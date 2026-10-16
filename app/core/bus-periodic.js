/** Probe-side periodic bus engine (firmware bus_periodic.h, HID 0x37).
 * Browser waits only drain results; they never determine the bus sampling period. */
import { waitMs } from './pace.js';
export const CMD = 0x37;
export const BUS = { I2C: 1, SPI: 2, DELAY: 3, ADC: 4 };
const ACT = { CAPS: 0, CLEAR: 1, PUT: 2, START: 3, STOP: 4, STATUS: 5, READ: 6, ACK: 7, RUN: 8 };
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const word = (b, off) => view(b).getUint32(off, true);
const errors = ['OK', '参数超限', '采集引擎或总线忙', '状态不匹配', '没有结果', '结果缓冲满'];
export function program(records){
  if (!records.length || records.length > 16) throw Error('probe 周期任务每组需要 1–16 条命令');
  const size = records.reduce((n, r) => n + 4 + r.data.length, 0);
  if (size > 512) throw Error('probe 周期任务每组最多 512 字节');
  const out = new Uint8Array(size); let off = 0;
  for (const r of records){
    if (r.data.length > 128) throw Error('probe 周期任务单条命令最多 128 字节');
    out[off] = r.kind; view(out).setUint16(off + 2, r.data.length, true);
    out.set(r.data, off + 4); off += 4 + r.data.length;
  }
  return out;
}
export function delayRecord(us){
  if (!Number.isInteger(us) || us < 0 || us > 60000000) throw Error('probe 延时需为 0–60000000 微秒整数');
  const b = new Uint8Array(4); view(b).setUint32(0, us, true);
  return { kind: BUS.DELAY, data: b };
}
export class BusPeriodicClient {
  constructor(xfer){ this.xfer = xfer; this.owned = false; this.stopError = null; }
  async command(action, args = new Uint8Array(), { empty = false } = {}){
    const res = await this.xfer(CMD, Uint8Array.of(action, ...args));
    if (!res || res.length < 7 || res[0] < 8 || res[1] !== CMD || res[2] !== action)
      throw Error('固件未支持 probe 周期采集，或响应不完整；请导入配套固件');
    const rc = word(res, 3);
    if (empty && rc === 4) return null;
    if (rc) throw Error(`probe 周期采集：${errors[rc] || rc}`);
    if (res[0] > res.length + 1) throw Error('probe 周期响应被截断');
    return res.subarray(7, res[0] - 1);
  }
  async status(){
    const b = await this.command(ACT.STATUS);
    if (b.length !== 20) throw Error('probe 周期状态长度错误');
    return { active: word(b, 0), queued: word(b, 4), fault: word(b, 8), epoch: word(b, 12), cleanup: word(b, 16) };
  }
  async stop(){
    if (!this.owned) return;
    try {
      await this.command(ACT.STOP, Uint8Array.of(255));
      const deadline = performance.now() + 3000;
      for (;;){
        const s = await this.status();
        if (!s.active && !s.cleanup) break;
        if (performance.now() >= deadline) throw Error('probe 周期停止未确认');
        await waitMs(5);
      }
      this.owned = false; this.stopError = null;
    } catch (e){ this.stopError = e; throw e; }
  }
  async read(){
    const b = await this.command(ACT.READ, Uint8Array.of(0), { empty: true });
    if (!b) return null;
    if (b.length < 24 || b[23] > 54 || b.length !== 24 + Math.min(32, b[23]))
      throw Error('probe 周期结果长度错误');
    const r = { seq: word(b, 0), epoch: word(b, 4), cycle: word(b, 8), timeMs: word(b, 12),
      skipped: word(b, 16), slot: b[20], step: b[21], err: b[22], data: new Uint8Array(b[23]) };
    r.data.set(b.subarray(24));
    if (r.data.length > 32){
      const tail = await this.command(ACT.READ, Uint8Array.of(32));
      if (tail.length !== 24 + r.data.length - 32 || word(tail, 0) !== r.seq ||
          word(tail, 4) !== r.epoch || tail[23] !== r.data.length) throw Error('probe 周期结果分片身份不一致');
      r.data.set(tail.subarray(24), 32);
    }
    const ack = new Uint8Array(4); view(ack).setUint32(0, r.seq, true);
    await this.command(ACT.ACK, ack); // Remove only the exact record we reconstructed.
    return r;
  }
  async run(bus, groups, { signal, shouldStop = () => false, onResult = () => {} } = {}){
    const stopped = () => signal?.aborted || shouldStop();
    if (!groups.length || groups.length > 8) throw Error('probe 周期采集支持 1–8 个任务组');
    const plans = groups.map(g => {
      if (!Number.isInteger(g.period) || g.period < 1 || g.period > 60000 ||
          !Number.isInteger(g.count || 0) || g.count < 0 || g.count > 0xFFFFFFFF)
        throw Error('probe 周期需为 1–60000 ms 整数，次数需为非负整数');
      return program(g.records);
    });
    const caps = await this.command(ACT.CAPS);
    if (String.fromCharCode(...caps.subarray(0, 4)) !== 'BPT1' || caps.length !== 10)
      throw Error('固件未支持 BPT1 周期采集');
    if (stopped()) return;
    let operationError;
    try {
      await this.command(ACT.CLEAR); this.owned = true;
      for (let slot = 0; slot < groups.length; slot++){
        const bytes = plans[slot];
        for (let off = 0; off < bytes.length; off += 55){
          if (stopped()) return;
          const chunk = bytes.subarray(off, off + 55);
          await this.command(ACT.PUT, Uint8Array.of(slot, bus, off & 255, off >>> 8, chunk.length, ...chunk));
        }
      }
      // Upload every group first: no bus work can run during the upload phase.
      for (let slot = 0; slot < groups.length; slot++){
        if (stopped()) return;
        const args = new Uint8Array(9); args[0] = slot;
        view(args).setUint32(1, groups[slot].period, true); view(args).setUint32(5, groups[slot].count || 0, true);
        const b = await this.command(ACT.START, args);
        if (b.length !== 4) throw Error('probe 周期启动应答错误');
        groups[slot].epoch = word(b, 0);
      }
      if (stopped()) return;
      await this.command(ACT.RUN);
      while (!stopped()){
        // Bounded UI work per drain; polling cadence does not control acquisition.
        for (let n = 0; n < 32 && !stopped(); n++){
          const r = await this.read(); if (!r) break;
          const g = groups[r.slot];
          if (!g || g.epoch !== r.epoch || r.step >= g.records.length) throw Error('probe 周期结果任务身份不匹配');
          if (!stopped()) onResult(r, g);
        }
        if (stopped()) break;
        const s = await this.status();
        if (s.fault) throw Error(`probe 周期采集已停止：${errors[s.fault] || s.fault}，数据未被静默覆盖`);
        if (!s.active && !s.queued && !s.cleanup) break;
        await waitMs(5);
      }
    } catch (error){ operationError = error; throw error; }
    finally {
      try { await this.stop(); }
      catch (cleanup){
        if (operationError) throw new AggregateError([operationError, cleanup], `${operationError.message}；停止也失败：${cleanup.message}`, { cause: operationError });
        throw cleanup;
      }
    }
  }
}

export function runSessionPeriodic(session, bus, groups, opts = {}){
  if (!session.connected || session.usingMock) throw Error('probe 周期采集需要真实探针连接');
  if (session._periodic) throw Error('已有 probe 周期采集在运行');
  const hid = session.hid, controller = new AbortController();
  const xfer = (cmd, data) => session._enqueue
    ? session._enqueue(() => hid.xfer(cmd, data))
    : hid.xfer(cmd, data);
  const client = new BusPeriodicClient(xfer);
  const wasBusy = session.busy;
  session._periodic = { controller, client, promise: null };
  session.setBusy(true);
  // Retire work already queued by the session (for example a STATUS poll)
  // before the periodic client takes exclusive ownership of the same HID link.
  const p = (async () => {
    await session._chain;
    if (!controller.signal.aborted)
      return await client.run(bus, groups, { ...opts, signal: controller.signal });
  })().finally(() => {
    if (!client.stopError){ session._periodic = null; session.setBusy(wasBusy); }
    else session.setBusy(true); // Failed STOP retains ownership for an explicit retry.
  });
  session._periodic.promise = p;
  return p;
}
export async function stopSessionPeriodic(session){
  const run = session._periodic;
  if (!run) return;
  if (run.client.stopError){
    await run.client.stop(); session._periodic = null; session.setBusy(false); return;
  }
  run.controller.abort();
  try { await run.promise; }
  catch (e){ if (run.client.stopError) throw e; }
}
