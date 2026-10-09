import assert from 'node:assert/strict';
import { waitForFirstRttData, waitForNextRttPoll } from './rtt-campaign-wait.mjs';
let passed = 0;
async function run(states, timeoutMs = 25000){
  let time = 0, i = 0;
  const pauses = [];
  const result = await waitForFirstRttData({
    readState: async () => states[Math.min(i++, states.length - 1)],
    pause: async ms => { pauses.push(ms); time += ms; },
    now: () => time, timeoutMs,
  });
  return { result, pauses };
}
const pending = { polls: 0, bytes: 0, running: true, error: false,
  err: '控制块 0x1240000，上行缓冲 32768 B（固件声明 3 个上行通道，本页读 ch0）' };
const ready = { ...pending, polls: 1, bytes: 32767 };
const observed = await run([pending, pending, ready]);
assert.equal(observed.result.bytes, 32767);
assert.deepEqual(observed.pauses, [400, 400]);
passed++;
// A successful status remains visible for the whole first read; it is not a fault.
assert.equal((await run(Array(20).fill(pending).concat(ready))).pauses.length, 20);
passed++;
assert.equal((await run([{ ...pending, polls: 1 }, ready])).result.bytes, 32767);
passed++;
await assert.rejects(run([{ ...pending, running: false, error: true, err: '读取失败：DMI_INVALID' }]), /轮询已停止.*DMI_INVALID/);
passed++;
await assert.rejects(run([pending], 800), /首轮没跑起来:|首轮没跑起来：/);
passed++;
await assert.rejects(run([{ ...pending, slow: true, health: { slow: true } }]), /链路偏慢/);
passed++;
// A still-running page may legitimately recover an error itself; the harness only observes.
assert.equal((await run([{ ...pending, error: true, err: '正在自愈' }, ready])).result.bytes, 32767);
passed++;
async function boundary(states, timeoutMs = 5000){
  let time = 0, i = 0;
  return waitForNextRttPoll({ readState: async () => states[Math.min(i++, states.length - 1)],
    pause: async ms => { time += ms; }, now: () => time, timeoutMs });
}
assert.equal((await boundary([ready, ready, { ...ready, polls: 2, bytes: 65534 }])).bytes, 65534); passed++;
await assert.rejects(boundary([ready, { ...ready, running: false, err: '读取失败' }]), /轮询已停止/); passed++;
await assert.rejects(boundary([ready, { ...ready, polls: 0, bytes: 0 }]), /统计已重置/); passed++;
await assert.rejects(boundary([ready], 20), /完整轮询超时/); passed++;
await assert.rejects(boundary([ready, { ...ready, polls: 2, bytes: 0 }]), /统计已重置/); passed++;
console.log(`RTT campaign wait: ${passed} passed`);
