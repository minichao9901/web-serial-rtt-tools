import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BusPeriodicClient, BUS, program, delayRecord, runSessionPeriodic, stopSessionPeriodic } from '../../app/core/bus-periodic.js';
import { buildRequest } from '../../app/hid/probe.js';
import { actXfer } from '../../app/i2c/protocol.js';
import * as SPI from '../../app/spi/protocol.js';
import { ScriptRunner as I2cRunner } from '../../app/i2c/runner.js';
import { SpiRunner } from '../../app/spi/runner.js';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const firmware = process.env.PROBE_FIRMWARE_REPO || resolve(root, '../5301evk_akaLinkPro');
assert.ok(existsSync(join(firmware, 'script_test/bus_periodic_wire_server.py')), 'set PROBE_FIRMWARE_REPO to the paired firmware checkout');
const dir = mkdtempSync(join(tmpdir(), 'bus-periodic-'));
const binary = join(dir, process.platform === 'win32' ? 'wire.exe' : 'wire');
execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [join(firmware, 'script_test/bus_periodic_wire_server.py'), binary], {env:{...process.env,CPATH:[join(firmware,'firmware/application_5301/src/api'),process.env.CPATH].filter(Boolean).join(delimiter)}});
const child = spawn(binary, [], { stdio: ['pipe','pipe','inherit'] });
const pending = [];
createInterface({ input: child.stdout }).on('line', line => pending.shift()?.resolve(line));
const exited = new Promise(resolve => child.on('exit', resolve));
child.on('exit', code => { for (const p of pending.splice(0)) p.reject(Error(`wire server exit ${code}`)); });
const send = line => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(line + '\n'); });
let auto = false;
const calls = [];
async function xfer(cmd, data){
  calls.push(data[0]);
  if (auto && data[0] === 6) await send('T 10');
  const req = Uint8Array.of(1, ...buildRequest(cmd, data));
  const line = await send('H ' + Buffer.from(req).toString('hex'));
  const res = Uint8Array.from(Buffer.from(line, 'hex')).subarray(1);
  await send('P');
  return res;
}
const i2c = { kind: BUS.I2C, data: actXfer({ dev: 0x48, addr: [0], rd: 54 }).subarray(1) };
const spi = { kind: BUS.SPI, data: SPI.frame(SPI.T.XFER, SPI.xferPayload({ cmd: 0x90, tcfg: SPI.TC.CMD_EN, rxLen: 54 })) };
try {
  assert.throws(() => program(Array(17).fill(i2c)), /16/);
  assert.throws(() => delayRecord(-1), /微秒/);
  for (const [bus, record] of [[BUS.I2C,i2c],[BUS.SPI,spi]]){
    await send('R'); calls.length = 0;
    const client = new BusPeriodicClient(xfer), seen = [];
    // Hold every browser result read until the probe has already collected three samples.
    let advanced = false;
    const held = new BusPeriodicClient(async (cmd, data) => {
      if (data[0] === 6 && !advanced){ advanced = true; await send('T 25'); }
      return xfer(cmd, data);
    });
    await held.run(bus, [{ period: 10, count: 3, records: [record] }], { onResult: r => seen.push(r) });
    assert.deepEqual(seen.map(r => r.cycle), [1,2,3]);
    assert.deepEqual(seen.map(r => r.timeMs), [0,10,20].map(n => n + seen[0].timeMs));
    assert.ok(seen.every(r => r.data.length === 54));
    assert.equal(calls.filter(x => x === 3).length, 1, 'one upload/start, no per-sample XFER');
    assert.equal((await client.status()).active, 0);
  }
  await send('R'); auto = false;
  const samples=[];let adcAdvanced=false;
  const adc=new BusPeriodicClient(async(cmd,data)=>{
    if(data[0]===6&&!adcAdvanced){adcAdvanced=true;await send('T 25');}
    return xfer(cmd,data);
  });
  await adc.run(BUS.ADC,[{period:10,count:3,records:[{kind:BUS.ADC,data:Uint8Array.of(3,16)}]}],{onResult:r=>samples.push(r)});
  assert.deepEqual(samples.map(r=>r.cycle),[1,2,3]);
  assert.deepEqual(samples.map(r=>r.timeMs-samples[0].timeMs),[0,10,20]);
  assert.ok(samples.every(r=>r.data.length===2&&r.data[0]===0x34));
  await send('R'); auto = true;
  const rows = [];
  await new BusPeriodicClient(xfer).run(BUS.I2C, [0,1].map(() => ({ period: 10, count: 2, records: [i2c] })), { onResult: r => rows.push(r) });
  assert.equal(rows.length, 4); assert.deepEqual([...new Set(rows.map(r => r.slot))].sort(), [0,1]);
  await send('R');
  const cancel = new AbortController(); calls.length = 0;
  await new BusPeriodicClient(xfer).run(BUS.I2C, [{ period: 10, count: 0, records: [i2c] }], {
    signal: cancel.signal, onResult(){ cancel.abort(); },
  });
  assert.ok(calls.includes(4));
  await send('R'); auto = false;
  const overflow = new BusPeriodicClient(async (cmd, data) => {
    if (data[0] === 6) await send('T 40');
    return xfer(cmd, data);
  });
  await assert.rejects(overflow.run(BUS.I2C, [{ period: 1, count: 0, records: [i2c] }]), /缓冲满/);
  assert.equal((await overflow.status()).active, 0);
  const unsupported = new BusPeriodicClient(async () => Uint8Array.of(1,0x37));
  await assert.rejects(unsupported.run(BUS.I2C,[{ period:10,records:[i2c] }]), /未支持/);
  // A status poll may already be queued when acquisition takes the HID link.
  // The periodic client must wait for that session chain to retire before CAPS.
  await send('R'); auto = true; calls.length = 0;
  let releaseQueued, finishQueued = false, pollQueued = null, inFlight = 0, overlap = false;
  const queuedSession = { connected:true, usingMock:false, busy:false,
    _chain:new Promise(resolve => { releaseQueued = resolve; }),
    setBusy(v){ this.busy=v; },
    _enqueue(fn){ const p=this._chain.then(fn,fn); this._chain=p.catch(()=>{}); return p; },
    hid:{ async xfer(cmd,data){
      inFlight++; if (inFlight > 1) overlap = true;
      try { await new Promise(resolve => setTimeout(resolve,2)); return await xfer(cmd,data); }
      finally { inFlight--; }
    } },
  };
  const queuedRun = runSessionPeriodic(queuedSession,BUS.I2C,[{period:10,count:0,records:[i2c]}],{
    shouldStop:()=>finishQueued,onResult(){
      if (!pollQueued) pollQueued=queuedSession._enqueue(()=>queuedSession.hid.xfer(0x37,Uint8Array.of(0)));
      finishQueued=true;
    },
  });
  await new Promise(resolve => setTimeout(resolve,0));
  assert.deepEqual(calls, [], 'no periodic HID command overlaps the queued session transaction');
  assert.equal(queuedSession.busy,true);
  releaseQueued(); await queuedRun; await pollQueued;
  assert.ok(calls.includes(0) && calls.includes(4), 'periodic CAPS and STOP run after the queued transaction');
  assert.equal(overlap,false,'periodic commands and a live status query share one HID serial chain');
  assert.ok(calls.filter(x=>x===0).length >= 2,'a status query can run during periodic capture without interleaving');
  await send('R'); auto = true;
  let stopFailed = false, finish = false;
  const session = { connected:true, usingMock:false, busy:false, setBusy(v){ this.busy=v; },
    hid:{ async xfer(cmd,data){
      if (data[0]===4 && !stopFailed){stopFailed=true;throw Error('STOP transport failure');}
      return xfer(cmd,data);
    } },
  };
  await assert.rejects(runSessionPeriodic(session,BUS.I2C,[{period:10,count:0,records:[i2c]}],{
    shouldStop:()=>finish,onResult(){finish=true;},
  }),/STOP transport failure/);
  assert.ok(session.busy && session._periodic?.client.owned,'unconfirmed STOP retains ownership');
  assert.throws(()=>runSessionPeriodic(session,BUS.I2C,[]),/已有/);
  await stopSessionPeriodic(session);assert.equal(session.busy,false);assert.equal(session._periodic,null);
  // Runner routing/decoding must use probe records, never transaction/sendFrames per tick.
  let planned;
  const events = [];
  const ir = new I2cRunner({ usingMock:false, setBusy(){}, log(){}, async runPeriodic(groups, opts){
    planned = groups; opts.onResult({ slot:0,step:0,cycle:1,err:0,data:Uint8Array.of(1),timeMs:10,skipped:0 },groups[0]);
  }, transaction(){ throw Error('host timing used'); } }, { onEvent:e => events.push(e) });
  await ir.run([{ kind:'xfer',dev:0x48,addr:[0],wr:[],rd:1,period:10,count:1,group:1 }]);
  assert.equal(planned[0].records[0].kind, BUS.I2C);assert.equal(ir.stats.ticks,1);
  const sr = new SpiRunner({ usingMock:false, log(){}, async runPeriodic(groups, opts){
    planned=groups;opts.onResult({ step:0,cycle:1,err:0,data:Uint8Array.of(1),timeMs:10,skipped:0 },groups[0]);
  }, sendFrames(){ throw Error('host timing used'); } });
  await sr.start({ errors:[],items:[{ type:SPI.T.XFER,payload:SPI.xferPayload({ rxLen:1 }),period:10,count:1,group:1 }] });
  if (sr._probeTask) await sr._probeTask;
  assert.equal(sr.stat.ticks,1);assert.equal(sr.timers.size,0);
  console.log('bus-periodic: production C/JS ABI, independent cadence, fragments, groups, cancellation, overflow and runner routing PASS');
} finally {
  child.stdin.end(); await exited; rmSync(dir,{recursive:true,force:true});
}
