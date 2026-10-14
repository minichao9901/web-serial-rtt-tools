/** 字节/整数小工具（全部按小端，目标芯片都是 LE）。 */

export function u32le(b, off = 0){
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

export function u32leBytes(v){
  const b = new Uint8Array(4);
  b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; b[2] = (v >>> 16) & 0xff; b[3] = (v >>> 24) & 0xff;
  return b;
}

/** 8 位干净地转字符（不会把 >127 的字节当成 UTF-8 拆坏） */
export function latin1(bytes){
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096){
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 4096, bytes.length)));
  }
  return s;
}

/** 以 0 结尾的 C 字符串 */
export function cstr(bytes){
  const i = bytes.indexOf(0);
  return latin1(i >= 0 ? bytes.subarray(0, i) : bytes);
}

export function concat(a, b){
  if (!a?.length) return b;
  if (!b?.length) return a;
  const o = new Uint8Array(a.length + b.length);
  o.set(a); o.set(b, a.length);
  return o;
}

export const hex = (n, w = 8) => '0x' + (n >>> 0).toString(16).padStart(w, '0');

/** "0x20000000-0x20020000, 0x2f000000-0x2f080000" → [{start,end}] */
export function parseRanges(text){
  const out = [];
  for (const part of String(text || '').split(/[,;]/)){
    const m = part.trim().match(/^(0x[0-9a-f]+|\d+)\s*(?:-\s*(0x[0-9a-f]+|\d+))?$/i);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : start + 0x10000;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end });
  }
  return out;
}

export const toU8 = v => v instanceof Uint8Array ? v : new Uint8Array(v);
