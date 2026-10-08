/** 从当前页面采集内置模拟波形，验证数据后截取 README 展示图；不连接硬件、不修改数据。 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Cdp, sleep } from '../selftest/cdp-lib.mjs';

const base = process.env.CDP_BASE || 'http://127.0.0.1:9333';
const url = `${process.env.PAGE_BASE || 'http://127.0.0.1:8899'}/index.html?readme-showcase=scope#scope`;
const page = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const cdp = new Cdp(base, 30000);
try {
  cdp.ws = await cdp._open(page.webSocketDebuggerUrl, (_, message) => cdp._dispatch(message));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 100; i++) {
    if (await cdp.eval('return !!window.__tools?.scope;')) break;
    await sleep(100);
  }
  await cdp.eval(`
    const sc = window.__tools.scope;
    document.getElementById('sc-mock').checked = true;
    await sc.setMock(true);
    for (const v of [...sc.selected]) sc.toggleVar(v, false);
    for (const i of [0, 3, 4]) sc.toggleVar(sc.mockVars()[i], true);
    document.getElementById('sc-period').value = '100';
    document.getElementById('sc-seconds').value = '2';
    document.querySelector('[data-group=sclayout] [data-v=lanes]').click();
    await sc.start();
  `);
  for (let i = 0; i < 100; i++) {
    if (await cdp.eval('return window.__tools.scope.store?.count >= 8000;')) break;
    await sleep(100);
  }
  const verification = await cdp.eval(`
    const sc = window.__tools.scope;
    await sc.stop();
    const st = sc.store;
    let mismatches = 0, timeGaps = 0, maxSineDelta = 0;
    for (let i = 0; i < st.count; i++) {
      const expected = [Math.fround(Math.sin(i * 0.02)), i % 1000, i % 10 < 5 ? 1000 : -1000];
      for (let k = 0; k < 3; k++) if (st.channel(k).at(i) !== expected[k]) mismatches++;
      if (i) {
        if (Math.abs(st.timeAt(i) - st.timeAt(i - 1) - 100) > 0.1) timeGaps++;
        maxSineDelta = Math.max(maxSineDelta, Math.abs(st.channel(0).at(i) - st.channel(0).at(i - 1)));
      }
    }
    sc.follow = false;
    sc.renderer.zoomTo(0, 600);
    sc.renderer.cursor = null;
    sc.renderer.setMark('a', 79);
    sc.renderer.setMark('b', 393);
    sc.drawFrame();
    return { summary: sc.summary(), mismatches, timeGaps, maxSineDelta };
  `);
  assert.equal(verification.summary.mode, 'mock');
  assert.ok(verification.summary.samples >= 8000);
  assert.equal(verification.summary.lost, 0);
  assert.equal(verification.summary.readErrors, 0);
  assert.equal(verification.summary.resyncs, 0);
  assert.equal(verification.mismatches, 0);
  assert.equal(verification.timeGaps, 0);
  assert.ok(verification.maxSineDelta < 0.021);
  await sleep(300);
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync('docs/shots/readme-scope-demo.png', Buffer.from(screenshot.data, 'base64'));
  writeFileSync('docs/shots/readme-scope-demo.json', JSON.stringify({
    description: '当前 J-Scope 内置模拟数据的界面演示，不是硬件性能验收。原始页面截图，无图片后期修改。',
    capturedAt: new Date().toISOString(), url, viewport: { width: 1600, height: 1000 }, ...verification,
  }, null, 2) + '\n');
  console.log(JSON.stringify(verification, null, 2));
} finally {
  cdp.close();
  await fetch(`${base}/json/close/${page.id}`);
}
