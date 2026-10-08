/**
 * 调试器页的 **RISC-V / JTAG 后端**（HPM6800EVK 等，2026-10）。
 *
 * 设计：**继承 `DebugSession`，只换掉"跟硬件打交道"的那一层**。
 * 源码级断点、单步跳过/进入/跳出、运行到光标、结构体树、命令行、符号表、行号表
 * 全都是架构无关的，已经在 `session.js` / `cmd.js` / `watch.js` / `{lines,dwarf}.js` 里，
 * 这里只提供：
 *   · 打开通路（HID 切 SWD+JTAG → WebUSB → DAP_JTAG → RISC-V DM；现成的
 *     `app/flash/hpm/{dap-transport,riscv-dm}.js`，RTT Viewer 的 RISC-V 通路用的同一套）
 *   · 停/跑/单步（`dmcontrol.haltreq` / `dcsr.step`）
 *   · 寄存器（抽象命令；CSR 的 regno 就是 CSR 号）
 *   · 内存（SBA）
 *   · **硬件断点 = 触发器**（`tselect`/`tdata2`/`tdata1`，8 个槽位）
 * 架构相关的"指令解码/落点/返回地址校验"在 `app/dbg/rv.js` 里，通过
 * `DebugSession` 的 `this.arch`（`RV_ARCH`）接进去。
 *
 * 🚨 四条真机踩出来的硬约束（改这块前必读，都是 2026-10 在 HPM6800EVK + akaLinkPro 上定的）：
 *   ① **`dmcontrol` 是老排法**：`haltreq = bit31`、`resumereq = bit30`、`hartsel = [25:16]`
 *      （不是规范 0.13 的 16/17）。按规范写 `1<<17` 会落进 hartsel → DM 认为"选了个不存在的
 *      hart"，`dmstatus` 立刻变 `allnonexistent`（0x40c0a2），之后**所有抽象命令 cmderr=4**。
 *      常量一律用 `app/flash/hpm/jtag.js` 里标定过的 `DMCONTROL`。
 *   ② **抽象命令（读寄存器 / 读 CSR / 写触发器）要求 hart 已经停住**，否则 cmderr=4（halt/resume）；
 *      SBA 读内存不受这个限制。
 *   ③ **CSR 不走单独的字段**：抽象命令的 `regno` 在 0x000~0xfff 这一档**就是 CSR 号本身**
 *      （0x7b0=dcsr、0x7b1=dpc、0x7a0=tselect…），GPR 是 0x1000+n。
 *   ④ **`dcsr.step` 这颗核不会自动清**（规范说会）—— 单步完必须手工清，否则"继续"会一直单步。
 */
import { DebugSession } from './session.js';
import { RV_ARCH } from './rv.js';
import { DMCONTROL, DMSTATUS_LAYOUT, REGNO, DCSR_EBREAK } from '../flash/hpm/jtag.js';
import { RiscvTransport } from '../flash/hpm/riscv-dm.js';
import { DapJtagTransport, setOutputModeData, PROBE_OUTPUT_MODE } from '../flash/hpm/dap-transport.js';
import { AkaLinkHid } from '../hid/probe.js';
import { WebUsbDapProbe, withTimeout } from '../rtt/dap-webusb.js';
import { closeProbeUsbDevices } from '../core/probe-bus.js';
import { resolveHpmTarget, assertHpmIdentity, overlapsSbaFence } from '../targets/hpm/porting.js';
import { sleep, waitMs } from '../core/pace.js';
import { align2 } from './fmt.js';

/** `dcsr.step`（bit2）：置上它 + resume = 执行一条指令后再进调试模式 */
const DCSR_STEP = 1 << 2;
/** 单步时把 `ebreak*` 一起置上（OpenOCD 也是这么做的；`prepareRun()` 里同理）*/
const EBREAK_ALL = (DCSR_EBREAK.m | DCSR_EBREAK.s | DCSR_EBREAK.u) >>> 0;

/**
 * 触发器的 mcontrol 编码 —— **从 OpenOCD 的真实写入抓下来的**（`openocd -d3` 里
 * `tdata1 <- 0x2980105c`，其中读出值是 0x21800000）：在位域上补
 *   dmode(bit27) + action=1 进调试模式(bit15:12) + m/s/u/execute(bit6/4/3/2)。
 * 实测：写进去之后 resume，**1 ms** 内精确停在目标地址；清断点写 0 即可（回 0x21800000）。
 */
const MCONTROL_SET = 0x0800105c;

/** CSR 号（抽象命令直接拿它当 regno 用）*/
const CSR = { mstatus: 0x300, mtvec: 0x305, mepc: 0x341, mcause: 0x342, mtval: 0x343, tselect: 0x7a0, tdata1: 0x7a1, tdata2: 0x7a2 };
/** tselect 写这个值 = **不选任何触发器**（规范：>= 触发器个数就是"没有选中"）*/
const TSELECT_NONE = 0x80000000;

/** RV32I 的 32 个通用寄存器（ABI 名，顺序 = x0..x31）*/
const XREGS = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
               's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
               'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
               's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
/** 寄存器表里额外摆几个常用 CSR（读得到、看得懂）*/
const SHOW_CSRS = [['mstatus', 0x300], ['mtvec', 0x305], ['mepc', 0x341], ['mcause', 0x342], ['mtval', 0x343], ['dcsr', 0x7b0]];

/** 名字 → {regno, kind}；认识 xN / ABI 名 / pc / 常用 CSR */
export function rvRegno(name){
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'pc' || s === 'dpc') return { regno: REGNO.PC, kind: 'pc' };
  if (s === 'dcsr') return { regno: REGNO.DCSR, kind: 'csr' };
  if (Object.prototype.hasOwnProperty.call(CSR, s)) return { regno: CSR[s], kind: 'csr' };
  let i = XREGS.indexOf(s);
  if (i < 0){
    const m = /^x(\d+)$/.exec(s);
    if (m && Number(m[1]) < 32) i = Number(m[1]);
  }
  return i < 0 ? null : { regno: 0x1000 + i, kind: 'gpr', index: i };
}

export class RiscvDebugSession extends DebugSession {
  constructor({ target } = {}){
    super();
    this.arch = RV_ARCH;                  // 指令解码/落点/返回地址校验都换成 RISC-V 那份
    this.isRiscv = true;
    this.port = resolveHpmTarget(target);
    this.dm = null;                       // RiscvTransport（DMI/SBA/抽象命令）
    this.jtag = null;
    this.caps = { numCode: 0, rev: 2, raw: 0 };
    this.backendName = 'RISC-V/JTAG';
  }

  // ---------------------------------------------------------------- 连接

  /**
   * 打开 RISC-V 通路。与 ARM 那条路的差别（`app/rtt/riscv-mem.js` 的注释里有完整版）：
   *   · HID 必须**每次**发 `output_mode = SWD+JTAG`（读回来看是 1 也没用）；
   *   · 还要让探针自己的 RISC-V 引擎与 RTT 桥**放开 TAP**（HID 0x33/0x31 的 action 0）；
   *   · `WebUsbDapProbe.open` 必须 `skipTargetInit: true` —— 默认那套按 SWD 协商，RISC-V 上必 NO ACK。
   */
  async connect({ clockKhz = 0, all = false, bus = null, target = this.port } = {}){
    if (this.probe) throw new Error('已经连接了（先断开）');
    this.port = resolveHpmTarget(target);
    if (bus?.supported){
      const r = await bus.requestRelease({ why: '调试页要占用探针（RISC-V/JTAG）' });
      if (r.asked) this._log(`跨页签协调：请 ${r.asked} 个其他页签让出探针，${r.acked} 个确认（等了 ${r.ms} ms）`, 'dim');
    }
    try { const n = await closeProbeUsbDevices(); if (n) this._log(`关掉 ${n} 个残留的探针句柄`, 'dim'); } catch {}

    // ① HID：切 JTAG + 让探针侧两个"占 TAP 的家伙"让位
    const hid = new AkaLinkHid();
    try {
      await withTimeout(hid.reconnect(), 8000, '连探针 HID');
      await withTimeout(hid.xfer(0x02, setOutputModeData(PROBE_OUTPUT_MODE.SWD_JTAG)), 3000, '切输出模式');
      this._log('探针 output_mode = SWD+JTAG', 'dim');
    } catch (e){
      this._log('⚠ 切 output_mode 失败（继续试 JTAG）：' + (e?.message || e), 'warn');
    }
    try { await withTimeout(hid.riscvStop(), 2000, 'RISC-V 引擎 stop'); this._log('已让探针 RISC-V 引擎放开 TAP', 'dim'); } catch {}
    try { await withTimeout(hid.stop(), 2500, 'RTT 桥 stop'); } catch {}
    try { await hid.close(); } catch {}

    // ② WebUSB：认领 interface 0，**不做 SWD 目标初始化**
    let auth = [];
    try { auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针'); } catch {}
    const openOpts = { skipTargetInit: true };
    /**
     * 🚨 **开探针要重试**（2026-10 真机统计）：这颗 akaLinkPro 在被上一个会话中途放开之后，
     *    IN 端点里躺着**陈旧响应**，封包探测第一次会以
     *    `响应回显 0x3 ≠ 命令 0x0` 失败（页面刷新后大约 3 次里 1 次）。
     *    `dap-webusb` 内部已经清过一次队列，但偶尔还是会连吃两次陈旧包 ——
     *    这里再兜一层"关掉句柄、等一会儿、重新开"，实测第二次就通。
     *    （不重试的话表现是"偶发连不上 RISC-V"，用户只能手动再点一次连接。）
     */
    const openOnce = async () => {
      if (this.probe?.disconnect){ try { await this.probe.disconnect(); } catch {} }
      this.probe = null;
      return auth.length
        ? await withTimeout(WebUsbDapProbe.open(auth[0], openOpts), 20000, '连接探针（WebUSB）')
        : await withTimeout(WebUsbDapProbe.request(all, openOpts), 60000, '等你在浏览器里选探针');
    };
    for (let attempt = 1; ; attempt++){
      try { this.probe = await openOnce(); break; }
      catch (e){
        if (attempt >= 3) throw e;
        this._log(`开探针失败（第 ${attempt} 次：${e?.message || e}）—— 等一下重开`, 'warn');
        try { await this.probe?.disconnect?.(); } catch {}
        await sleep(300 * attempt);
      }
    }
    this.probe.onLog = s => this._log('   [usb] ' + s, 'dim');

    // ③ JTAG → DMI → DM
    if (Number(clockKhz) > 0){
      try { await this.probe.setClock(Number(clockKhz) * 1000); } catch (e){ this._log('设 JTAG 时钟失败：' + (e?.message || e), 'warn'); }
    }
    this.jtag = new DapJtagTransport(this.probe, { irLength: this.port.debug.irLength, log: s => this._log('   [jtag] ' + s, 'dim') });
    this.dm = new RiscvTransport(this.jtag, { port: this.port, log: s => this._log('   [dm] ' + s, 'dim') });
    const info = await withTimeout(this.dm.init(), 20000, '初始化 RISC-V 调试模块');
    assertHpmIdentity(this.port, info);
    this.clockHz = Number(clockKhz) > 0 ? Number(clockKhz) * 1000 : 0;
    this.idcode = info?.idcode >>> 0;
    this.name = `RISC-V/JTAG · DM v${((info?.dmstatus ?? 0) >>> 0).toString(16)}`;
    this._log(`已连接：RISC-V/JTAG　IDCODE=0x${this.idcode.toString(16).toUpperCase()}　dmstatus=0x${((info?.dmstatus ?? 0) >>> 0).toString(16)}`, 'ok');
    await this.refresh();
    await this.bpInit();
    return this;
  }

  async disconnect(){
    this.clearFrames();
    const dm = this.dm, p = this.probe;
    try { if (dm) for (let i = 0; i < 8; i++){ await dm.writeReg(CSR.tselect, i); if ((await dm.readReg(CSR.tdata1)) !== 0x21800000) await dm.writeReg(CSR.tdata1, 0); } } catch {}
    try { await dm?.sbaClearErrors(); } catch {}
    if (p?.disconnect) await p.disconnect();
    this.dm = null; this.jtag = null; this.probe = null;
    this.halted = false; this.regs = []; this._prev = null; this.bps = [];
    this._xipFallbackLogged = false;
    this._badAddrs?.clear();
    if (p) this._log('已断开探针', 'dim');
  }

  // ---------------------------------------------------------------- 状态

  async _pollHalted(){
    const st = (await this.dm.dmiRead(0x11)) >>> 0;
    const layout = DMSTATUS_LAYOUT[this.dm.dmLayout || this.dmLayout] || DMSTATUS_LAYOUT.legacy;
    const halted = layout.allhalted | layout.anyhalted;
    const running = layout.allrunning | layout.anyrunning;
    this.dm.lastDmstatus = st;
    if ((st & 0xf) !== 2) throw new Error(`无法确认目标停机/运行状态：dmstatus=0x${st.toString(16)}`);
    const unavailable = layout.allunavail | layout.anyunavail;
    if (st & unavailable) throw new Error(`目标不可用：dmstatus=0x${st.toString(16)}`);
    if ((st & halted) === halted && !(st & running)) return true;
    if ((st & running) === running && !(st & halted)) return false;
    throw new Error(`无法确认目标停机/运行状态：dmstatus=0x${st.toString(16)}`);
  }

  async _pollRunning(){ return !(await this._pollHalted()); }

  /**
   * 等"目标**真的**跑起来了"，再开始等它停 —— 不加这一步会踩**陈旧读数**的坑。
   *
   * 🚨 2026-10 真机定因（HPM6800EVX + dcsr.step 单步 / 临时断点）：
   *    `resumereq` 写下去之后，DM 有**一小段时间**仍然报 `halted=1`（它自己还没处理完这请求）。
   *    我们的等待循环若第一拍就信了它，会立刻"当成已经停下"返回：
   *      · 单步 → 返回的 PC 跟原来一样（"点了单步没反应"），
   *      · 继续/临时断点 → 拿旧 PC 当命中点，**把触发器又装回去、还把 dcsr.step 清掉**，
   *        等 DM 真把核放开时，核带着"已装回的断点 + 没有 step"重新执行同一条指令 → 原地再命中。
   *    判据三条，任一成立就算"确实跑起来了"：
   *      ① dmstatus 报 running（[11:10]）；
   *      ② dmstatus 不报 halted 了；
   *      ③ PC 已经不是起步地址（单步一条、或立刻命中都会让它变）。
   *    `dpc` 是抽象命令、要求核停住，读失败不影响判断（跳过这一条）。
   *
   * @param {number|null} pc0 起步 PC（不知道就传 null）
   * @returns {Promise<boolean>} 有没有观察到"真的跑起来"
   */
  async _waitResumed(pc0 = null, timeoutMs = 300){
    const t0 = Date.now();
    for (;;){
      let st = 0;
      try { st = (await this.dm.dmiRead(0x11)) >>> 0; } catch { return false; }
      if (((st >>> 10) & 3) !== 0) return true;                 // ① running
      if (((st >>> 8) & 3) !== 3) return true;                  // ② 已经不在"停"态
      if (pc0 != null){                                         // ③ PC 动了（单步/立刻命中）
        try {
          if (((await this.dm.readReg(REGNO.PC)) >>> 0) !== (pc0 >>> 0)) return true;
        } catch { /* 读不到就算了 */ }
      }
      if (Date.now() - t0 > timeoutMs) return false;
      await waitMs(2);
    }
  }

  async refresh(){
    if (!this.dm) return { halted: false, pc: 0 };
    const wasHalted = this.halted, oldPc = this.pc;
    this.halted = await this._pollHalted();
    if (this.halted) this.pc = (await this.dm.readReg(REGNO.PC)) >>> 0;
    if (!this.halted || !wasHalted || this.pc !== oldPc) this.clearFrames();
    return this.statusInfo();
  }

  // ---------------------------------------------------------------- 寄存器

  async refreshRegs(){
    if (!this.dm) return [];
    /**
     * 🚨 抽象命令**要求 hart 停住**。运行中读会 cmderr=4 —— 这时候**保留上一次的行**，
     *    别把 0 写进寄存器表（那会让人以为寄存器真的变 0 了，ARM 那边读到的只是陈旧值）。
     */
    if (this.halted) this.halted = await this._pollHalted();
    if (!this.halted){
      this.clearFrames();
      if (!this._regsStaleLogged){ this._log('目标在运行时读不到寄存器（RISC-V 的抽象命令要求先停住）—— 先「暂停」再看', 'dim'); this._regsStaleLogged = true; }
      return this.regs;
    }
    this._regsStaleLogged = false;
    const list = [];
    for (let i = 0; i < 32; i++){
      const v = (await this.dm.readReg(0x1000 + i)) >>> 0;
      list.push({ name: XREGS[i], value: v, index: i, kind: 'gpr', note: `x${i}` });
    }
    const pcv = (await this.dm.readReg(REGNO.PC)) >>> 0;
    list.push({ name: 'pc', value: pcv, kind: 'pc' });
    for (const [nm, num] of SHOW_CSRS){
      let v = 0;
      try { v = (await this.dm.readReg(num)) >>> 0; } catch { continue; }
      list.push({ name: nm, value: v, csr: num, kind: 'csr' });
    }
    const prev = this._prev;
    for (const r of list) r.changed = !!prev && prev[r.name] !== undefined && prev[r.name] !== r.value;
    this._prev = Object.fromEntries(list.map(r => [r.name, r.value]));
    this.regs = list;
    this.pc = pcv;
    return list;
  }

  /** cmd.js 用：按名字找寄存器行（ARM 那边是 regs.js 的 regInfo）*/
  regInfo(name){
    const r = rvRegno(name);
    if (!r) return null;
    const label = r.kind === 'gpr' ? XREGS[r.index] : (r.kind === 'pc' ? 'pc' : Object.keys(CSR).find(k => CSR[k] === r.regno) || 'csr');
    return { name: label, regno: r.regno, kind: r.kind };
  }

  async readReg(name){
    const r = rvRegno(name);
    if (!r) throw new Error(`不认识的寄存器「${name}」（RV32：x0..x31 / ABI 名 / pc / 常用 CSR）`);
    if (!this.halted) throw new Error('抽象命令要先停住目标（先「暂停」）');
    await this._ensureHalted('readReg ' + name);
    return (await this.dm.readReg(r.regno)) >>> 0;
  }

  async writeReg(name, value){
    this.clearFrames();
    const r = rvRegno(name);
    if (!r) throw new Error(`不认识的寄存器「${name}」`);
    if (r.regno === 0x1000) throw new Error('x0 是硬连 0，写不进去');
    if (!this.halted) throw new Error('抽象命令要先停住目标（先「暂停」）');
    await this._ensureHalted('writeReg ' + name);
    await this.dm.writeReg(r.regno, value >>> 0);
    return (await this.dm.readReg(r.regno)) >>> 0;
  }

  /**
   * 🚨 抽象命令要求 hart **真的停着**（否则 cmderr=4/5，而且那条 cmderr 还会 sticky 住
   *    之后每一条命令）。而 `this.halted` 是**缓存**：上一格（编断点 / 临时断点单步 /
   *    外部复位）可能已经把核放跑了，缓存却还是 true。
   *
   *    真机现场（2026-10，make full_flow_6800evk → test-dbg-riscv）：连续挂 4 个断点后
   *    `go` 的第一步 `readReg('PC')` 就撞上 `cmderr=3`。所以这里**用 dmstatus 现场核一遍**，
   *    发现跑着就先 halt 再继续 —— 只在这条"缓存说停着"的路径上多读一次 dmstatus。
   */
  async _ensureHalted(what){
    const live = await this._pollHalted();   // 读不到就按缓存继续（别把调试卡死）
    if (live) return;
    this._log(`${what}：目标其实在跑（dmstatus 说没停）→ 先「暂停」再继续`, 'warn');
    await this.halt();
  }

  // ---------------------------------------------------------------- 内存（SBA）

  /** Memory readiness is chip-specific; it must never initialize/reset the target. */
  async _checkExternalRam(addr, length){
    await (this.port || resolveHpmTarget()).hooks.checkMemoryReady(this, addr, length);
  }

  /** Read target RAM via SBA; XIP uses only fully covered ELF image bytes.
   * A read failure must never reset DM/hart or restart the debugged program.
   */
  async memRead(addr, len){
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xffffffff ||
        !Number.isInteger(len) || len < 0 || addr + len > 0x100000000)
      throw new Error('内存地址或长度超出 32 位地址空间');
    if (!len) return new Uint8Array(0);
    const a = addr, n = len;
    if (overlapsSbaFence(this.port || resolveHpmTarget(), a, n)){
      // A request crossing into/out of XIP must not touch SBA, even partially.
      const port = this.port || resolveHpmTarget();
      const inside = port.memory.sbaReadForbidden.some(r => a >= r.start && a + n <= r.end);
      const b = inside ? this.sym?.codeBytes?.(a, n) : null;
      if (!b || b.length !== n)
        throw new Error('XIP/flash 数据不可用：载入的 ELF 只读段未完整覆盖请求；未访问 SBA，未补零');
      if (!this._xipFallbackLogged){
        this._xipFallbackLogged = true;
        this._log('XIP/flash 读取使用已载入 ELF 的只读镜像，未读取目标实时内存；请确保 ELF 与目标固件一致。', 'warn');
      }
      return b;
    }
    if (!this._badAddrs) this._badAddrs = new Map();
    // Readiness is checked afresh and is not a cached bad-address failure:
    // after startup completes, the same watch must become readable immediately.
    await this._checkExternalRam(a, n);
    const key = `${a}:${n}`, bad = this._badAddrs.get(key);
    if (bad && Date.now() - bad.at < 15000)
      throw new Error(bad.msg + '（同一读取范围失败后暂停重试 15 秒）');
    try {
      const got = await this.dm.readMem(a, n, 1500);
      this._badAddrs.delete(key);
      return got;
    } catch (e){
      const msg = String(e?.message || e);
      // Transport errors already used their bounded cleanup budget. A plain
      // backend failure may clear sticky flags, but never initialize/reset DM.
      if (!e.sbaHandled && !this.dm._wireFault){
        try { await this.dm.sbaClearErrors?.(); } catch { /* Preserve original failure. */ }
      }
      if (this._badAddrs.size >= 256) this._badAddrs.delete(this._badAddrs.keys().next().value);
      this._badAddrs.set(key, { msg, at: Date.now() });
      this._log(`读 0x${a.toString(16)}（${n} B）失败：${msg}。未自动复位调试模块或目标；若链路持续异常，请显式复位或重新连接。`, 'warn');
      throw e;
    }
  }

  async memWrite(addr, bytes){
    await this._checkExternalRam(addr, bytes.length);
    this.clearFrames();
    return await withTimeout(this.dm.writeMem(addr >>> 0, bytes), Math.max(4000, Math.ceil(bytes.length / 4) * 60), `SBA 写 ${bytes.length} 字节`);
  }

  /**
   * 取**指令字节**（`si` 解调用目标、断点单步算落点用）：**先看载入的 ELF，ELF 里没有才去读目标**。
   *
   * 🚨 2026-10 真机定因：这颗芯片上 **SBA 读 XIP 窗口（代码就住在 0x8000_0000 以上）会出错甚至
   *    把事务挂住**（现场 `SBA 读 0x80005898 出错 sbcs=0x4595c398`），而每次失败还会连带
   *    "两次 SBA + 一次 DM 重初始化"（慢，且有把 DM 搞得更糟的风险）。
   *    调试器要解码的指令必然就是**载入的那份 ELF 里的代码**（符号/行号都来自它），
   *    所以文件里那几个字节既准又零成本；目标内存读得到时也不需要它（ELF 里取不到才回落到读目标）。
   */
  async _codeBytes(addr, len){
    const b = this.sym?.codeBytes?.(addr >>> 0, len >>> 0);
    if (b && b.length >= len) return b;
    return await super._codeBytes(addr, len);
  }

  // ---------------------------------------------------------------- 硬件断点（触发器）

  /**
   * 让 hart 停下来 —— **只写 haltreq**（不碰 ndmreset），失败就重新初始化 DM 再试。
   *
   * 🚨 为什么不直接调 `dm.halt()`：那个入口在 haltreq 超时后会自动**退回 reset-halt**
   *    （`ndmreset|haltreq` → 松 ndmreset）。调试会话里这是"把目标整颗复位"的重手：
   *    真机压测里连续几十次单步后 DMI 偶发不应答（`dmstatus` 读回 0），
   *    这时一记 reset-halt 会把板子按在复位态、状态全丢，而且**问题不在目标**。
   *    所以这里自己走"安静停机"：先纯 haltreq，不行先治 DM（`dm.init()` 里有 dmactive 0→1、
   *    TAP 复位 + dmihardreset、DMI 冻住判别），治好再停一次；仍然失败则报错，不自动系统复位。
   */
  async _haltQuiet(hart = this.port?.debug.hart ?? 0, timeoutMs = 2500){
    await this.dm.dmiWrite(0x10, this.dm._ctl(hart, DMCONTROL.haltreq));
    return await this.dm.waitHalted(timeoutMs);
  }

  async _haltWithHeal(why = '停机', hart = this.port?.debug.hart ?? 0, timeoutMs = 2500){
    try { return await this._haltQuiet(hart, timeoutMs); }
    catch (e){
      this._log(`${why}失败（${e?.message || e}）—— 先重新初始化调试模块，再停一次`, 'warn');
      if (!await this._healDm(why)) throw e;
      try { return await this._haltQuiet(hart, timeoutMs); }
      catch (e2){
        throw new Error('暂停失败，未自动复位目标；请显式选择「复位并停」：' + (e2?.message || e2));
      }
    }
  }

  /**
   * DM 不应答时自救。`dm.init()` 里那套是现成的（dmactive 0→1、TAP 复位 + dtmcs.dmihardreset、
   * "两个 DM 寄存器读回同一个值"的冻结判别），真机偶发（`dmstatus` 读回 0）实测救得回来。
   * @returns {Promise<boolean>} 救回来没有
   */
  async _healDm(why = 'DM 不应答'){
    this.clearFrames();
    try {
      const r = await this.dm.init();
      this.dmLayout = this.dm.dmLayout;
      this._log(`调试模块已重新初始化（${why}）：dmstatus=0x${((r?.dmstatus ?? 0) >>> 0).toString(16)}`, 'dim');
      return true;
    } catch (e){
      this._log('重新初始化调试模块失败：' + (e?.message || e), 'err');
      return false;
    }
  }

  /**
   * "停一下做件事，完事放它继续" —— 抽象命令（读寄存器/读 CSR/写触发器）都要求 hart 停住，
   * 而用户在目标跑着的时候也可能按下断点。ARM 那边写 FPB 不需要停核，RISC-V 需要。
   */
  async _withHalted(fn, why = '操作'){
    const live = await this._pollHalted();
    this.halted = live;
    if (live) return await fn();
    this.clearFrames();
    this._log(`目标在跑：先停住目标来${why}，完事再放它继续`, 'dim');
    await this._haltWithHeal(why);
    this.halted = await this._pollHalted();
    if (!this.halted) throw new Error('停机未确认，未执行寄存器操作');
    const wasPc = this.pc;
    try { return await fn(); }
    finally {
      try { await this.dm.resume(null, this.port?.debug.hart ?? 0); this.halted = false; this.pc = wasPc; } catch {}
    }
  }

  /** 数一数这颗核有几个触发器，并把上次会话残留的清掉 */
  async bpInit(){
    let n = 0;
    try {
      n = await this._withHalted(async () => {
        let cnt = 0;
        for (let i = 0; i < 16; i++){
          try {
            await this.dm.writeReg(CSR.tselect, i);
            if (((await this.dm.readReg(CSR.tselect)) >>> 0) !== i) break;      // 写不进 = 没有这个槽位
            const t1 = (await this.dm.readReg(CSR.tdata1)) >>> 0;
            if (t1 !== 0x21800000 && (t1 & 0x7ff) !== 0) await this.dm.writeReg(CSR.tdata1, 0);   // 残留的断点
            cnt++;
          } catch { break; }
        }
        await this.dm.writeReg(CSR.tselect, TSELECT_NONE).catch(() => {});
        return cnt;
      }, '数触发器');
    } catch (e){
      this._log('数触发器失败（可以先「暂停」再连）：' + (e?.message || e), 'warn');
    }
    this.caps = { numCode: n, rev: 2, raw: n };
    this._log(`硬件断点：${n} 个触发器（tselect/tdata1/tdata2，RISC-V debug spec 的 mcontrol）`, n ? 'dim' : 'warn');
    return n;
  }

  /**
   * 把断点表写进触发器（每次都整体重排：第 i 个断点 = 第 i 号触发器）。
   * ⚠️ 抽象命令要求 hart 停住 —— 目标在跑就**先停一下、写完再放它跑**（ARM 那边写 FPB 不需要停）。
   */
  async _programBps(){
    await this._withHalted(async () => {
      for (let i = 0; i < this.caps.numCode; i++){
        const addr = this.bps[i];
        await this.dm.writeReg(CSR.tselect, i);
        if (addr === undefined){ await this.dm.writeReg(CSR.tdata1, 0); continue; }
        await this.dm.writeReg(CSR.tdata2, addr >>> 0);
        const base = (await this.dm.readReg(CSR.tdata1)) >>> 0;
        /**
         * mcontrol 是**读-改-写**：保留 DM 自己的只读能力位（读回 0x21800000），
         * 只补"dmode + action=1 + m/s/u/execute"（0x0800105c）。低 12 位里的 u/execute/store/load
         * 是 mcontrol 自己的字段，所以先把它们清干净再按 MCONTROL_SET 写。
         */
        await this.dm.writeReg(CSR.tdata1, ((base & ~0xfff) | MCONTROL_SET) >>> 0);
      }
      await this.dm.writeReg(CSR.tselect, TSELECT_NONE).catch(() => {});
      // 回读对账（写不落地最难查）：逐个确认 tdata2 与目标地址一致
      for (let i = 0; i < this.bps.length; i++){
        await this.dm.writeReg(CSR.tselect, i);
        const back = (await this.dm.readReg(CSR.tdata2)) >>> 0;
        if (back !== (this.bps[i] >>> 0)) this._log(`⚠ 触发器 ${i} 回读不一致（写 0x${(this.bps[i] >>> 0).toString(16)}，读 0x${back.toString(16)}）`, 'warn');
      }
      await this.dm.writeReg(CSR.tselect, TSELECT_NONE).catch(() => {});
    }, '写硬件断点');
  }

  async bpAdd(addr, note = ''){
    addr = align2(addr);                         // RISC-V 没有 Thumb 位，但保持半字对齐（并且必须是无符号）
    if (!this.caps.numCode) throw new Error('这颗核没有可用的触发器（tselect 写不进去）—— 本页暂不支持软件断点');
    const dup = this.bps.findIndex(b => align2(b) === addr);
    if (dup >= 0) return { index: dup, warn: '这个地址上已经有断点了' };
    if (this.bps.length >= this.caps.numCode) throw new Error(`硬件断点已用完（上限 ${this.caps.numCode} 个）—— 先删掉一个`);
    this.bps.push(addr);
    if (note) this.bpNotes.set(addr, note);
    await this._programBps();
    return { index: this.bps.length - 1 };
  }

  async bpDel(addr){
    addr = align2(addr);
    const n = this.bps.length;
    this.bps = this.bps.filter(b => align2(b) !== addr);
    if (this.bps.length === n) return false;
    this.bpNotes.delete(addr);
    await this._programBps();
    return true;
  }

  async bpClear(){
    const n = this.bps.length;
    this.bps = [];
    this.bpNotes.clear();
    await this._programBps();
    return n;
  }

  // ---------------------------------------------------------------- 运行控制

  /** ARM 那边命中后要清 DFSR；RISC-V 没有这个寄存器 */
  async _clearDfsr(){}

  /** ARM 的软复位走 AIRCR/DEMCR（PPB 寄存器）—— RISC-V 覆盖成 ndmreset，这里防呆 */
  async _resetCore(){ throw new Error('RISC-V 后端不走 ARM 的 AIRCR 软复位（见 resetHalt/resetRun）'); }

  /** 复用 ARM 的旧路径时的另一道防呆（RISC-V 单步用 dcsr.step，没有 C_STEP）*/
  async _stepByDhcsr(){ throw new Error('RISC-V 没有 DHCSR —— 单步走 dcsr.step'); }

  async run(){
    /**
     * 🚨 第一步读 dcsr 是**抽象命令**，要求 hart 真的停着 —— 否则 `cmderr=4`，而且那条
     *    cmderr 是 sticky 的，会把之后每一条抽象命令都带崩。真机现场（用户路径
     *    b main → 复位并停 → c）报的就是 `抽象命令失败（读寄存器 0x7b0）：cmderr=4`。
     *
     *    而 `this.halted` 只是**缓存**：自愈（复位 DM）、外部复位、别处一次 resume 都可能
     *    已经把核放跑。所以先按 **dmstatus 现场核一遍**（与 `readReg()` 同一条纪律）：
     *    核已经在跑 ⇒ 根本不该去读 dcsr（读也读不到，"清 step"此时也没意义），
     *    纠正缓存 + 补一次 resumereq（幂等）就收工，绝不把一条假的错误推给用户。
     */
    this.clearFrames();
    const live = await this._pollHalted();
    if (live === false){
      if (this.halted) this._log('继续：目标其实在跑（dmstatus 说没停）—— 只纠正状态，不下发抽象命令', 'warn');
      await this.dm.dmiWrite(0x10, this.dm._ctl(this.port?.debug.hart ?? 0, DMCONTROL.resumereq));
      this.halted = false;
      return;
    }
    const d = (await this.dm.readReg(REGNO.DCSR)) >>> 0;
    if (d & DCSR_STEP) await this.dm.writeReg(REGNO.DCSR, (d & ~DCSR_STEP) >>> 0);   // 别带着 step 跑
    await this.dm.dmiWrite(0x10, this.dm._ctl(this.port?.debug.hart ?? 0, DMCONTROL.resumereq));
    this.halted = false;
  }

  async halt(){
    this.clearFrames();
    await this._haltWithHeal('暂停', this.port?.debug.hart ?? 0, 3000);
    this.halted = await this._pollHalted();
    if (!this.halted) throw new Error('暂停未确认，目标仍在运行');
    try { this.pc = (await this.dm.readReg(REGNO.PC)) >>> 0; } catch {}
    return true;
  }

  /**
   * 单步一条指令：`dcsr.step` + `ebreak*` → resume → 等停下 → **手工清 step**（这颗核不会自动清）。
   * 与 ARM 那边不同：RISC-V 的 `step` 是硬件真单步，不需要"断点单步"兜底。
   *
   * 🚨 必须包在 `_withBpCleared(pc)` 里：**命中断点后 PC 就停在断点那条指令上**，
   *    触发器是"取指命中就停"——不临时摘掉它，单步会立刻再命中一次、PC 原地不动
   *    （现象就是"点了单步没反应"）。ARM 那边同理（见 docs/dbg-page.md §3.2）。
   */
  async step(){
    if (!this.halted) throw new Error('目标在运行 —— 先「暂停」再单步');
    await this._ensureHalted('单步');   // 缓存说停着也得现场核一遍：抽象命令要求 hart 真的停着
    const pc = (await this.dm.readReg(REGNO.PC)) >>> 0;
    await this._withBpCleared(pc, async () => {
      const d = (await this.dm.readReg(REGNO.DCSR)) >>> 0;
      await this.dm.writeReg(REGNO.DCSR, (d | DCSR_STEP | EBREAK_ALL) >>> 0);
      await this.dm.dmiWrite(0x10, this.dm._ctl(this.port?.debug.hart ?? 0, DMCONTROL.resumereq));
      this.halted = false;
      /**
       * 🚨 **先确认真的跑起来了，再等它停**（2026-10 真机定因）。
       *    直接 `waitHalted()` 会在"DM 还没处理完 resumereq、仍报 halted"的窗口里
       *    立刻返回 —— 于是我们**在核还没动的时候就把 `dcsr.step` 清掉、把触发器装回去**，
       *    等 DM 真放开核时，它带着"断点已装回、step 已被清"重新执行同一条指令：
       *    原地再命中 → 现象就是"单步按了没反应、PC 一动不动"。
       */
      await this._waitResumed(pc, 400);
      try { await this.dm.waitHalted(3000); }
      catch (e){ await this._haltQuiet(this.port?.debug.hart ?? 0, 1500).catch(() => {}); throw new Error('单步没停下来：' + (e?.message || e)); }
      await this.dm.writeReg(REGNO.DCSR, (d & ~DCSR_STEP) >>> 0).catch(() => {});
      this.halted = true;
    });
    await this.refresh();
    await this.refreshRegs();
    this.lastStepMode = 'step';
    return this.lastStepMode;
  }

  /**
   * 复位之后**把硬件断点重新下发**。
   *
   * 🚨 2026-10 真机定因（`reset halt` → 继续 → 停在 `_start` 之外、断点再也不命中）：
   *    **触发器（tselect/tdata1/tdata2）是 hart 自己的 CSR，hart 一复位就被清掉** ——
   *    而我们页面上的 `this.bps` 还留着那几个地址，界面上断点"看起来还在"，
   *    实际硬件里一个都没有了。所以任何复位之后都必须重新写一遍（核停在复位态，抽象命令可用）。
   */
  async _rearmBpsAfterReset(what = '复位'){
    if (!this.bps.length) return;
    try {
      const n = this.bps.length;
      await this._programBps();
      this._log(`${what}后重新下发 ${n} 个硬件断点（hart 复位会把触发器清掉）`, 'dim');
    } catch (e){
      this._log(`${what}后重新下发断点失败，目标不继续运行：` + (e?.message || e), 'err');
      throw e;
    }
  }

  /** 复位并停：ndmreset 脉冲 + 保持 haltreq（照烧录算法的要求，见 riscv-dm.js 的 resetHalt）*/
  async resetHalt(){
    this.clearFrames();
    this._badAddrs?.clear();
    await (this.port || resolveHpmTarget()).reset.halt(this.dm, this.port?.debug.hart ?? 0);
    this.halted = await this._pollHalted();
    if (!this.halted) throw new Error('复位后停机未确认，未重装断点');
    await this._rearmBpsAfterReset();
    await this.refresh();
    await this.refreshRegs();
    return '系统复位（ndmreset）+ 停住（RISC-V 上会停在复位后的第一条指令处，通常在 boot ROM）';
  }

  /**
   * 复位并运行：复位 → 停在复位向量 → **这时才把触发器写回去** → 放开 haltreq 让它跑。
   *
   * 🚨 2026-10 真机定因（HPM6800EVK + tcpecho，用户现场"复位并跑报抽象命令出错"）：
   *    老写法是"拉 ndmreset+haltreq → 等 50 ms → 直接写触发器 → 放开 ndmreset"，**写触发器时
   *    ndmreset 还按着** —— 核在复位态、`dmstatus` 既不报 halted，抽象命令于是全部 `cmderr=4`：
   *      `复位后重新下发断点失败：抽象命令出错（cmderr=4，abstractcs=0x80004004）`
   *    而 `_rearmBpsAfterReset` 只在"本来就有断点"时才跑，所以这个坑是"先 b main、再复位并跑"必踩。
   *    正确顺序（`riscv-dm.js` 的 `_haltByReset` 早就是这么做的，还带 ndmreset 放开复验）：
   *      ① ndmreset+haltreq 按住 → ② **放开 ndmreset、保持 haltreq** → ③ 等真的 halted
   *      → ④ 写触发器（此时抽象命令合法）→ ⑤ 放 haltreq 开跑。
   */
  async resetRun(){
    this.clearFrames();
    this._badAddrs?.clear();
    const DMC = 0x10;
    // ①②③：复位 + 停在复位向量（ndmreset 放开与否由 dm 侧复验，见那里的"血案"注释）
    await (this.port || resolveHpmTarget()).reset.haltForRun(this.dm, this.port?.debug.hart ?? 0);
    this.halted = await this._pollHalted();
    if (!this.halted) throw new Error('复位后停机未确认，未继续运行');
    // ④：现在核确实停着、且 ndmreset 已放开 —— 抽象命令写触发器才写得进去
    await this._rearmBpsAfterReset();
    /**
     * ⑤ 让它跑：**必须写 `resumereq`** —— RISC-V 里"清 haltreq"**不会**让核跑起来。
     *    2026-10 真机实测（HPM6800EVK）：只清 haltreq 的话核一直停在复位向量，
     *    `dpc=0x80003000`（`_start`）、`dcsr.cause=3`（haltreq）—— 现象就是"复位并跑了但没动"。
     *    老实现之所以看着能跑，是因为它清的是 **ndmreset**（放开复位本身就会开始执行）；
     *    现在流程改成"复位 → 停住 → 写触发器 → resume"，就必须显式 resume。
     */
    await this.run();
    await waitMs(10);
    await this.refresh();
    return '系统复位（ndmreset）+ 运行';
  }

  /** 时钟/PPB 自检那套是 ARM 的（DHCSR 读回 0 才降频），RISC-V 不适用 */
  async verifyClock(){ return { ok: true, hz: this.clockHz, checked: false }; }
}
