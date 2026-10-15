import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<html><body><div id="f-status"></div><div id="f-log"></div><div id="f-ram-result"></div><div id="toasts"></div></body></html>');
globalThis.document = document;
const { FlashView } = await import('../../app/flash/view.js');
const { WebUsbDapProbe } = await import('../../app/rtt/dap-webusb.js');

function fakeProbe({ initiallyHalted = false, corruptRead = false } = {}){
  let halted = initiallyHalted;
  let disconnected = false;
  let verifyWrites = true;
  const memory = new Map();
  const calls = { halt: 0, run: 0, writes: 0, reads: 0, reset: 0, disconnect: 0 };
  return {
    calls,
    get disconnected(){ return disconnected; },
    get verifyWrites(){ return verifyWrites; },
    set verifyWrites(v){ verifyWrites = v; },
    fast: false,
    async isHalted(){ return halted; },
    async halt(){ calls.halt++; halted = true; },
    async run(){ calls.run++; halted = false; },
    async reset(){ calls.reset++; return 'nRESET pulse'; },
    async writeMem(addr, bytes){
      calls.writes++;
      for (let i = 0; i < bytes.length; i++) memory.set((addr >>> 0) + i, bytes[i]);
    },
    async readMem(addr, len){
      calls.reads++;
      const bytes = Uint8Array.from({ length: len }, (_, i) => memory.get((addr >>> 0) + i) ?? 0);
      if (corruptRead && calls.reads === 3) bytes[7] ^= 0xff;
      return bytes;
    },
    async disconnect(){ calls.disconnect++; disconnected = true; },
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
assert.equal(running.probe.calls.reads, 3);
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
assert.match(document.getElementById('f-log').textContent, /全局硬复位完成/);

console.log('flash-sram-flow: SRAM verification/state restore/cleanup and global CMSIS-DAP reset lifecycle PASS');
