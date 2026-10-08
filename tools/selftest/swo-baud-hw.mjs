/** SWO->VCOM baud sweep. Isolates receiver bit-rate from data throughput.
 * Never flashes the probe. Backs up and restores all 128 KiB of F103CB Flash. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Cdp,sleep} from './cdp-lib.mjs';
import {analyzeTrace} from '../../app/swo/analyze.js';
import {packRecording} from '../../app/swo/recording.js';
import {stageOracle} from './swo-stage-oracle.mjs';
const out=process.env.SWO_OUT||'tmp/swo-baud-'+Date.now(),elfPath='tools/target-firmware/stm32f103cb_swo/fw.elf';
assert.ok(!existsSync(out+'/original-flash.bin'),'Use a new output directory; never overwrite an existing backup');
mkdirSync(out,{recursive:true});
const ocd=process.env.OPENOCD||'E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe',scripts=process.env.OPENOCD_SCRIPTS||'E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts',arm=process.env.ARM_BIN||'E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/';
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9345',40000),app=process.env.APP||'http://127.0.0.1:8911/index.html';
const useView=process.env.SWO_UI==='1';
const sha=b=>createHash('sha256').update(b).digest('hex'),elf=readFileSync(elfPath),report={startedAt:new Date().toISOString(),board:'STM32F103CB',fixture:elfPath,elfSha256:sha(elf),frontend:useView,rows:[]};
let original,demcr,restoreBytes,changed=false;
function save(){writeFileSync(out+'/results.json',JSON.stringify(report,null,2));}
function tcl(p){const q=resolve(p).replaceAll('\\','/');assert.ok(!/[{}\r\n]/.test(q));return '{'+q+'}';}
function command(text,name){const p=spawnSync(ocd,['-s',scripts,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c',text],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:3e6});const log=(p.stdout||'')+(p.stderr||'');writeFileSync(out+'/'+name+'.log',log);assert.equal(p.status,0,name+': '+(p.error?.message||log));return log;}
async function release(){await c.eval(`const t=__tools;if(t.swo.capture.active)await t.swo.capture.stop();if(t.dbg.session.connected)await t.dbg.disconnect();if(t.session.isOpen)await t.session.close();t.swo.pause();`);}
function setCore(mhz,label){
 const pll=((mhz/4-2)<<18)|0x400;
 assert.ok(mhz===8||Number.isInteger(mhz/4)&&mhz>=16&&mhz<=64);
 let script='init; halt; mww 0xe000e010 0; mww 0x40021004 0; sleep 10; mww 0x40021000 0x83; sleep 10; mww 0x40022000 0x12; ';
 if(mhz!==8)script+='mww 0x40021004 '+pll+'; mww 0x40021000 0x01000083; sleep 10; if {([lindex [read_memory 0x40021000 32 1] 0] & 0x02000000) == 0} {error "PLL_NOT_READY"}; mww 0x40021004 '+(pll|2)+'; sleep 10; if {(([lindex [read_memory 0x40021004 32 1] 0] >> 2) & 3) != 2} {error "PLL_NOT_SELECTED"}; ';
 script+='mww 0xe000e014 '+(mhz*1000-1)+'; mww 0xe000e018 0; mww 0xe000e010 7; echo "CLOCK_CFGR [read_memory 0x40021004 32 1]"; resume; sleep 150; shutdown';
 const log=command(script,label);return log.match(/CLOCK_CFGR\s+(0x[0-9a-f]+|\d+)/i)?.[1];
}
function sourceOracle(model){const pcs=[...new Set(model.pcSamples.map(e=>e.pc))];if(!pcs.length)return{checked:0,mismatches:0};const p=spawnSync(arm+'arm-none-eabi-addr2line.exe',['-f','-e',elfPath],{input:pcs.map(a=>a.toString(16)).join('\n')+'\n',encoding:'utf8',windowsHide:true,maxBuffer:5e6});assert.equal(p.status,0);const lines=p.stdout.trim().split(/\r?\n/);const samples=new Map(model.pcSamples.map(e=>[e.pc,e]));let checked=0,mismatches=0;for(let i=0;i<pcs.length;i++){const e=samples.get(pcs[i]),match=/(.*):(\d+)(?:\s|$)/.exec(lines[2*i+1]||'');if(!match||!Number(match[2])||!e.location)continue;checked++;if(lines[2*i]!==e.fn||Number(match[2])!==e.location.line||match[1].replaceAll('\\','/').split('/').pop()!==e.location.file.split('/').pop())mismatches++;}return{uniquePcs:pcs.length,checked,mismatches};}
async function record(cfg,label){
 cfg={core:cfg.core,baud:cfg.baud,period:cfg.period||8192,seconds:cfg.seconds||2,requestedBaud:cfg.requestedBaud||cfg.baud,autoClock:!!cfg.autoClock,round:!!cfg.round};
 const row={label,...cfg,startedAt:new Date().toISOString()};
 try{
  await release();row.clockCfgr=setCore(cfg.core,'clock-'+label);await sleep(250);
  if(useView){
   await c.eval(`__baudErrors=[];const v=__tools.swo;document.getElementById('sw-core').value=${cfg.core};document.getElementById('sw-baud').value=${cfg.requestedBaud};document.getElementById('sw-auto-clock').checked=${cfg.autoClock};document.getElementById('sw-baud-round').checked=${cfg.round};document.getElementById('sw-period').value=${cfg.period};document.getElementById('sw-seconds').value=${cfg.seconds};document.getElementById('sw-itm').checked=true;document.getElementById('sw-exceptions').checked=false;await v.start();`);
  }else{
   // Benchmark all raw events in Node; the interactive view deliberately caps expansion at 250k.
   await c.eval(`__baudErrors=[];const v=__tools.swo;v.capture.onChange=()=>{};v.capture.onError=e=>__baudErrors.push(String(e.message));const ports=await navigator.serial.getPorts(),port=ports.find(p=>p.getInfo().usbVendorId===0x0d28&&p.getInfo().usbProductId===0x0204);await v.capture.start({coreHz:${cfg.core*1e6},baudRate:${cfg.requestedBaud},autoClock:${cfg.autoClock},allowBaudRounding:${cfg.round},periodCycles:${cfg.period},seconds:${cfg.seconds},itm:true,exceptions:false,port,elfSha256:v.elf.sha256,verifyElf:p=>v.verifyElf(p)});`);
  }
  let finished=false;for(let n=0;n<600;n++){if(await c.eval(`return !__tools.swo.capture.active;`)){finished=true;break;}await sleep(100);}assert.ok(finished,'capture timeout');
  if(useView){for(let n=0;n<300;n++){if(await c.eval(`return !__tools.swo.analyzing&&!!__tools.swo.result;`))break;await sleep(100);}row.web=await c.eval(`const v=__tools.swo;return {stats:v.result?.stats,errors:__tools.errors,warning:document.getElementById('sw-warning').textContent};`);assert.ok(row.web.stats,'frontend decode completed');}
  const b=await c.eval(`const v=__tools.swo.capture,raw=v.raw();let text='';for(let p=0;p<raw.length;p+=8192)text+=String.fromCharCode(...raw.subarray(p,p+8192));return{raw:btoa(text),metadata:v.metadata,errors:__baudErrors};`);
  const raw=Buffer.from(b.raw,'base64');delete b.raw;Object.assign(row,b,{bytes:raw.length});
  writeFileSync(out+'/'+label+'.swopc',packRecording(raw,b.metadata));
  const a=analyzeTrace(raw,b.metadata,elf,{maxEvents:2000000});row.stats=a.stats;row.sourceOracle=sourceOracle(a);row.stageOracle=stageOracle(a);
  const markers=a.events.filter(e=>e.kind==='itm'&&e.port===1),valid=markers.filter(e=>(e.value>>>24)===0xa5);let jumps=0;for(let i=1;i<valid.length;i++)if(((valid[i].value>>>8)&65535)!==(((valid[i-1].value>>>8)&65535)+1&65535))jumps++;
  row.markers={total:markers.length,valid:valid.length,sequenceJumps:jumps};
  row.nominalSamples=(cfg.seconds||2)*cfg.core*1e6/(cfg.period||8192);row.sampleRatio=(a.stats.pc+a.stats.sleep)/row.nominalSamples;
  row.sampleHz=(a.stats.pc+a.stats.sleep)/(b.metadata.elapsedMs/1000);row.bytesPerSecond=raw.length/(b.metadata.elapsedMs/1000);row.wireUtilization=row.bytesPerSecond*10/cfg.baud;
  const reasons=[];if(a.stats.overflow)reasons.push('ITM overflow '+a.stats.overflow);if(a.stats.malformed)reasons.push('malformed '+a.stats.malformed);if(a.stats.truncated)reasons.push('truncated '+a.stats.truncated);if(b.errors.length||b.metadata.transportGaps.length)reasons.push('serial/transport errors');if(a.stats.unmapped)reasons.push('unmapped PCs '+a.stats.unmapped);if(a.stats.droppedEvents)reasons.push('analysis limit');if(row.sampleRatio<.98||row.sampleRatio>1.08)reasons.push('sample coverage '+(row.sampleRatio*100).toFixed(1)+'%');if(valid.length<20||valid.length!==markers.length||jumps)reasons.push('stage marker loss/corruption');if(row.stageOracle.mismatchCount)reasons.push('wrong stage '+row.stageOracle.mismatchCount);if(row.sourceOracle.mismatches||row.sourceOracle.checked<20)reasons.push('GNU source mismatch/insufficient valid PCs');if(b.metadata.restored!==true)reasons.push('register restore failed');
  if(useView&&(row.web.stats.pc!==a.stats.pc||row.web.stats.droppedEvents||row.web.errors.length))reasons.push('frontend decode mismatch/limit/error');
  if(process.env.PROBE_DIAG){
   const diag=spawnSync(process.env.PROBE_PYTHON||'python',[process.env.PROBE_DIAG,...(process.env.PROBE_SERIAL?['--serial',process.env.PROBE_SERIAL]:[])],{encoding:'utf8',windowsHide:true,timeout:10000});
   assert.equal(diag.status,0,diag.stderr||diag.stdout);row.receiver=JSON.parse(diag.stdout.trim());
   if(row.receiver.requestedBaud!==cfg.requestedBaud)reasons.push('receiver baud request mismatch');
   if(row.receiver.initStatus!==0||row.receiver.appliedBaud===0)reasons.push('receiver initialization failed');
   if(process.env.PROBE_CLOCK_HZ&&row.receiver.clockHz!==Number(process.env.PROBE_CLOCK_HZ))reasons.push('receiver clock mismatch');
  }
  row.passed=!reasons.length;row.reasons=reasons;
  }catch(e){
  row.passed=false;row.error=e.stack;row.setupRejected=!row.metadata;await release();
  if(row.setupRejected){
   // Preserve rejected attempts; an independent read distinguishes setup issues from corrupt UART data.
   try{const dump=out+'/reject-'+label+'.bin',expected=readFileSync(out+'/fixture.bin'),log=command('init; echo "AFTER_FAIL_CFGR [read_memory 0x40021004 32 1]"; dump_image '+tcl(dump)+' 0x08000000 '+expected.length+'; shutdown','reject-'+label);row.setupDiagnostic={cfgr:Number(/AFTER_FAIL_CFGR\s+(0x[0-9a-f]+|\d+)/i.exec(log)[1]),fixtureBytesMatch:expected.equals(readFileSync(dump))};}
   catch(check){row.setupDiagnostic={error:check.message};}
  }
 }
 report.rows.push(row);save();console.log(JSON.stringify({label,core:cfg.core,baud:cfg.baud,period:cfg.period||8192,pass:row.passed,bytes:row.bytes,pc:row.stats?.pc,sleep:row.stats?.sleep,overflow:row.stats?.overflow,malformed:row.stats?.malformed,ratio:row.sampleRatio,markers:row.markers,reasons:row.reasons,error:row.error}));return row;
}
try{
 await c.connect();await c.send('Page.bringToFront');await c.send('Page.navigate',{url:app+'?baud-sweep='+Date.now()+'#swo'});await sleep(500);await release();
 report.devices=await c.eval(`return {usb:(await navigator.usb.getDevices()).map(d=>({vid:d.vendorId,pid:d.productId,product:d.productName,serial:d.serialNumber})),ports:(await navigator.serial.getPorts()).map(p=>p.getInfo())};`);
 const bin=spawnSync(arm+'arm-none-eabi-objcopy.exe',['-O','binary',elfPath,out+'/fixture.bin'],{windowsHide:true});assert.equal(bin.status,0);restoreBytes=Math.ceil(readFileSync(out+'/fixture.bin').length/1024)*1024;
 const log=command('init; halt; flash probe 0; echo "ORIGINAL_DEMCR [read_memory 0xe000edfc 32 1]"; dump_image '+tcl(out+'/original-flash.bin')+' 0x08000000 131072; dump_image '+tcl(out+'/original-confirm.bin')+' 0x08000000 131072; resume; shutdown','backup');assert.match(log,/device id = 0x[0-9a-f]*410\b/i);assert.match(log,/flash size = 128 KiB/i);demcr=Number(/ORIGINAL_DEMCR\s+(0x[0-9a-f]+|\d+)/i.exec(log)[1]);original=readFileSync(out+'/original-flash.bin');assert.equal(original.length,131072);assert.deepEqual(original,readFileSync(out+'/original-confirm.bin'));writeFileSync(out+'/restore-pages.bin',original.subarray(0,restoreBytes));report.originalSha256=sha(original);report.originalDemcr=demcr;save();
 changed=true;command('init; program '+tcl(elfPath)+' verify reset exit','flash');await sleep(250);
 await c.eval(`await __tools.swo.loadElf(Uint8Array.from(atob(${JSON.stringify(elf.toString('base64'))}),c=>c.charCodeAt(0)).buffer,'baud-sweep.elf');`);
 const steps=process.env.SWO_STEPS?JSON.parse(process.env.SWO_STEPS):[{core:60,baud:1000000},{core:60,baud:2000000},{core:60,baud:3000000},{core:60,baud:4000000},{core:60,baud:5000000},{core:60,baud:6000000},{core:60,baud:7500000},{core:64,baud:8000000},{core:36,baud:9000000},{core:60,baud:10000000},{core:60,baud:12000000},{core:60,baud:15000000},{core:36,baud:18000000},{core:40,baud:20000000},{core:44,baud:22000000},{core:48,baud:24000000},{core:48,baud:24000000,requestedBaud:25000000,round:true}];
 for(let i=0;i<steps.length;i++)await record(steps[i],'step-'+String(i).padStart(2,'0'));
 if(!process.env.SWO_STEPS){
  const passed=report.rows.filter(r=>r.passed).sort((a,b)=>b.baud-a.baud),highest=passed[0];assert.ok(highest,'No usable baud rate');report.highestPreliminaryBaud=highest.baud;
  for(let i=0;i<3;i++)await record({...highest,seconds:5,period:8192},'repeat-'+i);
  // Increase actual byte traffic at the highest passing baud without exceeding line capacity by design.
  const wanted=(highest.core*1e6*9)/(highest.baud/10*.70),unit=wanted<=1024?64:1024,densePeriod=Math.max(unit,Math.ceil(wanted/unit)*unit);
  for(let i=0;i<3;i++)await record({...highest,seconds:3,period:densePeriod},'dense-'+i);
  await record({core:60,baud:1000000,period:8192,seconds:2},'recovery-1m');
 }
 report.completed=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}
finally{
 try{await release();}catch(e){report.releaseError=e.stack;process.exitCode=1;}
 if(original&&changed)try{const log=command('init; reset halt; flash write_image erase '+tcl(out+'/restore-pages.bin')+' 0x08000000; verify_image '+tcl(out+'/restore-pages.bin')+' 0x08000000; dump_image '+tcl(out+'/restored-flash.bin')+' 0x08000000 131072; mww 0xe000edfc '+demcr+'; reset run; mww 0xe000edfc '+demcr+'; echo "RESTORED_DEMCR [read_memory 0xe000edfc 32 1]"; shutdown','restore');assert.deepEqual(readFileSync(out+'/restored-flash.bin'),original);assert.equal(Number(/RESTORED_DEMCR\s+(0x[0-9a-f]+|\d+)/i.exec(log)[1]),demcr);report.restore={passed:true,sha256:sha(original),bytes:original.length};console.log('Original Flash restored and fully verified');}catch(e){report.restore={passed:false,error:e.stack};process.exitCode=1;console.error('RESTORE FAILED',e.stack);}
 save();c.close();
}
