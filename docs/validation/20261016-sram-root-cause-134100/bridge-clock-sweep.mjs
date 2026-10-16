import { Cdp, sleep } from '../../../tools/selftest/cdp-lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

// A01 定位：转发桥在 60 MHz 档被请求后，探针自报的实际档位分布。
// 每个 start 都是一次独立的 SWD 初始化（固件侧），因此重复启动即可量出"降一档"的概率。
const ELF = new URL('../../../tools/target-firmware/stm32f103_rtt_speed/build-ze/fw.elf', import.meta.url);
const b64 = readFileSync(ELF).toString('base64');
const N = Number(process.argv[2] || 10);
const c = new Cdp(undefined, 180000);
const out = new URL('./', import.meta.url);
const report = { requestedHz: 60000000, samples: [], errors: [] };
try {
  await c.connect();
  await c.send('Page.navigate', { url: `http://127.0.0.1:8899/index.html?t=${Date.now()}#rtt` });
  for (let i = 0; i < 200; i++) {
    if (await c.eval('return !!(window.__tools && window.__tools.hid);').catch(() => false)) break;
    await sleep(100);
  }
  // 转发页（rttcdc tab）+ HID 连接 + 60 MHz 档
  await c.eval(`document.querySelector('.tab[data-tab="rttcdc"]').click()`);
  if (!(await c.json('!!window.__tools.hid.dev?.connected'))) {
    await c.eval(`document.getElementById('h-connect').click()`, true);
    await sleep(1500);
  }
  await c.settle(/./, 'window.__tools.hid.dev?.connected', 15000);
  const clk = await c.json(`(()=>{const k=document.getElementById('h-clock');k.value='60000000';k.dispatchEvent(new Event('change'));return {value:k.value,disabled:k.disabled};})()`);
  report.clockField = clk;
  // 喂 ELF 取 _SEGGER_RTT 精确地址（与 campaign 相同）
  for (let i = 0; i < 3; i++) {
    const r = await c.json(`(async()=>{ const bin=atob(${JSON.stringify(b64)}); const u=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
        const dt=new DataTransfer(); dt.items.add(new File([u],'fw.elf'));
        const inp=window.__tools.hid._elfInput;
        if(!inp) return {err:'no _elfInput'};
        inp.files=dt.files; inp.dispatchEvent(new Event('change'));
        await new Promise(r=>setTimeout(r,500));
        return {addr:document.getElementById('h-addr').value,size:document.getElementById('h-size').value}; })()`);
    if (!r.err) { report.elf = r; break; }
    await sleep(500);
  }
  for (let i = 0; i < N; i++) {
    const sample = { i };
    try {
      await sleep(1200);   // 上一次 stop 之后给固件/页面的状态机一点恢复时间，别把"还没就绪"记成失败
      await c.eval(`document.getElementById('h-start').click()`, true);
      await c.settle(/./, 'window.__tools.hid.last?.running && window.__tools.hid.last?.cbAddr', 25000);
      const st = await c.json(`({mhz:window.__tools.hid.last?.swdMhz, cb:window.__tools.hid.last?.cbAddr, chunk:window.__tools.hid.last?.chunk, yield:window.__tools.hid.last?.dapYield, moved:window.__tools.hid.last?.moved})`);
      sample.result = st;
    } catch (e) {
      sample.error = String(e.message || e);
      report.errors.push(sample.error);
    }
    await c.eval(`(async()=>{ try{ await window.__tools.hid.stop('sweep'); }catch(e){} })()`).catch(() => {});
    await sleep(1200);
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
  }
  const mhz = report.samples.map(s => s.result?.mhz).filter(v => typeof v === 'number');
  report.summary = { requestedMhz: 60, ready: mhz.length, at60: mhz.filter(v => v >= 60).length, below: mhz.filter(v => v < 60).length, values: mhz, timeouts: report.samples.filter(s => s.error).length };
  console.log('SUMMARY ' + JSON.stringify(report.summary));
} catch (e) {
  report.fatal = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('bridge-clock-sweep.json', out), JSON.stringify(report, null, 2));
  c.close();
}
