import assert from 'node:assert/strict';
import test from 'node:test';
import {SwoCapture} from '../../app/swo/capture.js';
import {FPB,compAddr,encodeComparator} from '../../app/dbg/bp.js';

function rig({address=0x08001234,initiallyHalted=false,alreadyAtEntry=false,foreign=false,haltElsewhere=false}={}){
  const capacity=6,ctrl=(capacity<<4)|(foreign?1:0),memory=new Map([[FPB.CTRL,ctrl],[0xe000edf0,1<<16],[0xe000edf8,alreadyAtEntry?address:0]]);
  for(let i=0;i<capacity;i++)memory.set(compAddr(i),0);
  if(foreign)memory.set(compAddr(1),encodeComparator(0x08000400,1));
  let halted=initiallyHalted,started=false,polls=0,pc=alreadyAtEntry?address:0;
  const probe={device:{serialNumber:'fake'},isHalted:async()=>{
    if(started&&!halted&&++polls>=3){halted=true;pc=haltElsewhere?0x08000400:address;}
    return halted;
  },run:async()=>{started=true;halted=false;},halt:async()=>{halted=true;},
    readMemDiagnostic:async a=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,memory.get(a)||0,true);return b;},
    writeMem:async(a,b)=>{const value=new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);if(a===0xe000edf4){memory.set(0xe000edf8,pc);memory.set(0xe000edf0,(memory.get(0xe000edf0)||0)|(1<<16));}else if(a===FPB.CTRL){const current=memory.get(FPB.CTRL)||0;memory.set(FPB.CTRL,(current&0xfffffff0)|(value&3));}else{memory.set(a,value);if(a>=FPB.COMP0&&a<FPB.COMP0+capacity*4&&(value&1)&&!halted)started=true;}},disconnect:async()=>{}};
  const capture=new SwoCapture();capture.probe=probe;
  return {capture,probe,memory,get halted(){return halted;},get started(){return started;},get pc(){return pc;}};
}

test('one-shot function breakpoint hits and restores its leased FPB comparator',async()=>{
  const r=rig(),hit=await r.capture.runToEntry(0x08001235,'pipeline_scan');
  assert.equal(hit.hitPc,0x08001234);assert.equal(r.halted,true);assert.equal(r.started,true);
  assert.equal(r.memory.get(compAddr(0)),0);assert.equal(r.memory.get(FPB.CTRL)&1,0);
});

test('an existing comparator is preserved while a free slot is leased',async()=>{
  const r=rig({foreign:true}),original=r.memory.get(compAddr(1)),hit=await r.capture.runToEntry(0x08001234,'pipeline_scan');
  assert.equal(hit.hitPc,0x08001234);assert.equal(r.memory.get(compAddr(1)),original);assert.equal(r.memory.get(FPB.CTRL)&1,1);
});

test('already halted at the requested address needs no temporary comparator or run',async()=>{
  const r=rig({initiallyHalted:true,alreadyAtEntry:true}),hit=await r.capture.runToEntry(0x08001234,'pipeline_scan');
  assert.equal(hit.alreadyAtEntry,true);assert.equal(r.started,false);assert.equal(r.memory.get(compAddr(0)),0);
});

test('a different halt is rejected and the temporary comparator is removed',async()=>{
  const r=rig({haltElsewhere:true});
  await assert.rejects(r.capture.runToEntry(0x08001234,'pipeline_scan'),/不是所选采集起点/);
  assert.equal(r.memory.get(compAddr(0)),0);assert.equal(r.halted,true);
});

test('no free comparator fails without changing foreign breakpoint state',async()=>{
  const r=rig();r.memory.set(FPB.CTRL,r.memory.get(FPB.CTRL)|1);for(let i=0;i<6;i++)r.memory.set(compAddr(i),encodeComparator(0x08001000+i*2,1));
  const before=[...Array(6)].map((_,i)=>r.memory.get(compAddr(i)));
  await assert.rejects(r.capture.runToEntry(0x08001234,'pipeline_scan'),/没有空闲硬件断点槽位/);
  assert.deepEqual([...Array(6)].map((_,i)=>r.memory.get(compAddr(i))),before);
});
