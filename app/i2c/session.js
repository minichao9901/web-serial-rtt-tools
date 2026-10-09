/**
 * USB→I2C 桥的**会话层** —— 连接、配置、事务、计数器、日志环。**不碰 DOM**（只读 `document.hidden`）。
 *
 * 一句话说清它与 SPI 桥会话的差别：I2C **只有一条 HID 通路**（0x36），没有 bulk 端点、
 * 没有帧流、没有第二套缓冲。所以这一层比 spi/session.js 简单得多 —— 但要守住三件事：
 *
 *   1. **一次只允许一笔在飞**：固件对并发 XFER 回 `E_BUSY`，主机侧也别把请求排队堆起来
 *      （那是把"忙"当成正常状态用）。这里用一条串行链把事务排队，顺便让定时任务与手动
 *      点击不会打架。
 *   2. **必须走"登记 + 轮询 RESULT"**：一次事务最长 ~5 ms（54 B @100 kHz），
 *      一条 HID 往返拿不到数据。轮询间隔用 `waitMs`（`app/core/pace.js`）——
 *      页面不可见时 `setTimeout` 的短延时会**被钳到 ≥1 s**，那样一笔 5 ms 的事务要等 1 s。
 *   3. **探针失联要如实说**：连续几次 HID 超时就置 `lost`，并停掉自动轮询 ——
 *      否则串口/波形页会被超时错误刷屏（web-handoff §10 明确点了这一条）。
 */
import { AkaLinkHid } from '../hid/probe.js';
import { MockI2cProbe } from './mock.js';
import { waitMs } from '../core/pace.js';
import * as P from './protocol.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { BUS, runSessionPeriodic, stopSessionPeriodic } from '../core/bus-periodic.js';

const RING_MAX = 600;          // 日志环（切页时全量重放用）
const POLL_MS = 1500;          // STATUS 轮询间隔（观察量，1.5 s 够）
const LOST_AFTER = 3;          // 连续几次超时就判"探针失联"
const NOT_CONNECTED = '未连接 —— 点「连接探针（授权）」授权 HID（一个探针同时只能被一个页签占着）';

export class I2cSession {
  constructor(){
    this.hid = null;                 // 真：AkaLinkHid；假：MockI2cProbe
    this.usingMock = false;
    this.cfg = null;                 // {sclHz, pullup, retries, flags, actualSclHz}
    this.counters = null;
    this.status = null;              // 最近一次状态字（解析后）
    this.ring = [];
    this.subs = new Set();
    this.busy = false;
    this.lost = false;
    this.failStreak = 0;
    this._chain = Promise.resolve();
    this._pollTimer = null;
    this.stateText = NOT_CONNECTED;
    this.stateKind = '';
    this.lastOp = null;              // {label, err, ms, n}
  }

  // ==================================================================== 订阅 / 广播

  subscribe(view){
    this.subs.add(view);
    return () => this.subs.delete(view);
  }
  _emit(type, payload){
    for (const v of this.subs){
      try { v.onSession?.(type, payload); } catch (e){ console.warn('[i2c] 视图回调出错', e); }
    }
  }
  log(kind, text, tag = 'bus'){
    const e = { kind, text, tag, t: Date.now() };
    this.ring.push(e);
    if (this.ring.length > RING_MAX) this.ring.shift();
    this._emit('log', e);
  }
  _setState(text, kind = ''){
    this.stateText = text; this.stateKind = kind;
    this._emit('state', this.stateInfo());
  }
  stateInfo(){
    return {
      connected: this.connected, mock: this.usingMock, lost: this.lost,
      hidLabel: this.hid?.label || '', text: this.stateText, kind: this.stateKind,
      busy: this.busy, enabled: this.enabled, cfg: this.cfg, counters: this.counters,
      status: this.status, lastOp: this.lastOp,
    };
  }

  get connected(){ return !!(this.hid && (this.usingMock || this.hid.connected)); }
  get enabled(){ return !!this.status?.enabled; }
  get actualSclHz(){ return this.cfg?.actualSclHz || this.counters?.actualSclHz || 0; }

  // ==================================================================== 连接

  /** 连探针（HID）。`interactive=true` 会弹浏览器的授权框（第一次必须）*/
  async connect(interactive = false, { mock = false, enable = false } = {}){
    if (this._connectPromise) return await this._connectPromise;
    if (this._disconnectPromise) return false;
    this._connectPromise = runProbeOperation(this, 'i2c', async () => {
      if (mock && this.hid && !this.usingMock){
        this.stopPoll(); this._closing = true;
        try {
          await this._chain;
          await this._disableRealBridge();
          await this._dropHid();
          this.probeManager?.forget('i2c');
        } catch (e){ this.probeManager?.fail('i2c', e); throw e; }
        finally { this._closing = false; }
      }
      return await this._connectNow(interactive, { mock, enable });
    }, {
      mock, reason: 'I2C 要连接探针', recovery: true,
    });
    try { return await this._connectPromise; }
    catch (e){ this.log('e', e.message); return false; }
    finally { this._connectPromise = null; }
  }

  async _connectNow(interactive = false, { mock = false, enable = false } = {}){
    try {
      if (mock){
        if (!this.usingMock || !(this.hid instanceof MockI2cProbe)){
          await this._dropHid();
          this.hid = new MockI2cProbe();
          this.usingMock = true;
        }
        this.log('g', '假探针已就位（内置 AT24C02@0x50 / MPU6050@0x68 / ADS1115@0x48 / Si5351@0x60）');
      } else {
        if (this.usingMock || !this.hid){
          await this._dropHid();
          this.hid = new AkaLinkHid();
          this.usingMock = false;
        }
        await this.hid.connect(interactive);
        this.log('g', `HID 已连接：${this.hid.label || 'akaLinkPro'}`);
      }
      this.lost = false; this.failStreak = 0;
      this.hid.onDisconnect = () => {
        this.lost = true;
        this._setState('探针掉线了（检查 USB，再点「连接探针」）', 'err');
        this.stopPoll();
      };
      // 连接后第一件事：GET_CFG 确认桥的现状（探针复位/重烧后配置会回默认）
      await this.loadCfg({ quiet: true });
      await this.readStatus({ quiet: true });
      if (enable && !this.enabled){
        this.log('dim', '桥还没使能，自动发一次 ENABLE 1');
        await this.setEnabled(true);
      }
      this.startPoll();
      this._setState(this.enabled ? '已连接（桥已使能）' : '已连接（桥还没使能 —— 点「使能」）');
      return true;
    } catch (e){
      this.log('e', '连接失败：' + (e?.message || e));
      this._setState('连接失败：' + (e?.message || e), 'err');
      this._emit('state', this.stateInfo());
      return false;
    }
  }

  async _dropHid(){
    const h = this.hid;
    await h?.close?.();
    this.hid = null;
  }

  async disconnect(){
    this.probeManager?.cancel('i2c');
    if (this._disconnectPromise) return await this._disconnectPromise;
    this._disconnectPromise = this._disconnectNow();
    try {
      await this._disconnectPromise;
      this.probeManager?.forget('i2c');
    } catch (e){ this.probeManager?.fail('i2c', e); throw e; }
    finally { this._disconnectPromise = null; this._closing = false; }
  }

  async _disconnectNow(){
    await this.stopPeriodic();
    this.stopPoll();
    this._closing = true;
    await Promise.allSettled([this._connectPromise, this._reacquirePromise].filter(Boolean));
    await this._chain;
    await this._disableRealBridge();
    await this._dropHid();
    this.usingMock = false;
    this.cfg = null; this.counters = null; this.status = null;
    this._setState(NOT_CONNECTED);
    this._closing = false;
  }

  async _disableRealBridge(){
    await this.stopPeriodic();
    if (this.hid && !this.usingMock){
      // Closing WebHID alone leaves firmware enabled and PA28/29 owned by I2C.
      // A timed-out operation can still be pending in firmware; wait for ENABLE=0.
      const deadline = performance.now() + 2000;
      for (;;){
        const res = await this._rawCmd(P.actEnable(false));
        if (res?.length < 7 || res[0] < 8 || res[1] !== P.HID_CMD || res[2] !== P.ACT.ENABLE)
          throw new Error('I2C 失能响应不完整，保留引脚占用');
        const st = P.parseStatus(res);
        if (st.cmdRc === P.E.OK && !st.enabled && !st.pending) break;
        if (st.cmdRc !== P.E.BUSY || performance.now() >= deadline)
          throw new Error('I2C 失能未确认，保留引脚占用');
        await waitMs(5);
      }
    }
  }

  /** 探针重新枚举过（复位/拔插/重烧）→ 重新取设备对象。对"设备侧端点没打开"无效，只有拔插能救 */
  async reacquire(){
    if (this._reacquirePromise) return await this._reacquirePromise;
    if (this._disconnectPromise) return false;
    this._reacquirePromise = runProbeOperation(this, 'i2c', () => this._reacquireNow(), {
      mock: this.usingMock, reason: 'I2C 要重连探针', recovery: true,
    });
    try { return await this._reacquirePromise; }
    finally { this._reacquirePromise = null; }
  }

  async _reacquireNow(){
    if (this.usingMock || !this.hid) return this._connectNow(false);
    await this.hid._reacquire();
    this.lost = false; this.failStreak = 0;
    this.log('g', '已重新取到探针句柄');
    await this.loadCfg({ quiet: true });
    await this.readStatus({ quiet: true });
    this.startPoll();
    return true;
  }

  // ==================================================================== 底层：一条命令

  /**
   * 把活儿排进**串行链**。
   * 🚨 这不是可选的：`AkaLinkHid.xfer()` 里同一时刻只允许一条在飞（`if (this._pending) throw
   *    '上一条请求还没回来'`）。而事务内部要连续发 XFER + 好几条 RESULT，中间还夹着
   *    1.5 s 一次的 STATUS 轮询 —— 不排队就会互相踩，表现是"偶尔报『上一条请求还没回来』"。
   */
  _enqueue(fn){
    if (this._closing) return Promise.reject(new Error('I2C 会话正在断开'));
    const guarded = () => {
      if (this._closing) throw new Error('I2C 会话正在断开');
      return fn();
    };
    const p = this._chain.then(guarded, guarded);
    this._chain = p.catch(() => {});
    return p;
  }

  /** **直接**发一条 HID 0x36 命令（调用者负责已经在链里了）。带失联计数。*/
  async _rawCmd(data, timeout = 3000){
    if (!this.connected) throw new Error('探针没连上');
    try {
      const res = await this.hid.xfer(P.HID_CMD, data, timeout);
      this.failStreak = 0;
      return res;
    } catch (e){
      this.failStreak++;
      if (this.failStreak >= LOST_AFTER && !this.lost){
        this.lost = true;
        this.stopPoll();
        this.log('e', `连续 ${this.failStreak} 次没响应 —— 探针可能已失联：检查 USB 后点「连接探针」，还不行就拔插一次 USB（已知现象，见 web-handoff §10）`);
        this._setState('探针失联：检查 USB 后重新连接', 'err');
      }
      throw e;
    }
  }

  /** 排队发一条命令（页面上的按钮 / 轮询走这条）*/
  _cmd(data, timeout = 3000){ return this._enqueue(() => this._rawCmd(data, timeout)); }
  runPeriodic(groups, opts){ return runSessionPeriodic(this, BUS.I2C, groups, opts); }
  stopPeriodic(){ return stopSessionPeriodic(this); }

  /**
   * 一次事务（**登记 + 轮询 RESULT**），串行排队。
   * @returns {Promise<{err:number, data:Uint8Array, cmdRc:number, ms:number, tries:number}>}
   */
  transaction(x, { label = '', quiet = false, resultTimeout = 2000 } = {}){
    return this._enqueue(async () => {
      if (this.lost) throw new Error('探针失联中：先重连或拔插 USB');
      const t0 = performance.now();
      let tries = 0, r1;
      // 1) 登记（忙就重发 —— 固件明说"等一下重发"，别把它当失败）
      for (;;){
        tries++;
        r1 = await this._rawCmd(P.actXfer(x));
        const rc = P.parseStatus(r1).cmdRc;
        if (rc === P.E.OK) break;
        if (rc === P.E.BUSY && tries < 20){ await waitMs(1); continue; }
        const ms = performance.now() - t0;
        this.lastOp = { label, err: rc, ms, n: 0 };
        this._emit('op', this.lastOp);
        if (!quiet) this.log('e', `${label || P.describeXfer(x)} —— 被拒：${P.errText(rc)}`);
        return { err: rc, data: new Uint8Array(0), cmdRc: rc, ms, tries };
      }
      // 2) 轮询 RESULT 到 PENDING 清零
      //
      // 🚨 **跳出条件只能是 PENDING 清零**，别拿"完成计数（DONE_CNT）变了"当条件：
      //    DONE_CNT 数的是**成功**事务，失败的那一笔它不动 —— 于是每笔失败都要白等满
      //    `resultTimeout`（默认 2 s）。实测就是这么被咬的：向不存在的地址发一笔，
      //    2 s 才回来；扫描里几十个空地址就是好几分钟。
      //    （协议文档建议"想更严谨就比对 DONE_CNT"—— 那是在 PENDING 之外**额外**记一笔账，
      //      不是拿它当唯一判据。）
      const deadline = performance.now() + resultTimeout;
      let r = null;
      for (;;){
        r = await this._rawCmd(P.actResult());
        const st = P.parseStatus(r);
        this.status = st;
        if (!st.pending) break;
        if (performance.now() > deadline){
          const ms = performance.now() - t0;
          this.lastOp = { label, err: P.E_HOST_TIMEOUT, ms, n: 0 };
          this._emit('op', this.lastOp);
          if (!quiet) this.log('e', `${label || P.describeXfer(x)} —— 等 RESULT 超时（探针侧 ${resultTimeout} ms 没做完这一笔）`);
          return { err: P.E_HOST_TIMEOUT, data: new Uint8Array(0), cmdRc: 0, ms, tries };
        }
        await waitMs(1);
      }
      const { err, data } = P.parseResult(r);
      const ms = performance.now() - t0;
      this.lastOp = { label, err, ms, n: data.length };
      this._emit('op', this.lastOp);
      if (!quiet){
        const head = label || P.describeXfer(x);
        if (err === P.E.OK) this.log('ok', `${head} → ${P.hexBytes(data) || '（无数据）'}  · ${ms.toFixed(1)} ms`);
        else this.log('e', `${head} → ${P.errText(err)}`);
      }
      return { err, data, cmdRc: 0, ms, tries };
    });
  }

  // ==================================================================== 上层动作

  /**
   * **一次逻辑读**（长读自动分片）。上层只管"要从 dev 的 addr 读 rd 个字节"，
   * 54 B 的分片、拼接、错误定位都在这里做完 —— **中间那几笔不往日志里写**，
   * 只出一行结果（`256 B · 分 5 笔 · 62 ms`）。理由：一次只能读 54 B 是 HID 报文的限制，
   * 是实现细节，不该让填命令的人每次都自己拆。
   *
   * `chunk`：
   *   · `'reset'`（默认）—— 每片重发子地址。EEPROM / 寄存器型器件（MPU6050/ADS1115/Si5351）
   *     全都对，最稳，慢一倍。
   *   · `'ptr'` —— 地址指针自增（先零长度写推指针，之后续片不带子地址）。
   *     **读一次弹一个数的 FIFO 型器件必须用它**，否则每片重发子地址会把数据丢光。
   *
   * @returns {Promise<{err:number, data:Uint8Array, ms:number, chunks:number, mode:string, failNote?:string}>}
   */
  async readLong({ dev, addr = [], rd, chunk = 'reset' }, { label = '', quiet = false, resultTimeout = 2000 } = {}){
    const total = Math.max(0, rd | 0);
    if (total <= P.RD_MAX){
      const r = await this.transaction({ dev, addr, wr: [], rd: total }, { label, quiet, resultTimeout });
      return { ...r, chunks: 1, mode: 'single' };
    }
    const plan = P.planRead(addr, total, { mode: chunk });
    const t0 = performance.now();
    const head = label || `读 ${P.addr7(dev)}${addr.length ? '[' + P.hexBytes(addr) + ']' : ''} × ${total}`;
    const parts = [];
    let done = 0;
    for (let i = 0; i < plan.cmds.length; i++){
      const c = plan.cmds[i];
      // 分片内部一律 quiet：不逐片刷日志（这就是"让外部看不到"的地方）
      const r = await this.transaction({ dev, addr: c.addr, wr: [], rd: c.rd }, { quiet: true, resultTimeout });
      if (r.err !== P.E.OK){
        const ms = performance.now() - t0;
        const note = `第 ${i + 1}/${plan.cmds.length} 片（${c.note}）失败`;
        // 出错时**必须**说清断在哪一片、已经拿到多少 —— 这比"失败了"有用得多
        if (!quiet) this.log('e', `${head} → ${note}：${P.errText(r.err)}（已读回 ${done} B，这部分丢弃）`);
        this.lastOp = { label: head, err: r.err, ms, n: 0 };
        this._emit('op', this.lastOp);
        return { err: r.err, data: new Uint8Array(0), ms, chunks: i + 1, mode: plan.mode, failNote: note };
      }
      if (r.data.length) parts.push(r.data);
      done += r.data.length;
    }
    const data = new Uint8Array(done);
    let off = 0;
    for (const p of parts){ data.set(p, off); off += p.length; }
    const ms = performance.now() - t0;
    this.lastOp = { label: head, err: P.E.OK, ms, n: data.length };
    this._emit('op', this.lastOp);
    if (!quiet){
      this.log('ok', `${head} → ${data.length} B · 分 ${plan.cmds.length} 笔` +
        `${plan.mode === 'ptr' ? '（地址指针自增）' : ''} · ${ms.toFixed(1)} ms  ${P.hexBytes(data.subarray(0, 16))}${data.length > 16 ? ' …' : ''}`);
    }
    return { err: P.E.OK, data, ms, chunks: plan.cmds.length, mode: plan.mode };
  }

  /**
   * **一次逻辑写**（长写自动分片），与 `readLong` 对称。写不像读那样能靠器件指针自增，
   * 所以**每一片都自带子地址**（见 `protocol.planWrite`）。中间几笔同样不写日志，只出一行。
   *
   * @param {object} o
   *   · `dev`       7 位地址
   *   · `addr`      起始子地址（原序字节数组）
   *   · `data`      完整数据（`offsets` 是它里面的下标）
   *   · `offsets`   只写这些下标（缺省整块）—— 「寄存器」面板的「只写改动」用它
   *   · `chunkMax`  单片上限（缺省 51；**EEPROM 页写要按页给**，AT24C02 是 8）
   *   · `pageSize`  器件**页大小**（缺省 0 = 不限）。给了就保证每一片不跨页 —— 这是 EEPROM
   *                 页写回卷的真正防线：只设 `chunkMax` 的话，起始地址不是页倍数时第一片照样跨页
   *                 （见 `protocol.planWrite` 的 🚨）
   *   · `gapMs`     **片间等待**（缺省 0）。EEPROM 每写完一页要等 tWR（约 5 ms）才认下一笔，
   *                 所以按页写 EEPROM 时给 6 ms 左右；寄存器型器件不需要。
   * @returns {Promise<{err:number, ms:number, bytes:number, chunks:number, failNote?:string}>}
   */
  async writeLong({ dev, addr = [], data, offsets = null, chunkMax = P.WR_MAX, pageSize = 0, gapMs = 0 },
    { label = '', quiet = false, resultTimeout = 2000 } = {}){
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
    const plan = P.planWrite(addr, bytes, { chunkMax, offsets, pageSize });
    const head = label || `写 ${P.addr7(dev)}${addr.length ? '[' + P.hexBytes(addr) + ']' : ''} × ${plan.bytes} B`;
    if (!plan.chunks){
      if (!quiet) this.log('w', `${head} —— 没有要写的字节`);
      return { err: P.E.OK, ms: 0, bytes: 0, chunks: 0 };
    }
    const t0 = performance.now();
    let done = 0;
    for (let i = 0; i < plan.cmds.length; i++){
      const c = plan.cmds[i];
      const r = await this.transaction({ dev, addr: c.addr, wr: c.wr, rd: 0 }, { quiet: true, resultTimeout });
      if (r.err !== P.E.OK){
        const ms = performance.now() - t0;
        const note = `第 ${i + 1}/${plan.cmds.length} 片（${c.note}）失败`;
        if (!quiet) this.log('e', `${head} → ${note}：${P.errText(r.err)}（已写入 ${done} B，后面几片没发）`);
        this.lastOp = { label: head, err: r.err, ms, n: done };
        this._emit('op', this.lastOp);
        return { err: r.err, ms, bytes: done, chunks: i + 1, failNote: note };
      }
      done += c.wr.length;
      // 片间让路：EEPROM 的 tWR 期间器件不 ACK（不给就第 2 片起全失败）
      if (gapMs > 0 && i < plan.cmds.length - 1) await waitMs(gapMs);
    }
    const ms = performance.now() - t0;
    this.lastOp = { label: head, err: P.E.OK, ms, n: done };
    this._emit('op', this.lastOp);
    if (!quiet) this.log('ok', `${head} → 分 ${plan.cmds.length} 笔 · ${ms.toFixed(1)} ms`);
    return { err: P.E.OK, ms, bytes: done, chunks: plan.cmds.length };
  }

  async loadCfg({ quiet = false } = {}){
    const r = await this._cmd(P.actGetCfg());
    const cfg = P.parseCfg(P.dataOf(r).subarray(0, P.CFG_SIZE));
    this.cfg = cfg;
    this._emit('cfg', cfg);
    if (!quiet) this.log('g', `配置：SCL 档 ${cfg.actualSclHz / 1000} kHz（请求 ${cfg.sclHz}）· 内部上拉 ${cfg.pullup ? '开' : '关'} · 重试 ${cfg.retries}`);
    return cfg;
  }

  async applyCfg(cfg){
    const r = await this._cmd(P.actSetCfg(cfg));
    const rc = P.parseStatus(r).cmdRc;
    if (rc !== P.E.OK){ this.log('e', `写配置被拒：${P.errText(rc)}`); return null; }
    this.log('g', `已下发配置：请求 SCL ${cfg.sclHz} · 上拉 ${cfg.pullup ? '开' : '关'} · 重试 ${cfg.retries}`);
    return await this.loadCfg({ quiet: true });
  }

  async setEnabled(on){
    const r = await this._cmd(P.actEnable(on));
    const st = P.parseStatus(r);
    this.status = st;
    this._emit('status', st);
    this.log(on ? 'g' : 'w', on
      ? `桥已使能（PA28=SDA / PA29=SCL 已被 I2C 占用；⚠️ 使能期间 SPI 桥的辅助脚 pad16/17 会被拒）`
      : '桥已失能（两根脚放成高阻输入）');
    // 状态栏文案也要跟着变 —— 不然自动使能之后还挂着"桥还没使能"（实测就这么误导过一次）
    this._setState(this.enabled ? '已连接（桥已使能）' : '已连接（桥还没使能 —— 点「使能」）');
    this.startPoll();
    return st.enabled;
  }

  async busReset(){
    const r = await this._cmd(P.actReset());
    const rc = P.parseStatus(r).cmdRc;
    if (rc !== P.E.OK){ this.log('e', `总线恢复被拒：${P.errText(rc)}`); return false; }
    const { err } = await this._waitResult(2000);
    this.log(err === P.E.OK ? 'g' : 'e', `总线恢复：9 个 SCL 脉冲 + STOP + 控制器复位 → ${P.errText(err)}（计数器已清零）`);
    await this.readStatus({ quiet: true });
    return err === P.E.OK;
  }

  /** 只轮询 RESULT（给 RESET/SCAN 这种"登记后没有返回值"的动作用）*/
  async _waitResult(timeout = 2000){
    const deadline = performance.now() + timeout;
    for (;;){
      const r = await this._cmd(P.actResult());
      const st = P.parseStatus(r);
      this.status = st;
      this._emit('status', st);
      if (!st.pending){ const { err, data } = P.parseResult(r); return { err, data }; }
      if (performance.now() > deadline) return { err: P.E_HOST_TIMEOUT, data: new Uint8Array(0) };
      await waitMs(1);
    }
  }

  async readStatus({ quiet = false } = {}){
    const r = await this._cmd(P.actStatus());
    const st = P.parseStatus(r);
    const c = P.parseCounters(P.dataOf(r).subarray(0, P.STAT_WORDS * 4));
    this.status = st; this.counters = c;
    this._emit('status', st);
    this._emit('counters', c);
    if (!quiet){
      this.log('dim', `状态 0x${st.raw.toString(16).padStart(8, '0')} ` +
        `[${st.enabled ? 'EN' : '--'}${st.pending ? ' PEND' : ''}${st.busOk ? ' BUSOK' : ''}` +
        `${st.sda ? ' SDA=1' : ' SDA=0'}${st.scl ? ' SCL=1' : ' SCL=0'}] ` +
        `ok=${c.framesOk} err=${c.framesErr} tx=${c.bytesTx}B rx=${c.bytesRx}B ` +
        `nackA=${c.nackAddr} nackD=${c.nackData} to=${c.timeouts} recover=${c.busRecover}`);
    }
    return { status: st, counters: c };
  }

  /** 扫描 0x08..0x77 → 地址数组 */
  async scan(){
    const r = await this._cmd(P.actScan());
    const rc = P.parseStatus(r).cmdRc;
    if (rc !== P.E.OK){
      const msg = `扫描被拒：${P.errText(rc)}`;
      this.log('e', msg);
      throw new Error(msg);
    }
    const t0 = performance.now();
    const { err, data } = await this._waitResult(6000);
    const ms = performance.now() - t0;
    if (err !== P.E.OK){
      const msg = `扫描失败：${P.errText(err)}`;
      this.log('e', msg);
      throw new Error(msg);
    }
    const addrs = P.scanBitmapToAddrs(data);
    this.log(addrs.length ? 'ok' : 'warn', addrs.length
      ? `扫描完成（${ms.toFixed(0)} ms）：` + addrs.map(a => `${P.addr7(a)}${P.guessDevice(a) ? '(' + P.guessDevice(a) + ')' : ''}`).join(' · ')
      : `扫描完成（${ms.toFixed(0)} ms）：总线上没有任何器件应答 —— 先跑「接线自检(PINTEST)」，再查供电/上拉/地址`);
    await this.readStatus({ quiet: true });
    return { addrs, ms };
  }

  async pinTest(){
    const r = await this._cmd(P.actPinTest());
    const st = P.parseStatus(r);
    if (st.cmdRc !== P.E.OK){
      // PINTEST 会发一次真实探测事务，总线忙时会被拒 —— 这是正常的，等一下再来
      this.log('e', `接线自检被拒：${P.errText(st.cmdRc)}`);
      return null;
    }
    const v = P.parsePinTest(P.dataOf(r).subarray(0, 4));
    this.log(v.bridgeOk ? 'g' : 'e',
      `接线自检：空闲 SDA=${v.idleSda} SCL=${v.idleScl} · 开内部上拉后 SDA=${v.pullupSda} SCL=${v.pullupScl} · ` +
      `事务中曾拉低 SCL=${v.droveScl} SDA=${v.droveSda}` +
      (v.problems.length ? ` · 问题：${v.problems.join('；')}` : ''));
    if (v.bridgeOk) this.log('dim', 'bit16=1 且问题位图=0 ⇒ 桥这一侧没问题，没 ACK 就往器件侧查（接线/供电/地址/上拉）');
    this._emit('pintest', v);
    return v;
  }

  async dbg(){
    const r = await this._cmd(P.actDbg());
    const rows = P.parseDbg(P.dataOf(r));
    this.log('dim', '现场快照：' + rows.map(x => `${x.name}=0x${x.value.toString(16).padStart(8, '0')}`).join(' '));
    this._emit('dbg', rows);
    return rows;
  }

  // ==================================================================== 自动轮询

  startPoll(){
    if (this._pollTimer || !this.connected) return;
    this.stopPoll();
    this._pollTimer = setInterval(() => {
      // 页面看不见时别刷（省 USB 带宽，也免得和别的页签抢探针）
      if (typeof document !== 'undefined' && document.hidden) return;
      if (this.lost) return;
      // 定时循环里计数器正是最该看的；周期任务和轮询通过同一串行链排队。
      this.readStatus({ quiet: true }).catch(() => { /* 失联由 _rawCmd 记账 */ });
    }, POLL_MS);
  }
  stopPoll(){
    if (this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  /** 忙碌标记（执行器跑一整段时置上，避免自动轮询插进来抢 HID）*/
  setBusy(on){
    this.busy = !!on;
    this._emit('state', this.stateInfo());
  }

  summary(){
    return {
      connected: this.connected, mock: this.usingMock, lost: this.lost,
      enabled: this.enabled, cfg: this.cfg, counters: this.counters,
      ringLines: this.ring.length, lastOp: this.lastOp,
    };
  }
}
