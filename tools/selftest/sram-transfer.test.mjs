import assert from 'node:assert/strict';
import { SramBenchTransfer,prepareSramClock } from '../../app/flash/sram-transfer.js';

function probe({packet=512,depth=4,fault}={}){
  const memory=new Map(),pending=[];let packets=0,reset=0;
  const respond=frame=>{
    packets++;assert.equal(frame[0],5);assert.equal(frame[1],0);assert.equal(frame[3],5);
    const dv=new DataView(frame.buffer,frame.byteOffset,frame.byteLength);
    const addr=dv.getUint32(4,true),words=frame[2]-1,read=frame[8]===15;
    assert.ok((addr&1023)+words*4<=1024);assert.ok(frame.length<=packet);
    assert.equal(frame.length,8+(read?words:words*5));
    const res=new Uint8Array(3+(read?words*4:0));res.set([5,words+1,1]);
    // DAP_Transfer stops at a failed TAR: no subsequent DRW may execute.
    if(fault==='address-protocol'||fault==='address-zero'){
      res[1]=0;res[2]=fault==='address-protocol'?8:0;return res.subarray(0,3);
    }
    for(let i=0;i<words;i++){
      assert.equal(frame[8+i*(read?1:5)],read?15:13);
      for(let j=0;j<4;j++){
        if(read)res[3+i*4+j]=memory.get(addr+i*4+j)??0;
        else memory.set(addr+i*4+j,frame[9+i*5+j]);
      }
    }
    if(fault==='count')res[1]--;
    if(fault==='ack')res[2]=4;
    if(fault==='echo')res[0]=127;
    return fault==='short'?res.subarray(0,3):res;
  };
  return {pkt:Math.min(packet,512),_framing:'short',epOut:1,epIn:129,
    async info(id){return id===0xff?Uint8Array.of(packet&255,packet>>>8):Uint8Array.of(depth);},
    async flushWrites(){},async _withLock(fn){return await fn();},
    async _onXferTimeout(){reset++;},
    device:{
      async transferOut(_ep,frame){pending.push(respond(frame));return{status:fault==='stall'?'stall':'ok'};},
      async transferIn(_ep,size){assert.equal(size,packet);const b=pending.shift();assert.ok(b);return{status:'ok',data:new DataView(b.buffer,b.byteOffset,b.byteLength)};},
    },get packets(){return packets;},get resets(){return reset;},memory,
  };
}
for(const packet of [64,512,1024])for(const depth of [1,4]){
  const p=probe({packet,depth}),t=await SramBenchTransfer.create(p);
  const data=Uint8Array.from({length:65536},(_,i)=>(i*71^(i>>>8))&255);
  await t.write(0x240803fc,data);
  assert.deepEqual(await t.read(0x240803fc,data.length),data);
  assert.equal(p._posted,false);assert.ok(p.packets>40);assert.equal(t.packetSize,packet);
}
for(const fault of ['count','ack','echo','short','stall','address-protocol','address-zero']){
  const p=probe({fault}),t=await SramBenchTransfer.create(p);
  await assert.rejects(t.read(0x24080000,20480));assert.equal(p._faulted,true);
  if(fault==='stall')assert.equal(p.resets,1);
  if(fault.startsWith('address')){
    await assert.rejects(t.write(0x24080000,new Uint8Array(131072)));
    assert.equal(p.memory.size,0,'failed TAR never executes the data writes');
    assert.ok(p.packets<=8,'failure stops submitting new windows; already submitted reads are drained');
  }
}
const legacy=probe();legacy.info=async()=>Uint8Array.of(0);
assert.equal(await SramBenchTransfer.create(legacy),null);

// A slow fourth reply must not block refilling completed earlier slots.
const rolling=probe(),origIn=rolling.device.transferIn.bind(rolling.device),origOut=rolling.device.transferOut.bind(rolling.device);
let ins=0,outs=0,release;const gate=new Promise(r=>release=r);
rolling.device.transferIn=async(...args)=>{const result=await origIn(...args);if(++ins===4)await gate;return result;};
rolling.device.transferOut=async(...args)=>{if(++outs===5)release();return origOut(...args);};
await Promise.race([new SramBenchTransfer(rolling,4).read(0x20000000,4096),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('pipeline barrier')),1000);t.unref();})]);
assert.ok(outs>4);

// Clock qualification retries only setup; it never resets or writes SRAM.
const calls=[];let ids=0;
const clockProbe={idcode:0x1ba01477,apIndex:2,csw:0x23000052,
  async flushWrites(){},async setClock(hz){calls.push(['clock',hz]);},
  async abort(){calls.push(['abort']);return true;},async swdActivation(){calls.push(['activation']);},
  async _transfer(ops){
    for(const op of ops)if(!op.rnw&&op.ap)assert.ok([0,4].includes(op.addr));
    if(ops.length===2)return [0x411fc231];
    if(ops[0].rnw){if(++ids===2)throw Error('first high-clock frame');return [this.idcode];}
    calls.push(['setup',ops[0].addr,ops[0].data]);return [];
  },
};
const setup=await prepareSramClock(clockProbe,60000000);
assert.equal(setup.attempts,2);assert.deepEqual(setup.failures,['first high-clock frame']);
assert.deepEqual(calls.filter(x=>x[0]==='clock').map(x=>x[1]),[20000000,60000000,60000000]);
assert.equal(calls.filter(x=>x[0]==='activation').length,1);
clockProbe._transfer=async()=>{throw Error('broken link');};
await assert.rejects(prepareSramClock(clockProbe,60000000),/broken link/);
console.log('sram-transfer: 64/512/1024B, FIFO depth 1/4, cross-page integrity, stop-on-TAR-failure, drain/refill, strict clock qualification PASS');
