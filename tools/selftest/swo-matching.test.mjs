import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Elf} from '../../app/elf/elf.js';
import {tracePlan} from '../../app/swo/capture.js';
import {receiverCandidate,matchedOptions} from '../../app/swo/matching.js';
import {SwoReceiver,receiverWords,receiverStatus} from '../../app/swo/receiver.js';
import {TargetClock} from './swo-legacy-target-clock.mjs';
const base={coreHz:72e6,baudRate:24e6,seconds:1,periodCycles:512,autoBaud:true,receiverMode:2};
for(const [hz,period,timestamps,expected] of [[72e6,512,true,18e6],[32e6,256,true,16e6],[24e6,128,true,24e6],[60e6,256,true,30e6],[60e6,128,false,30e6],[24e6,64,false,24e6]]){
 const o=matchedOptions({...base,coreHz:hz,periodCycles:period,timestamps}),p=tracePlan(o);assert.equal(p.baudRate,expected);assert.equal(o.receiverEstimate.error,0);assert.ok(p.estimatedBytes<=p.wireBytes*.8);assert.equal(p.coreHz/(p.acpr+1),o.receiverEstimate.actualBaud);
}
assert.throws(()=>matchedOptions({...base,periodCycles:64}),/降低主频/);
assert.throws(()=>matchedOptions({...base,periodCycles:128}),/降低主频/);
assert.equal(tracePlan({...base,periodCycles:64}).samplesHz,1125000);
assert.equal(tracePlan({...base,periodCycles:64}).pcMinimumBaud,56250000);
assert.equal(receiverCandidate(24e6,0).error,0);
assert.equal(receiverCandidate(30e6,0).error,0);
assert.equal(receiverCandidate(23e6,2).pllHz,920e6);
assert.equal(receiverCandidate(25e6,2).retune,false);
// Non-nominal clocks must be used, rather than assuming the SDK default roots.
assert.notEqual(receiverCandidate(18e6,1,[24e6,704e6,600e6,400e6,800e6,666e6,500e6,266e6]).actualBaud,18e6);
const frame=(action,w)=>{const b=new Uint8Array(63);b.set([58,0x19,action]);const v=new DataView(b.buffer,3);w.forEach((x,i)=>v.setUint32(i*4,x,true));return b;};
assert.throws(()=>receiverWords(new Uint8Array(63),0),/未支持/);
assert.equal(receiverStatus([1,0xfffffffc,0,0,0,0,200e6,0,0,0,0,800e6,0,29]).rc,-4);
let token=0,active=false,busy=0,closed=0;
const fake={async xfer(cmd,data){assert.equal(cmd,0x19);const a=data[0],arg=new DataView(data.buffer).getUint32(1,true);if(a===1){assert.equal(arg,24e6);token=42;busy=1;}if(a===2){assert.equal(arg,42);token=0;active=false;}if(a===3)assert.equal(arg,token);const rc=busy?1:0;if(a===0&&busy){busy--;active=true;}return frame(a,[1,rc,token,active?3:0,24e6,active?24e6:0,active?192e6:200e6,4,4,8,1,active?768e6:800e6,5000,0xffffffff]);},async close(){closed++;}};
const r=new SwoReceiver(fake);assert.equal((await r.prepare(24e6,2)).actualBaud,24e6);await r.heartbeat();await r.close();assert.equal(token,0);assert.equal(closed,1);
const bad=new SwoReceiver({xfer:async()=>frame(1,[1,0xfffffffc,0,0,24e6,0,200e6,4,4,8,1,800e6,0,29])});await assert.rejects(()=>bad.prepare(24e6,2),/共享时钟节点 29/);
const bytes=readFileSync('tools/target-firmware/stm32f103cb_swo_clock/fw.elf'),elf=new Elf(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),symbols=Object.fromEntries(elf.symbols().map(x=>[x.name,x.addr])),memory=new Map([[symbols.g_clock_magic,0x5357434b],[symbols.g_clock_hz,72e6],[symbols.g_clock_error,0],[symbols.g_clock_seq,0]]);let writes=0;
const target=new TargetClock({read:async a=>memory.get(a),write:async(a,hz)=>{assert.equal(a,symbols.g_clock_request_hz);writes++;memory.set(symbols.g_clock_hz,hz);memory.set(symbols.g_clock_seq,memory.get(symbols.g_clock_seq)+1);}},elf);await target.validate();await target.change(24e6);await target.restore();assert.equal(memory.get(symbols.g_clock_hz),72e6);assert.equal(writes,2);
const unsupported=new TargetClock({write:()=>assert.fail('Unsupported firmware must never receive RCC/RAM writes')},null);await assert.rejects(()=>unsupported.validate(),/配套/);
console.log('SWO matching: bandwidth limits, exact clocks, live roots, protocol rejection, lease restoration, cooperative target validation PASS');
