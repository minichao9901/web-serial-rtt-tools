import assert from 'node:assert/strict';
import * as P from '../../app/scope/protocol.js';
import {ScopeView} from '../../app/scope/view.js';

const controls = new Map();
globalThis.document = {getElementById: id => controls.get(id)};
for (const [id, value] of [['sc-clock','60000'], ['sc-period','100'], ['sc-batch',''], ['sc-cdcoff','']])
  controls.set(id, {value, checked: true});
const v1 = {name:'x', addr:0x20000001, size:1, scalar:'u8'};
const gap = P.planReads([v1, {...v1,name:'y',addr:0x2000000e}]);
assert.equal(gap.frameBytes,2);
assert.equal(gap.readBytes,16,'alignment and merged gap cost target reads, not only payload bytes');
assert.equal(gap.readBlocks,1);
assert.ok(gap.estUs > P.planReads([v1]).estUs);
const page = P.planReads([{...v1,addr:0x200003fc,size:8,scalar:'f64'}]);
assert.equal(page.readBlocks,2,'SWD auto-increment page crossing requires two blocks');
assert.ok(P.planReads([v1],{swdMhz:20}).estUs > P.planReads([v1],{swdMhz:60}).estUs);
assert.equal(P.riscvPlanUs(gap),(4+4)*P.RISCV_COST.scanUs);
assert.equal(P.recommendedPeriodUs(7.3,P.BACKEND.SWD),10);
assert.equal(P.recommendedPeriodUs(7.3,P.BACKEND.RISCV),11);
assert.equal(P.recommendedPeriodUs(1.47),3);
for(const n of [0,-1,NaN,Infinity])assert.equal(P.recommendedPeriodUs(n),null);

function view(){
  const s=Object.create(ScopeView.prototype);
  Object.assign(s,{selected:[{...v1}],elf:{},hid:{},usingMock:false,swdMhz:60,targetRiscv:true,
    uiBackend:()=>P.BACKEND.RISCV,periodUs:()=>100,updatePlan:()=>P.planReads(s.selected),
    _absorbeStatusBackend(){},setStatusText(text){s.message=text;},
    configureScope:async()=>Uint8Array.of(0,0,0)});
  return s;
}
{
  const s=view();s.uiBackend=()=>P.BACKEND.SWD;s.swdMhz=45;s._reportedClockSelection=60000;
  assert.equal(s.planClockMhz(),45,'actual downshift is used for an unchanged requested clock');
  assert.equal(s.fastWordUs(),1.758);
  controls.get('sc-clock').value='30000';assert.equal(s.planClockMhz(),30,'new clock selection previews its new budget');
  controls.get('sc-clock').value='60000';
}
{
  const s=view();s.benchUs=7.3;s._benchKey=s.benchKeyOf();assert.equal(s.benchFresh(),true);
  s.selected[0]={...v1,addr:v1.addr+4};assert.equal(s.benchFresh(),false,'same names with new addresses invalidate calibration');
  s.selected=[{...v1}];assert.equal(s.benchFresh(),true);
  s.elf={};assert.equal(s.benchFresh(),false,'replacement ELF invalidates calibration');
}
for (const err of [0,-4]){
  const s=view();
  s.hidXfer=async(cmd,data)=>{
    const r=new Uint8Array(63),d=new DataView(r.buffer);
    if(data[0]===P.ACT.BENCH_RESULT){d.setUint32(3,7.3*24*2000,true);d.setUint32(7,2000,true);d.setInt32(11,err,true);}
    return r;
  };
  assert.equal(await s._benchNow(),!err);
  if(err){assert.equal(s.benchUs,null);await s.applyRecPeriod();assert.equal(controls.get('sc-period').value,'100','failed calibration must not overwrite period');}
  else {assert.equal(s.benchFresh(),true,'successful JTAG calibration remains usable');assert.equal(s.recPeriodUs,11);}
}
{
  const s=view();s.hidXfer=async(cmd,data)=>{
    const r=new Uint8Array(63),d=new DataView(r.buffer);
    if(data[0]===P.ACT.BENCH_RESULT){d.setUint32(3,48000,true);d.setUint32(7,2000,true);s.selected=[{...v1,addr:v1.addr+4}];}
    return r;
  };
  assert.equal(await s._benchNow(),false,'editing addresses during calibration cannot label the result as fresh');
}
{
  const b=new Uint8Array(48),d=new DataView(b.buffer),w=[0x31535348,123,24000000,100000,80000,70000,90000,65536,50,25000,48,256];
  w.forEach((n,i)=>d.setUint32(i*4,n,true));
  const m=P.parseScopeMetrics(b);assert.equal(m.skipped,80000);assert.equal(m.usb,70000);assert.equal(m.errors,90000);assert.equal(m.yields,65536);
  assert.throws(()=>P.parseScopeMetrics(b.subarray(1)));d.setUint32(0,0,true);assert.throws(()=>P.parseScopeMetrics(b));
}
{
  const s=view();let resolve,calls=0;
  s.supportsMetrics=true;s._captureGen=1;s.hidXfer=()=>{calls++;return new Promise(r=>resolve=r);};
  const p=s.readScopeMetrics(),q=s.readScopeMetrics();assert.equal(calls,1,'only one metrics request can be pending');
  s._captureGen=2;resolve(new Uint8Array(51));await Promise.all([p,q]);assert.equal(s.probeMetrics,undefined,'late previous-generation counts do not enter the new capture');
}
console.log('scope-rate: aligned/page/clock budgets, backend recommendations, valid calibration identity, full-width metrics and stale response rejection PASS');
