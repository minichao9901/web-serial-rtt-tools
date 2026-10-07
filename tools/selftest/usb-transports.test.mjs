import assert from 'node:assert/strict';
import { UsbLease } from '../../app/core/usb-device.js';
import { closeProbeUsbDevices } from '../../app/core/probe-bus.js';
import { WebUsbDapProbe } from '../../app/rtt/dap-webusb.js';
const ep = (endpointNumber, direction) => ({endpointNumber, direction, type:'bulk', packetSize:512});
const iface = (interfaceNumber, endpoints) => ({interfaceNumber, alternates:[{endpoints}]});
export function fakeUsb(){
 const events = []; const device = {vendorId:0xd28,productId:0x204,opened:false,
  configuration:{interfaces:[iface(5,[ep(11,'in'),ep(11,'out')]),iface(0,[ep(1,'in'),ep(2,'out'),ep(3,'in')])]},
  async open(){events.push('open');this.opened=true;},async claimInterface(i){events.push(`claim:${i}`);},
  async releaseInterface(i){events.push(`release:${i}`);},async clearHalt(){},
  async close(){events.push('close');this.opened=false;},async reset(){events.push('reset');},
 };return {device,events};
}
const {device,events}=fakeUsb();
Object.defineProperty(globalThis,'navigator',{value:{usb:{getDevices:async()=>[device]}},configurable:true});
const spi=new UsbLease(device,'spi');await spi.open();await spi.claim(5,[0x8b,11]);
const dap=new WebUsbDapProbe();dap.device=device;dap.resync=async()=>{};
await dap._claim();assert.equal(dap.epIn,1);assert.equal(dap.epOut,2,'DAP must not pick the SPI interface listed first');
dap._ctrl=async()=>{};await dap.disconnect();
assert.ok(device.opened);assert.ok(!events.includes('reset'));assert.ok(!events.includes('close'));
assert.equal(await closeProbeUsbDevices(),0,'legacy cleanup cannot close a live independent endpoint');
await spi.close();assert.equal(events.at(-1),'close');
console.log('usb-transports: DAP disconnect/legacy cleanup preserve independent SPI interface PASS');
const { VendorEpTransport } = await import('../../app/scope/transport.js');
{
 const {device,events}=fakeUsb();const spi=new UsbLease(device,'spi');await spi.open();await spi.claim(5,[0x8b,11]);
 const scope=new VendorEpTransport(device);await scope.open();await scope.close();
 assert.ok(device.opened);assert.ok(!events.includes('close'));assert.ok(!events.includes('reset'));assert.ok(events.includes('release:0'));
 await spi.close();
}
{
 const {device,events}=fakeUsb();const spi=new UsbLease(device,'spi');await spi.open();await spi.claim(5,[0x8b,11]);
 const scope=new VendorEpTransport(device);await scope.open();
 const pending=[];device.transferIn=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const close=device.close;device.close=async function(){await close.call(this);for(const p of pending.splice(0))p.reject(new Error('native handle closed'));};
 await scope.start(()=>{});await scope.stop();
 await assert.rejects(scope.close(),/先断开 spi/);assert.ok(!events.includes('reset'),'dirty scope cannot reset a live SPI stream');
 await spi.close();await scope.close();assert.ok(!events.includes('reset'),'exclusive handle close retires reads without a whole-device reset');
 assert.equal(pending.length,0);assert.equal(events.at(-1),'close');
}
console.log('usb-transports: Scope clean close preserves SPI; dirty close retains lease until exclusive recovery PASS');
const { WebUsbSpiTransport } = await import('../../app/spi/transport.js');
{
 const {device,events}=fakeUsb();const scope=new VendorEpTransport(device);await scope.open();
 const spi=new WebUsbSpiTransport(device);await spi.open();await spi.close();
 assert.ok(device.opened);assert.ok(events.includes('release:5'));assert.ok(!events.includes('close'));
 await scope.close();
}
{
 const {device,events}=fakeUsb();const scope=new VendorEpTransport(device);await scope.open();
 const spi=new WebUsbSpiTransport(device,{outTimeoutMs:5});await spi.open();
 let finish;device.transferOut=()=>new Promise(r=>finish=()=>r({status:'ok',bytesWritten:1}));
 await assert.rejects(spi.sendRaw(Uint8Array.of(1)),/写超时/);
 await assert.rejects(spi.close(),/先断开 scope/);assert.ok(!events.includes('reset'));assert.equal(spi.stalledInFlight,1);
 finish();await new Promise(r=>setImmediate(r));await scope.close();await spi.close();assert.ok(events.includes('reset'));
}
console.log('usb-transports: SPI clean close preserves Scope; timed-out native OUT is tracked and cannot reset Scope PASS');
