/**
 * 模拟 RISC-V 目标（JTAG TAP + DTM/DMI + Debug Module + SBA + XPI flash + flashloader 行为）。
 *
 * 存在意义：探针被占用时，**离线**把整条烧录链路跑通 —— 而且不是"打桩常量"，
 * 是真的按位解释 `jtag.js` 生成的 JTAG 序列：
 *   · TAP 状态机（TMS/TDI 位流）→ 认 IR → 41 位 DMI 扫描（流水线一深）
 *   · DM 寄存器：dmcontrol / dmstatus / abstractcs / command / data0 / sbcs / sbaddress0 / sbdata0
 *   · SBA：32 位、自增、写地址即读、读数据即续读；错误位（写 1 清零）
 *   · 内存：64 KB SRAM（flashloader 就加载在这儿）
 *   · flashloader：按**入口表**的七个函数语义执行（init/erase/program/read/info/erase_chip/deinit），
 *     数据写进一块"XPI flash"数组 —— 所以"擦干净了没有、写进去的对不对"都能真验。
 *
 * 不模拟的部分（真机才能验）：真实电气时序、ROM API 内部的 XPI 寄存器舞蹈、
 * 真实 flash 的擦写时间与 SFDP 探测。
 */

import { DM, DMI_OP, sbcsBlock, REGNO, DCSR_EBREAK } from '../../app/flash/hpm/jtag.js';
import { parseAlgoEntryTable, ENTRY_ORDER } from '../../app/flash/hpm/entry.js';
import { XIP_COPY_ADDR } from '../../app/flash/hpm/xip-copy.js';

const STATUS = { success: 0, invalidArgument: 1, outOfRange: 2, timeout: 3, noFlash: 4 };

/** 真机 abstractcs 的常态值（datacount=4、progbufsize=8）*/
const ABSTRACT_NOERR = 0x08000004;
/** 真机 dmstatus 的"不变部分"（HPM6800EVK 实测 0x004003a2 去掉 halt/run 那几位）*/
const DMSTATUS_BASE = 0x004000a2;
/** dmstatus 里会翻转的位（legacy 排法）：halted / running / resumeack / havereset */
const DMSTATUS_DYN = { halted: 0x300, running: 0xc00, resumeack: 0x30000, havereset: 0xc0000 };

export class SimTarget {
  /**
   * @param {{ramSize?:number, flashSize?:number, sectorSize?:number, blockSize?:number}} [opts]
   */
  constructor(opts = {}){
    this.idcode = 0x1000563D;
    this.dtmcs = 0x71;                        // version=1, idle=7（与真探针一致）
    this.ramSize = opts.ramSize ?? 0x10000;   // 64 KB SRAM
    this.ram = new Uint8Array(this.ramSize);
    this.flash = new Uint8Array(opts.flashSize ?? 0x100000);   // 1 MB 外部 flash
    this.flash.fill(0xff);
    this.sectorSize = opts.sectorSize ?? 0x1000;               // 4 KB 扇区
    this.blockSize = opts.blockSize ?? 0x10000;                // 64 KB 块
    // DM 寄存器
    // dmstatus 按 **HPM6800EVK 真机标定**的 legacy 排法造（见 jtag.js 的 DMSTATUS_LAYOUT 注释）：
    //   0x004003a2 = version=2 | authenticated | hasresethaltreq | confstrptrvalid
    //                | allhalted/anyhalted(bit8/9) | impebreak(bit22)
    //   halted ⇄ bit8/9，running ⇄ bit10/11，resumeack ⇄ bit16/17，havereset ⇄ bit18/19（都能翻转）
    this.dm = {
      dmcontrol: 0, dmstatus: DMSTATUS_BASE,
      abstractcs: ABSTRACT_NOERR,               // datacount=4 / progbufsize=8（与真机一致）
      command: 0, data0: 0, sbcs: sbcsBlock() & 0x000fffff,
      sbaddress: 0,
    };
    this.progbuf = [0, 0, 0, 0];                // progbuf0..3（主机侧只用前 3 个字放 fence）
    this.progbufRuns = 0;
    // dcsr：**故意按"刚上电、没被任何调试器动过"来造** —— ebreak* 全 0。
    // 真机上我们第一次接手时读到的是 0x4000b643（ebreak* 已置），但那是上一次 OpenOCD 会话留下的；
    // 全新板子不能指望这个，所以自测按最严的来：主机侧不置 dcsr.ebreak* 就会暴露。
    this.dcsr = 0x40000003;                     // xdebugver=4 | prv=machine
    this.dcsrEbreakEnabled = false;
    this.resumeAcked = false;                   // 收到过 resumereq（dmstatus bit16/17，粘住）
    this.havereset = false;                     // 被 ndmreset 复位过（dmstatus bit18/19，粘住）
    this.trapped = false;                       // ebreak 变成异常"跑飞"过

    this.regs = new Uint32Array(32);            // x0..x31（a0 = x10 = regs[10]）
    this.pc = 0;
    this.halted = true;
    // flashloader 状态（由 algo 的静态区模拟）
    this.flashInited = false;
    this.flashInfo = { totalBytes: this.flash.length, sectorBytes: this.sectorSize, blockBytes: this.blockSize };
    this.progChunks = 0;
    this.eraseOps = 0;
    this.romReads = 0;                          // ROM 的 flash_read 真跑了几次
    this.xipCopies = 0;                         // XIP 拷贝例程跑了几次（verify 走这条）
    this.romReadWedged = false;                 // 命中"ROM 读楔死总线"那个真机 bug
    this.injectOp3 = 0;                         // 故障注入：接下来 N 条 DMI 响应 op=3（DTM 错误态）
    this.dmiResets = 0;                         // 主机侧写了几次 dtmcs.dmireset
    this.readWedgedNow = false;
    this.log = [];
    // Independent protocol model: bus completion advances on TCK, not on host reads.
    this.busDelayCycles = opts.busDelayCycles ?? 0;
    this.busErrorAt = opts.busErrorAt ?? null;
    this.busHangAt = opts.busHangAt ?? null;
    this.busPending = null;
    this.busAccesses = [];
    this.busyConfigWrites = 0;
    this.sbaError = 0;
    this.sbaBusyError = false;
    this.dmiSticky = 0;
    // 统计（自测断言用）
    this.stats = { scans: 0, dmiWrites: 0, dmiReads: 0, sbaReads: 0, sbaWrites: 0 };
  }

  // ---------------------------------------------------------------- JTAG 层
  /** 执行一批序列，返回"要捕获的序列"的 TDO 字节数组（与 CMSIS-DAP 的响应同形）*/
  jtagSequences(seqs){
    const out = [];
    for (const s of seqs){
      const tdo = this._runSequence(s);
      if (s.captureBytes > 0) out.push(tdo);
    }
    return Promise.resolve(out);
  }

  connectJtag(){ this.log.push('DAP_Connect(JTAG)'); return Promise.resolve(); }

  _runSequence(seq){
    const clocks = s_clocks(seq.info);
    const tms = !!(seq.info & 0x40);
    const capture = !!(seq.info & 0x80);
    const tdo = new Uint8Array(seq.tdi.length);
    for (let i = 0; i < clocks; i++){
      const tdi = (seq.tdi[i >> 3] >> (i & 7)) & 1;
      const bit = this._tick(tms, tdi);
      if (capture && bit) tdo[i >> 3] |= 1 << (i & 7);
    }
    return tdo;
  }

  /** TAP 状态机 + 移位寄存器（DR/IR）*/
  _tick(tms, tdi){
    if (this.busPending && this.busPending.addr !== this.busHangAt && --this.busPending.left <= 0)
      this._sbaComplete();
    const S = this.tap || (this.tap = { state: 'TLR', ir: 0, dr: 0, drBits: 0, irBits: 0, tdo: 0 });
    let out = 0;
    switch (S.state){
      case 'TLR':      S.state = tms ? 'TLR' : 'RTI'; break;
      case 'RTI':      S.state = tms ? 'SelDR' : 'RTI'; break;
      case 'SelDR':    S.state = tms ? 'SelIR' : 'CapDR'; break;
      case 'CapDR':    S.state = tms ? 'Ex1DR' : 'ShiftDR'; S.drBits = 0; S.dr = 0n; S.shiftOut = this._drShiftOut(S.ir); break;
      case 'ShiftDR': {
        // 先出后进：TDO 是**上一次**请求的响应（流水线一深）
        out = Number((S.shiftOut ?? 0n) & 1n);
        if (S.shiftOut != null) S.shiftOut >>= 1n;
        S.dr |= BigInt(tdi & 1) << BigInt(S.drBits++);
        S.state = tms ? 'Ex1DR' : 'ShiftDR';
        break;
      }
      case 'Ex1DR':    S.state = tms ? 'UpdDR' : 'ShiftDR'; break;
      case 'UpdDR':    S.state = tms ? 'SelDR' : 'RTI'; this._onUpdateDR(S); break;
      case 'SelIR':    S.state = tms ? 'TLR' : 'CapIR'; break;
      case 'CapIR':    S.state = tms ? 'Ex1IR' : 'ShiftIR'; S.irBits = 0; S.ir = 0; break;
      case 'ShiftIR':
        S.ir |= (tdi & 1) << S.irBits++;
        S.state = tms ? 'Ex1IR' : 'ShiftIR';
        break;
      case 'Ex1IR':    S.state = tms ? 'UpdIR' : 'ShiftIR'; break;
      case 'UpdIR':    S.state = tms ? 'SelDR' : 'RTI'; this._onUpdateIR(S); break;
      default:         S.state = 'TLR'; break;
    }
    return out;
  }

  /**
   * 每次进入 Shift-DR 都要**重新装**要移出的值（一深流水线的响应、IDCODE、DTMCS）。
   * 🚨 早期只在 Update-IR 时装一次，于是同一条 IR 下的第二次扫描移出的还是上次被移空了的寄存器
   *    （全 0）—— 表现是"IDCODE 读到了、dmstatus 全是 0"。
   */
  _drShiftOut(ir){
    const i = ir & 0x1f;
    if (i === 0x01) return BigInt(this.idcode);
    if (i === 0x10) return BigInt(this.dtmcs);
    if (i === 0x11) return this.pendingDmi ?? 0n;
    return 0n;
  }

  _onUpdateIR(S){
    S.ir &= (1 << S.irBits) - 1;
    this.log.push(`IR=0x${S.ir.toString(16)}`);
  }

  _onUpdateDR(S){
    if ((S.ir & 0x1f) === 0x01){
      return;                                   // IDCODE：只读
    }
    if ((S.ir & 0x1f) === 0x10){
      // DTMCS 写：只认 dmireset（bit16）—— 真机语义：它清掉 DTM 的 DMI 错误态。
      // 2026-10-01 用户现场就靠这一下自愈（`DMI 写 0x39 失败（op=3）`）。
      if (S.dr & (1n << 16n)) {
        this.dmiResets = (this.dmiResets || 0) + 1;
        this.dmiSticky = 0;
        this.pendingDmi = 0n;
      }
      return;
    }
    if ((S.ir & 0x1f) !== 0x11) return;
    this.stats.scans++;
    /**
     * 故障注入：响应 op=3 是粘滞 BUSY，后续请求不处理，直到 dtmcs.dmireset。
     * 主机只能重发明确未接收的请求；结果不确定的有副作用访问不能盲目重发。
     */
    if (this.dmiSticky) { this.pendingDmi = BigInt(this.dmiSticky); return; }
    if (this.injectOp3 > 0){
      this.injectOp3--;
      this.op3Injected = (this.op3Injected || 0) + 1;
      this.pendingDmi = 3n;
      this.dmiSticky = 3;
      return;
    }
    // 41 位 DMI：op(2) | data(32)<<2 | addr(7)<<34
    const req = S.dr & ((1n << 41n) - 1n);
    const op = Number(req & 0x3n);
    const data = Number((req >> 2n) & 0xffffffffn) >>> 0;
    const addr = Number((req >> 34n) & 0x7fn);
    this.pendingDmi = this._dmiExecute(op, addr, data);
  }

  /** 执行一条 DMI 请求，返回 41 位响应（op 在低 2 位）*/
  _dmiExecute(op, addr, data){
    const enc = (opCode, payload) => BigInt(opCode & 0x3) | (BigInt(payload >>> 0) << 2n);
    if (op === DMI_OP.NOP) return enc(0, 0);
    if (op === DMI_OP.READ){
      this.stats.dmiReads++;
      return enc(0, this._readReg(addr));
    }
    if (op === DMI_OP.WRITE){
      this.stats.dmiWrites++;
      this._writeReg(addr, data);
      return enc(0, 0);
    }
    return enc(2, 0);
  }

  _readReg(addr){
    const d = this.dm;
    switch (addr){
      case DM.DMSTATUS: {
        // 按真机的 legacy 排法合成：halted/running 互斥，resumeack 与 havereset 粘住
        let v = DMSTATUS_BASE & ~(DMSTATUS_DYN.halted | DMSTATUS_DYN.running |
                                  DMSTATUS_DYN.resumeack | DMSTATUS_DYN.havereset);
        v |= this.halted ? DMSTATUS_DYN.halted : DMSTATUS_DYN.running;
        if (this.resumeAcked) v |= DMSTATUS_DYN.resumeack;
        if (this.havereset) v |= DMSTATUS_DYN.havereset;
        return v >>> 0;
      }
      case DM.DMCONTROL: return d.dmcontrol >>> 0;
      case DM.ABSTRACTCS: return d.abstractcs >>> 0;
      case DM.COMMAND: return d.command >>> 0;
      case DM.DATA0: return d.data0 >>> 0;
      case DM.SBCS: {
        // sbbusy / sbbusyerror / sberror 由 SBA 状态决定；配置位回读
        return (d.sbcs | (1 << 29) | (32 << 5) | 4 |
          (this.busPending ? 1 << 21 : 0) | (this.sbaBusyError ? 1 << 22 : 0) | (this.sbaError << 12)) >>> 0;
      }
      case DM.SBADDRESS0: return d.sbaddress >>> 0;
      case DM.SBDATA0: {
        if (this.busPending) this.sbaBusyError = true;
        const v = this.sbaNext ?? 0;
        if (!this.busPending && (this.dm.sbcs & (1 << 15))) this._sbaStart(false);
        return v >>> 0;
      }
      default: return 0;
    }
  }

  _writeReg(addr, data){
    const d = this.dm;
    switch (addr){
      case DM.DMCONTROL: {
        const wasActive = !!(d.dmcontrol & 1);
        const wasReset = !!(d.dmcontrol & 2);
        d.dmcontrol = data >>> 0;
        if (data & (1 << 31)){ this.halted = true; }                  // haltreq
        if (data & (1 << 30)){                                        // resumereq
          this.halted = false;
          this.resumeAcked = true;                                    // dmstatus bit16/17（真机上也粘住）
          this._onResume();
        }
        if (!wasActive && (data & 1)) this.halted = true;             // dmactive 上升沿：DM 复位、hart 停住
        // ndmreset 是电平式：拉高=拉复位（dmstatus 的 havereset 置起）、拉低=核从复位向量开始
        // 🚨 松开复位时核是"跑"还是"停"，取决于 **haltreq 有没有一起保持**：
        //    保持 haltreq = reset-**halt**（核停在复位向量，应用没机会重新配 XPI）；
        //    不保持 = reset-run（应用立刻起来）。主机侧 `RiscvTransport.resetHalt` 靠的就是这个差别
        //    （HPM6800EVK 上"应用配过的 XPI"会让第一次 erase 卡死，reset-halt 才治得好）。
        if ((data & 2) && !wasReset){ this.resetPulse = true; this.havereset = true; }
        if (!(data & 2) && wasReset){
          this.resetPulse = false;
          this.pc = 0;
          this.halted = !!(data & (1 << 31)) || !!(data & (1 << 28));   // haltreq 保持 → 停在复位向量
        }
        break;
      }
      case DM.PROGBUF0: case DM.PROGBUF0 + 1: case DM.PROGBUF0 + 2: case DM.PROGBUF0 + 3:
        this.progbuf[addr - DM.PROGBUF0] = data >>> 0;
        break;
      case DM.COMMAND: {
        d.command = data >>> 0;
        this._onAbstract(data >>> 0);
        break;
      }
      case DM.DATA0: d.data0 = data >>> 0; break;
      case DM.SBCS: {
        if (this.busPending) { this.busyConfigWrites++; throw Error('SBCS write while sbbusy'); }
        if (data & (1 << 22)) this.sbaBusyError = false;
        this.sbaError &= ~((data >>> 12) & 7);
        d.sbcs = (data & ((7 << 17) | (1 << 16) | (1 << 15) | (1 << 20))) >>> 0;
        break;
      }
      case DM.SBADDRESS0: {
        if (this.busPending) { this.sbaBusyError = true; break; }
        d.sbaddress = data >>> 0;
        // 🚨 真实的 DM 语义：**写 sbaddress0 时若置了 sbreadonaddr 就立刻发起一次总线读**，
        //    读成功后按 sbautoincrement 把地址 +4 —— 所以"写地址 → 写数据"这条路上，
        //    第一笔数据会落到 addr+4（真机实测的错位就是这样来的）。
        //    模拟器必须照这个来，否则主机侧的 sbcs 配错在自测里根本发现不了。
        if (d.sbcs & (1 << 20)) this._sbaStart(false);
        break;
      }
      case DM.SBDATA0: {
        if (this.busPending) { this.sbaBusyError = true; break; }
        this._sbaStart(true, data >>> 0);
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- SBA
  _sbaStart(write, value = 0){
    if (this.sbaBusyError || this.sbaError) return;
    const addr=this.dm.sbaddress >>> 0;
    this.busAccesses.push({addr,write});
    this.stats[write?'sbaWrites':'sbaReads']++;
    this.busPending={addr,write,value,left:this.busDelayCycles};
    if (!this.busDelayCycles && addr !== this.busHangAt) this._sbaComplete();
  }

  _sbaComplete(){
    const p=this.busPending; this.busPending=null;
    if (p.addr === this.busErrorAt) this.sbaError=2;
    else if (p.write) this._sbaStore(p.value);
    else this.sbaNext=this._loadWord(p.addr);
    if (!this.sbaError && (this.dm.sbcs & (1 << 16))) this.dm.sbaddress=(p.addr+4)>>>0;
  }

  _sbaStore(v){
    const a = this.dm.sbaddress >>> 0;
    if (a < this.ramSize){
      const dv = new DataView(this.ram.buffer, a, 4);
      dv.setUint32(0, v, true);
      // 写进 RAM 的可能是 flashloader 的代码/数据，也可能是普通数据 —— 都一样处理
    } else {
      this.sbaError = 2;
    }
  }

  _loadWord(a){
    a = a >>> 0;
    if (a < this.ramSize){
      const dv = new DataView(this.ram.buffer, a, 4);
      return dv.getUint32(0, true);
    }
    this.sbaError = 2;
    return 0;
  }

  // ---------------------------------------------------------------- 目标核 + flashloader
  /**
   * 自测用的直通入口：按"主机侧那一套"摆好参数与 pc，再走一次 resume。
   * 只给测试里"想单独验某个语义"的场合用，烧录流程本身不碰它。
   */
  runAlgoEntry(entryOffset, args = []){
    for (let i = 0; i < args.length; i++) this.regs[10 + i] = args[i] >>> 0;
    this.pc = entryOffset >>> 0;
    this.halted = false;
    this._onResume();
    return this.halted;
  }

  /**
   * resume：看 pc 落在**入口表的哪一项**，就"执行"那个函数（模拟算法的效果）。
   * 入口表是**从 RAM 里现解析的**（flashloader 刚被 SBA 写进去），和真机"跑到那个地址"同构 ——
   * 所以主机侧改了入口偏移/顺序，这里立刻就不认（而不是靠测试代码自己告诉模拟器调哪个函数）。
   */
  _onResume(){
    const a0 = this.regs[10], a1 = this.regs[11], a2 = this.regs[12], a3 = this.regs[13], a4 = this.regs[14];
    void a4;
    // 🚨 真机语义：只能以 `ebreak` 收尾、**且 dcsr.ebreak* 置起**时才进调试模式（= halt）。
    //    没置的话它是普通断点异常 → 核跳进异常向量乱跑、dmstatus 永远 running
    //    （我们就是这么在真机上卡了一轮）。这里照这个来，主机侧漏掉置位就能在自测里暴露。
    const ebreakOk = () => {
      if (this.dcsrEbreakEnabled) return true;
      this.log.push(`resume pc=0x${this.pc.toString(16)}：dcsr.ebreak* 没置 → ebreak 变成异常，核跑飞（不 halt）`);
      this.regs[10] = 0;                         // 返回码是垃圾（现实中读不到）
      this.halted = false;
      this.trapped = true;
      return false;
    };
    /**
     * 🚨 **XIP 拷贝例程**（`app/flash/hpm/xip-copy.js`，装载在 0x600）：
     *    主机侧 verify 靠它让**内核自己走 XIP 窗口**把 flash 搬进 RAM —— 与 OpenOCD 同路
     *    （2026-10 LA 解码 OpenOCD 波形定因：它读内存全靠 progbuf 跑 `lw s1,0(s1)`，
     *      `sbcs/sbaddress0/sbdata0` 写入次数为 0，且**从不调算法的 read 入口**）。
     *    这里按例程的真实语义执行：从 XPI 窗口拷 len 字节到 RAM；越界/非 4 倍数 → fault（不 halt）。
     *    ⚠️ 它**不是入口表里的一项**，所以必须在"查表 + 不是入口就 return"**之前**处理。
     */
    if ((this.pc >>> 0) === XIP_COPY_ADDR){
      if (!ebreakOk()) return;
      const r = this._xipCopy(a0, a1, a2);
      if (r === STATUS.success){
        this.regs[10] = 0;
        this.halted = true;
        return;
      }
      this.regs[10] = r >>> 0;
      this.halted = false;                        // 加载/存储 fault → 走异常向量，永远到不了 ebreak
      this.trapped = true;
      this.log.push(`xip_copy(src=0x${a0.toString(16)}, dst=0x${a1.toString(16)}, ${a2} B) → fault（地址越界/长度不是 4 的倍数）`);
      return;
    }
    const table = this._entryTable();
    // 🚨 pc 指的是**表项位置**（loadAddr + entryOffset，init 就是 0），不是 jal 的落点
    const hit = table.find(e => e.entryOffset === (this.pc >>> 0));
    if (!hit) { this.log.push(`resume pc=0x${this.pc.toString(16)}（不是算法入口，当作普通运行）`); return; }
    const entry = ENTRY_ORDER[table.indexOf(hit)];
    if (!ebreakOk()) return;
    let rc = STATUS.success;
    switch (entry){
      case 'init':  rc = this._flashInit(a0, a2, a3); break;
      case 'erase': rc = this._flashErase(a0, a1, a2); break;
      case 'program': rc = this._flashProgram(a0, a1, a2, a3); break;
      // 参数顺序照 README 的签名：flash_read(flash_base, buf, address, size) → a0..a3
      case 'read':
        rc = this._flashRead(a0, a1, a2, a3);
        // 🚨 命中"ROM 读楔死总线"的形状：核卡在永不完成的 XPI 事务上，
        //    **永远到不了末尾那条 ebreak**（真机上 haltreq 都停不住）→ 这里必须直接返回，不置 halted。
        if (this.readWedgedNow){ this.regs[10] = 0; this.halted = false; return; }
        break;
      case 'info':  rc = this._flashInfo(a0, a1); break;
      case 'eraseChip': rc = this._flashEraseChip(); break;
      case 'deinit': rc = STATUS.success; break;
      default: rc = STATUS.invalidArgument;
    }
    this.regs[10] = rc >>> 0;                    // a0 = 返回码
    this.halted = true;                          // ebreak → halt
  }

  /** 从 RAM 里现解析 flashloader 的入口表（缓存）*/
  _entryTable(){
    if (this._table) return this._table;
    const view = this.ram.subarray(0, 0x200);
    this._table = parseAlgoEntryTable(view);
    return this._table;
  }

  _flashInit(flashBase, opt0, opt1){
    this.flashInited = true;
    this.log.push(`flash_init(base=0x${flashBase.toString(16)}, opt0=0x${opt0.toString(16)}, opt1=0x${opt1.toString(16)})`);
    return STATUS.success;
  }

  /**
   * 🚨 **地址参数是"偏移"，不是绝对地址** —— 这是真机定标出来的语义（2026-10）：
   *    algo 里 `flash_erase/program/read` 只在 ROM API 版本 ≥ 0x56010300（hybrid XPI）时
   *    才 `address += flash_base`；HPM6800EVK 这版不是 hybrid，所以主机侧必须传偏移。
   *    真机实测：传绝对地址 → rc=2（out of range）；传偏移 → 擦/写/读全 rc=0。
   *    模拟器照这个来：`address` 超出 [0, flash.length) 一律 out_of_range ——
   *    这样主机侧要是忘换算，"擦/写/读全挂在第一块"在离线自测里就会炸，而不是等到真机。
   */
  _flashErase(flashBase, addr, size){
    if (!this.flashInited) return STATUS.noFlash;
    const off = addr >>> 0;
    if (off + size > this.flash.length) return STATUS.outOfRange;
    // 真算法按扇区擦；这里按扇区把区间标成 0xFF
    const from = Math.floor(off / this.sectorSize) * this.sectorSize;
    const to = Math.ceil((off + size) / this.sectorSize) * this.sectorSize;
    this.flash.fill(0xff, from, Math.min(to, this.flash.length));
    this.eraseOps++;
    this.log.push(`flash_erase(offset=0x${off.toString(16)}, ${size} B) → 擦 ${to - from} B`);
    return STATUS.success;
  }

  _flashEraseChip(){
    this.flash.fill(0xff);
    this.eraseOps++;
    return STATUS.success;
  }

  _flashProgram(flashBase, addr, bufAddr, size){
    if (!this.flashInited) return STATUS.noFlash;
    const off = addr >>> 0;
    if (off + size > this.flash.length) return STATUS.outOfRange;
    if (bufAddr + size > this.ramSize) return STATUS.invalidArgument;
    const src = this.ram.subarray(bufAddr, bufAddr + size);
    /**
     * NOR flash 的编程语义是**按位与**：只能把 1 写成 0，写 1 到已经是 0 的位不会把它变回 1
     * （硬件不报错，只是写不进去）。所以"没擦就写"不会当场失败，而是**校验时**露馅 ——
     * 这正是真机上的表现，模拟器照做，别把它变成"编程返回错误"。
     */
    for (let i = 0; i < size; i++){
      const merged = this.flash[off + i] & src[i];
      if (merged !== src[i]) this.programWithoutErase = true;    // 诊断标志（自测里断言它被置起）
      this.flash[off + i] = merged;
    }
    this.progChunks++;
    return STATUS.success;
  }

  /**
   * ROM 的 `flash_read` 语义 —— **连同真机那个"楔死总线"的 bug 一起建模**。
   *
   * 2026-10 HPM6800EVK 实测：flash offset ≥ 0x30000 且尺寸 ≥ 32768 时，
   * ROM 的读会卡在一条**永不完成的 XPI 事务**上：核再也到不了 ebreak（haltreq 都停不住），
   * `dmstatus` 恒报 running。主机侧不加小心的表现就是"等目标 halt 超时 60s → 整轮报废"。
   *
   * 所以这里照真机行为来：命中那个形状就**不 halt**（= 卡死），
   * 让"又有人把 verify 改回 ROM read"在离线自测里当场炸掉，而不是等真机烧板子。
   * 阈值是实测值（0x30000+16384 正常、+32768 卡），不是拍脑袋。
   */
  _flashRead(flashBase, bufAddr, addr, size){
    const off = addr >>> 0;                                  // 同上：这里是**偏移**
    this.readWedgedNow = false;
    if (off >= 0x30000 && size >= 32768){
      this.romReadWedged = true;
      this.readWedgedNow = true;
      this.log.push(`flash_read(offset=0x${off.toString(16)}, ${size} B) → ROM 读楔死总线（真机 bug），核永远到不了 ebreak`);
      return STATUS.success;
    }
    if (off + size > this.flash.length) return STATUS.outOfRange;
    if (bufAddr + size > this.ramSize) return STATUS.invalidArgument;
    this.ram.set(this.flash.subarray(off, off + size), bufAddr);
    this.romReads = (this.romReads || 0) + 1;
    return STATUS.success;
  }

  /** XIP 拷贝例程的语义（内核走 XPI 窗口读，见 app/flash/hpm/xip-copy.js）*/
  _xipCopy(src, dst, len){
    const XIP_BASE = 0x80000000;
    if (len === 0 || (len >>> 0) % 4) return STATUS.invalidArgument;
    if ((src >>> 0) < XIP_BASE || ((src >>> 0) - XIP_BASE) + (len >>> 0) > this.flash.length) return STATUS.outOfRange;
    if ((dst >>> 0) + (len >>> 0) > this.ramSize) return STATUS.invalidArgument;
    this.ram.set(this.flash.subarray((src >>> 0) - XIP_BASE, (src >>> 0) - XIP_BASE + (len >>> 0)), dst >>> 0);
    this.xipCopies = (this.xipCopies || 0) + 1;
    this.log.push(`xip_copy(0x${(src >>> 0).toString(16)} → RAM 0x${(dst >>> 0).toString(16)}, ${len} B)`);
    return STATUS.success;
  }

  _flashInfo(flashBase, infoAddr){
    if (!infoAddr || infoAddr + 8 > this.ramSize) return STATUS.invalidArgument;
    const dv = new DataView(this.ram.buffer, infoAddr, 8);
    dv.setUint32(0, this.flashInfo.totalBytes, true);
    dv.setUint32(4, this.flashInfo.sectorBytes, true);
    return STATUS.success;
  }

  /**
   * 抽象命令（Access Register / Access Memory）。
   * 烧录流程靠它：写 a0..a4（参数）、写 dpc（跳到算法入口）、读 a0（返回码）。
   */
  _onAbstract(command){
    const cmdtype = (command >>> 29) & 0x7;
    const regno = command & 0xffff;
    const write = !!((command >>> 16) & 1);
    const transfer = !!((command >>> 17) & 1);
    const postexec = !!((command >>> 18) & 1);
    if (postexec){
      // 执行 progbuf 里的程序：真机上这是"不进目标内存就能干活"的唯一手段（fence.i / 探 CSR）
      const prog = this.progbuf.slice();
      this.log.push(`progbuf 执行：${prog.map(w => '0x' + (w >>> 0).toString(16)).join(' ')}`);
      this.progbufRuns++;
      // 只认我们真正会发的那段（fence.i; fence rw,rw; ebreak）；别的一律 cmderr=1（不支持）
      const isFence = prog[0] === 0x0000100f && prog[1] === 0x0330000f && prog[2] === 0x00100073;
      if (!isFence) this.dm.abstractcs = ABSTRACT_NOERR | (1 << 8);
      return;
    }
    if (cmdtype === 0){                                  // Access Register
      if (!transfer) return;
      // 🚨 dpc = 0x7b1（调试规范 §3.14）。历史上这里跟着主机侧一起写错过 0x7c1，
      //    那样"写 pc"会静默落到别的寄存器上，主机侧 resume 永远跳不到算法入口。
      const isPc = regno === REGNO.PC;
      const isX = regno >= 0x1000 && regno < 0x1020;
      const isDcsr = regno === REGNO.DCSR;
      if (write){
        if (isPc) this.pc = this.dm.data0 >>> 0;
        else if (isDcsr){ this.dcsr = this.dm.data0 >>> 0; this.dcsrEbreakEnabled = !!(this.dcsr & DCSR_EBREAK.m); }
        else if (isX) this.regs[regno - 0x1000] = this.dm.data0 >>> 0;
      } else {
        this.dm.data0 = isPc ? this.pc >>> 0
                     : isDcsr ? this.dcsr >>> 0
                     : (isX ? this.regs[regno - 0x1000] : 0);
      }
      return;
    }
    if (cmdtype === 2){                                  // Access Memory（本工程没用到，留着以防将来）
      const size = 1 << ((command >>> 20) & 0x7);
      const addr = this.regs[11] >>> 0;                  // s1 = 地址（规范：地址放 x1? 实际是 s1=x9）
      void size; void addr;
    }
  }

}

/** CMSIS-DAP 序列 info 字节 → 拍数（0 = 64）*/
function s_clocks(info){
  const n = info & 0x3f;
  return n === 0 ? 64 : n;
}
