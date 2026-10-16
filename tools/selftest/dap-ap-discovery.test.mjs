import test from 'node:test';
import assert from 'node:assert/strict';
import {WebUsbDapProbe,CMD} from '../../app/rtt/dap-webusb.js';

function transport(candidates,final=0x411fc271){
  const p=new WebUsbDapProbe();let selected=0,csw=0;const visited=[];
  p._ctrl=async cmd=>Uint8Array.of(cmd===CMD.Connect?1:0);
  p.setClock=p.swdActivation=p._powerUpDP=async()=>{};
  p._readDP=async()=>0xa0000000;p._readAP=async()=>csw;p._writeAP=async()=>{};
  p._transfer=async ops=>{
    const op=ops[0];
    if(!op.ap&&op.rnw)return [0x6ba02477];
    if(!op.ap&&op.addr===8){selected=op.data>>>24;visited.push(selected);}
    if(op.ap&&!op.rnw&&op.addr===0)csw=op.data;
    if(op.ap&&op.rnw){const value=candidates(selected,csw);if(value instanceof Error){p._faulted=true;throw value;}return[value];}
    return[];
  };
  p._readMemOnce=async()=>{if(final instanceof Error)throw final;const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,final,true);return b;};
  return{p,visited};
}

test('AP0 FAULT / garbage then valid AP2 clears discovery-only fault after fresh read',async()=>{
  const {p}=transport(ap=>ap===0?Object.assign(Error('FAULT'),{ack:4}):0x411fc271);
  await p._targetInit();assert.equal(p.apIndex,2);assert.equal(p._faulted,false);
  const q=transport(ap=>ap===0?0x9576b58b:0x411fc271).p;
  await q._targetInit();assert.equal(q.apIndex,2);
});

test('reinitialization discards cached CSW and scans current target',async()=>{
  const {p}=transport(ap=>ap===2?0x411fc271:0);
  p.cswUsed=0xaa000012;await p._targetInit();assert.equal(p.apIndex,2);
});

test('no valid ARM CPU rejects instead of returning a nominally connected probe',async()=>{
  const {p}=transport(()=>0x9576b58b);await assert.rejects(p._targetInit(),/有效 ARM CPUID/);assert.equal(p._faulted,true);
});

test('fresh verification cannot be replaced by successful candidate probe',async()=>{
  const {p}=transport(()=>0x411fc271,0x9576b58b);await assert.rejects(p._targetInit(),/核验失败/);assert.equal(p._faulted,true);
});

test('explicit recovery preserves failure latch when final read fails',async()=>{
  const {p}=transport(()=>0x411fc271,Error('transport lost'));await assert.rejects(p.recoverDebugPort(),/transport lost/);assert.equal(p._faulted,true);assert.equal(p._recovering,false);
});

test('F103 AP0 succeeds and no other AP is selected',async()=>{
  const {p,visited}=transport(()=>0x411fc231,0x411fc231);await p._targetInit();assert.equal(p.apIndex,0);assert.ok(visited.every(ap=>ap===0));
});
