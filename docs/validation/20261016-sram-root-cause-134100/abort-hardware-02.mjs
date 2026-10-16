import assert from 'node:assert/strict';
import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// abort-hardware 复跑版（2026-10-16 DSH）：
// 1) 先释放别的页签并显式自愈上一次会话遗留的 FAULT 状态（原版在这里被 readMemDiagnostic 拦住）；
// 2) 触发真实总线 FAULT（0x20020000 = F103ZE 的 BOARD.faultAddr），旧报文不清 sticky、新报文清零；
// 3) 期间 flash 与 17 个体系寄存器必须逐字节一致，核保持 halt。
const c = new Cdp(undefined, 180000);
const out = new URL('./', import.meta.url);
const report = {};
const EVAL = `
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
try{ await __tools.probeManager.releaseOthers(null,'abort-hardware-02'); }catch(e){}
const p=await P.open((await P.authorized())[0],{clockKhz:1000});
try{
  const preState={faulted:!!p._faulted,recovering:!!p._recovering,needsReconnect:!!p._targetNeedsReconnect,faultHeals:p.faultHeals||0};
  // 正常读路径自带自愈：先把它跑一遍，把上一次会话遗留的 FAULT 清干净
  let preHeal='none';
  try{ await p.readMem(0x08000000,4); preHeal='readMem-ok'; }catch(e){ preHeal='readMem:'+e.message; }
  if(p._faulted){ try{ await p.recoverDebugPort(); preHeal+='+recoverDebugPort'; }catch(e){ preHeal+='+recover-failed:'+e.message; } }
  const afterHeal={faulted:!!p._faulted,faultHeals:p.faultHeals||0};
  await p.halt();
  const regsBefore=[]; for(let i=0;i<17;i++) regsBefore.push(await p.regRead(i));
  const flashBefore=Array.from(await p.readMem(0x08000000,16));
  const realAbort=p.abort; p.abort=async()=>false;
  let faultError=null;
  try{
    await p._transfer([{ap:true,rnw:false,addr:4,data:0x20020000}]);
    await p._transfer([{ap:true,rnw:true,addr:12}]);
  }catch(e){ faultError=e.message; }
  finally{ p.abort=realAbort; }
  const stat=async()=>(await p._transfer([{ap:false,rnw:true,addr:4}]))[0]>>>0;
  const stickyBefore=await stat();
  const oldResponse=Array.from(await p._ctrl(8,Uint8Array.of(30,0,0,0)));
  const stickyAfterOld=await stat();
  const newResponse=await p.abort();
  const stickyAfterNew=await stat();
  const flashAfter=Array.from(await p.readMem(0x08000000,16));
  const regsAfter=[]; for(let i=0;i<17;i++) regsAfter.push(await p.regRead(i));
  const dhcsr=(await p._readWord(0xe000edf0))>>>0;
  return {preState,preHeal,afterHeal,faultError,oldRequest:[8,30,0,0,0],oldResponse,stickyBefore,
    stickyAfterOld,newRequest:[8,0,30,0,0,0],newResponse,stickyAfterNew,
    flashBefore,flashAfter,regsBefore,regsAfter,dhcsr,halted:!!(dhcsr&(1<<17)),faultHeals:p.faultHeals||0};
}finally{ try{ await p.disconnect(); }catch(e){} }
`;
try {
  await c.connect();
  // 固定到源码入口页（上一次 job-15 把页签留在了发布包入口）
  await c.send('Page.navigate', { url: `http://127.0.0.1:8899/index.html?t=${Date.now()}#flash` });
  for (let i = 0; i < 200; i++) {
    if (await c.eval('return !!(window.__tools && window.__tools.probeManager);').catch(() => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  report.result = await c.eval(EVAL);
  const r = report.result;
  assert.match(String(r.faultError), /FAULT/);
  assert.ok(r.stickyBefore & 32, '触发 FAULT 后 DP sticky 应置位');
  assert.ok(r.stickyAfterOld & 32, '旧报文（abort 值写进索引字节）不应清掉 sticky');
  assert.equal(r.newResponse, true);
  assert.equal(r.stickyAfterNew & 32, 0);
  assert.deepEqual(r.flashBefore, r.flashAfter, 'flash 不应变化');
  assert.deepEqual(r.regsBefore, r.regsAfter, '体系寄存器不应变化');
  assert.equal(r.halted, true, '测完核应保持 halt');
  assert.ok(r.faultHeals >= 1, '自愈路径至少走了一次');
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('abort-hardware-02.json', out), JSON.stringify(report, null, 2));
  c.close();
}
