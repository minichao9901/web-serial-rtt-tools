import assert from 'node:assert/strict';import {writeFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';
const out=new URL('./repeat-20mhz/',import.meta.url),c=new Cdp(undefined,120000),report={started:new Date().toISOString(),method:'actual FlashView.benchmarkSram and browser WebUSB; CPU pre-halted, entire 64 KiB RAM preserved externally',cases:[],errors:[],flashWrites:false};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const setup=`const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');const p=await P.open((await P.authorized())[0],{clockKhz:1000});`;
async function snapshot(){return c.eval(setup+`try{const halted=!!((await p._readWord(0xe000edf0))&(1<<17));const regs=[];if(halted)for(let i=0;i<17;i++)regs.push(await p.regRead(i));return {halted,regs};}finally{await p.disconnect();}`);}
try{
 await c.connect();c.onEvent=m=>{if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails?.text||'uncaught exception');};
 await c.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?sram-hw='+Date.now()+'#flash'});
 for(let i=0;i<100;i++){if(await c.eval('return !!window.__tools?.flash;').catch(()=>false))break;await sleep(100);}
 await c.eval(`await __tools.probeManager.releaseOthers(null,'SRAM 实板测速');document.getElementById('f-chip').value='stm32f103';document.getElementById('f-chip').dispatchEvent(new Event('change'));document.getElementById('f-backend').value='webusb';document.getElementById('f-backend').dispatchEvent(new Event('change'));document.getElementById('f-ram-address').value='0x20000000';document.getElementById('f-ram-length').value='20480';document.getElementById('f-side-sram-tab').click();return true;`);
 const original=await c.eval(setup+`try{const identity={cpuid:await p._readWord(0xe000ed00),device:await p._readWord(0xe0042000),flashKiB:(await p._readWord(0x1ffff7e0))&65535};if((identity.device&4095)!==0x414||identity.flashKiB!==512)throw Error('Expected actual F103ZE');const wasHalted=!!((await p._readWord(0xe000edf0))&(1<<17));await p.halt();const regs=[];for(let i=0;i<17;i++)regs.push(await p.regRead(i));const ram=await p.readMemDiagnostic(0x20000000,65536),confirm=await p.readMemDiagnostic(0x20000000,65536);if(ram.some((v,i)=>v!==confirm[i]))throw Error('RAM backup not stable');const flash=await p.readMemDiagnostic(0x08000000,524288);const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};return {identity,wasHalted,regs,ram:b64(ram),flash:b64(flash)};}finally{await p.disconnect();}`);
 const ram=Buffer.from(original.ram,'base64'),flash=Buffer.from(original.flash,'base64');writeFileSync(new URL('original-ram.bin',out),ram);writeFileSync(new URL('original-flash.bin',out),flash);delete original.ram;delete original.flash;
 report.original={...original,ramBytes:ram.length,ramSha256:sha(ram),flashSha256:sha(flash)};writeFileSync(new URL('original-state.json',out),JSON.stringify(report.original,null,2));
 for(const khz of [20000,20000,20000,0,0,0]){
  const before=await snapshot();assert.equal(before.halted,true);assert.deepEqual(before.regs,original.regs);
  let result=null,error=null;try{result=await c.eval(`document.getElementById('f-ram-clock').value='${khz}';document.getElementById('f-ram-length').value='20480';return await __tools.flash.benchmarkSram();`);}catch(e){error=e.message;}
  const after=await snapshot();assert.equal(after.halted,true);assert.deepEqual(after.regs,original.regs,'RAM benchmark must not execute target code or change architectural registers');
  const row={requestedKhz:khz,result,error,registersPreserved:true,cpuKeptHalted:true,ui:await c.eval(`return document.getElementById('f-ram-result').textContent;`)};report.cases.push(row);writeFileSync(new URL('results-progress.json',out),JSON.stringify(report,null,2));
  if(result){assert.equal(result.verified,true);assert.equal(result.size,20480);assert.equal(result.passes,3);assert.ok(result.readRate>0&&result.writeRate>0);if(khz)assert.equal(result.clockKhz,khz);}
  writeFileSync(new URL('case-'+report.cases.length+'-clock-'+khz+'.png',out),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  console.log(JSON.stringify({requestedKhz:khz,actualKhz:result?.clockKhz,readMBps:result?.readRate,writeMBps:result?.writeRate,transport:result?.transport,verified:result?.verified,error}));
 }
 report.rangeLimits=[];
 for(const size of [32768,65536,131072]){const state=await c.eval(`document.getElementById('f-ram-length').value='${size}';try{await __tools.flash.benchmarkSram();return {rejected:false};}catch(e){return {rejected:true,error:e.message};}`);assert.equal(state.rejected,true);report.rangeLimits.push({size,...state});}
 assert.ok(report.cases.some(c=>c.requestedKhz===0&&c.result?.verified),'automatic clock case must produce verified result');
 assert.deepEqual(report.errors,[]);report.completed=true;
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.stack);}
finally{
 try{
  let state;try{state=JSON.parse(readFileSync(new URL('original-state.json',out),'utf8'));}catch{}
  if(state){const data=readFileSync(new URL('original-ram.bin',out));const restored=await c.eval(setup+`try{await p.halt();const original=Uint8Array.from(atob(${JSON.stringify(data.toString('base64'))}),x=>x.charCodeAt(0));await p.writeMem(0x20000000,original);const actual=await p.readMemDiagnostic(0x20000000,65536);if(actual.some((v,i)=>v!==original[i]))throw Error('RAM restore mismatch');const regs=[];for(let i=0;i<17;i++)regs.push(await p.regRead(i));if(JSON.stringify(regs)!==${JSON.stringify(JSON.stringify(state.regs))})throw Error('Architectural registers changed');const flash=await p.readMemDiagnostic(0x08000000,524288);let s='';for(let i=0;i<flash.length;i+=8192)s+=String.fromCharCode(...flash.subarray(i,i+8192));${state.wasHalted?'':'await p.run();'}return {ramRestored:true,registersPreserved:true,flash:btoa(s),halted:!!((await p._readWord(0xe000edf0))&(1<<17))};}finally{await p.disconnect();}`);const flash=Buffer.from(restored.flash,'base64');delete restored.flash;restored.flashSha256=sha(flash);assert.equal(restored.flashSha256,state.flashSha256);assert.equal(restored.halted,state.wasHalted);report.restore=restored;writeFileSync(new URL('restore.json',out),JSON.stringify({...restored,passed:true,ramSha256:state.ramSha256},null,2));}
 }catch(error){report.restoreError=error.stack;process.exitCode=1;console.error('Restore requires native fallback:',error.stack);}
 report.finished=new Date().toISOString();writeFileSync(new URL('sram-web.json',out),JSON.stringify(report,null,2));c.close();
}

