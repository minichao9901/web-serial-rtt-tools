/**
 * 固件文件解析：ELF / Intel HEX / BIN → [ { addr, data:Uint8Array } ]（地址升序，相邻段合并）。
 * ELF/HEX 自带地址；BIN 没有地址信息，由调用方给基地址。
 */

/**
 * 相邻（间隔 ≤ 4KB）的段合并成连续段，空隙补 0xFF（flash 擦除后的默认值）。
 *
 * 🚨 **重叠的段直接报错，不合并**（2026-10 代码审查）：老代码遇到 `s.addr < end` 时
 *    `gap` 被 `Math.max(0, …)` 夹成 0，后一段就被**接在前一段末尾**（地址整体抬高），
 *    而不是落到它自己的地址上 —— 既不报错也不提示，数据静默错位。
 *    正常 ELF 的各节不重叠，触发它的是 HEX 里的重复记录（或者坏文件）。
 */
function mergeSegs(segs){
  segs.sort((a, b) => a.addr - b.addr);
  const out = [];
  for (const s of segs){
    const last = out[out.length - 1];
    if (last && s.addr < last.addr + last.data.length){
      const end = last.addr + last.data.length;
      throw new Error(`固件里有两段重叠的地址：0x${s.addr.toString(16)} 起的 ${s.data.length} B ` +
        `落在前一段 0x${last.addr.toString(16)}..0x${(end - 1).toString(16)} 里面 —— ` +
        `文件里有重复/冲突的记录（HEX 重复段、或两个节映射到同一地址），不敢猜哪个对，请先修好文件`);
    }
    if (last && s.addr <= last.addr + last.data.length + 4096){
      const end = last.addr + last.data.length;
      const gap = s.addr - end;                        // 上面已保证 ≥ 0
      const merged = new Uint8Array(end - last.addr + gap + s.data.length);
      merged.set(last.data);
      merged.fill(0xff, end - last.addr, end - last.addr + gap);
      merged.set(s.data, end - last.addr + gap);
      last.data = merged;
      // 🚨 空洞被填成 0xFF 了：语义上没错（未编程=0xFF），但**必须记下来**，
      //    否则这份"填平"的数据既写又校验，一路静默通过，而镜像其实缺了字节。
      if (gap > 0){
        out.gaps ||= [];
        out.gaps.push({ addr: end, length: gap });
      }
    } else {
      out.push({ addr: s.addr, data: s.data });
    }
  }
  return out;
}

/**
 * ELF32 小端 → 烧录段。
 *
 * 🚨 **必须按"节(section)"取，不能只按 PT_LOAD 段取**（2026-10 HPM6800EVK 真机踩到）：
 *    HPM SDK 的 flash_xip 镜像把**启动头 `.boot_header`（0x80001000）放在任何 PT_LOAD 之外**
 *    （readelf -l 里根本没有覆盖它的段），而 ROM 就是靠这个头认镜像的。
 *    只按 PT_LOAD 烧 → 代码都在、启动头没烧 → 板子复位后停在 boot ROM 不动。
 *    OpenOCD 的 `flash write_image` 也是**按节**写的（SHF_ALLOC 的 PROGBITS），所以它烧 ELF 没问题。
 *    这就是"HPM 必须烧 ELF、不能烧 .bin"的真正原因（.bin 里那段是空的）。
 *
 * 地址取 **LMA**：节在某个 PT_LOAD 里时 = `p_paddr + (sh_addr - p_vaddr)`
 * （`.vectors`/`.data` 这类 VMA 在 ILM/SRAM、LMA 在 flash 的节全靠这个换算）；
 * 不在任何段里（如 `.boot_header`）就认为它本来就在 flash 上，直接用 `sh_addr`。
 */
export function parseElfImage(u8){
  if (!(u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46)) throw new Error('不是 ELF 文件（\\x7fELF 魔数不对）');
  const fileRange = (off, size, label) => {
    if (off > u8.byteLength || size > u8.byteLength - off)
      throw new Error(`ELF ${label}被截断或越界，不能烧录`);
  };
  const addressRange = (addr, size) => {
    if (addr + size > 0x100000000) throw new Error('ELF 加载地址跨 u32 边界，不能烧录');
  };
  fileRange(0, 52, '文件头');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(4) !== 1) throw new Error('只支持 32 位 ELF（STM32 都是）');
  if (dv.getUint8(5) !== 1) throw new Error('只支持小端 ELF');

  // 先把 PT_LOAD 段收集起来（用来给节做 VMA→LMA 换算）
  const phoff = dv.getUint32(28, true);
  const phentsize = dv.getUint16(42, true);
  const phnum = dv.getUint16(44, true);
  if (phnum){
    if (!phoff || phentsize < 32) throw new Error('ELF 程序头表格式无效');
    fileRange(phoff, phnum * phentsize, '程序头表');
  }
  const loads = [];
  for (let i = 0; i < phnum; i++){
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) !== 1) continue;                 // PT_LOAD
    const filesz = dv.getUint32(o + 16, true);
    if (!filesz) continue;
    const load = { off: dv.getUint32(o + 4, true), vaddr: dv.getUint32(o + 8, true),
                   paddr: dv.getUint32(o + 12, true), filesz };
    fileRange(load.off, filesz, 'PT_LOAD 数据');
    addressRange(load.vaddr, filesz); addressRange(load.paddr, filesz);
    loads.push(load);
  }
  const lmaOf = (addr, size) => {
    for (const L of loads){
      if (addr >= L.vaddr && addr + size <= L.vaddr + L.filesz) return (L.paddr + (addr - L.vaddr)) >>> 0;
    }
    return addr >>> 0;                                          // 不在段里：当作本来就在 flash（.boot_header 就是这种）
  };

  // 所有有文件内容的 ALLOC 节都要烧，包括 ARM_EXIDX 和初始化数组。
  const shoff = dv.getUint32(32, true);
  const shentsize = dv.getUint16(46, true);
  const shnum = dv.getUint16(48, true);
  const segs = [];
  if (shoff && shnum){
    if (shentsize < 40) throw new Error('ELF 节表格式无效');
    fileRange(shoff, shnum * shentsize, '节表');
    for (let i = 0; i < shnum; i++){
      const o = shoff + i * shentsize;
      const type = dv.getUint32(o + 4, true);
      const flags = dv.getUint32(o + 8, true);
      const addr = dv.getUint32(o + 12, true);
      const off = dv.getUint32(o + 16, true);
      const size = dv.getUint32(o + 20, true);
      if (type === 0 || type === 8 || !(flags & 0x2) || !size) continue; // 排除 NULL、NOBITS 和非 ALLOC
      fileRange(off, size, '可加载节数据');
      addressRange(addr, size);
      segs.push({ addr: lmaOf(addr, size), data: u8.slice(off, off + size) });
    }
  }
  /**
   * 🚨 **用 PT_LOAD 的文件字节把"节间空隙"补上**（2026-10 真机定因）。
   *
   * 节与节之间可能有**对齐空隙**（本例 `.isr_vector` 结束于 0x08000298，
   * `.text` 从 0x080002A0 开始，中间 8 字节不属于任何节）。按节取数据时这些字节缺失，
   * 后续 `mergeSegs` 会把它们填成 0xFF 并写进 flash —— 但 ELF 的 PT_LOAD 段里
   * 它们是真实的 0x00（链接器填的）。
   *
   * 后果（H743 实测）：板子上是 0xFF、ELF 期望 0x00，逐字节比对（ETM 页 verifyElf）
   * 报「目标机器码与 ELF 不匹配：0x08000298（ELF 00 ≠ 目标 ff）」；而烧录器自己的
   * 回读校验比的就是它填的 0xFF，所以显示"校验 OK"。OpenOCD 按段写所以没事。
   *
   * 修法：对每个 PT_LOAD，把它范围内"没有被任何节覆盖"的区间用**段文件字节**补成独立区段。
   */
  if (segs.length && loads.length){
    const byAddr = [...segs].sort((a, b) => a.addr - b.addr);
    const extra = [];
    for (const L of loads){
      const segStart = (L.paddr || L.vaddr) >>> 0;
      const segEnd = segStart + L.filesz;
      let cursor = segStart;
      for (const sg of byAddr){
        const sgEnd = sg.addr + sg.data.length;
        if (sgEnd <= segStart || sg.addr >= segEnd) continue;
        const lo = Math.max(sg.addr, segStart);
        if (lo > cursor){
          const off = L.off + (cursor - segStart);
          extra.push({ addr: cursor, data: u8.slice(off, off + (lo - cursor)) });
        }
        cursor = Math.max(cursor, Math.min(sgEnd, segEnd));
      }
      if (cursor < segEnd){
        const off = L.off + (cursor - segStart);
        extra.push({ addr: cursor, data: u8.slice(off, off + (segEnd - cursor)) });
      }
    }
    for (const seg of extra) segs.push(seg);
  }

  // 没有节表（被 strip 过的裸 ELF）就退回按段来 —— 至少比报错强
  if (!segs.length){
    for (const L of loads) segs.push({ addr: (L.paddr || L.vaddr) >>> 0, data: u8.slice(L.off, L.off + L.filesz) });
  }
  if (!segs.length) throw new Error('ELF 里没有带内容的可加载段');
  return mergeSegs(segs);
}

/** Intel HEX（:llaaaatt[dd...]cc） */
export function parseIntelHex(text){
  const HEX = /^([0-9a-fA-F]{2})+$/;
  const segs = [];
  let upper = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++){
    const line = lines[li].trim();
    if (!line || !line.startsWith(':')) continue;
    const body = line.slice(1);
    if (!HEX.test(body)) throw new Error(`HEX 第 ${li + 1} 行格式不对：${line.slice(0, 20)}…`);
    const bin = new Uint8Array(body.length / 2);
    for (let i = 0; i < bin.length; i++) bin[i] = parseInt(body.substr(i * 2, 2), 16);
    const len = bin[0];
    /**
     * 🚨 **长度与校验和都要核**（2026-10 代码审查）。记录形状是 `:llaaaatt[dd..]cc`，
     *    一共 `len + 5` 字节。老代码两个都不看，后果是**静默烧坏数据**：
     *      · 行被截断时 `slice(4, 4+len)` 会把**校验字节当成数据**收下（少掉的那几个字节没人发现）；
     *      · 数据位翻错也照收 —— 而烧录后的"回读校验"比对的正是这份已经坏掉的数据，
     *        所以界面会显示**校验通过**。
     *    "所有字节按 uint8 累加 == 0"是这个格式唯一的完整性依据，必须查。
     */
    if (bin.length !== len + 5){
      throw new Error(`HEX 第 ${li + 1} 行长度不对：长度字段说 ${len} 字节数据（整行应为 ${len + 5} 字节），` +
        `实际 ${bin.length} 字节 —— 文件被截断或改坏了`);
    }
    let sum = 0;
    for (const b of bin) sum = (sum + b) & 0xff;
    if (sum !== 0){
      throw new Error(`HEX 第 ${li + 1} 行校验和不对（所有字节之和应为 0，实得 0x${sum.toString(16).padStart(2, '0')}）` +
        ` —— 文件损坏了，别烧（烧坏的数据回读校验也会"通过"，因为它比的就是这份坏数据）`);
    }
    const addr = ((bin[1] << 8) | bin[2]) >>> 0;
    const type = bin[3];
    const data = bin.slice(4, 4 + len);
    if (type === 0x00) segs.push({ addr: (upper + addr) >>> 0, data });
    else if (type === 0x01) break;                             // EOF
    else if (type === 0x04) upper = (((data[0] << 8) | data[1]) << 16) >>> 0;   // 扩展线性地址
    else if (type === 0x02) upper = (((data[0] << 8) | data[1]) << 4) >>> 0;    // 扩展段地址
    // 03/05（起始地址）忽略：烧录用段里的地址
  }
  if (!segs.length) throw new Error('HEX 里没有数据记录');
  return mergeSegs(segs);
}

/**
 * 找出相邻区段之间的"空洞"（没有任何数据记录覆盖的地址区间）。
 * 只报**内部**空洞：首段之前 / 末段之后不算（那是镜像范围之外）。
 * 用途见 view.js：objcopy 的 ihex 输出会省掉整段 0x00，烧这种 hex 会漏字节。
 */
export function findGaps(regions){
  if (Array.isArray(regions?.gaps)) return regions.gaps;   // mergeSegs 已经记下来的（准确）
  const out = [];
  const sorted = [...regions].sort((a, b) => a.addr - b.addr);
  for (let i = 1; i < sorted.length; i++){
    const prevEnd = sorted[i - 1].addr + sorted[i - 1].data.length;
    if (sorted[i].addr > prevEnd) out.push({ addr: prevEnd, length: sorted[i].addr - prevEnd });
  }
  return out;
}

/** 按扩展名解析；bin 用调用方给的基地址 */
export function parseFirmware(name, u8, base){
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.elf') || n.endsWith('.axf') || n.endsWith('.out')) return parseElfImage(u8);
  if (n.endsWith('.hex') || n.endsWith('.ihex')) return parseIntelHex(new TextDecoder().decode(u8));
  if (!base) throw new Error('.bin 没有地址信息：请填基地址（STM32 通用默认 0x08000000）');
  return [{ addr: base >>> 0, data: u8 }];
}
