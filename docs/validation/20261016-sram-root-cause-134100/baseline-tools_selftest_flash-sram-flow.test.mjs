import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<html><body><div id="f-status"></div><div id="f-log"></div><div id="f-ram-result"></div><div id="toasts"></div></body></html>');
globalThis.document = document;
globalThis.requestAnimationFrame = fn => setImmediate(fn);
const { FlashView } = await import('../../app/flash/view.js');
const { WebUsbDapProbe } = await import('../../app/rtt/dap-webusb.js');

function fakeProbe({ initiallyHalted = false, corruptRead = false, corruptAt = 3, failResume = false, failClose = false, failState = false, shortRead = false } = {}){
  let halted = initiallyHalted;
  let disconnected = false;
  let verifyWrites = true;
  const memory = new Map();
  const calls = { halt: 0, run: 0, writes: 0, reads: 0, reset: 0, disconnect: 0, recover: 0, clocks: [] };
  return {
    calls,
    get disconnected(){ return disconnected; },
    get verifyWrites(){ return verifyWrites; },
    set verifyWrites(v){ verifyWrites = v; },
    fast: false,
    async isHalted(){ return halted; },
    async setClock(hz){ calls.clocks.push(hz); },
    async recoverDebugPort(){ calls.recover++; },
    async halt(){ calls.halt++; halted = true; },
    async run(){ calls.run++; if (failResume) throw new Error('resume failed'); halted = false; },
    async _ctrl(cmd, payload){
      if (cmd === 2) return Uint8Array.of(1);
      if (payload[0] === 0) calls.reset++;
      return Uint8Array.of(payload[0]);
    },
    async writeMem(addr, bytes){
      calls.writes++;
      for (let i = 0; i < bytes.length; i++) memory.set((addr >>> 0) + i, bytes[i]);
    },
    async readMem(addr, len){
      if (addr === 0xE000EDF0){ if (failState) throw new Error('state read failed'); return Uint8Array.of(0, 0, halted ? 2 : 0, 0); }
      calls.reads++;
      const bytes = Uint8Array.from({ length: len }, (_, i) => memory.get((addr >>> 0) + i) ?? 0);
      if (corruptRead && calls.reads === corruptAt) bytes[7] ^= 0xff;
      return shortRead ? bytes.subarray(0, bytes.length - 1) : bytes;
    },
    async disconnect(){ calls.disconnect++; if (failClose) throw new Error('close failed'); disconnected = true; },
  };
}

async function exercise(opts){
  const probe = fakeProbe(opts);
  WebUsbDapProbe.authorized = async () => [{ fake: true }];
  WebUsbDapProbe.open = async () => probe;
  const view = new FlashView();
  const result = await view._benchmarkSramOnce(0x24080000, 20 * 1024);
  return { result, probe, log: document.getElementById('f-log').textContent };
}

const running = await exercise({ initiallyHalted: false });
assert.equal(running.result.verified, true);
assert.equal(running.result.passes, 3);
assert.equal(running.probe.calls.writes, 3);
assert.equal(running.probe.calls.reads, 6);
assert.equal(running.probe.calls.run, 1, 'resume a target that was running when the test started');
assert.equal(running.probe.verifyWrites, true, 'restore the DAP write-verification setting');
assert.equal(running.probe.disconnected, true, 'close the probe after the test');
assert.match(running.log, /SRAM 测速.*数据校验通过/);

document.getElementById('f-log').textContent = '';
const halted = await exercise({ initiallyHalted: true });
assert.equal(halted.result.verified, true);
assert.equal(halted.probe.calls.run, 0, 'leave a target halted if it was halted before the test');

document.getElementById('f-log').textContent = '';
const failedProbe = fakeProbe({ initiallyHalted: false, corruptRead: true });
WebUsbDapProbe.authorized = async () => [{ fake: true }];
WebUsbDapProbe.open = async () => failedProbe;
const failedView = new FlashView();
await assert.rejects(failedView._benchmarkSramOnce(0x24080000, 20 * 1024), /校验失败/);
assert.equal(failedProbe.calls.run, 1, 'resume the target even after a failed integrity check');
assert.equal(failedProbe.disconnected, true, 'close the probe after a failed test');

const resetProbe = fakeProbe();
WebUsbDapProbe.authorized = async () => [{ fake: true }];
WebUsbDapProbe.open = async () => resetProbe;
const resetView = new FlashView();
assert.equal(await resetView.resetTarget(), true);
assert.equal(resetProbe.calls.reset, 1, 'global reset sends a hard nRESET pulse through CMSIS-DAP');
assert.equal(resetProbe.disconnected, true, 'close the probe after global reset');
assert.match(document.getElementById('f-log').textContent, /全局硬复位脉冲已发送/);

console.log('flash-sram-flow: SRAM verification/state restore/cleanup and global CMSIS-DAP reset lifecycle PASS');

for (const [opts, error] of [
  [{corruptRead:true,corruptAt:1}, /校验失败/],
  [{corruptRead:true,corruptAt:4}, /校验失败/],
  [{shortRead:true}, /长度不完整/],
  [{failResume:true}, /resume failed/],
  [{failClose:true}, /close failed/],
  [{failState:true}, /state read failed/],
]){
  document.getElementById('f-log').textContent='';
  const p=fakeProbe(opts);
  WebUsbDapProbe.open=async()=>p;
  const v=new FlashView();
  await assert.rejects(v._benchmarkSramOnce(0x24080000,20480),error);
  assert.doesNotMatch(document.getElementById('f-log').textContent,/数据校验通过/, 'never publish success before cleanup');
  assert.equal(p.calls.disconnect,1);
  if(opts.failState) assert.equal(p.calls.writes,0,'unreadable CPU state forbids SRAM writes');
}
console.log('flash-sram-flow: early corruption, timed-read corruption, short reads, resume/close/state failures PASS');

const autoInput=document.createElement('input');autoInput.id='f-ram-clock';autoInput.value='0';document.body.appendChild(autoInput);
const retryProbe=fakeProbe({corruptRead:true,corruptAt:1});
WebUsbDapProbe.open=async()=>retryProbe;
const retryView=new FlashView();
const retry=await retryView._benchmarkSramOnce(0x24080000,20480);
assert.equal(retry.clockKhz,45000);
assert.equal(retry.failedClocks.length,1);
assert.equal(retry.failedClocks[0].clockKhz,60000);
assert.equal(retryProbe.calls.recover,1);
assert.equal(retryProbe.calls.run,1,'retry never resumes CPU between destructive passes');
assert.equal(retryProbe.calls.clocks.at(-1),1000000,'execution control returns to 1MHz');
console.log('flash-sram-flow: auto clock retries the entire integrity test, records failures, keeps CPU halted, restores control clock PASS');
