/** F103CB acceptance against the already-installed HSE fixture; never flashes/reset/halts. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Cdp,sleep} from './cdp-lib.mjs';
import {analyzeTrace} from '../../app/swo/analyze.js';
import {packRecording} from '../../app/swo/recording.js';
import {stageOracle} from './swo-stage-oracle.mjs';
const base='tools/target-firmware/stm32f103cb_swo_hse/',elf=readFileSync(base+'fw.elf'),out='tmp/swo-sidebar-hw';mkdirSync(out,{recursive:true});
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9345',40000),report={fixture:base+'fw.elf',rows:[],targetClockWrites:false};
const ocd='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe',arm='E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/';
const registers=[0x40021000,0x40021004,0xe000edfc,0xe0001000,0xe0000e80,0xe0000e00,0xe0000e40,0xe0040010,0xe00400f0,0xe0040304,0xe0042004];
function snapshot(label){const commands='echo [mdw 0x40021000 2]; echo [mdw 0x40021000 2]; '+registers.map(a=>'read_memory 0x'+a.toString(16)+' 32 1; read_memory 0x'+a.toString(16)+' 32 1; echo "REG '+a.toString(16)+' [read_memory 0x'+a.toString(16)+' 32 1]"').join('; '),r=spawnSync(ocd,['-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c','init; '+commands+'; shutdown'],{encoding:'utf8',windowsHide:true,timeout:30000});const text=r.stdout+r.stderr;writeFileSync(out+'/'+label+'.log',text);assert.equal(r.status,0,text);return Object.fromEntries([...text.matchAll(/REG ([0-9a-f]+) (0x[0-9a-f]+|\d+)/g)].map(m=>[m[1],Number(m[2])]));}
async function release(){await c.eval(`const t=__tools;if(t.swo.capture.active)await t.swo.capture.stop();if(t.dbg.session.connected)await t.dbg.disconnect();if(t.session.isOpen)await t.session.close();t.swo.pause();`);}
try{
  await c.connect();await release();await c.send('Page.navigate',{url:'http://127.0.0.1:8911/index.html?swo-ports-hw='+Date.now()+'#swo'});await sleep(600);
  report.before=snapshot('before');assert.equal((report.before['40021004']>>>2)&3,2);
  const sources=Object.fromEntries(['main.c','pipeline.c','startup.c','pipeline.h'].map(n=>[n,readFileSync(base+'src/'+n,'utf8')]));
  await c.eval(`const v=__tools.swo;await v.loadElf(Uint8Array.from(atob(${JSON.stringify(elf.toString('base64'))}),c=>c.charCodeAt(0)).buffer,'F103 HSE fixed-clock.elf');v.sources.indexFileList(Object.entries(${JSON.stringify(sources)}).map(([n,t])=>new File([t],n)));await v.detectTarget();`);
  assert.equal(await c.eval('return __tools.swo.target.knownHz;'),72e6);
  for(const cfg of [{period:512,timestamps:true,itm:true,auto:true,baud:18e6},{period:256,timestamps:false,itm:false,auto:true,baud:18e6},{period:512,timestamps:true,itm:true,auto:false,baud:25e6},{period:512,timestamps:true,itm:true,exceptions:true,auto:false,baud:25e6}]){
    await c.eval(`const $=id=>document.getElementById(id);$('sw-period').value=${cfg.period};$('sw-timestamps').checked=${cfg.timestamps};$('sw-itm').checked=${cfg.itm};$('sw-exceptions').checked=${!!cfg.exceptions};$('sw-auto-baud').checked=${cfg.auto};$('sw-baud').value=${cfg.baud};$('sw-baud-round').checked=true;$('sw-seconds').value=1;await __tools.swo.start();`);
    for(let n=0;n<120;n++){if(await c.eval('return !__tools.swo.capture.active&&!__tools.swo.analyzing&&!!__tools.swo.result;'))break;await sleep(100);}
    const data=await c.eval(`const v=__tools.swo;if(v.capture.active||!v.recording)throw Error(document.getElementById('sw-warning').textContent);let s='';for(let n=0;n<v.recording.raw.length;n+=8192)s+=String.fromCharCode(...v.recording.raw.subarray(n,n+8192));return {raw:btoa(s),metadata:v.recording.metadata,errors:__tools.errors};`),raw=Buffer.from(data.raw,'base64');delete data.raw;
    const model=analyzeTrace(raw,data.metadata,elf,{maxEvents:2e6}),pcs=[...new Set(model.pcSamples.map(e=>e.pc))],gnu=spawnSync(arm+'arm-none-eabi-addr2line.exe',['-f','-e',base+'fw.elf'],{input:pcs.map(n=>n.toString(16)).join('\n')+'\n',encoding:'utf8',windowsHide:true});assert.equal(gnu.status,0);
    const lines=gnu.stdout.trim().split(/\r?\n/);for(let i=0;i<pcs.length;i++){const event=model.pcSamples.find(e=>e.pc===pcs[i]),m=/(.*):(\d+)/.exec(lines[i*2+1]);assert.equal(event.fn,lines[i*2]);assert.equal(event.location.line,Number(m[2]));assert.equal(event.location.file.split('/').pop(),m[1].replaceAll('\\','/').split('/').pop());}
    const row={cfg,bytes:raw.length,metadata:data.metadata,stats:model.stats,uniqueGNUChecks:pcs.length,stage:cfg.itm?stageOracle(model):null};report.rows.push(row);writeFileSync(out+'/capture-'+report.rows.length+'.swopc',packRecording(raw,data.metadata));
    assert.equal(data.metadata.restored,true);assert.equal(data.metadata.receiverRestored,true);assert.equal(data.metadata.plan.coreHz,72e6);assert.equal(data.metadata.plan.traceHz,72e6);assert.equal(data.metadata.plan.baudRate,cfg.auto?18e6:24e6);
    assert.deepEqual(data.errors,[]);assert.ok(Object.values(data.metadata.receiverErrors).every(n=>n===0));assert.equal(model.stats.malformed,0);if(!cfg.exceptions)assert.equal(model.stats.overflow,0);else{assert.ok(model.stats.exceptions>1000);assert.equal(model.events.filter(e=>e.kind==='gap'&&e.reason.includes('溢出')).length,model.stats.overflow,'producer burst overflow is explicitly exposed');}assert.equal(model.stats.unmapped,0);assert.ok(model.stats.pc>70000);assert.ok(pcs.length>20);
    if(row.stage){assert.ok(row.stage.checked>1000);assert.equal(row.stage.mismatchCount,0);}
    console.log(JSON.stringify({cfg,bytes:row.bytes,pc:model.stats.pc,uniqueGNUChecks:pcs.length,receiverErrors:data.metadata.receiverErrors}));
  }
  await release();report.after=snapshot('after');
  // DWT POSTCNT and ITM BUSY are runtime state; CR calibration can change. Compare owned configuration.
  for(const [a,v]of Object.entries(report.before)){const mask=a==='e0001000'?~0x1e:a==='e0000e80'?~0x800000:a==='e0040304'?~0x40:a==='40021000'?0x030f0003:-1;assert.equal(report.after[a]&mask,v&mask,'restored / unchanged '+a);}
  report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}
finally{try{await release();}catch(e){report.cleanupError=e.stack;process.exitCode=1;}writeFileSync(out+'/results.json',JSON.stringify(report,null,2));c.close();}
