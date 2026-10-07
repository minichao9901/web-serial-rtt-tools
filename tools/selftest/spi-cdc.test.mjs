import assert from 'node:assert/strict';
import {CMD,ACT,MAGIC,startData,decodeReply} from '../../app/spi-cdc/protocol.js';
import {SpiCdcSession} from '../../app/spi-cdc/session.js';
import {SerialSession} from '../../app/serial/session.js';
import {createProbeManager} from '../../app/core/probe-users.js';
const tick=()=>new Promise(r=>setImmediate(r));
function reply(action,{running=false,pending=false,rc=0,generation=0,config=0}={}){
  const p=new Uint8Array(63);p.set([54,CMD,action]);
  const d=new DataView(p.buffer,3);[MAGIC,1|(+running<<1)|(+pending<<2),rc,config,16384,0xffffffff,0xfffffffe,1,2,1,4,generation,3].forEach((v,i)=>d.setUint32(i*4,v,true));return p;
}
const bytes=reply(0,{rc:-100,pending:true,generation:3,config:258});
const offset=new Uint8Array(80);offset.set(bytes,7);
assert.deepEqual(decodeReply(offset.subarray(7,70)),{supported:true,running:false,pending:true,rc:-100,mode:2,lsb:true,bufferBytes:16384,received:0xffffffff,forwarded:0xfffffffe,dropped:1,fifoOverflows:2,pendingBytes:1,cdcQueued:4,generation:3,dmaErrors:3});
for(const bad of [bytes.slice(0,54),new Uint8Array(63),Uint8Array.from(bytes,(b,i)=>i===0?10:b),Uint8Array.from(bytes,(b,i)=>i===2?1:b)])assert.throws(()=>decodeReply(bad));
for(const mode of [0,1,2,3])assert.deepEqual([...startData({mode,lsb:true})],[1,mode,1]);
for(const config of [{mode:4},{mode:-1},{mode:1.5},{lsb:1}])assert.throws(()=>startData(config));
function fixture(){
  const events=[],state={running:false,pending:false,rc:0,generation:0,config:0};
  const h={connected:false,label:'fixture',async request(){this.connected=true;},async reconnect(){this.connected=true;},async close(){events.push('close');this.connected=false;},async xfer(cmd,data){
    assert.equal(cmd,CMD);const a=data[0];events.push(a);
    if(a===ACT.START){state.pending=true;state.rc=-100;state.generation++;state.config=data[1]|data[2]<<8;}
    if(a===ACT.STOP){state.pending=true;state.rc=-100;state.stop=true;}
    if(a===ACT.STATUS&&state.pending){state.pending=false;state.running=!state.stop;state.stop=false;state.rc=0;}
    return reply(a,state);
  }};
  const s=new SpiCdcSession({hidFactory:()=>h,wait:async()=>{}});return {s,h,state,events};
}
{
  const {s,h,state,events}=fixture();await s.connect(false);await s.start({mode:3,lsb:true});assert.ok(s.running);assert.equal(state.config,259);
  await s.stop();assert.ok(!s.running);await s.start();await s.disconnect();assert.ok(!h.connected);assert.ok(!s.running);assert.equal(events.at(-1),'close');
}
// A failed STOP retains the source claim, forbids takeover, and can be recovered.
{
  const {s,h}=fixture();const tools={spiCdc:{session:s},spiSession:{connected:false,async teardown(){}}};const m=createProbeManager(tools,{locks:null});s.probeManager=m;
  await s.connect();await s.start();const xfer=h.xfer.bind(h);h.xfer=async(c,d)=>{if(d[0]===ACT.STOP)throw Error('STOP timeout');return xfer(c,d);};
  await assert.rejects(s.stop(),/STOP timeout/);assert.ok(s.running);assert.ok(m.failures.has('spicdc'));
  await assert.rejects(m.run('spi',()=>assert.fail()),/释放尚未确认/);
  h.xfer=xfer;await s.disconnect();assert.deepEqual(m.summary().owners,[]);
}
// A native connect arriving after cancellation must close rather than retain HID.
{
  const {s,h}=fixture();let finish;h.request=async()=>{await new Promise(r=>finish=r);h.connected=true;};
  const m=createProbeManager({spiCdc:{session:s}},{locks:null});s.probeManager=m;
  const opening=s.connect();await tick();const closing=s.disconnect();finish();await Promise.all([opening,closing]);
  assert.ok(!h.connected);assert.deepEqual(m.summary().owners,[]);
}
// STOP must drain a START whose HID reply has not arrived yet.
{
  const {s,h}=fixture();const m=createProbeManager({spiCdc:{session:s}},{locks:null});s.probeManager=m;await s.connect();
  const xfer=h.xfer.bind(h);let finish;h.xfer=async(c,d)=>{if(d[0]===ACT.START)await new Promise(r=>finish=r);return xfer(c,d);};
  const starting=s.start();await tick();const closing=s.disconnect();finish();await Promise.all([starting,closing]);
  assert.ok(!s.running);assert.ok(!h.connected);assert.deepEqual(m.summary().owners,[]);
}
// Source changes retain the native CDC receiver. SPI also coexists with SWD.
{
  const {s}=fixture(),serial=new SerialSession(),events=[];
  const port={getInfo:()=>({usbVendorId:0xd28,usbProductId:0x204}),async open(){events.push('open');this.readable=new ReadableStream();this.writable=new WritableStream();},async setSignals(){},async close(){events.push('close');}};
  const hid={last:{running:false},async stop(){this.last.running=false;}};
  const dbg={session:{connected:false},async disconnect(){this.session.connected=false;}};
  const spiSession={connected:false,async teardown(){this.connected=false;}};
  const tools={spiCdc:{session:s},session:serial,hid,dbg,spiSession};const m=createProbeManager(tools,{locks:null});serial.probeManager=s.probeManager=m;
  await s.connect();await s.start();await serial.open(port,{owner:'spi-cdc'});assert.ok(s.running);assert.equal(m.summary().cdc.mode,'spi');
  await assert.rejects(serial.write(Uint8Array.of(1)),/SPI 转发/);
  await m.run('dbg',async()=>{dbg.session.connected=true;});assert.ok(s.running);assert.ok(dbg.session.connected);
  await m.run('hid',async()=>{hid.last.running=true;});assert.ok(!s.running);assert.ok(serial.isOpen);assert.ok(!dbg.session.connected);assert.equal(m.summary().cdc.mode,'rtt');
  await s.connect();await s.start();assert.ok(!hid.last.running);assert.ok(serial.isOpen);assert.deepEqual(events,['open']);
  await m.run('dbg',async()=>{dbg.session.connected=true;});assert.ok(s.running);
  await m.run('spi',async()=>{spiSession.connected=true;});assert.ok(!s.running);assert.ok(serial.isOpen);assert.ok(dbg.session.connected);
  await serial.close();assert.deepEqual(events,['open','close']);
}
console.log('SPI CDC: protocol bounds, signed status, deferred START/STOP, failed-stop fencing, late connect cancellation, shared receiver handoff and SWD coexistence PASS');
