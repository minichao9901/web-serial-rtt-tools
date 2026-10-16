import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<html><body><div id="f-status"></div><div id="f-log"></div><div id="toasts"></div></body></html>');
globalThis.document = document;
globalThis.requestAnimationFrame = fn => setImmediate(fn);

const { FlashView } = await import('../../app/flash/view.js');
const { WebUsbDapProbe } = await import('../../app/rtt/dap-webusb.js');

const calls = [];
const probe = {
  async _ctrl(command, payload){
    calls.push({ command, payload: [...payload] });
    if (command === 0x02) return Uint8Array.of(1);
    return Uint8Array.of(payload[0]);
  },
  async disconnect(){ calls.push({ disconnect: true }); },
};
WebUsbDapProbe.authorized = async () => [{ fake: true }];
WebUsbDapProbe.open = async () => probe;

const view = new FlashView();
assert.equal(await view.resetTarget(), true);
assert.deepEqual(calls.filter(call => call.command === 0x10).map(call => call.payload[0]), [0, 0x80],
  'global reset asserts nRESET and always releases it');
assert.equal(calls.filter(call => call.disconnect).length, 1, 'close the probe after reset');
assert.match(document.getElementById('f-log').textContent, /全局硬复位脉冲已发送/);

console.log('flash-reset-flow: global CMSIS-DAP reset lifecycle and probe cleanup PASS');
