/** OpenOCD image commands: preserve file sections and relocate before clipping. */
export const IMAGE_TYPES = ['bin', 'ihex', 'elf', 's19'];
const ADDRESS_END = 0x100000000;

/** Tcl-style literal words for filenames: quotes, nested braces and backslash escapes. */
export function imageWords(text){
  const words = [];
  let i = 0;
  const escape = () => {
    if (++i >= text.length) throw new Error('命令结尾不能是单独的反斜杠');
    const c = text[i++];
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[c] ?? c;
  };
  while (i < text.length){
    while (/\s/.test(text[i] || '') && i < text.length) i++;
    if (i === text.length) break;
    let word = '';
    const first = text[i];
    if (first === '{'){
      let depth = 1; i++;
      while (i < text.length && depth){
        const c = text[i++];
        if (c === '\\' && i < text.length){ word += c + text[i++]; continue; }
        if (c === '{') depth++;
        if (c === '}') depth--;
        if (depth) word += c;
      }
      if (depth) throw new Error('文件名的大括号未闭合');
    } else if (first === '"'){
      i++;
      while (i < text.length && text[i] !== '"') word += text[i] === '\\' ? escape() : text[i++];
      if (i === text.length) throw new Error('文件名的双引号未闭合');
      i++;
    } else {
      while (i < text.length && !/\s/.test(text[i])) word += text[i] === '\\' ? escape() : text[i++];
    }
    if (i < text.length && !/\s/.test(text[i])) throw new Error('引号或大括号后需要空格');
    words.push(word);
  }
  return words;
}

function number(text, label, { signed = false, end = false } = {}){
  const raw = String(text ?? '');
  const match = /^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|0[0-7]*|[1-9][0-9]*)$/.exec(raw);
  if (!match) throw new Error(`${label}无效：${raw}`);
  const magnitude = /^0[0-7]+$/.test(match[2]) ? parseInt(match[2], 8) : Number(match[2]);
  const value = match[1] === '-' ? -magnitude : magnitude;
  if (!Number.isSafeInteger(value) || value < (signed ? -0xffffffff : 0) || value > (end ? ADDRESS_END : 0xffffffff))
    throw new Error(`${label}超出 32 位目标范围：${raw}`);
  return value;
}

export function imageCommand(command, args){
  const load = command === 'load_image';
  const usage = load
    ? 'load_image filename [address [bin|ihex|elf|s19 [min_addr [max_length]]]]'
    : 'dump_image filename address size';
  if (!args[0] || (load ? args.length > 5 : args.length !== 3)) throw new Error('用法：' + usage);
  const filename = args[0];
  if (!load){
    const address = number(args[1], 'address');
    const size = number(args[2], 'size', { end: true });
    if (address + size > ADDRESS_END) throw new Error('dump_image 地址范围越过 32 位边界');
    return { filename, address, size };
  }
  const offset = args.length > 1 ? number(args[1], 'address', { signed: true }) : 0;
  const type = args[2] ?? null;
  if (type !== null && !IMAGE_TYPES.includes(type)) throw new Error('镜像格式必须是 bin、ihex、elf 或 s19');
  const min = args.length > 3 ? number(args[3], 'min_addr') : 0;
  const length = args.length > 4 ? number(args[4], 'max_length', { end: true }) : null;
  if (length !== null && min + length > ADDRESS_END) throw new Error('min_addr + max_length 越过 32 位边界');
  return { filename, offset, type, min, max: length === null ? Number.MAX_SAFE_INTEGER : min + length };
}

function detect(bytes){
  // OpenOCD probes the first nine bytes, irrespective of filename extension.
  if (bytes.length < 9) return 'bin';
  if (bytes[0] === 0x7f && bytes[1] === 69 && bytes[2] === 76 && bytes[3] === 70) return 'elf';
  const head = new TextDecoder().decode(bytes.subarray(0, 9));
  if (/^:[0-9a-f]{6}0[0-5]/i.test(head)) return 'ihex';
  if (/^S[0-8][0-9a-f]{2}/i.test(head)) return 's19';
  return 'bin';
}

function hexRecord(text, line){
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) throw new Error(`镜像第 ${line} 行不是完整十六进制记录`);
  return Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
}

function ihex(bytes){
  const sections = []; let upper = 0, ended = false;
  for (const [index, raw] of new TextDecoder().decode(bytes).split(/\r?\n/).entries()){
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(':')) throw new Error(`IHEX 第 ${index + 1} 行缺少冒号`);
    const record = hexRecord(line.slice(1), index + 1), size = record[0], kind = record[3];
    if (record.length !== size + 5 || record.reduce((sum, b) => sum + b, 0) % 256 !== 0)
      throw new Error(`IHEX 第 ${index + 1} 行长度或校验和错误`);
    const address = record[1] * 256 + record[2], data = record.subarray(4, 4 + size);
    if (kind === 0) sections.push({ addr: upper + address, data });
    else if (kind === 1 && size === 0){ ended = true; break; }
    else if (kind === 2 && size === 2) upper = (data[0] * 256 + data[1]) * 16;
    else if (kind === 4 && size === 2) upper = (data[0] * 256 + data[1]) * 65536;
    else if (!((kind === 3 || kind === 5) && size === 4)) throw new Error(`IHEX 第 ${index + 1} 行记录类型或长度错误`);
  }
  if (!ended) throw new Error('IHEX 缺少文件结束记录');
  return sections;
}

function srecord(bytes){
  const sections = [];
  const addressBytes = { 0: 2, 1: 2, 2: 3, 3: 4, 5: 2, 6: 3, 7: 4, 8: 3, 9: 2 };
  for (const [index, raw] of new TextDecoder().decode(bytes).split(/\r?\n/).entries()){
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const kind = Number(line[1]), width = addressBytes[kind];
    if (line[0] !== 'S' || !width) throw new Error(`S19 第 ${index + 1} 行记录类型错误`);
    const record = hexRecord(line.slice(2), index + 1);
    if (record.length !== record[0] + 1 || record[0] < width + 1 || record.reduce((sum, b) => sum + b, 0) % 256 !== 255)
      throw new Error(`S19 第 ${index + 1} 行长度或校验和错误`);
    let addr = 0; for (const b of record.subarray(1, 1 + width)) addr = addr * 256 + b;
    if (kind >= 1 && kind <= 3) sections.push({ addr, data: record.subarray(1 + width, record.length - 1) });
    if (kind >= 7) break;
  }
  if (!sections.length) throw new Error('S19 没有可加载数据');
  return sections;
}

function elf(bytes){
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length || size > bytes.length - offset)
      throw new Error('ELF 程序头或数据被截断');
  };
  range(0, 16);
  if (bytes[0] !== 0x7f || bytes[1] !== 69 || bytes[2] !== 76 || bytes[3] !== 70 || ![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5]))
    throw new Error('无效的 ELF 文件');
  const wide = bytes[4] === 2, little = bytes[5] === 1, header = wide ? 64 : 52;
  range(0, header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = offset => view.getUint16(offset, little), u32 = offset => view.getUint32(offset, little);
  const word = offset => {
    if (!wide) return u32(offset);
    const value = view.getBigUint64(offset, little);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ELF 地址或长度超出浏览器可精确表示范围');
    return Number(value);
  };
  const offset = word(wide ? 32 : 28), stride = u16(wide ? 54 : 42), count = u16(wide ? 56 : 44);
  if (!count || stride < (wide ? 56 : 32)) throw new Error('ELF 没有有效程序头表');
  range(offset, stride * count);
  const headers = [];
  for (let i = 0; i < count; i++){
    const at = offset + i * stride;
    headers.push({ type: u32(at), offset: word(at + (wide ? 8 : 4)), virtual: word(at + (wide ? 16 : 8)),
      physical: word(at + (wide ? 24 : 12)), size: word(at + (wide ? 32 : 16)), memory: word(at + (wide ? 40 : 20)) });
  }
  const virtual = headers.every(h => h.physical === 0) && headers.filter(h => h.type === 1 && h.memory > 0).length > 1;
  const sections = headers.filter(h => h.type === 1 && h.size > 0).map(h => {
    range(h.offset, h.size);
    return { addr: virtual ? h.virtual : h.physical, data: bytes.subarray(h.offset, h.offset + h.size) };
  });
  if (!sections.length) throw new Error('ELF 没有带文件内容的 PT_LOAD 段');
  return sections;
}

export function parseImage(bytes, type = null){
  type ??= detect(bytes);
  if (!IMAGE_TYPES.includes(type)) throw new Error('不支持的镜像格式：' + type);
  const sections = type === 'bin' ? [{ addr: 0, data: bytes }] : type === 'ihex' ? ihex(bytes) : type === 's19' ? srecord(bytes) : elf(bytes);
  return { type, sections };
}

export function imageLoadPlan(image, { offset = 0, min = 0, max = Number.MAX_SAFE_INTEGER } = {}){
  const plan = [];
  for (const section of image.sections){
    const start = section.addr + offset, end = start + section.data.length;
    const from = Math.max(start, min), to = Math.min(end, max);
    if (to <= from) continue;
    if (!Number.isSafeInteger(start) || from < 0 || to > ADDRESS_END) throw new Error('load_image 地址范围越过 32 位边界');
    plan.push({ addr: from, data: section.data.subarray(from - start, to - start) });
  }
  return plan;
}
