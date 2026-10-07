import assert from 'node:assert/strict';
import {RiscvTransport} from '../../app/flash/hpm/riscv-dm.js';
import {DM, SBCS, DMI_STATUS, drScan} from '../../app/flash/hpm/jtag.js';
import {SimTarget} from './hpm-sim.mjs';
import {DapJtagTransport} from '../../app/flash/hpm/dap-transport.js';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';

let passed=0, failed=0;
async function check(name, fn){
  try { await fn(); passed++; console.log('PASS '+name); }
  catch(e){ failed++; console.error('FAIL '+name+': '+e.message); }
}
async function rig(opts={}){
  const sim=new SimTarget(opts), dm=new RiscvTransport(sim);
  await dm.init();
  for(let i=0;i<sim.ram.length;i++) sim.ram[i]=(i*17+3)&255;
  sim.busAccesses=[];
  return {sim,dm};
}
await check('DMI response codes are independent of request opcodes',async()=>{
  assert.equal(DMI_STATUS.SUCCESS,0); assert.equal(DMI_STATUS.ERROR,2); assert.equal(DMI_STATUS.BUSY,3);
});
await check('single word at RAM end never prefetches an unmapped word',async()=>{
  const {sim,dm}=await rig();
  assert.deepEqual(await dm.readMem(sim.ramSize-4,4),sim.ram.slice(-4));
  assert.deepEqual(sim.busAccesses.map(a=>a.addr),[sim.ramSize-4]);
});
await check('unaligned multi-batch reads access exactly the aligned span',async()=>{
  const {sim,dm}=await rig(); const start=sim.ramSize-103;
  assert.deepEqual(await dm.readMem(start,103),sim.ram.slice(start));
  assert.deepEqual(sim.busAccesses.map(a=>a.addr),Array.from({length:26},(_,i)=>sim.ramSize-104+i*4));
});
await check('burst tail BUSY/FAILED cannot be accepted as clean SBCS',async()=>{
  for(const op of [2,3]){
    const t=new RiscvTransport({});
    t._scanDRMany=async reqs=>reqs.map((_,i)=>i===reqs.length-1?BigInt(op):0n);
    assert.equal((await t.sbaReadBurst(2)).ok,false);
    assert.equal((await t.dmiWriteBurst([1,2])).ok,false);
  }
});
await check('errors raised on bus completion are reported',async()=>{
  const t=new RiscvTransport({}); let n=0;
  t.dmiRead=async()=>++n===1?SBCS.SBBUSY:2<<12;
  await assert.rejects(t._checkSbcsAt(0x400,30),/SBA/);
});
await check('permanent busy times out without writing SBCS',async()=>{
  const t=new RiscvTransport({}); let writes=0;
  t.dmiRead=async()=>SBCS.SBBUSY|SBCS.SBBUSYERROR;
  t.dmiWrite=async()=>{writes++;};
  await assert.rejects(t.sbaClearErrors(10),/超时|sbbusy/);
  assert.equal(writes,0);
});
await check('writes wait for actual bus completion',async()=>{
  const {sim,dm}=await rig({busDelayCycles:800});
  const data=Uint8Array.from({length:104},(_,i)=>255-i);
  await dm.writeMem(0x400,data);
  assert.equal(sim.busPending,null); assert.equal(sim.sbaBusyError,false);
  assert.deepEqual(sim.ram.slice(0x400,0x468),data);
  assert.deepEqual(sim.busAccesses.filter(a=>a.write).map(a=>a.addr),Array.from({length:26},(_,i)=>0x400+i*4));
});
await check('delayed reads recover by completed address without rereading',async()=>{
  const {sim,dm}=await rig({busDelayCycles:800});
  const expected=sim.ram.slice(0x400,0x508);
  assert.deepEqual(await dm.readMem(0x400,expected.length),expected);
  assert.equal(sim.busPending,null); assert.equal(sim.sbaBusyError,false);
  assert.equal(sim.busyConfigWrites,0);
  assert.deepEqual(sim.busAccesses.map(a=>a.addr),Array.from({length:66},(_,i)=>0x400+i*4));
  assert.ok(dm.sbaReadDelay>64);
  const scans=sim.stats.scans;
  assert.deepEqual(await dm.readMem(0x400,expected.length),expected);
  assert.equal(dm._burstOff,false); assert.ok(sim.stats.scans>scans);
});
await check('real bus error is cleared and reported without retry/reset',async()=>{
  const {sim,dm}=await rig({busDelayCycles:500,busErrorAt:0x400});
  await assert.rejects(dm.readMem(0x400,4),e=>e.code==='SBA_BUS_ERROR'&&e.sberror===2);
  assert.deepEqual(sim.busAccesses.map(a=>a.addr),[0x400]);
  assert.equal(sim.sbaError,0); assert.equal(sim.busyConfigWrites,0);
  sim.busErrorAt=null;
  assert.deepEqual(await dm.readMem(0x404,4),sim.ram.slice(0x404,0x408));
});
await check('permanent bus hang is bounded and causes no unsafe recovery writes',async()=>{
  const {sim,dm}=await rig({busHangAt:0x400});
  await assert.rejects(dm.readMem(0x400,4,20),e=>e.code==='SBA_TIMEOUT');
  assert.equal(sim.busyConfigWrites,0); assert.deepEqual(sim.busAccesses.map(a=>a.addr),[0x400]);
});
await check('sticky DMI BUSY learns delay; FAILED is cleared and surfaced',async()=>{
  const {sim,dm}=await rig();
  sim.dmiSticky=3; sim.pendingDmi=3n;
  assert.equal(await dm.dmiRead(DM.DMCONTROL),sim.dm.dmcontrol);
  assert.ok(dm.dmiBusyDelay>0); assert.ok(sim.dmiResets>0);
  sim.dmiSticky=2; sim.pendingDmi=2n;
  await assert.rejects(dm.dmiRead(DM.DMCONTROL),e=>e.code==='DMI_FAILED');
  assert.equal(sim.dmiSticky,0);
  assert.equal(await dm.dmiRead(DM.DMCONTROL),sim.dm.dmcontrol);
});
await check('learned idle >64 clocks is preserved and packets remain within 512 bytes',async()=>{
  const idle=drScan(41,0n,{idle:220});
  assert.equal(idle.slice(0,-6).reduce((n,s)=>n+s.clocks,0),220);
  const {sim,dm}=await rig(); dm.sbaReadDelay=400;
  const original=sim.jtagSequences.bind(sim); let max=0;
  sim.jtagSequences=async seqs=>{
    const bytes=2+seqs.reduce((n,s)=>n+1+s.tdi.length,0); max=Math.max(max,bytes);
    assert.ok(bytes<=512); assert.ok(seqs.length<=255); return original(seqs);
  };
  assert.deepEqual(await dm.readMem(0x400,128),sim.ram.slice(0x400,0x480)); assert.ok(max>100);
});
await check('concurrent memory operations serialize address/configuration state',async()=>{
  const {sim,dm}=await rig({busDelayCycles:400});
  const expected=sim.ram.slice(0x400,0x440), data=new Uint8Array(64).fill(99);
  const [got]=await Promise.all([dm.readMem(0x400,64),dm.writeMem(0x500,data)]);
  assert.deepEqual(got,expected); assert.deepEqual(sim.ram.slice(0x500,0x540),data);
  assert.equal(sim.busyConfigWrites,0);
});
await check('timed-out wire is quarantined, including queued and late operations',async()=>{
  let finish,commands=0;
  const dm=new RiscvTransport({jtagSequences(seqs){
    commands++;
    return new Promise(resolve=>{finish=()=>resolve(seqs.filter(s=>s.captureBytes).map(s=>new Uint8Array(s.captureBytes)));});
  }});
  const results=await Promise.allSettled([dm.readMem(0x400,4,15),dm.readMem(0x500,4,100)]);
  assert.ok(results.every(r=>r.status==='rejected')); assert.ok(dm._wireFault);
  assert.equal(commands,1);
  finish(); await new Promise(resolve=>setTimeout(resolve,0));
  await assert.rejects(dm.readMem(0x600,4),/超时/); assert.equal(commands,1);
});
await check('DMI FAILED at burst tail reports failure and next valid read works',async()=>{
  const {sim,dm}=await rig(); const execute=sim._dmiExecute.bind(sim);
  let failed=false,dataReads=0;
  sim._dmiExecute=(op,addr,data)=>{
    if(op===1&&addr===DM.SBDATA0)dataReads++;
    if(op===1&&addr===DM.SBCS&&dataReads>=2&&!failed){failed=true;sim.dmiSticky=2;return 2n;}
    return execute(op,addr,data);
  };
  const control=sim.dm.dmcontrol;
  await assert.rejects(dm.readMem(0x400,64),e=>e.code==='DMI_FAILED');
  assert.equal(sim.dm.dmcontrol,control); assert.equal(sim.dmiSticky,0);
  assert.deepEqual(await dm.readMem(0x500,64),sim.ram.slice(0x500,0x540));
});
await check('bus delays across first-read, inter-word and tail boundaries never duplicate accesses',async()=>{
  for(const delay of [1,120,240,500,1500])for(const burst of [false,true]){
    const sim=new SimTarget({busDelayCycles:delay}),dm=new RiscvTransport(sim,{burst}); await dm.init();
    for(let i=0;i<sim.ramSize;i++)sim.ram[i]=(i*7+1)&255;
    sim.busAccesses=[];
    assert.deepEqual(await dm.readMem(0x401,99),sim.ram.slice(0x401,0x464));
    assert.deepEqual(sim.busAccesses.map(a=>a.addr),Array.from({length:25},(_,i)=>0x400+i*4));
    assert.equal(sim.busyConfigWrites,0);
  }
});
await check('write BUSY with lost DMI result resumes only uncommitted words',async()=>{
  const {sim,dm}=await rig({busDelayCycles:500});
  const execute=sim._dmiExecute.bind(sim); let injected=false;
  sim._dmiExecute=(op,addr,data)=>{
    const result=execute(op,addr,data);
    if(op===2&&addr===DM.SBDATA0&&!injected){
      injected=true; sim.dmiSticky=3; return 3n;
    }
    return result;
  };
  const data=Uint8Array.from({length:104},(_,i)=>(i*11)&255);
  await dm.writeMem(0x400,data);
  assert.deepEqual(sim.ram.slice(0x400,0x468),data);
  assert.deepEqual(sim.busAccesses.map(a=>a.addr),Array.from({length:26},(_,i)=>0x400+i*4));
  assert.equal(sim.busPending,null); assert.equal(sim.busyConfigWrites,0);
  assert.ok(dm.dmiBusyDelay>0);
});
await check('write bus error is reported once and subsequent valid write succeeds',async()=>{
  const {sim,dm}=await rig({busDelayCycles:500,busErrorAt:0x400});
  const control=sim.dm.dmcontrol;
  await assert.rejects(dm.writeMem(0x400,new Uint8Array(64)),e=>e.code==='SBA_BUS_ERROR');
  assert.deepEqual(sim.busAccesses.map(a=>a.addr),[0x400]);
  assert.equal(sim.dm.dmcontrol,control); assert.equal(sim.sbaError,0);
  sim.busErrorAt=null;
  await dm.writeMem(0x500,new Uint8Array(64).fill(99));
  assert.deepEqual(sim.ram.slice(0x500,0x540),new Uint8Array(64).fill(99));
  assert.equal(sim.busPending,null);
});
await check('slow and burst writes complete exactly once across bus delays',async()=>{
  for(const delay of [1,120,240,500,1500])for(const burst of [false,true]){
    const sim=new SimTarget({busDelayCycles:delay}),dm=new RiscvTransport(sim,{burst}); await dm.init();
    sim.busAccesses=[];
    const data=Uint8Array.from({length:100},(_,i)=>(i*19)&255);
    await dm.writeMem(0x400,data);
    assert.deepEqual(sim.ram.slice(0x400,0x464),data);
    assert.deepEqual(sim.busAccesses.map(a=>a.addr),Array.from({length:25},(_,i)=>0x400+i*4));
    assert.equal(sim.busPending,null); assert.equal(sim.busyConfigWrites,0);
  }
});
await check('JTAG forwards the shared deadline and USB stops between OUT and IN',async()=>{
  const deadline=performance.now()+1000;
  const jtag=new DapJtagTransport({_ctrl:async(cmd,body,opts)=>{
    assert.equal(opts.deadline,deadline); return Uint8Array.of(0);
  }});
  jtag.jtag=true;
  await jtag.jtagSequences([{clocks:1,tms:0,tdi:Uint8Array.of(0),captureBytes:0}],{deadline});
  const probe=new WebUsbDapProbe(); probe._ready=true; probe.pkt=512;
  let out=0,inside=0;
  let finish;
  probe.device={
    transferOut(){out++; return new Promise(resolve=>{finish=()=>resolve({status:'ok'});});},
    transferIn(){inside++; throw new Error('unexpected IN');},
  };
  await assert.rejects(probe._ctrl(0x14,null,{deadline:performance.now()-1}),/预算/);
  assert.equal(out,0);
  const pending=probe._ctrl(0x14,null,{deadline:performance.now()+15});
  // Block the host thread to model time consumed by OUT while it succeeds.
  const until=performance.now()+20; while(performance.now()<until){}
  finish();
  await assert.rejects(pending,/预算/);
  assert.equal(out,1); assert.equal(inside,0);
});
await check('bus timeout with real wire latency preserves the DMI control channel',async()=>{
  const {sim,dm}=await rig({busHangAt:0x400});
  const original=sim.jtagSequences.bind(sim);
  sim.jtagSequences=async seqs=>{
    await new Promise(resolve=>setTimeout(resolve,3));
    return original(seqs);
  };
  await assert.rejects(dm.readMem(0x400,4,100),e=>e.code==='SBA_TIMEOUT');
  assert.equal(dm._wireFault,undefined,'budget exhaustion must not pretend a wire transfer hung');
  assert.equal((await dm.dmiRead(DM.DMSTATUS))&15,2,'control/status DMI remains usable');
  assert.equal(sim.busyConfigWrites,0);
});
console.log(`RISC-V async SBA: ${passed} passed / ${failed} failed`);
if(failed) process.exitCode=1;
