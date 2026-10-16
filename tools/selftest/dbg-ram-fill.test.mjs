import assert from 'node:assert/strict';
import {runCmd, Cancelled} from '../../app/dbg/cmd.js';
import {completeLine} from '../../app/dbg/complete.js';
import {ramFillRequest, ramFillChunk} from '../../app/dbg/ram-fill.js';
import {DebugSession} from '../../app/dbg/session.js';

assert.equal(completeLine('fill_r').value, 'fill_ram ');
assert.equal(completeLine('fill_i').value, 'fill_inc ');
assert.deepEqual([...ramFillChunk(ramFillRequest('fill_inc',['0','8','254']),0,8)], [254,255,0,1,2,3,4,5]);
assert.deepEqual([...ramFillChunk(ramFillRequest('fill_inc',['0','8','254']),3,3)], [1,2,3]);
assert.equal(ramFillRequest('fill_inc',['0','3']).value,0);

const memory=new Uint8Array(10000).fill(0x55), writes=[];
const session={connected:true,memWrite:async(a,b)=>{writes.push([a,b.length]);memory.set(b,a);},memRead:async(a,n)=>memory.slice(a,a+n)};
await runCmd('fill_ram 3 9001 0xA5',session);
assert.deepEqual(writes,[[3,4096],[4099,4096],[8195,809]]);
assert.ok(memory.slice(3,9004).every(b=>b===0xa5));assert.equal(memory[2],0x55);assert.equal(memory[9004],0x55);
await runCmd('fill_inc 3 9001 0xFE',session);
assert.ok(memory.slice(3,9004).every((b,i)=>b===((254+i)&255)));assert.equal(memory[2],0x55);assert.equal(memory[9004],0x55);
await runCmd('fill_inc 5 3',session);assert.deepEqual([...memory.slice(5,8)],[0,1,2]);

const noWrite={connected:true,memWrite:async()=>assert.fail('bad request must not write')};
for(const line of ['fill_ram','fill_ram 0 2','fill_ram 0 2 1 extra','fill_inc 0','fill_inc 0 2 1 extra',
  'fill_ram -1 1 2','fill_ram 0x100000000 1 2','fill_ram 0 0 1','fill_inc 0 -1','fill_inc 0 1.5',
  'fill_ram 0 1 256','fill_inc 0 1 -1','fill_inc 0xffffffff 2','fill_ram 0 9007199254740993 1','fill_ram 0 1 junk'])
  await assert.rejects(runCmd(line,noWrite),Error,line);
await assert.rejects(runCmd('fill_inc 0 1',{connected:false}),/连接目标/);
let last;
await runCmd('fill_ram 0xffffffff 1 255',{connected:true,memWrite:async(a,b)=>{last=[a,...b];},memRead:async()=>Uint8Array.of(255)});
assert.deepEqual(last,[0xffffffff,255]);
await assert.rejects(runCmd('fill_ram 0 4 7',{...session,memRead:async()=>Uint8Array.of(7,7,9,7)}),/0x00000002.*已核对 0 \/ 4/);
await assert.rejects(runCmd('fill_inc 0 4',{...session,memRead:async()=>Uint8Array.of(0,1,2)}),/回读长度不足/);
let count=0,stop=false;
await assert.rejects(runCmd('fill_inc 0 9001',{...session,memWrite:async(a,b)=>{count++;memory.set(b,a);},memRead:async(a,n)=>{stop=true;return memory.slice(a,a+n);}},{signal:()=>stop}),e=>e instanceof Cancelled&&e.message.includes('已写入的内容保留'));
assert.equal(count,1);
await assert.rejects(runCmd('fill_ram 0 4 7',{...session,memWrite:async()=>{throw Error('SWD fault');}}),/SWD fault.*已核对/);

const target=new DebugSession();await target.connect({mock:true});
try {
  const pc=target.pc,halted=target.halted,sym=target.sym;
  await runCmd('fill_ram 0x20001001 9001 90',target);
  assert.ok((await target.memRead(0x20001001,9001)).every(b=>b===90));
  await runCmd('fill_inc 0x20001001 9001 0xFD',target);
  assert.ok((await target.memRead(0x20001001,9001)).every((b,i)=>b===((253+i)&255)));
  assert.equal(target.pc,pc);assert.equal(target.halted,halted);assert.equal(target.sym,sym);
  const help=await runCmd('h',target);assert.ok(help.lines.some(l=>l.t.includes('fill_ram'))&&help.lines.some(l=>l.t.includes('fill_inc')));
} finally {await target.disconnect();}
console.log('dbg-ram-fill: repeated/incrementing bytes, wrap, unaligned ranges, 9KB chunking, bounds, readback failure, cancellation and DebugSession state PASS');
