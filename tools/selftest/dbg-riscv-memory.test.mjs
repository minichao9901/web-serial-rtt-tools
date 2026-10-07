import assert from 'node:assert/strict';
import {Elf} from '../../app/elf/elf.js';
import {SymTab} from '../../app/dbg/symbols.js';
import {RiscvDebugSession} from '../../app/dbg/riscv.js';
import {RiscvTransport} from '../../app/flash/hpm/riscv-dm.js';
import {SBCS,DM,DMI_OP,DMI_STATUS,dmiRequest} from '../../app/flash/hpm/jtag.js';

const elf=Object.create(Elf.prototype);
elf.b=Uint8Array.of(11,12,21,22,31,32);
let segments=[{addr:0x80000000,off:0,size:2,type:1,flags:6},
 {addr:0x80000002,off:2,size:2,type:1,flags:2}];
elf.sections=()=>segments;
const sym=Object.create(SymTab.prototype);sym.elf=elf;
const s=Object.create(RiscvDebugSession.prototype),logs=[];
let reads=0,clears=0,failing=false;
Object.assign(s,{sym,halted:true,pc:0x80000000,_frames:{sentinel:true},_log:t=>logs.push(t),dm:{
 async readMem(a,n){reads++;if(failing)throw Error('SBA failed');return new Uint8Array(n).fill(7);},
 async sbaClearErrors(){clears++;},
 async init(){throw Error('implicit DM reset is forbidden');},
 async sbaHealthCheck(){throw Error('implicit target reset is forbidden');}
}});
assert.deepEqual([...await s.memRead(0x80000000,4)],[11,12,21,22]);
assert.equal(reads,0);assert.match(logs[0],/ELF.*未读取目标实时内存/);
assert.deepEqual([...elf.bytesAt(0x80000001,2,{ro:true})],[12,21]);
for(const mutate of [()=>{s.sym=null;},()=>{segments[1].addr++;},()=>{segments[1].flags=3;},()=>{segments[1].off=99;}]){
 const before=structuredClone(segments);mutate();
 await assert.rejects(s.memRead(0x80000000,4),/数据不可用/);
 segments=before;s.sym=sym;
}
assert.equal(reads,0,'missing image bytes never fall back to dangerous SBA');
await assert.rejects(s.memRead(0x7fffffff,2),/数据不可用/);
await assert.rejects(s.memRead(0xffffffff,2),/32 位/);
await assert.rejects(s.memRead(-1,4),/32 位/);
assert.equal(elf.bytesAt(0xffffffff,2),null);
// Only SHF_ALLOC file data may stand in for instruction/RO bytes.
segments[1].flags=0;assert.equal(elf.bytesAt(0x80000000,4,{ro:true}),null);segments[1].flags=2;
assert.equal(sym.covers(0x80000000,4),true);
assert.equal(sym.covers(0x80000000,5),false);
assert.equal(sym.covers(0xffffffff,2),false);
assert.equal(Object.create(SymTab.prototype).covers(0x20000000),false);

// Failed ordinary reads cannot reset or resume the target, or retry the bad bus access.
failing=true;const frames=s._frames;
await assert.rejects(s.memRead(0x01200000,8),/SBA failed/);
assert.equal(reads,1);assert.equal(clears,1);assert.equal(s.halted,true);assert.equal(s._frames,frames);
await assert.rejects(s.memRead(0x01200000,8),/15 秒/);assert.equal(reads,1);
failing=false;assert.equal((await s.memRead(0x01200000,4))[0],7,'cooldown is range-specific');
s._badAddrs.get('18874368:8').at-=15001;
assert.equal((await s.memRead(0x01200000,8))[0],7);
assert.equal(s._badAddrs.has('18874368:8'),false);

// All SBA failure states must preserve the stopped program and debugger state.
for(const state of [0x400000,0x200000,0x2000,0x600000]){
  const session=Object.create(RiscvDebugSession.prototype),log=[];
  const snapshot={sentinel:true}, regs={a0:123}, bps=[0x80003000];
  let attempts=0,repairs=0;
  Object.assign(session,{sym:null,halted:true,pc:0x80003010,regs,bps,_frames:snapshot,_log:t=>log.push(t),
    _repairStuckSba:async()=>{repairs++;throw Error('implicit recovery forbidden');},
    dm:{lastSbcs:state,async readMem(){attempts++;throw Error('SBA failed');},
      async init(){repairs++;throw Error('implicit DM init forbidden');},async sbaClearErrors(){}}});
  await assert.rejects(session.memRead(0x4000b600,60),/SBA failed/);
  assert.equal(attempts,1);assert.equal(repairs,0);assert.equal(session.halted,true);
  assert.equal(session.pc,0x80003010);assert.equal(session._frames,snapshot);
  assert.equal(session.regs,regs);assert.equal(session.bps,bps);
  await assert.rejects(session.memRead(0x4000b600,60),/15 秒/);assert.equal(attempts,1);
  assert.ok(log.some(t=>/未自动复位/.test(t)));
}
// RTT failures also cannot reset DM or retry an uncertain bus access.
{
  const {RiscvMem}=await import('../../app/rtt/riscv-mem.js');
  let reads=0,resets=0;
  const mem=new RiscvMem({dm:{async readMem(){reads++;throw Error('SBA failed');},
    async init(){resets++;}},log(){}});
  await assert.rejects(mem.readMem(0x400,4),/SBA failed/);
  assert.equal(reads,1);assert.equal(resets,0);
}

// Transport fences the complete aligned span before any hardware command.
const t=Object.create(RiscvTransport.prototype);let touched=0;
t.sbaConfig=async()=>{touched++;throw Error('allowed SBA path');};
for(const [a,n]of [[0x80000000,4],[0x7ffffffc,8],[0x8fffffff,2]]){
 await assert.rejects(t.readMem(a,n),/XIP\/flash/);assert.equal(touched,0);
}
for(const [a,n]of [[0xffffffff,2],[-1,4],[0,1.5],[0,-1]]){
 await assert.rejects(t.readMem(a,n),/32 位/);assert.equal(touched,0);
}
for(const a of [0x01200000,0x7ffffffc,0x90000000])await assert.rejects(t.readMem(a,4),/allowed SBA path/);
assert.equal(touched,3);
console.log('RISC-V memory: adjacent ELF segments, missing/hole/write/nonallocated/truncated bytes rejected, full XIP fence, no implicit reset, bounded range cooldown PASS');

// Unknown/invalid state cannot justify abstract commands or a resume write.
for(const state of [0,0x67adb267,0x40c0a2]){
 const session=Object.create(RiscvDebugSession.prototype);let abstract=0,writes=0;
 Object.assign(session,{halted:true,_log(){},dm:{dmiRead:async()=>state,readReg:async()=>{abstract++;},dmiWrite:async()=>{writes++;}}});
 await assert.rejects(session.run(),/无法确认/);
 await assert.rejects(session._ensureHalted('test'),/无法确认/);
 assert.equal(abstract,0);assert.equal(writes,0);
}
// A register refresh failure retains the prior snapshot rather than fabricating zeros.
const registers=Object.create(RiscvDebugSession.prototype),oldRegs=[{name:'a0',value:123}];
Object.assign(registers,{halted:true,regs:oldRegs,pc:99,_log(){},dm:{dmiRead:async()=>0x4c03a2,readReg:async()=>{throw Error('register read failed');}}});
await assert.rejects(registers.refreshRegs(),/register read failed/);
assert.equal(registers.regs,oldRegs);assert.equal(registers.pc,99);
// A failed breakpoint re-arm must prevent resetRun from resuming without breakpoints.
const reset=Object.create(RiscvDebugSession.prototype);let resumed=false;
Object.assign(reset,{bps:[0x80000000],_log(){},dm:{_haltByReset:async()=>{},dmiRead:async()=>0x4c03a2},
 _programBps:async()=>{throw Error('trigger failed');},run:async()=>{resumed=true;}});
await assert.rejects(reset.resetRun(),/trigger failed/);assert.equal(resumed,false);
const pause=Object.create(RiscvDebugSession.prototype);
Object.assign(pause,{_log(){},_haltQuiet:async()=>{throw Error('halt failed');},_healDm:async()=>true,dm:{halt:async()=>{throw Error('reset fallback must not run');}}});
await assert.rejects(pause._haltWithHeal(),/未自动复位目标/);
console.log('RISC-V state: unknown status fails closed, register failures preserve snapshot, failed trigger re-arm blocks resume, failed pause does not system-reset PASS');

// Reset helpers returning successfully do not substitute for actual hart state.
for(const action of ['resetHalt','resetRun']){
 const session=Object.create(RiscvDebugSession.prototype);let rearmed=false;
 Object.assign(session,{dm:{resetHalt:async()=>{},_haltByReset:async()=>{},dmiRead:async()=>0x4f0ca2},
 _rearmBpsAfterReset:async()=>{rearmed=true;},_log(){}});
 await assert.rejects(session[action](),/停机未确认/);assert.equal(rearmed,false);
}
console.log('RISC-V reset: helper return is not proof of halt; running hart blocks re-arm/resume PASS');

// SDK HPM6880 external SDRAM is inaccessible with DDR0 gated after reset.
{
 const session=Object.create(RiscvDebugSession.prototype),accesses=[];
 let group=0,resource=0,mode=0,writes=0;
 const word=value=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,value,true);return b;};
 Object.assign(session,{sym:{find:n=>['_init_ext_ram','init_ddr3l_1333'].includes(n)?{name:n}:null},_log(){},
  dm:{async readMem(a,n){accesses.push(a);return a===0xf4000800?word(group):a===0xf400041c?word(resource):a===0xf3010004?word(mode):new Uint8Array(n).fill(7);},
      async writeMem(){writes++;}}});
 await assert.rejects(session.memRead(0x4000b600,60),e=>e.code==='MEMORY_NOT_READY');
 assert.deepEqual(accesses,[0xf4000800,0xf400041c],'disabled DDR must not touch DDRCTL or SDRAM');
 assert.equal(session._badAddrs.size,0,'readiness is not a 15-second bad-address cache');
 await assert.rejects(session.memWrite(0x4c000000,word(1)),e=>e.code==='MEMORY_NOT_READY');assert.equal(writes,0);
 group=0x80;
 for(const blockedResource of [2,3,0x40000000]){
  resource=blockedResource;accesses.length=0;
  await assert.rejects(session.memRead(0x4000b600,60),e=>e.code==='MEMORY_NOT_READY');
  assert.deepEqual(accesses,[0xf4000800,0xf400041c]);
 }
 resource=0;mode=0;accesses.length=0;
 await assert.rejects(session.memRead(0x4000b600,60),e=>e.code==='MEMORY_NOT_READY');
 assert.deepEqual(accesses,[0xf4000800,0xf400041c,0xf3010004]);
 mode=1;accesses.length=0;
 assert.deepEqual(await session.memRead(0x4000b600,60),new Uint8Array(60).fill(7));
 assert.deepEqual(accesses,[0xf4000800,0xf400041c,0xf3010004,0x4000b600],'ready DDR immediately restores the same read');
 group=0;resource=1;
 await session.memWrite(0x4000b600,word(1));assert.equal(writes,1,'always-on resource mode is respected');
}
console.log('RISC-V external RAM: gated/transitional DDR never accessed; readiness restores reads/writes without cooldown PASS');

// Failed and deferred tree reads must invalidate the previously displayed data.
{
 const {DbgView}=await import('../../app/dbg/view.js');
 const view=Object.create(DbgView.prototype);
 const item={kind:'struct',size:4,addr:0x4000b600,bytes:Uint8Array.of(1,2,3,4),value:{text:'old'}};
 const error=new Error('SDRAM waiting');error.code='MEMORY_NOT_READY';
 Object.assign(view,{watch:{length:1,items:[item]},watchBusy:false,renderWatch(){},
  session:{connected:true,halted:true,async memRead(){throw error;}}});
 assert.equal(await view._refreshWatchLocked({force:true}),0);
 assert.equal(item.bytes,null);assert.equal(item.value.cls,'dim');assert.match(item.value.text,/等待初始化/);
 item.bytes=Uint8Array.of(1,2,3,4);delete error.code;
 await view._refreshWatchLocked({force:true});assert.equal(item.bytes,null);assert.equal(item.value.cls,'err');
}
console.log('Debugger watch: deferred and failed reads discard old struct member bytes PASS');

// Asynchronous SBA and batch recovery use the independent TCK-driven model
// in riscv-sba-async.test.mjs, rather than immediate address-increment stubs.
