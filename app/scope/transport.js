/**
 * 数据面传输：把"512 B 包流"从探针搬到页面。两种实现**同形**，页面不用管用的是哪个：
 *   · `VendorEpTransport` —— 真家伙：WebUSB 认领 interface 0，走**空闲的 bulk IN 端点 0x83**
 *     （SWO 端点，固件里从没写过；见 docs/scope-page.md §4）。
 *   · `MockTransport`      —— 假探针：不需要硬件，波形确定性生成（自测/演示用）。
 *
 * 收流的两条纪律（都是踩过的坑换来的）：
 *  1. **保持多条 transferIn 在飞**：一条 USB 读一次往返 ~0.2~0.5 ms，串行读会把速率锁死在
 *     几百 KB/s；批量读 4 KB + 2~4 条在飞才能吃满 bulk 带宽。
 *  2. **收尾必须先停推流、再收干净**：WebUSB 没有取消接口（app/rtt/dap-webusb.js:39-49 记着
 *     这个坑），挂起的 transferIn 会偷走下一场的响应 —— 所以 stop() 里要等在飞的读自己回来。
 */
import { withTimeout } from '../rtt/dap-webusb.js';
import { MockScopeProbe } from './mock.js';
import { UsbLease } from '../core/usb-device.js';

/** 探针上那个空闲的 bulk IN 端点（SWO 端点，SWO_STREAM=0 所以没人用）*/
export const EP_SCOPE = 0x83;
const VID = 0x0d28;
const dirtyDevices = new WeakSet();
const pendingByDevice = new WeakMap();

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class VendorEpTransport {
  constructor(device, opts = {}){
    this._usb = new UsbLease(device, 'scope');
    this.device = device = this._usb.device;
    this.ep = EP_SCOPE;
    this.iface = 0;
    this.chunkBytes = opts.chunkBytes ?? 4096;   // 一次 transferIn 想收多少（会被短包提前结束）
    this.inFlight = opts.inFlight ?? 3;          // 同时在飞的读
    this._adaptiveReadAhead = opts.inFlight == null && opts.chunkBytes == null;
    this.running = false;
    this.workers = [];
    this._pendingWorkers = pendingByDevice.get(device) || new Set();
    pendingByDevice.set(device, this._pendingWorkers);
    this.gen = 0;                 // 收流"轮次"代号：stop() 一加，超时残留在飞的 worker 就作废
    this.stalledInFlight = 0;     // 上一轮 stop() 里 800 ms 没等回来的在飞读笔数
    this.onError = null;          // 数据面不可恢复时的回调（由 start() 传入）
    this._fatal = null;
    this.chunks = 0; this.bytes = 0; this.errors = 0; this.lastError = null;
  }

  static supported(){ return typeof navigator !== 'undefined' && !!navigator.usb; }

  configureReadAhead(wireBps){
    if (this.running) throw new Error('先停止采样再改变预读窗口');
    if (!this._adaptiveReadAhead) return;
    // Provision at least 30 ms of native reads where the small window no
    // longer covers it. HPM's 8-channel/25 kHz stream is only 0.85 MB/s,
    // but decoding/drawing can pause JS for 25 ms: the old 1 MB/s cutoff
    // left just 14 ms of reads and caused USB drops despite zero probe skips.
    // Reserve ~80 ms when possible, including already completed reads awaiting
    // JS delivery. Limit native buffering to 16 * 8 KiB (128 KiB). This also
    // covers observed 52 ms GC/draw pauses at HPM's 25 kHz/8-channel rate.
    // Slow sessions retain the smaller window to avoid extra buffering delay.
    const fast = Number.isFinite(wireBps) && wireBps * 0.030 > 3 * 4096;
    this.inFlight = fast ? Math.max(6, Math.min(16, Math.ceil(wireBps * 0.080 / 8192))) : 3;
    this.chunkBytes = fast ? 8192 : 4096;
  }

  /** 已授权过的探针（浏览器记得就不用再弹框）*/
  static async authorized(){
    if (!VendorEpTransport.supported()) return [];
    try { return (await navigator.usb.getDevices()).filter(d => d.vendorId === VID); } catch { return []; }
  }

  /** 弹设备框 → 打开 → 认领接口（注意：必须给浏览器一个可见窗口，否则 requestDevice 直接回空数组）*/
  static async request(opts = {}){
    if (!VendorEpTransport.supported()) throw new Error('这个浏览器没有 WebUSB（桌面版 Chrome / Edge 才有）');
    const d = await navigator.usb.requestDevice({ filters: [{ vendorId: VID }] });
    const t = new VendorEpTransport(d, opts);
    await t.open();
    return t;
  }

  get label(){
    const d = this.device;
    const addr = (this.epAddr || (this.ep | 0x80)).toString(16);
    return `${d?.productName || 'akaLinkPro'} · EP 0x${addr} · ${this.chunkBytes} B/读 × ${this.inFlight}`;
  }

  /** 打开设备、找到带 0x83 的那个接口并认领 */
  async open(){
    try { return await this._open(); }
    catch (e){
      try { await this._usb.close({ dirty: dirtyDevices.has(this.device) }); }
      catch (cleanup){ this._usb.abandon(); e.message += `；USB 清理未完成：${cleanup.message}`; }
      throw e;
    }
  }
  async _open(){
    const d = this.device;
    await this._usb.open();
    let found = null;
    for (const iface of d.configuration.interfaces){
      for (const alt of iface.alternates){
        /**
         * 🚨 Chrome 的 WebUSB 报的 `endpointNumber` **不含方向位**：
         *    描述符里的 `0x83`（IN EP3）这里读出来是 `3`、`0x02`（OUT EP2）是 `2`、
         *    `0x81`（IN EP1）是 `1`。第一版按 `=== 0x83` 找，真机上永远找不到
         *    （"这个设备没有 bulk IN 端点 0x83"）—— 只有上真机才会暴露，假探针测不出来。
         *    而 `transferIn(ep)` / `clearHalt('in', ep)` 收的也是**这个不带方向位的编号**
         *    （既有的 CMSIS-DAP 通路就是这么用的，所以它一直好使）。
         */
        const ep = (alt.endpoints || []).find(e =>
          e.endpointNumber === (EP_SCOPE & 0x7f) && e.type === 'bulk' && e.direction === 'in');
        if (ep){ found = { iface, ep }; break; }
      }
      if (found) break;
    }
    if (!found){
      const seen = d.configuration.interfaces.flatMap(i => i.alternates.flatMap(a =>
        (a.endpoints || []).map(e => `0x${(e.endpointNumber | (e.direction === 'in' ? 0x80 : 0)).toString(16)}/${e.type}`)));
      throw new Error('没找到 bulk IN 端点 0x83（SWO 端点）—— 旧固件？选错设备了？' +
        `这个设备暴露的端点：${seen.join(' ') || '(无)'}`);
    }
    this.iface = found.iface.interfaceNumber;
    this.ep = found.ep.endpointNumber;         // 注意：不带方向位的编号（0x83 → 3）
    this.epAddr = this.ep | 0x80;              // 描述符里的地址，只用于显示/排障
    this.claimed = false;
    try { await this._usb.claim(this.iface, [this.epAddr]); this.claimed = true; }
    catch (e){
      /**
       * 🚨 **先端口复位再试一次**（2026-10 用户现场反复遇到）：
       *    `Unable to claim interface` 绝大多数是**残留占用**（上一次会话没放干净、
       *    页面被刷新掉、脚本中途退出、别的进程开过），不是接线问题。
       *    `device.reset()` 能把接口状态清干净，之后通常一把就成 —— 用户点一次「连接数据端点」
       *    就该连上，而不是被要求去排查一堆东西。
       */
      let ok = false;
      try {
        await this._usb.reset();
        await sleep(250);
        await this._usb.claim(this.iface, [this.epAddr]);
        ok = true; this.claimed = true;
        console.warn('[scope] 认领接口失败 → 端口复位后重试成功');
      } catch { /* 落到下面报错 */ }
      if (!ok){
        throw new Error(`认领 USB 接口失败：${e.message}\n` +
          '一个 USB 接口同时只能被一个程序/页签占用 —— 请检查：\n' +
          '  · 是不是**另开了一个页签**连着同一个数据端点？\n' +
          '  · 本工具的 RTT Viewer / 烧录器页还开着？\n' +
          '  · OpenOCD / pyOCD / J-Link 之类的本机程序还没退出？\n' +
          '（已经试过自动端口复位重连；再不行就拔插一次探针）');
      }
    }
    // 认领后清一次端点：上一场会话（或上一次断开）可能残留数据
    try { await d.clearHalt('in', this.ep); } catch { /* 有的设备不支持，忽略 */ }
    return this;
  }

  /**
   * 开始收流（onChunk 会被持续调用，参数是**原始字节**）。
   * @param {(bytes:Uint8Array)=>void} onChunk
   * @param {(e:Error)=>void} [onError] 数据面**不可恢复**地停了（读异常 / 反复 STALL）时叫一次 ——
   *        页面据此停采集并提示。以前没有这条回调：worker 悄悄退出、`running` 还是 true、
   *        界面照旧显示"采样中"，而一个字节都不来（2026-10 代码审查）。
   */
  async prepare(){
    if (!dirtyDevices.has(this.device)) return;
    if (await this._retireReads()){
      await withTimeout(this.open(), 5000, '重开采样数据端点');
      return;
    }
    // Generation checks cannot cancel native USB reads. Reset must retire them
    // before a new capture is allowed to submit any requests.
    try { await this._usb.reset(); }
    catch (resetError){
      /**
       * Windows sometimes rejects USBDevice.reset() after a timed-out EP 0x83
       * read, even though this transport is the only active owner. A reset is
       * still the preferred way to retire the native request; if the browser
       * refuses it, close the released interface/device and reopen it instead.
       * Never use this fallback for a shared-resource guard failure: that means
       * another live client still owns the probe and must be released first.
       */
      const why = String(resetError?.message || resetError);
      if (/USB 整设备复位需要先断开|USB 端点正在被/.test(why)) throw resetError;
      try {
        await this._usb.close({ dirty: false });
        await withTimeout(Promise.allSettled([...this._pendingWorkers]), 1500, '等待旧采样读退出（USB 重开）');
        await withTimeout(this.open(), 5000, '重开采样数据端点');
        console.warn('[scope] USB reset 失败，已关闭并重开数据端点：' + why);
        dirtyDevices.delete(this.device);
        this.stalledInFlight = 0;
        return;
      } catch (reopenError){
        throw new Error(`USB reset 失败（${why}），关闭并重开数据端点也失败：${reopenError?.message || reopenError}`);
      }
    }
    await withTimeout(Promise.allSettled([...this._pendingWorkers]), 1500, '等待旧采样读退出');
    await withTimeout(this.open(), 5000, '重新连接采样数据端点');
    dirtyDevices.delete(this.device);
    this.stalledInFlight = 0;
  }

  async _retireReads(){
    // SPI CDC uses HID/CDC rather than this WebUSB handle. Closing our
    // exclusively owned handle can cancel native reads without resetting
    // the whole probe or interrupting those independent streams.
    if (!this._usb.canRetireHandle()) return false;
    await this._usb.close({dirty: false});
    this.claimed = false;
    await withTimeout(Promise.allSettled([...this._pendingWorkers]), 1500, '等待采样接口读退出');
    dirtyDevices.delete(this.device);
    this.stalledInFlight = 0;
    return true;
  }

  async start(onChunk, onError){
    if (this.running) return;
    if (this._startPromise) return await this._startPromise;
    this._startPromise = this._start(onChunk, onError);
    try { return await this._startPromise; }
    finally { this._startPromise = null; }
  }

  async _start(onChunk, onError){
    const generation = ++this.gen;
    await this.prepare();
    if (generation !== this.gen) return;
    this.running = true;
    this._fatal = null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.gen++;                                   // 新一轮的代号：上一轮没收干净的 worker 靠它作废
    this.chunks = 0; this.bytes = 0; this.errors = 0;
    this._startedAt = performance.now();
    const g = this.gen;
    // One consumer awaits submission order. Native reads remain concurrent; promise
    // completion order is not necessarily stream order on Windows under load.
    this._nativeInFlight = 0;
    this.workers = Array.from({ length: 1 }, () => {
      const worker = this._worker(onChunk, g);
      this._pendingWorkers.add(worker);
      worker.then(() => this._pendingWorkers.delete(worker), () => this._pendingWorkers.delete(worker));
      return worker;
    });
  }

  /** 数据面出事 → 停掉整条流，并把原因交给页面（只报一次：N 条 worker 会同时撞上）*/
  _fail(why){
    if (this._fatal) return;
    this._fatal = why;
    this.errors++; this.lastError = why;
    this.running = false;
    try { this.onError?.(new Error(why)); } catch { /* 页面自己出错不该拖垮这里 */ }
  }

  async _worker(onChunk, g){
    let stalls = 0;
    // Attach rejection handling immediately: a rearmed read can reject while decoding.
    const issue = () => {
      this._nativeInFlight++;
      try {
        return Promise.resolve(this.device.transferIn(this.ep, this.chunkBytes))
          .then(result => { this._nativeInFlight--; return { result }; },
            error => { this._nativeInFlight--; return { error }; });
      } catch (error){ this._nativeInFlight--; return Promise.resolve({ error }); }
    };
    const queue = Array.from({ length: this.inFlight }, issue);
    try {
    /**
     * 🚨 循环条件要带上**代号** `g`：`stop()` 等在飞的读回来最多 800 ms，超时的那一条会活到
     *    下一轮 —— 那时 `running` 又被 `start()` 置回 true，只判 running 的话它会"复活"继续收，
     *    而且已经不在 `workers` 里，后面的 `stop()` 再也等不到它（worker 数无界增长，2026-10 代码审查）。
     */
    while (this.running && g === this.gen){
      let r;
      try {
        const completed = await queue[0];
        queue.shift();
        if (completed.error) throw completed.error;
        r = completed.result;
      } catch (e){
        /* 读抛异常（USB 抖动、探针复位）以前是直接 break —— 几条 worker 全退出后数据面就停了，
         * 而 `running` 还是 true、页面还显示"采样中"（2026-10 代码审查）。现在上报并整体停下。 */
        if (this.running && g === this.gen){
          this._fail('数据流中断：' + (e?.message || String(e)) + '（探针掉线了？拔插一次，或改用假探针）');
        }
        break;
      }
      if (!this.running || g !== this.gen) break;     // 收尾 / 换轮：这一条读到了也不再用
      if (r.status === 'ok' && r.data?.byteLength){
        stalls = 0;
        this.chunks++; this.bytes += r.data.byteLength;
        // Keep the native USB request queue full before doing synchronous JS work.
        queue.push(issue());
        try { onChunk(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)); }
        catch (e){ this._fail('数据解析失败：' + (e?.message || String(e))); break; }
      } else if (r.status !== 'ok'){
        this.errors++; this.lastError = r.status;
        if (r.status === 'stall'){
          /**
           * 🚨 STALL 必须 `clearHalt` 才解得开。老代码只给 errors 加一就立刻回头再读 ——
           *    端点一直保持 STALL，于是**空转**（实测 100 ms 内 transferIn 调了 7 万次）、
           *    CPU 占满、数据一个都不来（2026-10 代码审查）。这里清一次、让一拍，
           *    连续解不开就把整条流停掉并如实报出来，别让页面傻等。
           */
          try { await this.device.clearHalt('in', this.ep); } catch { /* 有的平台不支持 */ }
          await sleep(10);
          if (++stalls >= 8){
            this._fail(`端点 0x${(this.ep | 0x80).toString(16)} 连续 ${stalls} 次 STALL，clearHalt 也解不开 —— 数据流已停`);
            break;
          }
        }
      }
      if (queue.length < this.inFlight && this.running && g === this.gen) queue.push(issue());
    }
    } finally {
      // stop/error must track the already rearmed transfer until it settles.
      await Promise.all(queue);
    }
  }

  /** Stop rearming while the producer can still finish already submitted reads. */
  async quiesce(timeoutMs){
    if (timeoutMs === undefined){
      // Drain while the producer still runs. Under simultaneous SPI/CDC load
      // a nominal 500 kHz plan can deliver far less: 16 x 8 KiB native reads
      // then need nearly a second, rather than the usual 40 ms, to complete.
      // Stop rearming first and bound the wait using observed USB throughput.
      const elapsed = Math.max(1, performance.now() - (this._startedAt ?? performance.now()));
      const bytesPerMs = this.bytes / elapsed;
      const pendingBytes = (this._nativeInFlight || 0) * this.chunkBytes;
      timeoutMs = bytesPerMs > 0 ? Math.max(40, Math.min(2000, Math.ceil(pendingBytes / bytesPerMs + 100))) : 40;
    }
    this.running = false;
    this.gen++;
    if (this.workers.length)
      await Promise.race([Promise.allSettled(this.workers), sleep(timeoutMs)]);
  }

  /** 停止收流：等在飞的读全部回来（最多 800 ms），**不要**让它们挂在那儿 */
  async stop(){
    this.gen++;                    // 代号一变，超时残留在飞的那条读回来后就自行作废
    if (!this.workers.length){ this.stalledInFlight = 0; return; }
    this.running = false;
    let settled = 0;
    const all = this.workers.map(p => p.then(() => { settled++; }, () => { settled++; }));
    await Promise.race([Promise.allSettled(all), sleep(800)]);
    this.workers = [];
    /** 800 ms 还没回来的在飞读有几笔（WebUSB 取消不掉，只能如实记账；页面可据此提示）*/
    this.stalledInFlight = settled === all.length ? 0 : Math.max(1, this._nativeInFlight || 0);
    if (this.stalledInFlight) dirtyDevices.add(this.device);
  }

  async close(){
    await this.stop();
    if (dirtyDevices.has(this.device)) await this._retireReads();
    const dirty = dirtyDevices.has(this.device);
    try {
      await this._usb.close({ dirty });
    } catch (e){
      /**
       * Windows may reject USBDevice.reset() after a transfer has already
       * failed.  The reset is useful for recovery, but leaving the lease
       * claimed is worse: the next session then sees "endpoint in use by
       * scope" and cannot even reconnect.  All workers have been quiesced by
       * stop() above, so make one best-effort close without another reset to
       * release the interface and the native handle.
       */
      // Do not bypass the shared-resource guard (for example an active SPI
      // lease).  Only a native reset failure is recoverable by this fallback.
      if (!dirty || /USB 整设备复位需要先断开|USB 端点正在被/.test(String(e?.message || e))) throw e;
      try {
        await this._usb.close({ dirty: false });
        dirtyDevices.delete(this.device);
      } catch (cleanup){
        e.message += `；无复位释放也失败：${cleanup.message}`;
        throw e;
      }
      console.warn('[scope] USB reset 失败，已用无复位 close 释放数据端点：' + e.message);
      return;
    }
    dirtyDevices.delete(this.device);
  }

}

/** 假传输：包源是 MockScopeProbe 的 poll()，时间用 performance.now()
 *  ⚠️ 允许注入 `probe` —— 页面里 HID 面（配置/启停）和数据面必须是**同一个** mock 实例，
 *     否则会出现"配置发给了 A、数据从 B 出来"这种自己骗自己的假象。 */
export class MockTransport {
  constructor(opts = {}){
    this.probe = opts.probe || new MockScopeProbe(opts);
    this.running = false;
    this.timer = null;
    this.chunks = 0; this.bytes = 0; this.errors = 0; this.lastError = null;
    this.rateCap = opts.pollMs ?? 20;      // 每 20 ms 收一次（模拟 USB 轮询节奏）
    this._t0 = null;
  }
  static supported(){ return true; }
  static async request(opts){ return new MockTransport(opts); }
  get label(){ return `假探针（无需硬件）· ${Math.round(1e6 / this.probe.periodUs / 1000)} kHz · ${this.probe.vars.length} 通道`; }
  get device(){ return null; }
  /** 与真传输同形：真的那个要 open() 认领接口，假的什么都不用做 */
  async open(){ return this; }
  async start(onChunk){
    if (this.running) return;
    this.running = true;
    this._t0 = performance.now();
    this.probe.poll(0);
    this.timer = setInterval(() => {
      if (!this.running) return;
      const nowUs = (performance.now() - this._t0) * 1000;
      const out = this.probe.poll(nowUs);
      for (const pkt of out){ this.chunks++; this.bytes += pkt.length; onChunk(pkt); }
    }, this.rateCap);
  }
  async stop(){
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer); this.timer = null;
    await sleep(30);
  }
  async close(){ await this.stop(); }
}
