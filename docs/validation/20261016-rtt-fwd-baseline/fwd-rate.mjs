import { Cdp, sleep } from '../../../tools/selftest/cdp-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * RTT 转发速率 A/B 口径（2026-10-16 用户提出：转发比 akaLinkPro 记录低了）。
 * 同一块板、同一个探针、同一会话下，对**指定页面版本**测「页面 RX / 探针自报 moved」：
 *   node fwd-rate.mjs --app=http://127.0.0.1:8899/index.html --label=current --windows=3
 *   node fwd-rate.mjs --app=http://127.0.0.1:8899/tmp/base-20261004/index.html --label=baseline
 *   --force-buffer=4096 会对 SerialPort.prototype.open 打补丁，强改接收缓冲（用来把
 *   「代码版本」和「CDC 接收缓冲」两个变量分开）。
 */
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : (argv.includes('--' + k) ? true : d); };
const APP = String(arg('app', 'http://127.0.0.1:8899/index.html'));
const LABEL = String(arg('label', 'run'));
const CLOCK = String(arg('clock', '60000000'));
const SECS = Number(arg('secs', 8));
const WINDOWS = Number(arg('windows', 3));
const FORCE_BUFFER = arg('force-buffer', null);
const ROUNDS = Number(arg('rounds', 1));
const RAMP_MS = Number(arg('ramp-ms', 2000));   // 开 CDC 口后先丢掉多少毫秒（campaign 只用 800 ms）
const ELF = new URL('../../../tools/target-firmware/stm32f103_rtt_speed/build-ze/fw.elf', import.meta.url);
const b64 = readFileSync(ELF).toString('base64');
const out = new URL(`fwd-${LABEL}.json`, import.meta.url);
const c = new Cdp(undefined, 180000);
const report = { label: LABEL, app: APP, clock: CLOCK, forceBuffer: FORCE_BUFFER, windows: [], errors: [] };

const sampleExpr = `({ rx: window.__tools.stream.rxc.total, moved: window.__tools.hid.last?.moved || 0,
  t: performance.now(), mhz: window.__tools.hid.last?.swdMhz ?? null, pageRate: document.getElementById('c-rxrate')?.textContent ?? null })`;

try {
  await c.connect();
  await c.send('Page.navigate', { url: APP + '?t=' + Date.now() });
  for (let i = 0; i < 200; i++) {
    if (await c.eval('return !!(window.__tools && window.__tools.hid && window.__tools.stream);').catch(() => false)) break;
    await sleep(100);
  }
  const entry = await c.eval(`return (document.documentElement.dataset.bootEntry || 'source') + '|' + (window.__tools.hid ? 'hid' : 'no-hid');`);
  report.entry = entry;
  if (FORCE_BUFFER) {
    const patch = await c.json(`(async()=>{ const ports = await navigator.serial.getPorts();
      if(!ports.length) return {err:'no granted port'};
      const proto = Object.getPrototypeOf(ports[0]);
      if(!proto.__fwdPatched){ const orig = proto.open;
        proto.open = function(o){ return orig.call(this, { ...o, bufferSize: ${JSON.stringify(String(FORCE_BUFFER))} ? ${Number(FORCE_BUFFER)} : o.bufferSize }); };
        proto.__fwdPatched = true; }
      return { patched: true, bufferSize: ${Number(FORCE_BUFFER)} }; })()`);
    report.bufferPatch = patch;
  }
  await c.eval(`await __tools.probeManager?.releaseOthers?.(null, 'RTT 转发速率 A/B').catch(()=>{}); return true;`).catch(() => {});
  // 可选：先跑一段 RTT Viewer（复刻 campaign 的顺序：Viewer 6 s → 转发），再看对转发有无影响
  const viewerSecs = Number(arg('viewer-first', 0));
  if (viewerSecs > 0) {
    await c.eval(`document.querySelector('.tab[data-tab="rtt"]')?.click(); return true;`);
    await sleep(400);
    await c.eval(`(()=>{const b=document.getElementById('r-backend'); if(b){b.value='webusb'; b.dispatchEvent(new Event('change'));}
      const rr=document.getElementById('r-range'); if(rr) rr.value='0x20000000-0x20008000'; return true;})()`);
    await c.eval(`document.getElementById('r-usb-connect').click(); return true;`, true);
    await c.settle(/./, 'window.__tools.rtt?.rtt', 15000).catch(() => {});
    const viewer = await c.json(`({ rtt: !!window.__tools.rtt?.rtt, running: !!window.__tools.rtt?.running, bytes: window.__tools.rtt?.stats?.bytes || 0 })`).catch(() => ({}));
    report.viewer = viewer;
    await sleep(viewerSecs * 1000);
    report.viewerAfter = await c.json(`({ bytes: window.__tools.rtt?.stats?.bytes || 0, polls: window.__tools.rtt?.stats?.polls || 0 })`).catch(() => ({}));
    await c.eval(`(async()=>{ try{ await window.__tools.rtt.disconnect(); }catch(e){} return true; })()`).catch(() => {});
    await sleep(800);
  }
  await c.eval(`document.querySelector('.tab[data-tab="rttcdc"]')?.click(); return true;`).catch(() => {});
  await sleep(400);
  // HID 连接（老页面也一样有 #h-connect / #h-reconnect）
  if (!(await c.json('!!window.__tools.hid.dev?.connected'))) {
    await c.eval(`document.getElementById('h-connect')?.click(); return true;`, true);
    await sleep(1500);
  }
  await c.settle(/./, 'window.__tools.hid.dev?.connected', 20000);
  const clk = await c.json(`(()=>{const k=document.getElementById('h-clock');k.value=${JSON.stringify(CLOCK)};k.dispatchEvent(new Event('change'));
    return {value:k.value,disabled:k.disabled,options:[...k.options].map(o=>o.value)};})()`);
  report.clockField = { value: clk.value, disabled: clk.disabled, hasClock: clk.options.includes(CLOCK) };
  // 喂 ELF 取 _SEGGER_RTT
  for (let i = 0; i < 3; i++) {
    const r = await c.json(`(async()=>{ const bin=atob(${JSON.stringify(b64)}); const u=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
      const dt=new DataTransfer(); dt.items.add(new File([u],'fw.elf'));
      const inp=window.__tools.hid._elfInput; if(!inp) return {err:'no _elfInput'};
      inp.files=dt.files; inp.dispatchEvent(new Event('change'));
      await new Promise(r=>setTimeout(r,600));
      return {addr:document.getElementById('h-addr').value,size:document.getElementById('h-size').value}; })()`);
    if (!r.err) { report.elf = r; break; }
    await sleep(500);
  }
  for (let round = 1; round <= ROUNDS; round++) {
    // 起桥
    await c.eval(`document.getElementById('h-start').click(); return true;`, true);
    let started = false;
    for (let i = 0; i < 60; i++) {
      const st = await c.json(`({running: !!window.__tools.hid.last?.running, cb: window.__tools.hid.last?.cbAddr || 0})`).catch(() => ({}));
      if (st.running && st.cb) { started = true; break; }
      await sleep(500);
    }
    if (!started) { report.errors.push(`round ${round}: 桥没起来`); continue; }
    // 开 CDC 口
    if (!(await c.json('!!window.__tools.session.isOpen').catch(() => false))) {
      await c.eval(`document.getElementById('c-open').click(); return true;`, true);
      await c.settle(/./, 'window.__tools.session.isOpen', 20000);
    }
    await sleep(RAMP_MS);                    // 起跑让路/积压排空（campaign 口径是 800 ms）
    const first = await c.json(sampleExpr);
    report.rounds = report.rounds || [];
    const roundData = { round, mhz: first.mhz, samples: [first] };
    for (let w = 0; w < WINDOWS; w++) {
      await sleep(SECS * 1000);
      roundData.samples.push(await c.json(sampleExpr));
    }
    const rates = [];
    for (let i = 1; i < roundData.samples.length; i++) {
      const a = roundData.samples[i - 1], b = roundData.samples[i];
      const dt = (b.t - a.t) / 1000;
      rates.push({ rxMBs: (b.rx - a.rx) / dt / 1e6, movedMBs: (b.moved - a.moved) / dt / 1e6, dt: +dt.toFixed(2),
                   pageRate: b.pageRate, mhz: b.mhz });
    }
    roundData.rates = rates;
    roundData.mean = {
      rxMBs: +(rates.reduce((s, r) => s + r.rxMBs, 0) / rates.length).toFixed(3),
      movedMBs: +(rates.reduce((s, r) => s + r.movedMBs, 0) / rates.length).toFixed(3),
    };
    roundData.lastStatus = await c.json(`window.__tools.hid.last || null`).catch(() => null);
    report.windows.push(roundData);
    console.log(JSON.stringify({ label: LABEL, round, mhz: roundData.mhz, mean: roundData.mean, rates: rates.map(r => ({ rx: +r.rxMBs.toFixed(3), moved: +r.movedMBs.toFixed(3) })) }));
    // 收尾：停桥、关口
    await c.eval(`(async()=>{ try{ await window.__tools.session.close(); }catch(e){}
      try{ document.getElementById('h-stop').click(); }catch(e){} return true; })()`).catch(() => {});
    await sleep(1200);
  }
  report.passed = true;
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(out, JSON.stringify(report, null, 2));
  c.close();
}
