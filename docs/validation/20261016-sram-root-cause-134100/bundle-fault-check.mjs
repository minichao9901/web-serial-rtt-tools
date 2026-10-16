import assert from 'node:assert/strict';
import { Cdp, sleep } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// job-15 的 faultRecovery 步骤当年读的是 0x60000000（F103ZE 的 FSMC 窗口，实测不 FAULT），
// 所以被 "fault not triggered" 卡住。这里改用真故障地址 0x20020000，并在**发布包入口**上复核
// 「旧报文不清 sticky／新报文清零」与「FAULT 后 flash 仍可读」。
const c = new Cdp(undefined, 180000);
const out = new URL('./', import.meta.url);
const report = {};
const EVAL = `
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
try{ await __tools.probeManager.releaseOthers(null,'bundle-fault-check'); }catch(e){}
const p=await P.open((await P.authorized())[0],{clockKhz:1000});
try{
  try{ await p.readMem(0x08000000,4); }catch(e){}
  if(p._faulted){ await p.recoverDebugPort(); }
  await p.halt();
  const flashBefore=Array.from(await p.readMem(0x08000000,16));
  const realAbort=p.abort; p.abort=async()=>false;
  let faultError=null;
  try{
    await p._transfer([{ap:true,rnw:false,addr:4,data:0x20020000}]);
    await p._transfer([{ap:true,rnw:true,addr:12}]);
  }catch(e){ faultError=e.message; }
  finally{ p.abort=realAbort; }
  if(!faultError) throw Error('未触发总线 FAULT（0x20020000）');
  const stat=async()=>(await p._transfer([{ap:false,rnw:true,addr:4}]))[0]>>>0;
  const stickyBefore=await stat();
  const oldResponse=Array.from(await p._ctrl(8,Uint8Array.of(30,0,0,0)));
  const stickyAfterOld=await stat();
  const newResponse=await p.abort();
  const stickyAfterNew=await stat();
  const flashAfter=Array.from(await p.readMem(0x08000000,16));
  return {faultError,oldResponse,stickyBefore,stickyAfterOld,newResponse,stickyAfterNew,
    flashBefore,flashAfter,faultHeals:p.faultHeals||0};
}finally{ try{ await p.disconnect(); }catch(e){} }
`;
try {
  await c.connect();
  await c.send('Page.navigate', { url: `http://127.0.0.1:8899/index.html?modules=bundle&t=${Date.now()}#flash` });
  for (let i = 0; i < 200; i++) {
    if (await c.eval('return !!(window.__tools && window.__tools.probeManager);').catch(() => false)) break;
    await sleep(100);
  }
  report.entry = await c.eval('return document.documentElement.dataset.bootEntry;');
  assert.equal(report.entry, 'bundle');
  report.result = await c.eval(EVAL);
  const r = report.result;
  assert.match(String(r.faultError), /FAULT/);
  assert.ok(r.stickyBefore & 32);
  assert.ok(r.stickyAfterOld & 32, '发布包里旧报文同样不应清掉 sticky');
  assert.equal(r.newResponse, true);
  assert.equal(r.stickyAfterNew & 32, 0);
  assert.deepEqual(r.flashBefore, r.flashAfter, 'FAULT 后 flash 仍应可读且内容不变');
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('bundle-fault-check.json', out), JSON.stringify(report, null, 2));
  c.close();
}
