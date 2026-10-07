/** HPM6800EVK + SDK flash_sdram_xip: real WebUSB regression for
 * connect → load ELF → b main → expanded desc watch → reset halt → c.
 * Requires tools/selftest/launch-browser.ps1 and serve-nocache on 9333/8899.
 * Never programs firmware or writes target RAM. Explicit reset/halt/resume and
 * hardware breakpoints are part of the test. The board must run the given ELF.
 * node tools/selftest/dbg-hw-sba-reset.mjs --rounds=5 --clock=10000
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Cdp,sleep} from './cdp-lib.mjs';
const arg=(name,fallback)=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
const rounds=Number(arg('rounds',5)),clock=Number(arg('clock',10000));
assert.ok(Number.isInteger(rounds)&&rounds>0&&rounds<=50);
const source=resolve(arg('elf','E:/sdk_env_v1.11.0/work/lwip_lwip_tcpecho_hpm6800evk_flash_sdram_xip_debug/output/demo.elf'));
const local=resolve('tmp/sba-reset-demo.elf');copyFileSync(source,local);
const bytes=readFileSync(local);
const result={date:new Date().toISOString(),elf:source,sha256:createHash('sha256').update(bytes).digest('hex'),clockKhz:clock,rounds:[]};
const cdp=new Cdp('http://127.0.0.1:9333',60000);
const watchdog=setTimeout(()=>{console.error('SBA reset hardware regression timed out');process.exit(9);},180000);
async function waitFor(expr,timeout=8000){
 const start=Date.now();
 while(Date.now()-start<timeout){if(await cdp.eval('return !!('+expr+');'))return;await sleep(100);}
 throw new Error('page state timeout: '+expr);
}
try{
 await cdp.connect();
 await cdp.eval('try {await window.__tools?.dbg?.disconnect();} catch {} return true;');
 await cdp.send('Page.navigate',{url:'http://127.0.0.1:8899/index.html?sba-reset='+Date.now()+'#dbg'});
 await waitFor('window.__tools?.dbg');
 await cdp.eval(`const d=window.__tools.dbg;d.clearWatch();
   document.querySelector('#tabs .tab[data-tab="dbg"]').click();
   const backend=document.getElementById('d-backend');backend.value='riscv';backend.dispatchEvent(new Event('change'));
   const clk=document.getElementById('d-clock');clk.value='${clock}';clk.dispatchEvent(new Event('change'));
   return true;`);
 const connection=cdp.eval('await window.__tools.dbg.connect(); return window.__tools.dbg.session.idcode;',true);
 await cdp.settle(undefined,'window.__tools.dbg.session.connected',30000).catch(()=>{});
 assert.equal(await connection,0x1000563d,'HPM TAP identity');
 result.symbols=await cdp.eval(`const d=window.__tools.dbg;
   const r=await fetch('/tmp/sba-reset-demo.elf?t='+Date.now());d.loadElfBuffer(await r.arrayBuffer(),'demo.elf');
   window.__sbaHardware={d,s:d.session,addresses:[]};
   const dm=d.session.dm,write=dm.dmiWrite.bind(dm);
   dm.dmiWrite=async(a,v,...rest)=>{if(a===0x39)window.__sbaHardware.addresses.push(v>>>0);return await write(a,v,...rest);};
   const act=d._act.bind(d);d._act=(...args)=>{const p=act(...args);window.__sbaHardware.action=p;return p;};
   const main=d.sym.find('main'),desc=d.sym.find('desc');
   window.__sbaHardware.main=main.addr;window.__sbaHardware.desc=desc.addr;
   return {main:main.addr,desc:desc.addr,start:d.sym.find('_start').addr};`);
 assert.equal(result.symbols.main,0x8000790c,'test ELF main matches the user fixture');
 assert.equal(result.symbols.desc,0x4000b600);
 await cdp.eval(`const {d,s}=window.__sbaHardware;
   await d.runLine('b main');await s.exclusive(()=>s.resetHalt());
   const r=await d.runLine('c');if(r?.error)throw Error(r.error);return true;`);
 await waitFor('window.__sbaHardware.s.halted && window.__sbaHardware.s.pc===window.__sbaHardware.main');
 await cdp.eval(`const {d}=window.__sbaHardware;
   document.getElementById('d-watch-live').checked=true;
   d.addWatch('desc');d.watch.items[0].expanded=true;await d.refreshWatch({force:true});return true;`);
 for(let i=0;i<rounds;i++){
  const row=await cdp.eval(`const t=window.__sbaHardware,{d,s}=t,dm=s.dm;
    t.addresses.length=0;
    document.getElementById('d-reset-halt').click();
    const resetOk=await t.action;
    const stopped={ok:resetOk,pc:s.pc,halted:s.halted,value:d.watch.items[0].value,
      bytes:d.watch.items[0].bytes,addresses:[...t.addresses],fault:dm._wireFault?.message,
      sbcs:await s.exclusive(()=>dm.dmiRead(0x38))};
    const resumed=await d.runLine('c');
    return {stopped,resumed};`,true);
  assert.equal(row.stopped.ok,true);assert.equal(row.stopped.pc,result.symbols.start);assert.equal(row.stopped.halted,true);
  assert.equal(row.stopped.value.cls,'dim');assert.match(row.stopped.value.text,/SDRAM/);assert.equal(row.stopped.bytes,null);
  assert.ok(row.stopped.addresses.length>0,'readiness queries actually ran');
  assert.ok(row.stopped.addresses.every(a=>a===0xf4000800||a===0xf400041c),'reset watch must not touch gated DDRCTL or SDRAM');
  assert.equal(row.stopped.sbcs&0x607000,0);assert.equal(row.stopped.fault,undefined);assert.equal(row.resumed.error,undefined);
  await waitFor('window.__sbaHardware.s.halted && window.__sbaHardware.s.pc===window.__sbaHardware.main && window.__sbaHardware.d.watch.items[0].bytes');
  row.after=await cdp.eval(`const {d,s,desc}=window.__sbaHardware,dm=s.dm;
    return await s.exclusive(async()=>{
      const watched=Array.from(d.watch.items[0].bytes);
      const old=dm._burstOff;let slow;try{dm._burstOff=true;slow=Array.from(await s.memRead(desc,60));}finally{dm._burstOff=old;}
      const burst=Array.from(await s.memRead(desc,60));
      return {pc:s.pc,watched,slow,burst,bps:s.bpList().length,sbcs:await dm.dmiRead(0x38),fault:dm._wireFault?.message};
    });`);
  assert.deepEqual(row.after.watched,row.after.slow);assert.deepEqual(row.after.burst,row.after.slow);
  assert.equal(row.after.bps,1);assert.equal(row.after.sbcs&0x607000,0);assert.equal(row.after.fault,undefined);
  result.rounds.push(row);console.log(`PASS round ${i+1}: reset at _start defers SDRAM; c hits main; watch/slow/burst match`);
 }
 await cdp.eval(`const {d,s}=window.__sbaHardware;await s.exclusive(()=>s.bpClear());await d.runLine('c');return true;`);
 await sleep(1500);
 result.live=await cdp.eval(`const {d,s}=window.__sbaHardware;return {running:!s.halted,
   value:d.watch.items[0].value,bytes:Array.from(d.watch.items[0].bytes||[]),fault:s.dm._wireFault?.message};`);
 assert.equal(result.live.running,true);assert.equal(result.live.value.cls,'');assert.equal(result.live.bytes.length,60);assert.equal(result.live.fault,undefined);
 assert.ok(result.live.bytes.some(b=>b!==0),'live watch must contain initialized descriptors, not stale all-zero startup data');
 console.log('PASS live watch after continuing past main');
 // Leave the review page stopped at main, with desc expanded and live refresh on.
 await cdp.eval(`const {d,s}=window.__sbaHardware;await d.runLine('b main');
   document.getElementById('d-reset-halt').click();await window.__sbaHardware.action;
   await d.runLine('c');return true;`);
 await waitFor('window.__sbaHardware.s.halted && window.__sbaHardware.s.pc===window.__sbaHardware.main && window.__sbaHardware.d.watch.items[0].bytes');
 result.ok=true;
 await cdp.send('Page.bringToFront');
}catch(e){result.ok=false;result.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{
 try{result.log=await cdp.eval("return document.getElementById('d-out')?.textContent;");}catch{}
 writeFileSync(resolve(arg('out','tmp/sba-reset-hardware.json')),JSON.stringify(result,null,2));
 cdp.close();clearTimeout(watchdog);
}
