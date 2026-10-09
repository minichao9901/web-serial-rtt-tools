import assert from 'node:assert/strict';
import { SerialSession } from '../../app/serial/session.js';
import { createProbeManager } from '../../app/core/probe-users.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fakePort(vendorId=0xd28){
 const events=[],port={getInfo:()=>({usbVendorId:vendorId,usbProductId:0x204}),
  async open(opts){ this.openOptions=opts;events.push('open');this.readable=new ReadableStream();this.writable=new WritableStream({write:async b=>events.push(`tx:${b[0]}`)});},
  async setSignals(){},async close(){events.push('close');this.readable=null;this.writable=null;}};
 return {port,events};
}
const session=new SerialSession(),{port,events}=fakePort();
const hid={last:{running:false},_bridgeRequested:false,async stop(){this.last.running=false;this._bridgeRequested=false;}};
const scope={running:false}; const tools={session,hid,scope};const manager=createProbeManager(tools,{locks:null});session.probeManager=manager;
await session.open(port,{owner:'assistant'});assert.equal(port.openOptions.bufferSize,4096);assert.deepEqual(manager.summary().owners,['serial']);
await session.write(Uint8Array.of(1));assert.ok(events.includes('tx:1'));
await manager.run('hid',async()=>{hid._bridgeRequested=true;await manager.cdcMode.drainWrites();hid.last.running=true;});
assert.equal(manager.summary().cdc.mode,'rtt');assert.equal(events.filter(x=>x==='open').length,1,'RTT changes producer without reopening the shared receiver');
await assert.rejects(session.write(Uint8Array.of(2)),/RTT 转发/);
await session.open(port,{owner:'assistant'});assert.equal(hid.last.running,false,'explicit UART connection stops the bridge');assert.equal(manager.summary().cdc.mode,'uart');
await assert.rejects(manager.run('scope',()=>assert.fail(),{resources:['cdc-port'],rejectResources:['cdc-port']}),/CDC/);
assert.ok(session.isOpen,'CDC_OFF rejection preserves the live serial receiver');
await session.close();
await manager.run('scope',async()=>{scope.running=true;scope._cdcPausedRequested=true;},{resources:['cdc-port']});
await assert.rejects(session.open(port,{owner:'rtt'}),/CDC/);assert.ok(scope.running);
manager.fail('scope',new Error('STOP unknown'));
await assert.rejects(session.open(port,{owner:'rtt'}),/释放尚未确认/);
scope._cdcPausedRequested=false;manager.confirm('scope');manager.narrow('scope');
await session.open(port,{owner:'rtt'});assert.equal(port.openOptions.bufferSize,65536);assert.ok(session.isOpen,'confirmed STOP releases only the optional CDC pause resource');
assert.deepEqual(manager.summary().owners,['scope','serial']);await session.close();manager.forget('scope');
// An unrelated USB-UART adapter does not participate in probe arbitration.
const other=fakePort(0x1234);scope.running=true;scope._cdcPausedRequested=true;
await session.open(other.port,{owner:'assistant'});await session.write(Uint8Array.of(3));assert.deepEqual(manager.summary().owners,[]);await session.close();
// Closing while the native open is pending cancels setup and closes the eventual handle.
let finish;const delayed=fakePort();const originalOpen=delayed.port.open;
delayed.port.open=async function(){await new Promise(r=>finish=r);await originalOpen.call(this);};
scope.running=false;scope._cdcPausedRequested=false;
const opening=session.open(delayed.port,{owner:'rtt'});const rejected=assert.rejects(opening,/已取消/);await tick();const closing=session.close();finish();await Promise.all([closing,rejected]);
assert.equal(session.isOpen,false);assert.deepEqual(delayed.events,['open','close']);assert.deepEqual(manager.summary().owners,[]);
console.log('cdc-mode: shared receiver/source handoff, UART TX guard, optional pause ownership, unrelated ports, cancelled native open PASS');
