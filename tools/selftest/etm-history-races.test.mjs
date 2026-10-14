import test from 'node:test';import assert from 'node:assert/strict';import {ui,deferred} from './etm-ui-harness.mjs';
import {HistoryView} from '../../bridge/etm/backend/web/app/history.js';
const overview={elf:{sha256:'a'.repeat(64)},summary:{instructions:10,exceptions:0},quality:{validPackets:5,unknownExecution:0,packetIssues:0,overflowPackets:0,timing:{cycleElements:0}},status:{lastErrorCode:0},analysis:{functions:[],hotspots:[]},physical:{},firstSeq:null};

test('pending decoded overview cannot resurrect a raw record after switching',async()=>{
 const u=await ui();try{const d=deferred(),h=u.history;h.api=()=>d.promise;h.load=HistoryView.prototype.load;
  const pending=h.load('old','old');h.unload('raw');d.resolve(overview);await pending;
  assert.equal(h.sid,'raw');assert.equal(h.result,null);assert.equal(u.$('execution-timeline-panel').hidden,true);
 }finally{u.close();}
});
test('two loads of the same record keep loading until the current generation finishes',async()=>{
 const u=await ui();try{const a=deferred(),b=deferred(),h=u.history;let count=0;h.api=()=>count++===0?a.promise:b.promise;h.render=async()=>{};h.load=HistoryView.prototype.load;
  const first=h.load('same'),second=h.load('same');a.resolve(overview);await first;assert.equal(h.loading,true);
  b.resolve(overview);await second;assert.equal(h.loading,false);
 }finally{u.close();}
});
test('old navigation cannot select an event from the newly loaded record',async()=>{
 const u=await ui();try{const d=deferred(),h=u.history;h.sid='old';h.result={};h.recordRevision=1;h.api=()=>d.promise;let selected=0;h.select=async()=>{selected++;};
  const navigation=h.navigate(1);h.unload('new');h.result={};d.resolve({seq:3});await navigation;assert.equal(selected,0);
 }finally{u.close();}
});
test('old scope completion does not clear a new record scope lock or source selection',async()=>{
 const u=await ui();try{const d=deferred(),h=u.history;h.sid='old';h.result={eventCount:100,firstSeq:0};h.recordRevision=1;h.render=()=>d.promise;
  const zoom=h.setRange({start:2,end:8});h.unload('new');h.result={eventCount:20,firstSeq:0};h.scopeBusy=true;
  d.resolve();await zoom;assert.equal(h.scopeBusy,true);assert.equal(h.selected,null);
 }finally{u.close();}
});
test('1000 zoom/fit cases preserve the selected cursor and clamp to the full record',async()=>{
 const u=await ui();try{const h=u.history;h.result={eventCount:1000};h.timelineData={range:{totalStart:0,totalEnd:999}};let cases=0;
  h.setRange=async(range,remember,focus)=>{assert.ok(range===null||range.start>=0&&range.end<1000&&range.end>=range.start);assert.equal(focus,h.selected);if(range)assert.ok(range.start<=focus&&focus<=range.end);cases++;};
  for(let cursor=0;cursor<1000;cursor+=2){h.range=null;h.selected=cursor;await h.zoomRange(true);h.range={start:Math.max(0,cursor-1),end:Math.min(999,cursor+1)};await h.zoomRange(false);}
  assert.equal(cases,1000);
 }finally{u.close();}
});
test('wheel and drag range callbacks keep an existing cursor when it remains in range',async()=>{
 const u=await ui();try{const h=u.history;h.result={eventCount:100,firstSeq:0};h.selected=50;h.render=async()=>{h.window={firstSeq:30};};let selected;
  h.select=async seq=>{selected=seq;};await h.setRange({start:25,end:75});assert.equal(selected,50);
 }finally{u.close();}
});
