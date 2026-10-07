/**
 * 调试会话：把 CMSIS-DAP 探针包装成"一个简单调试器该有的动作"（**不碰 DOM**）。
 *
 * 底座全部是已有的东西（`app/rtt/dap-webusb.js` 的 WebUsbDapProbe）：
 *   halt/run/isHalted/_dhcsr、regRead/regWrite（DCRSR/DCRDR）、readMem/writeMem。
 * 这一层新增的只有三样：
 *   ① **硬件断点**（FPB，见 app/dbg/bp.js）—— 网页侧原来没有；
 *   ② **单步**与"跨过断点继续"（C_STEP + C_MASKINTS，命中后必须先摘比较器再单步）；
 *   ③ **抢占纪律**：连之前先请别的页签让出探针、停掉探针侧 RTT 桥（它每毫秒轮询目标内存，
 *      和寄存器访问抢同一条 SWD，实测会把每一步拖慢十倍）。
 *
 * 🚨 三条本项目踩过的硬约束（照做，别改）：
 *   1) **PPB（0xE0000000 那一片）要 ≤1 MHz**：DHCSR/DCRSR/FPB 都在这片，
 *      高时钟下读回 0（本仓烧录/身份识别早就是 1 MHz）。所以时钟默认 1000 kHz，别"顺手调高"。
 *   2) **写 DP CTRL/STAT 只写上电位，绝不"先掉电再上电"**（见 dap-webusb.js 的整段说明）。
 *   3) **WebUSB 没有取消接口**：任何一步超时都会留下挂起传输 —— 超时即把设备标脏，
 *      由 dap-webusb 在 disconnect 时做端口复位。所以这里所有等待都带超时。
 */

import { WebUsbDapProbe, withTimeout } from '../rtt/dap-webusb.js';
import { closeProbeUsbDevices } from '../core/probe-bus.js';
import { waitMs, sleep } from '../core/pace.js';
import { CFBP_SEL, CORE_REGS, SPECIAL_REGS, cfbpGet, cfbpSet, isCfbpSub, regInfo } from './regs.js';
import { FPB, FP_CTRL_KEY, canBreak, compAddr, decodeFpCtrl, planComparators } from './bp.js';
import { align2, hex32, u32leBytes } from './fmt.js';
import { backtrace } from './backtrace.js';
import { DwtWatchpoints } from './dwt.js';
import { thumbLen, decodeCall, nextAddrsOf, ARM_ARCH } from './thumb.js';

// Cortex-M 的调试寄存器（PPB）
const DHCSR = 0xe000edf0, DFSR = 0xe000ed30, AIRCR = 0xe000ed0c, DEMCR = 0xe000edfc;
const DBGKEY = 0xa05f0000;
const C_DEBUGEN = 1, C_HALT = 2, C_STEP = 4, C_MASKINTS = 8;
/** DEMCR.VC_CORERESET：内核一退出复位就停下（"复位并停"停在哪全靠它） */
const VC_CORERESET = 1;

/**
 * 总线 FAULT 的人话。`SWD 块传输 FAULT（读 4 字 @0xc）` 对用户等于天书，
 * 而真实原因通常就三类：地址没映射（芯片上不存在这个窗口）、外设时钟没开、指向了只写寄存器。
 * 链路本身由探针层自愈（dap-webusb 的 `_healIfFaulted`），这里只负责把话说清楚。
 */
function busFaultText(verb, addr, len){
  return `${verb} 0x${(addr >>> 0).toString(16)}（${len} 字节）失败：目标回了总线 FAULT —— `
       + '这个地址在当前状态读/写不了（没映射的窗口 / 外设时钟没开 / 只写寄存器 / 跨出了 RAM 末尾）。'
       + '调试链路会自己重新初始化，不用重连，换一个地址继续即可。';
}

/* Thumb 的指令长度/调用解码在 app/dbg/thumb.js（那边能单独自测），这里直接用。 */

/** 调试页默认 SWD 时钟（kHz）。
 *  🚨 2026-10-02 由用户拍板改成 **10 MHz**（原来是 1 MHz）：真机实测（akaLinkPro + STM32F103ZE）
 *  10/20/30 MHz 下 DHCSR/FPB/寄存器/RAM 全都正确，内存读 32 KB 从 1 MHz 的 ~100 KB/s 提到 **375 KB/s**
 *  （20 MHz 最高 488 KB/s）。历史"时钟偏高 DHCSR 读回 0"的坑由 `verifyClock()` 兜底：
 *  连上之后先验一次 PPB，读回不可信就**自动退回 1 MHz** 并写日志。 */
export const DEFAULT_CLOCK_KHZ = 10000;
/** PPB（DHCSR/DCRSR/FPB/AIRCR）的保守时钟上限：高时钟读数不可信时回退到这里 */
export const PPB_SAFE_HZ = 1_000_000;

export class DebugSession {
  constructor(){
    this.probe = null;
    this.sym = null;                       // SymTab（载入 ELF 后才有）
    this.bps = [];                         // 断点地址（顺序 = 比较器槽位）
    this.bpNotes = new Map();              // 地址 → 出处备注（如 `main.c:192`；纯显示用，不参与编码）
    this.caps = { numCode: 0, rev: 1, raw: 0 };
    this.halted = false;
    this.pc = 0;
    this.clockHz = DEFAULT_CLOCK_KHZ * 1000;
    this.backendName = 'WebUSB';
    this.name = '';
    this.idcode = 0;
    this.regs = [];                        // refreshRegs() 的缓存
    this.busy = false;                     // 正在做一次"用户动作"（按钮据此禁用）
    this.log = null;                       // (text, cls) => void
    /**
     * 架构描述子：寄存器名 / 指令长度 / 调用解码 / 落点计算 / 返回地址校验。
     * 默认是 ARM/Cortex-M（app/dbg/thumb.js 的 ARM_ARCH）；RISC-V 那份在 rv.js（RV_ARCH），
     * 由 `RiscvDebugSession`（app/dbg/riscv.js）覆盖低层硬件访问 + 换掉这个对象。
     */
    this.arch = ARM_ARCH;
    /**
     * C_STEP（DHCSR 单步）到底能不能用：null=还没试过，true/false=试过的结论。
     * 这颗探针/内核（akaLinkPro + F103ZE/H743）实测**不执行 C_STEP**，一次试探要 ~400 ms，
     * 所以失败一次就记住，后面全走断点单步（见 `step()`）。
     */
    this._cStepWorks = null;
    this._prev = null;                     // 上一次读到的寄存器值（算 changed 高亮）
    this._cfbp = 0;
    this._opChain = Promise.resolve();     // 串行化用的队列（见 exclusive/tryExclusive）
    this._opDepth = 0;
    this.dwt = new DwtWatchpoints(this);
  }

  get _opBusy(){ return this._opDepth > 0; }

  get connected(){ return !!this.probe; }
  get bpCapacity(){ return this.caps.numCode || 0; }

  _log(t, c){ try { this.log?.(t, c); } catch { /* 日志不影响主流程 */ } }

  // ------------------------------------------------------------ SWD 串行化

  /**
   * 🚨 一条 SWD 链路上**任何两次操作交错都会读出垃圾**。
   *
   * 2026-10-02 真机实测（10 MHz + STM32F103ZE）：页面那个 150 ms 的观察循环（`refresh()` 读 DHCSR/PC）
   * 与脚本/用户的一次 `readReg()` 撞在一起时，**100 次里有 18 次读到 0x0 / 0x1 / 0x999 这种废值**
   * （连续读 DCRDR 前被别人的 DCRSR 插了一脚）。停掉观察循环后 100 次 0 错。
   * 这不是时钟问题（1 MHz 下同样会撞），是**并发**问题。
   *
   * 规则（改代码时守住）：
   *   · 后台轮询（观察循环、RTT 泵）用 `tryExclusive()` —— **忙就跳过这一拍**，绝不排队堆积；
   *   · 用户动作 / 自动化脚本用 `exclusive()` —— 排队执行，保证整段操作不与任何东西交错。
   * 两者都不会互相嵌套（嵌套会死锁），所以这里是简单的"整段独占"，不做可重入。
   */
  async exclusive(fn){
    const prev = this._opChain;
    let release;
    this._opChain = new Promise(res => { release = res; });
    this._opDepth++;
    try {
      await prev.catch(() => {});
      return await fn();
    } finally {
      this._opDepth--;
      release();
    }
  }

  /** 后台轮询专用：正忙就返回 `{ skipped: true }`（不排队、不等待） */
  async tryExclusive(fn){
    if (this._opBusy) return { skipped: true };
    const r = await this.exclusive(fn);
    return { skipped: false, value: r };
  }

  // ------------------------------------------------------------ 连接

  /**
   * 连接目标。
   * @param {{mock?:boolean, clockKhz?:number, all?:boolean, bus?:object, stopBridge?:boolean, forcePick?:boolean}} opts
   *   mock=true 用内置的假目标（自测/演示，不需要硬件）
   *   bus = core/probe-bus.js 的 ProbeBus（会先请别的页签让出探针）
   */
  async connect(opts = {}){
    const { mock = false, clockKhz = DEFAULT_CLOCK_KHZ, all = false, bus = null, stopBridge = true, forcePick = false } = opts;
    if (this.probe) throw new Error('已经连接了（先断开）');
    this.backendName = mock ? '模拟目标' : 'WebUSB';
    if (mock){
      const { MockTarget } = await import('./mock.js');
      this.probe = new MockTarget();
      await this.probe.connect();
      this.name = this.probe.name;
      this.idcode = this.probe.idcode >>> 0;
    } else {
      /**
       * ① 先请别的页签让出探针。WebUSB 一个接口同时只能被一个连接认领，
       *    别的页签还占着时这里只会拿到 `Unable to claim interface`（reset 也救不回来）。
       */
      if (bus?.supported){
        const r = await bus.requestRelease({ why: '调试页要占用探针' });
        if (r.asked) this._log(`跨页签协调：请 ${r.asked} 个其他页签让出探针，${r.acked} 个确认（等了 ${r.ms} ms）`, 'dim');
      }
      /**
       * ② 停掉本页「RTT 转发」的探针桥：它在**探针侧**轮询目标内存（约 1 kHz），
       *    与这里的寄存器/内存访问抢同一条 SWD —— 不停的话单步一次要等好几秒。
       */
      if (stopBridge){
        const fw = globalThis.__tools?.hid;
        if (fw?.last?.running){
          try { await fw.stop(); this._log('已停掉「RTT 转发」的探针桥（它一直在轮询目标内存，会跟调试抢探针）', 'warn'); }
          catch (e){ this._log('停 RTT 转发失败（继续）：' + (e?.message || e), 'warn'); }
        }
      }
      /** ③ 清掉本页签可能残留的僵尸连接（接口认领挂在连接上，丢引用不 close 会挡住重新认领） */
      try { const n = await closeProbeUsbDevices(); if (n) this._log(`关掉 ${n} 个残留的探针句柄`, 'dim'); } catch {}

      const openOnce = () => withTimeout(WebUsbDapProbe.open(this._auth[0], { clockKhz }), 20000, '连接探针');
      // 已经授权过的探针不用再弹选择框（也能让自动化跑起来）
      let auth = [];
      if (!forcePick){
        try { auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针'); }
        catch (e){ throw new Error(`${e.message} —— 浏览器 USB 服务可能被上一次中断的会话卡住了：刷新页面（或拔插一次探针）再试`); }
      }
      if (!auth.length){
        this.probe = await withTimeout(WebUsbDapProbe.request(all, { clockKhz }), 60000, '等你在浏览器里选探针');
      } else {
        this._auth = auth;
        try { this.probe = await openOnce(); }
        catch (e1){
          // 刚被别的会话用过的探针第一次常常连不上（接口还没释放干净）：等 1.2 s 再试一次
          this._log(`第一次连接失败（${e1.message}）—— 等 1.2 s 重试一次…`, 'warn');
          await sleep(1200);
          try { await closeProbeUsbDevices(); } catch {}
          this.probe = await openOnce();
        }
      }
      this.probe.onLog = s => this._log('   [usb] ' + s, 'dim');
      this.probe.fast = false;             // 严格档：调试动作全都要回读确认
      this.name = this.probe.name || 'CMSIS-DAP';
      this.idcode = this.probe.idcode >>> 0;
      this.clockHz = this.probe.clockHz || clockKhz * 1000;
    }
    this._log(`已连接：${this.name}　SWD ${(this.clockHz / 1000).toFixed(0)} kHz　IDCODE=0x${this.idcode.toString(16).toUpperCase()}`, 'ok');
    this._cStepWorks = null;               // 新的一次连接：C_STEP 支不支持重新探（粘性结论只在本会话内有效）
    await this.refresh();
    if (!mock) await this.verifyClock();
    await this.bpInit();
    return this;
  }

  /**
   * 连接后核对一次"选中的 SWD 时钟在这颗探针上能不能读 PPB"。
   *
   * 历史坑（docs/dbg-page.md §3.1）：DHCSR/DCRSR/FPB/AIRCR 都在 PPB（0xE0000000 那一片），
   * 这颗探针固件在时钟偏高时**读回 0** → 寄存器表全是 0、断点静默失效，看着像"页面坏了"。
   * 2026-10 真机实测（akaLinkPro + STM32F103ZE）：10/20/30 MHz 的 DHCSR/FPB/RAM 全都正常，
   * 但换一块探针固件未必 —— 所以这里**主动验一次**，不合格就自动退回 1 MHz，
   * 并把证据写进日志（不许静默降级，用户得知道为什么寄存器不灵了）。
   */
  async verifyClock(){
    if (!this.probe || this.clockHz <= PPB_SAFE_HZ) return { ok: true, hz: this.clockHz, checked: false };
    const seen = [];
    for (let i = 0; i < 3; i++){
      try { seen.push((await this.probe._readWord(DHCSR)) >>> 0); }
      catch { seen.push(0xdeadbeef); }
    }
    const bad = seen.some(v => v === 0 || v === 0xffffffff || v === 0xdeadbeef) || new Set(seen).size > 1;
    if (!bad) return { ok: true, hz: this.clockHz, checked: true, seen };
    const was = this.clockHz;
    await this.probe.setClock(PPB_SAFE_HZ);
    this.probe.clockHz = PPB_SAFE_HZ;
    this.clockHz = PPB_SAFE_HZ;
    this._log(`⚠ SWD ${Math.round(was / 1000)} kHz 下 PPB 读回不可信（DHCSR=${seen.map(v => '0x' + v.toString(16)).join(' / ')}）`
      + ` —— 已自动退回 1 MHz（寄存器/断点只能在 ≤1 MHz 下用）`, 'warn');
    return { ok: false, hz: PPB_SAFE_HZ, was, seen };
  }

  async disconnect(){
    this.clearFrames();
    const p = this.probe;
    if (p && this.dwt.items.length) {
      await this.dwt.clear();
    }
    // Retain the backend and ownership until hardware cleanup and USB close succeed.
    if (p?.disconnect) await p.disconnect();
    this.dwt = new DwtWatchpoints(this);
    this.probe = null;
    this.halted = false; this.regs = []; this._prev = null;
    this.bps = [];
    this._cStepWorks = null;              // 换了目标/重连之后重新探一次 C_STEP
    if (p) this._log('已断开探针', 'dim');
  }

  // ------------------------------------------------------------ 状态

  /** 读 DHCSR 刷新"停住/在跑"，停住时顺手把 PC 也读回来 */
  async refresh(){
    if (!this.probe) return { halted: false, pc: 0 };
    const v = await this.probe._readWord(DHCSR);
    this.halted = ((v >>> 17) & 1) === 1;
    if (this.halted) this.pc = await this.readReg('PC');
    if(this._frames&&(!this.halted||this.pc!==this._framePc))this.clearFrames();
    return this.statusInfo();
  }

  statusInfo(){
    return { halted: this.halted, pc: this.pc >>> 0, connected: this.connected, linked: this.probe?.lastOkAt ? true : undefined };
  }

  /** 不管现在是什么状态，先把目标停住（绝大多数操作都在停住状态下做） */
  async ensureHalted(){
    if (!await this.probe.isHalted()) await this.probe.halt();
    await this.refresh();
  }

  // ------------------------------------------------------------ 运行控制

  async halt(){
    await this.probe.halt();
    await this.refresh();
    await this.refreshRegs();
  }

  async run(){
    this.clearFrames();
    await this._clearDfsr();
    await this.probe.run();
    this.halted = false;
  }

  /**
   * 继续运行 —— 带"跨过断点"处理。
   *
   * 🚨 命中断点后 PC **停在断点那条指令的地址上**，而 FPB 是"取指地址命中就停"：
   *    直接写 C_HALT=0 让它跑，它会立刻再命中一次（用户看到的是"点了继续没反应"）。
   *    正确做法是 gdb/pyOCD 那一套：**先单步跨过它再继续**（step() 自己会临时摘比较器）。
   */
  async cont(){
    this.clearFrames();
    if (!this.halted) { await this.run(); return false; }
    /**
     * 🚨 状态可能与硬件不一致（典型：SBA 自愈做过 ndmreset、或别的会话把核放跑过）——
     *    界面上写着"已停止"，硬件其实在跑。这时读 PC（抽象命令要求先停住）会得到 `cmderr=4`，
     *    用户看到的就是「敲 c 报抽象命令出错」（2026-10 用户现场：b main → reset → c）。
     *    先按真实状态刷新一次：真在跑，那"继续"这件事本来就已经达成了，直接返回。
     */
    let pc = 0;
    try {
      pc = align2(await this.readReg('PC'));
    } catch (e){
      await this.refresh?.().catch?.(() => {});
      if (!this.halted) return true;
      throw e;
    }
    if (this._bpAt(pc) !== undefined){
      this._log(`PC 停在断点 0x${pc.toString(16)} 上：先单步跨过它再继续`, 'dim');
      await this.step();
      /**
       * 🚨 跨过断点之后**目标可能已经在跑**了（RISC-V 上单步的收尾会放开核，2026-10 真机：
       *    `make full_flow_6800evk` 的 test-dbg-riscv 连挂 4 个断点后就在这一步炸 —— 下面那次
       *    `readReg` 撞上"抽象命令要先停住目标"，整轮套件中断）。
       *    语义上这时"继续"**已经达成**（它就在跑），所以直接返回 true，不要再读寄存器。
       *    ARM 那条路单步后仍然halted（C_STEP 或断点单步都会停回来），走不到这个分支。
       */
      if (!this.halted){ return true; }
    }
    const pcRun = align2(await this.readReg(this.arch.PC));   // 起步地址：用来确认"真的跑起来了"
    await this.run();
    /**
     * 🚨 只等"**确实**跑起来"，不等它停 —— 这一步不能省（2026-10 RISC-V 真机定因）：
     *    `resumereq` 写下去之后，DM 有一小段时间仍然报 `halted=1`（还没处理完这请求）。
     *    谁在这段窗口里读一次状态，就会得到"已经停了（PC 还是老地址）"的**陈旧读数** ——
     *    界面表现为"点了继续，目标却原地不动/立刻显示已停止"，测试脚本表现为"继续之后没反应"。
     *    这里等它真的离开"停"态就返回（正常几毫秒），之后不管它跑多久。
     */
    await this._waitResumed(pcRun, 400);
    return true;
  }

  /**
   * 等"目标真的跑起来了"（各后端自己实现 `_pollHalted`；RISC-V 那边还多看一个 running 位）。
   * 判据：不报 halted 了，**或** PC 已经不是起步地址了（单步一条/立刻命中都会让它变）。
   * @param {number|null} pc0 起步 PC（不知道就传 null）
   * @returns {Promise<boolean>} 有没有观察到"真的跑起来"
   */
  async _waitResumed(pc0 = null, timeoutMs = 400){
    const t0 = Date.now();
    for (;;){
      let halted = true;
      try { halted = await this._pollHalted(); } catch { return false; }
      if (!halted) return true;
      if (pc0 != null){
        try { if (align2(await this.readReg(this.arch.PC)) !== align2(pc0)) return true; } catch { /* 读不到就算了 */ }
      }
      if (Date.now() - t0 > timeoutMs) return false;
      await waitMs(2);
    }
  }

  /**
   * 找这个地址上的断点。
   *
   * 🚨 2026-10 真机（HPM6800EVK，代码在 **0x80000000 以上**）定因的**重大缺陷**：
   *    早先写的是 `const a = (addr >>> 0) & 0xfffffffe` —— `&` 是 32 位**有符号**运算，
   *    RHS 直接得到**负的** int32；而比较的左边是 `((b & ~1) >>> 0)`（无符号）。
   *    于是 ≥0x80000000 的地址**永远匹配不上** → 所有依赖 `_bpAt` 的逻辑集体失效：
   *      · `_withBpCleared()` 以为"这个地址上没有断点"，**不摘比较器/触发器** →
   *        单步立刻在断点上再次命中，PC 原地不动（现象："点了单步没反应"）；
   *      · `cont()` 不先跨过断点 → 一放就跑回同一个断点（现象："4 个断点只有 1 个会命中"）；
   *      · 源码级单步/运行到光标的临时断点判重全乱。
   *    现在统一用 `align2()`（`fmt.js`，内部 `>>> 0`）算两端，任何一个字节地址都能对上。
   *    ARM 侧同样受益：代码放在 0x90000000（外部 XIP flash）的 H7 会踩同一个坑。
   */
  _bpAt(addr){
    const a = align2(addr);
    return this.bps.find(b => align2(b) === a);
  }

  /**
   * 临时摘掉某个地址上的比较器跑一段（单步/继续时都要用）。
   * 不摘的话：PC 就停在断点地址上，"单步一条"会因为取指再次命中而原地不动。
   */
  async _withBpCleared(addr, fn){
    const hit = this._bpAt(addr);
    if (hit === undefined) return await fn();
    const a = align2(addr);
    const saved = this.bps.slice();
    this.bps = saved.filter(b => align2(b) !== a);
    await this._programBps();
    try { return await fn(); }
    finally { this.bps = saved; await this._programBps(); }
  }

  /**
   * 单步一条指令。
   *
   * 主路径：DHCSR 写 C_STEP。
   * 🚨 先看到 S_HALT 变 0 再等它变回 1 —— 写 C_STEP 的那一刻 DHCSR 还是旧值，
   *    只等"=1"会立刻返回（等于没等）。C_MASKINTS 让这一步不响应中断（gdb 的 stepi 语义）。
   *
   * 兜底（2026-10-02 真机实测加）：**有的探针/内核组合根本不执行 C_STEP**。
   *    本机 akaLinkPro(CMSIS-DAP v2) + STM32F103ZE 实测：写完 C_STEP 后 DHCSR 回读**恒定**
   *    `0x30007`（C_STEP 位一直在、S_HALT 从不掉），PC 一动不动 —— 换个姿势（带/不带 C_MASKINTS）、
   *    换干净状态（AIRCR 复位后线程模式、CFSR/HFSR 全 0）都一样；而**同一个地址上
   *    "放 FPB 比较器 + 运行"能精确停在下一条指令**（实测 pc → pc+2 命中）。
   *    旧代码在这种情况下**静默当成功返回**，用户看到的是"点了单步没反应"，还以为是页面坏了。
   *    现在：C_STEP 没让 PC 前进就自动改用**断点单步**，并把这件事写进日志（不许静默降级）。
   */
  async step(){
    this.clearFrames();
    if (!this.halted) throw new Error('目标在运行 —— 先「暂停」再单步');
    const pc = align2(await this.readReg('PC'));
    this.lastStepMode = null;
    /**
     * 这一步到底成没成，如实上报（2026-10 审查报告 §低危 那条：老代码只回 `lastStepMode`，
     * 调用方**分不出**"用哪种方式单步的"和"这一步压根没执行"）。
     */
    this.lastStepOk = null;
    await this._withBpCleared(pc, async () => {
      /**
       * 🚨 `_cStepWorks` 是**粘性记忆**：这颗探针/内核不执行 C_STEP（DHCSR 写进去 C_STEP、
       *    回读 0x3000f、PC 纹丝不动 —— 真机实测 F103ZE 与 H743 都是这样），
       *    而"试一次 C_STEP"要烧掉 400 ms（60 轮 DHCSR 轮询）。不记住的话每次单步都白等半秒，
       *    「单步跳出」要走上百条指令时就变成"卡死"。失败一次之后直接走断点单步（~15 ms/步）。
       */
      if (this._cStepWorks !== false){
        if (await this._stepByDhcsr(pc)){ this._cStepWorks = true; this.lastStepMode = 'dhcsr'; this.lastStepOk = true; return; }
        const wasOk = this._cStepWorks === true;
        this._cStepWorks = false;
        this._log((wasOk ? 'C_STEP 没让目标前进（这次；可能刚复位或重连过）'
                         : '这颗探针/内核不执行 C_STEP（DHCSR 单步位写进去但核纹丝不动）')
          + ' —— 改用「断点单步」，后面每一步都走这条路，不再重复试探', 'warn');
      }
      this.lastStepMode = 'breakpoint';
      this.lastStepOk = await this._stepByBreakpoint(pc);
      if (!this.lastStepOk) this._log('这一步没执行（断点单步：落点算不出来 / 比较器不够 / 2 s 没停到落点）', 'err');
    });
    await this.refresh();
    await this.refreshRegs();
    return this.lastStepMode;
  }

  /** C_STEP 主路径。@returns {Promise<boolean>} PC 是否**真的**前进了 */
  async _stepByDhcsr(pc){
    let moved = false;
    try {
      try { await this.probe._dhcsr(DBGKEY | C_DEBUGEN | C_HALT | C_STEP | C_MASKINTS); }
      catch (e){ this._log('写 C_STEP 失败：' + (e?.message || e), 'warn'); return false; }
      let sawRun = false;
      for (let i = 0; i < 400; i++){
        let v;
        try { v = await this.probe._readWord(DHCSR); }
        catch (e){ this._log('读 DHCSR 失败：' + (e?.message || e), 'warn'); return false; }
        const h = ((v >>> 17) & 1) === 1;
        if (!h) sawRun = true;
        else if (sawRun) break;
        /* 「根本没跑起来」不用等满 400 轮：C_STEP 生效的话 S_HALT 在前几轮就该掉下去。
           这一步在坏组合上会白等 400 次 USB 往返（每次 ~0.3 ms + 1 ms 延时）。 */
        if (!sawRun && i >= 60) break;
        await waitMs(1);
      }
      /* 判据用 PC，不用 S_HALT —— S_HALT 位本身也可能读滞后/读脏（本仓有过先例） */
      try { moved = align2(await this.readReg('PC')) !== pc; }
      catch { moved = false; }
      return moved;
    } finally {
      /**
       * 🚨 **无论成败都要把单步位收干净**（2026-10-03 F103 真机定因，本文件最贵的一条）。
       *
       * 上面那笔写的是 `C_HALT|C_STEP|C_MASKINTS`，而这颗探针/内核**不执行 C_STEP**
       * （见 step() 的说明）—— 于是 `C_MASKINTS` 就留在 DHCSR 里了。麻烦在于：
       *   · 恢复运行写的是 `C_HALT=0` 的值，其中的 `MASKINTS=0` **不生效**
       *     （该位只在核**已经停住**时可写）→ 核带着"中断屏蔽"一直跑下去；
       *   · 症状极具误导性：**SysTick 不再触发**（`g_ticks` 冻住）而主循环照跑（`g_loops` 照涨），
       *     于是**任何下在中断里的断点永远不可能命中**。压测里表现成"ISR 断点等满 4 s 超时、
       *     核停在随机位置"；而套件的 `alive()` 只看 ticks/loops 任一在动就判"活着"，把真因盖住；
       *   · 更糟的是 `_cStepWorks` 是粘性记忆（只试一次 C_STEP）：**一次粘上，整个会话都坏**
       *     （实测就是这么连坏 6 轮压测的）。
       *
       * 实测（2026-10-03，F103ZE + akaLinkPro）：坏状态 `DHCSR=0x1010009`（MASKINTS=1 / C_HALT=0）
       * → 写一次 `0xA05F0003` 回到 `0x30003` → 恢复运行 Δticks 立即恢复、ISR 断点 406 ms 命中。
       */
      await this._clearStepResidue();
    }
  }

  /**
   * 清掉单步残留的 `C_MASKINTS`（DHCSR bit3）。只在真的置位时才动手。
   *
   * 🚨 清它的姿势**必须是"先确保停住、再写 C_HALT=1 且 MASKINTS=0"**：直接写"运行"的值
   *    （`0xA05F0001`）里的 MASKINTS=0 **不生效** —— 该位只在核已经停住时可写。
   *    所以这里写一次 halt（把核停下 + 顺手清位），恢复运行交给调用方（`run()`）。
   */
  async _clearStepResidue(){
    if (typeof this.probe?._dhcsr !== 'function') return false;      // RISC-V/JTAG 后端没有这一位
    try {
      const v = (await this.probe._readWord(DHCSR)) >>> 0;
      if (((v >>> 3) & 1) !== 1) return false;
      await this.probe._dhcsr(DBGKEY | C_DEBUGEN | C_HALT);
      this._log('已清掉单步残留的 C_MASKINTS —— 不清的话中断再也进不来（中断里的断点永远不会命中）', 'dim');
      return true;
    } catch { return false; }
  }

  /**
   * 断点单步（C_STEP 不可用时的兜底）：把临时比较器放在**这条指令真正会去的地方**。
   *
   * 🚨 2026-10 真机压测定因：早先只会把比较器放在"下一条指令"（pc+len）上，
   *    对**分支/返回**指令是错的 —— 核一跳走，pc+len 永远不会命中，于是白等 2 秒、
   *    再把核停在某个随机位置（表现："单步跳出"在非叶子函数里连点三次还在原地打转）。
   *    现在先用 `nextAddrsOf` 把落点算出来（`bx lr` / `pop {pc}` / `b` / `bcc` / `cbz` /
   *    `bl` 调用 / `ldr pc` …），**条件分支的两个候选都放**比较器，谁被走到都算数。
   */
  async _stepByBreakpoint(pc){
    let info;
    try {
      info = await this.arch.nextAddrsOf(pc, {
        readHalf: a => this._readHalfword(a),
        readWord: async a => { const b = await this._codeBytes(a >>> 0, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; },
        readReg: n => this.readReg(n),
      });
    } catch (e){
      this._log('断点单步：读不到 PC 处的指令（' + (e?.message || e) + '）—— 这一步没执行', 'err');
      return false;
    }
    const targets = [...new Set(info.addrs.map(a => align2(a)))].filter(a => a !== align2(pc));
    if (!targets.length){
      this._log(`断点单步：这条指令（${info.why}）算不出落点 —— 这一步没执行`, 'err');
      return false;
    }
    const placed = [];
    for (const t of targets){
      if (this._bpAt(t) !== undefined){ placed.push({ t, mine: false }); continue; }   // 那个地址上本来就有用户断点
      try { await this.bpAdd(t); placed.push({ t, mine: true }); }
      catch (e){ this._log(`断点单步：比较器不够，放弃候选落点 0x${t.toString(16)}`, 'warn'); }
    }
    if (!placed.length){
      this._log('断点单步失败（比较器放不下）—— 这一步没执行', 'err');
      return false;
    }
    try {
      await this._clearDfsr();
      await this.run();
      const t0 = Date.now();
      while (Date.now() - t0 < 2000){                     // 最多等 2 s
        try { this.halted = await this._pollHalted(); } catch { /* 读一次失败不算停 */ }
        if (this.halted){
          const hit = align2(await this.readReg('PC'));
          if (!info.certain) this._log(`断点单步：这条是「${info.why}」，落点不算确定 —— 实际停在 0x${hit.toString(16)}`, 'dim');
          return true;
        }
        await waitMs(4);
      }
      this._log(`断点单步：2 s 内没停到任何候选落点（${info.why}；候选 `
        + targets.map(t => '0x' + t.toString(16)).join(' / ') + '）—— 目标已暂停', 'warn');
      await this.probe.halt().catch(() => {});
      return false;
    } finally {
      for (const p of placed) if (p.mine) await this.bpDel(p.t).catch(() => {});
    }
  }

  /**
   * 读一条指令（半字）。
   *
   * 🚨 必须走 `_codeBytes()`，**绝不能直接 `this.probe.readMem`**（2026-10 RISC-V 真机定因）：
   *    `this.probe` 在 ARM 后端是 SWD/AHB-AP，在 RISC-V 后端是**同一颗探针的 JTAG 实例** ——
   *    对它做 WebUSB 内存读会走 AHB-AP，链路上根本没有 AP，直接 FAULT（现场报 `地址 0x4`），
   *    而 `stepInto()` 把异常吞掉之后"就当它没读到" → 退化成指令级单步，
   *    表现是 "si 停在原地不动、也进不去被调函数"。
   *    `_codeBytes()` 走的是后端自己的内存读（RISC-V 走 SBA），并且**带 ELF 兜底**。
   */
  async _readHalfword(addr){
    const b = await this._codeBytes(addr >>> 0, 2);
    return (b[0] | (b[1] << 8)) & 0xffff;
  }

  /**
   * 取**指令字节**（解码用，不是给用户看内存的）。先读目标，读不到就退回**载入的 ELF** 里那一份。
   *
   * 🚨 为什么要兜底（2026-10 HPM6800EVK 真机定因）：这颗芯片上 **SBA 读 XIP 窗口
   *    （代码就住在 0x8000_0000 以上）会失败甚至把事务挂住**（现场 `SBA 读 0x80005898 出错
   *    sbcs=0x4595c398`）。而 `si`（解调用目标）、断点单步（算落点）都必须读到**正在执行的代码**。
   *    载入的 ELF 与板上跑的固件本来就是同一份（符号/行号都靠它），所以从文件里取这几个字节
   *    既准又零风险；真读得到目标内存时当然优先用目标内存（能反映掉电重烧/自改写）。
   */
  async _codeBytes(addr, len){
    const a = addr >>> 0;
    try { return await this.memRead(a, len); }
    catch (e){
      const b = this.sym?.codeBytes?.(a, len);
      if (b && b.length >= len){
        this._log(`读不到目标代码（${e?.message || e}）—— 改用载入的 ELF 里那一份指令字节`, 'dim');
        return b;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------ 源码级单步 / 运行到光标

  /**
   * 「放一个临时比较器 → 运行 → 等它停下 → 把比较器收干净」——
   * 源码级单步与「运行到光标」的共同底座。
   *
   * 🚨 三个坑（都会伪装成"点了按钮没反应"）：
   *   ① **PC 上原本就有用户断点**：不先摘掉它，一放开就原地再命中（看着像没动）——
   *      交给 `_withBpCleared()`；临时断点加在"摘掉之后"的状态里，收尾顺序反过来。
   *   ② **临时断点正好落在用户断点上**：不能删（那是用户的）——这种情况干脆不加比较器，
   *      直接跑，让用户断点替我们拦住。
   *   ③ **FPB 比较器被用户断点占满**：必须给人话错误（"先删一个"），不能静默走成"没停"。
   *
   * @returns {Promise<number|null>} 停下来的 PC（没停下返回 null，且目标已被暂停）
   */
  async _tempBpRun(target, { clearAt = null, what = '临时断点', timeoutMs = 3000 } = {}){
    target = align2(target);
    const go = async () => {
      const mine = this._bpAt(target) === undefined;
      if (mine){
        try { await this.bpAdd(target); }
        catch (e){
          throw new Error(`${what}：需要在 0x${target.toString(16)} 放一个临时比较器，但硬件断点已用完`
            + `（${this.bps.length}/${this.caps.numCode}）—— 先删掉一个用户断点再试`);
        }
      }
      try {
        await this._clearDfsr();
        const pc0 = this.halted ? align2(await this.readReg(this.arch.PC)) : null;
        await this.run();
        await this._waitResumed(pc0, 300);          // 先确认真的跑起来了（见 cont() 的注释）
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs){
          await waitMs(4);
          try { this.halted = await this._pollHalted(); } catch { /* 读一次失败不算停 */ }
          if (this.halted) return align2(await this.readReg(this.arch.PC));
        }
        await this.probe.halt().catch(() => {});
        await this.refresh();
        this._log(`${what}：${timeoutMs} ms 内没停下来（已把目标暂停在 0x${((this.pc >>> 0)).toString(16)}）`, 'warn');
        return null;
      } finally {
        if (mine) await this.bpDel(target).catch(() => {});
      }
    };
    return clearAt != null ? await this._withBpCleared(clearAt, go) : await go();
  }

  /** 地址 → "文件:行"（没有行号信息时给空串） */
  _locText(addr){ try { return this.sym?.locText?.(addr >>> 0) || ''; } catch { return ''; } }

  /**
   * 函数入口的"第一条语句"地址：优先 `prologue_end`（gdb 同款：跳过序言），
   * 退到第一条 `is_stmt`，都没有就停在入口本身（库函数/汇编块没有行号信息）。
   */
  _entryStmt(addr){
    const a = align2(addr);
    const rows = this.sym?.lines?.rowsInRange(a, (a + 64) >>> 0, 64) || [];
    if (!rows.length) return a;
    const pe = rows.find(r => r.prologueEnd);
    if (pe) return pe.addr;
    const st = rows.find(r => r.isStmt);
    return st ? st.addr : rows[0].addr;
  }

  /** 源码级「单步跳过」(F10)：跑到**当前行的下一条语句**停下（函数调用整行跳过） */
  async stepOver(){
    this.clearFrames();
    if (!this.halted) throw new Error('目标在运行 —— 先「暂停」再单步');
    if (!this.sym?.lines) throw new Error('这份 ELF 没有行号信息（编译时没带 -g？）—— 源码级单步用不了，用 `s` 走指令级单步');
    const pc = align2(await this.readReg('PC'));
    const next = this.sym.lines.nextStmtAddr(pc);
    // 最后一条行记录（包括 is_stmt=1 的右花括号）没有 next，仍应执行收尾并返回。
    // 没有当前行或可靠函数信息的汇编/行号空洞则保留明确的错误。
    const atEnd = !next && this.sym.lines.at(pc) && this.sym.funcAt?.(pc)?.exact;
    if (atEnd || (next?.tail && !next.isStmt)){
      const out = await this.stepOut();
      return `单步跳过：这一行是 ${this.sym.funcAt?.(pc)?.name || '函数'} 的最后一条语句 —— ` + out;
    }
    if (!next){
      throw new Error(`这一行（${this._locText(pc) || hex32(pc)}）后面没有行号记录了（函数最后一行 / 汇编块）`
        + '—— 用 s 走指令级单步、c 继续，或 rc 指定目标行');
    }
    this.lastStepMode = 'over';
    const hit = await this._tempBpRun(next.addr, { clearAt: pc, what: '单步跳过' });
    if (hit == null){
      /**
       * 超时的**典型**原因不是"工具坏了"：行号表里"当前行之后的第一条语句"可能**根本不可达** ——
       * 比如 `for(;;)` 的末尾（后面紧接着的是别的函数的代码，GCC 常把它们排在同一条行号序列里，
       * 2026-10 真机在 H743 上就是这个情形：目标行算成了 `main.c:144`（wait_field 的代码））。
       * MDK/gdb 遇到这种也会一直跑下去，所以这里**如实说明 + 给出替代动作**，不假装成功。
       */
      const where = this._locText(next.addr) || hex32(next.addr);
      return `单步跳过：${Math.round(3000 / 1000)} s 内没停到目标行（${where}）—— 常见原因是这一行的“下一条语句”不可达`
        + `（例如无限循环的末尾）；目标已暂停在 ${this._locText(this.pc) || hex32(this.pc)}。`
        + '可以改用 s（指令级单步）、rc <文件:行>（跑到指定行）或 c（继续）';
    }
    this.pc = hit;
    return `单步跳过 → ${this._locText(hit) || hex32(hit)}（0x${hit.toString(16)}）`;
  }

  /**
   * 源码级「单步进入」(F11)：当前指令是调用（BL/BLX）→ 停到**被调函数的第一条语句**；
   * 不是调用（普通语句）→ 等同"单步跳过"；`BLX <reg>` 这类目标算不出来 → 走指令级单步。
   */
  async stepInto(){
    this.clearFrames();
    if (!this.halted) throw new Error('目标在运行 —— 先「暂停」再单步');
    const pc = align2(await this.readReg(this.arch.PC));
    let call = null;
    try {
      const hw1 = await this._readHalfword(pc);
      if (this.arch.insnLen(hw1) === 4){
        const hw2 = await this._readHalfword((pc + 2) >>> 0);
        call = this.arch.decodeCall(hw1, hw2, pc);
      }
    } catch (e){ this._log('读 PC 处指令失败（按指令级单步处理）：' + (e?.message || e), 'dim'); }

    if (!call || !call.target){
      this._log(`这一条不是可静态解析的调用（${this.arch.name === 'riscv' ? 'jal/c.jal' : 'BL/BLX'}）—— 按指令级单步进入`, 'dim');
      await this.step();
      this.lastStepMode = 'into(insn)';
      const at = align2(await this.readReg(this.arch.PC));
      this.pc = at;
      return `单步进入（指令级）→ ${this._locText(at) || this.sym?.nameOf?.(at) || hex32(at)}`;
    }
    const entry = this.sym?.lines ? this._entryStmt(call.target) : (call.target >>> 0);
    this.lastStepMode = 'into';
    const hit = await this._tempBpRun(entry, { clearAt: pc, what: '单步进入（函数第一条语句）' });
    if (hit == null) return `单步进入：没停到函数里（目标 ${this._locText(entry) || hex32(entry)}），已暂停`;
    this.pc = hit;
    return `单步进入 → ${this._locText(hit) || this.sym?.nameOf?.(hit) || hex32(hit)}（0x${hit.toString(16)}）`;
  }

  /**
   * LR 到底是不是**当前这一帧**的返回地址（"单步跳出"能不能走快路径的判据）。
   *
   * 🚨 为什么不能只看"LR 在不在当前函数里"（2026-10 真机压测第二版才定死）：
   *    函数末尾若是 `pop {r7, pc}`（不含 lr），LR **不会**被恢复 —— 于是"刚从一个内部调用
   *    返回"之后，LR 里留着的是那次调用的返回地址，它落在**被调函数**里（既不等于当前函数、
   *    也不等于调用者）。只看"在不在当前函数里"会把这种陈旧值当成合法返回地址，
   *    于是"跳出"跳到一个**已经返回过的旧位置**（压测现场：从 engine_deep_l3 跳到 deep_l5 里，
   *    再顺着调用链转一圈回来 —— 连点 5 次跳出还在原地打转）。
   *
   * 可信判据（可以静态验证）：**返回地址前面那条指令，必须是一个"调用当前所在函数"的调用** ——
   * 因为"F 的返回地址"就是这么来的：`bl F` 的下一条。验证不了（间接调用 `blx Rn`、
   * 读不到代码、当前 PC 不在任何已知函数里）就**老实走慢路径**，不猜。
   */
  async _validReturnAddr(pc, lr){
    if (!this.arch.retLooksValid(lr >>> 0)) return false;
    const self = this.sym?.funcAt?.(pc >>> 0);
    if (!self?.exact) return false;
    const R = align2(lr);
    const target = await this.arch.callEndingAt((a, n) => this._codeBytes(a, n), R);
    return target != null && this.sym.funcAt(target)?.addr === self.addr;
  }

  /**
   * 源码级「单步跳出」(Shift+F11)：跑到**调用点的下一条指令**。
   *
   * 🚨 **为什么不能只看 LR**（2026-10 真机压测抓到的最大的体验坑）：
   *    LR 只在**叶子函数**里才一直是返回地址。只要本函数里调用过别人（非叶子函数），
   *    那条 `bl` 就把 LR 覆盖成"这次调用之后的那条指令" —— 此时按「跳出」会原地不动
   *    （目标地址 == 当前 PC，于是只回报一句"已经在这一行"），而 MDK/Ozone/gdb 会正常跳回调用者。
   *    实测现场：H743 · 6 层嵌套 · 在 `engine_deep_l4` 里按「跳出」，
   *    `LR=0x80002bd` 正是本函数里 `bl deep_l5` 的下一条指令。
   *
   * 两种走法（都**不碰栈内存** —— H7 的栈常在 DTCM(0x20000000)，虽然实测这颗探针读得到，
   * 但别的板子/别的探针不一定，所以这条路必须能不依赖"读栈"）：
   *   ① **LR 通过静态校验**（见 `_validReturnAddr`）→ 直接在返回地址放临时比较器跑过去（最快）；
   *   ② **通不过校验**（被覆盖 / 陈旧值 / 间接调用）→ **单步走完本函数剩下的部分**，
   *      边走边看 SP：SP 高过起步值 = 本帧弹掉了 = 回到调用者了。途中"进了别的函数"
   *      （真调用 / 中断）就用 LR 临时比较器**跨过去**，不跟着钻进去 ——
   *      代价只有"本函数剩余指令数"，与调用深度、被调函数多大都无关。
   */
  async stepOut(){
    this.clearFrames();
    if (!this.halted) throw new Error('目标在运行 —— 先「暂停」再单步');
    const pc0 = align2(await this.readReg(this.arch.PC));
    const sp0 = (await this.readReg(this.arch.SP)) >>> 0;
    const lr = (await this.readReg(this.arch.LR)) >>> 0;
    const self = this.sym?.funcAt?.(pc0) || null;
    this.lastStepMode = 'out';
    if (!this.arch.retLooksValid(lr)) throw new Error(this.arch.retBadMsg(lr));

    // ① LR 可信：直接跑过去
    if (await this._validReturnAddr(pc0, lr)){
      const hit = await this._tempBpRun(align2(lr), { clearAt: pc0, what: '单步跳出（返回地址）' });
      if (hit == null) return '单步跳出：没停到返回地址，目标已暂停';
      this.pc = hit;
      return `单步跳出 → ${this._locText(hit) || this.sym?.nameOf?.(hit) || hex32(hit)}（0x${hit.toString(16)}，按 LR 返回）`;
    }

    // ② LR 不可信（被内部调用覆盖 / 陈旧值）：单步走完本函数，用 SP 判断"帧弹掉了没有"
    if (!self){
      throw new Error('这一层查不到函数信息（ELF 里没有 PC 所属的函数）—— 用 s 走指令级单步，或 c 继续');
    }
    const r = await this._stepOutByFrame(sp0, self, pc0);
    this.lastStepMode = 'out';
    await this.refresh();
    await this.refreshRegs();
    if (r.hit != null){
      this.pc = r.hit;
      return `单步跳出 → ${this._locText(r.hit) || this.sym?.nameOf?.(r.hit) || hex32(r.hit)}`
           + `（0x${r.hit.toString(16)}，LR 不是本帧的返回地址（被内部调用覆盖或已陈旧），`
           + `走了 ${r.steps} 条指令回到调用者）`;
    }
    if (r.error) throw new Error(r.error);
    return `单步跳出：在本函数（${self.name}）里走了 ${r.steps} 条指令还没回到调用者`
         + `（可能是死循环、或函数太大）—— 目标已暂停在 ${this._locText(r.pc) || hex32(r.pc)}`;
  }

  /**
   * 「跳出」的慢路径：从当前 PC 单步往前走，直到**本函数这一帧被弹掉**（SP 高过起步值且 PC 不在本函数里）。
   * 遇到别的函数（真调用 / 中断）用 LR 临时比较器跨过去。
   * @returns {Promise<{hit?:number, steps:number, pc?:number, error?:string}>}
   */
  async _stepOutByFrame(sp0, self, pc0){
    const MAX = 400;                              // 上限：够走完任何正常函数的剩余部分
    for (let i = 1; i <= MAX; i++){
      try { await this.step(); }
      catch (e){ return { steps: i, pc: this.pc >>> 0, error: `单步跳出：单步失败（${e?.message || e}）` }; }
      const pc = align2(await this.readReg(this.arch.PC));
      const sp = (await this.readReg(this.arch.SP)) >>> 0;
      const at = this.sym?.funcAt?.(pc) || null;
      const inSelf = !!at && at.addr === self.addr;
      if (inSelf) continue;
      if (sp > sp0) return { hit: pc, steps: i };          // 帧弹掉了 → 已经回到调用者
      /**
       * 还在别人的代码里、SP 却没升高 —— 这是**调用或中断**（不是返回）：
       * 用 LR 放个临时比较器跨过去，别一条条钻。异常里的 LR 是 EXC_RETURN，跨不了，只能让它自己走完。
       */
      const lr = (await this.readReg(this.arch.LR)) >>> 0;
      if (this.arch.retLooksValid(lr)){
        const hit = await this._tempBpRun(align2(lr), { clearAt: pc, what: '单步跳出（跨过调用）', timeoutMs: 2000 });
        if (hit != null){
          const sp2 = (await this.readReg(this.arch.SP)) >>> 0;
          if (sp2 > sp0) return { hit: align2(await this.readReg(this.arch.PC)), steps: i };
        }
      }
    }
    return { steps: MAX, pc: align2(await this.readReg(this.arch.PC)) };
  }

  /**
   * 「运行到光标」：跑到指定地址停下（源码视图双击某一行就是它）。
   * 目标地址上**已经有用户断点**时直接跑（让那个断点拦住），不再加临时比较器。
   */
  async runTo(addr, { label = '', timeoutMs = 8000 } = {}){
    this.clearFrames();
    if (!this.connected) throw new Error('还没连接目标（先点「连接」）');
    const target = align2(addr);
    const pc = this.halted ? align2(await this.readReg(this.arch.PC)) : null;
    if (pc != null && target === pc) return `已经停在这一行上（${label || hex32(target)}）`;
    const hit = await this._tempBpRun(target, {
      clearAt: pc, what: `运行到 ${label || hex32(target)}`, timeoutMs,
    });
    if (hit == null) return `运行到 ${label || hex32(target)}：${Math.round(timeoutMs / 1000)} s 内没到达（目标已暂停）`;
    this.pc = hit;
    return `已运行到 ${this._locText(hit) || label || hex32(hit)}（0x${hit.toString(16)}）`;
  }

  /** 清调试事件标志（命中过断点后 DFSR.BKPT 会一直挂着，清掉才能判断下一次是怎么停的） */
  async _clearDfsr(){
    try { await this.probe.writeMem(DFSR, u32leBytes(0x1f)); } catch (e){ this._log('清 DFSR 失败（忽略）：' + (e?.message || e), 'dim'); }
  }

  /**
   * 复位（软件复位：AIRCR.SYSRESETREQ）。
   *
   * 🚨 不用探针的 nRESET 引脚：本机好几块板根本没把 NRST 接到探针，"拉复位"看着成功其实没动；
   *    而 AIRCR 走内核寄存器，一定到。
   *
   * 🚨🚨 **"复位并停"要在复位向量上停住**（2026-10 压测抓到的体验问题）：
   *    只写 `C_HALT` 再 SYSRESETREQ 是不够的 —— 实测（H743 + akaLinkPro）复位后内核照样跑，
   *    等我们去"停"它的时候已经跑到 `main+0x6c` 了：用户点了「复位并停」，PC 却不在复位向量上；
   *    更糟的是如果此刻挂着断点，内核会**一路跑到断点**（"复位重跑"于是变成"复位后直接停在某个断点"）。
   *    正解是 **DEMCR.VC_CORERESET（内核复位向量捕获）**：置上它，内核一退出复位就立刻停下、
   *    一条指令都不执行（OpenOCD / MDK 的 `reset halt` 用的就是这一位）。
   *    复位完必须把这一位清掉，否则接下来"复位并运行"也会被咬住停在向量上。
   */
  async _resetCore(){
    const demcr0 = await this._readDemcr();
    if (demcr0 != null) await this._writeDemcr(demcr0 | VC_CORERESET);   // ① 开向量捕获
    await this.probe._dhcsr(DBGKEY | C_DEBUGEN | C_HALT);               // ② 再请求停住（双保险）
    await this.probe.writeMem(AIRCR, u32leBytes(0x05fa0004));           // ③ 软复位
    await waitMs(60);                                                   // 给目标 60 ms 真的复位（yieldTask 不受后台节流影响）
    try { await this.probe._targetInit(); }
    catch (e){ this._log('复位后重新初始化 SWD 失败（继续试）：' + (e?.message || e), 'warn'); }
    await this.probe.halt().catch(() => {});
    if (demcr0 != null) await this._writeDemcr(demcr0 & ~VC_CORERESET);   // ④ 关掉捕获
    return demcr0;
  }

  /** 读 DEMCR（读不到就返回 null —— 复位流程不该因为读不到它就断掉） */
  async _readDemcr(){
    try { const b = await this.probe.readMem(DEMCR, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
    catch { return null; }
  }
  async _writeDemcr(v){
    try { await this.probe.writeMem(DEMCR, u32leBytes(v >>> 0)); return true; } catch { return false; }
  }

  async resetHalt(){
    this.clearFrames();
    await this._resetCore();
    await this.probe.halt();
    await this.refresh();
    await this.refreshRegs();
    await this.dwt.rearm();
    return '软件复位（AIRCR.SYSRESETREQ）+ 停住';
  }

  async resetRun(){
    this.clearFrames();
    await this._resetCore();
    await this.dwt.rearm();
    await this.run();
    return '软件复位（AIRCR.SYSRESETREQ）+ 运行';
  }

  // ------------------------------------------------------------ 寄存器

  /** 读一个寄存器；CFBP 里的四个特殊寄存器按字节拆出来 */
  async readReg(name){
    const info = regInfo(name);
    if (!info) throw new Error(`不认识的寄存器「${name}」`);
    if (isCfbpSub(info)) return cfbpGet(await this._readCfbp(), info.name);
    return (await this.probe.regRead(info.sel)) >>> 0;
  }

  /** 写一个寄存器（CFBP 子寄存器走"读-改-写"，别把兄弟字节冲掉） */
  async writeReg(name, value){
    this.clearFrames();
    const info = regInfo(name);
    if (!info) throw new Error(`不认识的寄存器「${name}」`);
    if (isCfbpSub(info)){
      const cur = await this._readCfbp();
      const next = cfbpSet(cur, info.name, value);
      await this.probe.regWrite(CFBP_SEL, next);
      this._cfbp = next;
      return next;
    }
    await this.probe.regWrite(info.sel, value >>> 0);
    return value >>> 0;
  }

  async _readCfbp(){
    this._cfbp = (await this.probe.regRead(CFBP_SEL)) >>> 0;
    return this._cfbp;
  }

  /** 读回全部寄存器（21 次 PPB 往返，1 MHz 下几十毫秒），并标出与上次相比变了的 */
  async refreshRegs(){
    if (!this.probe) return [];
    const list = [];
    for (const r of CORE_REGS){
      const v = await this.readReg(r.name);
      list.push({ name: r.name, value: v >>> 0, note: r.note, kind: 'core' });
    }
    const cfbp = await this._readCfbp();
    for (const s of SPECIAL_REGS){
      list.push({ name: s.name, value: cfbpGet(cfbp, s.name), shift: s.shift, kind: 'cfbp', note: s.note });
    }
    const prev = this._prev;
    for (const r of list) r.changed = !!prev && prev[r.name] !== undefined && prev[r.name] !== r.value;
    this._prev = Object.fromEntries(list.map(r => [r.name, r.value]));
    this.regs = list;
    this.pc = (list.find(r => r.name === 'PC')?.value || this.pc) >>> 0;
    return list;
  }

  regList(){ return this.regs; }

  /** Caller holds session.exclusive, just like command/register/memory operations. */
  clearFrames(){ this._frames=null;this._selectedFrame=0; }
  async backtrace(opts={}){
    this.clearFrames();
    const result=await backtrace(this,opts);
    if(!result.scan){this._frames=result;this._frameElf=this.sym?.elf;this._framePc=this.pc;this._frameSp=result.frames[0]?.sp;}
    return result;
  }
  async selectFrame(index=0){
    await this.refresh();
    if(!this._frames||!this.halted||this.pc!==this._framePc||this.sym?.elf!==this._frameElf||await this.readReg(this.arch.SP)!==this._frameSp){this.clearFrames();throw new Error('栈帧已失效，请重新 bt');}
    if(!Number.isInteger(index)||index<0||index>=this._frames.frames.length)throw new Error('栈帧序号越界');
    this._selectedFrame=index;return this._frames.frames[index];
  }
  async locals(opts={}){
    const frame=await this.selectFrame(this._selectedFrame||0);
    const {frameLocals}=await import('./locals.js');
    return await frameLocals(this,frame,opts);
  }

  // ------------------------------------------------------------ 内存


  /**
   * 内存读写。**FAULT 要翻译成人话**：`SWD 块传输 FAULT（读 4 字 @0xc）` 对用户等于天书，
   * 而真实原因通常就三类：地址没映射（读到了芯片上不存在的窗口）、外设时钟没开、
   * 指向了只写的寄存器。链路本身在探针层会自动修（见 dap-webusb 的 `_healIfFaulted`）。
   */
  async memRead(addr, len){
    if (!len) return new Uint8Array(0);
    const a = addr >>> 0;
    const budget = Math.max(3000, Math.ceil(len / 32) * 200);
    try {
      return await withTimeout(this.probe.readMem(a, len >>> 0), budget, `读内存 ${len} 字节`);
    } catch (e){
      if (e?.ack === 4 || /FAULT/.test(e?.message || '')) throw new Error(busFaultText('读', a, len));
      throw e;
    }
  }

  async memWrite(addr, bytes){
    this.clearFrames();
    const a = addr >>> 0;
    const budget = Math.max(3000, Math.ceil(bytes.length / 32) * 200);
    try {
      await withTimeout(this.probe.writeMem(a, bytes), budget, `写内存 ${bytes.length} 字节`);
    } catch (e){
      if (e?.ack === 4 || /FAULT/.test(e?.message || '')) throw new Error(busFaultText('写', a, bytes.length));
      throw e;
    }
  }

  // ------------------------------------------------------------ 断点（FPB）

  /** 读 FPB 的能力（比较器个数 / 版本），并把**上一次会话残留的比较器清掉** */
  async bpInit(){
    let raw = 0;
    try { raw = (await this.probe._readWord(FPB.CTRL)) >>> 0; }
    catch (e){ this._log('读 FPB 控制寄存器失败：' + (e?.message || e), 'warn'); }
    this.caps = decodeFpCtrl(raw);
    if (this.caps.numCode > 16) this.caps.numCode = 16;      // 明显是读花了，别按它分配
    this._log(`硬件断点：${this.caps.numCode} 个比较器（FPB rev${this.caps.rev}，CTRL=0x${raw.toString(16)}）`, 'dim');
    // 残留的比较器会让目标"莫名其妙停住"：接手时一律清空（标准调试器的做法）
    let stale = 0;
    for (let i = 0; i < this.caps.numCode; i++){
      try {
        const v = (await this.probe._readWord(compAddr(i))) >>> 0;
        if (v & 1){ stale++; await this.probe.writeMem(compAddr(i), u32leBytes(0)); }
      } catch { break; }
    }
    if (stale) this._log(`清掉了上次会话残留的 ${stale} 个硬件断点`, 'warn');
    // 有的内核（或某些安全状态）根本不给访问 FPB —— 这里失败不能把整次连接带崩
    try { await this.probe.writeMem(FPB.CTRL, u32leBytes(FP_CTRL_KEY | (this.caps.numCode ? 1 : 0))); }
    catch (e){ this._log('写 FPB 控制寄存器失败（这颗内核可能没有可用的 FPB）：' + (e?.message || e), 'warn'); }
  }

  bpList(){
    return this.bps.map((addr, i) => ({
      addr: addr >>> 0, slot: i,
      sym: this.sym?.funcAt?.(align2(addr))?.name || this.sym?.find?.(String(addr))?.name || '',
      note: this.bpNotes.get(align2(addr)) || '',
      /** 行号表里反查出来的出处（`main.c:192`）——断点列表显示它，用户才知道自己下在源码哪一行 */
      loc: this._locText(align2(addr)),
    }));
  }

  /** 加断点（返回 index 是 0 基，命令层显示时 +1）。
   *  @param {number} addr
   *  @param {string} [note] 出处备注（`b main.c:192` 会带上来），只用于显示 */
  async bpAdd(addr, note = ''){
    addr = align2(addr);                  // Thumb：断点只能落在半字边界（≥0x80000000 的地址也要归一化成无符号）
    if (!this.caps.numCode) throw new Error('这颗内核没有可用的 FPB 比较器（读回 FP_CTRL 说 0 个）—— 本页暂不支持软件断点');
    if (!canBreak(addr, this.caps.rev)) throw new Error(`FPB rev${this.caps.rev} 只能匹配 0x20000000 以下的地址（0x${addr.toString(16)} 超出范围）`);
    const dup = this.bps.findIndex(b => align2(b) === addr);
    if (dup >= 0) return { index: dup, warn: '这个地址上已经有断点了' };
    if (this.bps.length >= this.caps.numCode) throw new Error(`硬件断点已用完（上限 ${this.caps.numCode} 个）—— 先删掉一个`);
    this.bps.push(addr);
    if (note) this.bpNotes.set(addr, note);
    await this._programFpb();
    return { index: this.bps.length - 1 };
  }

  async bpDel(addr){
    addr = align2(addr);
    const n = this.bps.length;
    this.bps = this.bps.filter(b => align2(b) !== addr);
    if (this.bps.length === n) return false;
    this.bpNotes.delete(addr);
    await this._programFpb();
    return true;
  }

  async bpClear(){
    const n = this.bps.length;
    this.bps = [];
    this.bpNotes.clear();
    await this._programFpb();
    return n;
  }

  /**
   * 断点写进硬件 —— 名字按架构不同：ARM 是 FPB 比较器（`_programFpb`）、
   * RISC-V 是触发器（`RiscvDebugSession` 覆盖本方法）。`_withBpCleared` 这类共用逻辑
   * 一律走这个入口，别直接叫 `_programFpb`。
   */
  async _programBps(){ return await this._programFpb(); }

  /**
   * "目标停住了吗"的**一次轮询**（ARM = 读 DHCSR 的 S_HALT；RISC-V 覆盖成读 dmstatus）。
   * 单步/临时断点的等待循环都走这里，别再直接读 DHCSR。
   */
  async _pollHalted(){
    const v = await this.probe._readWord(DHCSR);
    return ((v >>> 17) & 1) === 1;
  }

  /** 把断点表写进比较器（每次都整体重排：第 i 个断点 = 第 i 号比较器，顺序稳定好排查） */
  async _programFpb(){
    const { slots, overflow, bad } = planComparators(this.bps, this.caps.numCode, this.caps.rev);
    if (overflow.length) this._log(`⚠ ${overflow.length} 个断点装不下（比较器只有 ${this.caps.numCode} 个）`, 'err');
    if (bad.length) this._log(`⚠ ${bad.length} 个断点地址超出 FPB rev${this.caps.rev} 的匹配范围`, 'err');
    for (let i = 0; i < slots.length; i++){
      await this.probe.writeMem(compAddr(i), u32leBytes(slots[i] || 0));
    }
    const enable = this.bps.length && this.caps.numCode ? 1 : 0;
    await this.probe.writeMem(FPB.CTRL, u32leBytes(FP_CTRL_KEY | enable));
    // 回读对账：这颗探针的 PPB 写偶发不落地，断点静默失效最难查
    for (let i = 0; i < slots.length; i++){
      const want = slots[i] || 0;
      const got = (await this.probe._readWord(compAddr(i))) >>> 0;
      if (got !== want) this._log(`⚠ 比较器 ${i} 回读 0x${got.toString(16)} ≠ 写入 0x${want.toString(16)}（断点可能不生效）`, 'warn');
    }
  }
}
