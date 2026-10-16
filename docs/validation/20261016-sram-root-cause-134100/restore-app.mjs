import assert from 'node:assert/strict';
import { Cdp, sleep } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// 收尾：把目标从「SRAM 基准跑过之后」的状态拉回原例程。
// 复刻 codex 已验收的 usb-reenumerate.py 序列，但走网页 WebUSB（不占用 OpenOCD）：
//   halt → 开 USB/IOPA 时钟 → USB_CNTR=PDWN|FRES → PA12 开漏拉低 150 ms → SYSRESETREQ
//   → VTOR=0x08000000、SP/PC 取 0x08000000 向量、清 PRIMASK/FAULTMASK → resume。
// 只写 RAM/寄存器，不写 flash。
const c = new Cdp(undefined, 180000);
const out = new URL('./', import.meta.url);
const report = {};
const EVAL = `
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
const {waitMs}=await import('./app/core/pace.js');
const u32=b=>new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);
const u32b=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v>>>0,true);return b;};
const rd=async a=>u32(await p.readMem(a,4));
const wr=async(a,v)=>p.writeMem(a,u32b(v));
try{ await __tools.probeManager.releaseOthers(null,'restore-app'); }catch(e){}
const p=await P.open((await P.authorized())[0],{clockKhz:1000});
const steps=[];
try{
  try{ await p.readMem(0x08000000,4); }catch(e){}
  if(p._faulted){ await p.recoverDebugPort(); }
  await p.halt();
  const vec=await p.readMem(0x08000000,8);
  const sp=u32(vec.slice(0,4)),pc=u32(vec.slice(4,8));
  steps.push({step:'vectors',sp:'0x'+sp.toString(16),pc:'0x'+pc.toString(16)});
  const apb2=await rd(0x40021018); await wr(0x40021018,apb2|4); steps.push({step:'APB2ENR-IOPA',before:'0x'+apb2.toString(16)});
  const apb1=await rd(0x4002101c); await wr(0x4002101c,apb1|0x00800000); steps.push({step:'APB1ENR-USB',before:'0x'+apb1.toString(16)});
  await p.writeMem(0x40005c40,new Uint8Array([3,0])); steps.push({step:'USB_CNTR=PDWN|FRES'});
  const crh=await rd(0x40010804); await wr(0x40010804,(crh&0xfff0ffff)|0x00060000); steps.push({step:'PA12-open-drain-low',before:'0x'+crh.toString(16)});
  await waitMs(150);
  const resetInfo=await p.sysReset(); steps.push({step:'sysreset',info:resetInfo});
  await waitMs(120);
  const dhcsrAfterReset=(await p._readWord(0xe000edf0))>>>0;
  if(!(dhcsrAfterReset&(1<<17))) await p.halt();
  await p.writeMem(0xE000ED08,u32b(0x08000000));
  await p.regWrite(13,sp);
  await p.regWrite(15,pc);
  await p.regWrite(0x14,0);
  await p.run();
  await waitMs(600);
  const dhcsrRun=(await p._readWord(0xe000edf0))>>>0;
  return {steps,sp:'0x'+sp.toString(16),pc:'0x'+pc.toString(16),dhcsrAfterReset,haltedAfterReset:!!(dhcsrAfterReset&(1<<17)),dhcsrRunning:dhcsrRun,haltedAtEnd:!!(dhcsrRun&(1<<17)),faultHeals:p.faultHeals||0};
}finally{ try{ await p.disconnect(); }catch(e){} }
`;
try {
  await c.connect();
  await c.send('Page.navigate', { url: `http://127.0.0.1:8899/index.html?t=${Date.now()}#flash` });
  for (let i = 0; i < 200; i++) {
    if (await c.eval('return !!(window.__tools && window.__tools.probeManager);').catch(() => false)) break;
    await sleep(100);
  }
  report.result = await c.eval(EVAL);
  const r = report.result;
  assert.equal(r.haltedAtEnd, false, '收尾后目标应在运行');
  report.passed = true;
  console.log(JSON.stringify(report));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('restore-app.json', out), JSON.stringify(report, null, 2));
  c.close();
}
