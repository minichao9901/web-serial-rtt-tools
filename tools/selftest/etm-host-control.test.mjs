import test from 'node:test';
import assert from 'node:assert/strict';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';
import {EtmTarget} from '../../bridge/etm/backend/web/app/target.js';

test('embedded ETM uses parent diagnostic transport: keyed reset is sent once',async()=>{
  const p=new WebUsbDapProbe(),t=new EtmTarget(()=>{},{host:{}}),writes=[];t.probe=p;
  p._writeMemOnce=async(a,b)=>writes.push([a,[...b]]);
  p._readMemLocked=async()=>{throw Error('control write must not read back');};
  p._healIfFaulted=async()=>{throw Error('control write must not heal');};
  await t.write(0xe000ed0c,0x05fa0004,false);
  assert.deepEqual(writes,[[0xe000ed0c,[4,0,250,5]]]);
  p._faulted=true;await assert.rejects(t.write(0xe000ed0c,0x05fa0004,false),/已故障/);assert.equal(writes.length,1);
});

test('fault appearing while control write waits for transport lock prevents sending',async()=>{
  const p=new WebUsbDapProbe();let release,sent=0;
  p._writeMemOnce=async()=>{sent++;};p._lockChain=new Promise(r=>{release=r;});
  const pending=p.writeMemDiagnostic(0xe000ed0c,new Uint8Array(4));p._faulted=true;release();
  await assert.rejects(pending,/FAULT/);assert.equal(sent,0);
});

test('legacy injected driver fails before reset rather than silently retrying it',async()=>{
  const t=new EtmTarget(()=>{},{host:{}});let ordinary=0;t.probe={writeMem:async()=>{ordinary++;}};
  await assert.rejects(t.write(0xe000ed0c,0x05fa0004,false),/更新完整 ETM 桥包/);assert.equal(ordinary,0);
});

test('embedded ETM recovery calls actual parent driver and leaves execution decisions to controller',async()=>{
  const p=new WebUsbDapProbe(),t=new EtmTarget(()=>{},{host:{}}),events=[];
  t.probe=p;t.debugFault=true;p._faulted=true;p.clockHz=1000000;
  p._targetInit=async options=>{events.push(['recover',options.clock]);};
  p.run=async()=>{throw Error('must not resume');};p.sysReset=async()=>{throw Error('must not reset');};
  t.halt=async()=>events.push(['halt']);t.clearEntryBreak=async()=>events.push(['clear-entry']);t.restore=async()=>events.push(['restore']);t.inspect=async()=>({halted:true});
  assert.equal((await t.recoverDebugPort()).halted,true);assert.equal(t.transportFault,false);
  assert.deepEqual(events,[['recover',1000000],['halt'],['clear-entry'],['restore']]);
  p._targetInit=async()=>{throw Error('unavailable');};await assert.rejects(p.recoverDebugPort(),/unavailable/);
  assert.equal(p._faulted,true);assert.equal(p._recovering,false);
});

test('unexpected halt reports addresses and register reasons',async()=>{
  const t=new EtmTarget(()=>{},{host:{}});const values=new Map([[0xe000edf0,0x30003],[0xe000ed30,8],[0xe000edfc,0x1000400]]);t.read=async a=>values.get(a);
  const e=await t.unexpectedHalt(0x08000494,0x080004d0,'复位后');assert.match(e.message,/0x08000494.*0x080004d0.*异常捕获.*DFSR 0x00000008.*目标保持暂停/);
});
test('standalone release callback cannot disconnect while a hardware operation is busy',async()=>{
 const t=new EtmTarget(()=>{},{host:{}});let releases=0;t.disconnect=async()=>releases++;t.canRelease=()=>false;
 await assert.rejects(Promise.resolve().then(()=>t.bus.onRelease()),/正在操作/);assert.equal(releases,0);
 t.canRelease=()=>true;await t.bus.onRelease();assert.equal(releases,1);
});
test('DHCSR write keeps TAR and DRW together while another memory read queues',async()=>{
 const p=new WebUsbDapProbe(),writes=[];let address,unblock,arrived;const ready=new Promise(r=>arrived=r),blocked=new Promise(r=>unblock=r);
 p._setTAR=async a=>{address=a;arrived();await blocked;};p._transferBlock=async()=>writes.push(address);
 p._readMemLocked=async a=>{address=a;return new Uint8Array(4);};
 const control=p._dhcsr(0xa05f0003);await ready;const read=p.readMem(0x20000000,4);await new Promise(r=>setImmediate(r));unblock();await Promise.all([control,read]);assert.deepEqual(writes,[0xe000edf0]);
});
