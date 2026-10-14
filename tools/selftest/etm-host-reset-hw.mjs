// Real akaLinkPro bytes via tools/usb_acceptance_bridge.py; all SWD logic uses the toolbox driver.
// Requires exclusive probe/Kingst ownership and the installed F103ZE 48/24 MHz fixture. No flashing.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';
import {EtmTarget} from '../../bridge/etm/backend/web/app/target.js';
const output=process.env.VALIDATION_DIR;if(!output)throw Error('Set VALIDATION_DIR');
const base=(process.env.APP||'http://127.0.0.1:8884')+'/etm/api/';
async function usb(op,more={}){const r=await fetch('http://127.0.0.1:8768',{method:'POST',body:JSON.stringify({op,...more})});const d=await r.json();if(d.error)throw Error(d.error);return d.value;}
async function api(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',...(body instanceof FormData?{body}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
const p=new WebUsbDapProbe(),t=new EtmTarget(console.log,{host:{}}),report={method:'production toolbox WebUsbDapProbe, raw USB bytes, actual F103ZE + Kingst',rounds:[],passed:false};let resets=0,jobId=null;
p.device={transferOut:async(ep,data)=>{assert.equal(ep,2);return {bytesWritten:await usb('write',{bytes:[...data]})};},transferIn:async ep=>{assert.equal(ep,1);const b=Uint8Array.from(await usb('read'));return {data:new DataView(b.buffer)};}};
Object.assign(p,{pkt:512,maxWords:120,epOut:2,epIn:1,_framing:'short',_ready:true,skipClearHalt:true,onLog:console.log});t.probe=p;t.hseHz=8e6;
const write=p._writeMemOnce.bind(p);p._writeMemOnce=async(a,b,...args)=>{if(a===0xe000ed0c)resets++;return write(a,b,...args);};
try{
 await p._targetInit({clock:1000000});await t.inspect();
 const form=new FormData();form.append('elf',new Blob([await readFile(resolve('bridge/etm/backend/firmware/stm32f103_cdc_trace/fw-ze.elf'))]),'fw-ze.elf');
 const elf=await api('elf',form),entry=elf.functions.find(f=>f.name==='cdc_acm_init').address,poll=elf.functions.find(f=>f.name==='cdc_poll').address;
 report.elfSha=elf.sha256;report.entry=entry;await t.verifyElf(elf);
 const bp=t.breakpoints.add({name:'cdc_acm_init',address:entry});await t.breakpoints.arm(bp);
 for(let round=0;round<3;round++){
  const leased=t.breakpoints.items.filter(b=>b.lease);await t.verifyElf(elf);await t.breakpoints.suspend();const before=resets;
  await t.reset({address:entry});assert.equal(await t.pc(),entry);assert.equal(resets-before,1);
  const info=await t.configure({branchBroadcast:false});assert.equal(info.clocks.coreHz,48e6);assert.equal(info.clocks.physicalTraceHz,24e6);
  const job=await api('capture',{rate:500000000,seconds:.01,threshold:1.65,sync:true,decode:true,clock:0,data:[1,2,3,4],fraction:.25,config:t.config,elfId:elf.elfId,targetVerified:true,targetSnapshot:info,captureEntry:entry});jobId=job.job;
  let resumed=false,state;const deadline=Date.now()+90000;
  for(;;){state=await api('jobs/'+jobId);
   if(state.state==='armed'&&!resumed){assert.equal(await t.pc(),entry);await t.run();resumed=true;}
   if(['done','error'].includes(state.state))break;if(Date.now()>deadline)throw Error('capture timeout');await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(state.state,'done',state.error);jobId=null;
  const overview=await api('browse/'+job.record+'/overview');assert.ok(overview.summary.instructions>10000);
  for(const name of ['packetIssues','overflowPackets','unprocessedBytes','unknownSourceBytes'])assert.equal(overview.quality[name],0,name);
  await t.restore();await t.halt();await t.breakpoints.resume(leased);
  assert.ok(bp.lease);assert.equal(await t.read(bp.lease.slot),bp.lease.encoded);
  await t.runTo(poll);assert.equal(await t.pc(),poll);
  report.rounds.push({round,record:job.record,resets:resets-before,entry,runTo:poll,breakpointRestored:true,summary:overview.summary,quality:overview.quality});
  console.log('PASS',round,job.record,overview.summary.instructions);
 }
 await t.halt();const pc=await t.pc();const dhcsr=await t.read(0xe000edf0);
 await t.recoverDebugPort();assert.equal(await t.pc(),pc);assert.equal(await t.isHalted(),true);assert.equal(resets,3);report.recovery={pc,dhcsr,noReset:true,keptHalted:true};report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;}
finally{
 try{if(jobId)await api('stop/'+jobId,{});await t.halt();await t.clearEntryBreak();await t.breakpoints.clear();await t.restore();await t.run();report.finalRunning=!(await t.isHalted());assert.equal(report.finalRunning,true);}catch(e){report.cleanupError=e.stack;process.exitCode=1;}
 await usb('quit').catch(()=>{});await writeFile(resolve(output,'host-hardware-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,rounds:report.rounds.length,error:report.error,cleanupError:report.cleanupError}));
}
