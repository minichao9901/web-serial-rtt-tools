import assert from 'node:assert/strict';
import { buildRequest, CMD, RESET_IO_ACT, resetIoData, parseResetIoResponse } from '../../app/hid/probe.js';

assert.deepEqual([...resetIoData(RESET_IO_ACT.GET)], [0, 0]);
assert.deepEqual([...resetIoData(RESET_IO_ACT.SET_NRST_MODE, 1)], [1, 1]);
assert.deepEqual([...resetIoData(RESET_IO_ACT.SET_NRST_MODE, 0)], [1, 0]);

const get = buildRequest(CMD.RESET_IO, resetIoData(RESET_IO_ACT.GET));
assert.deepEqual([...get.subarray(0, 5)], [3, CMD.RESET_IO, 0, 0, 0]);

assert.deepEqual(parseResetIoResponse(Uint8Array.of(4, CMD.RESET_IO, 0, 1, 3)), {
  openDrain: true, supportsMode: true, dualReset: true, pa27Configurable: false, capabilities: 3,
});
assert.deepEqual(parseResetIoResponse(Uint8Array.of(4, CMD.RESET_IO, 0, 0, 1)), {
  openDrain: false, supportsMode: true, dualReset: false, pa27Configurable: false, capabilities: 1,
});
assert.throws(() => parseResetIoResponse(Uint8Array.of(1, 0, 0)), /固件不支持/);
assert.throws(() => parseResetIoResponse(Uint8Array.of(4, CMD.RESET_IO, 0xff, 0, 0)), /板型不支持/);
assert.throws(() => parseResetIoResponse(Uint8Array.of(4, CMD.RESET_IO, 0xfe, 0, 0)), /未知/);

console.log('reset-io-protocol: HID 0x3A request, response, capability, and legacy-firmware parsing PASS');

assert.equal(parseResetIoResponse(Uint8Array.of(4, CMD.RESET_IO, 0, 1, 7)).pa27Configurable, true);
for (const bytes of [[4,58], [4,58,0,2,7], [3,58,0,1,7]]) assert.throws(() => parseResetIoResponse(Uint8Array.from(bytes)), /格式|完整/);
