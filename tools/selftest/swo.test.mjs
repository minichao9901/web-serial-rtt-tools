import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SwoDecoder} from '../../app/swo/decoder.js';
import {packRecording,unpackRecording} from '../../app/swo/recording.js';
import {analyzeTrace,selectRange} from '../../app/swo/analyze.js';
import {tracePlan} from '../../app/swo/capture.js';
const sync=[0,0,0,0,0,0x80],pc=[0x17,0x40,0x00,0x00,0x08],stamp=[0xc0,0x80,0x10];
function decode(bytes,split=bytes.length,aligned=true){const events=[],d=new SwoDecoder({aligned,emit:e=>events.push(e)});for(let p=0;p<bytes.length;p+=split)d.feed(bytes.slice(p,p+split));return {events,stats:d.finish()};}
const raw=Uint8Array.from([...sync,...pc,...stamp,0x0e,15,0x10,0x0e,15,0x20,0x0b,0x12,0x34,0x56,0x78,0x10,...pc,0x70,...pc,...stamp]);
const normal=decode(raw);for(let n=1;n<=raw.length;n++)assert.deepEqual(decode(raw,n),normal,'all USB/UART split boundaries');
assert.equal(normal.events.find(x=>x.kind==='pc').cycles,2048);assert.equal(normal.events.find(x=>x.kind==='itm').value,0x78563412);
assert.deepEqual(normal.events.filter(x=>x.kind==='exception').map(x=>[x.exception,x.action]),[[15,'enter'],[15,'exit']]);assert.equal(normal.stats.overflow,1);
assert.equal(decode(Uint8Array.from(pc),1,false).stats.pc,0,'unframed raw import needs sync');
const broken=decode(Uint8Array.from([...pc,0x04,...pc,...sync,...pc]));assert.equal(broken.stats.pc,2,'unknown header suppresses guessed PC until sync');assert.equal(broken.stats.malformed,1);
assert.equal(decode(Uint8Array.from([0x17,1,2])).stats.truncated,1);
const bounded=decode(Uint8Array.from([0xc0,0x80,0x80,0x80,0x80,0x80,...pc,...sync,...pc]));assert.equal(bounded.stats.malformed,1);assert.equal(bounded.stats.pc,1);
const blob=packRecording(raw,{startAligned:true,plan:{coreHz:8000000}}),r=unpackRecording(blob);assert.deepEqual(r.raw,raw);assert.equal(r.metadata.plan.coreHz,8000000);assert.equal(unpackRecording(raw).metadata.startAligned,false);
assert.throws(()=>unpackRecording(blob.slice(0,-1)),/字节数/);const huge=blob.slice();new DataView(huge.buffer).setUint32(8,999999,true);assert.throws(()=>unpackRecording(huge),/头长度/);
const model=analyzeTrace(raw,{startAligned:true,transportGaps:[{offset:6+pc.length,reason:'UART framing'}]});assert.ok(model.events.some(x=>x.kind==='gap'&&x.reason.includes('UART')));
const limited=analyzeTrace(raw,{startAligned:true},null,{maxEvents:2});assert.equal(limited.events.length,2);assert.ok(limited.stats.droppedEvents);
assert.equal(selectRange(analyzeTrace(Uint8Array.from([...pc,...pc]),{startAligned:true}),1,1).samples,1);
assert.equal(tracePlan({coreHz:8000000,baudRate:1000000,periodCycles:4096}).samplesHz,1953.125);assert.throws(()=>tracePlan({coreHz:8000000,baudRate:3000000}),/整除/);assert.throws(()=>tracePlan({coreHz:8000000,baudRate:1000000,periodCycles:2000}),/采样间隔/);
console.log('SWO protocol/recording: split boundaries, PC/ITM/exceptions, timestamps, sync, overflow, truncation, hostile lengths, gaps, limits and planning PASS');

assert.equal(decode(Uint8Array.from([0x17,0,0,0,0])).stats.pc,1,'zero address PC is distinct from a one-byte sleep packet');
const rebase=decode(Uint8Array.from([0x70,...pc,0x10,...pc,0x10]));assert.equal(rebase.events.filter(e=>e.kind==='pc')[0].cycles,null);assert.equal(rebase.events.filter(e=>e.kind==='pc')[1].cycles,1);
const selectedModel={events:[{kind:'pc',fn:'a',sample:0,segment:0},{kind:'pc',fn:'b',sample:1,segment:0},{kind:'pc',fn:'a',sample:2,segment:0},{kind:'pc',fn:'c',sample:3,segment:0}]};assert.equal(selectRange(selectedModel,0,3,'a').transitions.length,0,'filter cannot bridge through excluded PCs');assert.equal(selectRange(selectedModel,1,2).transitions.length,1,'edges limited to current range');
