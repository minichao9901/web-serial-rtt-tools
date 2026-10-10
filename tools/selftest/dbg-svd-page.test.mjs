/** Real SVD DOM and debugger polling, with memory reads simulated; no hardware. */
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {Cdp,sleep} from './cdp-lib.mjs';
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',20000),app=process.env.APP||'http://127.0.0.1:8899/index.html';
let targetId,passed=0;const ok=(condition,name)=>{assert.ok(condition,name);passed++;console.log('PASS '+name);};
try{
 await c.connect();({targetId}=await c.sendBrowser('Target.createTarget',{url:'about:blank'}));
 const tab=(await(await fetch(c.base+'/json/list')).json()).find(t=>t.id===targetId);
 c.ws.close();c.ws=await c._open(tab.webSocketDebuggerUrl,(ws,m)=>c._dispatch(m));await c.send('Page.enable');await c.send('Runtime.enable');await c.send('Network.enable');await c.send('Network.setCacheDisabled',{cacheDisabled:true});
 await c.send('Page.bringToFront');const url=new URL(app);url.hash='dbg';await c.send('Page.navigate',{url:url.href});
 for(let n=0;n<100;n++){if(await c.eval('return !!window.__tools?.dbg&&!document.getElementById("boot-mask");').catch(()=>false))break;await sleep(100);}
 ok(await c.eval(`return !__tools.errors.length&&document.getElementById('d-svd-bundled').options.length===3&&!document.getElementById('d-svd-live').checked;`),'SVD controls initialized, live reading defaults off');
 for(const [id,count]of [['STM32H743',2946],['STM32H750',3067],['STM32F103xx',null]]){
  const model=await c.eval(`const d=__tools.dbg,m=await d.loadBundledSvd(${JSON.stringify(id)});return {name:m?.name,registers:m?.peripherals.reduce((n,p)=>n+p.registers.length,0),empty:m?.peripherals.filter(p=>!p.registers.length).length};`);
  ok(model.name===id&&(count===null||model.registers===count)&&!model.empty,'compressed built-in '+id+' and inherited peripheral registers');
 }
 await c.eval(`const d=__tools.dbg;await d._ensureSession(false);document.getElementById('d-backend').value='webusb';const s=d.session;globalThis.svdTest={raw:0,reads:[],active:0,maxActive:0,fail:false};s.probe={};s.halted=true;s.regs=[];
 s.memRead=async(a,n)=>{const m=svdTest;m.reads.push({a,time:performance.now()});m.active++;m.maxActive=Math.max(m.maxActive,m.active);try{await new Promise(r=>setTimeout(r,30));if(m.fail)throw Error('simulated bus failure');const b=new Uint8Array(n);new DataView(b.buffer).setUint32(0,m.raw,true);return b;}finally{m.active--;}};
 s.refresh=async()=>({connected:true,halted:s.halted,pc:0});d._refreshWatchLocked=async()=>{};d.renderSource=async()=>{};d.faultPanel.afterStopLocked=async()=>null;
 d._dockSelect('svd');await s.exclusive(async()=>{});const p=document.getElementById('d-svd-periph');p.value=d.svd.peripherals.findIndex(p=>p.name==='GPIOA');d._renderSvdRegisters();document.getElementById('d-svd-reg').value=d._svdPeripheral().registers.findIndex(r=>r.name==='CRL');d._renderSvdRegister();await d._readSvdRegister();return true;`);
 ok(await c.eval(`return !document.getElementById('d-svd-value').classList.contains('chg');`),'first paused read establishes baseline without false orange');
 await c.eval(`const d=__tools.dbg;d.session.halted=false;svdTest.raw=1;await d._readSvdRegister();`);
 ok(await c.eval(`const rows=[...document.querySelectorAll('#d-svd-fields .svdfield')];return document.getElementById('d-svd-value').classList.contains('chg')&&rows.find(r=>r.querySelector('.fn').textContent==='MODE0').classList.contains('chg')&&!rows.find(r=>r.querySelector('.fn').textContent==='CNF0').classList.contains('chg');`),'running register and changed bitfield orange; unchanged field remains normal');
 for(const width of [1600,1280]){
  await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  const layout=await c.eval(`return {page:document.documentElement.scrollWidth<=innerWidth+1,rows:[...document.querySelectorAll('[data-dock="svd"] .toolrow')].every(r=>r.scrollWidth<=r.clientWidth+1)};`);
  ok(layout.page&&layout.rows,'SVD toolbar layout '+width);
 }
 mkdirSync('tmp',{recursive:true});const screenshot=await c.send('Page.captureScreenshot',{format:'png'});writeFileSync('tmp/svd-live-page.png',Buffer.from(screenshot.data,'base64'));
 await sleep(2300);
 ok(await c.eval(`return !document.querySelector('#d-svd-fields .chg')&&!document.getElementById('d-svd-value').classList.contains('chg');`),'orange expires after a stable interval even without another memory read');
 await c.eval(`const d=__tools.dbg;d.session.halted=true;d.session.regs=[];await d.afterStop();await d._readSvdRegister();`);
 ok(await c.eval(`return document.getElementById('d-svd-value').classList.contains('chg');`),'after-stop hook compares previous paused snapshot, repeated read preserves orange');
 await c.eval(`const d=__tools.dbg;d.session.regs=[];await d.afterStop();`);
 ok(await c.eval(`return !document.getElementById('d-svd-value').classList.contains('chg');`),'unchanged next halted snapshot clears orange');
 const hiddenStop=await c.eval(`const d=__tools.dbg,n=svdTest.reads.length;d.dockTab='regs';d.session.regs=[];svdTest.raw=2;await d.afterStop();d.dockTab='svd';return svdTest.reads.length===n+1&&document.getElementById('d-svd-value').classList.contains('chg');`);
 ok(hiddenStop,'halted snapshots stay current when another debugger dock tab is selected');
 const poll=await c.eval(`const d=__tools.dbg,s=d.session;s.halted=false;document.getElementById('d-svd-live').checked=true;d._svdNextReadAt=0;svdTest.reads=[];d.watching=true;const loop=d._watchLoop();await new Promise(r=>setTimeout(r,900));
 const liveReads=svdTest.reads.length;let release;const gate=new Promise(r=>release=r);const busy=s.exclusive(()=>gate);await new Promise(r=>setTimeout(r,80));const before=svdTest.reads.length;await new Promise(r=>setTimeout(r,600));const busyReads=svdTest.reads.length-before;release();await busy;
 document.getElementById('tab-dbg').classList.remove('active');const hiddenBefore=svdTest.reads.length;await new Promise(r=>setTimeout(r,700));const hiddenReads=svdTest.reads.length-hiddenBefore;document.getElementById('tab-dbg').classList.add('active');d.watching=false;await loop;return {liveReads,busyReads,hiddenReads,maxActive:svdTest.maxActive};`);
 ok(poll.liveReads>=1&&poll.liveReads<=3,'running debugger loop refreshes selected SVD register');
 ok(poll.busyReads===0&&poll.maxActive===1,'foreground ownership excludes automatic reads; no overlapping transactions');
 ok(poll.hiddenReads===0,'hidden debugger panel does not poll SVD registers');
 const stale=await c.eval(`const d=__tools.dbg;svdTest.raw=7;const p=d._readSvdRegister();document.getElementById('d-svd-reg').value=d._svdPeripheral().registers.findIndex(r=>r.name==='CRH');d._renderSvdRegister();const key=d._svdKey();await p;return !d.svdValues.entries.has(key)&&document.getElementById('d-svd-value').textContent.includes('复位值');`);
 ok(stale,'late read cannot overwrite another selected register');
 await c.eval(`svdTest.fail=true;document.getElementById('d-svd-live').checked=true;await __tools.dbg._refreshSvdLocked();`);
 ok(await c.eval(`return !document.getElementById('d-svd-live').checked&&document.getElementById('d-svd-auto-note').textContent.includes('simulated bus failure');`),'read failure stops automatic polling and shows the reason');
 const mismatch=await c.eval(`const d=__tools.dbg,arch=d.session.arch;d.session.arch={...arch,name:'riscv'};const n=svdTest.reads.length;await d._refreshSvdLocked();const skipped=svdTest.reads.length===n&&document.getElementById('d-svd-auto-note').textContent.includes('RISC-V');d.session.arch=arch;return skipped;`);
 ok(mismatch,'STM32 SVD cannot automatically read a RISC-V target');
 const sideEffects=await c.eval(`const d=__tools.dbg;svdTest.fail=false;d.loadSvdText('<device><name>safe-test</name><peripherals><peripheral><name>P</name><baseAddress>0x40000000</baseAddress><registers><register><name>STATUS</name><addressOffset>0</addressOffset><readAction>clear</readAction></register></registers></peripheral></peripherals></device>');const n=svdTest.reads.length;await d._refreshSvdLocked();const skipped=svdTest.reads.length===n;await d._readSvdRegister();return skipped&&svdTest.reads.length===n+1&&document.getElementById('d-svd-auto-note').textContent.includes('副作用');`);
 ok(sideEffects,'read-side-effect register skipped automatically; manual read still available');
 await c.eval(`__tools.dbg._resetSvdSamples();__tools.dbg.session.probe=null;return true;`);
 ok(await c.eval('return !__tools.errors.length;'),'no uncaught page errors or hardware connections');
 console.log(`SVD page: ${passed} passed`);
}finally{if(targetId)try{await c.sendBrowser('Target.closeTarget',{targetId});}catch{}c.close();}
