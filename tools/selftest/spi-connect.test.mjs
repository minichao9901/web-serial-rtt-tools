/** SPI 连接入口：授权选择、共享会话关闭及失败重试，不使用实物探针。 */
import assert from 'node:assert/strict';
import { AkaLinkHid, VID, PID, USAGE_PAGE } from '../../app/hid/probe.js';
import { SpiSession } from '../../app/spi/session.js';

const probe = name => ({ productName: name, vendorId: VID, productId: PID,
  collections: [{ usagePage: USAGE_PAGE }], opened: false });
const a = probe('A'), b = probe('B');
let authorized = [], selected = a, prompts = 0;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hid: {
  getDevices: async () => authorized,
  requestDevice: async ({ filters }) => {
    assert.deepEqual(filters, [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE }]);
    prompts++; return selected ? [selected] : [];
  },
} } });
globalThis.document = { hidden: false };
AkaLinkHid.prototype.open = async function(device){ this.device = device; device.opened = true; };
AkaLinkHid.prototype.close = async function(){ this.device.opened = false; this.device = null; };
function fixture(){
  const s = new SpiSession();
  s.loadCfg = s.loadProfile = s.pollStatus = async () => {};
  s.ensurePoll = () => {};
  s._disableBridge = async () => {};
  return s;
}
const connect = async (devices, interactive, expected, expectedPrompts) => {
  authorized = devices; prompts = 0;
  const s = fixture();
  assert.equal(await s.connectHid(interactive), true);
  assert.equal(s.hid.device, expected);
  assert.equal(prompts, expectedPrompts);
  await s.disconnect();
};
const otherHid = { ...probe('其它厂商 HID'), vendorId: 0x06cb };
await connect([otherHid, a], undefined, a, 0);
await connect([], undefined, a, 1);
await connect([otherHid], undefined, a, 1);
selected = b;
await connect([a, b], undefined, b, 1);
await connect([a], true, b, 1);
await connect([a], false, a, 0);
console.log('PASS: 唯一授权设备自动连接；首次、多设备、其它 HID、手动选择及旧授权接口');

{
  authorized = [a]; prompts = 0;
  const s = fixture();
  await s.connectHid();
  const hid = s.hid;
  assert.equal(await s.connectHid(true), true);
  assert.equal(s.hid, hid);
  assert.equal(prompts, 0, '已连接时不更换 HID');
  const events = [];
  s.transport = { stop: async () => events.push('stop'), close: async () => events.push('USB close') };
  s._disableBridge = async () => events.push('disable');
  hid.close = async () => events.push('HID close');
  assert.equal(await s.disconnect(), true);
  assert.deepEqual(events, ['stop', 'disable', 'USB close', 'HID close']);
  assert.equal(s.connected, false); assert.equal(s.dataReady, false); assert.equal(s.busy, false);
}
{
  const s = fixture(); let fail = true;
  const hid = { connected: true, close: async () => { if (fail) throw new Error('关闭失败'); } };
  s.hid = hid;
  assert.equal(await s.disconnect(), false);
  assert.equal(s.hid, hid); assert.equal(s.busy, false); assert.equal(s.stateKind, 'err');
  fail = false;
  assert.equal(await s.disconnect(), true); assert.equal(s.hid, null); assert.equal(s.stateKind, '');
  s.hid = hid; s.setBusy(true);
  assert.equal(await s.disconnect(), false); assert.equal(s.hid, hid);
  s.setBusy(false); await s.disconnect();
}
console.log('PASS: 共享连接依序关闭；关闭失败保留句柄并允许重试；传输中拒绝关闭');
