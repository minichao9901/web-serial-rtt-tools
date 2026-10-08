/** H743 acceptance. Requires stm32h743_fault fixture already flashed. Does not
 * flash/erase; caller must back up and restore original Flash separately. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Cdp,sleep} from './cdp-lib.mjs';
import {join} from 'node:path';
const out=process.env.DIAG_OUT||'tmp/diagnostics-hw',fixture=process.env.DIAG_FIXTURE||'tools/target-firmware/stm32h743_fault/fw.elf';
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',30000),results=[];
mkdirSync(out,{recursive:true});
const cases=[
 {mode:1,name:'UDF / MSP',flag:16,label:'fault_udf_pc',stack:'MSP'},
 {mode:2,name:'divide by zero',flag:25,label:'fault_div_pc',stack:'MSP'},
 {mode:3,name:'precise bus fault',flag:9,label:'fault_bus_pc',stack:'MSP',address:0x60000000},
 {mode:4,name:'UDF / PSP',flag:16,label:'fault_udf_pc',stack:'PSP'},
 {mode:5,name:'UDF / PSP / FP',flag:16,label:'fault_udf_pc',stack:'PSP',extended:true},
 {mode:6,name:'MPU denied access',flag:1,label:'fault_mpu_pc',stack:'MSP',address:0x2407c000},
 {mode:1,name:'handler prologue unwind',flag:16,label:'fault_udf_pc',stack:'MSP',catch:false},
 {mode:1,name:'repeat catch after reset',flag:16,label:'fault_udf_pc',stack:'MSP'},
];
try{
 await c.connect();await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?diagnostics-hw='+Date.now()+'#dbg'});await c.send('Page.bringToFront');
 for(let i=0;i<100;i++){if(await c.eval('return !!window.__tools?.dbg;').catch(()=>false))break;await sleep(100);}
 const bytes=readFileSync(fixture);
 await c.eval(`const d=__tools.dbg;document.getElementById('d-backend').value='webusb';document.getElementById('d-clock').value='10000';document.getElementById('d-rtt-on').checked=false;await d._syncBackend();d.loadElfBuffer(Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),x=>x.charCodeAt(0)).buffer,'stm32h743_fault.elf');if(!await d.connect())throw Error('H743 connect failed');`);
 if(process.env.DIAG_SOURCE){
  // CDP cannot reliably populate a webkitdirectory input on all Chromium
  // versions. Index the actual fixture source through the same File API.
  const source=readFileSync(join(process.env.DIAG_SOURCE,'main.c'),'utf8');
  const indexed=await c.eval(`await __tools.dbg._indexSrcFiles([new File([${JSON.stringify(source)}],'main.c')]);return __tools.dbg.src.ready;`);
  assert.equal(indexed,true,'actual fixture source indexed');
 }
 for(const tc of cases){
  await c.eval(`const d=__tools.dbg;await d._act('验收复位',async()=>{await d.faultPanel.restoreCatchLocked(false);await d.session.resetRun();d._startWatch();});`);
  await sleep(150);await c.eval(`await __tools.dbg.runLine('halt');`);
  const baseline=await c.eval(`const d=__tools.dbg,p=d.session.probe;return {demcr:new DataView((await p.readMemDiagnostic(0xe000edfc,4)).buffer).getUint32(0,true),heal:p.faultHeals,recoveries:p.recoveries,heartbeat:new DataView((await p.readMemDiagnostic(d.sym.find('g_heartbeat').addr,4)).buffer).getUint32(0,true),clock:p.clockHz};`);
  assert.ok(baseline.heartbeat>0,'fixture running before injection');
  const injection=await c.eval(`const d=__tools.dbg;return await d.session.exclusive(async()=>{${tc.catch===false?'':'await d.faultPanel.setCatchLocked(true);'}const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,${tc.mode},true);await d.session.memWrite(d.sym.find('g_fault_request').addr,b);const word=async a=>new DataView((await d.session.probe.readMemDiagnostic(a,4)).buffer).getUint32(0,true);return {request:await word(d.sym.find('g_fault_request').addr),demcr:await word(0xe000edfc),dhcsr:await word(0xe000edf0)};});`);
  console.log('Inject',tc.name,injection);assert.equal(injection.request,tc.mode);assert.ok(injection.dhcsr&(1<<17));
  await c.eval(`await __tools.dbg.runLine('c');`);
  if(tc.catch===false){await sleep(150);await c.eval(`await __tools.dbg.runLine('halt');`);}
  for(let i=0;i<100;i++){const ready=await c.eval('return __tools.dbg.session.halted && !__tools.dbg.session.busy && !!__tools.dbg.faultPanel.snapshot && !__tools.dbg.faultPanel.historical;');if(ready)break;await sleep(100);}
  const snapshot=await c.eval(`const d=__tools.dbg;return {report:d.faultPanel.report(),tab:d.dockTab,halted:d.session.halted,pc:d.session.pc,expected:d.sym.find(${JSON.stringify(tc.label)}).addr>>>0,heal:d.session.probe.faultHeals,recoveries:d.session.probe.recoveries,errors:__tools.errors,log:document.getElementById('d-out')?.textContent};`);
  writeFileSync(out+'/pending.json',JSON.stringify({case:tc,injection,snapshot},null,2));
  if(!snapshot.halted){const state=await c.eval(`const p=__tools.dbg.session.probe;const w=async a=>new DataView((await p.readMemDiagnostic(a,4)).buffer).getUint32(0,true);return {request:await w(__tools.dbg.sym.find('g_fault_request').addr),seen:await w(__tools.dbg.sym.find('g_fault_seen').addr),dhcsr:await w(0xe000edf0),demcr:await w(0xe000edfc),cfsr:await w(0xe000ed28),hfsr:await w(0xe000ed2c)};`);console.log('Not halted',state);writeFileSync(out+'/not-halted.json',JSON.stringify(state,null,2));assert.fail('Target did not halt');}
  const check=await c.eval(`const d=__tools.dbg,p=d.session.probe;const read=async()=>({regs:await Promise.all([15,14,16,13,17,18].map(x=>p.regReadDiagnostic(x))),scb:Array.from(await p.readMemDiagnostic(0xe000ed24,28))});const before=await read();await d.session.exclusive(()=>d.faultPanel.captureLocked());return {before,after:await read(),demcr:new DataView((await p.readMemDiagnostic(0xe000edfc,4)).buffer).getUint32(0,true)};`);
  const item={case:tc,baseline,...snapshot,readOnly:JSON.stringify(check.before)===JSON.stringify(check.after),demcr:check.demcr};results.push(item);writeFileSync(out+'/faults.json',JSON.stringify(results,null,2));
  const r=snapshot.report?.snapshot;
  console.log(tc.name,JSON.stringify({error:r?.error,raw:r?.raw,frame:r?.frame&&{pc:r.frame.pc,stack:r.frame.stack,extended:r.frame.extended,validated:r.frame.validated,unwound:r.frame.unwound},frames:r?.frames?.map(x=>x.name),expected:snapshot.expected,readOnly:item.readOnly}));
  assert.ok(snapshot.halted);assert.equal(snapshot.tab,'fault');assert.equal(r.error,null);assert.ok(r.raw.CFSR & (1<<tc.flag),tc.name+' CFSR');assert.ok(r.raw.HFSR&(1<<30),'escalated HardFault');assert.equal(r.frame.validated,true);assert.equal(r.frame.pc,snapshot.expected);assert.equal(r.frame.stack,tc.stack);assert.equal(!!r.frame.extended,!!tc.extended);assert.ok(r.frames.length>=3,'at least original leaf + caller chain');assert.equal(item.readOnly,true);assert.equal(snapshot.heal,baseline.heal);assert.equal(snapshot.recoveries,baseline.recoveries);assert.deepEqual(snapshot.errors,[]);
  if(tc.address!=null)assert.equal(tc.flag===1?r.raw.MMFAR:r.raw.BFAR,tc.address);
  if(tc.catch===false)assert.equal(r.frame.unwound,true);
  if(process.env.DIAG_SOURCE){
   const loc=r.frames[0].loc;assert.ok(loc?.line>0,'saved PC has source location');
   const sourceView=await c.eval(`await __tools.dbg.showSource(${JSON.stringify(loc.file)},${loc.line});return {shown:document.getElementById('d-src').textContent,cur:__tools.dbg.srcCur};`);
   assert.match(sourceView.shown,/fault_udf|fault_div|fault_bus|fault_mpu/);
   assert.equal(sourceView.cur.line,loc.line);item.sourceShown=true;
   writeFileSync(out+'/faults.json',JSON.stringify(results,null,2));
  }
  if(tc.mode===5||tc.mode===6)writeFileSync(out+'/fault-'+tc.mode+'.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await c.eval(`await __tools.dbg.session.exclusive(()=>__tools.dbg.faultPanel.restoreCatchLocked(false));`);
  const restored=await c.eval(`return new DataView((await __tools.dbg.session.probe.readMemDiagnostic(0xe000edfc,4)).buffer).getUint32(0,true);`);assert.equal(restored,baseline.demcr,'DEMCR restored preserving other bits');
 }
 console.log('H743 fault acceptance: '+results.length+' cases passed');
}finally{
 writeFileSync(out+'/faults.json',JSON.stringify(results,null,2));
 try{await c.eval(`const d=__tools.dbg;if(d.session.connected){await d.session.exclusive(()=>d.faultPanel.restoreCatchLocked(false));await d.disconnect();}`);}catch(e){console.error('Cleanup:',e.message);}
 c.close();
}
