// Actual board route/controller validation. Requires exclusive SWD/Kingst ownership; does not flash firmware.
import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {ProbeManager} from '../../app/core/probe-manager.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const etmRoot=process.env.ETM_ROOT||resolve(root,'../web-etm-trace');
const {EtmTarget}=await import(pathToFileURL(resolve(etmRoot,'web/app/target.js')));
const output=process.env.VALIDATION_DIR;if(!output)throw Error('Set VALIDATION_DIR to a new persistent run directory');
const base=(process.env.APP||'http://127.0.0.1:8878')+'/etm/api/',bridge=process.env.PROBE_BRIDGE||'http://127.0.0.1:8772',sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function rpc(path,body={}){const r=await fetch(bridge+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
const probe={readMemDiagnostic:async(address,length)=>new Uint8Array(Buffer.from((await rpc('/read',{address,length})).data,'base64')),writeMemDiagnostic:async(address,bytes)=>rpc('/write',{address,data:Buffer.from(bytes).toString('base64')}),halt:()=>rpc('/halt'),run:()=>rpc('/run'),disconnect:async()=>{}};
const Probe={supported:()=>true,authorized:async()=>[{vendorId:0x0d28}],open:async()=>probe};
const manager=new ProbeManager({locks:null});let busy=false;
const host={probeType:Probe,run:fn=>manager.run('etm',fn)};
const t=new EtmTarget(console.log,{host});t.hseHz=8e6;
manager.register('etm',{resources:['target-engine','dap-bulk'],active:()=>!!t.probe,protected:()=>busy,release:()=>t.disconnect()});
manager.register('dbg',{resources:['target-engine','dap-bulk'],active:()=>false,release:async()=>{}});
async function api(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',...(body instanceof FormData?{body}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
const form=new FormData();form.append('elf',new Blob([await readFile(process.env.ELF||resolve(etmRoot,'firmware/stm32f103_cdc_trace/fw-ze.elf'))]),'fw-ze.elf');
const elf=await api('elf',form),entry=elf.functions.find(f=>f.name==='cdc_poll').address,records=[];
try{
 await host.run(()=>t.connect());await t.verifyElf(elf);assert.equal((await t.inspect()).clocks.coreHz,48000000);
 if(elf.download)assert.ok(elf.download.startsWith('/etm/api/'));
 for(const mode of ['reset','no-reset','stop','reset']){
  busy=true;
  try{await host.run(async()=>{
   await t.verifyElf(elf);if(mode==='no-reset')await t.runTo(entry);else await t.reset({address:entry});
   const info=await t.configure({branchBroadcast:false});assert.equal(info.clocks.physicalTraceHz,24000000);
   const job=await api('capture',{rate:500000000,seconds:.01,threshold:2,sync:true,decode:mode!=='stop',clock:0,data:[1,2,3,4],fraction:.25,config:t.config,elfId:elf.elfId,targetVerified:true,targetSnapshot:info,captureScope:'business-unfiltered-window',captureEntry:entry});
   let continued=false,state;const until=Date.now()+60000;
   for(;;){state=await api('jobs/'+job.job);
    if(state.state==='armed'&&!continued){
     assert.equal(await t.isHalted(),true);assert.equal(await t.pc(),entry);
     await assert.rejects(manager.run('dbg',async()=>{}),/正在使用探针/);
     if(mode==='stop')await api('stop/'+job.job,{});else await t.run();continued=true;
    }
    if(['done','error'].includes(state.state))break;
    if(Date.now()>until)throw Error('capture timeout');await sleep(25);
   }
   if(mode==='stop'){assert.equal(await t.isHalted(),true);records.push({mode,...job,state:state.state,error:state.error});}
   else{
    assert.equal(state.state,'done',state.error);const r=await api('browse/'+job.record+'/overview');
    assert.equal(r.summary.instructions,r.summary.sourceMapped);assert.ok(r.summary.instructions>10000);
    for(const key of ['packetIssues','overflowPackets','unprocessedBytes','unknownSourceBytes'])assert.equal(r.quality[key],0,key);
    records.push({mode,...job,summary:r.summary,quality:r.quality});console.log('PASS',mode,job.record,r.summary.instructions);
   }
   await t.restore();
  });}finally{busy=false;}
 }
 await manager.run('dbg',async()=>{});assert.equal(t.probe,null);assert.equal(manager.leases.has('etm'),false);
 await host.run(()=>t.connect());assert.equal((await t.inspect()).clocks.coreHz,48000000);
 await writeFile(resolve(output,'hardware-result.json'),JSON.stringify({elfSha:elf.sha256,entry,records,method:'same-origin API and actual EtmTarget/ProbeManager; SWD via persistent pyOCD bridge, not browser WebUSB',validationRunId:process.env.VALIDATION_RUN_ID||null,handoffPassed:true},null,2));
}finally{
 try{await t.restore();if(t.probe)await t.run();await t.disconnect();}finally{t.bus.close();await rpc('/shutdown');}
}
