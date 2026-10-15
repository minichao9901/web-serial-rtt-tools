import assert from 'node:assert/strict';
import { FlashDataClock } from '../../app/flash/data-clock.js';
import { FlashRunner } from '../../app/flash/runner.js';

function probe({corrupt=false,failWrite=false,failRestore=false}={}){
  let memory=new Uint8Array(),hz=1000000;
  const calls=[];
  return {calls,verifyWrites:true,
    async setClock(value){calls.push(['clock',value]);if(value===1000000&&failRestore)throw new Error('restore failed');hz=value;},
    async writeMem(_addr,bytes){calls.push(['write',hz,this.verifyWrites]);if(failWrite)throw new Error('wire failed');memory=bytes.slice();},
    async readMem(){calls.push(['read',hz]);const out=memory.slice();if(corrupt)out[0]^=1;return out;},
    async flushWrites(){calls.push(['flush',hz]);},
  };
}
const data=Uint8Array.of(1,2,3,4);
const normal=probe();await new FlashDataClock(normal).writeMem(0x20000000,data);
assert.deepEqual(normal.calls,[['write',1000000,true]],'default flash behavior is unchanged');
const fast=probe();await new FlashDataClock(fast,20000).writeMem(0x20000000,data);
assert.deepEqual(fast.calls,[['clock',20000000],['write',20000000,false],['flush',20000000],['read',20000000],['clock',1000000]]);
assert.equal(fast.verifyWrites,true);
for(const opts of [{corrupt:true},{failWrite:true},{failWrite:true,failRestore:true}]){
  const p=probe(opts),runner=new FlashRunner(p,{clockKhz:45000});
  runner.algo={page_buffers:[0x20000000],pc_program_page:1};let executed=false;
  runner.runCode=async()=>{executed=true;};
  await assert.rejects(runner.programPage(0x08000000,data));
  assert.equal(executed,false,'never execute a flashloader with an unverified RAM buffer');
  assert.equal(p.verifyWrites,true);assert.deepEqual(p.calls.at(-1),['clock',1000000]);
}
const readProbe=probe();await new FlashDataClock(readProbe,36000).readMem(0x08000000,4);
assert.deepEqual(readProbe.calls,[['clock',36000000],['read',36000000],['clock',1000000]]);
console.log('flash-data-clock: selected data clock, 1MHz control restore, strict RAM integrity and failure before programming PASS');
