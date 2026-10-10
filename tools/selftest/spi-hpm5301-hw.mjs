/**
 * HPM5301EVKLite → akaLinkPro SPI2 全双工回显与速率爬升真机验收。
 *
 * 前置：目标烧入 hpm5301evklite_spi_echo/fw.elf；PB10/11/12/13 同名连接并共地；
 * 本地页面与 CDP 浏览器已启动。每档 64×256 B，逐字节核对 MISO 和上一帧 MOSI。
 */
import { Cdp, DEV_RE, sleep } from './cdp-lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { F, T, linesToTcfg, xferPayload } from '../../app/spi/protocol.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const value = argv.find(item => item.startsWith(`--${name}=`));
  return value ? value.split('=').slice(1).join('=') : fallback;
};
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const RATES = arg('sclk', '10').split(',').map(Number).filter(n => n > 0);
const FRAMES_PER_RATE = Math.max(16, Math.min(256, Number(arg('frames', '64')) | 0));
const BATCH_FRAMES = Math.max(1, Math.min(16, Number(arg('batch', '1')) | 0));
const MODE = Math.max(0, Math.min(3, Number(arg('mode', '0')) | 0));
const CS = Math.max(0, Math.min(3, Number(arg('cs', '0')) | 0));
const OUT = resolve(arg('out', 'docs/validation/2026-10-10-hpm5301-spi-dma.json'));
const BYTES_PER_FRAME = 256;
const nap = ms => sleep(ms);
let pass = 0, fail = 0;
const ok = (condition, label, detail = '') => {
  if (condition) { pass++; console.log(`  PASS  ${label}${detail ? ` · ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` · ${detail}` : ''}`); }
};
const sig = Uint8Array.from({ length: BYTES_PER_FRAME }, (_, i) => 0x5a ^ (i * 37));
const makeTx = n => Uint8Array.from({ length: BYTES_PER_FRAME }, (_, i) => (n * 29 + i * 73 + (i >>> 1) * 11) & 0xff);
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const bitCount = value => { let n=value; n=n-((n>>>1)&0x55); n=(n&0x33)+((n>>>2)&0x33); return (((n+(n>>>4))&0x0f)*0x01); };

function item(tx, index){
  return {
    type: T.XFER,
    flags: F.RSP,
    label: `HPM5301 echo #${index}`,
    payload: xferPayload({ tcfg: linesToTcfg(1), tx, rxLen: BYTES_PER_FRAME }),
  };
}

const cdp = new Cdp(CDP);
try {
  await cdp.connect();
  await cdp.send('Page.navigate', { url: APP + '?spi-hpm5301=' + Date.now() });
  for (let i = 0; i < 100; i++){
    if (await cdp.eval('return !!window.__tools?.spiSession;').catch(() => false)) break;
    await nap(250);
  }
  if (!await cdp.eval('return !!window.__tools?.spiSession;')) throw new Error('SPI 页面模块未加载；确认本地服务地址和浏览器');
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.eval(`document.querySelector('#tabs .tab[data-tab="spi"]')?.click();
    (async()=>{ const t=window.__tools; try{await t.dbg?.disconnect?.();}catch{} try{await t.rtt?.disconnect?.();}catch{} try{await t.scope?.releaseProbe?.('SPI 真机测试');}catch{} })(); return true;`);
  await nap(350);

  console.log('== 连接 akaLinkPro HID / SPI WebUSB ==');
  const hid0 = await cdp.json('({connected:window.__tools.spiSession.connected,label:window.__tools.spiSession.hid?.label||""})');
  if (!hid0.connected){
    await cdp.eval('document.getElementById("sp-connect").click(); return true;', true);
    await cdp.settle(DEV_RE, 'window.__tools.spiSession.connected', 30000);
  }
  const hid = await cdp.json('({connected:window.__tools.spiSession.connected,label:window.__tools.spiSession.hid?.label||""})');
  ok(hid.connected, `HID 连接（${hid.label || 'akaLinkPro'}）`);
  if (!hid.connected) throw new Error('HID 连接失败');

  const usb0 = await cdp.eval('return !!window.__tools.spiSession.dataReady;');
  if (!usb0){
    await cdp.eval('document.getElementById("sp-usb").click(); return true;', true);
    await cdp.settle(/akaLinkPro|CMSIS|WinUSB|Composite/i, 'window.__tools.spiSession.dataReady', 30000);
  }
  const usb = await cdp.json('({ready:window.__tools.spiSession.dataReady,iface:window.__tools.spiSession.transport?.iface||null,label:window.__tools.spiSession.transport?.label||""})');
  ok(usb.ready, `SPI 数据端点连接（接口 ${usb.iface}）`);
  if (!usb.ready) throw new Error('SPI WebUSB 数据端点未连接');

  console.log(`== 配置 Mode ${MODE} / CS policy ${CS}，启用桥 ==`);
  await cdp.eval('document.getElementById("sp-get").click(); return true;');
  await nap(300);
  const original = await cdp.json('({enabled:window.__tools.spiSession.enabled,cfg:window.__tools.spiSession.cfg})');
  if (original.enabled) await cdp.eval('await window.__tools.spiSession.setEnabled(false,"bus"); return true;');
  await cdp.eval(`const $=id=>document.getElementById(id);
    $('sp-mode').value='${MODE}'; $('sp-cs').value='${CS}'; $('sp-thr').value='100'; return true;`);
  const initial = await cdp.eval(`const r=await window.__tools.spiSession.applyConfig(window.__tools.spi.readCfgFromUI(),'bus');
    return {cfg:r.cfg,diffs:r.diffs};`);
  ok(initial.cfg?.mode === MODE && initial.cfg?.csPolicy === CS, `Mode ${MODE} 与 CS policy ${CS} 配置已回读`);
  const en = await cdp.eval('return await window.__tools.spiSession.setEnabled(true,"bus");');
  ok(en && (await cdp.eval('return window.__tools.spiSession.enabled;')), 'SPI 桥已使能');
  if (!en) throw new Error('SPI 桥未能使能');

  console.log('== 速率测试：逐档同步，再校验 DMA 回显上一笔 MOSI ==');
  let carry = sig;
  let globalFrame = 0;
  const results = [];

  for (const mhz of RATES){
    const requested = mhz * 1e6;
    await cdp.eval(`const e=document.getElementById('sp-sclk');
      if(![...e.options].some(o=>Number(o.value)===${requested}))e.add(new Option('${mhz} MHz 验收档','${requested}'));
      e.value=${requested}; return true;`);
    const applied = await cdp.eval('const r=await window.__tools.spiSession.applyConfig(window.__tools.spi.readCfgFromUI(),"bus"); return {cfg:r.cfg,diffs:r.diffs};');
    const actualCfg = applied.cfg?.sclkHz;
    const cfgOk = actualCfg === requested;
    ok(cfgOk, `${mhz} MHz 档配置回读`, `请求 ${requested} Hz / 实际配置 ${actualCfg} Hz`);
    if (!cfgOk){ results.push({requestedMHz:mhz,actualHz:actualCfg,failed:FRAMES_PER_RATE,configMismatch:true}); continue; }

    // Each rate starts with two known transactions, recovering phase after a
    // failed high-speed tier rather than hiding all later rate results.
    const syncTx0 = makeTx(0x13579 + mhz * 2);
    const syncTx1 = makeTx(0x1357a + mhz * 2);
    const sync = await cdp.eval(`const s=window.__tools.spiSession;
      const a=${JSON.stringify([...item(syncTx0, `sync-${mhz}-0`).payload])};
      const b=${JSON.stringify([...item(syncTx1, `sync-${mhz}-1`).payload])};
      const opts={quiet:true,tag:'bus',timeoutMs:2500,batchBytes:8192};
      const r0=await s.sendFrames([{type:${T.XFER},flags:${F.RSP},label:'HPM5301 sync 0',payload:new Uint8Array(a)}],opts);
      const r1=await s.sendFrames([{type:${T.XFER},flags:${F.RSP},label:'HPM5301 sync 1',payload:new Uint8Array(b)}],opts);
      return {failed:(r0.failed||0)+(r1.failed||0),rsp:r1.rsps?.[0]?{status:r1.rsps[0].status,data:Array.from(r1.rsps[0].data||[])}:null};`);
    const syncOk = !sync.failed && sync.rsp?.status === 0 && equal(Uint8Array.from(sync.rsp.data || []), syncTx0);
    const syncGot=Uint8Array.from(sync.rsp?.data||[]);
    const syncBitErrors=syncGot.length===syncTx0.length?syncGot.reduce((n,v,i)=>n+bitCount(v^syncTx0[i]),0):null;
    const syncDetail = { failed:sync.failed, responseStatus:sync.rsp?.status ?? null,
      responseBytes:sync.rsp?.data?.length ?? 0, prefix:sync.rsp?.data?.slice(0, 12) ?? null,
      expectedPrefix:[...syncTx0.subarray(0,12)], bitErrors:syncBitErrors };
    ok(syncOk, `${mhz} MHz 双帧同步`, syncOk ? '第二帧正确回显第一帧' : JSON.stringify(syncDetail));
    if (!syncOk){
      const status=await cdp.eval('await window.__tools.spiSession.pollStatus(true); return {actual:window.__tools.spiSession.counters.actualSclkHz,counters:window.__tools.spiSession.counters};');
      results.push({requestedMHz:mhz,actualHz:status.actual||actualCfg,failed:FRAMES_PER_RATE,syncFailed:true,sync:syncDetail,
        bitErrors:syncBitErrors,comparedBits:syncBitErrors===null?0:BYTES_PER_FRAME*8,ber:syncBitErrors===null?null:syncBitErrors/(BYTES_PER_FRAME*8),counters:status.counters});
      continue;
    }
    carry = syncTx1;

    let checked = 0, bad = 0, statusErr = 0, byteErr = 0, bitErrors = 0, noReply = 0;
    const samples = [];
    const beforeStats = await cdp.eval('await window.__tools.spiSession.pollStatus(true); return window.__tools.spiSession.counters;');
    const t0 = performance.now();
    for (let offset = 0; offset < FRAMES_PER_RATE; offset += BATCH_FRAMES){
      const count = Math.min(BATCH_FRAMES, FRAMES_PER_RATE - offset);
      const txs = Array.from({ length: count }, (_, j) => makeTx(globalFrame + j));
      const expected = txs.map((_, j) => j === 0 ? carry : txs[j - 1]);
      const items = txs.map((tx, j) => item(tx, globalFrame + j));
      const encoded = items.map(it => ({ type: it.type, flags: it.flags, label: it.label, payload: [...it.payload] }));
      const batch = await cdp.eval(`const s=window.__tools.spiSession;
        const items=${JSON.stringify(encoded)}.map(x=>({...x,payload:new Uint8Array(x.payload)}));
        const r=await s.sendFrames(items,{quiet:true,tag:'bus',timeoutMs:2500,batchBytes:8192});
        return {sent:r.sent,failed:r.failed,rsps:r.rsps.map(x=>x?{status:x.status,data:Array.from(x.data||[]),error:x.error?.message||null}:null)};`);
      if (batch.failed) bad += batch.failed;
      for (let j = 0; j < count; j++){
        const rsp = batch.rsps[j];
        if (!rsp){ noReply++; bad++; continue; }
        if (rsp.status !== 0){ statusErr++; bad++; continue; }
        const got = Uint8Array.from(rsp.data || []);
        if (!equal(got, expected[j])){
          byteErr++; bad++;
          bitErrors += got.length===expected[j].length ? got.reduce((n,v,i)=>n+bitCount(v^expected[j][i]),0) : Math.max(got.length,expected[j].length)*8;
          if (samples.length < 4) samples.push({ frame: globalFrame + j,
            expected: [...expected[j].subarray(0, 16)], received: [...got.subarray(0, 16)],
            tx: [...txs[j].subarray(0, 16)], length: got.length });
        }
        else checked++;
      }
      carry = txs.at(-1);
      globalFrame += count;
      if (batch.failed) break;
    }
    const elapsedMs = performance.now() - t0;
    const status = await cdp.eval('await window.__tools.spiSession.pollStatus(true); return {counters:window.__tools.spiSession.counters,actual:window.__tools.spiSession.counters.actualSclkHz};');
    const rateMBps = checked * BYTES_PER_FRAME / (elapsedMs / 1000) / 1e6;
    const result = { requestedMHz: mhz, actualHz: status.actual, frames: checked, failed: bad,
      statusErr, byteErr, bitErrors, comparedBits:FRAMES_PER_RATE*BYTES_PER_FRAME*8,
      ber:bitErrors/(FRAMES_PER_RATE*BYTES_PER_FRAME*8), noReply, elapsedMs, oneWayMBps: rateMBps,
      counters: status.counters ? { framesOk: status.counters.framesOk-beforeStats.framesOk,
        framesErr: status.counters.framesErr-beforeStats.framesErr,
        bytesTx: status.counters.bytesTx-beforeStats.bytesTx, bytesRx: status.counters.bytesRx-beforeStats.bytesRx,
        lastTicks:status.counters.lastTicks,lastUs:status.counters.lastUs,
        probeBusMBps:status.counters.lastUs ? BYTES_PER_FRAME/status.counters.lastUs : null } : null };
    results.push(result);
    console.log(`  ${mhz} MHz 请求 → ${(status.actual / 1e6).toFixed(2)} MHz 实际；${checked}/${FRAMES_PER_RATE} 帧一致，`+
      `${bad} 错 / BER ${(result.ber*1000000).toFixed(1)} ppm；WebUSB ${(rateMBps).toFixed(3)} MB/s；`+
      `探针 SPI 事务 ${(result.counters?.probeBusMBps ?? 0).toFixed(3)} MB/s（${result.counters?.lastUs ?? '?'} µs/帧）；`+
      `frames_err=${status.counters?.framesErr ?? '?'} bytes_rx=${status.counters?.bytesRx ?? '?'}`);
    const clean = checked === FRAMES_PER_RATE && bad === 0 && (result.counters?.framesErr ?? 0) === 0;
    if (!clean && samples.length) console.log('    mismatch samples: ' + JSON.stringify(samples));
    ok(clean, `${mhz} MHz SPI 回环数据校验`, `${checked}/${FRAMES_PER_RATE} 帧正确，状态错 ${statusErr}，字节错 ${byteErr}，无响应 ${noReply}`);
  }

  await cdp.eval('await window.__tools.spiSession.setEnabled(false,"bus"); return true;');
  const errors = await cdp.eval('return {errors:window.__tools.summary().errors,counters:window.__tools.spiSession.counters};');
  ok(errors.errors.length === 0, '页面无未处理异常', JSON.stringify(errors.errors.slice(0, 3)));
  console.log('\n===== HPM5301 SPI 真机结果 =====');
  for (const r of results) console.log(`${r.requestedMHz} MHz -> ${(r.actualHz / 1e6).toFixed(2)} MHz, `+
    `${r.frames ?? 0}/${FRAMES_PER_RATE} frames, ${(r.oneWayMBps ?? 0).toFixed(3)} MB/s, ${r.failed} errors`);
  console.log(`\n${fail ? 'FAIL' : 'PASS'} spi-hpm5301-hw: ${pass} 通过 / ${fail} 失败`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ board:'HPM5301EVKLite', target:'SPI2 DMA Slave', probe:'akaLinkPro SPI Master', mode:MODE,csPolicy:CS,
    wiring:'PB10/11/12/13 one-to-one + GND', frameBytes:BYTES_PER_FRAME, framesPerRate:FRAMES_PER_RATE,
    batchFrames:BATCH_FRAMES, results, pass, fail, at:new Date().toISOString() }, null, 2));
  console.log(`结果已保存：${OUT}`);
  process.exitCode = fail ? 1 : 0;
} finally {
  try { await cdp.eval('if(window.__tools?.spiSession?.enabled) await window.__tools.spiSession.setEnabled(false,"bus"); return true;'); } catch {}
  // Retire a possible outstanding EP11 OUT DMA with a ZLP before handing the
  // probe's shared SPI buffers to SPI->CDC slave mode. The firmware's shared
  // buffer lease cannot be released while a native OUT descriptor is armed.
  try { await cdp.eval(`const s=window.__tools?.spiSession;
    if(s?.transport?.device && s.transport.epOut!==undefined){
      await s.transport.device.transferOut(s.transport.epOut,new Uint8Array(0));
      await s.pollStatus(true);
    } return true;`); } catch {}
  try { await cdp.eval('await window.__tools?.spiSession?.disconnect?.(); return true;'); } catch {}
  cdp.close();
}
