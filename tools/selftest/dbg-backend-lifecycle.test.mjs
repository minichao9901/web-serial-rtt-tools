import assert from 'node:assert/strict';
import {DebugSession} from '../../app/dbg/session.js';
import {RiscvDebugSession} from '../../app/dbg/riscv.js';
import {DbgView} from '../../app/dbg/view.js';
import {ProbeManager} from '../../app/core/probe-manager.js';
import {SvdValueState} from '../../app/dbg/svd-state.js';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
globalThis.document={getElementById:()=>null};
const v=Object.create(DbgView.prototype),s=new DebugSession(),held=gate();let closed=false;
v.svdValues=new SvdValueState();v._svdRevision=0;
s.probe={disconnect:async()=>{closed=true;}};Object.assign(v,{session:s,_stopWatch(){},rttStop(){},renderRegs(){},renderMem(){},renderBps(){},_syncButtons(){},_bindSessionLog(){}});
const operation=s.exclusive(()=>held.promise),switching=v._ensureSession(true);await tick();assert.equal(v.session,s);assert.equal(closed,false);
held.resolve();await Promise.all([operation,switching]);assert.equal(closed,true);assert.ok(v.session instanceof RiscvDebugSession);
await v._ensureSession(false);assert.ok(v.session instanceof DebugSession);assert.ok(!(v.session instanceof RiscvDebugSession));
console.log('dbg-backend-lifecycle: ARM/RISC-V switch waits for old actions and disconnect before replacing session PASS');

for (const Backend of [DebugSession, RiscvDebugSession]){
  const session = new Backend(), manager = new ProbeManager({ locks: null });
  let rejectClose = true, acquired = false;
  const probe = { async disconnect(){ if (rejectClose) throw new Error('USB close failed'); } };
  const dm = { async writeReg(){}, async readReg(){ return 0x21800000; }, async sbaClearErrors(){} };
  session.probe = probe; if (session instanceof RiscvDebugSession) session.dm = dm;
  manager.register('dbg', { resources: ['target'], active: () => session.connected, release: () => session.disconnect() });
  manager.register('flash', { resources: ['target'], active: () => false, release: async () => {} });
  await manager.run('dbg', async () => {});
  await assert.rejects(manager.run('flash', async () => { acquired = true; }), /USB close failed/);
  assert.equal(acquired, false); assert.equal(session.probe, probe);
  if (session instanceof RiscvDebugSession) assert.equal(session.dm, dm);
  assert.ok(manager.failures.has('dbg'));
  rejectClose = false; await session.disconnect(); manager.forget('dbg');
  await manager.run('flash', async () => { acquired = true; }); assert.equal(acquired, true);
  assert.equal(session.probe, null);
}
const dwtSession = new DebugSession(), dwtProbe = { async disconnect(){ throw new Error('must not close yet'); } };
dwtSession.probe = dwtProbe;
dwtSession.dwt = { items: [{}], async clear(){ throw new Error('DWT cleanup failed'); } };
await assert.rejects(dwtSession.disconnect(), /DWT cleanup failed/); assert.equal(dwtSession.probe, dwtProbe);
console.log('dbg-backend-lifecycle: failed USB/DWT teardown retains backend and blocks takeover until retry PASS');
