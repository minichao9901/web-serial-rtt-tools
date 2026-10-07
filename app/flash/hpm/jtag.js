/**
 * 用 CMSIS-DAP 的 **JTAG 序列**命令访问 RISC-V 调试模块（DTM/DMI）。
 *
 * 为什么是这条路：探针的 interface 0 就是标准 CMSIS-DAP v2（bulk OUT 0x02 / IN 0x81），
 * 而它的 DAP 引擎带 `DAP_JTAG_Sequence`（0x14）。探针固件自己的 RISC-V 引擎
 * （`src/riscv/riscv_jtag.c`）用的就是同一套 JTAG 位序 —— 这里的每个序列都是**照它抄的**，
 * 所以不是"照着规范猜"，而是"照着一份在 HPM6800EVK 上跑通了的实现搬"：
 *
 *   TAP 复位   ：6 × (8 TCK, TMS=1) + 1 TCK TMS=0（停 Run-Test/Idle）
 *   装 IR      ：2 TCK TMS=1（Select-DR、Select-IR）→ 2 TCK TMS=0（Capture-IR、Shift-IR）
 *                → 4 bit IR[3:0] TMS=0 → 1 bit IR[4] TMS=1 → TMS=1（Update-IR）→ TMS=0（RTI）
 *   DR 扫描    ：可选 idle 拍（TMS=0，dtmcs 要求 7 拍）→ TMS=1（Select-DR）
 *                → 2 TCK TMS=0（Capture-DR、Shift-DR）→ n-1 bit TMS=0 → 最后 1 bit TMS=1
 *                → TMS=1（Update-DR）→ TMS=0（RTI）
 *   DMI 请求   ：41 位 DR = op(2) | data(32) << 2 | addr(7) << 34，**响应在下一次扫描里**
 *
 * ⚠️ **未在真机上验证**（本轮探针被占用）：位序/编码有固件源码与 RISC-V 调试规范双向对账，
 *    并用模拟 DTM 做了端到端自测；真机 bring-up 时最可能需要调的是 `idle` 拍数与 DAP 命令打包。
 */

/** CMSIS-DAP 命令码（只列用到的） */
export const DAP = {
  INFO: 0x00, CONNECT: 0x02, DISCONNECT: 0x03,
  SWJ_CLOCK: 0x11, SWJ_SEQUENCE: 0x12,
  JTAG_SEQUENCE: 0x14, JTAG_CONFIGURE: 0x15, JTAG_IDCODE: 0x16,
  TRANSFER: 0x05, TRANSFER_BLOCK: 0x06,
};

export const DAP_PORT = { DISABLED: 0, SWD: 1, JTAG: 2 };

/** 序列信息字节：bit0-5 = TCK 拍数（0 表示 64），bit6 = TMS 电平，bit7 = 是否捕获 TDO */
export function seqInfo(clocks, tms, capture){
  const n = clocks >= 64 ? 0 : clocks;         // 0 = 64 拍（CMSIS-DAP 规定）
  return ((n & 0x3f) | (tms ? 0x40 : 0) | (capture ? 0x80 : 0)) & 0xff;
}

/**
 * 一条 JTAG 序列（TDI 位流 LSB 在前）。
 * 返回的对象里**必须带上归一化后的 `clocks`**（0 在 info 里表示 64 拍）—— 上层要靠它
 * 逐位解析 TDO；早期只回 info/tdi，结果按位收集时拿到 undefined、TDO 全 0（自测里抓到）。
 * @param {{clocks:number, tms:boolean, tdi?:Uint8Array|number[], capture?:boolean}} s
 * @returns {{info:number, clocks:number, tdi:Uint8Array, captureBytes:number}}
 */
export function buildSequence({ clocks, tms = false, tdi = null, capture = false }){
  const n = clocks >= 64 ? 64 : clocks;
  const bytes = Math.ceil(n / 8);
  const out = new Uint8Array(bytes);
  if (tdi != null){
    const src = tdi instanceof Uint8Array ? tdi : Uint8Array.from(tdi);
    out.set(src.subarray(0, Math.min(bytes, src.length)));
  }
  return { info: seqInfo(clocks, tms, capture), clocks: n, tdi: out, captureBytes: capture ? bytes : 0 };
}

// ---------------------------------------------------------------- TAP 动作
/** TAP 复位 → Run-Test/Idle（可从任意状态拉回来）*/
export function tapReset(){
  const seqs = [];
  for (let i = 0; i < 6; i++) seqs.push(buildSequence({ clocks: 8, tms: true, tdi: new Uint8Array([0xff]) }));
  seqs.push(buildSequence({ clocks: 1, tms: false, tdi: new Uint8Array([1]) }));
  return seqs;
}

/** RTI → Shift-IR（装 5 位 IR）→ Update-IR → RTI */
export function tapLoadIR(ir, irLength = 5){
  const seqs = [];
  seqs.push(buildSequence({ clocks: 2, tms: true, tdi: new Uint8Array([0x03]) }));   // Select-DR, Select-IR
  seqs.push(buildSequence({ clocks: 2, tms: false, tdi: new Uint8Array([0x03]) }));  // Capture-IR, Shift-IR
  const low = irLength - 1;
  const lowBits = ir & ((1 << low) - 1);
  seqs.push(buildSequence({ clocks: low, tms: false, tdi: new Uint8Array([lowBits & 0xff]) }));
  seqs.push(buildSequence({ clocks: 1, tms: true, tdi: new Uint8Array([(ir >>> low) & 1]) }));  // 最后一位 → Exit1-IR
  seqs.push(buildSequence({ clocks: 1, tms: true, tdi: new Uint8Array([1]) }));      // Update-IR
  seqs.push(buildSequence({ clocks: 1, tms: false, tdi: new Uint8Array([1]) }));     // RTI
  return seqs;
}

/**
 * 一次 DR 扫描（RTI → Shift-DR → Update-DR → RTI），返回捕获到的位。
 * @param {number} nbits 位数（本文件用 32 位 IDCODE / 41 位 DMI / 32 位 DTMCS）
 * @param {bigint|number} tdi 要移入的数据（低位先出）
 * @param {{idle?:number, capture?:boolean}} [opts] idle = 扫描前先跑几拍 RTI（DTM 要求 ≥7）
 */
export function drScan(nbits, tdi, opts = {}){
  const { idle = 0, capture = true } = opts;
  const v = typeof tdi === 'bigint' ? tdi : BigInt(tdi >>> 0);
  const seqs = [];
  for (let left = Math.ceil(idle); left > 0; left -= 64)
    seqs.push(buildSequence({ clocks: Math.min(64, left), tms: false, tdi: new Uint8Array(8).fill(0xff) }));
  seqs.push(buildSequence({ clocks: 1, tms: true, tdi: new Uint8Array([1]) }));       // Select-DR
  seqs.push(buildSequence({ clocks: 2, tms: false, tdi: new Uint8Array([0x03]) }));   // Capture-DR, Shift-DR
  const nlow = nbits - 1;
  const low = v & ((1n << BigInt(nlow)) - 1n);
  const lowBytes = new Uint8Array(Math.ceil(nlow / 8));
  for (let i = 0; i < nlow; i++) if ((low >> BigInt(i)) & 1n) lowBytes[i >> 3] |= 1 << (i & 7);
  seqs.push(buildSequence({ clocks: nlow, tms: false, tdi: lowBytes, capture }));
  seqs.push(buildSequence({ clocks: 1, tms: true, tdi: new Uint8Array([Number((v >> BigInt(nlow)) & 1n)]), capture }));  // 最后一位
  seqs.push(buildSequence({ clocks: 1, tms: true, tdi: new Uint8Array([1]) }));       // Update-DR
  seqs.push(buildSequence({ clocks: 1, tms: false, tdi: new Uint8Array([1]) }));      // RTI
  return seqs;
}

/** 把若干条序列的 TDO 字节按位拼起来（CMSIS-DAP 的响应里每条序列的 TDO 依次排列）*/
export function gatherTDO(captures, totalBits){
  const out = new Uint8Array(Math.ceil(totalBits / 8));
  let bit = 0;
  for (const cap of captures){
    for (const b of cap){
      for (let k = 0; k < 8 && bit < totalBits; k++, bit++){
        if ((b >> k) & 1) out[bit >> 3] |= 1 << (bit & 7);
      }
    }
  }
  return out;
}

/** 从按位拼好的 TDO 里取小端整数 */
export function bitsToUint(bytes, bitOffset, nbits){
  let v = 0;
  for (let i = 0; i < nbits; i++){
    const bit = bitOffset + i;
    if ((bytes[bit >> 3] >> (bit & 7)) & 1) v += 2 ** i;
  }
  return v;
}

// ---------------------------------------------------------------- DMI
/** RISC-V DMI 请求的 41 位编码：op(2) | data(32) << 2 | addr(7) << 34 */
export function dmiRequest(op, addr, data){
  return (BigInt(op & 0x3)) | ((BigInt(data >>> 0)) << 2n) | ((BigInt(addr & 0x7f)) << 34n);
}

/** 解 41 位 DMI 响应 → { op, data } */
export function dmiResponse(bits){
  const op = Number(bits & 0x3n);
  const data = Number((bits >> 2n) & 0xffffffffn) >>> 0;
  return { op, data };
}

/** DMI op 码 */
export const DMI_OP = { NOP: 0, READ: 1, WRITE: 2 };

/** 常用 DMI 地址（RISC-V 调试规范 §3.14，与探针固件 `riscv_jtag.c` 的宏逐一对齐）*/
export const DM = {
  DATA0: 0x04,
  DMCONTROL: 0x10, DMSTATUS: 0x11, HARTINFO: 0x12, ABSTRACTCS: 0x16, COMMAND: 0x17, ABSTRACTAUTO: 0x18,
  PROGBUF0: 0x20,                                  // progbuf0..progbuf15 = 0x20..0x2f
  SBCS: 0x38, SBADDRESS0: 0x39, SBDATA0: 0x3c,
};

/** sbcs 的位（**照抄探针固件** `riscv_jtag.c` —— 这些位在真机上跑通过，别按记忆改）*/
export const SBCS = {
  SBACCESS32: 2 << 17,
  SBAUTOINC: 1 << 16,
  SBREADONDATA: 1 << 15,
  SBREADONADDR: 1 << 20,
  SBBUSY: 1 << 21,
  SBBUSYERROR: 1 << 22,        // 写 1 清零
  SBERROR: 7 << 12,            // [14:12]，写 1 清零
};

/** 32 位**块读**的 sbcs 初值：32 位访问 + 自增 + 写地址即读 + 读数据即续读 */
export const sbcsBlock = () => (SBCS.SBACCESS32 | SBCS.SBAUTOINC | SBCS.SBREADONADDR | SBCS.SBREADONDATA) >>> 0;
/**
 * 32 位**块写**的 sbcs：**绝不能带 sbreadonaddr**。
 * 🚨 2026-10 真机踩到：带 readonaddr 时"写 sbaddress0"会先触发一次读，读完之后地址**自增 4**，
 *    于是第一笔数据写到 addr+4 —— 现象是"写进去的 blob 整体错位一个字"（读回来 SRAM[4..] = blob[0..]），
 *    接着 resume 跑的是垃圾指令、SoC 被看门狗复位、hart 报 allunavail。
 *    探针固件 `riscv_jtag_write()` 用的就是 `sba_config(0)`（只留 32 位 + 自增）✓ 照它来。
 */
export const sbcsWrite = () => (SBCS.SBACCESS32 | SBCS.SBAUTOINC) >>> 0;
/** 单字"抱住地址"用：不自增 + 读数据即续读（每次读同一个地址，J-Scope 的单变量快路径语义）*/
export const sbcsHold = () => (SBCS.SBACCESS32 | SBCS.SBREADONADDR | SBCS.SBREADONDATA) >>> 0;

/** DMI 响应里的 op 状态码 */
export const DMI_STATUS = { SUCCESS: 0, BUSY: 3, ERROR: 2 };

/** dmcontrol 位域（只列用到的）*/
export const DMCONTROL = {
  dmactive: 1 << 0, ndmreset: 1 << 1, ackhavereset: 1 << 28,
  hartsel: (h) => ((h & 0x3ff) << 16) >>> 0, haltreq: 1 << 31, resumereq: 1 << 30,
};
/**
 * dmstatus 位域 —— **两套布局都要认**。
 *
 * 2026-10 HPM6800EVK 真机标定（`tmp/hpm-dm-bits.mjs`，做法：种 `jal x0,0` 死循环看"跑"的位、
 * 再写 haltreq 看"停"的位，两组位刚好互补）：
 *   · 停住：**bit8/9** 置起（allhalted/anyhalted），bit10/11 清零 → `dmstatus=0x…03a2`
 *   · 运行：**bit10/11** 置起（allrunning/anyrunning），bit8/9 清零 → `dmstatus=0x…0ca2`
 *   同时 resumeack 在 bit16/17、havereset 在 bit18/19 —— 这一整套是调试规范 **0.11 时代的排法**：
 *   [9:8] halt、[11:10] run、[13:12] unavail、[15:14] nonexistent、[17:16] resumeack、[19:18] havereset。
 *   0.13/1.0 把这几对整体挪到了高位（halt 在 [25:24]）。所以这里用 `detectLayout()` 实测一次再决定。
 *
 * 🚨 别把 [11:10] 当 unavail（我踩过）：那样会把"跑到飞起"误读成"核不可用"，
 *    再顺手做一次 reset-halt，现象就变成"烧录算法永远不结束"。
 */
export const DMSTATUS_LAYOUT = {
  legacy: { allhalted: 1 << 8, anyhalted: 1 << 9, allrunning: 1 << 10, anyrunning: 1 << 11,
            allunavail: 1 << 12, anyunavail: 1 << 13 },
  spec:   { allhalted: 1 << 24, anyhalted: 1 << 25, allrunning: 1 << 22, anyrunning: 1 << 23,
            allunavail: 1 << 20, anyunavail: 1 << 21 },
};
/** 两套布局都成立的那些位 */
export const DMSTATUS = {
  /** version 是 **bit[3:0]**（调试规范）；HPM6800EVK 实测读回 2 —— 但它的位排法仍是 0.11 那套，
   *  所以版本号只能当参考，真正的判据是 `detectLayout()` 的实测结果。 */
  version: (v) => ((v >>> 0) & 0xf),
  /** 按实测布局取 unavail / havereset 掩码（两套布局位不同）*/
  unavailMask: (layout) => {
    const L = DMSTATUS_LAYOUT[layout] || DMSTATUS_LAYOUT.legacy;
    return L.allunavail | L.anyunavail;
  },
  /** havereset：legacy 在 [19:18]、规范在 [15:14] */
  haveresetMask: (layout) => (layout === 'spec' ? ((1 << 14) | (1 << 15)) : ((1 << 18) | (1 << 19))),
  /** 按实测出来的布局取"已停"掩码 */
  haltedMask: (layout) => {
    const L = DMSTATUS_LAYOUT[layout] || DMSTATUS_LAYOUT.legacy;
    return L.allhalted | L.anyhalted;
  },
};
/** abstractcs 位域 */
export const ABSTRACTCS = {
  busy: 1 << 12, cmderr: (v) => ((v >>> 8) & 0x7), datacount: (v) => ((v >>> 0) & 0xf) + 1,
};
/** abstract command 的 cmdtype / 寄存器编号 */
export const CMDTYPE = { ACCESS_REGISTER: 0, QUICK_ACCESS: 1, ACCESS_MEMORY: 2 };
/**
 * hart 寄存器号（调试规范 §3.14 的抽象命令编号，**不是** CSR 编号本身）：
 *   x0..x31 = 0x1000+n（a0 = x10 = 0x100a）、f0..f31 = 0x1020+n、
 *   `dpc` = **0x7b1**（`dcsr`=0x7b0、`dscratch0/1`=0x7b2/0x7b3）。
 *
 * 🚨 2026-10 真机踩到：这里曾写成 `0x7c1`（既不合法也不是 dpc）。
 *    后果极隐蔽 —— 写"pc"其实写进了某个自定义 CSR，**核仍然从 dpc 里的老地址（复位向量 0x80001）开始跑**，
 *    于是现象是"resume 之后 dmstatus 永远报 running、烧录算法永远不结束、读 pc 永远 0x80001"。
 *    OpenOCD 的 `riscv.h` 里就是 `#define DPC 0x7b1`，与规范一致。
 */
export const REGNO = { PC: 0x7b1, DCSR: 0x7b0 };
/**
 * `dcsr` 里"ebreak 进调试模式"的位。
 *
 * 🚨 不置这些位的话，算法末尾那条 `ebreak` 只会触发**断点异常**：固件里没有对应的
 *    trap 处理，核会跳去异常向量一路乱跑 —— 表现为 dmstatus 永远报 running、烧录"永远不结束"。
 *    OpenOCD 在跑算法前也是先 `dcsr |= ebreak*`（日志里 `set_dcsr_ebreak()`）。
 */
export const DCSR_EBREAK = { m: 1 << 15, s: 1 << 13, u: 1 << 12 };
/** progbuf 里"刷指令缓存"那段（与 OpenOCD 的 autofence 相同）：fence.i; fence rw,rw; ebreak */
export const PROGBUF_FENCE = [0x0000100f, 0x0330000f, 0x00100073];

/** 抽象命令字：cmdtype[31:29] | aarsize[22:20] | postexec[18] | transfer[17] | write[16] | regno[15:0] + data
 *  ⚠️ regno 必须在 16 位内：x0..x31 = 0x1000+n（a0 = x10 = 0x100a）、dpc = 0x7b1。*/
export function abstractCommand({ cmdtype = CMDTYPE.ACCESS_REGISTER, aarsize = 2, postexec = false,
                                  transfer = true, write = false, regno = 0, data = 0 } = {}){
  if (regno > 0xffff) throw new Error(`regno 0x${regno.toString(16)} 超出 16 位（x 寄存器从 0x1000 起）`);
  const command = (((cmdtype & 0x7) << 29) | ((aarsize & 0x7) << 20) |
                   (postexec ? 1 << 18 : 0) | (transfer ? 1 << 17 : 0) | (write ? 1 << 16 : 0) |
                   (regno & 0xffff)) >>> 0;
  return { command, data: data >>> 0 };
}
