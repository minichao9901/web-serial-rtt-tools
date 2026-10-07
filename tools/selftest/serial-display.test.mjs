import assert from 'node:assert/strict';
import {RxBuffer} from '../../app/core/rxview.js';
import {AnsiDisplay, BurstGuard, terminalBytes} from '../../app/core/display-stream.js';
import {SerialSession} from '../../app/serial/session.js';

// 确定性测试显示预算；真实布局与突发流量另由 serial-display-page 覆盖。
globalThis.setInterval = () => 0;
const element = () => ({ children: [], textContent: '', scrollTop: 0, scrollHeight: 10,
  appendChild(n){ this.children.push(n); n.remove = () => { this.children.splice(this.children.indexOf(n), 1); }; } });
globalThis.document = { createTextNode: text => ({textContent: text}) };
const enc = new TextEncoder();
const el = element(), rx = new RxBuffer(el);let scrolls=0;
rx._scroll=()=>scrolls++;
const line=enc.encode('trace: abcdefghijklmnopqrstuvwxyz\n');
for(let i=0;i<20000;i++)rx._store(line,new Date());
assert.ok(rx.raw.length<=8192);assert.ok(rx.bytes<=rx.maxRaw);assert.equal(rx.truncated,true);
rx.repaint();assert.equal(scrolls,1);assert.equal(rx.nodes.length,1);assert.ok(rx.lines<=rx.maxLines);
assert.ok(rx.text().length>el.children[0].textContent.length,'保存缓冲独立于显示窗口');
rx.clear();scrolls=0;const chinese=enc.encode('中文\n');
rx.push(chinese.subarray(0,2));rx.push(chinese.subarray(2));rx.flush();
assert.equal(el.children[0].textContent,'中文\n');assert.equal(scrolls,1);
rx.setPaused(true);rx.push(enc.encode('paused\n'));const before=el.children[0].textContent;
rx.repaint();assert.equal(el.children[0].textContent,before);rx.setPaused(false);
assert.ok(el.children[0].textContent.endsWith('paused\n'));
rx.clear();scrolls=0;let visible=false;rx.isVisible=()=>visible;
rx.push(enc.encode('hidden\n'));rx.flush();assert.equal(scrolls,0);assert.equal(rx.bytes,7);
visible=true;rx.flush();assert.equal(scrolls,1);assert.equal(el.children[0].textContent,'hidden\n');
rx.setDisplayOff(true);rx.push(enc.encode('skip'));rx.setPaused(true);rx.setDisplayOff(false);
assert.equal(rx.suppressedBytes,0);rx.setPaused(false);assert.ok(el.children[0].textContent.includes('省略了'));
rx.clear();rx.maxDisplay=1024;rx.push(enc.encode('a'.repeat(200000)));rx.flush();
assert.ok(el.children[0].textContent.length<=1024);assert.equal(rx.bytes,200000);

let shown=false;const writes=[],callbacks=[];
const term={write(b,cb){writes.push(b);callbacks.push(cb);}};
const q=new AnsiDisplay(term,{visible:()=>shown});
for(let i=0;i<5000;i++)q.push(enc.encode('x'.repeat(1024)));
assert.ok(q.bytes<=65536);assert.ok(q.pending.length<=1024);q.flush();assert.equal(writes.length,0);
shown=true;q.flush();assert.equal(writes.length,1);assert.ok(writes[0].length<17000);
q.flush();assert.equal(writes.length,1,'尚未完成 xterm 写入时不能继续排队');
callbacks.shift()();q.flush();assert.equal(writes.length,2);let clears=0;term.clear=()=>clears++;
q.clear();assert.equal(clears,0);callbacks.shift()();assert.equal(clears,1,'清空必须覆盖已在解析的旧批次');q.flush();assert.equal(writes.length,2);
const state={lastWasCR:false};
assert.equal(new TextDecoder().decode(terminalBytes(enc.encode('a\r'),state)),'a\r');
assert.equal(new TextDecoder().decode(terminalBytes(enc.encode('\nb\n'),state)),'\nb\r\n');
const burst=new BurstGuard();assert.equal(burst.add(4096,0),false);assert.equal(burst.add(8192,10),true);
assert.equal(burst.add(100,200),false);
// 关闭的 readable 暂时尚未更新时，read loop 必须让浏览器任务获得执行机会。
const serial=new SerialSession();serial.isOpen=true;let closedReads=0;
const readable={getReader:()=>({read:async()=>{closedReads++;return {done:true};},releaseLock(){}})};
serial.port={readable,close:async()=>{}};
setTimeout(()=>{serial.port.readable=null;},0);
await serial._readLoop();assert.ok(closedReads>0);assert.ok(closedReads<1000);
console.log('serial-display: bounded history, one scroll, UTF-8, pause/hidden recovery, ANSI backpressure and burst gate PASS');
