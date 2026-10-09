/** 独立页面，不碰用户原页面或真串口。APP/CDP 可覆盖。 */
import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync} from 'node:fs';
import {Cdp} from './cdp-lib.mjs';
const base=process.env.CDP||'http://127.0.0.1:9333';
const app=process.env.APP||'http://localhost:8899/index.html';
const c=new Cdp(base,60000);
const p=await(await fetch(base+'/json/new?'+encodeURIComponent(app+'?demo=serial&hid=mock&display-test='+Date.now()+'#rttcdc'),{method:'PUT'})).json();
try{
c.ws=await c._open(p.webSocketDebuggerUrl,(_,m)=>c._dispatch(m));
await c.send('Page.enable');await c.send('Runtime.enable');await c.send('Network.enable');await c.send('Network.setCacheDisabled',{cacheDisabled:true});await c.send('Page.bringToFront');
for(let i=0;i<100;i++){ if(await c.eval('return !!__tools?.stream?.rx').catch(()=>false))break;await new Promise(r=>setTimeout(r,50)); }
await c.send('Performance.enable');
const pre=await c.send('Performance.getMetrics');
const history=await c.eval(`
__tools.stream._setRxMode('ascii');
const rx=__tools.stream.rx;rx.clear();rx.setAutoscroll(true);rx.setTimestamps(false);
const b=new TextEncoder().encode(('trace enet_common_handler abcdefghijklmnopqrstuvwxyz0123456789\\n').repeat(16));
for(let i=0;i<2048;i++)rx._store(b,new Date());
const start=performance.now();rx.setDisplayOff(true);rx.setDisplayOff(false);
return {ms:performance.now()-start,rawBytes:rx.bytes,nodes:rx.nodes.length,chars:rx.el.textContent.length,lines:rx.lines};`);
const post=await c.send('Performance.getMetrics');
history.layouts=post.metrics.find(m=>m.name==='LayoutCount').value-pre.metrics.find(m=>m.name==='LayoutCount').value;
assert.ok(history.ms<500,JSON.stringify(history));assert.ok(history.layouts<=3,JSON.stringify(history));assert.ok(history.chars<=262144);assert.equal(history.nodes,1);
const burst=await c.eval(`
const {SerialSession}=await import('./app/serial/session.js');
const t=__tools,s=t.stream;const enc=new TextEncoder();
t.session.isOpen=true;s.rxc.reset();t.assistant.rxc.reset();
let terminalWrites=0;const tw=t.terminal.term.write.bind(t.terminal.term);t.terminal.term.write=(...a)=>{terminalWrites++;return tw(...a);};
let recorded=0;const rec=s.rec;rec.active=true;rec._w={write:async b=>{
  for(let i=0;i<b.length;i++)if(b[i]!==packet[(recorded+i)%packet.length])throw Error('记录字节内容错位');
  recorded+=b.length;
},close:async()=>{}};
const packet=enc.encode(('trace eth tcp repeat abcdefghijklmnopqrstuvwxyz 1234567890\\n').repeat(2048)).slice(0,65536);
const n=256,expected=n*packet.length;
const ss=new SerialSession();let index=0;ss.isOpen=true;
ss.port={readable:{getReader:()=>({read:async()=>{if(index++<n)return {value:packet,done:false};ss.isOpen=false;return {done:true};},releaseLock(){}})},close:async()=>{}};
ss.on('data',(b,timestamp)=>t.session.emit('data',b,timestamp));
let heartbeats=0,maxGap=0,last=performance.now();
const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;heartbeats++;},10);
await ss._readLoop();await new Promise(r=>setTimeout(r,30));
rec._flush();await rec._wq;await rec.stop();clearInterval(timer);
const hiddenWrites=terminalWrites;
const suppressed=s.suppressed,pending=t.terminal.display.bytes;
// 恢复显示与手动显示，继续承受突发数据。
s.suppManual=true;s._setSuppressed(false);
for(let j=0;j<1024;j++)t.session.emit('data',packet,new Date());
s.rx.flush();
const manualChars=s.rx.el.textContent.length;
// 切到隐藏终端，回放有限尾部，不一次解析全部历史。
document.querySelector('#tabs [data-tab=terminal]').click();
await new Promise(r=>setTimeout(r,500));
const terminalPending=t.terminal.display.bytes;
// ANSI 突发、暂停、恢复、清空。
document.querySelector('#tabs [data-tab=rttcdc]').click();s._setRxMode('ansi');
s.suppManual=true;s._setSuppressed(false);s.rx.setPaused(true);
for(let j=0;j<1024;j++)t.session.emit('data',packet,new Date());
s.rx.setPaused(false);s._ansiRedraw();const ansiPending=s.ansiDisplay.bytes;
await new Promise(r=>setTimeout(r,500));
document.getElementById('c-clear').click();const cleared=s.ansiDisplay.bytes===0&&s.rx.bytes===0;
t.session.isOpen=false;t.terminal.term.write=tw;
return {expected,receivedBeforeManual:s.rxc.total-2048*packet.length,recorded,heartbeats,maxGap,hiddenWrites,suppressed,pending,manualChars,terminalPending,ansiPending,cleared,errors:t.errors};
`);
assert.equal(burst.recorded,burst.expected,'显示抑制不影响文件写入字节');assert.equal(burst.receivedBeforeManual,burst.expected,'计数涵盖全部接收数据');
assert.ok(burst.heartbeats>0,'连续立即兑现的 read 期间 UI 定时器必须运行');assert.ok(burst.maxGap<500,JSON.stringify(burst));
assert.equal(burst.hiddenWrites,0);assert.equal(burst.suppressed,true);assert.ok(burst.pending<=65536);assert.ok(burst.ansiPending<=65536);assert.ok(burst.manualChars<=262144);assert.equal(burst.cleared,true);assert.deepEqual(burst.errors,[]);
const sustained=await c.eval(`
const t=__tools,s=t.stream;t.session.isOpen=true;
document.querySelector('#tabs [data-tab=rttcdc]').click();s._setRxMode('ascii');s.suppManual=false;s.rxc.reset();s.rx.clear();
const packet=new TextEncoder().encode(('trace TCP enet abcdefghijklmnopqrstuvwxyz0123456789\\n').repeat(32)).slice(0,1024);
for(let i=0;i<2048;i++)s.rx._store(packet,new Date());s.rx.repaint();
let expected=0,recorded=0,heartbeats=0,maxGap=0,last=performance.now(),hiddenWrites=0;
const write=t.terminal.term.write.bind(t.terminal.term);t.terminal.term.write=(...a)=>{hiddenWrites++;return write(...a);};
const rec=s.rec;rec.active=true;rec.error=null;rec.bytes=0;rec.pushed=0;rec.written=0;rec._w={write:async b=>{
for(let i=0;i<b.length;i++)if(b[i]!==packet[(recorded+i)%packet.length])throw Error('持续流记录内容错位');recorded+=b.length;
},close:async()=>{}};
const beat=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;heartbeats++;},20);
const phases=[];
for(const kb of [200,512,1024]){
  const start=performance.now();
  for(let tick=0;tick<75;tick++){
    for(let i=0;i<Math.round(kb*.02);i++){t.session.emit('data',packet,new Date());expected+=packet.length;}
    await new Promise(r=>setTimeout(r,20));
  }
  const high=s.suppressed;await new Promise(r=>setTimeout(r,1400));s._stats();
  phases.push({requestedKBps:kb,high,recovered:!s.suppressed,ms:performance.now()-start});
}
clearInterval(beat);rec._flush();await rec._wq;await rec.stop();t.session.isOpen=false;t.terminal.term.write=write;
return {expected,recorded,received:s.rxc.total,heartbeats,maxGap,hiddenWrites,phases,errors:t.errors};`);
assert.equal(sustained.expected,sustained.recorded);assert.equal(sustained.expected,sustained.received);assert.ok(sustained.maxGap<500,JSON.stringify(sustained));assert.equal(sustained.hiddenWrites,0);
assert.ok(sustained.phases.every(p=>p.high&&p.recovered));assert.deepEqual(sustained.errors,[]);
const regular=await c.eval(`
const {runUiSelfTest}=await import('./tools/selftest/ui.selftest.mjs');
const t=__tools;t.assistant.demo=true;
document.getElementById('h-addr').value='';
const {DemoPort}=await import('./app/serial/demo.js');t.assistant.ports=[new DemoPort()];
document.querySelector('#tabs [data-tab=serial]').click();t.assistant.suppManual=false;t.assistant._setSuppressed(false);t.assistant.rxc.reset();
return await runUiSelfTest(t);`);
assert.ok(regular.every(r=>r.ok),JSON.stringify(regular.filter(r=>!r.ok)));
mkdirSync('tmp',{recursive:true});writeFileSync('tmp/serial-display-page-result.json',JSON.stringify({history,burst,sustained,regular},null,2));
console.log(JSON.stringify({history,burst,sustained,regularPassed:regular.length},null,2));
}finally{c.close();await fetch(base+'/json/close/'+p.id).catch(()=>{});}
