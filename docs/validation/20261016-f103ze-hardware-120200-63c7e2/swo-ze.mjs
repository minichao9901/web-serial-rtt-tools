/** F103ZE acceptance against the already-installed HSE fixture; no flash/reset. Each run resumes from pipeline_scan's one-shot FPB breakpoint. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';
import {analyzeTrace} from '../../../app/swo/analyze.js';
import {packRecording} from '../../../app/swo/recording.js';
import {stageOracle} from '../../../tools/selftest/swo-stage-oracle.mjs';
const base='tools/target-firmware/stm32f103cb_swo_hse/',fixture='docs/validation/20261016-f103ze-acceptance-112445-5b3aac/swo-ze/fw.elf',elf=readFileSync(fixture),out='docs/validation/20261016-f103ze-hardware-120200-63c7e2/swo-01';mkdirSync(out,{recursive:true});
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',40000),report={fixture,rows:[],targetClockWrites:false,flashWrites:false,resets:false};
const ocd='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe',arm='E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/';
const registers=[0x40021000,0x40021004,0xe000edfc,0xe0001000,0xe0000e80,0xe0000e00,0xe0000e40,0xe0040010,0xe00400f0,0xe0040304,0xe0042004,0xe0002000,...Array.from({length:6},(_,i)=>0xe0002008+i*4)];
function snapshot(label){const commands='echo [mdw 0x40021000 2]; echo [mdw 0x40021000 2]; '+registers.map(a=>'read_memory 0x'+a.toString(16)+' 32 1; read_memory 0x'+a.toString(16)+' 32 1; echo "REG '+a.toString(16)+' [read_memory 0x'+a.toString(16)+' 32 1]"').join('; '),r=spawnSync(ocd,['-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c','init; '+commands+'; shutdown'],{encoding:'utf8',windowsHide:true,timeout:30000});const text=r.stdout+r.stderr;writeFileSync(out+'/'+label+'.log',text);assert.equal(r.status,0,text);return Object.fromEntries([...text.matchAll(/REG ([0-9a-f]+) (0x[0-9a-f]+|\d+)/g)].map(m=>[m[1],Number(m[2])]));}
async function release(){await c.eval(`const t=window.__tools;if(!t)return false;if(t.swo.capture.active)await t.swo.capture.stop();if(t.dbg.session.connected)await t.dbg.disconnect();if(t.session.isOpen)await t.session.close();t.swo.pause();return true;`);}
try{
  await c.connect();await release();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?swo-ports-hw='+Date.now()+'#swo'});await sleep(600);
  report.before=snapshot('before');assert.equal((report.before['40021004']>>>2)&3,2);
  const sources=Object.fromEntries(['main.c','pipeline.c','startup.c','pipeline.h'].map(n=>[n,readFileSync(base+'src/'+n,'utf8')]));
  await c.eval(`const v=__tools.swo;await v.loadElf(Uint8Array.from(atob(${JSON.stringify(elf.toString('base64'))}),c=>c.charCodeAt(0)).buffer,'F103 HSE 24 MHz.elf');v.sources.indexFileList(Object.entries(${JSON.stringify(sources)}).map(([n,t])=>new File([t],n)));v.setEntryBreakpoint('b pipeline_scan');document.getElementById('sw-hse').value='8';`);
  if(!await c.eval(`return (await navigator.usb.getDevices()).length>0;`)){const detection=c.eval('await __tools.swo.detectTarget()',true);await c.pickDevice(/AkaLink|MicroLink|CMSIS|DAP/i,20000);await detection;}
  else await c.eval('await __tools.swo.detectTarget()');
  if(!await c.eval(`return (await navigator.hid.getDevices()).some(d=>d.vendorId===0x0d28&&d.productId===0x0204);`)){await c.eval(`document.getElementById('sw-clock-grant').click();return true;`,true);await c.pickDevice(/AkaLink|MicroLink|CMSIS|DAP/i,20000);}
  if(!await c.eval(`return (await navigator.serial.getPorts()).some(p=>{const i=p.getInfo();return i.usbVendorId===0x0d28&&i.usbProductId===0x0204;});`)){await c.eval(`document.getElementById('sw-pick').click();return true;`,true);await c.pickDevice(/AkaLink|MicroLink|VCOM|Serial/i,20000);await c.eval('await __tools.swo.refreshPorts()');}
  assert.equal(await c.eval('return __tools.swo.target.knownHz;'),24e6);
  for(const cfg of [{period:4096,timestamps:true,itm:true,auto:false,baud:1000000},{period:8192,timestamps:false,itm:false,auto:false,baud:1000000}]){
    await c.eval(`const $=id=>document.getElementById(id);$('sw-period').value=${cfg.period};$('sw-timestamps').checked=${cfg.timestamps};$('sw-itm').checked=${cfg.itm};$('sw-exceptions').checked=${!!cfg.exceptions};$('sw-auto-baud').checked=${cfg.auto};$('sw-baud').value=${cfg.baud};$('sw-baud-round').checked=false;$('sw-seconds').value=1;await __tools.swo.start();`);
    for(let n=0;n<120;n++){if(await c.eval('return !__tools.swo.capture.active&&!__tools.swo.analyzing&&!!__tools.swo.result;'))break;await sleep(100);}
    const data=await c.eval(`const v=__tools.swo;if(v.capture.active||!v.recording)throw Error(document.getElementById('sw-warning').textContent);let s='';for(let n=0;n<v.recording.raw.length;n+=8192)s+=String.fromCharCode(...v.recording.raw.subarray(n,n+8192));return {raw:btoa(s),metadata:v.recording.metadata,errors:__tools.errors};`),raw=Buffer.from(data.raw,'base64');delete data.raw;
    const model=analyzeTrace(raw,data.metadata,elf,{maxEvents:2e6}),pcs=[...new Set(model.pcSamples.map(e=>e.pc))],gnu=spawnSync(arm+'arm-none-eabi-addr2line.exe',['-f','-e',fixture],{input:pcs.map(n=>n.toString(16)).join('\n')+'\n',encoding:'utf8',windowsHide:true});assert.equal(gnu.status,0);
    const lines=gnu.stdout.trim().split(/\r?\n/);for(let i=0;i<pcs.length;i++){const event=model.pcSamples.find(e=>e.pc===pcs[i]),m=/(.*):(\d+)/.exec(lines[i*2+1]);assert.equal(event.fn,lines[i*2]);assert.equal(event.location.line,Number(m[2]));assert.equal(event.location.file.split('/').pop(),m[1].replaceAll('\\','/').split('/').pop());}
    const row={cfg,bytes:raw.length,metadata:data.metadata,stats:model.stats,uniqueGNUChecks:pcs.length,stage:cfg.itm?stageOracle(model):null};report.rows.push(row);writeFileSync(out+'/capture-'+report.rows.length+'.swopc',packRecording(raw,data.metadata));writeFileSync(out+'/capture-'+report.rows.length+'.bin',raw);writeFileSync(out+'/capture-'+report.rows.length+'.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert.equal(data.metadata.restored,true);assert.equal(data.metadata.receiverRestored,true);assert.equal(data.metadata.plan.coreHz,24e6);assert.equal(data.metadata.plan.traceHz,24e6);assert.equal(data.metadata.plan.baudRate,1000000);assert.equal(data.metadata.entryBreakpoint?.label,'pipeline_scan');assert.equal(data.metadata.entryBreakpoint?.hitPc,await c.eval('return __tools.swo.entryBreakpoint.address;'));assert.equal(data.metadata.entryBreakpoint?.targetWasRunningAtStart,true);
    assert.deepEqual(data.errors,[]);assert.ok(Object.values(data.metadata.receiverErrors).every(n=>n===0));assert.equal(model.stats.malformed,0);assert.equal(model.stats.overflow,0);assert.equal(model.stats.unmapped,0);assert.ok(model.stats.pc>1000);assert.ok(pcs.length>20);
    if(row.stage){assert.ok(row.stage.checked>1000);assert.equal(row.stage.mismatchCount,0);}
    console.log(JSON.stringify({cfg,bytes:row.bytes,pc:model.stats.pc,uniqueGNUChecks:pcs.length,receiverErrors:data.metadata.receiverErrors}));
  }
  await release();report.after=snapshot('after');
  // DWT POSTCNT and ITM BUSY are runtime state; CR calibration can change. Compare owned configuration.
  for(const [a,v]of Object.entries(report.before)){const mask=a==='e0001000'?~0x1e:a==='e0000e80'?~0x800000:a==='e0040304'?~0x40:a==='40021000'?0x030f0003:-1;assert.equal(report.after[a]&mask,v&mask,'restored / unchanged '+a);}
  report.passed=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}
finally{try{await release();}catch(e){report.cleanupError=e.stack;process.exitCode=1;}writeFileSync(out+'/results.json',JSON.stringify(report,null,2));c.close();}
