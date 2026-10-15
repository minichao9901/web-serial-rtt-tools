import assert from 'node:assert/strict';
import { pulseTargetReset } from '../../app/flash/target-reset.js';

for(const failure of [null,'assert','release','both','empty']){
  const calls=[];let assertedAt=0;
  const probe={async _ctrl(cmd,payload){
    calls.push([cmd,...payload]);
    if(cmd===2)return Uint8Array.of(1); // _ctrl strips the command echo.
    assert.deepEqual([...payload.subarray(1)],payload[0] ? [128,0x50,0xc3,0,0] : [128,0,0,0,0]);
    if(payload[0]===0){
      assertedAt=performance.now();
      if(failure==='assert'||failure==='both')throw new Error('assert failed');
    }else if(!failure)assert.ok(performance.now()-assertedAt>=18,'hold reset low for 20ms, independent of pin-match wait');
    if(payload[0]===128&&(failure==='release'||failure==='both'))throw new Error('release failed');
    return failure==='empty'?new Uint8Array():Uint8Array.of(payload[0]);
  }};
  if(failure)await assert.rejects(pulseTargetReset(probe));
  else await pulseTargetReset(probe);
  assert.deepEqual(calls.map(c=>[c[0],c[1]]),[[2,1],[16,0],[16,128]],'always attempt release after asserting reset');
}
console.log('target-reset: real pulse duration, CMSIS-DAP framing, failed assert/release and empty responses PASS');
