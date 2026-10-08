import assert from 'node:assert/strict';
import { Counter } from '../../app/core/stats.js';

// 真实 SPI/CDC 的小块到达频率超过旧版 4096 事件上限，仍需统计完整一秒。
const c = new Counter();
for (let i = 0; i < 30000; i++) c.add(40, i / 30);
assert.equal(c.total, 1200000);
assert.equal(c.frames, 30000);
assert.equal(c.rate(1000), 1200000);
assert.ok(c._win.length - c._head <= 1001);
assert.equal(c.rate(1500), 600000);
assert.equal(c.rate(2001), 0);

// 不调用 rate 的后台页也须保持有界；长暂停后只计新数据。
c.reset();
for (let i = 0; i < 600000; i++) c.add(40, i / 30);
assert.equal(c.total, 24000000);
assert.equal(c.frames, 600000);
assert.ok(c._win.length <= 2026);
assert.equal(c.rate(20000), 1200000);
c.add(123, 100000);
assert.equal(c.rate(100000), 123);
assert.equal(c.rate(101001), 0);

c.reset();
assert.equal(c.total, 0);
assert.equal(c.frames, 0);
assert.equal(c.rate(0), 0);
c.add(10, 0.1); c.add(20, 0.9);
assert.equal(c.rate(0.9), 30);
assert.equal(c.frames, 2);
console.log('Counter high-event-rate, idle, bounded storage and reset: passed');
