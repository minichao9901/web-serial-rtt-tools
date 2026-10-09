// Explicit opt-in: replaces target test program, leaves the HSE 72 MHz fixture running.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {Cdp,sleep} from './cdp-lib.mjs';
import {analyzeTrace} from '../../app/swo/analyze.js';
import {packRecording} from '../../app/swo/recording.js';
import {SwoDecoder} from '../../app/swo/decoder.js';
import {symbolIndex} from '../../app/swo/analyze.js';
import {stageOracle} from './swo-stage-oracle.mjs';
assert.equal(process.env.SWO_CLOCK_FLASH,'1','Set SWO_CLOCK_FLASH=1 to authorize the cooperative target fixture');
const base='tools/target-firmware/stm32f103cb_swo_clock/',elf=readFileSync(base+'fw.elf'),out=process.env.SWO_OUT||'tmp/swo-clock-hw';mkdirSync(out,{recursive:true});
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9345',40000),ocd='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe',arm='E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/';
const report={rows:[],fixture:base+'fw.elf'};
function command(t,name){const p=spawnSync(ocd,['-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c',t],{encoding:'utf8',windowsHide:true,timeout:45000});writeFileSync(out+'/'+name+'.log',p.stdout+p.stderr);assert.equal(p.status,0,p.stdout+p.stderr);return p.stdout+p.stderr;}
const path=p=>'{'+resolve(p).replaceAll('\\','/')+'}';
async function release(){await c.eval(`const t=__tools;if(t.swo.capture.active)await t.swo.capture.stop();if(t.dbg.session.connected)await t.dbg.disconnect();if(t.session.isOpen)await t.session.close();t.swo.pause();`);}
function oracle(model){const pcs=[...new Set(model.pcSamples.map(e=>e.pc))],p=spawnSync(arm+'arm-none-eabi-addr2line.exe',['-f','-e',base+'fw.elf'],{input:pcs.map(x=>x.toString(16)).join('\n')+'\n',encoding:'utf8',windowsHide:true});assert.equal(p.status,0);const rows=p.stdout.trim().split(/\r?\n/);let checked=0;for(let i=0;i<pcs.length;i++){const e=model.pcSamples.find(x=>x.pc===pcs[i]),m=/([^:]+):(\d+)/.exec(rows[2*i+1]);if(!e.location||!m||!Number(m[2]))continue;assert.equal(e.fn,rows[2*i]);assert.equal(e.location.file.replaceAll('\\','/').split('/').pop(),m[1].replaceAll('\\','/').split('/').pop());assert.equal(e.location.line,Number(m[2]));checked++;}assert.ok(checked>20);return checked;}
try{
 await c.connect();await release();await c.send('Page.navigate',{url:'http://127.0.0.1:8911/index.html?clock-hw='+Date.now()+'#swo'});await sleep(600);
 if(!existsSync(out+'/before.bin')){const log=command('init; halt; flash probe 0; dump_image '+path(out+'/before.bin')+' 0x08000000 131072; dump_image '+path(out+'/confirm.bin')+' 0x08000000 131072; resume; shutdown','backup');assert.match(log,/flash size = 128 KiB/);assert.deepEqual(readFileSync(out+'/before.bin'),readFileSync(out+'/confirm.bin'));}
 command('init; program '+path(base+'fw.elf')+' verify reset exit','flash');await sleep(300);
 const sources=Object.fromEntries(['main.c','pipeline.c','startup.c','pipeline.h','clock.c'].map(n=>[n,readFileSync(base+'src/'+n,'utf8')]));
 await c.eval(`const v=__tools.swo;await v.loadElf(Uint8Array.from(atob(${JSON.stringify(elf.toString('base64'))}),c=>c.charCodeAt(0)).buffer,'f103cb_swo_clock.elf');v.sources.indexFileList(Object.entries(${JSON.stringify(sources)}).map(([n,t])=>new File([t],n)));`);
 for(const cfg of JSON.parse(process.env.SWO_CASES||'null')||[{hz:72e6,period:512,timestamps:true,itm:true,seconds:.5},{hz:32e6,period:256,timestamps:true,itm:true,seconds:.5},{hz:24e6,period:128,timestamps:true,itm:true,seconds:.5},{hz:24e6,period:64,timestamps:false,itm:false,seconds:.35}]){
  const i=report.rows.length;
  await c.eval(`const v=__tools.swo;await v.refreshPorts();v.capture.probeManager=v.probeManager;await v.capture.start({coreHz:72e6,autoClock:true,hseHz:8e6,targetClockHz:${cfg.hz},baudRate:24e6,autoBaud:true,receiverMode:2,periodCycles:${cfg.period},timestamps:${cfg.timestamps},itm:${cfg.itm},seconds:${cfg.seconds},port:v.ports[0],elf:v.elf.elf,elfSha256:v.elf.sha256,verifyElf:p=>v.verifyElf(p),onTarget:t=>v.showTarget(t)});`);
  for(let n=0;n<200;n++){if(await c.eval('return !__tools.swo.capture.active&&!__tools.swo.analyzing&&!!__tools.swo.result;'))break;await sleep(50);}
  const data=await c.eval(`const v=__tools.swo;if(!v.recording)throw Error(document.getElementById('sw-warning').textContent+' / '+JSON.stringify(v.capture.metadata));let text='';for(let p=0;p<v.recording.raw.length;p+=8192)text+=String.fromCharCode(...v.recording.raw.subarray(p,p+8192));return {raw:btoa(text),metadata:v.recording.metadata,errors:__tools.errors};`),raw=Buffer.from(data.raw,'base64'),model=analyzeTrace(raw,data.metadata,elf,{maxEvents:cfg.seconds>1?250000:2e6});delete data.raw;
  writeFileSync(out+'/capture-'+i+'.swopc',packRecording(raw,data.metadata));
  const symbols=symbolIndex(elf),unique=new Map();let fullUnmapped=0;const decoder=new SwoDecoder({aligned:true,emit:e=>{if(e.kind==='pc'){const mapped=symbols.lookup(e.pc);if(!mapped.exact)fullUnmapped++;unique.set(e.pc,mapped);}}});decoder.feed(raw);decoder.finish();
  const row={fullUniqueOracle:oracle({pcSamples:[...unique.values()]}),fullUnmapped,cfg,bytes:raw.length,...data,stats:model.stats,oracle:oracle(model),stage:stageOracle(model)};report.rows.push(row);writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(row));
  assert.equal(data.metadata.restored,true);assert.equal(data.metadata.receiverRestored,true);assert.equal(data.metadata.targetClockRestored,true);assert.deepEqual(data.errors,[]);assert.ok(Object.values(data.metadata.receiverErrors).every(n=>n===0),'UART RX errors');assert.equal(model.stats.malformed,0);assert.equal(model.stats.overflow,0);assert.equal(model.stats.unmapped,0);assert.equal(fullUnmapped,0);if(!cfg.itm)assert.equal(model.stats.itm,0);assert.ok(model.stats.pc>cfg.hz/cfg.period*cfg.seconds*.5);assert.ok(model.hotspots.some(e=>e.fn==='branch_leaf_a'));assert.ok(!model.hotspots.some(e=>e.fn==='never_path'||e.fn==='branch_leaf_b'));if(cfg.itm){assert.ok(row.stage.checked>1000);assert.equal(row.stage.mismatchCount,0);}
 }
 report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}
finally{try{await release();}catch(e){report.cleanupError=e.stack;process.exitCode=1;}writeFileSync(out+'/results.json',JSON.stringify(report,null,2));c.close();}
