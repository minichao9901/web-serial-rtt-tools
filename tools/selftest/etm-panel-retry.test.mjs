import test from 'node:test';import assert from 'node:assert/strict';import {ui} from './etm-ui-harness.mjs';import {EtmView} from '../../app/etm/view.js';
test('retry releases an idle old child before reloading',async()=>{
 const u=await ui();try{const view=new EtmView(),calls=[];view.notice=u.window.document.createElement('div');
  view.bridge={probe:()=>({}),busy:()=>false,release:async()=>calls.push('release')};view.load=async()=>calls.push('reload');
  await view.retry();assert.deepEqual(calls,['release','reload']);assert.equal(view.bridge,null);
 }finally{u.close();}
});
test('retry cannot steal a busy probe or discard a failed cleanup',async()=>{
 const u=await ui();try{const view=new EtmView();view.notice=u.window.document.createElement('div');let released=0;let error='';view.showError=e=>{error=e;};
  const bridge={probe:()=>({}),busy:()=>true,requestStop:async()=>{throw Error('old task still cleaning');},release:async()=>released++};view.bridge=bridge;
  await view.retry();assert.equal(released,0);assert.equal(view.bridge,bridge);assert.match(error,/still cleaning/);
 }finally{u.close();}
});
