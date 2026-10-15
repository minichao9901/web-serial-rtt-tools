import assert from 'node:assert/strict';
import { SramBenchTransfer } from '../../app/flash/sram-transfer.js';

function probe({packet=512,depth=4,fault}={}){
  const memory=new Map(),pending=[];let packets=0,reset=0;
  const respond=frame=>{
    packets++;
    assert.equal(frame[0],127);assert.equal(frame[1],2);
    assert.deepEqual([...frame.subarray(2,6)],[5,0,1,5]);
    const dv=new DataView(frame.buffer,frame.byteOffset,frame.byteLength);
    const addr=dv.getUint32(6,true),words=dv.getUint16(12,true),read=frame[14]===15;
    assert.ok((addr&1023)+words*4<=1024,'each packet must respect the TAR wrap boundary');
    assert.ok(frame.length<=packet);
    assert.equal(frame.length,15+(read?0:words*4));
    const res=new Uint8Array(9+(read?words*4:0));res.set([127,2,5,1,1,6,words&255,words>>>8,1]);
    for(let i=0;i<words*4;i++){
      if(read)res[9+i]=memory.get(addr+i)??0;
      else memory.set(addr+i,frame[15+i]);
    }
    if(fault==='count')res[6]--;
    if(fault==='ack')res[8]=4;
    if(fault==='echo')res[0]=5;
    if(fault==='address-protocol')res[4]=8;
    if(fault==='address-zero')res[4]=0;
    return fault==='short'?res.subarray(0,8):res;
  };
  const p={pkt:packet,_framing:'short',epOut:1,epIn:129,
    async info(id){return Uint8Array.of(id===0xf0?16:depth);},
    async flushWrites(){},async _withLock(fn){return await fn();},
    async _ctrl(cmd,req){assert.equal(cmd,127);return respond(Uint8Array.of(cmd,...req)).subarray(1);},
    async _onXferTimeout(){reset++;},
    device:{
      async transferOut(_ep,frame){pending.push(respond(frame));return{status:fault==='stall'?'stall':'ok'};},
      async transferIn(){const b=pending.shift();assert.ok(b,'IN must follow its OUT in FIFO order');return{status:'ok',data:new DataView(b.buffer,b.byteOffset,b.byteLength)};},
    },
    get packets(){return packets;},get resets(){return reset;},
  };return p;
}
for(const packet of [64,512])for(const depth of [1,4]){
  const p=probe({packet,depth}),t=await SramBenchTransfer.create(p);
  const data=Uint8Array.from({length:20480},(_,i)=>(i*71^(i>>>8))&255);
  await t.write(0x240803fc,data); // first word is immediately before a 1KiB boundary.
  assert.deepEqual(await t.read(0x240803fc,data.length),data);
  assert.equal(p._posted,false);assert.ok(p.packets>40);
}
for(const fault of ['count','ack','echo','short','stall']){
  const p=probe({fault}),t=await SramBenchTransfer.create(p);
  await assert.rejects(t.read(0x24080000,20480));assert.equal(p._faulted,true);
  if(fault==='stall')assert.equal(p.resets,1);
}
const legacy=probe();legacy.info=async()=>Uint8Array.of(0);
assert.equal(await SramBenchTransfer.create(legacy),null,'unsupported atomic commands use ordinary memory API');
console.log('sram-transfer: 64/512-byte packets, 1/4-deep FIFO, cross-page data integrity, ACK/count/echo/short/stall failures PASS');
for(const fault of ['address-protocol','address-zero']){
  const p=probe({fault}),t=await SramBenchTransfer.create(p);
  await assert.rejects(t.write(0x24080000,new Uint8Array(131072)),fault==='address-protocol'?/地址设置.*SWD 协议错误/:/地址设置.*异常 ACK/);
}
console.log('sram-transfer: reject failed TAR completion even when the following 120-word transfer reports success PASS');
