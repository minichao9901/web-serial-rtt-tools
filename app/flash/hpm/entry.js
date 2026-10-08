/**
 * HPM flashloader 的**入口表解析**（RV32）。
 *
 * `func_table.S` 生成的是 7 个 `jal 函数` + `ebreak` 对：
 *
 *     _init:
 *       jal flash_init      ; 入口 0
 *       ebreak
 *       jal flash_erase     ; 入口 1
 *       ebreak
 *       ...
 *
 * 🚨 **不要假设表项是 8 字节**：汇编器会把 `ebreak` 压成 2 字节的 `c.ebreak`，
 *    实测每项是 **4 + 2 = 6 B**（构建脚本一开始按 8 B 步长校验，第 2 项就炸了）。
 *    这里的做法是**真解码**：从偏移 0 开始逐条走指令（RVC 的 16 位 / 常规 32 位），
 *    把每个 `jal`/`c.jal` 的目标算出来，直到遇到不是 jal 的指令为止。
 *    好处是编译器/汇编器换了压缩策略也不用改代码 —— 自测拿构建时抓的符号地址对账。
 */

/** 解一条 J 型（jal）立即数：imm[20] | imm[10:1] | imm[11] | imm[19:12] */
export function jalOffset(inst){
  const x = inst >>> 0;
  let imm = ((x >>> 31) & 1) * 0x100000 +
            ((x >>> 21) & 0x3ff) * 2 +
            ((x >>> 20) & 1) * 0x800 +
            ((x >>> 12) & 0xff) * 0x1000;
  if (imm >= 0x100000) imm -= 0x200000;        // 21 位有符号
  return imm;
}

/** 解一条 CJ 型（c.jal，RV32 专有）立即数：imm[11] | imm[4] | imm[9:8] | imm[10] | imm[6] | imm[7] | imm[3:1] | imm[5] */
export function cjalOffset(inst){
  const x = inst & 0xffff;
  let imm = ((x >>> 12) & 1) * 0x800 +
            ((x >>> 11) & 1) * 0x10 +
            ((x >>> 9) & 3) * 0x100 +
            ((x >>> 8) & 1) * 0x400 +
            ((x >>> 7) & 1) * 0x40 +
            ((x >>> 6) & 1) * 0x80 +
            ((x >>> 3) & 7) * 2 +
            ((x >>> 2) & 1) * 0x20;
  // 🚨 12 位立即数的**符号位是 bit11（0x800）**，别写成 `imm >= 0x1000` ——
  //    那等于要求"值 ≥ 4096"，而 12 位立即数最大只有 0xFFF，判据永远不成立，
  //    所有负偏移都会被解成正的大数（objdump 对 0x3fd5 解出 -12，我们这边会解成 +4084）。
  if (imm & 0x800) imm -= 0x1000;
  return imm;
}

/** 这条 16 位指令是不是 c.jal？（RVC：funct3=001，quadrant=01） */
export function isCJal(bytes, off){
  const inst = bytes[off] | (bytes[off + 1] << 8);
  return (inst & 0x3) === 0x1 && ((inst >>> 13) & 0x7) === 0x1;
}

/**
 * 走一遍入口表，返回每个入口的**偏移**与跳转目标。
 * @param {Uint8Array} bytes flashloader blob（加载地址 = 0，所以偏移就是地址）
 * @param {number} maxEntries 最多认几个（默认 16，防呆）
 * @returns {Array<{entryOffset:number, target:number, instrBytes:number}>}
 */
export function parseAlgoEntryTable(bytes, maxEntries = 16){
  const out = [];
  let off = 0;
  while (off + 2 <= bytes.length && out.length < maxEntries){
    const b0 = bytes[off], b1 = bytes[off + 1];
    const is32 = (b0 & 0x3) === 0x3;
    if (is32){
      const inst = (b0 | (b1 << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
      if ((inst & 0x7f) !== 0x6f) break;                     // 不是 jal → 表到头了
      out.push({ entryOffset: off, target: off + jalOffset(inst), instrBytes: 4 });
      off += 4;
    } else {
      if (!isCJal(bytes, off)) break;
      out.push({ entryOffset: off, target: off + cjalOffset(b0 | (b1 << 8)), instrBytes: 2 });
      off += 2;
    }
    // 每条 jal 后面应当跟着 ebreak（2 字节 c.ebreak = 0x9002，或 4 字节 0x00100073）
    const after = bytes[off] | (bytes[off + 1] << 8);
    if (after === 0x9002) off += 2;
    else if (after === 0x0073) off += 4;
    else break;                                               // 没有 ebreak → 不是规整的表，收工
  }
  return out;
}

/** 按 `func_table.S` 的顺序给入口起名（顺序是契约，见 README）*/
export const ENTRY_ORDER = ['init', 'erase', 'program', 'read', 'info', 'eraseChip', 'deinit'];

/** 解析并按名字返回：`{ init: {entryOffset, target}, erase: … }` */
export function algoEntries(bytes){
  const list = parseAlgoEntryTable(bytes);
  const out = {};
  ENTRY_ORDER.forEach((name, i) => { if (list[i]) out[name] = list[i]; });
  return { list, byName: out, count: list.length };
}

/** Relocate only ELF-declared internal GOT pointers. The canonical blob stays unchanged. */
export function relocateAlgoBytes(bytes, descriptor, loadAddr){
  if (!Number.isInteger(loadAddr) || loadAddr < 0 || loadAddr + bytes.length > 0x100000000)
    throw new Error('算法加载地址超出 32 位范围');
  if (loadAddr !== descriptor.loadAddr && !Array.isArray(descriptor.relocations))
    throw new Error('算法缺少 GOT 重定位信息，请重建算法');
  const out = new Uint8Array(bytes), view = new DataView(out.buffer);
  for (const { offset, target } of descriptor.relocations || []) {
    if (!Number.isInteger(offset) || offset < 0 || offset % 4 || offset + 4 > out.length ||
        !Number.isInteger(target) || target < descriptor.loadAddr || target >= descriptor.loadAddr + out.length ||
        view.getUint32(offset,true) !== target)
      throw new Error('算法 GOT 重定位信息与机器码不一致');
    view.setUint32(offset, target + loadAddr - descriptor.loadAddr, true);
  }
  return out;
}
