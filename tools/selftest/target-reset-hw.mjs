/** Real target-reset acceptance. USB and HID must be authorized in the test profile.
 * Does not flash firmware or write target SRAM.
 * node tools/selftest/target-reset-hw.mjs <persistent-output-directory> */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Cdp } from './cdp-lib.mjs';

const out = resolve(process.argv[2] || 'validation/target-reset-hw');
await mkdir(out, { recursive: true });
await writeFile(resolve(out,'run-started.json'),JSON.stringify({started:new Date().toISOString()}),{flag:'wx'});
const c = new Cdp();
const report = { started: new Date().toISOString(), cases: [], errors: [] };
try {
  await c.connect();
  report.page=await c.eval('return location.href;');
  c.onEvent = m => { if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params); };
  const auth = await c.eval(`return {usb:(await navigator.usb.getDevices()).length,hid:(await navigator.hid.getDevices()).length};`);
  assert.ok(auth.usb && auth.hid, 'authorize both USB and HID first');
  for (const mode of [false, true]){
    const state = await c.eval(`
      const h=window.__tools.hid; await h.reconnect({silent:false});
      const input=document.getElementById('global-nrst-open-drain');
      if(input.disabled)throw new Error('PA27 mode control disabled');
      input.checked=${mode}; await h.applyResetOutputMode();
      return await h.dev.getResetOutputMode();`);
    assert.equal(state.openDrain, mode); assert.equal(state.pa27Configurable, true);
    report.cases.push({ name: 'web mode switch', mode: mode ? 'open-drain' : 'push-pull', state });
    // Configure vector catch, then let the existing firmware run before pressing reset.
    await c.eval(`
      await window.__tools.hid.dev.close();
      const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
      const p=await P.open((await P.authorized())[0],{clockKhz:1000});
      const write=async(a,v)=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v>>>0,true);await p.writeMem(a,b);};
      try {
        await p.halt(); const demcr=await p._readWord(0xe000edfc);
        const resetVector=await p._readWord(0x08000004);
        window.__resetEvidence={demcr,resetVector};
        await write(0xe000edfc,demcr|1);
        await write(0x580244d0,1<<16); // RCC_RSR.RMVF: clear old reset-source flags.
        await p.run();
        window.__resetEvidence.beforeDhcsr=await p._readWord(0xe000edf0);
      } finally {await p.disconnect();}
      return true;`);
    assert.equal(await c.eval('return await window.__tools.flash.resetTarget();'), true);
    const evidence = await c.eval(`
      const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
      const p=await P.open((await P.authorized())[0],{clockKhz:1000});
      const ev=window.__resetEvidence;
      try {
        ev.dhcsr=await p._readWord(0xe000edf0);
        ev.dfsr=await p._readWord(0xe000ed30);
        ev.rsr=await p._readWord(0x580244d0);
        if(ev.dhcsr & (1<<17)) ev.pc=await p.regRead(15);
      } finally {
        const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,ev.demcr,true);
        await p.writeMem(0xe000edfc,b); await p.run(); await p.disconnect();
      }
      return ev;`);
    report.cases.push({ name: 'web reset vector catch', mode, evidence });
    assert.ok(!(evidence.beforeDhcsr & (1 << 17)), 'CPU was running before reset');
    assert.ok(evidence.dhcsr & (1 << 17), 'CPU stopped due to reset vector catch');
    assert.ok(evidence.dfsr & 8, 'DFSR.VCATCH set');
    assert.equal(evidence.pc & ~1, evidence.resetVector & ~1, 'PC is Reset_Handler');
    assert.ok(evidence.rsr & (1 << 22), 'RCC_RSR.PINRSTF: external NRST caused reset');
    console.log('web reset PASS', mode ? 'OD' : 'PP', JSON.stringify(evidence));
  }
  for (let i=0;i<3;i++) assert.equal(await c.eval('return await window.__tools.flash.resetTarget();'), true);
  report.cases.push({ name: 'three consecutive global resets', passed: true });
  const screen=await c.send('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(out,'web-acceptance.png'), Buffer.from(screen.data,'base64'));
  report.log = await c.eval(`return document.getElementById('f-log').textContent;`);
  assert.equal(report.errors.length,0,'no uncaught page exceptions');
  report.result='passed';
} catch(e){ report.result='failed'; report.failure=e.stack; console.error(e); process.exitCode=1; }
finally {
  if(report.result==='failed'){
    try { await c.eval(`
      if(window.__resetEvidence){
        const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
        const p=await P.open((await P.authorized())[0],{clockKhz:1000});
        try {
          const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,window.__resetEvidence.demcr,true);
          await p.writeMem(0xe000edfc,b); await p.run();
        } finally {await p.disconnect();}
      }
      return true;`); }
    catch(e){report.cleanupError=e.message;}
  }
  report.finished=new Date().toISOString();
  await writeFile(resolve(out,'web-hardware.json'),JSON.stringify(report,null,2),{flag:'wx'});
  c.close();
}
