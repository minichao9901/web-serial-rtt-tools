import assert from 'node:assert/strict';
import {RttCdcView} from '../../app/hid/view.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
globalThis.document={getElementById:()=>null};globalThis.window={};
const wait=gate(),events=[];let starts=0,status=0;
const v=Object.create(RttCdcView.prototype);Object.assign(v,{_ensure:()=>wait.promise,params:()=>({}),persist(){},render(){},dev:{stop:async()=>{events.push('stop');return {rc:0,status:{running:true}};},status:async()=>{status++;return {status:{running:false}};},start:async()=>{starts++;}}});
const start=v.start();await v.start();const stop=v.stop();await tick();assert.deepEqual(events,[]);wait.resolve(true);await Promise.all([start,stop]);
assert.equal(starts,0);assert.deepEqual(events,['stop']);assert.equal(status,1);assert.equal(v.last.running,false);
v.dev.stop=async()=>{throw new Error('link failed');};await assert.rejects(v.stop(),/link failed/);assert.equal(v._stopPromise,null);
console.log('rtt-cdc-lifecycle: stop cancels pending start, waits for firmware STOP completion, propagates failure PASS');

{
  const events = [];
  let connected = true;
  const v = Object.create(RttCdcView.prototype);
  const leases = new Map([['hid', {}]]);
  Object.assign(v, {
    dev: { get connected(){ return connected; }, async close(){ events.push('close'); connected = false; } },
    mock: null, info: { fw: 'test' }, last: { running: true }, _bridgeRequested: true,
    _starting: false, _setResetIoUi(){}, render(){},
    stop: async options => {
      events.push(`stop:${!!options?.fromManager}`); v.last = { running: false }; v._bridgeRequested = false;
      leases.delete('hid'); events.push('forget:hid');
    },
    probeManager: { leases, failures: new Map(), forget(owner){ events.push(`forget:${owner}`); leases.delete(owner); } },
  });
  assert.equal(await v.disconnect(), true);
  assert.deepEqual(events, ['stop:false', 'forget:hid', 'close'], 'stop the probe-side RTT engine before closing HID');
  assert.equal(v.info, null); assert.equal(v.last, null); assert.equal(v.dev.connected, false);
  assert.equal(v._disconnecting, false); assert.equal(v._disconnectPromise, null);
}
{
  const events = [];
  const v = Object.create(RttCdcView.prototype);
  Object.assign(v, {
    dev: { connected: true, async close(){ events.push('close'); } },
    mock: null, last: { running: true }, _bridgeRequested: true,
    _setResetIoUi(){}, render(){},
    stop: async () => { events.push('stop'); throw new Error('STOP not confirmed'); },
    probeManager: { leases: new Map([['hid', {}]]), failures: new Map(), forget(){ events.push('forget'); } },
  });
  assert.equal(await v.disconnect(), false);
  assert.deepEqual(events, ['stop'], 'keep HID open when the probe did not confirm STOP');
  assert.equal(v.last.running, true); assert.equal(v._disconnecting, false);
}
console.log('rtt-cdc-lifecycle: close stops active bridge first, releases HID, and retains it when STOP is unconfirmed PASS');
