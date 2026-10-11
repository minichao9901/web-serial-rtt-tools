import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleRangeFromPixels,zoomRangeAroundCursor} from '../../app/swo/window.js';

test('drag selects an inclusive PC-sample range in either direction and clips at plot edges',()=>{
  assert.deepEqual(sampleRangeFromPixels(20,80,100,100,199),{start:120,end:180});
  assert.deepEqual(sampleRangeFromPixels(80,20,100,100,199),{start:120,end:180});
  assert.deepEqual(sampleRangeFromPixels(-10,140,100,100,199),{start:100,end:199});
});

test('zoom keeps the current cursor inside and centers the new interval around it',()=>{
  const zoomed=zoomRangeAroundCursor({start:0,end:99},{start:0,end:999},75,true);
  assert.deepEqual(zoomed,{start:51,end:100});
  assert.ok(zoomed.start<=75&&75<=zoomed.end);
});

test('zoom uses interval center when cursor is outside the current selection',()=>{
  assert.deepEqual(zoomRangeAroundCursor({start:100,end:199},{start:0,end:999},20,true),{start:126,end:175});
});

test('zoom out expands to the full sample range and zoom in stops at two samples',()=>{
  assert.deepEqual(zoomRangeAroundCursor({start:400,end:599},{start:0,end:999},500,false),{start:301,end:700});
  assert.deepEqual(zoomRangeAroundCursor({start:5,end:6},{start:0,end:999},5,true),{start:5,end:6});
});
