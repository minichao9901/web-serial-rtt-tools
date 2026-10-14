import test from 'node:test';import assert from 'node:assert/strict';import {ui,deferred} from './etm-ui-harness.mjs';import {EtmView,workbenchUrl} from '../../app/etm/view.js';
test('retry releases an idle old child before reloading',async()=>{
 const u=await ui();try{const view=new EtmView(),calls=[];let connected=true;view.notice=u.window.document.createElement('div');
  view.bridge={probe:()=>connected?{}:null,busy:()=>false,release:async()=>{calls.push('release');connected=false;}};view.load=async()=>calls.push('reload');
  await view.retry();assert.deepEqual(calls,['release','reload']);assert.equal(view.bridge,null);
 }finally{u.close();}
});
test('workbench link follows current local port or saved project port',()=>{
 assert.equal(workbenchUrl({hostname:'127.0.0.1',port:'8888'},8878),'http://127.0.0.1:8888/#etm');
 assert.equal(workbenchUrl({hostname:'example.github.io',port:''},8999),'http://127.0.0.1:8999/#etm');
 assert.equal(workbenchUrl({hostname:'example.github.io',port:''},'invalid'),'http://127.0.0.1:8878/#etm');
});
test('child unload drains the old task before releasing its probe',async()=>{
 const view=new EtmView(),calls=[];let busy=true;view.showError=e=>calls.push(e);const bridge={probe:()=>null,busy:()=>busy,requestStop:async()=>{calls.push('stop');busy=false;},release:async()=>calls.push('release')};view.bridge=bridge;
 await view.childUnloaded(bridge);assert.equal(view.bridge,null);assert.equal(view.detaching,null);assert.ok(calls.indexOf('stop')<calls.indexOf('release'));
});
test('failed child unload retains the original bridge for recovery',async()=>{
 const view=new EtmView();view.showError=()=>{};const bridge={busy:()=>false,release:async()=>{throw Error('faulted');}};view.bridge=bridge;
 await view.childUnloaded(bridge);assert.equal(view.bridge,bridge);assert.equal(view.detaching,null);
});
test('explicit retry recovers a lost faulted realm then confirms release before reload',async()=>{
 const u=await ui();try{const view=new EtmView(),calls=[];let fault=true,connected=true;view.load=async()=>calls.push('reload');view.showError=e=>{throw Error(e);};
  view.bridge={probe:()=>connected?{}:null,busy:()=>false,summary:()=>({transportFault:fault}),recoverForRelease:async()=>{calls.push('recover');fault=false;},release:async()=>{assert.equal(fault,false);calls.push('release');connected=false;}};
  await view.retry();assert.deepEqual(calls,['recover','release','reload']);assert.equal(view.bridge,null);
 }finally{u.close();}
});
test('late cleanup of an old child cannot release or forget a newer child',async()=>{
 const view=new EtmView(),d=deferred();view.showError=()=>{};let busy=true,oldReleased=0,newReleased=0,forgot=0;
 const old={probe:()=>null,busy:()=>busy,requestStop:async()=>{await d.promise;busy=false;},release:async()=>oldReleased++},newer={probe:()=>({}),busy:()=>false,release:async()=>newReleased++};
 view.bridge=old;const pending=view.childUnloaded(old);view.bridge=newer;view.probeManager={run:async(_,fn)=>fn(),forget:()=>forgot++};d.resolve();await pending;
 assert.equal(oldReleased,1);assert.equal(newReleased,0);assert.equal(forgot,0);assert.equal(view.bridge,newer);
});
test('retry cannot steal a busy probe or discard a failed cleanup',async()=>{
 const u=await ui();try{const view=new EtmView();view.notice=u.window.document.createElement('div');let released=0;let error='';view.showError=e=>{error=e;};
  const bridge={probe:()=>({}),busy:()=>true,requestStop:async()=>{throw Error('old task still cleaning');},release:async()=>released++};view.bridge=bridge;
  await view.retry();assert.equal(released,0);assert.equal(view.bridge,bridge);assert.match(error,/still cleaning/);
 }finally{u.close();}
});
