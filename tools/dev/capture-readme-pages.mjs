/** README 功能预览：真实页面、真实 ELF、内置模型与明确标注的虚拟 ADC 信号，不访问硬件。 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Cdp, sleep } from '../selftest/cdp-lib.mjs';

const base = process.env.CDP_BASE || 'http://127.0.0.1:9333';
const app = process.env.PAGE_BASE || 'http://127.0.0.1:8899';
const requested = process.argv.slice(2);
const scenes = {
  flash: {
    tab: 'flash', description: '真实 ELF 的离线载入与地址解析；尚未连接目标或执行烧录。',
    prepare: String.raw`
      const f = window.__tools.flash;
      const file = new File([await (await fetch('/tools/fixtures/dwarf/stm32f103_scope.elf')).arrayBuffer()], 'stm32f103_scope.elf');
      document.getElementById('f-backend').value = 'webusb';
      document.getElementById('f-chip').value = 'stm32f103'; f._applyChip();
      await f._onFile(file);
      const { parseFirmware } = await import('/app/flash/image.js');
      const raw = new Uint8Array(await file.arrayBuffer());
      const regions = parseFirmware(file.name, raw, 0);
      const hex = n => '0x' + n.toString(16).padStart(8, '0');
      f._log('── ELF 离线检查：载入与解析，尚未烧录 ──');
      f._log('文件：' + file.name + ' · ' + raw.length + ' 字节');
      for (const r of regions) f._log(hex(r.addr) + ' → ' + hex(r.addr + r.data.length - 1) + ' · ' + r.data.length + ' 字节');
      f._log('有效载荷：' + regions.reduce((n, r) => n + r.data.length, 0) + ' 字节');
      f._log('流程：连接探针 → 擦除 / 写入 → 读回校验 → 复位运行');
      f._status('固件已载入 · 尚未烧录');
      return { file: file.name, fileBytes: raw.length, regions: regions.map(r => ({address:r.addr,bytes:r.data.length})), flashed:false };
    `,
    check: s => { assert.equal(s.flashed, false); assert.ok(s.regions.length && s.fileBytes > 1000); },
  },
  rttcdc: {
    tab: 'rttcdc', description: '内置模拟 HID 转发控制与 DemoPort 日志接收；不是实际 RTT 吞吐验收。',
    prepare: String.raw`
      const { hid, stream, session } = window.__tools;
      await hid.start();
      await stream.refreshPorts();
      const demo = stream.ports.findIndex(p => p.constructor.name === 'DemoPort');
      if (demo < 0) throw Error('缺少演示串口');
      document.getElementById('c-port').value = String(demo);
      await stream.connect();
      await new Promise(r => setTimeout(r, 450));
      stream.rx.clear();
      session.port._emit('[DEMO] RTT 转发日志演示 · 数据由页面生成\r\n\r\n');
      for (let i = 0; i < 24; i++) {
        session.port._emit('[' + String(i * 100).padStart(6, '0') + ' ms] ' + ['INFO  main       系统心跳 · loop=' + i, 'DEBUG network    收到数据包 · payload=128 B', 'INFO  sensor     温度=' + (25 + i / 20).toFixed(2) + ' °C', 'DEBUG scheduler  周期任务完成 · queue=0'][i % 4] + '\r\n');
      }
      await new Promise(r => setTimeout(r, 100));
      stream.rx.flush(); stream._stats();
      return { mode: 'mock', bridge: hid.summary(), receivedBytes: stream.rxc.total, port: session.port.constructor.name };
    `,
    check: s => { assert.equal(s.mode, 'mock'); assert.equal(s.port, 'DemoPort'); assert.ok(s.receivedBytes > 1000); },
  },
  dbg: {
    tab: 'dbg', description: '内置 Cortex-M 模型，配合仓库真实 ELF / 源码展示断点、监视变量与单帧回溯；不模拟完整指令执行。',
    prepare: String.raw`
      const d = window.__tools.dbg;
      const elf = await (await fetch('/tools/fixtures/dwarf/stm32f103_scope.elf')).arrayBuffer();
      d.loadElfBuffer(elf, 'stm32f103_scope.elf');
      const files = await Promise.all(['main.c', 'stm32f103_regs.h'].map(async name => new File([await (await fetch('/tools/fixtures/readme/stm32f103_scope/' + name)).text()], name)));
      await d._indexSrcFiles(files);
      document.getElementById('d-backend').value = 'mock';
      document.getElementById('d-backend').dispatchEvent(new Event('change'));
      await d.connect();
      d.clearWatch();
      const main = d.sym.find('main').addr & ~1;
      await d.runLine('r PC 0x' + main.toString(16));
      await d.runLine('r LR 0xffffffff');
      await d.runLine('b main');
      for (const line of ['mw &g_tick 39 30 00 00', 'mw &g_far_cnt 39 30 00 00']) {
        const result = await d.runLine(line); if (result.error) throw Error(result.error);
      }
      const packed = new DataView(new ArrayBuffer(24));
      packed.setFloat32(0,0.588,true); packed.setFloat32(4,-0.2,true); packed.setInt32(8,12345,true);
      packed.setUint16(12,345,true); packed.setInt16(14,1000,true); packed.setUint8(16,57); packed.setInt8(17,-21); packed.setUint32(20,0x10003039,true);
      await d.session.memWrite(d.sym.find('g_pack').addr, new Uint8Array(packed.buffer));
      for (const line of ['w g_tick', 'w g_far_cnt', 'w g_pack', 'bt']) {
        const result = await d.runLine(line); if (result.error) throw Error(result.error);
      }
      document.querySelector('#d-dock-tabs [data-dock=var]').click();
      await d.refreshWatch({force:true});
      document.querySelector('#d-watch-list button[data-exp]').click();
      await d.refreshAll();
      return { mode: 'mock', ...d.summary(), sourceText: document.getElementById('d-src').textContent.slice(0, 200) };
    `,
    check: s => { assert.equal(s.mode, 'mock'); assert.ok(s.connected && s.elf && s.sourceText); assert.equal(s.watch[0].value, '12345'); assert.equal(s.src.cur.line, 132); },
  },
  panel: {
    tab: 'panel', description: '内置模拟 SPI/QSPI 探针和屏幕 GRAM，展示 ST77916 四线发图；不代表实屏或硬件传输速率。',
    prepare: String.raw`
      const { spiSession:s, panel:p } = window.__tools;
      await s.setMock(true);
      document.getElementById('pn-preset').value = 'st77916';
      document.getElementById('pn-preset').dispatchEvent(new Event('change'));
      await p.applyPreset();
      await s.setEnabled(true, p.tag);
      p.setPattern('BAR');
      await p.sendImage();
      await s.pollStatus(true);
      return {enabled:s.enabled, ...p.summary()};
    `,
    check: s => { assert.equal(s.mock, true); assert.equal(s.enabled, true); assert.equal(s.geomW, 360); assert.equal(s.parseErrors, 0); assert.ok(s.bytesTx >= 259200); assert.equal(s.framesErr, 0); },
  },
  adc: {
    tab: 'analog', description: '虚拟 1 kHz 正弦，1.65 V 偏置、1.8 Vpp、16 位量化、200 kSa/s；注入页面数据层，不连接硬件 ADC。',
    prepare: String.raw`
      const a = window.__tools.analog;
      const rate = 200000, frequency = 1000, reference = 3.3, bits = 16;
      const codes = Uint16Array.from({length:16000}, (_, i) => Math.round((1.65 + 0.9 * Math.sin(2 * Math.PI * frequency * i / rate)) / reference * 65535));
      document.getElementById('an-rate').value = String(rate);
      document.getElementById('an-bits').value = String(bits);
      document.getElementById('an-reference').value = String(reference);
      document.getElementById('an-time').value = '0.0005';
      document.getElementById('an-volts').value = '0.5';
      document.getElementById('an-offset').value = '1.65';
      document.getElementById('an-level').value = '1.65';
      document.getElementById('an-trigger').value = 'auto';
      a.store.reset(); a.store.append({codes,rate,bits}); a.total = a.store.total;
      a.renderAdc();
      document.getElementById('an-cursor-x').checked = true;
      document.getElementById('an-cursor-y').checked = true;
      a.adcCursors = {x:[0.00125,0.00225], y:[0.75,2.55]};
      a.paintAdc();
      a.status('虚拟正弦信号 · 1 kHz / 1.8 Vpp · 未连接硬件');
      const { measureAdc } = await import('/app/analog/measure.js');
      return {mode:'synthetic',rate,frequency,bits,reference,total:a.total,visible:a.adcDisplay.frame.codes.length,
        measurements:measureAdc(a.adcDisplay.frame.codes,{rate,bits,reference}),cursors:a.adcCursors};
    `,
    check: s => { assert.equal(s.mode, 'synthetic'); assert.ok(Math.abs(s.measurements.frequency - 1000) < 1); assert.ok(Math.abs(s.measurements.peakToPeak - 1.8) < 0.001); assert.ok(s.visible >= 1000); },
  },
};

for (const [name, scene] of Object.entries(scenes)) {
  if (requested.length && !requested.includes(name)) continue;
  const url = `${app}/index.html?hid=mock&demo=serial&readme-showcase=${name}#${scene.tab}`;
  const page = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {method:'PUT'})).json();
  const cdp = new Cdp(base, 30000);
  try {
    cdp.ws = await cdp._open(page.webSocketDebuggerUrl, (_, message) => cdp._dispatch(message));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    for (let i = 0; i < 100; i++) {
      if (await cdp.eval('return !!window.__tools?.analog;')) break;
      await sleep(100);
    }
    const verification = await cdp.eval(scene.prepare);
    scene.check(verification);
    await sleep(6500); // 等正常提示 toast 消退，不裁掉或隐藏页面元素。
    const errors = await cdp.eval('return window.__tools.errors;');
    assert.deepEqual(errors, []);
    const screenshot = await cdp.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    const prefix = `docs/shots/readme-${name}`;
    writeFileSync(prefix + '.png', Buffer.from(screenshot.data, 'base64'));
    writeFileSync(prefix + '.json', JSON.stringify({description:scene.description,capturedAt:new Date().toISOString(),url,
      viewport:{width:1600,height:1000},verification,errors}, null, 2) + '\n');
    console.log(name + ': ' + scene.description);
  } finally {
    cdp.close(); await fetch(`${base}/json/close/${page.id}`);
  }
}
