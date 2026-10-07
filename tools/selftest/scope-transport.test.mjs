import assert from 'node:assert/strict';
import { VendorEpTransport } from '../../app/scope/transport.js';
const tick = () => new Promise(r => setImmediate(r));
const packet = value => ({ status: 'ok', data: new DataView(Uint8Array.of(value).buffer) });
class USB {
  pending = []; calls = 0; halts = 0;
  transferIn(){ this.calls++; return new Promise((resolve, reject) => this.pending.push({ resolve, reject })); }
  clearHalt(){ this.halts++; return Promise.resolve(); }
  resolve(value){ this.pending.shift().resolve(value); }
  reject(){ this.pending.shift().reject(new Error('disconnected')); }
  drain(){ for (const p of this.pending.splice(0)) p.resolve(packet(0)); }
}
{
  const t = new VendorEpTransport(new USB());
  t.configureReadAhead(2.06e6); assert.equal(t.inFlight,6); assert.equal(t.chunkBytes,8192);
  t.configureReadAhead(1e4); assert.equal(t.inFlight,3); assert.equal(t.chunkBytes,4096);
  t.running=true; assert.throws(()=>t.configureReadAhead(2e6));
  const custom=new VendorEpTransport(new USB(),{inFlight:2,chunkBytes:512});
  custom.configureReadAhead(2e6);assert.equal(custom.inFlight,2);assert.equal(custom.chunkBytes,512);
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 3 }), seen = [];
  await t.start(b => seen.push(b[0]));
  const second = usb.pending.splice(1, 1)[0];
  second.resolve(packet(2)); await tick();
  assert.deepEqual(seen, [], 'later native completion cannot overtake the first submitted read');
  assert.equal(usb.calls, 3, 'a slow head cannot cause an unbounded rearm queue');
  usb.resolve(packet(1)); await tick();
  assert.deepEqual(seen, [1, 2], 'callbacks preserve stream order under reversed promise completion');
  const stop = t.stop(); usb.drain(); await stop;
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 3 });
  const seen = [];
  await t.start(bytes => {
    assert.equal(usb.pending.length, 3, 'rearm precedes decoding, bounded outstanding reads');
    seen.push(bytes[0]);
  });
  assert.equal(usb.pending.length, 3);
  usb.resolve(packet(1)); await tick();
  usb.resolve(packet(2)); await tick();
  assert.deepEqual(seen, [1, 2]);
  const stop = t.stop(); usb.drain(); await stop;
  assert.deepEqual(seen, [1, 2], 'stale reads are drained without callbacks');
  assert.equal(t.stalledInFlight, 0);
  assert.equal(usb.calls, 5);
  await t.start(b => seen.push(b[0])); usb.resolve(packet(3)); await tick();
  const secondStop = t.stop(); usb.drain(); await secondStop;
  assert.deepEqual(seen, [1, 2, 3]);
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 1 });
  const errors = [];
  await t.start(() => { throw new Error('decode'); }, e => errors.push(e.message));
  usb.resolve(packet(1)); await tick();
  assert.equal(t.running, false); assert.equal(errors.length, 1);
  assert.equal(usb.pending.length, 1, 'callback error still tracks rearmed request');
  const stop = t.stop(); usb.reject(); await stop;
  assert.equal(t.stalledInFlight, 0);
}
{
  const usb = new USB(), t = new VendorEpTransport(usb, { inFlight: 1 });
  const seen = [], errors = [];
  await t.start(b => seen.push(b[0]), e => errors.push(e.message));
  usb.resolve({ status: 'stall' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(usb.halts, 1); assert.equal(usb.pending.length, 1);
  usb.resolve(packet(4)); await tick(); assert.deepEqual(seen, [4]);
  usb.reject(); await tick(); assert.equal(t.running, false); assert.equal(errors.length, 1);
  await t.stop();
}
console.log('scope-transport: rearm, ordering, bounded reads, stop/restart, decoder error, stall, disconnect PASS');
{
 const usb=new USB();let resets=0;
 usb.reset=async()=>{resets++;usb.drain();};usb.close=async()=>{};
 const t=new VendorEpTransport(usb,{inFlight:1}),seen=[];t.open=async()=>t;
 await t.start(b=>seen.push(b[0]));await t.stop();assert.equal(t.stalledInFlight,1);
 await t.start(b=>seen.push(b[0]));assert.equal(resets,1);assert.equal(usb.pending.length,1,'old native read retired before new request');
 usb.resolve(packet(9));await tick();assert.deepEqual(seen,[9],'new session first packet delivered');
 const stop=t.stop();usb.drain();await stop;
}
{
 const usb=new USB();let resets=0,closes=0,reopens=0;
 const t=new VendorEpTransport(usb,{inFlight:1});
 t._usb.reset=async()=>{resets++;throw new Error("Failed to execute 'reset' on 'USBDevice': Unable to reset the device.")};
 t._usb.close=async({dirty}={})=>{assert.equal(dirty,false);closes++;usb.drain()};
 t.open=async()=>{reopens++;return t};
 await t.start(()=>{});await t.stop();assert.equal(t.stalledInFlight,1);
 await t.start(()=>{});
 assert.equal(resets,1);assert.equal(closes,1);assert.equal(reopens,1);
 assert.equal(usb.pending.length,1,'close/reopen retires the previous read before submitting a new one');
 usb.resolve(packet(9));await tick();
 const stop=t.stop();usb.drain();await stop;
}
console.log('scope-transport: stalled restart resets/retire reads; native reset failure recovers by close/reopen PASS');
{
 const usb=new USB();usb.close=async()=>{};usb.reset=async()=>usb.drain();
 const old=new VendorEpTransport(usb,{inFlight:1});await old.start(()=>{});await old.stop();
 const replacement=new VendorEpTransport(usb,{inFlight:1});replacement.open=async()=>replacement;
 const seen=[];await replacement.start(b=>seen.push(b[0]));assert.equal(usb.pending.length,1,'replacement waits for old transport native reads');
 usb.resolve(packet(10));await tick();assert.deepEqual(seen,[10]);const stop=replacement.stop();usb.drain();await stop;
}
console.log('scope-transport: replacing transport cannot orphan native reads on the same device PASS');
{
 const usb=new USB();let resets=0;usb.reset=async()=>{resets++;usb.drain();};usb.close=async()=>{};
 const t=new VendorEpTransport(usb,{inFlight:3});t.open=async()=>t;await t.start(()=>{});
 const quiesce=t.quiesce();usb.drain();await quiesce;assert.equal(usb.calls,3,'quiescing never rearms reads');await t.stop();assert.equal(t.stalledInFlight,0);
 await t.start(()=>{});assert.equal(resets,0,'ordinary capture restart needs no USB reset');const stop=t.stop();usb.drain();await stop;
}
console.log('scope-transport: quiesce drains producer-completed reads without rearming or resetting normal captures PASS');
