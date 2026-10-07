/**
 * RISC-V 调试模块访问（DMI + SBA），跑在 CMSIS-DAP 的 JTAG 序列之上。
 *
 * 分层（**传输是注入的**，所以同一套协议代码既能驱动真探针，也能被模拟 DTM 驱动）：
 *
 *   RiscvTransport（本文件） ← 需要一个 `dap`：
 *       { jtagSequences(seqs) -> Promise<Uint8Array[]>   // 每条序列的 TDO 字节
 *         connectJtag() -> Promise<void> }               // DAP_Connect(JTAG) + 配置
 *   ↑ 真机：app/flash/hpm/dap-transport.js（走 WebUSB interface 0 的 CMSIS-DAP v2）
 *   ↑ 自测：tools/selftest/hpm-flash.test.mjs 里的模拟 DTM
 *
 * 关键协议点（与探针固件 `riscv_jtag.c` 的做法逐条对齐，那份在 HPM6800EVK 上跑通过）：
 *   · **DMI 是流水线**：每次扫描拿回的是**上一次**请求的响应，所以 read = 发 READ + 发 NOP 收结果；
 *     连续写可以一直 posted，只在需要确认时补一次 NOP。
 *   · `dtmcs.idle` 要求扫描之间给若干 RTI 拍（本探针实测 7，见固件注释），默认 8。
 *   · SBA 块访问：`sbcs = 32 位 + 自增 + 写地址即读 + 读数据即续读`，
 *     写 `sbaddress0` 就发起第一次读，之后每读一次 `sbdata0` 就自动开始下一次。
 *   · 出错（sbbusyerror / sberror）**写 1 清零**，写 0 等于没做 —— 固件里踩过这个坑
 *     （"搬了一块就再也搬不动"），这里照它的做法处理。
 */

import { DM, DMI_OP, DMI_STATUS, SBCS, sbcsBlock, sbcsWrite, sbcsHold, dmiRequest, dmiResponse,
         tapReset, tapLoadIR, drScan, bitsToUint, abstractCommand, ABSTRACTCS, DMSTATUS, DMSTATUS_LAYOUT,
         DMCONTROL, CMDTYPE, REGNO, DCSR_EBREAK, PROGBUF_FENCE } from './jtag.js';

/** IR 值（RISC-V DTM 规范：0x01 = IDCODE、0x10 = DTMCS、0x11 = DMI） */
export const IR_IDCODE = 0x01;
export const IR_DTMCS = 0x10;
export const IR_DMI = 0x11;
/** DR 位宽 */
export const DR_DMI_BITS = 41;
export const DR_DTMCS_BITS = 32;
export const DR_IDCODE_BITS = 32;

/**
 * SBA 批量读/写时，每拍之间多插几拍 RTI 空转（`drScan` 的 `idle`）。
 *
 * 🚨 2026-10 真机定因（用户现场：监视里加一个结构体 → 每次停住都报读失败，而断点/单步看着
 *    完全正常）：SBA 是"访问 sbdata0 就触发下一笔总线访问"，DM 的总线访问比 JTAG 拍**慢**
 *    —— 背靠背连发时只要有一笔还没完就收到下一次访问，DM 就置 `sbbusyerror`，**而且它的
 *    SBA 引擎会就此卡住**（之后每次读内存都失败；抽象命令不受影响）。清位救不回来，只能
 *    重新初始化 DM 或断电。目标在跑、总线还被 DMA 抢时（tcpecho 的网口就是）这笔访问更慢。
 *
 *    所以从源头拉开间隔，**用 `idle` 而不是多垫 NOP 拍**：idle 只把那条空转序列的**时钟数**
 *    改大，TDI 字节数固定 8 B 不变 —— 不占 CMSIS-DAP 的 512 B/包预算（垫 NOP 拍要 ~18 B/拍，
 *    13 字一批直接冲到 1909 B，被 make test-offline 当场拦下）。
 */
const SB_BEAT_IDLE = 64;

export class RiscvTransport {
  /**
   * @param {{jtagSequences:(seqs:Array)=>Promise<Uint8Array[]>, connectJtag?:()=>Promise<void>}} dap
   * @param {{idle?:number, log?:Function}} [opts]
   */
  constructor(dap, opts = {}){
    this.dap = dap;
    this.idle = opts.idle ?? 8;              // DTM 要求的 RTI 拍（探针固件默认 8）
    this.log = opts.log || (() => {});
    this.open = false;
    this.lastDtmcs = 0;
    this.lastDmstatus = 0;
    this.lastSbcs = 0;
    this.scans = 0;
    this.sbaFailed = false;
    this._sbcsCfg = null;
    this._burstOff = false;    // 批量读被真机拒绝过就关掉（见 readMem / sbaReadBurst）
    this._burstMiss = 0;
    this._holdAddr = null;
    this.dmLayout = null;      // dmstatus 的位布局（'legacy' = halted 在 bit8/9，'spec' = bit14/15），init 时实测
  }

  /**
   * 打开 TAP 并唤醒 DM —— 顺序**照探针固件 `riscv_jtag_open()`**（那份在 HPM6800EVK 上跑通过）：
   *   ① TAP 复位 → IR=0x01 读 IDCODE（0 / 0xFFFFFFFF 视为没人）
   *   ② IR=0x10 读 DTMCS
   *   ③ 🚨 **再走一次 TAP 复位**：dtmcs/idcode 扫描之后 DTM 就不应答 DMI 了（固件实测记下的坑）
   *   ④ 装 IR=0x11，先投两条 NOP 把 DMI 流水线排空
   *   ⑤ 🚨 `dmcontrol` **写 0 再写 1**（不是只写 1）：写 0 会复位 DM、中止进行中的操作 ——
   *      这是 SBA 卡死（读到没挂载的地址导致 sbbusy 永久挂起）之后唯一的解药
   *   ⑥ 读 dmstatus 作为"DM 真的醒了吗"的判据
   */
  async init(){
    await this.dap.connectJtag?.();
    await this.sequences(tapReset());
    await this.sequences(tapLoadIR(IR_IDCODE));
    this.idcode = Number((await this._scanDR(DR_IDCODE_BITS, 0n)) & 0xffffffffn) >>> 0;
    if (!this.idcode || this.idcode === 0xffffffff) {
      throw new Error('JTAG 链上没读到 IDCODE（0/全 1）——' +
        '① 先查接线/供电（20 针排线两头是否插紧、板子上电）；' +
        '② 若反复如此、而且板上应用也不启动：目标很可能被卡住的 ndmreset 按在复位态' +
        '（TAP 靠探针 TCK 还能读 IDCODE，但 DMI 全部读回同一常量、haltreq 无效）——' +
        '把探针 USB 和板子电源一起拔掉，等 10 秒再插（只拔板子电源没用：探针的 5V 还在供电）。' +
        '详见 app/flash/hpm/riscv-dm.js 里 resetHalt() 的注释');
    }
    await this.sequences(tapLoadIR(IR_DTMCS));
    this.lastDtmcs = Number((await this._scanDR(DR_DTMCS_BITS, 0n)) & 0xffffffffn) >>> 0;

    // ③ dtmcs/idcode 扫描之后必须回 Test-Logic-Reset，否则 DMI 不应答
    await this.sequences(tapReset());
    await this.sequences(tapLoadIR(IR_DMI));
    // ④ 排空 DMI 流水线
    await this.dmiPost(DMI_OP.NOP, 0, 0);
    await this.dmiPost(DMI_OP.NOP, 0, 0);
    // ⑤ DM 复位（0）再唤醒（1）
    await this.dmiWrite(DM.DMCONTROL, 0);
    await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive);
    // ⑥ 判据
    this.lastDmstatus = (await this.dmiRead(DM.DMSTATUS)) >>> 0;
    /**
     * 🚨 **`dmstatus` 读回 0（连 version 字段都是 0）= DM 停在 `dmactive=0`**（2026-10-01 现场）：
     *    上面那句"dmcontrol=0 复位 DM"之后、"dmactive=1 唤醒"这一笔只要被链路抖掉一次，
     *    整个 DM 就静默地留在未激活态 —— 表现是 **TAP 能读 IDCODE、但 DMI 全 0**、
     *    `haltreq` 无效（用户现场日志正是 `dmstatus=0x0（version=0）`）。
     *    规范里 **dmcontrol 即使 DM 未激活也仍然可写**，所以这里多叫几次；还不行就
     *    TAP 复位 + `dtmcs.dmihardreset`（bit17）把 DTM 整个复位后再叫 —— 都失败才抛。
     *
     * 🚨 2026-10 又补一条：**version 不是 0 也可能是垃圾**。一次 SBA 读超时（读 XIP 窗口那类）
     *    之后实测读回 `dmstatus=0x67adb267`（version=7）—— 那不是"醒着的 DM"，
     *    而是 DMI 在回一堆无意义的数据；放任不管的话后续每个寄存器读都是乱的。
     *    这颗 DM 的 version 实测恒为 2，所以判据收紧成"低 4 位必须等于 2"。
     */
    const versionOk = (v) => ((v >>> 0) & 0xf) === 2;
    if (!versionOk(this.lastDmstatus)){
      this.log(` ⚠ dmstatus=0x${this.lastDmstatus.toString(16)} 不像是真的（version 应为 2）→ 叫醒 DM`);
      this.lastDmstatus = await this._dmWakeRecover();
      if (!versionOk(this.lastDmstatus)){
        throw new Error('调试模块不应答：dmstatus 一直读回 0 或垃圾（DM 停在未激活态 / DMI 被打乱）——' +
          '把探针 USB 和板子电源一起拔掉 10 秒再插（只拔板子电源不够：探针 5V 还在供电）');
      }
    }
    /**
     * 🚨 **"DMI 冻住"判别**（2026-10-01 现场）：读**两个不同的** DM 寄存器却得到**完全相同的值**
     *    （典型：`dmcontrol` 读回等于 `dmstatus`）—— 真机不可能这样，这是 DMI 卡在
     *    "重复返回上一次响应"（响应寄存器冻住、写不落地 → `haltreq` 无效、reset-halt 也停不住）。
     *    按规范这类态要 POR，但实测**TAP 复位 + `dtmcs.dmihardreset` + 重新 dmactive** 有机会救回来，
     *    所以这里自动试一次；救不回来才让上层报错（提示拔探针 USB + 板子电源）。
     */
    try {
      const dmc = (await this.dmiRead(DM.DMCONTROL)) >>> 0;
      if (dmc === this.lastDmstatus){
        this.log(` ⚠ DMI 像是冻住了（dmcontrol 与 dmstatus 都读回 0x${dmc.toString(16)}）→ 试硬复位 DTM`);
        const st = await this._dmWakeRecover();
        if (st) this.lastDmstatus = st;
        // 救回来没有？**必须复验**：救不回来就当场抛明确错误，别让上层白等 3~6 秒的 halt 超时
        // （真机实测：这种态 `dmihardreset` 也救不回来，只能 POR / BOOT0+复位）
        let stillFrozen = false;
        try {
          const dmc2 = (await this.dmiRead(DM.DMCONTROL)) >>> 0;
          stillFrozen = (dmc2 === this.lastDmstatus) || ((await this.dmiRead(DM.DMSTATUS)) >>> 0) === dmc2;
        } catch { stillFrozen = true; }
        if (stillFrozen){
          throw new Error('调试模块的 DMI 冻住了（两个 DM 寄存器读回同一个值、写不落地，haltreq 无效）——' +
            '硬复位 DTM 也救不回来。请把探针 USB 和板子电源一起拔掉 10 秒再插，' +
            '或用板子的 BOOT0 + 复位 把它拉回来（实测两者都有效）');
        }
        this.log(' ✅ 硬复位 DTM 后 DM 恢复应答');
      }
    } catch (e){
      if (/冻住/.test(String(e.message))) throw e;
      /* 其它读失败就走正常路径报错 */
    }
    this.open = true;
    this.log(`RISC-V DM：idcode=0x${this.idcode.toString(16)} dtmcs=0x${this.lastDtmcs.toString(16)} ` +
             `dmstatus=0x${this.lastDmstatus.toString(16)}（version=${DMSTATUS.version(this.lastDmstatus)}）`);
    return { idcode: this.idcode, dtmcs: this.lastDtmcs, dmstatus: this.lastDmstatus };
  }

  /**
   * **把不应答的 DM 叫醒**（dmstatus 读回 0 = `dmactive=0`；或 DMI 冻住时先硬复位 DTM）。
   * 返回叫醒后的 dmstatus（0 表示没救回来）。见 `init()` 里两处调用的注释。
   */
  async _dmWakeRecover(){
    for (let i = 0; i < 5; i++){
      try {
        await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive);
        await new Promise(r => setTimeout(r, 50));
        const st = (await this.dmiRead(DM.DMSTATUS)) >>> 0;
        if (st) return st;
      } catch { /* 继续试 */ }
    }
    try {
      await this.sequences(tapReset());
      await this.sequences(tapLoadIR(IR_DTMCS));
      await this._scanDR(DR_DTMCS_BITS, 1n << 17n);          // bit17 = dmihardreset
      await this.sequences(tapReset());
      await this.sequences(tapLoadIR(IR_DMI));
      await this.dmiPost(DMI_OP.NOP, 0, 0);
      await this.dmiPost(DMI_OP.NOP, 0, 0);
      await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive);
      const st = (await this.dmiRead(DM.DMSTATUS)) >>> 0;
      if (st) this.log(' DM 之前不应答 → TAP 复位 + dmihardreset 后已唤醒');
      return st;
    } catch { return 0; }
  }

  /**
   * 一次 DR 扫描，返回**移出位**拼成的 BigInt（低位先出，所以 bit i = 第 i 个移出的位）。
   *
   * 🚨 位对齐很容易写错：只有带 capture 的序列会回 TDO，而**每条序列回了多少位**由它的拍数决定
   *    （不是字节数）。这里逐条按位收集，避免"按字节拼接"把最后那条 1 拍的序列算成 8 位。
   */
  async _scanDR(nbits, tdi){
    const seqs = drScan(nbits, tdi, { idle: this.idle });
    const caps = await this.sequences(seqs);
    const bits = [];
    let ci = 0;
    for (const s of seqs){
      if (!s.captureBytes) continue;
      const bytes = caps[ci++];
      const clocks = s.clocks >= 64 ? 64 : s.clocks;
      for (let i = 0; i < clocks; i++) bits.push((bytes[i >> 3] >> (i & 7)) & 1);
    }
    let v = 0n;
    for (let i = 0; i < bits.length && i < nbits; i++) if (bits[i]) v |= (1n << BigInt(i));
    this.scans++;
    return v;
  }

  /** 把一批序列交给下层（真机是一条 DAP_JTAG_Sequence 命令，模拟器直接执行）*/
  async sequences(seqs){
    const caps = await this.dap.jtagSequences(seqs);
    if (!caps || caps.length !== seqs.filter(s => s.captureBytes > 0).length){
      // 下层的返回长度必须与"要捕获的序列条数"一致，否则位对齐全错（宁可报错也别继续）
      throw new Error(`JTAG 序列返回条数不对：期望 ${seqs.filter(s => s.captureBytes > 0).length}，实际 ${caps?.length}`);
    }
    return caps;
  }

  /**
   * 发一条 DMI 请求，返回**上一次**请求的响应（流水线语义）*/
  async dmiPost(op, addr = 0, data = 0){
    const bits = await this._scanDR(DR_DMI_BITS, dmiRequest(op, addr, data));
    return dmiResponse(bits);
  }

  /**
   * **解 DTM 的 DMI 错误态**：响应 `op=3`（既不是 SUCCESS 也不是 BUSY）就是它。
   *
   * 🚨 2026-10-01 真机现场（用户手动烧录，挂在这里）：日志 `DMI 写 0x39 失败（op=3）`——
   *    0x39 是 `sbaddress0`，op=3 说明 DTM 的 DMI 状态机进了错误态；规范写明
   *    **此后所有 DMI 操作都不会被处理，直到写 `dtmcs.dmireset`**（sticky，自愈不了）。
   *    我们原来只对 BUSY(1) 重试，遇到 op=3 直接抛错 → 整轮烧录中止（第一段已经写着"校验 OK"了）。
   *    OpenOCD 处理这条（它的 dmi 层会看 dtmcs），我们照做：
   *      装 IR=DTMCS → 写 bit16（dmireset）→ 装回 IR=DMI → 投两条 NOP 排空流水线。
   *    写 dmireset 只清错误态、不动 DM 里的任何状态，所以**重试是安全的**。
   */
  async dmiReset(){
    this.dmiResets = (this.dmiResets || 0) + 1;
    await this.sequences(tapLoadIR(IR_DTMCS));
    await this._scanDR(DR_DTMCS_BITS, 1n << 16n);        // bit16 = dmireset（写 1 清 sticky 错误 + 复位 DMI 状态机）
    await this.sequences(tapLoadIR(IR_DMI));
    await this.dmiPost(DMI_OP.NOP, 0, 0);                // 排空一拍，丢掉复位前那条挂起的响应
    this.log(` DTM 的 DMI 进了错误态（op=3）→ 写 dmireset 清掉，第 ${this.dmiResets} 次`);
  }

  /**
   * 同步 DMI 读（两次扫描；DM busy 时重试）。
   * 🚨 整个重试循环有**墙钟上限**（默认 5 s）：探针固件在"目标总线被卡住的 SBA 读"之后
   *    可能连 DMI 都不应答，没有上限的话这里会一轮轮重试到几分钟，界面看着就是"卡死"
   *    （2026-10 真机踩到：SBA 读一个外设寄存器 → 之后整条链路都在等超时）。
   */
  async dmiRead(addr, timeoutMs = 5000){
    const t0 = Date.now();
    for (let i = 0; i < 8; i++){
      await this.dmiPost(DMI_OP.READ, addr, 0);          // 冲掉上一条挂起的响应
      const r = await this.dmiPost(DMI_OP.NOP, 0, 0);    // 这条才是读的结果
      if (r.op === DMI_STATUS.SUCCESS) return r.data;
      /**
       * 🚨 `op=3` = DTM 的 DMI 进了错误态（不是 BUSY、也不是目标回 ERROR）——
       *    规范：此后所有 DMI 操作都不被处理，**必须写 `dtmcs.dmireset` 才能继续**。
       *    这里当场清掉重试（2026-10-01 用户现场：一个 op=3 就把整轮烧录中止了）。
       */
      if (r.op === 3){ await this.dmiReset(); continue; }
      if (r.op !== DMI_STATUS.BUSY) throw new Error(`DMI 读 0x${addr.toString(16)} 失败（op=${r.op}）`);
      if (Date.now() - t0 > timeoutMs){
        throw new Error(`DMI 读 0x${addr.toString(16)} 一直 BUSY（超过 ${timeoutMs} ms）——` +
          ' 目标总线/外设不响应，或 DM 处于复位中');
      }
    }
    throw new Error(`DMI 读 0x${addr.toString(16)} 一直 BUSY`);
  }

  /**
   * 同步 DMI 写（发 + 用一次 NOP 收状态）。
   * 🚨 **BUSY 要重试，不是直接抛**（2026-10 对照 OpenOCD 定因）：DMI 只有一级流水，
   *    上一拍还没处理完时投进来的请求会被 DM 回 BUSY 丢掉 —— OpenOCD 的 `dmi_op` 就是
   *    "BUSY 就重来"，我们原来是直接抛错 → 表现成"烧录偶发失败/卡住"。这里最多重试 4 次。
   */
  async dmiWrite(addr, data){
    for (let attempt = 0; attempt < 6; attempt++){
      await this.dmiPost(DMI_OP.WRITE, addr, data);
      const r = await this.dmiPost(DMI_OP.NOP, 0, 0);
      if (r.op === DMI_STATUS.SUCCESS) return;
      // `op=3` = DTM 的 DMI 进了错误态 → 写 dmireset 清掉重试（见 dmiReset 的注释）
      if (r.op === 3){ await this.dmiReset(); continue; }
      if (r.op !== DMI_STATUS.BUSY) throw new Error(`DMI 写 0x${addr.toString(16)} 失败（op=${r.op}）`);
    }
    throw new Error(`DMI 写 0x${addr.toString(16)} 一直 BUSY（DM 没跟上）`);
  }

  /**
   * **批量 DMI 写** —— 烧录慢的大头就在这里。
   *
   * 老写法每个字 = `dmiWrite` = WRITE 一次扫描 + NOP 一次扫描 = **两次 USB 往返**；
   * 1388 B 的 flashloader 就是 347 个字 ≈ 694 次往返，真机 ~0.3 ms/次也要 0.2 s，
   * 链路稍慢（几十 ms/次）就变成几十秒 —— 用户看到的就是"卡在加载 flashloader"。
   * 对照数据（2026-10 同一块板、同一支探针、同一份 246 KB 镜像）：
   *   OpenOCD 0.12（DMI 压批）**4.9 s / 49 KiB/s**；我们逐字写 **42~78 s**。
   * 这里照 `sbaReadBurst` 的**同一套时序**：`WRITE,NOP,WRITE,NOP,…` 压进**一条**
   * `DAP_JTAG_Sequence`，**每拍都收状态**（DMI 只一级深，丢一拍会静默写错地方）。
   * 任何一拍不是 SUCCESS 就返回 `badAt`，调用方从那一个字起退回逐字慢路径并重对齐地址。
   *
   * 🚨 2026-10 真机补充（同 `sbaReadBurst`）：批内每拍背靠背，DM 有一拍没写完就收到下一次
   *    `sbdata0` 写时会置 `sbbusyerror` —— 而**每拍状态仍报 SUCCESS**，于是写入静默丢失
   *    （flash 烧出来就是坏的）。所以批尾补一拍 `READ sbcs`（同一扫描，不额外花 USB 命令）。
   *
   * @returns {{ok:boolean, badAt:number, op?:number, sbcs:number|null}} badAt=-1 表示全成功
   */
  async dmiWriteBurst(words){
    const reqs = [];
    for (const w of words){
      reqs.push(dmiRequest(DMI_OP.WRITE, DM.SBDATA0, w >>> 0));
      reqs.push(dmiRequest(DMI_OP.NOP, 0, 0));
    }
    reqs.push(dmiRequest(DMI_OP.READ, DM.SBCS, 0));      // 批尾自检
    reqs.push(dmiRequest(DMI_OP.NOP, 0, 0));
    const resps = await this._scanDRMany(reqs, { idle: SB_BEAT_IDLE });
    const sbcs = dmiResponse(resps[words.length * 2 + 1]).data >>> 0;
    for (let i = 0; i < words.length; i++){
      const r = dmiResponse(resps[i * 2 + 1]);            // 第 i 个写的结果紧跟它的那一拍
      if (r.op !== DMI_STATUS.SUCCESS) return { ok: false, badAt: i, op: r.op, sbcs };
    }
    // 攒下 sbcs 错误位 ⇒ 这一批不能算数（哪一拍超速未知，整批重写）
    if (sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)) return { ok: false, badAt: 0, sbcs };
    return { ok: true, badAt: -1, sbcs };
  }

  // ---------------------------------------------------------------- 目标控制
  /** 让 DM 上线（dmactive=1）并选 hart 0 */
  async activate(hart = 0){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart));
    const st = await this.dmiRead(DM.DMSTATUS);
    return st;
  }

  /**
   * 让 hart 停下来：**只写 haltreq**（与 OpenOCD 一致，2026-10 真机标定过）。
   *
   * 🚨 曾经的错误做法：`dmactive|ndmreset|haltreq` → 松 ndmreset（"reset halt"那套）。
   *    那个写法**会顺手把整个 SoC 复位一次**，核被停在 boot ROM 的复位向量上；
   *    之后如果 pc 又没写对（见 REGNO.PC 那个坑），核就从 ROM 一路跑回应用固件，
   *    现象是"算法永远不结束"。真机标定结果：**plain haltreq 完全够用**，
   *    dmstatus 的 [9:8]（halted）会立刻置起、[11:10]（running）清零。
   *    只有在 haltreq 真的停不住时才退回 reset-halt（少数 DM 需要），见 `_haltByReset()`。
   */
  async halt(hart = 0, timeoutMs = 3000){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    try {
      return await this.waitHalted(timeoutMs);
    } catch (e){
      this.log(` haltreq 没能停住核（${e.message}）→ 退回 reset-halt`);
      return await this._haltByReset(hart, timeoutMs);
    }
  }

  /** reset-halt（兜底）：ndmreset 拉高带 haltreq → 松开 ndmreset（haltreq 保持）*/
  async _haltByReset(hart = 0, timeoutMs = 3000){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.ndmreset | DMCONTROL.haltreq));
    await new Promise(r => setTimeout(r, 50));
    // 🚨 放开 ndmreset 这一步**必须执行**（卡住就把整芯片按在复位态，见 resetHalt() 的注释）
    try {
      await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    } catch (e){
      throw new Error(`ndmreset 没能放开（${e.message}）——目标可能停在复位态：` +
        '把探针 USB 和板子电源一起拔掉 10 秒再插');
    }
    /**
     * 🚨 **放开之后要复验**（2026-10 压测现场）：写成功 ≠ 落地。这一笔要是被链路抖掉，
     *    ndmreset 就是"电平式按住不放" —— 整芯片停在复位态，DMI 从此读回常量、
     *    应用不启动，只能**连探针 USB 一起拔**才能 POR 回来（只拔板子电源不算）。
     *    所以这里回读 dmcontrol 确认 ndmreset 位已经清掉，没清掉就再放几次。
     */
    for (let i = 0; i < 3; i++){
      let dmc = null;
      try { dmc = (await this.dmiRead(DM.DMCONTROL)) >>> 0; } catch { dmc = null; }
      if (dmc != null && !(dmc & (DMCONTROL.ndmreset >>> 0))){
        if (i) this.log(` ndmreset 复验通过（第 ${i + 1} 次写入才落地）`);
        break;
      }
      this.log(` ⚠ dmcontrol 回读 0x${(dmc ?? 0).toString(16)}：ndmreset 还没放开，再写一次`);
      try { await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq)); }
      catch { /* 下一次回读会再判断 */ }
      await new Promise(r => setTimeout(r, 20));
    }
    return await this.waitHalted(timeoutMs);
  }

  /**
   * **进 flash 流程前把 SoC 复位并把核停在复位向量**（ndmreset + 保持 haltreq）。
   *
   * 🚨 2026-10 LA 对照 OpenOCD + 真机 A/B 定因（**别删这一条**）：
   *   HPM6800EVK 上跑着 `flash_sdram_xip` 的应用时，**应用已经把 XPI/flash 控制器配过一遍**
   *   （它自己要 XIP 执行）。我们在这种"已被应用配过"的 XPI 上跑 `flash_init`（ROM 的 auto_config
   *   重配一遍）之后，**第一次写类操作（erase）会把核楔死在一条永不完成的 XPI 事务上**：
   *   `dmstatus` 恒 running、haltreq 都停不住、抽象命令 cmderr=4，要 ndmreset 才能解 ——
   *   历史日志里"第一次 erase 必卡 60s、重试就过"就是它。
   *
   *   实测对照（同参数 erase 8192 B）：
   *     · 直接 setup→erase                     ：卡 >60 s（靠 withAlgoRetry 自愈）
   *     · 先 reset-**run**（复位后应用立刻重启并重配 XPI）→ setup→erase ：仍然卡
   *     · 先 reset-**halt**（核停在复位向量，应用没机会重配 XPI）→ setup→erase ：**118 ms 通过**
   *   ⇒ 所以这里用 reset-halt（**不是** reset-run）。
   */
  async resetHalt(hart = 0, timeoutMs = 5000){
    /**
     * 🚨 **`ndmreset` 一定要放开**（2026-10 现场血案）：它是电平式的，"按住不放就整芯片停在复位态"
     *    （`PPOR_RESET_HOLD` 的 bit4 = debug reset 默认是置起的）。而放开它只能由 DM 写寄存器 ——
     *    万一这里在"已拉高、还没放开"之间抛错（USB 掉线、页面被关、探针被抢），目标就**锁死**：
     *      · TAP 还能读 IDCODE（那靠探针的 TCK 驱动），
     *      · 但 DMI 全部读回同一个常量、写不落地 → haltreq 无效、reset-halt 也停不住；
     *      · 板子不启动（应用被按在复位态）。
     *    **唯一出路是整板 POR —— 而且必须连探针 USB 一起拔**（探针的 5V 还在给板子供电时，
     *    只拔板子电源不算 POR，解不开）。所以这里用 try/finally：**无论中间出什么事，都要把复位放开**。
     */
    let released = false;
    try {
      await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.ndmreset | DMCONTROL.haltreq));
      await new Promise(r => setTimeout(r, 50));
    } finally {
      try {
        await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
        released = true;
      } catch { /* 放开失败：调用方会在后续读里报错；提示见 init() 的 IDCODE 文案 */ }
    }
    if (!released) throw new Error('ndmreset 没能放开（探针↔目标链路断了？）——' +
      '这时目标可能停在复位态，要把探针 USB 和板子电源一起拔掉 10 秒再插才能解');
    try {
      await this.waitHalted(timeoutMs);
    } catch {
      // 停不住就退回普通 halt（至少别把流程卡死；真正的失败让后面的调用去报）
      await this.halt(hart, timeoutMs).catch(() => {});
    }
  }

  /** dmcontrol 的公共位：dmactive + hartsel(h) */
  _ctl(hart, extra = 0){
    return ((DMCONTROL.dmactive | DMCONTROL.hartsel(hart) | extra) >>> 0);
  }

  /**
   * 等核停下来 —— **只轮询，不写 haltreq**。
   * 🚨 烧录算法就是靠"跑完最后一条 ebreak 自然停住"来交差的：这里要是再写一次 haltreq，
   *    会把还在擦/写的算法当场打断，返回码变成垃圾（而界面会显示"成功"或莫名其妙的错误）。
   */
  async waitHalted(timeoutMs = 20000){
    const mask = DMSTATUS.haltedMask(this.dmLayout);
    const t0 = Date.now();
    for (;;){
      const st = await this.dmiRead(DM.DMSTATUS);
      if (st & mask) return true;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等目标 halt 超时（${timeoutMs} ms，dmstatus=0x${st.toString(16)}）`);
    }
  }

  /** 系统复位后运行（烧完让固件自己跑起来）：ndmreset 脉冲 + 不置 haltreq */
  async resetRun(hart = 0){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.ndmreset));
    await new Promise(r => setTimeout(r, 50));
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart));
    await new Promise(r => setTimeout(r, 10));
  }

  /**
   * 实测这台 DM 用哪套 dmstatus 布局（halted 在 [9:8] 还是 [25:24]）。
   * 做法：写一次 haltreq（**不复位**），再看两套布局里哪一对 halted 位被置起来。
   * 真机标定结果（HPM6800EVK, 2026-10）：[9:8] → legacy（0.11 时代排法）。
   */
  async detectLayout(hart = 0){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    const legacyMask = DMSTATUS_LAYOUT.legacy.allhalted | DMSTATUS_LAYOUT.legacy.anyhalted;
    const specMask = DMSTATUS_LAYOUT.spec.allhalted | DMSTATUS_LAYOUT.spec.anyhalted;
    let v = 0;
    for (let i = 0; i < 20; i++){
      v = await this.dmiRead(DM.DMSTATUS);
      if (v & (legacyMask | specMask)) break;
      await new Promise(r => setTimeout(r, 25));
    }
    // 两套布局的 halted 位互不相同：哪一对置起就用哪套（都没置起就按实测的 legacy 来）
    this.dmLayout = (v & legacyMask) ? 'legacy' : (v & specMask) ? 'spec' : 'legacy';
    this.lastDmstatus = v >>> 0;
    this.log(` dmstatus=0x${(v >>> 0).toString(16)} → 用 ${this.dmLayout} 布局判 halt` +
      (this.dmLayout === 'legacy' ? '（halted 在 bit8/9，与 HPM 实测一致）' : '（halted 在 bit24/25，规范布局）'));
    return this.dmLayout;
  }

  /** 让目标跑起来（resumereq），可选先写 pc */
  async resume(pc = null, hart = 0){
    if (pc != null) await this.writeReg(REGNO.PC, pc >>> 0);
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.resumereq));
  }

  /**
   * 跑算法前的准备（**两步都不能省**，都是照 OpenOCD 的 `riscv_run_algorithm` 来的）：
   *   ① `dcsr |= ebreak*`：让算法末尾那条 `ebreak` **进调试模式**而不是触发断点异常。
   *      不置的话核会跳进异常向量乱跑，dmstatus 永远 running；
   *   ② `fence.i`：算法是刚从 SBA 写进 SRAM 的，核的指令预取/缓存里可能是旧内容。
   *      这段 fence 走 **progbuf**（抽象命令 postexec）执行 —— 不能在 SRAM 里跑，
   *      因为"要刷缓存的那段代码"本身就在那儿（鸡生蛋问题）。
   */
  async prepareRun(){
    const dcsr = (await this.readReg(REGNO.DCSR)) >>> 0;
    const want = (dcsr | DCSR_EBREAK.m | DCSR_EBREAK.s | DCSR_EBREAK.u) >>> 0;
    if (want !== dcsr){
      await this.writeReg(REGNO.DCSR, want);
      this.log(` dcsr: 0x${dcsr.toString(16)} → 0x${want.toString(16)}（置 ebreak*，算法收尾的 ebreak 才会停住核）`);
    } else {
      this.log(` dcsr = 0x${dcsr.toString(16)}（ebreak* 已置）`);
    }
    await this.execProgbuf(PROGBUF_FENCE);
    this.log(' 已 fence.i（progbuf 执行，刷指令预取）');
  }

  /**
   * 用 **progbuf** 跑一小段程序（抽象命令 postexec）。程序必须以 `ebreak` 收尾（规范要求）。
   * 这是唯一能在"不执行目标内存里的代码"的前提下让核干点事的手段，用来刷缓存/探 CSR。
   */
  async execProgbuf(words){
    if (!words.length) throw new Error('progbuf 程序不能为空');
    for (let i = 0; i < words.length; i++) await this.dmiWrite(DM.PROGBUF0 + i, words[i] >>> 0);
    const { command } = abstractCommand({ regno: 0x1000, transfer: false, postexec: true, aarsize: 2 });
    await this.dmiWrite(DM.COMMAND, command);
    await this._waitAbstract(3000);
  }

  /** 读一个 hart 寄存器（x0..x31 = 0x1000+n、dpc = 0x7b1）*/
  async readReg(regno){
    return this._abstractRetry(async () => {
      const { command } = abstractCommand({ regno, write: false, aarsize: 2 });
      await this.dmiWrite(DM.COMMAND, command);
      await this._waitAbstract();
      return await this.dmiRead(DM.DATA0);          // 通用寄存器、dpc、CSR 都从 data0 取
    }, `读寄存器 0x${regno.toString(16)}`);
  }

  /** 写一个 hart 寄存器；返回写下去的 32 位值 */
  async writeReg(regno, value){
    await this._abstractRetry(async () => {
      await this.dmiWrite(DM.DATA0, value >>> 0);
      const { command } = abstractCommand({ regno, write: true, aarsize: 2 });
      await this.dmiWrite(DM.COMMAND, command);
      await this._waitAbstract();
    }, `写寄存器 0x${regno.toString(16)}`);
    return value >>> 0;
  }

  /**
   * 🚨 `abstractcs.cmderr` 是**写 1 才清**的 sticky 位（规范 §3.14）：一条抽象命令失败之后，
   *    **之后每一条抽象命令都会立刻报同一个 cmderr** —— 真机现场（2026-10，make full_flow_6800evk）：
   *    编 4 个断点的过程中有一条失败 → 紧跟着读 PC（`cont()` 的第一步）就报
   *    `抽象命令出错（cmderr=3，abstractcs=0x220305）`，整个 RISC-V 调试压力套件当场中断，
   *    而"真凶"那条早就不见了。这里统一兜住：失败 → 清 cmderr（写 0x700）→ 重试一次，
   *    仍然失败才把错误抛出去（重试对读/写/幂等的 progbuf 都是安全的）。
   */
  async _abstractRetry(fn, what){
    try { return await fn(); }
    catch (e){
      if (!/cmderr|抽象命令/.test(e?.message || '')) throw e;
      try { await this.dmiWrite(DM.ABSTRACTCS, 0x700); } catch {}
      this.log(`抽象命令失败（${what}）：${e.message} → 清 cmderr 后重试一次`);
      return await fn();
    }
  }

  async _waitAbstract(timeoutMs = 2000){
    const t0 = Date.now();
    for (;;){
      const cs = await this.dmiRead(DM.ABSTRACTCS);
      if (!(cs & ABSTRACTCS.busy)){
        const err = ABSTRACTCS.cmderr(cs);
        if (err) throw new Error(`抽象命令出错（cmderr=${err}，abstractcs=0x${cs.toString(16)}）`);
        return cs;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error('抽象命令一直 busy');
    }
  }

  // ---------------------------------------------------------------- SBA（系统总线）
  async sbaConfig(extra = sbcsBlock()){
    if (this.sbaFailed){ await this.sbaClearErrors(); this.sbaFailed = false; }
    if (this._sbcsCfg === extra) return;
    await this.dmiWrite(DM.SBCS, extra >>> 0);
    this._sbcsCfg = extra >>> 0;
    this.lastSbcs = extra >>> 0;
  }

  /**
   * sberror/sbbusyerror 是**写 1 清零**（固件里踩过"写 0 等于没做"）。
   *
   * 🚨 2026-10 真机补充：**在飞的事务没落定时写进去的清位会被丢掉** —— 坏事务随后完成，
   *    又会把 `sberror` 立起来，于是"读一次没映射的地址 → 之后每一次内存读都失败"。
   *    所以这里先等 `sbbusy` 落（有界），清完**再读回来复验**，还挂着就再清一次。
   */
  async sbaClearErrors(){
    for (let i = 0; i < 25; i++){
      const s = await this.dmiRead(DM.SBCS).catch(() => null);
      if (s === null) return;
      this.lastSbcs = s;
      if (!(s & SBCS.SBBUSY)) break;
      await new Promise(r => setTimeout(r, 2));
    }
    const sbcs = await this.dmiRead(DM.SBCS);
    this.lastSbcs = sbcs;
    if (sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
      await this.dmiWrite(DM.SBCS, (sbcs | SBCS.SBBUSYERROR | SBCS.SBERROR) >>> 0);
      const back = await this.dmiRead(DM.SBCS).catch(() => null);      // 复验：粘滞位没清掉的话后面每次读都会失败
      if (back !== null){
        this.lastSbcs = back;
        if (back & (SBCS.SBBUSYERROR | SBCS.SBERROR))
          await this.dmiWrite(DM.SBCS, (back | SBCS.SBBUSYERROR | SBCS.SBERROR) >>> 0);
      }
    }
    this._sbcsCfg = null;                 // 清错之后配置要重写
  }

  /**
   * 单次 DMI 扫描的往返耗时（ms）—— 判"探针链路是不是退化了"。
   *
   * 正常这台探针一次扫描 ~0.3 ms（12 次 < 5 ms）。退化时（USB vendor 接口半死）实测每次
   * 几十毫秒甚至超时：表现就是**烧录卡在"加载 flashloader"一动不动**（1388 B 要写 347 个字，
   * 每个字一次往返 —— 0.3 ms/次是 0.1 s，30 ms/次就是 10 s+，还会一路慢下去）。
   */
  async dmiSpeedProbe(n = 12){
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < n; i++) await this.dmiPost(DMI_OP.NOP, 0, 0);
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return (t1 - t0) / n;
  }

  /**
   * **SBA 健康自检 + 分级自愈** —— 每次"要用 SBA 干正事"（烧录、读 RTT）之前先跑一遍。
   *
   * 2026-10 HPM6800EVK 真机定因：上一次会话（或上一次失败的读）会在系统总线上留下
   * **永远不完成的事务**，此后：
   *   · `sbcs` 里 `sbbusy`(bit21) 常驻、`sbbusyerror`(bit22)/`sberror`([14:12]) 挂着；
   *   · **任何** SBA 访问都失败 —— 烧录的表现是 `SBA 写 0x0 出错`，重试三次也过不去；
   *     读 RTT 的表现是"控制块读回全 0 / 找不到控制块"，用户看到的就是"网页总是卡住"。
   * 分级自愈（从轻到重）：
   *   ① `sbaClearErrors()` —— 能清掉"写 1 清零"的那几个位；
   *   ② DM 复位（`dmcontrol` 写 0 再写 1，即 `init()`）—— 中止挂起操作；
   *   ③ **系统复位（ndmreset）** —— 实测**只有这一级能解开"总线事务卡死"**（`init()` 解不开）。
   * 另外顺带量一次**链路速度**（`msPerScan`）：慢到离谱时要让调用方先重开 USB 会话，
   * 否则后面擦/写/校验会一路卡（2026-10 用户现场"点烧录卡在加载 flashloader"就是这么来的）。
   *
   * @returns {Promise<{ok:boolean, before:number|null, after:number|null, level:string, note:string,
   *                    msPerScan?:number, slow?:boolean}>}
   */
  async sbaHealthCheck({ peekAddr = 0x01200000, perWordMs = 800, allowSystemReset = true, slowMs = 5 } = {}){
    const readSbcs = async () => { try { return (await this.dmiRead(DM.SBCS)) >>> 0; } catch { return null; } };
    /** 脏判据：busy 挂着、或 busyerror/sberror 非 0 */
    const dirty = s => s == null || (s & SBCS.SBBUSY) !== 0 || (s & (SBCS.SBBUSYERROR | SBCS.SBERROR)) !== 0;
    /** 真做一次短超时的 SBA 读 —— sbcs 干净也可能"读一下就卡" */
    const peek = async () => { try { await this.readMem(peekAddr, 4, perWordMs); return true; } catch { return false; } };

    /** 顺带量一次链路速度：慢到离谱时调用方要先重开 USB 会话，否则后面会一路卡住 */
    const msPerScan = await this.dmiSpeedProbe(12).catch(() => NaN);
    const slow = Number.isFinite(msPerScan) && msPerScan > slowMs;
    const spd = Number.isFinite(msPerScan) ? `${msPerScan.toFixed(2)} ms/扫描${slow ? ' ⚠ 偏慢（正常 ~0.3）' : ''}` : '速度测不出';
    const R = o => ({ msPerScan: Number.isFinite(msPerScan) ? +msPerScan.toFixed(3) : undefined, slow, ...o });

    const before = await readSbcs();
    if (!dirty(before) && await peek()){
      return R({ ok: true, before, after: before, level: 'none', note: `SBA 干净（${spd}）` });
    }

    // ① 清错误位
    try { await this.sbaClearErrors(); } catch {}
    let after = await readSbcs();
    if (!dirty(after) && await peek()){
      return R({ ok: true, before, after, level: 'clear', note: `清掉 sberror/sbbusyerror 后恢复（${spd}）` });
    }

    // ② DM 复位（dmcontrol 0 → 1）
    this.log('SBA 不健康 → 复位调试模块（dmcontrol 0→1）');
    try { await this.dmiWrite(DM.DMCONTROL, 0); await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive); } catch {}
    after = await readSbcs();
    if (!dirty(after) && await peek()){
      return R({ ok: true, before, after, level: 'dm', note: `DM 复位后恢复（${spd}）` });
    }

    // ③ 系统复位（ndmreset）—— 最后手段，会把目标重启一次
    if (allowSystemReset){
      this.log('SBA 仍不健康 → 系统复位（ndmreset）自愈');
      try { await this.resetRun(); await new Promise(r => setTimeout(r, 1500)); } catch {}
      try { await this.dmiWrite(DM.DMCONTROL, 0); await this.dmiWrite(DM.DMCONTROL, DMCONTROL.dmactive); } catch {}
      after = await readSbcs();
      if (!dirty(after) && await peek()){
        return R({ ok: true, before, after, level: 'ndmreset', note: `系统复位（ndmreset）后恢复（${spd}）` });
      }
    }
    return R({ ok: false, before, after, level: 'failed', note: '清错误位 / DM 复位 / ndmreset 都没救回来（多半是接线或目标供电）' });
  }


  /**
   * 一条 USB 命令里塞多拍 DMI 扫描，返回**每条扫描**移出的位（BigInt，低位先出）。
   *
   * 为什么要这个：每拍扫描都是一次 USB 往返（实测 ~0.28 ms），而一次 CMSIS-DAP 的
   * `DAP_JTAG_Sequence` 本来就能装几十拍 —— 逐拍发等于把 USB 延迟乘以拍数。
   * 真机实测（HPM6800EVK）：逐字读 5.7 KB/s，与 TCK 1 MHz 还是 60 MHz 无关 → 瓶颈全在 USB。
   */
  async _scanDRMany(requests, { idle = this.idle } = {}){
    const groups = [];
    const all = [];
    for (const rq of requests){
      const seqs = drScan(DR_DMI_BITS, rq, { idle });
      groups.push({ from: all.length, n: seqs.length });
      for (const s of seqs) all.push(s);
    }
    const caps = await this.sequences(all);
    const out = [];
    let ci = 0;
    for (const g of groups){
      let v = 0n, bit = 0;
      for (let k = 0; k < g.n && bit < DR_DMI_BITS; k++){
        const s = all[g.from + k];
        if (!s.captureBytes) continue;
        const bytes = caps[ci++];
        const clocks = s.clocks >= 64 ? 64 : s.clocks;
        for (let i = 0; i < clocks && bit < DR_DMI_BITS; i++, bit++){
          if ((bytes[i >> 3] >> (i & 7)) & 1) v |= (1n << BigInt(bit));
        }
      }
      out.push(v);
      this.scans++;
    }
    return out;
  }

  /**
   * 一批 SBA 读：`READ, NOP, READ, NOP, …`（**每拍都收状态**，不是"投一批再收"）。
   *
   * 🚨 为什么不是"READ×N 再收 N 拍"（看着更省）：本文件 `writeMem` 的注释里记着那次教训 ——
   *    DMI 流水线只有一级深，前一条没处理完时投进去的请求会被 DM 回 BSY 并**丢掉**。
   *    读路径虽然丢的是"没读成"而不是"写错地方"，但一旦丢一拍，后面所有字都会**整体错位一个**
   *    （自增是硬件推进的）—— 这种静默错位比慢一点坏得多。所以这里严格照已验证过的逐字时序
   *    （READ 之后必有 NOP 收状态），只是把它们压进**同一条** DAP 命令里省 USB 往返。
   *    任何一拍不是 SUCCESS 就返回 `badAt`，调用方从那里起退回逐字慢路径（并把地址写回去对齐）。
   *
   * @returns {{words:Uint32Array, ok:boolean, badAt:number}} badAt=-1 表示全成功
   */
  /**
   * 一批读：把 count 个字的 `sbdata0` 读压进**一条** `DAP_JTAG_Sequence`。
   *
   * 🚨 2026-10 真机定因（用户现场：往监视里加一个**结构体**变量 → 复位并停就报
   *    `读 0x4000b600（60 B）失败：SBA 读 0x4000b638 出错（sbcs=0x20758407）`，
   *    而且从此**所有内存读全废**）：
   *      60 B = 15 字 = 一批 13 字 + 一批 2 字；批内每拍是**背靠背**发出的，DM 只要有一拍
   *      还没来得及读完就收到下一次 `sbdata0` 访问，就会置 **`sbbusyerror`** —— 而
   *      **每一拍的 DMI 状态仍然报 SUCCESS**，所以只看拍状态根本发现不了，那一批的数据
   *      也就不可信（可能读到上一笔的残值）。目标在跑、总线被抢时更容易踩中。
   *
   *    所以批尾在**同一条扫描**里补一拍 `READ sbcs`：校验成本 0 条额外 USB 命令（只多 2 拍
   *    JTAG），但每一批都能当场判定"这批到底算不算数"，`ok=false` 时调用方清错误位并按字重读。
   *
   * @returns {{words:Uint32Array, ok:boolean, badAt:number, sbcs:number|null}}
   *          ok=false 且 badAt=0 ⇒ 这批攒下了 sbcs 错误位，整批不可信
   */
  async sbaReadBurst(count, perWordMs = 2000){
    const reqs = [];
    for (let i = 0; i < count; i++){
      reqs.push(dmiRequest(DMI_OP.READ, DM.SBDATA0, 0));
      reqs.push(dmiRequest(DMI_OP.NOP, 0, 0));
    }
    reqs.push(dmiRequest(DMI_OP.READ, DM.SBCS, 0));      // 批尾自检
    reqs.push(dmiRequest(DMI_OP.NOP, 0, 0));
    const resps = await this._scanDRMany(reqs, { idle: SB_BEAT_IDLE });
    const sbcs = dmiResponse(resps[count * 2 + 1]).data >>> 0;
    const words = new Uint32Array(count);
    for (let i = 0; i < count; i++){
      const r = dmiResponse(resps[i * 2 + 1]);          // 第 i 个字的结果紧跟它的那一拍
      if (r.op !== DMI_STATUS.SUCCESS) return { words, ok: false, badAt: i, sbcs };
      words[i] = r.data >>> 0;
    }
    if (sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)) return { words, ok: false, badAt: 0, sbcs };
    return { words, ok: true, badAt: -1, sbcs };
  }

  /**
   * 一批能塞几个字？按 CMSIS-DAP 包长算：每拍请求 18 B（TDI 11 + 序列头 7）、响应 6 B，
   * 一个字 = READ/NOP 或 WRITE/NOP 两拍。留点余量（命令字节 + 固件自己的开销）。
   *
   * 🚨 2026-10 逐档实测的**命令长度天花板**（同一支 akaLinkPro 探针）：
   *    请求 577 B（16 字/批）正常；**721 B（20 字）起响应恒少 222 B**、973 B 更乱。
   *    探针固件 `DAP_XFER_SIZE` 明明是 1024 且 `DAP.c` 没有任何条数上限 —— 所以问题在
   *    USB 多包收发那一层（待单独攻）。在那之前**按 512 B 端点包长算批次**，不赌。
   *    上限 64 只是兜底（真接上支持大包的目标时别再被写死的 12 卡住）。
   */
  _burstWords(){
    const pkt = Math.min(this.dap?.probe?.pkt || this.dap?.pkt || 512, 512);
    /**
     * 每拍请求 18 B（TDI 11 + 序列头 7）；`SB_BEAT_IDLE` 那条空转序列按 clocks/8 字节算
     * （idle=8 的 1 B 已经含在 18 里，所以只加**多出来**的部分）。一个字 = 2 拍。
     * 实测对照（hpm-flash.test 会把上限钉住）：idle=8、13 字批 = 492 B；
     * idle=64、13 字批 = 701 B（每拍 +7 B）⇒ 现在一批 9 字 = 475 B。
     */
    const perBeat = 18 + Math.max(0, Math.ceil(Math.min(64, SB_BEAT_IDLE) / 8) - 1);
    const byReq = Math.floor((pkt - 24) / perBeat / 2);
    const byResp = Math.floor((pkt - 8) / 6 / 2);
    return Math.max(2, Math.min(64, byReq, byResp));
  }

  /** 查一次 sbcs：攒着的总线错误要当场报出来，别让它变成后一段的错位读 */
  async _checkSbcsAt(here, perWordMs){
    this.lastSbcs = await this.dmiRead(DM.SBCS, perWordMs);
    if (this.lastSbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
      this.sbaFailed = true;
      throw new Error(`SBA 读 0x${(here >>> 0).toString(16)} 出错（sbcs=0x${this.lastSbcs.toString(16)}）——`
        + ' 这一笔总线访问没有干净完成；若之后每次读内存都失败，请「断开」重连（或给板子断电重上电）恢复。');
    }
    if (this.lastSbcs & SBCS.SBBUSY){
      /**
       * 这颗 DM 的 `sbbusy` 会在"刚发过访问"的窗口里短暂置起（实测：读内存明明成功，紧接着
       * 单读一次 sbcs 也是这个位亮着），所以先给它几毫秒自己落，别急着宣判"卡死"。
       * 真的不落才算故障 —— 那种情况会把后面**所有**内存读带走，必须给用户一条能走的恢复路径。
       */
      for (let i = 0; i < 8; i++){
        await new Promise(r => setTimeout(r, 2));
        this.lastSbcs = await this.dmiRead(DM.SBCS, perWordMs);
        if (!(this.lastSbcs & SBCS.SBBUSY)) return;
      }
      this.sbaFailed = true;
      throw new Error(`SBA 读 0x${(here >>> 0).toString(16)} 时 sbbusy 一直不落 —— 总线事务没完成`
        + '（地址没映射 / 外设没时钟）。它会让之后所有内存读都失败：请「断开」重连或给板子断电重上电恢复。');
    }
  }

  /**
   * 块读：addr 可以不对齐；返回 length 字节。
   *
   * 🚨 出错信息要给得"能直接定位"（2026-10 真机教训）：SBA 去读一个**没映射/没时钟**的
   *    外设窗口时，总线事务可能永远不完成 —— 此时 `sbdata0` 读不出来、`sbbusy` 也一直不落。
   *    这里对每个字都给了上限，并且明确告诉用户"这个地址不对/外设没时钟"，而不是干等。
   *    （SBA 只适合 RAM/已配好的 flash 窗口；片内外设一律走算法/内核去读。）
   */
  async readMem(addr, length, perWordMs = 2000){
    /**
     * 🚨 2026-10 真机定因（HPM6800EVK，稳定复现）：`复位并停`（ndmreset）之后的**第一笔**
     *    SBA 访问会被 DM 判成 `sbbusyerror`（`sbcs` 从干净的 `0x20158407` 变成 `0x20758407`），
     *    于是"复位并停 → 读内存"这一步必错；而 `复位并跑` + 等一会儿再读就正常 —— 说明只是
     *    复位后总线还没落定，既不是地址错也不是数据错。
     *
     *    这类位是**写 1 清零的记账位**：清掉再读一次通常就干净了。直接抛给用户，他看到的就是
     *    "复位并停之后就报读失败"。所以这里只对这类错误清位重试一次；重试仍带同样的错才认输
     *    （真·地址不通时两次都会失败，由上层记冷却并如实报错）。
     */
    try {
      return await this._readMemOnce(addr, length, perWordMs);
    } catch (e){
      if (!/sbcs|总线访问没有干净完成|sbbusy/.test(String(e?.message || ''))) throw e;
      await this.sbaClearErrors().catch(() => {});
      return await this._readMemOnce(addr, length, perWordMs);
    }
  }

  async _readMemOnce(addr, length, perWordMs = 2000){
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xffffffff ||
        !Number.isInteger(length) || length < 0 || addr + length > 0x100000000)
      throw new Error('SBA 地址或长度超出 32 位地址空间');
    if (!length) return new Uint8Array(0);
    // SBA reads full words, including the bytes before/after an unaligned request.
    // Fence the entire native span before issuing any DMI command.
    const nativeStart = Math.floor(addr / 4) * 4;
    const nativeEnd = Math.ceil((addr + length) / 4) * 4;
    if (nativeStart < 0x90000000 && nativeEnd > 0x80000000){
      throw new Error('读取范围覆盖 XIP/flash 窗口：拒绝 SBA 访问；请使用已载入 ELF 的只读镜像');
    }
    const out = new Uint8Array(length);
    const start = nativeStart;
    const first = (addr >>> 0) - start;                 // 头部补齐
    const words = Math.ceil((first + length) / 4);
    await this.sbaConfig();
    this._holdAddr = null;
    await this.dmiWrite(DM.SBADDRESS0, start);
    const put = (i, w) => {
      const b = [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff];
      for (let k = 0; k < 4; k++){
        const pos = i * 4 + k - first;
        if (pos >= 0 && pos < length) out[pos] = b[k];
      }
    };

    /**
     * 两条路：
     *   · **批量**（默认）：一批十几个字压进**一条** DAP_JTAG_Sequence 命令；
     *   · **逐字**（保底）：原来看过真机的那套写法 —— 批次出错、或目标就是批不动时退回来。
     *
     * 🚨 批量那条**每拍都验状态**（见 `sbaReadBurst`）：DMI 流水线只有一级深，丢一拍不会报错，
     *    只会让后面所有字**整体错位一个**（自增在硬件里推进）。所以任何一拍不是 SUCCESS，
     *    就从那个字起退回逐字，并且**把 sbaddress0 写回去对齐**（不重写就不知道自增停在哪）。
     *    另外"批不动"不算错误（逐字照样读得全，只是慢）：连撞 3 次就整段不再批。
     */
    const BURST = this._burstWords();
    let i = 0, slowLeft = 0;
    while (i < words){
      const want = Math.min(BURST, words - i);
      if (!this._burstOff && slowLeft <= 0 && want >= 2){
        const b = await this.sbaReadBurst(want, perWordMs);
        /**
         * 批尾自检判定"这批不算数"（`sbbusyerror`/`sberror`）时：**先清掉那个写 1 清零的
         * 粘滞位**，再把地址写回去对齐，这一段整批改按字重读（每个字一次 USB 往返，天然
         * 给总线留了时间）。
         *
         * 🚨 以前这里是直接抛错 —— 抛出去时那一笔事务还挂在总线上，之后**每一次** SBA
         *    访问都失败。用户现场就是"往监视里加了个结构体变量 → 复位并停报错 → 从此全废"。
         *    读内存失败不该把整颗 DM 的内存通路一起带走：能降级就降级，只有物理不通才报错。
         */
        const sbcsBad = typeof b.sbcs === 'number' && (b.sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR));
        if (sbcsBad && !b.ok) await this.sbaClearErrors().catch(() => {});
        const good = b.ok ? want : (sbcsBad ? 0 : Math.max(0, b.badAt));
        for (let k = 0; k < good; k++) put(i + k, b.words[k]);
        i += good;
        if (b.ok){
          /**
           * sbcs 检查**不必每批都做**：查一次 = 两次 DMI 扫描（= 两条 USB 命令），
           * 每批都查会把命令数翻三倍（实测 512 个字 133 条 → 改成每 4 批查一次后 ~50 条）。
           * 批次内部的"每拍验状态"已经能抓住丢拍，这里只是兜底看有没有攒着的总线错误。
           */
          if (i % (BURST * 4) === 0 || i === words) await this._checkSbcsAt(start + (i - 1) * 4, perWordMs);
          continue;
        }
        this._burstMiss++;
        /**
         * 🚨 撞到"超速"（sbbusyerror）就**立刻**关掉批量：这颗 DM 一旦被判超速，它的 SBA
         *    引擎会就此卡住（之后每次内存读都失败）。宁可这一段慢（每字一次 USB 往返），
         *    也不能把链路搞废。拍状态不对（badAt）只是"这批没批动"，容忍 3 次再关。
         */
        if (sbcsBad || this._burstMiss >= 3){
          if (!this._burstOff) this.log('SBA 批量读撞到超速 → 本会话改走逐字慢路径（正确优先）');
          this._burstOff = true;
        }
        await this.dmiWrite(DM.SBADDRESS0, (start + i * 4) >>> 0);
        slowLeft = BURST;
        continue;
      }
      const here = (start + i * 4) >>> 0;
      let w;
      try {
        w = await this.dmiRead(DM.SBDATA0, perWordMs);
      } catch (e){
        this.sbaFailed = true;
        throw new Error(`SBA 读 0x${here.toString(16)} 卡住了（${e.message}）——` +
          ' 这个地址多半没映射，或所在外设的时钟被门控（片内外设请让内核去读）');
      }
      put(i, w);
      i++;
      if (slowLeft > 0) slowLeft--;
      // 逐字路径每 16 个字查一次 sbcs（真机实测：逐字查会把读放大一倍）
      if (slowLeft <= 0 && (i % 16 === 0 || i === words)) await this._checkSbcsAt(here, perWordMs);
    }
    return out;
  }

  /** 块写：addr 必须 4 字节对齐、length 必须是 4 的倍数（flashloader 的 buf 就是这么用的）*/
  async writeMem(addr, bytes){
    if (bytes.length % 4) throw new Error(`SBA 写要求 4 字节对齐（长度 ${bytes.length}）`);
    if ((addr >>> 0) % 4) throw new Error(`SBA 写要求 4 字节对齐（地址 0x${(addr >>> 0).toString(16)}）`);
    // 🚨 写路径的 sbcs **不能带 sbreadonaddr**：否则写地址会先触发一次读、读完自增 4，
    //    第一笔数据就落到 addr+4（真机上表现为"blob 整体错位一个字"，接下去 resume 跑垃圾指令）
    await this.sbaConfig(sbcsWrite());
    this._holdAddr = null;
    await this.dmiWrite(DM.SBADDRESS0, addr >>> 0);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /**
     * 逐字写是**正确但极慢**的老路径（每字两次 USB 往返）—— 真机对照 OpenOCD 慢 10 倍
     * （同一份 246 KB 镜像：OpenOCD 4.9 s，我们 42~78 s），"卡在加载 flashloader"就是这么来的。
     * 现在走 `dmiWriteBurst`：多拍压进一条 `DAP_JTAG_Sequence`，**但仍然是每拍都收状态**
     * （`WRITE,NOP,WRITE,NOP,…`，DMI 只一级深，丢一拍会静默写错地方）。
     * 哪一拍不是 SUCCESS 就从那个字起退回逐字写，并把 `sbaddress0` 写回去对齐自增指针。
     */
    const BURST = this._burstWords();
    let off = 0;
    while (off < bytes.length){
      const nWords = Math.min(BURST, (bytes.length - off) >> 2);
      if (nWords >= 2 && !this._writeBurstOff){
        const words = [];
        for (let k = 0; k < nWords; k++) words.push(dv.getUint32(off + k * 4, true));
        const b = await this.dmiWriteBurst(words);
        if (b.ok){ off += nWords * 4; continue; }
        // 批尾自检发现"这批不算数"：清掉粘滞错误位，整批从 off 起按字重写（badAt=0 已对齐）
        if (typeof b.sbcs === 'number' && (b.sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)))
          await this.sbaClearErrors().catch(() => {});
        this._writeBurstMiss = (this._writeBurstMiss || 0) + 1;
        if ((typeof b.sbcs === 'number' && (b.sbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)) !== 0) || this._writeBurstMiss >= 3){
          this._writeBurstOff = true;
          this.log('DMI 批量写撞到超速/连撞 3 次 → 本段改走逐字慢路径（正确优先）');
        }
        // 自增指针已经推进到出错那一拍：写回地址对齐，再从那里逐字补
        await this.dmiWrite(DM.SBADDRESS0, ((addr >>> 0) + off + b.badAt * 4) >>> 0);
        off += b.badAt * 4;
        continue;
      }
      await this.dmiWrite(DM.SBDATA0, dv.getUint32(off, true));
      off += 4;
    }
    // 收尾：读一次 sbcs 确认没有攒着的错误
    this.lastSbcs = await this.dmiRead(DM.SBCS);
    if (this.lastSbcs & (SBCS.SBBUSYERROR | SBCS.SBERROR)){
      this.sbaFailed = true;
      throw new Error(`SBA 写 0x${(addr >>> 0).toString(16)} 出错（sbcs=0x${this.lastSbcs.toString(16)}）`);
    }
  }

  /**
   * 单字流水读（J-Scope 的单变量快路径同构）：把 SBA 抱在同一个地址上（关自增），
   * 之后每拍只有一次 DMI 扫描；延迟一拍 —— 第一次的结果要丢掉，最后一个值由调用方补收。
   */
  async holdPrepare(addr){
    const a = (addr >>> 0) & ~3;
    if (this._holdAddr === a) return;
    await this.sbaConfig(sbcsHold());
    await this.dmiWrite(DM.SBADDRESS0, a);
    this._holdAddr = a;
    await this.dmiPost(DMI_OP.READ, DM.SBDATA0, 0);      // 投出第一次读（结果下一拍才回来）
    await this.dmiPost(DMI_OP.NOP, 0, 0);                // 丢掉那一次
  }

  async holdRead(){
    const r = await this.dmiPost(DMI_OP.READ, DM.SBDATA0, 0);
    if (r.op !== DMI_STATUS.SUCCESS) return null;
    return r.data;
  }
}
