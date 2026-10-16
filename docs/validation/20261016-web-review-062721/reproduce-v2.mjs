import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
const root=new URL('../../../',import.meta.url);
const {document}=parseHTML(await readFile(new URL('index.html',root),'utf8'));
globalThis.document=document;
const {SerialSession}=await import(new URL('app/serial/session.js',root));
const {Assistant}=await import(new URL('app/serial/assistant.js',root));
const {AnalogView}=await import(new URL('app/analog/view.js',root));
const {SpiSession}=await import(new URL('app/spi/session.js',root));
const {SpiBusView}=await import(new URL('app/spi/bus-view.js',root));
const {AcqView}=await import(new URL('app/spi/acq-view.js',root));
const {createProbeManager}=await import(new URL('app/core/probe-users.js',root));
const {ACT}=await import(new URL('app/spi/protocol.js',root));
const rows=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function repro(id,fn){try{rows.push({id,result:'reproduced',...await fn()});}catch(e){rows.push({id,result:'not-reproduced',error:e.stack});}}
await repro('F01-serial-write-success-on-failure',async()=>{
 const s=new SerialSession(),events=[];s.isOpen=true;s.port={getInfo:()=>({}),writable:{getWriter:()=>({write:async()=>{throw Error('injected write failure');}})}};s.on('error',e=>events.push(e.message));
 let rejected=false;await s.write(Uint8Array.of(1)).catch(()=>rejected=true);assert.equal(rejected,false);assert.deepEqual(events,['injected write failure']);return {callerRejected:rejected,errorEvents:events};
});
await repro('F02-timer-sends-after-stop',async()=>{
 const s=new SerialSession();let unlock,submitted=0,finished=0;
 s.isOpen=true;s.port={getInfo:()=>({}),writable:{getWriter:()=>({write:async()=>{if(!unlock)await new Promise(r=>unlock=r);finished++;}})}};
 const write=s.write.bind(s);s.write=b=>{submitted++;return write(b);};
 const a=new Assistant(s);a.txSeg={value:'ascii'};document.getElementById('s-tx').value='X';document.getElementById('s-timer').checked=true;document.getElementById('s-timer-ms').value='20';
 a._armTimer();await sleep(145);document.getElementById('s-timer').checked=false;a._armTimer();const atStop={submitted,finished};unlock();await s._wq;assert.ok(atStop.submitted>=4);assert.equal(atStop.finished,0);assert.equal(finished,atStop.submitted);return {atStop,finishedAfterStop:finished};
});
await repro('F03-adc-invalid-start-erases-history',async()=>{
 const v=new AnalogView();v.renderAdc=()=>{};v.status=()=>{};v.store.append({codes:Uint16Array.of(1,2,3),rate:1000,bits:16});v.total=3;
 document.getElementById('an-reference').value='3.3';const before=v.store.length;let error;try{await v.acquire(10);}catch(e){error=e.message;}
 assert.equal(before,3);assert.equal(v.store.length,0);assert.match(error,/先连接探针/);return {before,after:v.store.length,error};
});
await repro('F04-spi-mutation-allowed-while-busy',async()=>{
 const s=new SpiSession(),calls=[];s.hid={connected:true};s.transport={};s.busy=true;
 const v=new SpiBusView(s);v.refreshButtons();const buttons=Object.fromEntries(['sp-set','sp-pin-apply','sp-disable','sp-reset','sp-abort'].map(id=>[id,document.getElementById(id).disabled]));
 s.hidAction=async(action)=>{calls.push(action);return Uint8Array.of(8,0x35,action,0,0,0,0);};s.pollStatus=async()=>{};await s.reset();assert.ok(calls.includes(ACT.RESET));assert.ok(Object.values(buttons).every(x=>x===false));return {busy:s.busy,disabled:buttons,commandsSent:calls};
});
await repro('F05-spi-stop-failure-has-no-ui-retry',async()=>{
 const s=new SpiSession();s.hid={connected:true};s.transport={};s.busy=true;s._periodic={client:{stopError:Error('injected STOP failure'),owned:true}};
 const a=new AcqView({session:s});a.renderPill('idle');const disconnected=await s.disconnect();const manager=createProbeManager({spiSession:s},{locks:null});let takeoverError='';try{await manager.run('i2c',async()=>{});}catch(e){takeoverError=e.message;}
 assert.equal(disconnected,false);assert.equal(document.getElementById('sp-dsl-stop').disabled,true);assert.match(takeoverError,/正在使用探针/);return {disconnectResult:disconnected,stopButtonDisabled:document.getElementById('sp-dsl-stop').disabled,takeoverError};
});
await repro('F06-spi-disable-rejected-but-reports-success',async()=>{
 const s=new SpiSession(),logs=[];s.hid={connected:true};s.log=(kind,text)=>logs.push({kind,text});s.pollStatus=async()=>{};
 const enabledPlusBusy=1|(3<<8);s.hidAction=async()=>{const reply=Uint8Array.of(8,0x35,ACT.ENABLE,0,0,0,0);new DataView(reply.buffer).setUint32(3,enabledPlusBusy,true);return reply;};
 const result=await s.setEnabled(false);assert.equal(result,true);assert.ok(logs.some(l=>l.kind==='g'&&l.text.includes('桥已失能')));return {returned:result,responseEnabled:true,logs};
});
await writeFile(new URL('reproductions-v2.json',import.meta.url),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));if(rows.some(r=>r.result!=='reproduced'))process.exitCode=1;

