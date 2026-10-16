/**
 * SEGGER RTT 主机端协议（与探针解耦：只要给出 readMem/writeMem 就能工作）。
 *
 * 控制块（32 位目标）：
 *   char  acID[16]              "SEGGER RTT\0..."
 *   u32   MaxNumUpBuffers
 *   u32   MaxNumDownBuffers
 *   then  aUp[MaxNumUp]   ，每项 24 字节：
 *         u32 sName; u32 pBuffer; u32 SizeOfBuffer; u32 WrOff; u32 RdOff; u32 Flags;
 *   then  aDown[MaxNumDown]，结构完全相同
 *
 * 上行走 ring buffer：读 [RdOff, WrOff) → 把 RdOff 写成 WrOff（主机是读方）。
 * 下行走反的：主机写数据 + 推进 WrOff（目标是读方）。
 *
 * ⚠️ 与 rtt.py 一致的三个坑：
 *  ① 缓冲是环形，读之前必须判断是否绕回，否则一次只能读到末尾；
 *  ② WrOff/RdOff 要尽量一次性读回来（这里整条 24 字节项一起读），避免撕裂；
 *  ③ 目标写太快会覆盖/丢弃主机没读走的数据（RTT 不重传），但要注意**能观测到什么**：
 *     · 最实用的是「缓冲水位」：每次读到 n 字节，n/(size-1) 就是当时的占用率。
 *       实测（STM32F103 + OpenOCD RPC，读速只有 ~17 KB/s）：目标一次灌 8KB 进 4KB 缓冲、
 *       主机只收到 4KB —— 水位峰值 92%，但**一次都没到 100%**（主机边读边被写）。
 *       所以判据取「水位 ≥ 3/4 记为高位」，比死等 "n == size-1" 实用得多。
 *     · 「精确差值」：主机侧 RdOff 落后于上次排空位置（上次推进失败/读取出错）时，
 *       用「目标写了多少(ΔWr) − 这次读到多少」算得出差值。
 *     · 不可观测：SKIP 模式下目标自己丢掉的数据、或目标在两轮之间写了超过整个缓冲 —— 
 *       模运算已经绕圈，谁也看不出来丢了多少（JLinkRTTViewer 同样不知道）。
 *       界面上的数字都当"下限/压力指示"，不是精确账。
 */
import { u32le, u32leBytes, latin1 } from '../core/bin.js';
import { waitMs } from '../core/pace.js';
import { OperationBudget } from '../core/operation-budget.js';

export const CB_ID = 'SEGGER RTT';
export const ENTRY = 24;

/**
 * 通道缓冲大小的合理上限 —— 只用来挡"读到垃圾"，不是功能限制。
 *
 * 🚨 这里原本写死 `1 << 20`（1 MB），2026-10 HPM6800EVK 真机踩到：
 *    **HPM SDK 自带的 SEGGER_RTT_Conf.h 就把 `BUFFER_SIZE_UP` 设成 8 MB**
 *    （`middleware/segger_rtt/Config/SEGGER_RTT_Conf.h`：`8192*1024`），于是
 *    `lwip_tcpecho`（trace 插桩版）这种固件**控制块明明是好的**，页面却报
 *    「通道 0 缓冲大小 8388608 不合理」→ `validate()` 不过 → Viewer 死活连不上。
 *    "环开得大"是合法配置，代价只是延迟高（8 MB 环在 1 MB/s 的排空速率下要 8 s 才排空），
 *    不是错误；探针侧的 `rtt_bridge.c` 也从来没有这个上限（只查 size==0 / rd>=size / wr>size）。
 *
 * 放到 32 MB：仍挡得住实测见过的垃圾值（例：探针挂起读残渣给过 size=560229490 ≈ 534 MB），
 * 又不冤枉大环。真要再大，改这一个常量即可。
 */
export const MAX_CH_BYTES = 32 << 20;

/**
 * 一轮 `readUp` 最多读多少字节。
 *
 * 🚨 2026-10 HPM6800EVK 真机踩到（`lwip_tcpecho` 插桩版，上行环 8 MB）：
 *    `readUp` 的语义原本是"一次读完整段 `[rd, wr)`"，而这个固件**只写不读**地跑了几十分钟，
 *    Viewer 连上时环里积了 **3.8 MB** —— 那一次 `readMem` 在 RISC-V/SBA 上直接失败
 *    （实测：4 B/64 B 各 4 ms；4 KB 138 ms；64 KB 2.4 s（≈30 KB/s）；**1 MB 报
 *    `DMI 写 0x39 失败（op=1）`**）。因为读失败时不推进 RdOff，界面上的现象就是
 *    **"控制块认出来了、轮询也在跑（polls 在涨），但一个字节都不来"**。
 *    分块之后每轮都推进一点：大积压最多是"慢慢排空"，不会假死。
 *
 * 取值口径：64 KB 在 RISC-V/SBA 上实测 2.4 s 且不触发上面那个失败；
 * 对 ARM/WebUSB 那条路（实测 275 KB/s~2.9 MB/s、轮询 100+ Hz）也远够用 ——
 * 64 KB × 100 Hz = 6.4 MB/s 的天花板，比链路本身还高，只有"一次读 3 MB"这种病态才需要它。
 */
export const MAX_READ_PER_POLL = 64 * 1024;

const sleepMs = waitMs;
const allZero = b => b.length > 0 && b.every(x => x === 0);
const hasCbId = b => b.length >= CB_ID.length && latin1(b.subarray(0, CB_ID.length)) === CB_ID;
/**
 * 让链路自己重启一次（能做就做）：RISC-V 那条路是**复位调试模块**（见 riscv-mem.js 的 recover），
 * ARM/WebUSB 那条路也能重激活 SWD。没有 recover 的 mem（模拟器、桥）就当无事发生。
 */
async function recoverMem(mem){ try { await mem?.recover?.(); } catch {} }

export class Rtt {
  constructor(mem, opts = {}){
    this.mem = mem;                     // { readMem(addr,len), writeMem(addr,bytes) }
    this.addr = opts.addr || 0;
    this.maxUp = 0; this.maxDown = 0;
    this.upBase = 0; this.downBase = 0;
    this.up = []; this.down = [];
    this._lastWr = new Map();
    this._backlog = new Map();          // 每通道：环里还没读走的字节数（分块读的对账基准）
    this._lost = new Map();
    this._full = new Map();
    this._high = new Map();
    this.peak = 0;
    this._names = new Map();
  }

  // ---------------- 定位控制块 ----------------
  /**
   * 找一个**可信的**控制块：RAM 里出现 "SEGGER RTT" 的地方可能不止一处
   * —— 上一次固件编译留下的旧控制块会残留在 .bss 之外（RAM 不是每次上电都清零），
   * 锁错了就会出现"通道数/缓冲指针全是垃圾"的怪现象（本机实测踩到）。
   * 所以候选地址要逐个校验结构是否合理，第一个通过的就是它。
   */
  static async locate(mem, o = {}){
    const { addr = 0, ranges = [], chunk = 4096, onProgress } = o;
    if (addr){
      const v = await Rtt.validate(mem, addr);
      /**
       * 🚨 手填地址不成立时**必须提示"清空就会自动扫描"**（2026-10 真机走查踩到）：
       *    那个输入框是 store 绑定的，换固件/换目标后它还是上一次的值（本机就残留着 RISC-V 那次的
       *    0x2000000c），于是页面拿一个**过时地址**去校验、直接报"不是可用的 RTT 控制块" ——
       *    看起来像"RTT 连不上"，其实把输入框清空、自动扫描就好了。
       */
      if (!v.ok){
        throw new Error(`0x${addr.toString(16)} 处不是可用的 RTT 控制块：${v.reason}` +
          '　—— 注意这个地址是**手填的**：如果它是上一次会话/别的芯片留下的，清空「控制块地址」' +
          '让页面自动扫描（或在 RAM 范围里扫）就能连上');
      }
      return addr;
    }
    let done = 0;
    const total = ranges.reduce((s, r) => s + (r.end - r.start), 0) || 1;
    const tried = [];
    for (const r of ranges){
      for (let a = r.start; a < r.end; a += chunk - (CB_ID.length - 1)){
        const n = Math.min(chunk, r.end - a);
        if (n < 16) break;
        let buf;
        try { buf = await mem.readMem(a, n); }
        catch { buf = new Uint8Array(0); }          // 该段不可读（没映射）就跳过
        const s = latin1(buf);
        let i = s.indexOf(CB_ID);
        while (i >= 0){
          const cand = a + i;
          const v = await Rtt.validate(mem, cand);
          if (v.ok) return cand;
          tried.push({ addr: cand, reason: v.reason });
          i = s.indexOf(CB_ID, i + 1);
        }
        done += n;
        onProgress?.(Math.min(1, done / total), a);
      }
    }
    if (tried.length){
      const t = tried[0];
      throw new Error(`找到 ${tried.length} 处 "SEGGER RTT"，但结构都不可信（第一个 0x${t.addr.toString(16)}：${t.reason}）`);
    }
    return 0;
  }

  /** 校验某个地址是不是合理的控制块（结构自洽才认） */
  static async validate(mem, addr){
    const budget = new OperationBudget('校验 RTT 控制块', 15000);
    try {
      /**
       * 🚨 头 24 字节**必须重试**（2026-10 HPM6800EVK 真机定因）：
       *    探针的 RISC-V/SBA 读会**偶发返回全 0**（同一地址连读 20 次全对，但中间会插一次全 0；
       *    实测还见过 `sbcs.sbbusy` 常驻的挂起事务），一次就把"控制块好好的目标"判成
       *    「没有 "SEGGER RTT" 标识」—— 界面表现正是用户说的"Viewer 时好时坏、连不上"。
       *    读失败或读到全 0 就**重启一次链路再读**，最多 3 次；3 次都不行才认账。
       */
      let hdr = await budget.step('读取标识', () => mem.readMem(addr, 24));
      for (let i = 0; i < 2 && !hasCbId(hdr); i++){
        await budget.step('恢复读取链路', () => recoverMem(mem));
        await sleepMs(80);
        hdr = await budget.step('重新读取标识', () => mem.readMem(addr, 24));
      }
      if (!hasCbId(hdr)) return { ok: false, reason: `没有 "SEGGER RTT" 标识${allZero(hdr) ? '（读到全 0，重试 3 次仍如此）' : ''}` };
      const maxUp = u32le(hdr, 16), maxDown = u32le(hdr, 20);
      if (maxUp < 1 || maxUp > 16 || maxDown > 16) return { ok: false, reason: `通道数不合理（up=${maxUp} down=${maxDown}）` };
      const upBase = addr + 24, downBase = upBase + ENTRY * maxUp;
      let used = 0, bytes = 0;
      for (let i = 0; i < maxUp + maxDown; i++){
        const base = i < maxUp ? upBase : downBase;
        const idx = i < maxUp ? i : i - maxUp;
        const b = await mem.readMem(base + ENTRY * idx, ENTRY);
        const size = u32le(b, 8), wr = u32le(b, 12), rd = u32le(b, 16), pbuf = u32le(b, 4);
        if (!size) continue;                                   // 没用到的通道
        used++;
        if (size > MAX_CH_BYTES) return { ok: false, reason: `通道 ${i} 缓冲大小 ${size} 不合理（> ${MAX_CH_BYTES} 上限）` };
        if (wr >= size || rd >= size) return { ok: false, reason: `通道 ${i} 读写指针越界（wr=${wr} rd=${rd} size=${size}）` };
        if (!pbuf || (pbuf & 3)) return { ok: false, reason: `通道 ${i} 缓冲指针无效（0x${pbuf.toString(16)}）` };
        bytes += size;
      }
      if (!used) return { ok: false, reason: '所有通道都没配置缓冲' };
      if (!bytes) return { ok: false, reason: '缓冲总大小为 0' };
      return { ok: true, reason: '', maxUp, maxDown, used, bytes };
    } catch (e){
      return { ok: false, reason: '读取失败：' + (e?.message || e) };
    }
  }

  async init(addr = this.addr){
    this._initBudget = new OperationBudget('初始化 RTT 通道', 15000);
    try { return await this._initNow(addr); }
    finally { this._initBudget = null; }
  }
  async _initNow(addr){
    const hdr = await this.mem.readMem(addr, 24);
    if (latin1(hdr.subarray(0, 10)) !== CB_ID){
      throw new Error(`0x${addr.toString(16)} 处不是 RTT 控制块（读到 "${latin1(hdr.subarray(0, 16))}"）`);
    }
    this.addr = addr;
    this.maxUp = u32le(hdr, 16);
    this.maxDown = u32le(hdr, 20);
    if (this.maxUp > 16 || this.maxDown > 16) throw new Error(`控制块里的通道数不合理（up=${this.maxUp} down=${this.maxDown}）`);
    this.upBase = addr + 24;
    this.downBase = this.upBase + ENTRY * this.maxUp;
    this.up = []; this.down = [];
    for (let i = 0; i < this.maxUp; i++) this.up.push(await this._entry(this.upBase, i));
    for (let i = 0; i < this.maxDown; i++) this.down.push(await this._entry(this.downBase, i));
    this._lastWr.clear(); this._backlog.clear(); this._lost.clear();
    return this;
  }

  /**
   * 读一个通道表项（24 字节）。
   *
   * 🚨 读**一次不通过结构校验就重读**：探针的 AP 读是挂起读，紧跟写/换地址之后
   *    偶尔会拿到上一笔事务的残渣（实测读到过 size=560229490、pbuf=0xd 这种）。
   *    这类垃圾几乎都过不了下面的合理性校验，所以"按需重读"比"无脑读两遍"划算得多
   *    （后者把 RTT 吞吐砍掉一半，实测 330 → 154 KB/s）。
   *
   * 🚨 2026-10 HPM6800EVK 追加：RISC-V/SBA 那条路会**偶发读回全 0 / 挂起**，
   *    第二次失败时顺手让链路自愈一次（`mem.recover()` = 复位调试模块）再试 —— 用户看到的现象
   *    是"轮询在跑但一个字节都不来 / 一会儿好一会儿坏"，重试+自愈能把它拉回来。
   */
  async _entry(base, i){
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++){
      this._initBudget?.check(`读取通道 ${i}`);
      try { return await this._entryOnce(base, i); }
      catch (e){
        lastErr = e;
        if (attempt === 1) await recoverMem(this.mem);
      }
    }
    throw lastErr;
  }

  async _entryOnce(base, i){
    const b = await this.mem.readMem(base + ENTRY * i, ENTRY);
    const e = { sName: u32le(b, 0), pbuf: u32le(b, 4), size: u32le(b, 8), wr: u32le(b, 12), rd: u32le(b, 16), flags: u32le(b, 20) };
    // 合理性检查：目标刚复位/没在跑时，控制块位置可能只剩旧数据或 0，
    // 不检查的话会拿垃圾指针去读（甚至读到天文数字长度 → RangeError）。
    if (e.size > MAX_CH_BYTES) throw new Error(`RTT 通道 ${i} 的缓冲大小不合理（${e.size} > ${MAX_CH_BYTES}）→ 目标可能刚复位或没在运行`);
    if (e.size && (e.wr >= e.size || e.rd >= e.size)) throw new Error(`RTT 通道 ${i} 的读写指针越界（wr=${e.wr} rd=${e.rd} size=${e.size}）→ 控制块内容不可信`);
    if (e.size && !e.pbuf) throw new Error(`RTT 通道 ${i} 的缓冲指针是 0 → 控制块内容不可信`);
    return e;
  }

  /**
   * 通道名（存在目标内存里，按需读一次）。
   *
   * 🚨 **必须带超时**（2026-10 真机踩到，HPM6800EVK/RISC-V）：通道名是个**目标内存里的指针**，
   *    固件把它放在哪不受我们控制 —— 本例里 `sName = 0x8000cf1c` 落在 XIP flash 窗口，
   *    探针的 SBA 读那个窗口会**永久挂起**（而且挂起后整条链路都不应答）。
   *    名字只是显示用的锦上添花，绝不能让"连上 RTT"这一步被它拖死 —— 读不到就当没有名字。
   */
  async name(dir, ch){
    const e = (dir === 'up' ? this.up : this.down)[ch];
    if (!e || !e.sName) return '';
    const k = `${dir}${ch}`;
    /**
     * 后端声明"这个名字读不得"就直接跳过（RISC-V 的 `RiscvMem.skipNames`）：
     * 1.2 s 超时只是**保护**，不是解药 —— 超时后那笔 SBA 事务还挂着，会把
     * `sbcs.sbbusyerror` 置成 sticky（写 1 才清），之后每个环读都直接失败，
     * 整条 Viewer 白连（真机现场见 make hw-campaign-hpm）。
     * ARM 那条路（AHB-AP 读 flash 没问题）不设这个标志，照旧读名字。
     */
    if (this.mem?.skipNames){
      this._names.set(k, '');
      return '';
    }
    if (!this._names.has(k)){
      let nm = '';
      try {
        const buf = await Promise.race([
          this.mem.readMem(e.sName, 16),
          new Promise(res => setTimeout(() => res(null), 1200)),
        ]);
        if (buf) nm = latin1(buf.subarray(0, 16)).replace(/\0.*$/, '');
      } catch {}
      this._names.set(k, nm);
    }
    return this._names.get(k);
  }

  // ---------------- 上行（目标 → 主机） ----------------
  /**
   * @returns {Promise<{bytes:Uint8Array, lost:number, full:boolean, high:boolean,
   *                    level:number, wr:number, rd:number, backlog:number}>}
   *   level = 环里**未读数据**占缓冲容量（size-1）的比例；high = 水位 ≥ 3/4；
   *   backlog = 这一轮读完还剩多少没读（>0 说明数据比链路快，下一轮接着排）。
   */
  async readUp(ch = 0){
    const e = await this._entry(this.upBase, ch);            // 每次整项重读：WrOff/RdOff 一致，且能跟上固件重新初始化缓冲
    this.up[ch] = e;
    const empty = { bytes: new Uint8Array(0), lost: 0, full: false, high: false, level: 0, wr: e.wr, rd: e.rd, backlog: 0 };
    if (!e.size) return empty;
    let n = e.wr - e.rd;
    if (n < 0) n += e.size;

    /**
     * 「被覆盖丢掉多少」的记账（分块读之后必须换算法）。
     *
     * 老算法是 `本轮目标写入量 - 本轮读到的字节` —— 那是建立在"一次读完整段"之上的。
     * 分块之后"故意留到下一轮读的"会被算成丢失（数字虚高、还可能误导成链路丢数据）。
     * 改成按积压对账：`上一轮剩下的 + 本轮目标写入的 - 现在环里真有的` = 被目标覆盖掉的。
     * BLOCK_IF_FIFO_FULL 的目标（本仓自测靶子都是）永远不会覆盖，这里恒为 0 —— 对得上。
     */
    const prevBacklog = this._backlog.get(ch) || 0;
    const prevWr = this._lastWr.get(ch);
    let lost = 0;
    if (prevWr !== undefined){
      const advanced = (e.wr - prevWr + e.size) % e.size;
      lost = Math.max(0, prevBacklog + advanced - n);
      if (lost) this._lost.set(ch, (this._lost.get(ch) || 0) + lost);
    }
    this._lastWr.set(ch, e.wr);
    this._backlog.set(ch, n);                                // 先按"一个字节都没读走"记，读成功后再减

    if (n === 0) return empty;
    /** 本轮实际读多少：见 MAX_READ_PER_POLL（大积压 + 慢链路时一次读完整段会直接失败）*/
    const readNow = Math.min(n, MAX_READ_PER_POLL);

    let data;
    /**
     * 读一段上行数据：**绕回时必须分两段读**（缓冲末端 + 开头）。
     * 抽成函数是因为下面的"错位读重试"也得走同一条路 —— 老代码重试只读了
     * `readMem(pbuf + rd, n)` 单段，绕回时那会跨过缓冲末端去读相邻内存：
     * 只要重试回来的内容里恰好没有 "SEGGER RTT" 签名，就被当成正常数据用掉并推进 RdOff，
     * 于是**未绕回的错误数据静默进了日志**（代码审查抓到的）。
     */
    const readSpan = async () => {
      if (e.rd + readNow <= e.size) return await this.mem.readMem(e.pbuf + e.rd, readNow);
      const n1 = e.size - e.rd;
      const a = await this.mem.readMem(e.pbuf + e.rd, n1);
      const b = await this.mem.readMem(e.pbuf, readNow - n1);
      const out = new Uint8Array(a.length + b.length);
      out.set(a); out.set(b, a.length);
      return out;
    };
    data = await readSpan();

    // 错位读防护：高速下 SWD 偶发把别的地址内容读回来，最明显的指纹是**整个控制块**被读回来
    // （见 `_looksCorrupt` 的判据）。整段丢弃、**不推进 RdOff** —— 下一轮会原样重读，数据不丢；
    // 若时钟太高持续出错，表现为 corrupt 一直涨，提示降时钟。
    if (this._looksCorrupt(data)){
      const retry = await readSpan();                          // 先立即重读一次（同样两段逻辑）
      if (this._looksCorrupt(retry)){
        return { ...empty, backlog: n, corrupt: true };         // 没读走任何东西 → 积压照旧
      }
      data = retry;
    }

    /** RdOff 只推进**本轮真读到的**那么多个字节（分块读的关键：留到下一轮继续，不丢也不阻塞）*/
    const newRd = (e.rd + readNow) % e.size;
    await this.mem.writeMem(this.upBase + ENTRY * ch + 16, u32leBytes(newRd));
    this._backlog.set(ch, n - readNow);

    // 过载信号：水位（环形缓冲最多装 size-1）
    const cap = e.size - 1;
    const level = cap > 0 ? n / cap : 0;
    const full = n >= cap;
    const high = level >= 0.75;
    if (full) this._full.set(ch, (this._full.get(ch) || 0) + 1);
    if (high) this._high.set(ch, (this._high.get(ch) || 0) + 1);
    if (level > this.peak) this.peak = level;

    return { bytes: data, lost, full, high, level, wr: e.wr, rd: e.rd, backlog: n - readNow };
  }

  /**
   * 错位读指纹：**整个控制块被读回来了**，而不是"数据里出现了这几个字"。
   *
   * 🚨 老判据是 `data.includes('SEGGER RTT')`（2026-10 代码审查抓到，后果是致命的）：
   *    目标自己 `printf("SEGGER RTT ready")` 时，每一轮重读都得到同样的内容 → 整段丢弃、
   *    **RdOff 永不推进 → 这条通道永久卡死**（一条日志都出不来），上层还会误报成
   *    「SWD 链路不稳定，把时钟调低」，把排查方向带偏。
   *
   * 现在的判据是"签名后面紧跟**本控制块的两个通道数字段**"（MaxUp @+16、MaxDown @+20）——
   * 这才是"把控制块读回来了"的指纹：目标打印的那串字后面不可能是这两个数。
   * 签名落在读取窗口末尾、来不及核对字段时**当正常数据放行**：宁可漏一次防护，
   * 也不能再把通道卡死（真错位读还有"重读一次"那道防线兜着）。
   */
  _looksCorrupt(data){
    const s = latin1(data);
    const first = s.indexOf(CB_ID);
    if (first < 0) return false;
    for (let i = first; i >= 0; i = s.indexOf(CB_ID, i + 1)){
      if (i + 24 > data.length) continue;                       // 字段不全 → 无法确认，放过
      if (u32le(data, i + 16) === this.maxUp && u32le(data, i + 20) === this.maxDown) return true;
    }
    return false;
  }

  totalLost(ch){ return this._lost.get(ch) || 0; }
  fullCount(ch){ return this._full.get(ch) || 0; }
  highCount(ch){ return this._high.get(ch) || 0; }

  // ---------------- 下行（主机 → 目标） ----------------
  /** 写多少算多少（目标不来取就只能写满缓冲）；返回实际写入字节数 */
  async writeDown(ch, bytes){
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!data.length) return 0;
    const e = await this._entry(this.downBase, ch);
    this.down[ch] = e;
    if (!e.size) return 0;
    const free = (e.size - 1 + e.rd - e.wr + e.size) % e.size;
    const n = Math.min(data.length, free);
    if (n <= 0) return 0;
    const part = Math.min(n, e.size - e.wr);
    if (part === n){
      await this.mem.writeMem(e.pbuf + e.wr, data.subarray(0, n));
    } else {
      await this.mem.writeMem(e.pbuf + e.wr, data.subarray(0, part));
      await this.mem.writeMem(e.pbuf, data.subarray(part, n));
    }
    await this.mem.writeMem(this.downBase + ENTRY * ch + 12, u32leBytes((e.wr + n) % e.size));
    return n;
  }

  info(){
    return {
      addr: this.addr, maxUp: this.maxUp, maxDown: this.maxDown,
      up: this.up.map((e, i) => ({ ch: i, size: e.size, pbuf: e.pbuf, wr: e.wr, rd: e.rd, flags: e.flags })),
      down: this.down.map((e, i) => ({ ch: i, size: e.size, pbuf: e.pbuf, wr: e.wr, rd: e.rd, flags: e.flags })),
    };
  }
}
