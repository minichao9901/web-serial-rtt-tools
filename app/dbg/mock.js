/**
 * 假目标（Mock Target）：一个**行为正确的最小 Cortex-M 模型**，接口与 WebUsbDapProbe 一模一样。
 *
 * 为什么值得写：调试页最容易错的不是 USB，而是**语义**——"命中断点后继续会立刻再命中"、
 * "单步要先看到 S_HALT 拉低才算跑过"、CFBP 的读-改-写、FPB 比较器的编码……
 * 这些都能在没有硬件的情况下用这个假目标跑出来（`make test-dbg` 与页面自测都在用它）。
 *
 * 建模原则：
 *   · FPB 用**真的编码/解码**（复用 app/dbg/bp.js）—— 编码写错时"断点永远不命中"，测试会红；
 *   · 指令模型极简：每条 2 字节、PC 前进 2；跑到代码区末尾就绕回（形成一个死循环），
 *     这样"没有断点时一直在跑"这个断言是稳的；
 *   · **只在读 DHCSR / isHalted 时按经过的时间推进指令**（不跑真定时器）——
 *     测试里没有后台线程，行为完全可预期；
 *   · 运行中会顺手改一个"心跳"变量（0x20000000 的计数），页面上能直观看到"目标在跑"；
 *   · flash 写入直接报错（真板子也要先解锁，本页本来就不做烧录）。
 */

import { FPB, FP_CTRL_KEY, decodeComparator } from './bp.js';
import { CFBP_SEL } from './regs.js';
import { u32leBytes, align4 } from './fmt.js';
import { thumbLen, decodeCall } from './thumb.js';

const FLASH = 0x08000000, FLASH_SIZE = 0x20000;      // 128 KB
const RAM = 0x20000000, RAM_SIZE = 0x10000;          // 64 KB
const DHCSR = 0xe000edf0, DCRSR = 0xe000edf4, DCRDR = 0xe000edf8;
const DFSR = 0xe000ed30, AIRCR = 0xe000ed0c;

/** 假指令的代码区（跑出末尾就绕回开头，等于死循环） */
const CODE = 0x08000100, CODE_END = 0x08001000;

/** 假目标里的 RTT 控制块（调试页的「RTT 输出」可以直接指向它，验证同屏链路） */
export const RTT_CB = 0x20000100, RTT_UP = 0x20000200, RTT_UP_SIZE = 256, RTT_NAME = 0x20000300;

/** 模型里的寄存器下标（DCRSR 的 REGSEL → 下标） */
const RI = { SP: 13, LR: 14, PC: 15, XPSR: 16, MSP: 17, PSP: 18, CFBP: 19, DCRDR: 20, SEL: 21 };
const SLOTS = 24;
const CORE_INDEX = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 12, 13: 13, 14: 14, 15: 15, 16: 16, 17: 17, 18: 18 };

export class MockTarget {
  constructor(){
    this.name = '模拟目标（内置 Cortex-M7 模型）';
    this.idcode = 0x6ba02477;                  // 与真机那颗 STM32H7B0 的 SW-DP 一致，便于对照
    this.clockHz = 1_000_000;
    /**
     * 假目标的"高时钟下 PPB 读回垃圾"开关：真机上那颗探针固件历史上有这个毛病，
     * `DebugSession.verifyClock()` 就是为它写的兜底 —— 自测靠这个开关把回退路径也跑一遍。
     * 打开后：任何 PPB 地址（0xE0000000 起）读回全 0。
     */
    this.ppbGarbage = false;
    this.fast = false;
    this.lastOkAt = 0;
    this.onLog = null;
    this.flash = new Uint8Array(FLASH_SIZE);
    this.ram = new Uint8Array(RAM_SIZE);
    this.ppb = new Map();
    this.regs = new Uint32Array(SLOTS);
    this.dhcsr = 0;
    this.dfsr = 0;
    this.execCount = 0;
    this.running = false;
    this._lastTick = 0;
    this._stepsPerMs = 6;                      // "主频"（每毫秒执行几条假指令）——只影响多久撞上断点
    this._dhcsrPhase = 0; this._dhcsrVal = 0;  // 一次字读的 4 个字节要返回同一个值（见 _dhcsrWord）
    this._stepPending = false; this._stepRunning = false;
    /**
     * 模拟"这颗探针/内核不执行 C_STEP"（2026-10-02 真机 akaLinkPro + STM32F103ZE 实测）：
     * 写完 C_STEP 后 DHCSR 恒定回 0x30007（C_STEP 位一直在、S_HALT 从不掉），PC 一动不动。
     * 上层 `step()` 的兜底（改用断点单步）就靠这个开关做离线回归。
     */
    this.brokenCStep = false;
    this._initMemory();
  }

  get connected(){ return true; }
  async connect(){
    this.ppb.clear();
    this.ppb.set(0xe000ed00,0x410fc231);
    this.ppb.set(0xe0001000,4<<28);
    this._resetCore(false);
    this.dhcsr = 0xa05f0003;                   // 连上时是"停住"状态（真机 DAP_ResetTarget 之后多半如此）
    return true;
  }
  async disconnect(){ this.running = false; return true; }
  _log(s){ try { this.onLog?.(s); } catch { /* 日志不该影响主流程 */ } }

  _initMemory(){
    this._put32(this.flash, 0, 0x20010000);    // 初始 SP（栈顶）
    this._put32(this.flash, 4, CODE | 1);      // 复位向量（Thumb，bit0=1）
    for (let i = 8; i < FLASH_SIZE; i += 2) this._put16(this.flash, i, 0xbf00);    // NOP 填充
    for (let i = 0; i < RAM_SIZE; i += 4) this._put32(this.ram, i, (0xa5a50000 | (i & 0xffff)) >>> 0);
    this._initRtt();
  }

  /**
   * 造一个**结构合法**的 RTT 控制块（1 个上行通道），这样调试页的「RTT 输出」有真东西可读。
   * 布局按 SEGGER RTT：16 字节 "SEGGER RTT"+填充、MaxNumUp、MaxNumDown，然后每个通道 24 字节
   * （sName / pBuffer / Size / WrOff / RdOff / Flags）。
   */
  _initRtt(){
    const id = 'SEGGER RTT\0\0\0\0\0';
    for (let i = 0; i < id.length; i++) this.ram[RTT_CB - RAM + i] = id.charCodeAt(i);
    const w = (off, v) => this._put32(this.ram, RTT_CB - RAM + off, v);
    w(16, 1); w(20, 0);                        // MaxNumUpBuffers / MaxNumDownBuffers
    w(24, RTT_NAME); w(28, RTT_UP); w(32, RTT_UP_SIZE); w(36, 0); w(40, 0); w(44, 0);
    const nm = 'dbg\0';
    for (let i = 0; i < nm.length; i++) this.ram[RTT_NAME - RAM + i] = nm.charCodeAt(i);
  }

  /** 往 RTT 上行环里塞一行（环形 + 与固件同样的"满了不覆盖"语义） */
  _pushRtt(text){
    /**
     * 🚨 必须先 encode 成字节：直接 `for (const ch of text) ram[..] = ch` 会把**字符**写进
     *    Uint8Array —— JS 会做 ToNumber：数字字符变成它的数值（'8'→8），字母/标点变成 NaN→0。
     *    结果是"环里确实有 100 字节，但内容全是 0 和零星数字"，页面上就是一堆乱码（本仓自测抓到的）。
     */
    const bytes = new TextEncoder().encode(text);
    const wrOff = RTT_CB - RAM + 36, rdOff = RTT_CB - RAM + 40;
    let wr = this._u32(this.ram, wrOff);
    const rd = this._u32(this.ram, rdOff);
    for (const b of bytes){
      const next = (wr + 1) % RTT_UP_SIZE;
      if (next === rd) break;                  // 环满：像 BLOCK_IF_FIFO_FULL 的固件那样不覆盖
      this.ram[RTT_UP - RAM + wr] = b;
      wr = next;
    }
    this._put32(this.ram, wrOff, wr);
  }

  /** 上电/复位：向量表取 SP 与复位向量（跟真板子一样） */
  _resetCore(run){
    const sp = this._u32(this.flash, 0);
    const pc = this._u32(this.flash, 4) & ~1;
    this.regs[RI.SP] = sp; this.regs[RI.MSP] = sp; this.regs[RI.PSP] = 0;
    this.regs[RI.PC] = pc;
    this.regs[RI.XPSR] = 0x01000000;           // EPSR.T = 1（Thumb）
    this.regs[RI.CFBP] = 0;
    this.dfsr = 0;
    this.running = !!run;
    this._lastTick = Date.now();
  }

  _u32(buf, o){ return (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0; }
  _u16(buf, o){ return ((buf[o] | (buf[o + 1] << 8)) & 0xffff) >>> 0; }
  _put32(buf, o, v){ buf[o] = v & 0xff; buf[o + 1] = (v >>> 8) & 0xff; buf[o + 2] = (v >>> 16) & 0xff; buf[o + 3] = (v >>> 24) & 0xff; }
  _put16(buf, o, v){ buf[o] = v & 0xff; buf[o + 1] = (v >>> 8) & 0xff; }

  // ------------------------------------------------------------ 内存

  _bufOf(addr, len){
    if (addr >= FLASH && addr + len <= FLASH + FLASH_SIZE) return this.flash;
    if (addr >= RAM && addr + len <= RAM + RAM_SIZE) return this.ram;
    return null;
  }
  _baseOf(addr){ return (addr >= FLASH && addr < FLASH + FLASH_SIZE) ? FLASH : RAM; }

  async readMem(addr, len){
    addr = addr >>> 0;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++){
      const a = (addr + i) >>> 0;
      const buf = this._bufOf(a, 1);
      out[i] = buf ? buf[a - this._baseOf(a)] : this._ppbByte(a);
    }
    this.lastOkAt = Date.now();
    return out;
  }

  /**
   * 写内存。
   * 🚨 PPB 段必须**按整字**写：DHCSR/AIRCR/FP_CTRL 都是整字寄存器，
   *    而且 FP_CTRL 要求 KEY 位与 ENABLE **同一次写入**才生效、DFSR 是"写 1 清"，
   *    逐字节读-改-写会把语义搞坏（真硬件同样是整字访问）。
   */
  async writeMem(addr, bytes){
    addr = addr >>> 0;
    if (addr >= FLASH && addr < FLASH + FLASH_SIZE){
      throw new Error('（模拟）flash 是只读的 —— 本页不做烧录，要写 flash 请用「烧录器」页');
    }
    let i = 0;
    while (i < bytes.length){
      const a = (addr + i) >>> 0;
      const buf = this._bufOf(a, 1);
      if (buf){ buf[a - this._baseOf(a)] = bytes[i++]; continue; }
      // 🚨 PPB 地址 ≥0x80000000，`a & ~3` 在 32 位有符号运算下**会变成负数** —— 必须 >>> 0
      const base = align4(a), off = a - base;
      const word = Uint8Array.from(u32leBytes(this._ppbReadWord(base)));
      const n = Math.min(4 - off, bytes.length - i);
      word.set(bytes.subarray(i, i + n), off);
      this._ppbWriteWord(base, this._u32(word, 0));
      i += n;
    }
    this.lastOkAt = Date.now();
  }

  _ppbByte(addr){
    const base = align4(addr);
    return (this._ppbReadWord(base) >>> ((addr & 3) * 8)) & 0xff;
  }

  _ppbReadWord(addr){
    addr = addr >>> 0;
    switch (addr){
      case DHCSR: return this._dhcsrWord();
      case DCRSR: return this.regs[RI.SEL] >>> 0;
      case DCRDR: return this.regs[RI.DCRDR] >>> 0;
      case DFSR: return this.dfsr >>> 0;
      case FPB.CTRL: return (this.fpCtrl | FP_CTRL_KEY) >>> 0;
      default: return (this.ppb.get(addr) || 0) >>> 0;
    }
  }

  _ppbWriteWord(addr, val){
    addr = addr >>> 0; val = val >>> 0;
    switch (addr){
      case DHCSR: this._writeDhcsr(val); return;
      case DCRSR: this._writeDcrsr(val); return;
      case DCRDR: this.regs[RI.DCRDR] = val; return;
      case DFSR: this.dfsr &= ~val; return;                      // 写 1 清标志
      case AIRCR:
        this.ppb.set(addr, val);
        if (((val >>> 2) & 1) === 1){                            // SYSRESETREQ
          const keepHalt = (this.dhcsr & 2) === 2;
          this._resetCore(false);
          this.dhcsr = 0xa05f0000 | (keepHalt ? 3 : 1);
          this._log('（模拟）收到 AIRCR.SYSRESETREQ：内核复位到复位向量');
        }
        return;
      case FPB.CTRL:
        // 只有带 KEY 位的写才被接受（跟真硬件一样）
        if (val & FP_CTRL_KEY) this.fpCtrl = ((this.fpCtrl & ~1) | (val & 1)) >>> 0;
        return;
      default:
        this.ppb.set(addr, val);
        return;
    }
  }

  // ------------------------------------------------------------ 调试寄存器

  /** FP_CTRL 复位值：8 个代码比较器、rev1（= 真机 Cortex-M7 的排法） */
  get fpCtrl(){ return (this.ppb.get(FPB.CTRL) ?? 0x80) >>> 0; }
  set fpCtrl(v){ this.ppb.set(FPB.CTRL, (v >>> 0) | 0x80); }
  get fpbRev(){ return 1 + (((this.fpCtrl & 0xf0000000) >>> 28)); }

  /**
   * 读 DHCSR（字读）。
   *
   * 🚨 两条都是**真硬件的行为**，模型不照做的话上层会误判：
   *   ① **绝不能把 DBGKEY(0xA05F) 回显在读数里**：那是"写"的时候才要带的钥匙，
   *      真硬件读回来高半字只有状态位（bit16 S_REGRDY / bit17 S_HALT …）。
   *      把 0xA05F 或进去会让 bit17 恒为 1（0xA05F 的 bit1 = 1）→
   *      "目标明明在跑、读回来永远是已停止"，继续/断点全线失灵（本仓自测踩过这一跤）。
   *   ② **一次字读的 4 个字节必须是同一个值**：上层 `_readWord()` 是逐字节读的，
   *      每个字节都重新采样的话会拼出"半跑半停"的假状态。这里用 phase 计数，
   *      每 4 次字节读算一次真正的寄存器读。
   *
   * 单步的状态机也放在这里：写完 C_STEP 之后**第一次读看到"在跑"、第二次看到"又停住"**
   * —— 上层的 `step()` 就是靠"先看到 S_HALT=0 再看到 1"来判断这一步真的执行了。
   */
  _dhcsrWord(){
    if (this._dhcsrPhase === 0){
      if (this._stepPending){                       // 单步：这一读看到"跑起来了"
        this._stepPending = false;
        this._stepRunning = true;
        this._dhcsrVal = this._mkDhcsr(true);
      } else if (this._stepRunning){                // 再读一次：这一条指令已经跑完
        this._stepRunning = false;
        this._dhcsrVal = this._mkDhcsr(this.running);
      } else {
        this._advance();
        this._dhcsrVal = this._mkDhcsr(this.running);
      }
    }
    this._dhcsrPhase = (this._dhcsrPhase + 1) & 3;
    return this._dhcsrVal >>> 0;
  }
  _mkDhcsr(running){
    return (((this.dhcsr & 0xf) | (1 << 16) | ((running ? 0 : 1) << 17)) >>> 0);
  }

  _writeDhcsr(val){
    const dbg = val & 1, halt = (val >>> 1) & 1, step = (val >>> 2) & 1;
    this.dhcsr = val & 0xf;
    if (step && halt){
      /* 🚨 brokenCStep = 真机实测的那种坏组合：C_STEP 位写进去了、但核一步都不走，
       *    S_HALT 一直是 1（DHCSR 读回恒定 0x30007）。上层必须自己发现"PC 没动"再兜底。 */
      if (this.brokenCStep) return;
      // 单步：执行一条指令。**不要**立刻把 running 归零 —— 交给 _dhcsrWord 的状态机，
      // 让上层能观察到 "S_HALT 0 → 1" 这个过程（真硬件上这一步是真实发生的）。
      this._exec(1);
      this._stepPending = true;
      this._stepRunning = false;
      return;
    }
    this._stepPending = false; this._stepRunning = false;
    if (!dbg){ this.running = false; return; }
    this.running = !halt;
    if (this.running) this._lastTick = Date.now();
  }

  /** 按经过的时间推进假指令（同一毫秒内不重复推进，免得测试里数字乱跳） */
  _advance(){
    if (!this.running || this._now() === this._lastTick) return;
    const dt = Math.min(200, this._now() - this._lastTick);
    this._lastTick = this._now();
    this._exec(Math.max(1, dt * this._stepsPerMs));
  }
  _now(){ return Date.now(); }

  /**
   * 执行 n 条假指令：PC 前进（**认 BL/BLX**，跳到目标并把返回地址放进 LR）；
   * 撞上 FPB 比较器就停住（PC 停在断点那条指令上）。
   *
   * 为什么要认 BL/BLX：源码级「单步进入」的实现是"把临时断点放在被调函数的入口"，
   * 如果假目标永远只会 PC+=2，这条路径就**测不出来**（会上板才发现落点不对）。
   * flash 默认是 0xBF00（NOP）填充，所以老用例的行为不变。
   */
  _exec(n){
    for (let k = 0; k < n; k++){
      let pc = this.regs[RI.PC] >>> 0;
      if (pc < CODE || pc >= CODE_END) pc = CODE;                // 绕回代码区开头
      this.execCount++;
      if ((this.execCount & 0xff) === 0){                        // 心跳变量
        this._put32(this.ram, 0, this.execCount >>> 0);
        this._put32(this.ram, 4, (pc + 0x20000000) >>> 0);
        if (this._cpuAccess(RAM,4,'w') || this._cpuAccess(RAM+4,4,'w')) {
          this.regs[RI.PC]=(pc+2)>>>0; return;
        }
      }
      if ((this.execCount & 0x7ff) === 0) this._pushRtt(`[dbg] tick ${this.execCount >> 11} @0x${pc.toString(16)}\r\n`);
      if (this._bpHit(pc)) return;
      let next = (pc + 2) >>> 0;
      const hw1 = this._u16(this.flash, pc - FLASH);
      /**
       * `BX LR`（0x4770）= 函数返回：PC ← LR（抹掉 Thumb 位）。
       * 有了它，"单步进入 → 单步跳出"才能在假目标上真跑一遍（否则核只会顺序走，
       * 永远回不到调用点的下一条指令 —— 单步跳出的用例就测不出来）。
       */
      if (hw1 === 0x4770){
        this.regs[RI.PC] = (this.regs[RI.LR] & 0xfffffffe) >>> 0;
        continue;
      }
      /**
       * `PUSH {r7, lr}`（0xB580）/ `POP {r7, pc}`（0xBD80）：**真的动栈**（SP 减/加 8，值写进 RAM）。
       *
       * 为什么假目标也要有栈语义：「单步跳出」在**非叶子函数**里不能只看 LR ——
       * 本函数内部的 `bl` 早把 LR 覆盖成"那次调用之后的那条指令"了。页面的做法是不碰栈、
       * 改成"一条条单步走完本函数、用 **SP 有没有弹回去**判断这一帧结没结束"。
       * 假目标若不动 SP，这条路径就永远走不到终点（测不出来）——
       * 真机现场：H743 · 6 层嵌套 · 在 engine_deep_l4 里按「跳出」连续 5 次原地不动。
       */
      if (hw1 === 0xb580 || hw1 === 0xbd80){
        const push = hw1 === 0xb580;
        const sp = this.regs[RI.SP] >>> 0;
        const nsp = (push ? sp - 8 : sp + 8) >>> 0;
        const lo = push ? nsp : sp;
        if (lo >= RAM && lo + 8 <= RAM + RAM_SIZE){
          const o = lo - RAM;
          if (push){
            this._put32(this.ram, o, this.regs[7] >>> 0);            // r7
            this._put32(this.ram, o + 4, this.regs[RI.LR] >>> 0);    // lr
          } else {
            this.regs[7] = this._u32(this.ram, o);
            next = this._u32(this.ram, o + 4) & 0xfffffffe;          // pc ← 保存的 lr
          }
        }
        this.regs[RI.SP] = nsp;
        this.regs[RI.PC] = next;
        continue;
      }
      if (thumbLen(hw1) === 4){
        const hw2 = this._u16(this.flash, pc - FLASH + 2);
        const call = decodeCall(hw1, hw2, pc);
        if (call){
          this.regs[RI.LR] = ((pc + 4) | 1) >>> 0;               // Thumb BL：LR = 返回地址（带 bit0=1）
          next = call.target >>> 0;
        } else next = (pc + 4) >>> 0;                           // 其它 32 位指令占 4 字节
      }
      this.regs[RI.PC] = next;
    }
  }

  /** CPU access only: debugger SWD reads/writes must not fire data watchpoints. */
  _cpuAccess(addr,size,mode){
    if (!(this.ppb.get(0xe000edfc)&0x01000000)) return false;
    let hit=false;
    for(let slot=0;slot<4;slot++){
      const f=0xe0001028+16*slot, fn=(this.ppb.get(f)||0)&15;
      if(fn!==7 && fn!==(mode==='r'?5:6)) continue;
      const base=this.ppb.get(0xe0001020+16*slot)>>>0;
      const length=2**((this.ppb.get(0xe0001024+16*slot)||0)&31);
      if(addr<base+length && addr+size>base){ this.ppb.set(f,fn|0x01000000); hit=true; }
    }
    if(hit){ this.dfsr|=4; this.dhcsr|=3; this.running=false; }
    return hit;
  }

  /** 取指地址是否命中已使能的比较器（用**真编码/解码**，见 bp.js） */
  _bpHit(addr){
    for (let i = 0; i < 16; i++){
      const comp = this.ppb.get(FPB.COMP0 + 4 * i);
      if (comp === undefined) continue;
      const d = decodeComparator(comp, this.fpbRev);
      if (!d.enabled) continue;
      if ((d.addr & ~1) === (addr & ~1)){
        this.running = false;
        this.dfsr |= 2;                                          // DFSR.BKPT
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ DCRSR/DCRDR

  _writeDcrsr(val){
    val = val >>> 0;
    const sel = val & 0x1f;
    this.regs[RI.SEL] = val;
    if (val & 0x10000){                                          // REGWnR：写内核寄存器
      const v = this.regs[RI.DCRDR] >>> 0;
      if (sel === CFBP_SEL) this.regs[RI.CFBP] = v;
      else { const idx = CORE_INDEX[sel]; if (idx !== undefined) this.regs[idx] = v; }
    } else {
      this.regs[RI.DCRDR] = (sel === CFBP_SEL ? this.regs[RI.CFBP] : (this.regs[CORE_INDEX[sel]] ?? 0xffffffff)) >>> 0;
    }
  }

  // ------------------------------------------------------------ 与 WebUsbDapProbe 同形的接口

  async _dhcsr(value){ this._writeDhcsr(value >>> 0); }
  async run(){ this._writeDhcsr(0xa05f0001); }
  async halt(){ this._writeDhcsr(0xa05f0003); }
  async isHalted(){ return !this.running; }
  async readMemDiagnostic(addr,len){ return this.readMem(addr,len); }
  async regReadDiagnostic(sel){ if(this.running)throw new Error('目标在运行'); return this.regRead(sel); }
  async setHardFaultCatch(on){ const v=this.ppb.get(0xe000edfc)||0;this.ppb.set(0xe000edfc,on?v|(1<<10):v&~(1<<10));return !!(v&(1<<10)); }
  /** 真探针有 SWJ_Clock（0x11）；假目标只改个数字，够上层判断"实际用的是哪个档" */
  async setClock(hz){ this.clockHz = hz >>> 0; return true; }
  async _readWord(addr){
    // 模拟"高时钟读 PPB 回 0"的坏探针（见 ppbGarbage）
    if (this.ppbGarbage && (addr >>> 0) >= 0xe0000000) return 0;
    const b = await this.readMem(addr, 4); return this._u32(b, 0);
  }
  async _targetInit(){ return true; }
  async regRead(sel){ this._writeDcrsr(sel & 0x1f); return this.regs[RI.DCRDR] >>> 0; }
  async regWrite(sel, value){ this.regs[RI.DCRDR] = value >>> 0; this._writeDcrsr((sel & 0x1f) | 0x10000); }
  async _resetAfterAir(){
    const keepHalt = (this.dhcsr & 2) === 2;
    this._resetCore(false);
    this.dhcsr = 0xa05f0000 | (keepHalt ? 3 : 1);
  }
  async sysReset(){ await this._resetAfterAir(); return '软件复位（模拟）'; }
  async reset(){ await this._resetAfterAir(); return 'nRESET 脉冲（模拟）'; }
  async recover(){ return true; }
}
