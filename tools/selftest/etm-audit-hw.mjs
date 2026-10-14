// Exclusive F103ZE/Kingst acceptance. Real toolbox driver over raw USB bytes; no flashing.
import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';import {EtmTarget} from '../../bridge/etm/backend/web/app/target.js';
const out=process.env.VALIDATION_DIR;if(!out)throw Error('Set VALIDATION_DIR');const base=(process.env.APP||'http://127.0.0.1:8886')+'/etm/api/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function usb(op,more={}){const r=await fetch('http://127.0.0.1:8768',{method:'POST',body:JSON.stringify({op,...more})});const d=await r.json();if(d.error)throw Error(d.error);return d.value;}
async function api(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',...(body instanceof FormData?{body}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
const p=new WebUsbDapProbe(),t=new EtmTarget(console.log,{host:{}}),report={method:'actual toolbox JS + raw USB + F103ZE/Kingst',cases:[],passed:false,flashWrites:false};let jid=null,resets=0;
p.device={transferOut:async(ep,data)=>({bytesWritten:await usb('write',{bytes:[...data]})}),transferIn:async()=>{const b=Uint8Array.from(await usb('read'));return {data:new DataView(b.buffer)};}};
Object.assign(p,{pkt:512,maxWords:120,epOut:2,epIn:1,_framing:'short',_ready:true,skipClearHalt:true,onLog:console.log});t.probe=p;t.hseHz=8e6;
const write=p._writeMemOnce.bind(p);p._writeMemOnce=async(a,b,...rest)=>{if(a===0xe000ed0c)resets++;return write(a,b,...rest);};
async function terminal(job){const until=Date.now()+150000;for(;;){const s=await api('jobs/'+job);if(['done','cancelled','error'].includes(s.state))return s;if(Date.now()>until)throw Error('Hardware task watchdog');await sleep(50);}}
try{
 await p._targetInit({clock:1000000});const info=await t.inspect();assert.equal(info.profile,'stm32f103ze');assert.equal(info.clocks.coreHz,48e6);
 const form=new FormData();form.append('elf',new Blob([await readFile(resolve('bridge/etm/backend/firmware/stm32f103_cdc_trace/fw-ze.elf'))]),'fw-ze.elf');const elf=await api('elf',form);await t.verifyElf(elf);report.elfSha=elf.sha256;
 const entry=elf.functions.find(f=>f.name==='cdc_acm_init').address,poll=elf.functions.find(f=>f.name==='cdc_poll').address;
 const bp=t.breakpoints.add({address:entry,label:'cdc_acm_init'});await t.breakpoints.arm(bp);const la=await api('status');
 const modes=process.env.MODES?.split(',')||['reset-1ms','reset-2ms','reset-5ms','reset-10ms','run-to-10ms','queued-stop','armed-stop','reset-after-stop'];
 for(const mode of modes){
  const bps=t.breakpoints.items.filter(b=>b.lease);await t.halt();await t.breakpoints.suspend();const before=resets;
  if(mode==='run-to-10ms')await t.runTo(poll);else await t.reset({address:entry});
  const at=mode==='run-to-10ms'?poll:entry;const configured=await t.configure({branchBroadcast:false});assert.equal(await t.pc(),at);
  const ms=Number(/-(\d+)ms/.exec(mode)?.[1]||5),rate=mode.startsWith('200m-')?200000000:process.env.EXERCISE_200M&&mode==='reset-2ms'&&la.rates.includes(200000000)?200000000:500000000;
  const fraction=mode.startsWith('200m-phase10-')?.1:.25;
  const job=await api('capture',{rate,seconds:ms/1000,threshold:mode==='reset-5ms'?2:1.65,sync:true,decode:true,clock:0,data:[1,2,3,4],fraction,config:t.config,elfId:elf.elfId,targetVerified:true,targetSnapshot:configured,captureEntry:at,captureScope:'business-unfiltered-window',libraryOrigin:'validation'});jid=job.job;
  let state,resumed=false;
  if(mode==='queued-stop'){await api('stop/'+jid,{});state=await terminal(jid);}
  else{
   const until=Date.now()+150000;for(;;){state=await api('jobs/'+jid);
    if(state.state==='armed'&&!resumed){if(mode==='armed-stop')await api('stop/'+jid,{});else await t.run();resumed=true;}
    if(['done','cancelled','error'].includes(state.state))break;if(Date.now()>until)throw Error('Task watchdog');await sleep(50);
   }
  }
  if(['queued-stop','armed-stop'].includes(mode)){assert.equal(state.state,'cancelled',JSON.stringify(state));assert.equal(await t.isHalted(),true);assert.equal(await t.pc(),at);report.cases.push({mode,record:job.record,state:state.state,noCpuResume:true,noOldBufferExport:true});}
  else{assert.equal(state.state,'done',JSON.stringify(state));const r=await api('browse/'+job.record+'/overview');assert.ok(r.summary.instructions>100);
   for(const key of ['packetIssues','overflowPackets','unprocessedBytes','unknownSourceBytes'])assert.equal(r.quality[key],0,key);
   report.cases.push({mode,record:job.record,rate,fraction,ms,summary:r.summary,quality:r.quality,resets:resets-before});
  }
  jid=null;await t.restore();await t.halt();await t.breakpoints.resume(bps);assert.ok(bp.lease);await t.run();
  console.log('PASS',mode,report.cases.at(-1).summary?.instructions||'cancelled');
 }
 await t.halt();await t.breakpoints.suspend();
 const beforeTimeout=Date.now();await assert.rejects(t.runTo(entry,{timeout:250}),/超时/);assert.ok(Date.now()-beforeTimeout<4000);assert.equal(t.entryBreak,null);assert.equal(await t.isHalted(),true);report.cases.push({mode:'one-shot-entry-without-reset',expectedTimeout:true,temporaryBreakpointRemoved:true});
 const waiting=t.runTo(entry,{timeout:5000});const cancel=setTimeout(()=>{t.cancelEntry=true;},150);await assert.rejects(waiting,/取消/);clearTimeout(cancel);assert.equal(t.entryBreak,null);report.cases.push({mode:'cancel-entry-wait',halted:true,temporaryBreakpointRemoved:true});
 await t.breakpoints.arm(bp);const pc=await t.pc();p._faulted=true;await t.recoverDebugPort();assert.equal(await t.pc(),pc);assert.equal(await t.isHalted(),true);report.cases.push({mode:'explicit-recovery-software-fault-latch',pc,preservedHalt:true});report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{
 try{if(jid)await api('stop/'+jid,{});await t.halt();await t.clearEntryBreak();await t.breakpoints.clear();await t.restore();await t.run();report.finalRunning=!(await t.isHalted());}catch(e){report.cleanupError=e.stack;process.exitCode=1;}
 await usb('quit').catch(()=>{});await writeFile(resolve(out,'hardware-matrix.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,error:report.error,cleanupError:report.cleanupError}));
}
