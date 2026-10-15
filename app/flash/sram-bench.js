import { CHIPS } from '../core/chips.js';

export const SRAM_BENCH_PASSES = 3;
export const SRAM_BENCH_SIZES = Object.freeze([20, 32, 64, 128].map(k => k * 1024));

export function chipRamRanges(chipId){
  const text = CHIPS.find(c => c.v === chipId)?.ram || '';
  return text.split(',').map(s => {
    const m = s.trim().match(/^(0x[\da-f]+)\s*-\s*(0x[\da-f]+)$/i);
    return m ? { start: Number.parseInt(m[1], 16), end: Number.parseInt(m[2], 16) } : null;
  }).filter(Boolean);
}

export function parseSramAddress(text){
  const s = String(text || '').trim();
  if (!/^(?:0x[\da-f]{1,8}|\d+)$/i.test(s)) return NaN;
  return Number(s.toLowerCase().startsWith('0x') ? Number.parseInt(s, 16) : Number(s));
}

export function validateSramBench(chipId, addressText, size){
  const addr = parseSramAddress(addressText);
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xffffffff || (addr & 3))
    throw new Error('起始地址须是 4 字节对齐的有效地址（例如 0x24080000）');
  if (!SRAM_BENCH_SIZES.includes(size)) throw new Error('请选择 20、32、64 或 128 KiB 测试长度');
  const end = addr + size;
  const region = chipRamRanges(chipId).find(r => addr >= r.start && end <= r.end);
  if (!region) throw new Error(`0x${addr.toString(16)}–0x${end.toString(16)} 不在当前芯片的已知 SRAM 区间内`);
  return { addr, size, end, region };
}
