/** Independent browser tab; models only, no hardware/firmware changes. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Cdp, sleep } from './cdp-lib.mjs';
const base=process.env.CDP || 'http://127.0.0.1:9333', app=process.env.APP || 'http://127.0.0.1:8899/index.html';
const page=await (await fetch(`${base}/json/new?${encodeURIComponent(app+'?hid=mock&demo=serial&diagnostics-test='+Date.now()+'#dbg')}`,{method:'PUT'})).json();
const c=new Cdp(base,30000), errors=[];
mkdirSync('tmp/diagnostics',{recursive:true});
try{
  c.ws=await c._open(page.webSocketDebuggerUrl,(_,m)=>c._dispatch(m));
  c.onEvent=e=>{if(e.method==='Runtime.exceptionThrown')errors.push(e.params.exceptionDetails.text+':'+e.params.exceptionDetails.exception?.description);};
  await c.send('Runtime.enable');await c.send('Page.enable');await c.send('Network.enable');await c.send('Network.setCacheDisabled',{cacheDisabled:true});
  await c.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<100;i++){if(await c.eval('return !!window.__tools?.diagnostics;'))break;await sleep(100);}
  assert.ok(await c.eval('return !!window.__tools?.diagnostics;'),'app initialization');
  const stopped=await c.eval(`
    const v=__tools.dbg;document.getElementById('d-backend').value='mock';await v.connect();
    const p=v.session.probe;
    p.ppb.set(0xe000ed28,(1<<9)|(1<<15));p.ppb.set(0xe000ed2c,1<<30);p.ppb.set(0xe000ed38,0x40000004);
    p.ppb.set(0xe000ed08,0);p.regs[16]=0x01000003;p.regs[14]=0xfffffffd;p.regs[18]=0x20000020;
    p.regs[15]=0x08000100;v.session.pc=0x08000100;
    const b=new Uint8Array(32),d=new DataView(b.buffer);[1,2,3,4,12,0x08000201,0x08000180,0x01000000].forEach((x,i)=>d.setUint32(i*4,x,true));
    await p.writeMem(0x20000020,b);
    // Mock vector address zero is not writable code; use the model's flash vector table.
    p.ppb.set(0xe000ed08,0x08000000);p.flash.set([1,1,0,8],12);
    await v.session.exclusive(async()=>{await v.session.refreshRegs();await v.afterStop();});
    return {tab:v.dockTab,report:v.faultPanel.report(),reads:v.faultPanel.snapshot.reads,running:p.running};
  `);
  assert.equal(stopped.tab,'fault');assert.equal(stopped.running,false);assert.equal(stopped.report.snapshot.frame.validated,true);
  assert.ok(stopped.report.findings.some(x=>x.text.includes('有效 BFAR')));
  assert.equal(stopped.report.settings.时段,'当前停止现场');
  assert.equal(await c.eval(`return document.getElementById('d-fault-catch').checked;`),false);
  assert.equal(await c.eval(`const v=__tools.dbg,p=v.session.probe;const before=p.ppb.get(0xe000edfc)||0;await v.session.exclusive(()=>v.faultPanel.setCatchLocked(true));await v.session.exclusive(()=>v.faultPanel.restoreCatchLocked(false));return (p.ppb.get(0xe000edfc)||0)===before;`),true);
  const source=await c.eval(`
    const v=__tools.dbg;v.loadElfBuffer(await(await fetch('/tools/fixtures/dwarf/stm32f103_scope.elf')).arrayBuffer(),'stm32f103_scope.elf');
    const p=v.session.probe,pc=v.sym.find('main').addr&0xfffffffe;
    const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,pc,true);await p.writeMem(0x20000038,bytes);
    await v.session.exclusive(()=>v.faultPanel.captureLocked());return v.faultPanel.report();
  `);
  assert.equal(source.snapshot.frame.validated,true);assert.ok(source.snapshot.frames[0].loc?.line>0);assert.equal(source.environment.ELF,'stm32f103_scope.elf');
  writeFileSync('tmp/diagnostics/fault-panel.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  const downloads=await c.eval(`
    const saved=URL.createObjectURL,click=HTMLAnchorElement.prototype.click,blobs=[];window._exports=[];
    URL.createObjectURL=b=>{blobs.push(b);return saved(b);};HTMLAnchorElement.prototype.click=function(){if(this.download.startsWith('akalink-'))_exports.push(this.download);else click.call(this);};
    document.getElementById('d-fault-json').click();document.getElementById('d-fault-md').click();
    const output=await Promise.all(blobs.map(b=>b.text()));URL.createObjectURL=saved;HTMLAnchorElement.prototype.click=click;
    return {names:_exports,output};
  `);
  assert.equal(downloads.names.length,2);assert.equal(JSON.parse(downloads.output[0]).schema,'akalink-diagnostics/v1');assert.match(downloads.output[1],/异常诊断报告/);
  const failure=await c.eval(`
    const v=__tools.dbg,p=v.session.probe,read=p.readMemDiagnostic.bind(p),accesses=[];
    p.readMemDiagnostic=async(a,n)=>{accesses.push(a);if(a===0xe000ed28)throw Error('test fault');return read(a,n);};
    v.watching=true;v.rtt={readUp(){throw Error('must not pump after fault');}};
    await v.session.exclusive(()=>v.faultPanel.captureLocked());p.readMemDiagnostic=read;
    return {error:v.faultPanel.snapshot.error,watching:v.watching,rtt:!!v.rtt,last:accesses.at(-1),running:p.running};
  `);
  assert.match(failure.error,/test fault/);assert.equal(failure.watching,false);assert.equal(failure.rtt,false);assert.equal(failure.last,0xe000ed28);assert.equal(failure.running,false);
  const old=await c.eval(`await __tools.dbg.runLine('c');return __tools.dbg.faultPanel.report().settings.时段;`);assert.match(old,/历史/);
  await c.eval(`await __tools.dbg.disconnect();location.hash='scope';await __tools.scope.setMock(true);document.getElementById('sc-period').value='100';document.getElementById('sc-seconds').value='1';await __tools.scope.start();`);
  await sleep(1600);
  const quality=await c.eval(`await __tools.scope.stop();const before=document.getElementById('sc-canvas').getBoundingClientRect().height;document.getElementById('sc-quality').click();return {before,after:document.getElementById('sc-canvas').getBoundingClientRect().height,shown:!__tools.diagnostics.drawer.el.hidden,report:__tools.diagnostics.report('scope')};`);
  assert.equal(quality.shown,true);assert.equal(quality.before,quality.after);assert.ok(quality.report.metrics.find(x=>x.name==='网页保留样本').value>0);
  await c.eval(`document.querySelector('.diag-drawer details').open=true;`);await sleep(1100);
  assert.equal(await c.eval(`return document.querySelector('.diag-drawer details').open;`),true);
  mkdirSync('tmp/diagnostics',{recursive:true});
  writeFileSync('tmp/diagnostics/scope-quality.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await c.eval(`location.hash='rttcdc';await __tools.hid.start();await __tools.stream.refreshPorts();document.getElementById('c-port').value=String(__tools.stream.ports.findIndex(p=>p.constructor.name==='DemoPort'));await __tools.stream.connect();`);
  await sleep(700);
  const rtt=await c.eval(`__tools.stream._setSuppressed(true);document.getElementById('c-quality').click();return __tools.diagnostics.report('rtt');`);
  assert.ok(rtt.findings.some(x=>x.text.includes('高速显示保护')));assert.ok(rtt.findings.some(x=>x.text.includes('误码率')));
  assert.equal(rtt.settings.数据,'模拟探针状态');
  const flood=await c.eval(`
    const v=__tools.stream;clearInterval(v.s.port._timer);v.s.port._timer=null;
    const before=v.rxc.total, times=[];let last=performance.now();
    const timer=setInterval(()=>{const now=performance.now();times.push(now-last);last=now;},30);
    try {for(const size of [10240,102400]){
      const bytes=new Uint8Array(size).fill(65);bytes[size-1]=10;
      for(let i=0;i<12;i++){__tools.session.emit('data',bytes,new Date());await new Promise(r=>setTimeout(r,50));}
    }}finally{clearInterval(timer);}
    return {bytes:v.rxc.total-before,suppressed:v.suppressed,maxDelay:Math.max(...times),events:__tools.diagnostics.report('rtt').history.events.length};
  `);
  assert.equal(flood.bytes,12*(10240+102400));assert.equal(flood.suppressed,true);assert.ok(flood.maxDelay<1000,JSON.stringify(flood));assert.ok(flood.events<=128);
  await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await sleep(300);writeFileSync('tmp/diagnostics/rtt-quality.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await c.eval(`await __tools.session.close();await __tools.hid.stop();__tools.diagnostics.drawer.close();location.hash='dbg';`);
  assert.deepEqual(errors,[]);const globals=await c.eval(`return __tools.errors;`);assert.deepEqual(globals,[]);
  console.log('diagnostics-page: fault auto snapshot, catch restore, exports/history, JScope counters/drawer height, RTT 200 KiB/s and 2 MiB/s simulated bursts, 1280/1600 UI OK; max UI interval '+flood.maxDelay.toFixed(1)+' ms');
}finally{
  c.close();await fetch(`${base}/json/close/${page.id}`).catch(()=>{});
}
