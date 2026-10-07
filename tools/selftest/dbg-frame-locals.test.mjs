/** Real ARM GCC ELF + synthetic adverse cases; no connected target required. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Elf} from '../../app/elf/elf.js';
import {Dwarf} from '../../app/elf/dwarf.js';
import {cfiRow,unwindCfi,Reader} from '../../app/dbg/cfi.js';
import {frameLocals,evaluateLocation,inScope} from '../../app/dbg/locals.js';
import {backtrace} from '../../app/dbg/backtrace.js';
import {DebugSession} from '../../app/dbg/session.js';
import {runCmd} from '../../app/dbg/cmd.js';
import {ARM_ARCH} from '../../app/dbg/thumb.js';
const u32=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);return b;};
// Fixed readelf addresses below belong to this snapshot. A full_flow rebuild
// can change compiler layout in the downloadable target ELF independently.
const elf=new Elf(new Uint8Array(readFileSync(new URL('./fixtures/dbg-locals-arm.elf',import.meta.url))));
const dwarf=new Dwarf(elf);
const sp=0x20001000,pc=0x080001d0;
// Independent readelf contract: engine_linear uses r7+24 as CFA after its prologue.
const row=cfiRow(elf,pc);assert.equal(row.reg,7);assert.equal(row.offset,24);
assert.deepEqual(row.rules.get(14),{kind:'offset',v:-4});
assert.equal(cfiRow(elf,0x0800017c).offset,0);
assert.equal(cfiRow(elf,0x0800017e).offset,8);
assert.equal(cfiRow(elf,0x08000214).reg,13);
assert.equal(cfiRow(elf,0x08000214).offset,8);
const regs=Array(16).fill(0);regs[7]=sp;regs[13]=sp;regs[14]=0x08000301;regs[15]=pc;
const known=new Set(regs.map((_,i)=>i));
const memory=new Map([[sp,123],[sp+4,0x20000200],[sp+12,77],[sp+16,0x20001040],[sp+20,0x08000301]]);
const reads=[];
const read=async(a,n)=>{reads.push([a,n]);assert.equal(n,4);if(!memory.has(a))throw new Error('FAULT');return u32(memory.get(a));};
const session={halted:true,connected:true,pc,arch:ARM_ARCH,sym:{elf,dwarf},memRead:read,refresh:async()=>{},readReg:async n=>n==='SP'?sp:n==='PC'?pc:n==='LR'?regs[14]:regs[Number(n.slice(1))]};
const result=await frameLocals(session,{regs,known:[...known],lookup:pc,cfa:sp+24,kind:'current'});
const values=Object.fromEntries(result.rows.map(r=>[r.name,r]));
assert.equal(values.seed.value,'123');assert.equal(values.slot.value,String(0x20000200));assert.equal(values.a.value,'77');
assert.equal(values.seed.argument,true);assert.equal(values.a.argument,false);
// Earlier PC: compiler location lists put these arguments in registers instead.
regs[0]=0x20000300;regs[1]=456;
const early=await frameLocals(session,{regs,known:[...known],lookup:0x08000184,cfa:sp+24});
assert.equal(early.rows.find(r=>r.name==='seed').value,'456');
assert.equal(early.rows.find(r=>r.name==='slot').value,String(0x20000300));
const lost=await frameLocals(session,{regs,known:[4,7,13,14,15],lookup:0x08000184,cfa:sp+24});
assert.match(lost.rows.find(r=>r.name==='seed').error,/不可恢复/);
const unwound=await unwindCfi(regs,known,row,async a=>new Reader(await read(a,4)).uint(4),(a,n)=>a>=sp&&a+n<=sp+128&&a%4===0);
assert.equal(unwound.regs[13],sp+24);assert.equal(unwound.regs[7],sp+64);assert.equal(unwound.regs[15],0x08000301);
assert.equal(unwound.known.has(0),false);assert.equal(unwound.known.has(1),false);
const bt=await backtrace(session,{depth:2});
assert.equal(bt.frames.length,2);assert.equal(bt.frames[0].cfa,sp+24);assert.equal(bt.frames[1].kind,'cfi');assert.equal(bt.frames[1].known.includes(0),false);
assert.equal((await backtrace(session,{depth:1})).frames[0].cfa,sp+24);
await assert.rejects(()=>frameLocals({...session,halted:false},bt.frames[0]),/暂停/);
await assert.rejects(()=>frameLocals(session,{kind:'candidate'}),/可靠/);
await assert.rejects(()=>frameLocals(session,bt.frames[0],{signal:()=>true}),e=>e.cancelled);
const fault=await frameLocals({...session,memRead:async()=>{throw new Error('FAULT');}},bt.frames[0]);
assert.match(fault.rows.find(r=>r.name==='seed').error,/FAULT/);
// Expression bounds, unavailable registers and unsupported optimization operations.
const ctx={regs,known,base:sp+24,cfa:sp+24,read};
assert.deepEqual(await evaluateLocation(Uint8Array.of(0x91,0x6c),ctx),{value:sp+4,direct:false});
assert.deepEqual(await evaluateLocation(Uint8Array.of(0x31,0x32,0x22,0x9f),ctx),{value:3,direct:true});
assert.equal((await evaluateLocation(Uint8Array.of(0x9c),ctx)).value,sp+24);
await assert.rejects(()=>evaluateLocation(Uint8Array.of(0x93,4),ctx),/位置暂不可用/);
await assert.rejects(()=>evaluateLocation(Uint8Array.of(3,1),ctx),/截断/);
await assert.rejects(()=>evaluateLocation(Uint8Array.of(0x22),ctx),/为空/);
await assert.rejects(()=>evaluateLocation(Uint8Array.of(0x91,0x7f),{...ctx,base:0}),/溢出/);
assert.throws(()=>new Reader(Uint8Array.of(0),-1),/偏移/);
// Synthetic DWARF5 location/range lists, constants, lexical scopes and aggregate values.
function synthetic(version=5){
 const attr=value=>({form:0x17,value}),expr=value=>({form:0x18,value:Uint8Array.from(value)});
 const cu={version,addrSize:4};
 const rec=(offset,tag,parent,attrs)=>({offset,tag,parent,depth:parent===-1?0:1,cu,attrs:new Map(attrs)});
 const root=rec(0,0x11,-1,[[0x11,attr(0)],[0x8c,attr(8)],[0x74,attr(8)]]);
 const fn=rec(1,0x2e,0,[[3,{value:'synthetic'}],[0x11,{form:1,value:0x1000}],[0x12,{form:6,value:0x100}],[0x40,expr([0x9c])]]);
 const x=rec(2,0x34,1,[[3,{value:'x'}],[0x49,attr(1)],[2,{form:0x22,value:0,listIndex:true}]]);
 const block=rec(3,0x0b,1,[[0x55,{form:0x23,value:0,listIndex:true}]]);
 const inner=rec(4,0x34,3,[[3,{value:'inner'}],[0x49,attr(1)],[0x1c,{value:-3}]]);
 const arr=rec(5,0x34,1,[[3,{value:'array'}],[0x49,attr(2)],[2,expr([3,...u32(sp)])]]);
 // base=8, table entry=4 -> list starts at12; absolute start_end [0x1020,0x1040).
 const loc=new Uint8Array([0,0,0,0,5,0,4,0,4,0,0,0,7,...u32(0x1020),...u32(0x1040),1,0x50,0]);
 const ranges=new Uint8Array([0,0,0,0,5,0,4,0,4,0,0,0,6,...u32(0x1020),...u32(0x1040),0]);
 const records=[root,fn,x,block,inner,arr],sections={'.debug_loclists':loc,'.debug_rnglists':ranges};
 return {_arr:records,index(){},dieAt:o=>records.find(r=>r.offset===o),childrenOf:r=>records.filter(c=>c.parent===r.offset),merged:r=>r,
  attr:(r,a)=>r?.attrs.get(a),num:(r,a)=>typeof r?.attrs.get(a)?.value==='number'?r.attrs.get(a).value:null,name:r=>r.attrs.get(3)?.value||'',
  type:id=>id===2?{kind:'array',size:4,count:1,elem:{kind:'scalar',size:4,scalar:'i32'}}:{kind:'scalar',size:4,scalar:'i32',name:'int'},
  elf:{data:n=>sections[n]}};
}
const sd=synthetic(),sr=await frameLocals({...session,sym:{dwarf:sd}},{regs,known:[...known],lookup:0x1022,cfa:sp+24});
assert.equal(sr.rows.find(r=>r.name==='x').value,String(regs[0]));
assert.equal(sr.rows.find(r=>r.name==='inner').value,'-3');
assert.equal(sr.rows.find(r=>r.name==='array').children[0].text,'123');
const outside=await frameLocals({...session,sym:{dwarf:sd}},{regs,known:[...known],lookup:0x1050,cfa:sp+24});
assert.equal(outside.rows.some(r=>r.name==='inner'),false);assert.match(outside.rows.find(r=>r.name==='x').error,/优化|位置/);
assert.equal(inScope(sd,sd._arr[1],0x1100),false);
// Session/command frame selection is serialized by caller and never writes target registers.
const s=Object.create(DebugSession.prototype);const {connected,...parts}=session;Object.assign(s,parts,{probe:{}});s.clearFrames();
s.backtrace=DebugSession.prototype.backtrace;s.selectFrame=DebugSession.prototype.selectFrame;s.locals=DebugSession.prototype.locals;
let writes=0;s.writeReg=async()=>{writes++;};s.memWrite=async()=>{writes++;};
await runCmd('bt 2',s);const command=await runCmd('frame 1',s);assert.equal(s._selectedFrame,1);assert.equal(command.frame.sp,sp+24);
assert.equal(writes,0);assert.ok((await runCmd('info args',s)).locals);
await assert.rejects(()=>runCmd('frame 999',s),/越界/);
s.pc+=2;await assert.rejects(()=>s.locals(),/失效/);
s.pc=pc;await s.backtrace({depth:2});s.sym={elf:{},dwarf};await assert.rejects(()=>s.selectFrame(0),/失效/);

const mutation=new DebugSession();mutation.probe={writeMem:async()=>{},regWrite:async()=>{},run:async()=>{}};mutation._clearDfsr=async()=>{};
for(const action of [()=>mutation.memWrite(sp,u32(1)),()=>mutation.writeReg('R0',1),()=>mutation.run()]){
 mutation._frames={frames:[{pc,sp}]};mutation._selectedFrame=1;await action();assert.equal(mutation._frames,null);assert.equal(mutation._selectedFrame,0);
}
s.sym=session.sym;await s.backtrace({depth:2});const originalRead=s.readReg;s.readReg=async n=>n==='SP'?sp+4:originalRead(n);
await assert.rejects(()=>s.selectFrame(0),/失效/);

console.log('dbg-frame-locals: real ARM GCC CFI/prologue/epilogue, DWARF4 locals, DWARF5 lists/scopes, frame registers, commands, faults, cancellation and stale ELF PASS');
