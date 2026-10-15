import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { chipRamRanges, parseSramAddress, validateSramBench, SRAM_BENCH_SIZES } from '../../app/flash/sram-bench.js';

assert.deepEqual(SRAM_BENCH_SIZES, [20480, 32768, 65536, 131072]);
assert.equal(parseSramAddress('0x24080000'), 0x24080000);
assert.equal(parseSramAddress('536870912'), 0x20000000);
assert.ok(Number.isNaN(parseSramAddress('0x240800000')));

const h7Ranges = chipRamRanges('stm32h7b0');
assert.deepEqual(h7Ranges, [
  { start: 0x20000000, end: 0x20020000 },
  { start: 0x24000000, end: 0x24100000 },
]);
assert.equal(validateSramBench('stm32h7b0', '0x24080000', 131072).end, 0x240a0000);
assert.equal(validateSramBench('stm32h7b0', '0x20000000', 20480).region.start, 0x20000000);
assert.throws(() => validateSramBench('stm32h7b0', '0x2001c000', 32768), /不在当前芯片/);
assert.throws(() => validateSramBench('stm32h7b0', '0x24080002', 20480), /4 字节对齐/);
assert.throws(() => validateSramBench('stm32h7b0', '0x08000000', 20480), /不在当前芯片/);
assert.throws(() => validateSramBench('stm32h7b0', '0x24080000', 4096), /测试长度/);
assert.throws(() => validateSramBench('custom', '0x20000000', 20480), /不在当前芯片/);

const page = parseHTML(await readFile(new URL('../../index.html', import.meta.url), 'utf8')).document;
assert.ok(page.getElementById('btn-global-reset'), 'header exposes the global reset button');
assert.ok(page.getElementById('global-trst-open-drain'), 'header exposes the TRST electrical-mode toggle');
assert.ok(page.getElementById('f-sram-bench'), 'flash page exposes the SRAM test panel');
assert.deepEqual([...page.getElementById('f-ram-length').options].map(o => Number(o.value)), SRAM_BENCH_SIZES);

console.log('sram-bench: UI controls, size choices, address parsing, H7 split SRAM bounds, alignment, and flash rejection PASS');
