import assert from 'node:assert/strict';
import { createProbeManager } from '../../app/core/probe-users.js';
import { DbgView } from '../../app/dbg/view.js';
import { FlashView } from '../../app/flash/view.js';
import { ScopeView } from '../../app/scope/view.js';
import { RttCdcView } from '../../app/hid/view.js';
import { I2cSession } from '../../app/i2c/session.js';
import { SpiSession } from '../../app/spi/session.js';

const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
const nodes = new Map();
globalThis.document = { getElementById: id => {
  if (id === 'toasts') return null;
  if (!nodes.has(id)) nodes.set(id, { value: id === 'd-backend' ? 'webusb' : '', textContent: '' });
  return nodes.get(id);
} };
globalThis.window = {};
const events = [];
const scope = Object.create(ScopeView.prototype);
Object.assign(scope, {
  selected: [{ addr: 0x20000000 }], usingMock: false, running: false,
  syncButtons(){}, setStatusText(){}, _stopWatchdog(){},
  _stopData: async function(){ events.push('scope:STOP'); this.transport.running = false; },
});
let setup = gate();
scope._startOnce = async function(){
  events.push('scope:setup'); await setup.promise;
  this._startTouched = true; this.running = true;
  this.hid = { close: async () => events.push('scope:HID-close') };
  this.transport = { running: true, close: async () => events.push('scope:USB-close') };
};
const dbg = Object.create(DbgView.prototype);
Object.assign(dbg, { session: { connected: false }, _out(){}, _disconnectNow: async () => { dbg.session.connected = false; events.push('dbg:close'); } });
dbg._connectNow = async () => { events.push('dbg:setup'); dbg.session.connected = true; };
const flash = Object.create(FlashView.prototype); Object.assign(flash, { busy: false, file: { name: 'fw.bin' } });
const hid = Object.create(RttCdcView.prototype); Object.assign(hid, { mock: null, last: { running: false }, render(){}, dev: { stop: () => assert.fail('queued bridge never acquired the engine') } });
hid._startBridgeNow = () => assert.fail('queued bridge START must be cancelled');
const i2c = new I2cSession();
i2c._connectNow = async () => { i2c.hid = { connected: true }; events.push('i2c:setup'); return true; };
i2c._disconnectNow = async () => { i2c.hid = null; events.push('i2c:close'); };
const spi = new SpiSession();
spi._connectHidNow = async () => { spi.hid = { connected: true }; events.push('spi:setup'); return true; };
spi._teardownNow = async () => { spi.hid = null; events.push('spi:close'); };
const tools = { scope, dbg, flash, hid, i2c: { session: i2c }, spiSession: spi };
let handshakes = 0;
const manager = createProbeManager(tools, { locks: null, bus: { supported: true, requestRelease: async () => { handshakes++; } } });
tools.probeManager = manager; window.__tools = tools;
for (const v of [scope, dbg, flash, hid, i2c, spi]) v.probeManager = manager;

const capture = scope.start(), debug = dbg.connect();
await tick(); assert.deepEqual(events, ['scope:setup']);
setup.resolve(); await Promise.all([capture, debug]);
assert.deepEqual(events, ['scope:setup', 'scope:STOP', 'scope:USB-close', 'scope:HID-close', 'dbg:setup']);
assert.deepEqual(manager.summary().owners, ['dbg']);

await i2c.connect(false); assert.deepEqual(manager.summary().owners, ['dbg', 'i2c']);
assert.equal(handshakes, 2, 'compatible local client does not ask other tabs to release this page');
await dbg.disconnect();
setup = gate(); setup.resolve(); await scope.start();
assert.deepEqual(manager.summary().owners, ['i2c', 'scope']);

// Pending control work does not stop an independent live stream.
const held = gate();
const control = manager.run('i2c', () => held.promise);
const bridge = hid.start(); const cancelledBridge = hid.stop();
const cancelledBridgeResult = await Promise.all([bridge, cancelledBridge]);
assert.ok(cancelledBridgeResult);
assert.equal(scope.running, true, 'cancelled pending bridge sends no STOP to the running sampler');
assert.equal(scope.transport.running, true, 'control queue does not quiesce an independent live stream');
held.resolve(); await control;

const burning = gate(); flash._flashOnce = async () => { events.push('flash:write'); await burning.promise; };
const burn = flash.flash();
await tick(); assert.equal(scope.running, false); assert.equal(i2c.connected, true, 'independent I2C stays connected during target flash');
assert.equal(events.at(-1), 'flash:write');
assert.equal(await dbg.connect(), false, 'flash reservation rejects competing acquisition');
burning.resolve(); await burn; assert.equal(flash.busy, false);
assert.deepEqual(manager.summary().owners, ['i2c']);

await spi.connectHid(false);
assert.deepEqual(manager.summary().owners, ['spi']);
await i2c.connect(false);
assert.equal(spi.connected, false, 'SPI auxiliary pads may overlap I2C pins, so the bridge is released');
await manager.releaseOthers(null);
assert.deepEqual(manager.summary().owners, []);
console.log('probe-integration: real entry points serialize setup, coexist on disjoint resources, cancel queued START and protect flash PASS');

// Failed scope STOP stays reserved, including after its USB/HID handles have been closed.
scope._stopUnconfirmed = true;
manager.fail('scope', new Error('HID STOP unavailable'));
await assert.rejects(manager.run('dbg', () => assert.fail()), /释放尚未确认/);
await assert.rejects(scope.stop(), /先重新连接探针/);
await assert.rejects(manager.run('dbg', () => assert.fail()), /释放尚未确认/);
manager.confirm('scope'); manager.forget('scope');
console.log('probe-integration: unknown firmware stop cannot be bypassed by a later feature PASS');

scope._stopUnconfirmed = false;
const closing = gate();
scope.transport = { running: false, close: async () => { events.push('scope:closing'); await closing.promise; } };
scope.hid = { close: async () => events.push('scope:closed') };
await manager.run('scope', async () => {});
const manualRelease = scope.releaseProbe('手动断开');
const handoffDuringClose = dbg.connect();
await tick(); assert.equal(dbg.session.connected, false);
assert.equal(events.at(-1), 'scope:closing');
closing.resolve(); await Promise.all([manualRelease, handoffDuringClose]);
assert.equal(dbg.session.connected, true);
assert.deepEqual(events.slice(-3), ['scope:closing', 'scope:closed', 'dbg:setup']);
await dbg.disconnect();
console.log('probe-integration: manual release and managed takeover share one complete USB close PASS');

const pendingBridge = Object.create(RttCdcView.prototype);
const bridgeEvents = [];
Object.assign(pendingBridge, {
  mock: null, last: { running: false }, render(){}, persist(){}, params: () => ({}), _ensure: async () => true,
  _settle: async function(){ this.last = { running: false, startRc: -100 }; },
  dev: {
    start: async () => ({ rc: 0 }),
    stop: async () => { bridgeEvents.push('STOP'); return { rc: 0, status: { running: false, startRc: -100 } }; },
    status: async () => { bridgeEvents.push('STOP-confirmed'); return { status: { running: false, startRc: 0 } }; },
    close: async () => {},
  },
});
const bridgeTools = { hid: pendingBridge };
const bridgeManager = createProbeManager(bridgeTools, { locks: null });
pendingBridge.probeManager = bridgeManager;
await pendingBridge.start();
assert.deepEqual(bridgeManager.summary().owners, ['hid'], 'queued firmware START retains ownership after the host settle deadline');
await bridgeManager.run('dbg', async () => bridgeEvents.push('dbg:open'));
assert.deepEqual(bridgeEvents, ['STOP', 'STOP-confirmed', 'dbg:open']);
console.log('probe-integration: firmware START pending retains ownership until STOP completion is confirmed PASS');

const switching = gate(); let openedAfterCancel = 0;
const cancelledDbg = Object.create(DbgView.prototype);
Object.assign(cancelledDbg, {
  session: { connected: false, exclusive: async fn => fn(), connect: async () => { openedAfterCancel++; } },
  _out(){}, _ensureSession: () => switching.promise, _disconnectNow: async () => {},
});
const switchingConnect = cancelledDbg.connect(); await tick();
await cancelledDbg.disconnect(); switching.resolve();
assert.equal(await switchingConnect, false); assert.equal(openedAfterCancel, 0);
console.log('probe-integration: cancelling during backend preparation cannot create a later debug session PASS');
