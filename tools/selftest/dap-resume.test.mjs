import assert from 'node:assert/strict';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';
async function resume(before,states,reasons){
 let writes=0,reads=0;const queue=[...reasons];
 const p={_clearMaskintsIfSet:async()=>{},_dhcsr:async()=>writes++,
  _readWord:async a=>a===0xe000ed30 ? reads++===0?before:queue.shift():states.shift()};
 await WebUsbDapProbe.prototype.run.call(p);return writes;
}
// Genuine vector catch or immediate breakpoint: never resume the stopped site twice.
assert.equal(await resume(0,[0x30003],[8]),1);
assert.equal(await resume(0,[0x30003],[2]),1);
// A stale sticky BKPT plus S_RETIRE_ST still means the next flash call executed.
assert.equal(await resume(2,[0x1030003],[2]),1);
// Dropped write / stale halt without a new stop event: retain the bounded retry.
assert.equal(await resume(0,[0x30003,0x10001],[0]),2);
assert.equal(await resume(2,[0x30003,0x10001],[2]),2);
assert.equal(await resume(0,[0x10001],[]),1);
console.log('dap-resume: immediate vector catch / breakpoint preserved, stale halt retry retained');
