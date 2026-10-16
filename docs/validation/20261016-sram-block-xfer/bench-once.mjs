import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// 产品口径单点复测：页面 FlashView.benchmarkSram()（20 KiB × 3 轮写 + 3 轮读，含校验），
// 与 micro.mjs 的裸帧口径在同一会话里对比，用来判断"产品层还有多少可回收开销"。
const out = new URL('./', import.meta.url);
const c = new Cdp(undefined, 240000);
const report = { runs: [] };
try {
  await c.connect();
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html?bench=' + Date.now() + '#flash' });
  for (let i = 0; i < 200; i++) { if (await c.eval('return !!window.__tools?.flash;').catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
  await c.eval(`await __tools.probeManager.releaseOthers(null,'SRAM 产品口径复测');
    document.getElementById('f-chip').value='stm32f103';document.getElementById('f-chip').dispatchEvent(new Event('change'));
    document.getElementById('f-backend').value='webusb';document.getElementById('f-backend').dispatchEvent(new Event('change'));
    document.getElementById('f-ram-address').value='0x20000000';document.getElementById('f-ram-length').value='20480';
    document.getElementById('f-side-sram-tab').click();return true;`);
  for (let r = 0; r < 4; r++) {
    const res = await c.eval(`document.getElementById('f-ram-clock').value='60000'; return await __tools.flash.benchmarkSram();`);
    report.runs.push(res);
    console.log(JSON.stringify({ r, transport: res.transport, clock: res.clockKhz, readMBs: +res.readRate.toFixed(3), writeMBs: +res.writeRate.toFixed(3), readMs: +res.readMs.toFixed(1), writeMs: +res.writeMs.toFixed(1), verified: res.verified }));
  }
  const ok = report.runs.filter(x => x.verified);
  report.mean = { readMBs: +(ok.reduce((s, x) => s + x.readRate, 0) / ok.length).toFixed(3), writeMBs: +(ok.reduce((s, x) => s + x.writeRate, 0) / ok.length).toFixed(3) };
  console.log('MEAN ' + JSON.stringify(report.mean));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('bench-once.json', out), JSON.stringify(report, null, 2));
  c.close();
}
