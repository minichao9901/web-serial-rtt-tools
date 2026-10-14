import test from 'node:test';import assert from 'node:assert/strict';import {ui,deferred} from './etm-ui-harness.mjs';

test('real page handlers enforce prerequisites and complete a capture with restored breakpoint',async()=>{
 const u=await ui();try{
  assert.equal(u.$('start').disabled,true);assert.equal(u.$('run-to').disabled,true);
  await u.upload();await u.click('connect');await u.select();assert.equal(u.$('start').disabled,false);
  await u.click('start');assert.equal(u.state.operation,false);assert.equal(u.state.job,null);
  assert.ok(u.target.breakpoints.items[0].lease);assert.ok(u.events.indexOf('configure')<u.events.indexOf('run'));
 }finally{u.close();}
});
test('bad parameters fail before reset, halt or trace configuration',async()=>{
 const u=await ui();try{await u.upload();await u.click('connect');await u.select();
  for(const [id,value]of [['duration','2001'],['rate','0'],['threshold','5'],['fraction','1'],['traceid','0'],['channels','1,2,3,4,']]){
   const old=u.$(id).value,before=u.events.length;u.$(id).value=value;await u.click('start');assert.equal(u.events.length,before,id);assert.equal(u.state.operation,false);u.$(id).value=old;
  }
 }finally{u.close();}
});
test('ELF picker callback is protected by the real parent owner during a delayed upload',async()=>{
 const u=await ui();try{await u.click('connect');const block=deferred();u.model.block={path:'elf',promise:block.promise};const upload=u.upload();
  await new Promise(r=>setImmediate(r));assert.equal(u.state.hardwareOperation,true);
  await assert.rejects(u.manager.run('dbg',async()=>{}),/正在使用/);block.resolve();await upload;assert.equal(u.state.hardwareOperation,false);
 }finally{u.close();}
});
test('late file picker results cannot overwrite an active operation; uppercase record package is recognized',async()=>{
 const u=await ui();try{
  Object.defineProperty(u.$('capture-file'),'files',{value:[new File(['zip'],'A.ETMRECORD')],configurable:true});u.state.operation=true;
  await u.$('capture-file').onchange();assert.ok(!u.requests.includes('import'));u.state.operation=false;
  u.model.jobStates=['cancelled'];await u.$('capture-file').onchange();assert.ok(u.requests.includes('import'));assert.equal(u.state.operation,false);
 }finally{u.close();}
});
test('direct capture preserves ETMv3 readback and refuses to invent protocol before a connection',async()=>{
 const u=await ui();try{
  await u.upload();u.$('sync').checked=false;u.$('sync').onchange();await u.click('start');assert.equal(u.jobs.length,0);assert.match(u.$('job-state').textContent,/不能假定 ETMv4/);
  await u.click('connect');await u.click('disconnect');u.model.jobStates=['done'];await u.click('start');
  assert.equal(JSON.parse(u.jobs[0]).config.protocol,'ETMv3');assert.equal(u.events.filter(x=>x==='run').length,0);
 }finally{u.close();}
});
test('fault cleanup retains the suspended breakpoint set until explicit recovery',async()=>{
 const u=await ui();try{
  await u.upload();await u.click('connect');await u.select();
  u.target.configure=async()=>{u.target.debugFault=true;throw Error('SWD fault');};await u.click('start');
  assert.equal(u.target.breakpoints.items[0].lease,null);assert.equal(u.state.pendingBreakpointRestore.length,1);
  await u.click('recover-debug');assert.ok(u.target.breakpoints.items[0].lease);assert.equal(u.state.pendingBreakpointRestore.length,0);
 }finally{u.close();}
});
test('stop during arm delay never resumes CPU',async()=>{
 const u=await ui();try{
  await u.upload();await u.click('connect');await u.select();const capture=u.click('start');
  for(let i=0;i<50&&u.state.jobPhase!=='armed';i++)await new Promise(r=>setImmediate(r));
  await u.click('stop');await capture;assert.equal(u.events.filter(e=>e==='run').length,0);assert.equal(u.state.job,null);
 }finally{u.close();}
});
test('unconfirmed analyser stop disables capture until stop is explicitly confirmed',async()=>{
 const u=await ui();const original=globalThis.fetch;try{
  await u.upload();await u.click('connect');await u.select();u.model.jobStates=['error'];
  globalThis.fetch=async(...args)=>String(args[0]).includes('/stop/')?{ok:false,json:async()=>({error:'stop refused'})}:original(...args);
  await u.click('start');assert.equal(u.state.failedCaptureJob,'capture-a');assert.equal(u.$('start').disabled,true);assert.equal(u.$('stop').disabled,false);
  globalThis.fetch=original;await u.click('stop');assert.equal(u.state.failedCaptureJob,null);assert.equal(u.$('start').disabled,false);
 }finally{globalThis.fetch=original;u.close();}
});
test('background halt polling uses the parent probe queue',async()=>{
 const u=await ui();try{
  await u.upload();await u.click('connect');await u.select();u.target.info.halted=false;
  const block=deferred();u.target.isHalted=()=>block.promise;const polling=u.intervals[0]();await new Promise(r=>setImmediate(r));
  await assert.rejects(u.manager.run('dbg',async()=>{}),/正在使用/);block.resolve(false);await polling;assert.equal(u.state.hardwareOperation,false);
 }finally{u.close();}
});
test('direct LA capture remains busy even after disconnecting the SWD probe',async()=>{
 const u=await ui(),d=deferred();let pending;
 try{
  await u.upload();await u.click('connect');await u.select();await u.click('disconnect');u.$('sync').checked=false;u.$('sync').onchange();
  u.model.block={path:'jobs/capture-a',promise:d.promise};u.model.jobStates=['cancelled'];pending=u.click('start');
  for(let i=0;i<40&&!u.state.job;i++)await new Promise(r=>setImmediate(r));
  assert.equal(u.target.probe,null);assert.equal(u.state.jobKind,'capture');assert.equal(u.window.__etmBridge.busy(),true);
  d.resolve();await pending;assert.equal(u.window.__etmBridge.busy(),false);
 }finally{d.resolve();if(pending)await pending;u.close();}
});
test('200 repeat operation orders recover from validation/entry errors and never keep controls busy',async()=>{
 let cases=0;
 for(const order of ['elf-first','connect-first']){
  const u=await ui();try{
   if(order==='elf-first'){await u.upload();await u.click('connect');}else{await u.click('connect');await u.upload();}await u.select();
   for(let i=0;i<100;i++){
    u.model.verifyError=i%5===0?'ELF mismatch':null;u.model.entryError=i%5===1?'entry timeout':null;u.model.jobStates=['armed','done'];
    await u.click('start');assert.equal(u.state.operation,false);assert.equal(u.state.job,null);assert.equal(u.state.hardwareOperation,false);
    assert.ok(u.target.breakpoints.items[0].lease);assert.equal(u.$('disconnect').disabled,false);cases++;
   }
  }finally{u.close();}
 }
 console.log('Verified '+cases+' real controller operation-order cases');
});
