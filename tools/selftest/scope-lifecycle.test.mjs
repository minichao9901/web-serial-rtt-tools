import assert from 'node:assert/strict';
import {ScopeView} from '../../app/scope/view.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
globalThis.document={getElementById:id=>({value:id==='sc-period'?'100':'0'})};
for(const fail of [false,true]){
 const cfg=gate(),v=Object.create(ScopeView.prototype),events=[];let calls=0;
 Object.assign(v,{selected:[{addr:0x20000000,scalar:'u32',name:'x',size:4}],usingMock:true,hid:{},running:false,transport:{running:false,start:async function(){calls++;this.running=true;},stop:async function(){events.push('USB-stop');this.running=false;}},renderer:{setStore(){},setTrigger(){},clearMarks(){}},periodUs:()=>100,seconds:()=>1,isReal:()=>false,updatePlan:()=>({}),applyTrigger(){},configureScope:()=>cfg.promise,_startWatchdog(){},_stopWatchdog(){},_absorbeStatusBackend(){},benchFresh:()=>false,setStatusText(){},syncButtons(){},hidXfer:async(cmd,data)=>{events.push(data[0]===0?'HID-stop':'HID-start');return Uint8Array.of(0,0,0);}});
 const start=v.start();await v.start();const stop=v.stop('cancel');await tick();cfg.resolve(fail?null:Uint8Array.of(0,0,0));await Promise.all([start,stop]);
 assert.equal(calls,0);assert.equal(v.running,false);assert.equal(v._capturing,false);assert.deepEqual(events,['HID-stop','USB-stop']);assert.equal(v._starting,false);
}
{
 const status=gate(),reached=gate(),v=Object.create(ScopeView.prototype);
 Object.assign(v,{selected:[{addr:0x20000000,scalar:'u32',name:'x',size:4}],usingMock:true,hid:{},running:false,transport:{running:false,start:async function(){this.running=true;},stop:async function(){this.running=false;}},renderer:{setStore(){},setTrigger(){},clearMarks(){}},periodUs:()=>100,seconds:()=>1,isReal:()=>false,updatePlan:()=>({}),applyTrigger(){},configureScope:async()=>Uint8Array.of(0,0,0),_startWatchdog(){},_stopWatchdog(){},_absorbeStatusBackend(){},benchFresh:()=>false,setStatusText(){},syncButtons(){},hidXfer:async(cmd,data)=>{if(data[0]===2){reached.resolve();return status.promise;}return Uint8Array.of(0,0,0);}});
 const start=v.start();await reached.promise;const stop=v.stop();status.resolve(Uint8Array.of(0,0,0));await Promise.all([start,stop]);
 assert.equal(v.running,false);assert.equal(v.transport.running,false);assert.equal(v._capturing,false);
}
console.log('scope-lifecycle: double start, cancellation during CONFIG/STATUS, STOP before USB drain PASS');
{
 const v=Object.create(ScopeView.prototype);let drained=false;
 Object.assign(v,{hid:{},transport:{stop:async()=>{drained=true;}},hidXfer:async()=>{throw new Error('HID unavailable');}});
 await assert.rejects(v._stopData(),/无法确认采样已停止/);assert.equal(drained,true,'USB still drained when control stop fails');
}
{
 const v=Object.create(ScopeView.prototype);let stopped=0;
 Object.assign(v,{selected:[],usingMock:true,mockVars:()=>[],syncButtons(){},setStatusText(){},_stopWatchdog(){},_stopData:async()=>{stopped++;}});
 await v.start();assert.equal(stopped,0,'invalid start cannot stop someone else\'s engine');
}
console.log('scope-lifecycle: STOP errors propagate while USB drains; rejected input does not send STOP PASS');
{
 const v=Object.create(ScopeView.prototype),events=[];let fail=true;
 const hid={close:async()=>{if(fail)throw new Error('HID close failed');}};
 Object.assign(v,{hid,stop:async()=>{},syncButtons(){},setStatusText(){},probeManager:{cancel(){},fail:(owner,e)=>events.push([owner,e.message]),forget:owner=>events.push(['forget',owner])}});
 await assert.rejects(v.releaseProbe(),/HID close failed/);assert.equal(v.hid,hid);
 assert.deepEqual(events,[['scope','HID close failed']]);
 fail=false;await v.releaseProbe();assert.equal(v.hid,null);assert.deepEqual(events.at(-1),['forget','scope']);
}
console.log('scope-lifecycle: HID close failure retains handle and ownership until successful retry PASS');
