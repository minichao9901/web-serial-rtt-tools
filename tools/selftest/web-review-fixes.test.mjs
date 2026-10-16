import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {SerialSession} from '../../app/serial/session.js';
import {Assistant} from '../../app/serial/assistant.js';
import {AnalogView} from '../../app/analog/view.js';
import {SpiSession} from '../../app/spi/session.js';
import {SpiBusView} from '../../app/spi/bus-view.js';
import {AcqView} from '../../app/spi/acq-view.js';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';
import {I2cView} from '../../app/i2c/view.js';
import {parseScript} from '../../app/i2c/dsl.js';
import {RiscvDebugSession} from '../../app/dbg/riscv.js';
import {REGNO} from '../../app/flash/hpm/jtag.js';
import {SpiCdcSession} from '../../app/spi-cdc/session.js';
import {BusPeriodicClient,BUS} from '../../app/core/bus-periodic.js';
const {document}=parseHTML(readFileSync(new URL('../../index.html',import.meta.url),'utf8'));globalThis.document=document;
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
{
 const s=new SerialSession();let fails=true,tx=0;s.isOpen=true;s.port={getInfo:()=>({}),writable:{getWriter:()=>({write:async()=>{if(fails)throw Error('write failure');tx++;}})}};s.on('error',()=>{});
 await assert.rejects(s.write(Uint8Array.of(1)),/write failure/);fails=false;assert.equal(await s.write(Uint8Array.of(2)),true);assert.equal(tx,1);
 const held=gate();s.writer={write:async()=>held.promise};const manual=s.write(Uint8Array.of(3));await tick();const cancel=new AbortController();const queued=s.write(Uint8Array.of(4),{signal:cancel.signal});cancel.abort();held.resolve();await manual;assert.equal(await queued,false);
}
{
 const s=new SerialSession(),held=gate();let submitted=0;s.isOpen=true;s.port={getInfo:()=>({}),writable:{getWriter:()=>({write:async()=>held.promise})}};const write=s.write.bind(s);s.write=(...a)=>{submitted++;return write(...a);};
 const a=new Assistant(s);a.txSeg={value:'ascii'};document.getElementById('s-tx').value='X';document.getElementById('s-timer').checked=true;document.getElementById('s-timer-ms').value='20';a._armTimer();await sleep(100);assert.equal(submitted,1,'slow writes do not build up timer commands');document.getElementById('s-timer').checked=false;a._armTimer();held.resolve();await sleep(45);assert.equal(submitted,1);
}
{
 const v=new AnalogView();v.renderAdc=()=>{};v.status=()=>{};v.store.append({codes:Uint16Array.of(1,2,3),rate:1000,bits:16});v.total=3;document.getElementById('an-reference').value='3.3';await assert.rejects(v.acquire(10),/先连接/);assert.equal(v.store.length,3);
 v.session.acquire=async()=>{throw Error('START failed');};await assert.rejects(v.acquire(10),/START failed/);assert.equal(v.store.length,3);
 globalThis.requestAnimationFrame=fn=>{fn();return 1;};v.session.acquire=async(options,onBlock)=>onBlock({codes:Uint16Array.of(7,8),rate:1000,bits:16});await v.acquire(2);assert.equal(v.store.length,2);assert.equal(v.total,2);
}
{
 const s=new SpiSession();s.hid={connected:true};s.transport={};s.busy=true;let called=false;s.hid.xfer=async()=>{called=true;};
 for(const op of [()=>s.reset(),()=>s.abort(),()=>s.setEnabled(false),()=>s.applyProfile({}),()=>s.applyConfig({}),()=>s.setMock(false)])await assert.rejects(op(),/SPI 任务/);
 assert.equal(called,false);const v=new SpiBusView(s);v.refreshButtons();for(const id of ['sp-set','sp-pin-apply','sp-disable','sp-reset','sp-abort','sp-mock'])assert.equal(document.getElementById(id).disabled,true);
 let retries=0;s._periodic={client:{stopError:Error('STOP failed'),stop:async()=>{retries++;}}};s.probeManager={confirm(){}};
 const acq=new AcqView({session:s});acq.renderPill();assert.equal(document.getElementById('sp-dsl-stop').textContent,'重试停止');assert.equal(document.getElementById('sp-dsl-stop').disabled,false);await acq.stop('retry');assert.equal(retries,1);assert.equal(s.busy,false);assert.equal(s._periodic,null);
}
{
 const s=new SpiSession();s.hid={connected:true};s.hidAction=async()=>Uint8Array.of(8,0x35,1,1,0,0,0);s.pollStatus=async()=>null;const messages=[];s.log=(kind,text)=>messages.push({kind,text});await assert.rejects(s.setEnabled(false),/无法确认/);assert.equal(messages.some(m=>m.kind==='g'),false);
}
{
 const p=new WebUsbDapProbe(),held=gate(),healing=gate(),events=[];p._readMemLocked=async addr=>{events.push('read'+addr);if(addr===1)await held.promise;return new Uint8Array(4);};p._targetInit=async()=>{events.push('heal');await healing.promise;};
 const a=p.readMem(1,4);await tick();p._faulted=true;const b=p.readMem(2,4),c=p.readMem(3,4);await tick();assert.deepEqual(events,['read1']);held.resolve();await a;await tick();assert.deepEqual(events,['read1','heal']);healing.resolve();await Promise.all([b,c]);assert.deepEqual(events,['read1','heal','read2','read3']);
 p._faulted=true;p._targetInit=async()=>{throw Error('heal failed');};await assert.rejects(p.readMem(4,4),/heal failed/);assert.equal(p._faulted,true);assert.equal(events.includes('read4'),false);
}
{
 const p=new WebUsbDapProbe();p.device={};p._usb={reset:async()=>{}};p._claim=async()=>{};p._note=()=>{};await p._onXferTimeout('test');assert.equal(p._targetNeedsReconnect,true);assert.equal(p._faulted,true);p._ready=true;await assert.rejects(p._ctrl(0x14,new Uint8Array()),e=>e.code==='DAP_SESSION_LOST');p._dapPort=2;await assert.rejects(p.readMem(0,4),/重新连接/);
 const q=new WebUsbDapProbe();q.maxWords=120;q._setTAR=async()=>{};q._transferBlock=async()=>({count:0,words:[]});await assert.rejects(q._readMemOnce(0x20000000,8),/无进展/);let n=0;q._transferBlock=async()=>++n===1?{count:1,words:[0x12345678]}:{count:0,words:[]};await assert.rejects(q._readMemOnce(0x20000000,8),/20000004/);
}
{
 const v=new I2cView();v.session={connected:true,log(){}};v._flushSoon=()=>{};v._runPill=()=>{};v.results.set(0,{text:'table data'});v._parseDsl=()=>parseScript('rd 0x50 0x00 1');v._run=async items=>{for(const item of items)v._onRunEvent({type:'item',phase:'done',item,err:0,hex:'AA',ms:1});};await v._runScript(false);assert.equal(v.results.get(0).text,'table data');v._onRunEvent({type:'item',phase:'done',item:{kind:'xfer',resultRow:1},err:0,hex:'BB',ms:1});assert.ok(v.results.get(1).text.includes('BB'));
}
for(const resumes of [true,false]){
 const s=Object.create(RiscvDebugSession.prototype);let requested=false,stepCleared=false;s.halted=true;s._ensureHalted=async()=>{};s._withBpCleared=async(pc,fn)=>fn();s.refresh=async()=>{};s.refreshRegs=async()=>{};s._haltQuiet=async()=>{s.halted=true;};
 s.dm={_ctl:(h,extra=0)=>extra,dmiRead:async()=>0x300|(requested&&resumes?(3<<16):0),readReg:async r=>r===REGNO.PC?0x80000000:0,writeReg:async(r,val)=>{if(r===REGNO.DCSR&&!(val&4))stepCleared=true;},dmiWrite:async(a,value)=>{requested=!!value;},waitHalted:async()=>{}};
 if(resumes)assert.equal(await s.step(),'step','fresh ack permits a same-PC self-loop');else{ s._waitResumed=async()=>false;await assert.rejects(s.step(),/未确认/); }assert.equal(stepCleared,true);
}
{
 const hid={connected:true,request:async()=>{},xfer:async()=>{throw Error('body');},close:async()=>{throw Error('cleanup');}};const s=new SpiCdcSession({hidFactory:()=>hid});await assert.rejects(s.connect(),e=>e instanceof AggregateError&&e.errors[0].message==='body'&&e.errors[1].message==='cleanup');assert.equal(s.hid,hid);
 const c=new BusPeriodicClient();c.command=async a=>a===0?Uint8Array.of(66,80,84,49,8,0,2,16,54,32):a===3?new Uint8Array(4):a===8?Promise.reject(Error('body')):new Uint8Array();c.stop=async()=>{throw Error('cleanup');};await assert.rejects(c.run(BUS.I2C,[{period:10,count:1,records:[{kind:BUS.DELAY,data:new Uint8Array(4)}]}]),e=>e instanceof AggregateError&&e.errors.length===2&&e.cause.message==='body');
}
{
 const s=Object.create(RiscvDebugSession.prototype);let cleared=false;s.halted=true;s._ensureHalted=async()=>{};s._withBpCleared=async(pc,fn)=>fn();s._haltQuiet=async()=>{s.halted=true;};
 s.dm={_ctl:(h,extra=0)=>extra,dmiRead:async()=>0,readReg:async r=>r===REGNO.PC?0x80000000:0,writeReg:async(r,value)=>{if(r===REGNO.DCSR&&!(value&4))cleared=true;},dmiWrite:async(a,value)=>{if(value)throw Error('resume reply lost');}};
 await assert.rejects(s.step(),/resume reply lost/);assert.equal(cleared,true,'lost resume reply still clears temporary step after halting');
}
{
 const s=new SpiSession(),held=gate();s.hid={connected:true};s.transport={sendPacks:async()=>held.promise};
 const frame=s.sendFrames([{type:1,payload:new Uint8Array(),flags:0}]);await tick();assert.equal(s.busy,true,'single-frame operations own busy state');
 s.setBusy(false);assert.equal(s.busy,true,'an unrelated busy reset cannot release an in-flight frame');await assert.rejects(s.reset(),/SPI 任务/);await assert.rejects(s.setMock(false),/SPI 任务/);
 held.resolve({sent:1,failed:0});await frame;assert.equal(s.busy,false);
}
console.log('web-review fixes: failure propagation, timer backpressure/cancel, ADC retention, SPI mutation/STOP/state, serialized DAP recovery/short reads, I2C source isolation, confirmed RV step, dual errors PASS');
