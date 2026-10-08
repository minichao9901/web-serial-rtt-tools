/**
 * **XIP 窗口拷贝例程**（RV32，手工汇编、7 条指令 28 字节）—— verify 用它替掉 ROM 的 `flash_read`。
 *
 * ## 为什么需要它（2026-10 LA 实测定因，改这块前必读）
 *
 * 把 OpenOCD 烧同一块 HPM6800EVK 的 JTAG 波形抓下来解码（LA CH0..3 = TCK/TMS/TDI/TDO，
 * 500 MS/s `tmp/la-jtag-decode.py` / `tmp/la-parse-decoded.py`）后对比，差异只有一条：
 *
 * | | OpenOCD | 我们（改之前） |
 * |---|---|---|
 * | 读目标内存 | progbuf 跑 `lw s1,0(s1)`（CPU 自己走 XIP 窗口） | SBA |
 * | 读回 flash | **根本不读**（`flash write_image` 不校验；`read` 入口调用次数 = 0） | 调算法 `read` → ROM `flash_read` |
 *
 * 而 ROM 的 `flash_read` 在这颗芯片上**会把核楔死**：flash offset `0x30000` 起、尺寸 ≥32768 时
 * 事务永不完成，现象是 `dmstatus` 恒报 running、**连 haltreq 都停不住核**、抽象命令 `cmderr=4`
 * （实测复现 5/5；同址 4096/8192/16384 正常，`0x0/0x10000/0x20000` 各 65536 也正常）。
 * 反过来，**用 CPU 走 XIP 窗口 `lw` 读同一批地址全部正常**（progbuf 实测 0x80000000/0x30000/
 * 0x34000/0x36000/0x38000/0x3E000 全部秒回真实固件内容）—— 这正是 OpenOCD 走的那条路。
 *
 * ## 例程
 *
 * ```
 *   lw   t0, 0(a0)      ; a0 = 源（XIP 窗口地址，如 0x80030000）
 *   sw   t0, 0(a1)      ; a1 = 目的（SRAM 中转区）
 *   addi a0, a0, 4
 *   addi a1, a1, 4
 *   addi a2, a2, -4     ; a2 = 剩余字节数（必须 4 的倍数）
 *   bne  a2, x0, -20
 *   ebreak              ; 收尾：核进调试模式 → 上层 waitHalted 看到 halt
 * ```
 *
 * 入口地址取 `0x600`：算法 blob 占 `0x0..0x56C`，`0x1000` 是 flash_get_info 的输出、
 * `0x2000` 起是数据中转区 —— 中间这段空着，够放 28 字节且 4 字节对齐。
 */

/** 默认零地址工作区的兼容地址；实际装载地址由 hpmWorkLayout 计算。 */
export const XIP_COPY_ADDR = 0x00000600;

/**
 * 机器码逐条（编码用 RISC-V 手册的域拼出来，自测 `hpm-flash.test.mjs` 会**反解**核对）：
 *   lw   t0,0(a0)   = imm=0, rs1=x10, funct3=2(LW),  rd=x5,  op=0x03
 *   sw   t0,0(a1)   = imm=0, rs2=x5,  rs1=x11, funct3=2(SW),  op=0x23
 *   addi a0,a0,4    = imm=4, rs1=x10, funct3=0, rd=x10, op=0x13
 *   addi a1,a1,4    = imm=4, rs1=x11, funct3=0, rd=x11, op=0x13
 *   addi a2,a2,-4   = imm=-4, rs1=x12, funct3=0, rd=x12, op=0x13
 *   bne  a2,x0,-20  = imm=-20, rs2=x0, rs1=x12, funct3=1(BNE), op=0x63
 *   ebreak          = 0x00100073
 */
export const XIP_COPY_WORDS = [
  0x00052283,      // lw   t0, 0(a0)
  0x0055A023,      // sw   t0, 0(a1)
  0x00450513,      // addi a0, a0, 4
  0x00458593,      // addi a1, a1, 4
  0xFFC60613,      // addi a2, a2, -4
  0xFE0616E3,      // bne  a2, x0, -20
  0x00100073,      // ebreak
];

/** 例程字节（小端），每次调用都新建一份 */
export function xipCopyBytes(){
  const out = new Uint8Array(XIP_COPY_WORDS.length * 4);
  const dv = new DataView(out.buffer);
  XIP_COPY_WORDS.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return out;
}

/** 反解一条指令（自测用）：返回 {mnemonic, rd, rs1, rs2, imm} */
export function decodeXipCopyWord(inst){
  const x = inst >>> 0;
  const op = x & 0x7f;
  const rd = (x >>> 7) & 0x1f, funct3 = (x >>> 12) & 7, rs1 = (x >>> 15) & 0x1f, rs2 = (x >>> 20) & 0x1f;
  const sx = (v, bits) => (v & (1 << (bits - 1))) ? v - (1 << bits) : v;
  if (op === 0x03) return { mnemonic: 'lw', rd, rs1, imm: sx(x >>> 20, 12) };
  if (op === 0x23) return { mnemonic: 'sw', rs1, rs2, imm: sx(((x >>> 25) << 5) | ((x >>> 7) & 0x1f), 12) };
  if (op === 0x13) return { mnemonic: 'addi', rd, rs1, imm: sx(x >>> 20, 12) };
  if (op === 0x63){
    const imm = ((x >>> 31) & 1) << 12 | ((x >>> 25) & 0x3f) << 5 | ((x >>> 8) & 0xf) << 1 | ((x >>> 7) & 1) << 11;
    return { mnemonic: 'bne', rs1, rs2, imm: sx(imm, 13) };
  }
  if (x === 0x00100073) return { mnemonic: 'ebreak' };
  return { mnemonic: `?0x${x.toString(16)}` };
}
