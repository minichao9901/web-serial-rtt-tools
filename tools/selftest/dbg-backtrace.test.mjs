import assert from 'node:assert/strict';
import { prel31, exidxEntry, unwindBytes, unwindFrame, backtrace } from '../../app/dbg/backtrace.js';
import { ARM_ARCH } from '../../app/dbg/thumb.js';
import { runCmd } from '../../app/dbg/cmd.js';
const code=0x08001000, tab=0x08002000, sp=0x20000000;
const u32=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);return b;};
function elfFor(values){
  const b=new Uint8Array(values.length*8),dv=new DataView(b.buffer);
  values.forEach((v,i)=>{dv.setUint32(i*8,(code+i*0x100-tab-i*8)&0x7fffffff,true);dv.setUint32(i*8+4,v,true);});
  return {section:n=>n==='.ARM.exidx'?{addr:tab}:null,data:()=>b,
    sections:()=>[{addr:code,size:0x400,flags:6}],bytesAt:(a,n)=>{
      if(a>=code && a+n<=code+0x400){
        const out=new Uint8Array(n); if(a===code && n===4) out.set([0,0xf0,0,0xf8]);return out;
      } return null;
    }};
}
function session(values=[0x80a8b0b0,0x80a8b0b0,1]){
  const mem=new Map([[sp,5],[sp+4,code+0x111],[sp+8,6],[sp+12,code+0x211]]);
  const regs={SP:sp,PC:code+0x10,LR:code+0x333,PSP:sp+0x1000};
  const elf=elfFor(values);
  return {connected:true,halted:true,arch:ARM_ARCH,pc:regs.PC,mem,regs,
    sym:{elf,nameOf:a=>'function_'+Math.floor((a-code)/0x100),at:a=>({file:'main.c',line:Math.floor((a-code)/0x100)+1})},
    refresh:async()=>{},readReg:async n=>regs[n]??0,
    memRead:async(a,n)=>{const out=new Uint8Array(n);for(let i=0;i<n;i+=4){if(!mem.has(a+i))throw new Error('FAULT');out.set(u32(mem.get(a+i)),i);}return out;},
    backtrace(opts){return backtrace(this,opts);}};
}
assert.equal(prel31(0x7ffffffc,100),96); assert.equal(prel31(4,0xfffffffe),2);
const s=session();
const result=await backtrace(s);
assert.equal(result.frames.length,3); assert.match(result.reason,/CANTUNWIND/);
assert.deepEqual(result.frames.map(x=>x.sp),[sp,sp+8,sp+16]);
assert.deepEqual(result.frames.map(x=>x.loc.line),[1,2,3]);
assert.equal((await backtrace(s,{depth:2})).frames.length,2);
assert.equal((await backtrace(s,{depth:1,scan:true})).frames.length,1);
assert.equal((await runCmd('bt 2',s)).backtrace.frames.length,2);
await assert.rejects(()=>runCmd('bt 0',s),/1..64/);
await assert.rejects(()=>backtrace(s,{stackBytes:33}),/对齐/);
await assert.rejects(()=>runCmd('bt scan nope',s),/1..64/);
s.halted=false;await assert.rejects(()=>backtrace(s),/先暂停/);s.halted=true;
await assert.rejects(()=>backtrace(s,{signal:()=>true}),e=>e.cancelled);
const missing=session();missing.sym.elf=elfFor([]);
assert.match((await backtrace(missing)).reason,/缺少/);
const entryStop=session();entryStop.regs.PC=code; assert.match((await backtrace(entryStop)).reason,/函数入口/);
const fault=session();fault.mem.clear(); assert.match((await backtrace(fault)).reason,/FAULT/);
const reserved=session([0x80ffb0b0]);assert.match((await backtrace(reserved)).reason,/opcode/);
const loop=session([0x80b0b0b0]);loop.regs.LR=loop.regs.PC|1;
assert.match((await backtrace(loop)).reason,/进展|循环|LR 不可恢复/);
// Register pops, delayed r13 update, explicitly popped zero PC, reserved/truncated opcodes.
const r=new Uint32Array(16);r[13]=sp;r[14]=code|1;r[7]=sp+32;
const valid=(a,n)=>a>=sp&&a+n<=sp+256&&a%4===0;
assert.equal((await unwindFrame(r,[0x97,0xb0],async()=>0,valid))[13],sp+32);
const popped=await unwindFrame(r,[0x8a,0x00,0xb0],async a=>a===sp?sp+64:0,valid);
assert.equal(popped[13],sp+64);assert.equal(popped[15],0);
await assert.rejects(()=>unwindFrame(r,[0x80],async()=>0,valid),/截断/);
await assert.rejects(()=>unwindFrame(r,[0x80,0],async()=>0,valid),/拒绝/);
await assert.rejects(()=>unwindFrame(r,[0xb2,255,255,255,255,127],async()=>0,valid),/过长|边界/);
assert.equal((await unwindFrame(r,[0xd0,0xb0],async()=>0,valid))[13],sp+8);
// Out-of-line compact personality 1, extra words and bad extab references.
const extElf=elfFor([0]);const exaddr=tab+0x100;
extElf.bytesAt=(a,n)=>a===exaddr?u32(0x8101a8b0):a===exaddr+4?u32(0xb0b0b0b0):null;
const entry={value:(exaddr-tab-4)&0x7fffffff,place:tab+4};
assert.deepEqual(unwindBytes(extElf,entry),[0xa8,0xb0,0xb0,0xb0,0xb0,0xb0]);
assert.throws(()=>unwindBytes(elfFor([]),entry),/无效/);
// Basic MSP and extended PSP exception frames, including stack alignment padding.
for(const exc of [0xfffffff9,0xffffffed]){
  const e=session([0x80b0b0b0]); e.regs.LR=exc;
  const base=(exc&4)?e.regs.PSP:sp, offset=(exc&16)?0:72;
  [1,2,3,4,5,code+0x211,code+0x210,0x01000200].forEach((v,i)=>e.mem.set(base+i*4,v));
  const bt=await backtrace(e);assert.equal(bt.frames[1].kind,'exception');
  assert.equal(bt.frames[1].pc,code+0x210);assert.equal(bt.frames[1].sp,base+offset+36);
}
const scan=session();scan.regs.LR=code+5; scan.mem.clear();
for(let i=0;i<4096;i+=4) scan.mem.set(sp+i,i===4?code+5:0);
const candidates=await backtrace(scan,{scan:true});
assert.equal(candidates.frames.length,3); assert.equal(candidates.frames[1].kind,'candidate');
assert.match(candidates.reason,/不是已证实/);
const edge=session();edge.regs.LR=code+5;edge.mem.clear();edge.mem.set(sp,code+5);
const partial=await backtrace(edge,{scan:true});
assert.equal(partial.frames.length,3); assert.match(partial.reason,/读取边界/);
const rv=session();rv.arch={...ARM_ARCH,name:'riscv'};
assert.match((await backtrace(rv)).reason,/RISC-V/);
console.log('dbg-backtrace: EHABI tables/opcodes, symbols, depth, faults/bounds, cycle, cancellation, exceptions, scan labeling PASS');
