import assert from 'node:assert/strict';
import {WebUsbDapProbe,CMD} from '../../app/rtt/dap-webusb.js';
let frame;
const p=Object.create(WebUsbDapProbe.prototype);
p._ctrl=async(cmd,payload)=>{frame=Uint8Array.of(cmd,...payload);return Uint8Array.of(0);};
assert.equal(await p.abort(),true);
assert.deepEqual([...frame],[CMD.WriteABORT,0,0x1e,0,0,0]);
// Firmware ignores request[0] (DAP index), then reads request[1..4].
assert.equal(new DataView(frame.buffer).getUint32(2,true),0x1e);
p._ctrl=async()=>Uint8Array.of(255);assert.equal(await p.abort(),false);
p._ctrl=async()=>{throw Error('disconnected');};assert.equal(await p.abort(),false);
console.log('dap-abort: correct DAP index/value, firmware decode, command failure propagation PASS');
