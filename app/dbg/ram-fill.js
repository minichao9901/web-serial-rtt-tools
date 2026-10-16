/** Byte-based RAM patterns. Validate without the wrapping used by register values. */
export function ramFillRequest(command, args){
  const incremental = command === 'fill_inc';
  const usage = incremental ? 'fill_inc 地址 长度 [起始值]' : 'fill_ram 地址 长度 值';
  if (incremental ? args.length < 2 || args.length > 3 : args.length !== 3)
    throw new Error('用法：' + usage);
  const integer = (text, label, max) => {
    if (!/^(?:0x[0-9a-f]+|0b[01]+|0o[0-7]+|[0-9]+)$/i.test(text)) throw new Error(`${label}无效：${text}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${label}超出范围：${text}`);
    return value;
  };
  const address = integer(args[0], '地址', 0xffffffff);
  const length = integer(args[1], '长度', 0x100000000);
  const value = integer(args[2] ?? '0', '字节值（0–255）', 255);
  if (!length) throw new Error('长度必须大于 0（单位：字节）');
  if (address + length > 0x100000000) throw new Error('填充范围越过 32 位地址边界');
  return { address, length, value, incremental };
}

export function ramFillChunk(request, offset, count){
  const bytes = new Uint8Array(count);
  if (request.incremental){
    for (let i = 0; i < count; i++) bytes[i] = (request.value + offset + i) & 255;
  } else bytes.fill(request.value);
  return bytes;
}
