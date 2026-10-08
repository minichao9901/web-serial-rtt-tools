import { resolveHpmTarget, overlapsSbaFence, assertHpmIdentity } from '../../targets/hpm/porting.js';
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

import { DM, DMI_OP, DMI_STATUS, SBCS, sbcsBlock, sbcsWrite, dmiRequest, dmiResponse,
         tapReset, tapLoadIR, drScan, abstractCommand, ABSTRACTCS, DMSTATUS, DMSTATUS_LAYOUT,
         DMCONTROL, CMDTYPE, REGNO, DCSR_EBREAK, PROGBUF_FENCE } from './jtag.js';

/** IR 值（RISC-V DTM 规范：0x01 = IDCODE、0x10 = DTMCS、0x11 = DMI） */
export const IR_IDCODE = 0x01;
export const IR_DTMCS = 0x10;
export const IR_DMI = 0x11;
/** DR 位宽 */
export const DR_DMI_BITS = 41;
export const DR_DTMCS_BITS = 32;
export const DR_IDCODE_BITS = 32;

// Separate learned delays: DMI acceptance and system-bus completion are different.
const SB_BEAT_IDLE = 64;
const SBA_ERRORS = SBCS.SBBUSYERROR | SBCS.SBERROR;
// Do not start a USB round trip in the final sliver of a logical timeout.
// Even a healthy probe cannot reliably finish OUT + IN in < 1 ms. A bus
// timeout must leave DMI usable; actual in-flight wire timeouts still quarantine.
const MIN_WIRE_BUDGET_MS = 10;
const now = () => globalThis.performance?.now() ?? Date.now();

export class RiscvAccessError extends Error {
  constructor(code, message, details = {}){
    super(message); this.name = 'RiscvAccessError'; this.code = code;
    Object.assign(this, details);
  }
}

export class RiscvTransport {
  /**
   * @param {{jtagSequences:(seqs:Array)=>Promise<Uint8Array[]>, connectJtag?:()=>Promise<void>}} dap
   * @param {{idle?:number, log?:Function, burst?:boolean}} [opts] burst=false 使用逐字路径
   */
  constructor(dap, opts = {}){
    this.dap = dap;
    this.port = resolveHpmTarget(opts.port);
    this.hart = this.port.debug.hart;
    this.idle = opts.idle ?? this.port.debug.idle;              // DTM 要求的 RTI 拍（探针固件默认 8）
    this.log = opts.log || (() => {});
    this.open = false;
    this.lastDtmcs = 0;
    this.lastDmstatus = 0;
    this.lastSbcs = 0;
    this.scans = 0;
    this.sbaFailed = false;
    this._sbcsCfg = null;
    this._burstOff = opts.burst === false;
    this._burstMiss = 0;
    this._writeBurstOff = opts.burst === false;
    this.dmiBusyDelay = 0;
    this.sbaReadDelay = SB_BEAT_IDLE;
    this.sbaWriteDelay = SB_BEAT_IDLE;
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
    this._sbcsCfg = null; this._holdAddr = null; this.sbaFailed = false;
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
    assertHpmIdentity(this.port, { idcode: this.idcode });
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
    await this.dmiWrite(DM.DMCONTROL, this._ctl(this.hart ?? 0));
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
        await this.dmiWrite(DM.DMCONTROL, this._ctl(this.hart ?? 0));
        await new Promise(r => setTimeout(r, 50));
        const st = (await this.dmiRead(DM.DMSTATUS)) >>> 0;
        if (st) return st;
      } catch { /* 继续试 */ }
    }
    try {
      await this.sequences(tapReset());
      assertHpmIdentity(this.port, { idcode: this.idcode });
    await this.sequences(tapLoadIR(IR_DTMCS));
      await this._scanDR(DR_DTMCS_BITS, 1n << 17n);          // bit17 = dmihardreset
      await this.sequences(tapReset());
      await this.sequences(tapLoadIR(IR_DMI));
      await this.dmiPost(DMI_OP.NOP, 0, 0);
      await this.dmiPost(DMI_OP.NOP, 0, 0);
      await this.dmiWrite(DM.DMCONTROL, this._ctl(this.hart ?? 0));
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
  async _scanDR(nbits, tdi, deadline = Infinity, idle = this.idle){
    const seqs = drScan(nbits, tdi, { idle });
    const caps = await this.sequences(seqs, { deadline });
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
  async sequences(seqs, { deadline = Infinity } = {}){
    if (this._wireFault) throw this._wireFault;
    if (this._remaining(deadline) < MIN_WIRE_BUDGET_MS)
      throw new RiscvAccessError('DMI_TIMEOUT', '调试访问时间预算已耗尽；未启动新的 JTAG 传输');
    // A JS timeout cannot cancel a USB transfer. Quarantine this transport so
    // neither cleanup nor a queued operation can start a competing transfer.
    let timer;
    const pending = this.dap.jtagSequences(seqs, { deadline });
    let caps;
    try {
      caps = Number.isFinite(deadline) ? await Promise.race([pending,
        new Promise((_, reject) => { timer = setTimeout(() => {
          this._wireFault = new RiscvAccessError('DMI_TIMEOUT', 'JTAG 传输超时；请断开重连', { uncertain: true });
          reject(this._wireFault);
        }, this._remaining(deadline)); })]) : await pending;
    } catch (e){
      this._wireFault = e; throw e;
    } finally { clearTimeout(timer); }
    if (!caps || caps.length !== seqs.filter(s => s.captureBytes > 0).length){
      // 下层的返回长度必须与"要捕获的序列条数"一致，否则位对齐全错（宁可报错也别继续）
      throw new Error(`JTAG 序列返回条数不对：期望 ${seqs.filter(s => s.captureBytes > 0).length}，实际 ${caps?.length}`);
    }
    return caps;
  }

  /**
   * 发一条 DMI 请求，返回**上一次**请求的响应（流水线语义）*/
  async dmiPost(op, addr = 0, data = 0, deadline = Infinity){
    const bits = await this._scanDR(DR_DMI_BITS, dmiRequest(op, addr, data), deadline,
      this.idle + this.dmiBusyDelay);
    return dmiResponse(bits);
  }

  _remaining(deadline){
    const left = deadline - now();
    if (left <= 0) throw new RiscvAccessError('DMI_TIMEOUT', '调试访问超时；未自动复位目标');
    return left;
  }

  _exclusive(key, fn){
    const pending = (this[key] || Promise.resolve()).then(fn);
    this[key] = pending.catch(() => {});
    return pending;
  }

  _learnDelay(kind){
    const key = kind === 'dmi' ? 'dmiBusyDelay' : kind === 'read' ? 'sbaReadDelay' : 'sbaWriteDelay';
    const old = this[key] || 0;
    // Keep even a single scan inside the 512-byte command limit. When larger
    // bus delays leave no room for a batch, _burstWords selects the slow path.
    this[key] = Math.min(kind === 'dmi' ? 512 : 1024, old + Math.floor(old / 10) + 1);
  }

  async _dmiReset(deadline){
    this.dmiResets = (this.dmiResets || 0) + 1;
    await this.sequences(tapLoadIR(IR_DTMCS), { deadline });
    await this._scanDR(DR_DTMCS_BITS, 1n << 16n, deadline);
    await this.sequences(tapLoadIR(IR_DMI), { deadline });
    await this.dmiPost(DMI_OP.NOP, 0, 0, deadline);
  }

  dmiReset(timeoutMs = 5000){
    const deadline = now() + timeoutMs;
    return this._exclusive('_dmiQueue', () => this._dmiReset(deadline));
  }

  async _dmiOp(op, addr, data, deadline){
    for (let attempt = 0; attempt < 64; attempt++){
      this._remaining(deadline);
      let r = await this.dmiPost(op, addr, data, deadline);
      const requestAccepted = r.op === DMI_STATUS.SUCCESS;
      if (requestAccepted) r = await this.dmiPost(DMI_OP.NOP, 0, 0, deadline);
      if (r.op === DMI_STATUS.SUCCESS) return r.data;
      if (r.op === DMI_STATUS.BUSY || r.op === DMI_STATUS.ERROR){
        if (r.op === DMI_STATUS.BUSY) this._learnDelay('dmi');
        await this._dmiReset(deadline);
        if (r.op === DMI_STATUS.ERROR)
          throw new RiscvAccessError('DMI_FAILED', `DMI 访问 0x${addr.toString(16)} 失败（op=2）`, { addr, op: r.op });
        // These registers can start/consume a bus transfer. An accepted request
        // with a lost result must not be blindly replayed.
        if (requestAccepted && (addr === DM.SBADDRESS0 || addr === DM.SBDATA0))
          throw new RiscvAccessError('DMI_BUSY', `DMI 访问 0x${addr.toString(16)} 完成状态不确定`,
            { addr, op: r.op, uncertain: true });
        continue;
      }
      throw new RiscvAccessError('DMI_INVALID', `DMI 响应使用保留状态（op=${r.op}）`, { addr, op: r.op });
    }
    throw new RiscvAccessError('DMI_TIMEOUT', `DMI 访问 0x${addr.toString(16)} 一直 BUSY`);
  }

  dmiRead(addr, timeoutMs = 5000){
    const deadline = now() + timeoutMs;
    return this._exclusive('_dmiQueue', () => this._dmiOp(DMI_OP.READ, addr, 0, deadline));
  }

  dmiWrite(addr, data, timeoutMs = 5000){
    const deadline = now() + timeoutMs;
    return this._exclusive('_dmiQueue', () => this._dmiOp(DMI_OP.WRITE, addr, data, deadline));
  }

  _busIdle(kind){
    return this.idle + this.dmiBusyDelay + (kind === 'write' ? this.sbaWriteDelay : this.sbaReadDelay);
  }

  _burstWords(kind = 'read'){
    const pkt = Math.min(this.dap?.probe?.pkt || this.dap?.pkt || 512, 512);
    const seqs = drScan(DR_DMI_BITS, 0n, { idle: this._busIdle(kind) });
    const beatBytes = seqs.reduce((n, s) => n + 1 + s.tdi.length, 0);
    const scans = Math.min(Math.floor((pkt - 2) / beatBytes), Math.floor(255 / seqs.length), Math.floor((pkt - 2) / 6));
    return Math.max(1, Math.floor(scans / 2) - 1); // Reserve READ SBCS + NOP.
  }

  async _sbaBurst(values, kind, deadline){
    const count = kind === 'read' ? values : values.length;
    const reqs = [];
    for (let i = 0; i < count; i++){
      reqs.push(dmiRequest(kind === 'read' ? DMI_OP.READ : DMI_OP.WRITE, DM.SBDATA0,
        kind === 'read' ? 0 : values[i]));
      reqs.push(dmiRequest(DMI_OP.NOP, 0, 0));
    }
    reqs.push(dmiRequest(DMI_OP.READ, DM.SBCS, 0), dmiRequest(DMI_OP.NOP, 0, 0));
    return this._exclusive('_dmiQueue', async () => {
      const resps = await this._scanDRMany(reqs, { idle: this._busIdle(kind), deadline });
      const words = new Uint32Array(count);
      // Check every scan, including request-phase and the SBCS response.
      for (let k = 0; k < resps.length; k++){
        const r = dmiResponse(resps[k]);
        if (r.op !== DMI_STATUS.SUCCESS)
          return { words, ok: false, badAt: Math.min(count, Math.floor(k / 2)), op: r.op, sbcs: null };
        if (k < count * 2 && (k & 1)) words[k >> 1] = r.data;
      }
      const sbcs = dmiResponse(resps[count * 2 + 1]).data >>> 0;
      this.lastSbcs = sbcs;
      return { words, ok: !(sbcs & SBA_ERRORS), badAt: (sbcs & SBA_ERRORS) ? 0 : -1, sbcs };
    });
  }

  sbaReadBurst(count, timeoutMs = 2000){ return this._sbaBurst(count, 'read', now() + timeoutMs); }
  dmiWriteBurst(words, timeoutMs = 2000){ return this._sbaBurst(words, 'write', now() + timeoutMs); }

  // ---------------------------------------------------------------- 目标控制
  /** 让 DM 上线（dmactive=1）并选 hart 0 */
  async activate(hart = this.hart ?? 0){
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
  async halt(hart = this.hart ?? 0, timeoutMs = 3000){
    await this.dmiWrite(DM.DMCONTROL, this._ctl(hart, DMCONTROL.haltreq));
    try {
      return await this.waitHalted(timeoutMs);
    } catch (e){
      this.log(` haltreq 没能停住核（${e.message}）→ 退回 reset-halt`);
      return await this._haltByReset(hart, timeoutMs);
    }
  }

  /** reset-halt（兜底）：ndmreset 拉高带 haltreq → 松开 ndmreset（haltreq 保持）*/
  async _haltByReset(hart = this.hart ?? 0, timeoutMs = 3000){
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
  async resetHalt(hart = this.hart ?? 0, timeoutMs = 5000){
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
  async resetRun(hart = this.hart ?? 0){
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
  async detectLayout(hart = this.hart ?? 0){
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
  async resume(pc = null, hart = this.hart ?? 0){
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
  async _waitSba(deadline, addr = 0){
    let polls = 0;
    for (;;) {
      let left;
      try { left = this._remaining(deadline); }
      catch { throw this._sbaError('SBA_TIMEOUT', addr, this.lastSbcs, 'sbbusy 等待超时；请显式复位或断开重连'); }
      let sbcs;
      try { sbcs = (await this.dmiRead(DM.SBCS, left)) >>> 0; }
      catch (e){
        if (e.code === 'DMI_TIMEOUT' && !this._wireFault)
          throw this._sbaError('SBA_TIMEOUT', addr, this.lastSbcs, 'sbbusy 等待超时；请显式复位或断开重连');
        throw e;
      }
      this.lastSbcs = sbcs;
      if (!(sbcs & SBCS.SBBUSY)) return sbcs;
      // Real USB calls already yield. Avoid a host timer per poll (Windows
      // timers can be much longer than 1 ms); yield periodically for simulators.
      if (++polls % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  _sbaError(code, addr, sbcs, message){
    this.sbaFailed = true;
    return new RiscvAccessError(code,
      `SBA 访问 0x${(addr >>> 0).toString(16)} 失败（sbcs=0x${(sbcs >>> 0).toString(16)}）：${message}`,
      { addr, sbcs, sberror: (sbcs & SBCS.SBERROR) >>> 12 });
  }

  async _clearSba(deadline, addr = 0){
    const sbcs = await this._waitSba(deadline, addr);
    // Stop both automatic triggers. Only writable configuration/W1C bits.
    await this.dmiWrite(DM.SBCS, (sbcs & SBA_ERRORS) | SBCS.SBACCESS32, this._remaining(deadline));
    this._sbcsCfg = null; this._holdAddr = null;
    const back = await this._waitSba(deadline, addr);
    if (back & SBA_ERRORS) throw this._sbaError('SBA_CLEAR_FAILED', addr, back, '错误位清除失败');
    this.sbaFailed = false;
    return back;
  }

  sbaClearErrors(timeoutMs = 500){
    const deadline = now() + timeoutMs;
    return this._exclusive('_sbaQueue', () => this._clearSba(deadline));
  }

  async sbaConfig(extra = sbcsBlock(), timeoutMs = 2000){
    const deadline = now() + timeoutMs;
    const sbcs = await this._waitSba(deadline);
    if (sbcs & SBA_ERRORS) await this._clearSba(deadline);
    if (this._sbcsCfg !== (extra >>> 0)){
      await this.dmiWrite(DM.SBCS, extra >>> 0, this._remaining(deadline));
      this._sbcsCfg = extra >>> 0;
    }
    this.sbaFailed = false;
  }

  async _checkSbcsAt(addr, timeoutMs = 2000){
    const sbcs = await this._waitSba(now() + timeoutMs, addr);
    if (sbcs & SBA_ERRORS) throw this._sbaError((sbcs & SBCS.SBERROR) ? 'SBA_BUS_ERROR' : 'SBA_BUSY',
      addr, sbcs, '总线访问未完成；未自动复位目标');
    return sbcs;
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
  async sbaHealthCheck({ peekAddr = (this.port || resolveHpmTarget()).memory.healthPeekAddr, perWordMs = 800, allowSystemReset = true, slowMs = 5 } = {}){
    if (peekAddr == null) throw new Error('该目标未配置 SBA 健康检查地址');
    this._validateMemory(peekAddr, 4);
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
    try { await this.dmiWrite(DM.DMCONTROL, 0); await this.dmiWrite(DM.DMCONTROL, this._ctl(this.hart ?? 0)); } catch {}
    after = await readSbcs();
    if (!dirty(after) && await peek()){
      return R({ ok: true, before, after, level: 'dm', note: `DM 复位后恢复（${spd}）` });
    }

    // ③ 系统复位（ndmreset）—— 最后手段，会把目标重启一次
    if (allowSystemReset){
      this.log('SBA 仍不健康 → 系统复位（ndmreset）自愈');
      try { await this.resetRun(); await new Promise(r => setTimeout(r, 1500)); } catch {}
      try { await this.dmiWrite(DM.DMCONTROL, 0); await this.dmiWrite(DM.DMCONTROL, this._ctl(this.hart ?? 0)); } catch {}
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
  async _scanDRMany(requests, { idle = this.idle, deadline = Infinity } = {}){
    const groups = [];
    const all = [];
    for (const rq of requests){
      const seqs = drScan(DR_DMI_BITS, rq, { idle });
      groups.push({ from: all.length, n: seqs.length });
      for (const s of seqs) all.push(s);
    }
    const caps = await this.sequences(all, { deadline });
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

  _validateMemory(addr, length, read = true){
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xffffffff ||
        !Number.isInteger(length) || length < 0 || addr + length > 0x100000000)
      throw new Error('SBA 地址或长度超出 32 位地址空间');
    const start = Math.floor(addr / 4) * 4, end = Math.ceil((addr + length) / 4) * 4;
    if (read && overlapsSbaFence(this.port || resolveHpmTarget(), start, end - start))
      throw new Error('读取范围覆盖 XIP/flash 窗口：拒绝 SBA 访问；请使用已载入 ELF 的只读镜像');
    return { start, end, words: (end - start) / 4 };
  }

  async _runSba(fn, deadline){
    try { return await fn(); }
    catch (e){
      this.sbaFailed = true; this._sbcsCfg = null; this._holdAddr = null;
      e.sbaHandled = true;
      // Cleanup shares the original budget; never reset DM/hart or launch a
      // transfer after the wire timed out. Preserve the original failure.
      if (!this._wireFault && now() < deadline){
        try { await this._clearSba(deadline, e.addr); } catch {}
      }
      throw e;
    }
  }

  async _burstStatus(b, deadline, addr, kind){
    if (b.op != null){
      if (b.op === DMI_STATUS.BUSY) this._learnDelay('dmi');
      if (b.op === DMI_STATUS.BUSY || b.op === DMI_STATUS.ERROR) await this.dmiReset(this._remaining(deadline));
      else throw new RiscvAccessError('DMI_INVALID', `DMI 批量响应使用保留状态（op=${b.op}）`, { addr });
      if (b.op !== DMI_STATUS.BUSY || kind === 'read')
        throw new RiscvAccessError(b.op === DMI_STATUS.BUSY ? 'DMI_BUSY' : 'DMI_FAILED',
          `DMI 批量${kind === 'read' ? '读' : '写'}完成状态不确定；未重复访问`, { addr, uncertain: true });
    } else if (!b.ok && !(b.sbcs & SBA_ERRORS)){
      throw new RiscvAccessError('SBA_BATCH_FAILED', 'SBA 批量结果不完整；未重复访问', { addr });
    }
    const sbcs = b.op == null && b.sbcs != null && !(b.sbcs & SBCS.SBBUSY)
      ? b.sbcs : await this._waitSba(deadline, addr);
    if (sbcs & SBCS.SBERROR) throw this._sbaError('SBA_BUS_ERROR', addr, sbcs, '系统总线错误；未重复访问');
    return sbcs;
  }

  async readMem(addr, length, timeoutMs = 2000){
    const { start, words } = this._validateMemory(addr, length);
    if (!length) return new Uint8Array(0);
    // One shared budget includes queueing, retries and cleanup. Large buffers
    // receive a size-based allowance; a hung single word remains short-bounded.
    const deadline = now() + Math.max(timeoutMs, words * 4);
    return this._exclusive('_sbaQueue', () => this._runSba(async () => {
      const native = new Uint8Array(words * 4), view = new DataView(native.buffer);
      let i = 0;
      const config = words > 1 ? sbcsBlock() : sbcsBlock() & ~SBCS.SBREADONDATA;
      const startRead = async index => {
        await this.sbaConfig(config, this._remaining(deadline));
        this._holdAddr = null;
        await this.dmiWrite(DM.SBADDRESS0, start + index * 4, this._remaining(deadline));
        await this._checkSbcsAt(start + index * 4, this._remaining(deadline));
      };
      await startRead(0);
      while (i < words){
        const here = start + i * 4;
        const count = Math.min(this._burstWords('read'), words - i - 1); // Leave tail out of all bursts.
        if (!this._burstOff && count >= 2){
          const b = await this.sbaReadBurst(count, this._remaining(deadline));
          const sbcs = await this._burstStatus(b, deadline, here, 'read');
          if (sbcs & SBCS.SBBUSYERROR){
            // Like OpenOCD: after the pending read finishes, sbaddress is just
            // past the resident word. Earlier consumed words are valid; fetch
            // the resident word after disabling automatic reads and clearing.
            const next = await this.dmiRead(DM.SBADDRESS0, this._remaining(deadline));
            const resident = (next - start) / 4 - 1;
            if (!Number.isInteger(resident) || resident <= i || resident > i + count || resident >= words)
              throw this._sbaError('SBA_PROGRESS', here, sbcs, '系统总线地址进度异常');
            for (let k = 0; k < resident - i; k++) view.setUint32((i + k) * 4, b.words[k], true);
            await this._clearSba(deadline, here);
            view.setUint32(resident * 4, await this.dmiRead(DM.SBDATA0, this._remaining(deadline)), true);
            i = resident + 1; this._burstMiss++; this._learnDelay('read');
            if (i < words) await startRead(i);
          } else {
            for (let k = 0; k < count; k++) view.setUint32((i + k) * 4, b.words[k], true);
            i += count;
          }
          continue;
        }
        // Conservative baseline: check each completion before consuming data.
        await this._checkSbcsAt(here, this._remaining(deadline));
        if (i === words - 1) await this.sbaConfig(config & ~SBCS.SBREADONDATA, this._remaining(deadline));
        view.setUint32(i * 4, await this.dmiRead(DM.SBDATA0, this._remaining(deadline)), true);
        i++;
        await this._checkSbcsAt(here, this._remaining(deadline));
      }
      return native.slice(addr - start, addr - start + length);
    }, deadline));
  }

  async writeMem(addr, bytes, timeoutMs = 2000){
    this._validateMemory(addr, bytes.length, false);
    if (addr % 4 || bytes.length % 4) throw new Error('SBA 写要求地址和长度 4 字节对齐');
    if (!bytes.length) return;
    const deadline = now() + Math.max(timeoutMs, bytes.length);
    return this._exclusive('_sbaQueue', () => this._runSba(async () => {
      await this.sbaConfig(sbcsWrite(), this._remaining(deadline)); this._holdAddr = null;
      await this.dmiWrite(DM.SBADDRESS0, addr, this._remaining(deadline));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let off = 0, misses = 0;
      while (off < bytes.length){
        await this._checkSbcsAt(addr + off, this._remaining(deadline));
        const count = Math.min(this._burstWords('write'), (bytes.length - off) / 4);
        if (!this._writeBurstOff && count >= 2){
          const data = Array.from({ length: count }, (_, k) => view.getUint32(off + k * 4, true));
          const b = await this.dmiWriteBurst(data, this._remaining(deadline));
          const sbcs = await this._burstStatus(b, deadline, addr + off, 'write');
          if ((sbcs & SBCS.SBBUSYERROR) || b.op === DMI_STATUS.BUSY){
            const next = await this.dmiRead(DM.SBADDRESS0, this._remaining(deadline));
            if (next < addr + off || next > addr + off + count * 4 || (next - addr) % 4)
              throw this._sbaError('SBA_PROGRESS', addr + off, sbcs, '系统总线写进度异常');
            if (next === addr + off && ++misses > 8)
              throw this._sbaError('SBA_PROGRESS', next, sbcs, '系统总线写入没有进展');
            off = next - addr; this._learnDelay('write');
            await this._clearSba(deadline, next);
            await this.sbaConfig(sbcsWrite(), this._remaining(deadline));
            await this.dmiWrite(DM.SBADDRESS0, next, this._remaining(deadline));
          } else { off += count * 4; misses = 0; }
        } else {
          await this.dmiWrite(DM.SBDATA0, view.getUint32(off, true), this._remaining(deadline));
          await this._checkSbcsAt(addr + off, this._remaining(deadline));
          off += 4;
        }
      }
      await this._checkSbcsAt(addr + off - 4, this._remaining(deadline));
    }, deadline));
  }

  // The old posted hold path left a bus read in flight across calls. Keep the
  // API while using the same completed single-word path as ordinary reads.
  async holdPrepare(addr){ this._validateMemory(addr, 4); this._holdAddr = Math.floor(addr / 4) * 4; }
  async holdRead(){
    const addr = this._holdAddr;
    if (addr == null) throw new Error('请先准备单字采样地址');
    const bytes = await this.readMem(addr, 4);
    this._holdAddr = addr;
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }
}
