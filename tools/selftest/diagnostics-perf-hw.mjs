/** Sequential hardware A/B against an archived baseline. Requires the matching
 * H743 fixture already flashed; no flash writes or automatic firmware change. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {Cdp,sleep} from './cdp-lib.mjs';
const arg=(key,fallback)=>process.argv.find(x=>x.startsWith('--'+key+'='))?.split('=').slice(1).join('=')||fallback;
const kind=arg('kind','scope'),seconds=Number(arg('seconds','8')),repeats=Number(arg('repeats','3'));
const clockKhz=Number(arg('clock','60000'));
assert.ok(Number.isFinite(clockKhz)&&clockKhz>0,'--clock is SWD kHz');
const dir=arg('out','tmp/diagnostics-hw'),baseline=arg('baseline','/tmp/diagnostics-hw/baseline/index.html');
const c=new Cdp('http://127.0.0.1:9333',60000),results=[];mkdirSync(dir,{recursive:true});
const fixture=kind==='scope'?'tools/target-firmware/stm32h743_scope/fw.elf':kind==='rtt'?'tools/target-firmware/stm32h743_rtt_speed/fw.elf':'tools/target-firmware/stm32h743_fault/fw.elf';
const bytes=readFileSync(fixture).toString('base64');
async function cleanup(){await c.eval(`const t=__tools;await t.diagnostics?.drawer.close();if(t.scope.running)await t.scope.stop();await t.scope.releaseProbe();await t.hid.stop();await t.hid.dev?.close();if(t.session.isOpen)await t.session.close();if(t.dbg.session.connected)await t.dbg.disconnect();`);}
try{
 await c.connect();
 for(let repeat=0;repeat<repeats;repeat++)for(const state of (repeat%2?['open','closed','baseline']:['baseline','closed','open'])){
  if(kind==='dbg'&&state==='open')continue;
  await cleanup();const url=state==='baseline'?baseline:'/index.html';
  await c.send('Page.navigate',{url:'http://127.0.0.1:8899'+url+'?diagnostic-perf='+Date.now()+'#'+(kind==='rtt'?'rttcdc':kind==='scope'?'scope':'dbg')});await c.send('Page.bringToFront');
  for(let i=0;i<100;i++){if(await c.eval('return !!window.__tools?.scope;').catch(()=>false))break;await sleep(100);}
  await c.eval(`globalThis.hwPerf={intervals:[],last:performance.now()};hwPerf.timer=setInterval(()=>{const n=performance.now();hwPerf.intervals.push(n-hwPerf.last);hwPerf.last=n;},20);`);
  if(kind==='dbg'){
   await c.eval(`const d=__tools.dbg;document.getElementById('d-backend').value='webusb';document.getElementById('d-clock').value='10000';document.getElementById('d-rtt-on').checked=false;document.getElementById('d-follow-pc').checked=false;await d._syncBackend();d.loadElfBuffer(Uint8Array.from(atob(${JSON.stringify(bytes)}),x=>x.charCodeAt(0)).buffer,'fault-fixture.elf');if(!await d.connect())throw Error('connect');await d.session.resetRun();`);
   const r=await c.eval(`const d=__tools.dbg;const times=[];for(let i=0;i<60;i++){const a=performance.now();await d.runLine('halt');if(!d.session.halted)throw Error('not halted');await d.runLine('c');times.push(performance.now()-a);await new Promise(r=>setTimeout(r,5));}await d.runLine('halt');return {cycles:times.length,cycleMs:times.reduce((a,b)=>a+b,0)/times.length,maxCycleMs:Math.max(...times),faultSnapshot:!!d.faultPanel?.snapshot,heals:d.session.probe.faultHeals,recoveries:d.session.probe.recoveries};`);
   results.push({kind,repeat,state,...r});
  }else if(kind==='scope'){
   await c.eval(`const s=__tools.scope;document.getElementById('sc-target').value='swd';document.getElementById('sc-target').dispatchEvent(new Event('change'));document.getElementById('sc-clock').value='60000';await s.connectHid(false);await s.connectUsb(false);if(!s.hid||!s.transport)throw Error('scope connection');await s.loadElfFile(new File([Uint8Array.from(atob(${JSON.stringify(bytes)}),x=>x.charCodeAt(0))],'scope.elf'));`);
   for(const config of [{period:3,vars:['g_pack.u_cnt']},{period:10,vars:['g_pack.f_sin','g_pack.i_tick','g_pack.i_sq1k']}]){
    await c.eval(`const s=__tools.scope;s.selected=[];for(const name of ${JSON.stringify(config.vars)}){const v=s.all.find(x=>x.name===name);if(!v)throw Error('Missing '+name);s.toggleVar(v,true);}document.getElementById('sc-period').value=${JSON.stringify(String(config.period))};document.getElementById('sc-seconds').value=${JSON.stringify(String(seconds+2))};document.getElementById('sc-cdcoff').checked=false;document.getElementById('sc-batch').checked=true;s.updatePlan();await s.start();if(!s.running)throw Error(document.getElementById('sc-state').textContent);${state==='open'?'__tools.diagnostics.drawer.open("scope");':''}hwPerf.intervals=[];hwPerf.last=performance.now();hwPerf.started=performance.now();`);
    await sleep(seconds*1000);
    const r=await c.eval(`const s=__tools.scope;await s.readScopeMetrics({fresh:true});const timing=(performance.now()-hwPerf.started)/1000;await s.stop();let invalid=0;for(const channel of s.store.channels){if(channel.name==='g_pack.f_sin')for(let i=0;i<s.store.count;i++)if(!Number.isFinite(channel.at(i))||Math.abs(channel.at(i))>1.001)invalid++;if(channel.name==='g_pack.i_sq1k')for(let i=0;i<s.store.count;i++)if(Math.abs(channel.at(i))!==1000)invalid++;}return {seconds:timing,swdMhz:s.swdMhz,requestedClock:document.getElementById("sc-clock").value,rateHz:s.store.rate(),samples:s.store.count,packets:s.packets,gap:s.lost,decode:s.decodeErr,overrun:s.store.overrun,metrics:s.probeMetrics,metricsError:s.metricsError,invalid,report:__tools.diagnostics?.report('scope'),uiMaxMs:Math.max(...hwPerf.intervals),uiP99Ms:hwPerf.intervals.sort((a,b)=>a-b)[Math.floor(hwPerf.intervals.length*.99)],errors:__tools.errors};`);
    results.push({kind,repeat,state,config,...r});console.log(kind,repeat,state,config.period,JSON.stringify({rate:r.rateHz,metrics:r.metrics,gap:r.gap,decode:r.decode,invalid:r.invalid,uiP99:r.uiP99Ms,uiMax:r.uiMaxMs}));
    writeFileSync(dir+'/performance-'+kind+'.json',JSON.stringify(results,null,2));assert.ok(r.samples>0);assert.equal(r.gap,0);assert.equal(r.decode,0);assert.equal(r.invalid,0);assert.equal(r.metrics?.errors,0);assert.deepEqual(r.errors,[]);
   }
  }else{
   await c.eval(`document.getElementById('h-target').value='swd';document.getElementById('h-target').dispatchEvent(new Event('change'));document.getElementById('h-clock').value='${clockKhz*1000}';document.getElementById('h-addr').value='0x24000014';document.getElementById('h-size').value='0x1000';await __tools.hid.connect();await __tools.hid.start();await __tools.stream.refreshPorts();await __tools.stream.connect();if(!__tools.session.isOpen||!__tools.hid.last?.running)throw Error('RTT not started');${state==='open'?'__tools.diagnostics.drawer.open("rtt");':''}
    globalThis.hwPattern={bytes:0,phase:0,bad:0,synced:false,first:[],mismatches:[]};const pattern=Uint8Array.of(104,101,108,108,111,32,119,111,114,108,100,33,10);hwPerf.unsubscribe=__tools.session.on('data',b=>{for(const x of b){if(hwPattern.first.length<100)hwPattern.first.push(x);if(!hwPattern.synced){if(x===10){hwPattern.synced=true;hwPattern.phase=0;}continue;}if(x!==pattern[hwPattern.phase]){hwPattern.bad++;if(hwPattern.mismatches.length<10)hwPattern.mismatches.push({x,want:pattern[hwPattern.phase],phase:hwPattern.phase});}hwPattern.phase=x===10?0:(hwPattern.phase+1)%pattern.length;}hwPattern.bytes+=b.length;});`);
   await sleep(800);const before=await c.eval('return {bytes:hwPattern.bytes,bad:hwPattern.bad,first:hwPattern.first,mismatches:hwPattern.mismatches,time:performance.now(),status:__tools.hid.last};');
   await c.eval('hwPerf.intervals=[];hwPerf.last=performance.now();');await sleep(seconds*1000);
   const r=await c.eval(`await __tools.hid.refresh();return {bytes:hwPattern.bytes,bad:hwPattern.bad,first:hwPattern.first,mismatches:hwPattern.mismatches,time:performance.now(),status:__tools.hid.last,uiMaxMs:Math.max(...hwPerf.intervals),uiP99Ms:hwPerf.intervals.sort((a,b)=>a-b)[Math.floor(hwPerf.intervals.length*.99)],retained:__tools.stream.rx.rawBytes,suppressed:__tools.stream.suppressed,report:__tools.diagnostics?.report('rtt'),errors:__tools.errors};`);
   // A repeating line detects discontinuities, not exact lost bytes or BER.
   // Keep mismatches as evidence while finishing the sequential A/B sweep.
   const result={kind,repeat,state,seconds:(r.time-before.time)/1000,Bps:(r.bytes-before.bytes)*1000/(r.time-before.time),bad:r.bad-before.bad,before,after:r};results.push(result);console.log(kind,repeat,state,JSON.stringify({Bps:result.Bps,bad:result.bad,status:r.status,uiP99:r.uiP99Ms,uiMax:r.uiMaxMs}));writeFileSync(dir+'/performance-'+kind+'.json',JSON.stringify(results,null,2));assert.ok(result.Bps>1000000);assert.equal(r.status.rdErr,0);assert.equal(r.status.wrErr,0);assert.deepEqual(r.errors,[]);
  }
  const extra=await c.eval('clearInterval(hwPerf.timer);return {uiMaxMs:Math.max(...hwPerf.intervals),errors:__tools.errors};');if(kind==='dbg'){Object.assign(results.at(-1),extra);console.log(results.at(-1));}
  writeFileSync(dir+'/performance-'+kind+'.json',JSON.stringify(results,null,2));
 }
}finally{try{await c.eval('if(globalThis.hwPerf)clearInterval(hwPerf.timer);');await cleanup();}catch(e){console.error('Cleanup',e.message);}c.close();}
