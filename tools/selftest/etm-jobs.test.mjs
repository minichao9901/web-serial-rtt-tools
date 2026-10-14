import test from 'node:test';import assert from 'node:assert/strict';
import {requestJson,pollJob} from '../../bridge/etm/backend/web/app/jobs.js';

test('stalled fetch and stalled response body are bounded and do not retry',async()=>{
  for(const fetchImpl of [()=>new Promise(()=>{}),async()=>({ok:true,json:()=>new Promise(()=>{})})]){
    await assert.rejects(requestJson('/api/jobs/a',{}, {timeout:5,fetchImpl}),/请求超时/);
  }
});
test('bad JSON, server rejection and oversized upload are explicit errors',async()=>{
  for(const [response,message]of [[{ok:true,json:async()=>{throw Error('bad')}},/无效响应/],[{ok:false,json:async()=>({error:'offline'})},/offline/],[{status:413},/容量/]])
    await assert.rejects(requestJson('/api',{}, {fetchImpl:async()=>response}),message);
});

function runner(states,options={}){
  let time=0,index=0,resumes=0,done=0;const seen=[];
  return {run:()=>pollJob('job',{read:async()=>({state:states[Math.min(index++,states.length-1)],record:'a',error:'device offline'}),
    onState:j=>seen.push(j.state),onResume:async()=>{resumes++;},onDone:async()=>{done++;},now:()=>time,sleep:async ms=>{time+=ms;},
    interval:10,totalMs:500,stageMs:{queued:50,starting:50,armed:50,saving:50,decoding:50},...options}),
    stats:()=>({resumes,done,seen,time})};
}
test('all active stages time out; unknown and failure states terminate',async()=>{
  for(const phase of ['queued','starting','armed','saving','decoding']){
    const r=runner([phase]);await assert.rejects(r.run(),/阶段过久/);assert.ok(r.stats().time<=160);
  }
  for(const phase of ['unexpected','error'])await assert.rejects(runner([phase]).run());
});
test('stop between arm and resume prevents CPU running; cancelled does not load stale data',async()=>{
  let cancelled=false;const r=runner(['armed','cancelled'],{shouldResume:()=>!cancelled,sleep:async()=>{cancelled=true;}});
  assert.equal((await r.run()).state,'cancelled');assert.equal(r.stats().resumes,0);assert.equal(r.stats().done,0);
});
test('batch task state sequences: resume exactly once, cancel/error never complete, no indefinite polls',async()=>{
  let cases=0;
  for(let queued=0;queued<4;queued++)for(let armed=0;armed<4;armed++)for(let saving=0;saving<4;saving++)for(const terminal of ['done','cancelled','error']){
    const states=[...Array(queued).fill('queued'),...Array(armed).fill('armed'),...Array(saving).fill('saving'),'decoding',terminal];
    const r=runner(states,{totalMs:5000,stageMs:{queued:1000,armed:1000,saving:1000,decoding:1000}});
    if(terminal==='error')await assert.rejects(r.run(),/device offline/);else await r.run();
    assert.equal(r.stats().resumes,armed?1:0);assert.equal(r.stats().done,terminal==='done'?1:0);cases++;
  }
  console.log('Verified '+cases+' task sequences');
});
