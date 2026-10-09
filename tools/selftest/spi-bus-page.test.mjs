/**
 * 「SPI/QSPI 桥」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/spi-bus-page.test.mjs    （等价：make test-spi-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 跑的是**真页面对象**（`window.__tools.spi` 是桥页视图、`window.__tools.spiSession` 是共享会话）：
 * 切页 → 开假探针 → 读写配置 → 使能 → 发各种帧 → 回环自检 → 错误路径 → 统计对账。
 * 面板档 / 初始化步 / 屏相关的东西在 `spi-panel-page.test.mjs` 里测。
 * 每一步都断言"客观状态"（假探针里的计数、线上字节、表格内容），不看"像不像"。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const URL_ = APP + '?demo=serial&t=' + Date.now();

setTimeout(() => { console.error('[WATCHDOG] 总超时'); process.exit(9); }, 180000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

async function ensureBrowser(){
  try { await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2500) }); return; } catch {}
  console.log('  （CDP 浏览器没在跑，自己拉一个…）');
  const ps = spawn('pwsh', ['-NoProfile', '-File', join(root, 'tools', 'selftest', 'launch-browser.ps1'), '-Port', '9333', '-Url', APP],
    { stdio: 'ignore', detached: true });
  ps.unref();
  for (let i = 0; i < 90; i++){
    await sleep(500);
    try { await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2000) }); return; } catch {}
  }
  throw new Error('等 CDP 浏览器超时');
}

await ensureBrowser();
const list = await (await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(5000) })).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('CDP 里没有页面目标');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连不上')); });
let seq = 0; const pend = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)){ const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const send = (method, params = {}, t = 25000) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pend.delete(id)) rej(new Error(method + ' 超时')); }, t);
});

/** 在页面里求值（表达式字符串；异常会被抛出来） */
async function ev(expr){
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面里报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

await send('Page.enable');
await send('Page.bringToFront');
await send('Runtime.enable');
// 🚨 必须关缓存：python http.server 不发 Cache-Control，改完模块会拿到旧的（本仓库踩过）
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.spi;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.spi 不存在）');

/**
 * 🚨 **自带前置**：右列 tab 与「假器件」都是**持久化的用户设置**（localStorage）。
 * 上一个套件/上一轮跑崩了会把它们留在别处 —— 实测踩过：上一轮把假器件留在「命令型 ADC」上，
 * 这一轮的 Flash 卡那几节就整片红（12 条），看着像功能坏了，其实是状态没清。
 * 与 `#i2c` 的 page 套件同一个纪律：**起手先把状态钉死**。
 */
await ev(`
  const K = 'serial-rtt-tools:v1';
  const st = JSON.parse(localStorage.getItem(K) || '{}');
  delete st['spi.dock'];
  st['spi.mockDevice'] = 'flash';
  localStorage.setItem(K, JSON.stringify(st));
  const sel = document.getElementById('sp-mock-device');
  if (sel){ sel.value = 'flash'; sel.dispatchEvent(new Event('change')); }
  const mock = document.getElementById('sp-mock');
  if (mock){ mock.checked = false; mock.dispatchEvent(new Event('change')); }
  return true;`);
await sleep(250);
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 40; i++){
  await sleep(400);
  try { if (await ev('return !!window.__tools?.spi;')) break; } catch {}
}
await ev(`document.querySelector('#tabs .tab[data-tab="spi"]').click(); return true;`);
await sleep(200);

// ==================================================================== 1
console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(Array.isArray(s.tabs) && s.tabs.includes('spi'), '标签栏里有 spi（桥页）');
  ok(s.tabs.includes('panel'), '标签栏里有 panel（屏页）');
  const menu = await ev(`return [...document.querySelectorAll('#tool-switch [data-tab]')].map(e=>e.dataset.tab);`);
  ok(menu.join(',') === 'spi,panel,spicdc,swo,i2c,analog,gen',
     '更多功能顺序：SPI/QSPI → 屏 → SPI 转发 → SWO → I2C → ADC/DAC → 工程生成', menu.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.spi && s.spi.connected === false && s.spi.dataReady === false, '初始：未连接（HID 与数据面都空）');
  ok(s.panel && s.panel.connected === false, '屏页看到的是**同一个**会话（初始也未连接）');
  const logs = await ev(`return document.getElementById('sp-log').textContent;`);
  ok(/就绪/.test(logs), '日志区有启动提示');
}

// ==================================================================== 1b
console.log('== 1b. 右列分 tab（照 #dbg 那套：一次只显示一个）==');
{
  const t = await ev(`
    const ids = [...document.querySelectorAll('#sp-dock-tabs button[data-dock]')].map(b => b.dataset.dock);
    const pages = [...document.querySelectorAll('#sp-box-dock .dockpage')].map(p => p.dataset.dock);
    return { ids, pages,
             shown: [...document.querySelectorAll('#sp-box-dock .dockpage.on')].map(p => p.dataset.dock),
             saved: (JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}') || {})['spi.dock'] };`);
  ok(t.ids.join(',') === 'cmd,reg,dsl,live,flash,loop', `六个 tab：命令表/寄存器/脚本/实时值/Flash/回环（${t.ids.join(',')}）`, t.ids.join(','));
  ok(t.pages.join(',') === t.ids.join(','), '每个 tab 都有对应的内容块（顺序一致）');
  ok(t.shown.length === 1, '🚨 同时**只有一个**内容块可见', JSON.stringify(t.shown));

  const sw = await ev(`
    const click = d => document.querySelector('#sp-dock-tabs button[data-dock="' + d + '"]').click();
    const out = [];
    for (const d of ['dsl', 'flash', 'loop', 'cmd', 'dsl']){
      click(d);
      out.push({ d,
        on: [...document.querySelectorAll('#sp-box-dock .dockpage.on')].map(p => p.dataset.dock),
        btnOn: [...document.querySelectorAll('#sp-dock-tabs button.on')].map(b => b.dataset.dock),
        saved: (JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}') || {})['spi.dock'],
        rows: document.querySelectorAll('#sp-cmd-body tr').length,
        lbRows: document.getElementById('sp-lb-body').children.length });
    }
    click('cmd');
    return out;`);
  for (const r of sw){
    ok(r.on.length === 1 && r.on[0] === r.d, `切到「${r.d}」：只有它显示`, JSON.stringify(r.on));
    ok(r.btnOn.length === 1 && r.btnOn[0] === r.d, `……tab 按钮也只有一个高亮`, JSON.stringify(r.btnOn));
    ok(r.saved === r.d, '……选择落进 localStorage（刷新/切页回来还在）', String(r.saved));
  }
  ok(sw.every(r => r.rows === 3), '切 tab 不重建命令表（初始 3 行始终在）', JSON.stringify(sw.map(r => r.rows)));
  ok(sw.every(r => r.lbRows === 0), '切 tab 不污染回环结果表（还没跑过）');

  // tab 栏那一行（胶囊 + 中止）不在任何 dockpage 里 —— 切到哪个 tab 都看得见
  const pill = await ev(`
    return { inPage: !!document.querySelector('#sp-box-dock .dockpage #sp-run-pill'),
             inHeader: !!document.querySelector('#sp-box-dock > .dockhead #sp-run-pill'),
             abortInHeader: !!document.querySelector('#sp-box-dock > .dockhead #sp-run-abort'),
             text: document.getElementById('sp-run-pill').textContent,
             abortDisabled: document.getElementById('sp-run-abort').disabled };`);
  ok(pill.inHeader && !pill.inPage, '运行状态在卡片内的公共工具栏，切 tab 仍可见');
  ok(pill.abortInHeader === true, '「中止」按钮在卡片内的公共工具栏');
  ok(/空闲|忙/.test(pill.text), `空闲时胶囊写着状态：「${pill.text}」`);
  ok(pill.abortDisabled === true, '没在跑回环时「中止」是灰的');
}

// ==================================================================== 2
console.log('== 2. 切到 SPI/QSPI 桥页 + 开假探针 ==');
{
  await ev(`document.querySelector('#tabs .tab[data-tab="spi"]').click(); return true;`);
  await sleep(300);
  ok(await ev(`return document.getElementById('tab-spi').classList.contains('active');`), '点击标签后 #tab-spi 变成 active');
  const s = await ev(`
    const c = document.getElementById('sp-mock'); c.checked = true; c.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 800));
    return window.__tools.spi.summary();`);
  ok(s.mock === true && s.connected === true && s.dataReady === true, '勾上「用假探针」→ HID 与数据面都就绪');
  const info = await ev(`return document.getElementById('sp-info').textContent + ' | ' + document.getElementById('sp-usbinfo').textContent;`);
  ok(/假探针/.test(info), `侧栏写明是假探针：「${info}」`);
  const st = await ev(`return document.getElementById('sp-state').textContent;`);
  ok(/假探针/.test(st), `状态行 = ${st}`);
}

// ==================================================================== 3
console.log('== 3. 配置：读取 → 改写 → 回读对账 ==');
{
  await ev(`document.getElementById('sp-get').click(); await new Promise(r=>setTimeout(r,250)); return true;`);
  const def = await ev(`return { sclk: document.getElementById('sp-sclk').value, cs: document.getElementById('sp-cs').value,
    dc: document.getElementById('sp-pad-dc').value, rst: document.getElementById('sp-pad-rst').value }`);
  ok(def.sclk === '0', `默认 SCLK = 板级默认（select=${def.sclk}）`);
  /* 2026-10：假探针默认辅助脚 = 「引脚分配图」推荐值（AUX_DEFAULT）—— 顺手把「引脚设置」这一节
   * 的结构也钉住：改名、去掉 CS 辅助（下拉 + 低有效那个勾），只留 DC/RST/BL。 */
  ok(def.dc === '14' && def.rst === '5', `默认辅助脚 DC=PA26 / RST=PA02（${def.dc}/${def.rst}）`);
  const pinSec = await ev(`return {
    legend: document.getElementById('sp-pad-dc').closest('fieldset').querySelector('legend').textContent,
    hasCsAux: !!document.getElementById('sp-pad-csaux'),
    hasCsLow: !!document.getElementById('sp-al-cs'),
    bl: document.getElementById('sp-pad-bl').value,
    opts: [...document.querySelectorAll('#sp-pad-dc option')].map(o => o.value),
  };`);
  ok(/引脚设置/.test(pinSec.legend), `那一节已改名「引脚设置」：${pinSec.legend}`);
  ok(!pinSec.hasCsAux && !pinSec.hasCsLow, 'CS 辅助（下拉 + 低有效勾）已移除');
  ok(pinSec.bl === '13', `BL 默认 PA31（${pinSec.bl}）`);
  ok(pinSec.opts.includes('14') && pinSec.opts.includes('17'), 'pad 下拉里有 PA26~PA29（14~17，2026-09-30 释放的那批）');

  /* 2026-10-03：I2C 桥的 SCL/SDA 在固件里是**写死的**（PA29/PA28 = J3[19]/J3[21]），
     用户要求在「引脚分配图」上**固定显示**这两根（与配置、与 I2C 是否使能都无关）——
     接线的人必须一眼看到它们已经名花有主。 */
  const pinmap = await ev(`
    document.getElementById('sp-pinmap-btn').click();
    await new Promise(r => setTimeout(r, 350));
    const rows = [...document.querySelectorAll('#sp-pinmap-body tr')].map(tr => tr.textContent.replace(/\\s+/g, ' ').trim());
    return {
      hidden: document.getElementById('sp-pinmap').hidden,
      r19: rows.find(t => t.startsWith('19')) || '',
      r21: rows.find(t => t.startsWith('21')) || '',
      fixed: document.querySelectorAll('#sp-pinmap-body .p-fixed').length,
      i2c: document.querySelectorAll('#sp-pinmap-body .is-i2c').length,
      legend: document.getElementById('sp-pinmap-legend').textContent,
      foot: document.getElementById('sp-pinmap-foot').textContent,
    };`);
  ok(pinmap.hidden === false, '「引脚分配图」能打开');
  ok(/PA29/.test(pinmap.r19) && /SCL/.test(pinmap.r19) && /I2C/.test(pinmap.r19),
     `J3[19] 固定标成 I2C SCL（${pinmap.r19}）`);
  ok(/PA28/.test(pinmap.r21) && /SDA/.test(pinmap.r21) && /I2C/.test(pinmap.r21),
     `J3[21] 固定标成 I2C SDA（${pinmap.r21}）`);
  ok(pinmap.fixed === 2 && pinmap.i2c === 2, `这两根带「固定」徽标与 I2C 配色（徽标 ${pinmap.fixed} / 配色 ${pinmap.i2c}）`);
  ok(/◆/.test(pinmap.legend) && /I2C/.test(pinmap.legend), '图例里有「◆ I2C 桥固定脚」');
  ok(/J3\[19\]/.test(pinmap.foot) && /J3\[21\]/.test(pinmap.foot), '脚注给了 I2C 的接线位置（J3[19]/J3[21]）');
  await ev(`document.getElementById('sp-pinmap-btn').click(); return true;`);   // 关掉，别挡住后面的小节

  /* 探针里三根线全空（刚烧完固件/重枚举的默认态）时，面板**预填推荐脚位**而不是显示"不用" ——
   * 用户 2026-10 现场就是卡在这儿。假探针的默认配置里 DC/RST/BL 是推荐值，所以这里换成
   * "把探针写成全 0 → 再读回" 来复现现场。 */
  const empty = await ev(`
    const s = window.__tools.spiSession;
    // 直接把假探针的配置改成"三根线都不用"（等价于刚烧完固件/重枚举后的默认态），再走页面的「读取配置」
    s.mockProbe.cfg.padDc = 0; s.mockProbe.cfg.padRst = 0; s.mockProbe.cfg.padBl = 0;
    document.getElementById('sp-get').click();
    await new Promise(r => setTimeout(r, 400));
    return { dc: document.getElementById('sp-pad-dc').value, rst: document.getElementById('sp-pad-rst').value,
             bl: document.getElementById('sp-pad-bl').value, cfg: s.cfg,
             log: document.getElementById('sp-log').textContent };`);
  ok(empty.cfg.padDc === 0 && empty.dc === '14' && empty.rst === '5' && empty.bl === '13',
     `探针里是"不用"时面板预填推荐脚位（探针 ${empty.cfg.padDc}/${empty.cfg.padRst}/${empty.cfg.padBl} → 面板 ${empty.dc}/${empty.rst}/${empty.bl}）`);
  ok(/已按推荐脚位预填/.test(empty.log), '日志里说明了"预填还没写进探针"');
  // 收尾：把假探针恢复成推荐值，后面几个小节继续用
  await ev(`
    const s = window.__tools.spiSession;
    s.mockProbe.cfg.padDc = 14; s.mockProbe.cfg.padRst = 5; s.mockProbe.cfg.padBl = 13;
    document.getElementById('sp-get').click();
    await new Promise(r => setTimeout(r, 300));
    return 1;`);

  const applied = await ev(`
    document.getElementById('sp-sclk').value = '40000000';
    document.getElementById('sp-mode').value = '0';
    document.getElementById('sp-cs').value = '0';
    document.getElementById('sp-thr').value = '100';
    document.getElementById('sp-clear').checked = true;
    document.getElementById('sp-set').click();
    await new Promise(r => setTimeout(r, 400));
    return { cfg: window.__tools.spiSession.cfg?.sclkHz, log: document.getElementById('sp-log').textContent };`);
  ok(applied.cfg === 40000000, `写配置后回读到 40 MHz（实际 ${applied.cfg}）`);
  ok(/回读对账一致/.test(applied.log), '日志明确写着「回读对账一致」（不靠状态字的 err 判断）');
}

// ==================================================================== 4
// ==================================================================== 5
console.log('== 5. 使能与状态 ==');
{
  const on = await ev(`
    document.getElementById('sp-enable').click();
    await new Promise(r => setTimeout(r, 400));
    return { en: window.__tools.spiSession.mockProbe.enabled, st: window.__tools.spi.summary() };`);
  ok(on.en === true, 'ENABLE → 假探针进入使能状态');
  const st = await ev(`
    await window.__tools.spiSession.pollStatus(true);
    return { sum: window.__tools.spi.summary(), word: document.getElementById('sp-word-text').textContent,
             sclk: document.getElementById('sp-sclk-actual').textContent };`);
  ok(st.sum.actualSclkHz === 40000000, `状态回读的实际 SCLK = 40 MHz（${st.sum.actualSclkHz}）`);
  ok(/MHz/.test(st.sclk), `页面把实际 SCLK 显示出来了：「${st.sclk}」`);
  ok(/已使能/.test(st.word), `状态字人话里含「已使能」：「${st.word}」`);
}

// ==================================================================== 6
console.log('== 6. 通用命令表（一行一条，最多 10 条）+ 文本面板 ==');
{
  const shape = await ev(`
    const cards = ['sp-cmd-card','sp-dsl-card','sp-flash-card','sp-loop-card'].filter(i => !!document.getElementById(i));
    const rows = document.querySelectorAll('#sp-cmd-body tr').length;
    const cells = [...document.querySelectorAll('#sp-cmd-body tr:first-child [data-f]')].map(e => e.dataset.f);
    const cols = [...document.querySelectorAll('#sp-cmd-card thead th')].map(e => e.textContent);
    const old = ['sp-x-cmd','sp-x-token','sp-x-dcen','sp-x-csaux','sp-x-nodma'].map(i => !!document.getElementById(i));
    return { cards, rows, cells, cols, old, stack: !!document.querySelector('#tab-spi .busstack'),
             dock: !!document.querySelector('#tab-spi .spdock'),
             spcols: !!document.querySelector('#tab-spi .spcols') };`);
  ok(shape.cards.length === 4, `右区就是那四块（现在是四个 tab 的内容）：${shape.cards.join(' / ')}`);
  ok(shape.dock === true && shape.stack === false && shape.spcols === false,
     '右列是 tab 面板（不再是单列堆叠 .busstack，也不是两列 .spcols）', JSON.stringify(shape));
  ok(shape.rows === 3, `命令表初始 3 行（实际 ${shape.rows}）`);
  ok(shape.cols.join(',').includes('cmd') && shape.cols.join(',').includes('tx 数据'), `表头是参数项：${shape.cols.join(' | ')}`);
  ok(shape.cells.join(',') === 'cmd,lines,addrLen,addr,dummy,rx,tx,res', `每行的字段：${shape.cells.join(',')}`);
  ok(!shape.old.some(Boolean), '旧 XFER 表单里的 DC / token / 辅助 CS / 强制轮询等勾选项都撤了');

  const added = await ev(`
    const cell=document.querySelector('#sp-cmd-body tr:first-child [data-f="tx"]');
    cell.value='AA BB';
    document.getElementById('sp-cmd-add').click();
    const value=cell.value;
    cell.value='';
    return { rows:document.querySelectorAll('#sp-cmd-body tr').length, preserved:value==='AA BB' && cell===document.querySelector('#sp-cmd-body tr:first-child [data-f="tx"]') };`);
  ok(added.rows === 4 && added.preserved, '添加命令行保留已填内容、原节点与发送顺序');

  // 填 1/2/4 行，第 3 行故意留空
  const sent = await ev(`
    const set = (r, f, v) => { document.querySelector('#sp-cmd-body tr:nth-child(' + r + ') [data-f=' + f + ']').value = v; };
    set(1, 'cmd', '0x9F'); set(1, 'rx', '3');
    set(2, 'cmd', '0x03'); set(2, 'addrLen', '3'); set(2, 'addr', '0x1000'); set(2, 'rx', '8');
    set(4, 'cmd', '0x02'); set(4, 'addrLen', '3'); set(4, 'addr', '0x2000'); set(4, 'tx', 'aa bb');
    const before = window.__tools.spiSession.mockProbe.stats.framesOk;
    document.getElementById('sp-cmd-send').click();
    for (let i = 0; i < 60 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 250));
    const res = [...document.querySelectorAll('#sp-cmd-body td.res')].map(td => td.textContent);
    const p = window.__tools.spiSession.mockProbe;
    return { before, after: p.stats.framesOk, res, log: document.getElementById('sp-log').textContent,
             cls: [...document.querySelectorAll('#sp-cmd-body td.res')].map(td => td.className) };`);
  ok(sent.after === sent.before + 3, `3 行发出 3 条帧，空行不发（frames_ok ${sent.before}→${sent.after}）`);
  ok(/^OK/.test(sent.res[0]) && /ef 40 18/.test(sent.res[0]), `第 1 行读回 JEDEC ID 显示在「结果」列：${sent.res[0]}`);
  ok(/^OK/.test(sent.res[1]), `第 2 行（读 8 B）也 OK：${sent.res[1]}`);
  ok(/^OK/.test(sent.res[3]), `第 4 行（写 2 B，没有读）也能看到结果：${sent.res[3]}`);
  ok(sent.res[2] === '' && sent.res.slice(4).every(x => x === ''), '没填的行结果列保持空白');
  ok(/通用命令：发了 3 条/.test(sent.log), '日志里有整段总结');
  ok(sent.cls[0] === 'res ok', '结果列带上 ok/bad 类（失败会标红）');
}

// ==================================================================== 6b
console.log('== 6b. 文本面板：C 表行 / 语法错带行号 / 导出回灌 ==');
{
  // C 表行 + 非 XFER 帧混着来，一次发出去
  const mix = await ev(`
    const before = window.__tools.spiSession.mockProbe.stats.framesOk;
    document.getElementById('sp-dsl-text').value = [
      '# 贴一段 C 表',
      '{0x9F, 1, 0, 0x000000, 0, 3, NULL},',
      '{0x03, 1, 3, 0x000010, 0, 4, NULL},',
      'delay 2000',
      'gpio DC 1',
      'reset 5 20',
    ].join('\\n');
    document.getElementById('sp-dsl-send').click();
    for (let i = 0; i < 60 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 250));
    const p = window.__tools.spiSession.mockProbe;
    return { before, after: p.stats.framesOk, delays: p.delays, gpio: p.wireLog.slice(-6), cs: p.cs,
             sum: document.getElementById('sp-dsl-sum').textContent, errs: document.getElementById('sp-dsl-err').textContent };`);
  ok(mix.after === mix.before + 5, `C 表行 + delay + gpio + reset 共 5 条帧都发了（frames_ok ${mix.before}→${mix.after}）`);
  ok(mix.delays.includes(2) && mix.delays.some(d => d === 25), `delay 2000（µs）= 2 ms、reset 5 20 = 25 ms 都落到探针上（${mix.delays.join(',')}）`);
  ok(mix.gpio.some(l => /GPIO dc=1/.test(l)), 'gpio 帧也落地了');
  ok(mix.cs === false, '整段结束后 CS 是释放的');
  ok(/发完/.test(mix.sum) && mix.errs === '', `摘要：${mix.sum}`);

  // 语法错 → 一行都不发、错误表带行号
  const bad = await ev(`
    const before = window.__tools.spiSession.mockProbe.stats.framesOk;
    document.getElementById('sp-dsl-text').value = '# 注释\\n\\n0x11\\n{0x9F, 1, 0, 0, 0}\\n0x29';
    document.getElementById('sp-dsl-send').click();
    await new Promise(r => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('#sp-dsl-err tr')].map(tr => tr.textContent);
    return { rows, sum: document.getElementById('sp-dsl-sum').textContent, log: document.getElementById('sp-log').textContent,
             before, after: window.__tools.spiSession.mockProbe.stats.framesOk, shown: document.getElementById('sp-dsl-errwrap').style.display };`);
  ok(bad.rows.length === 1 && /^4/.test(bad.rows[0]), `错误表里正好 1 行、行号 4：${bad.rows[0]}`);
  ok(/6~7 列/.test(bad.rows[0]), 'C 表行列数不够 → 说清了几列');
  ok(bad.after === bad.before, `有语法错时**一条都不发**（frames_ok 没动：${bad.before}）`);
  ok(/第 4 行/.test(bad.log) && bad.shown === '', '日志里有明确报错、错误表也显示了');

  // 导出 → 回灌：C 表 / JSON / 文本三条路都要能再解析
  const round = await ev(`
    const D = await import('/app/spi/frames-dsl.js');
    document.getElementById('sp-dsl-text').value = 'xfer cmd=0x6B addr=0 addrl=3 dummy=1 lines=4 rx=492 cs_hold\\nxfer lines=4 rx=100 cs_off\\ndelay 120ms';
    const r = D.parseFrames(document.getElementById('sp-dsl-text').value);
    const c = D.itemsToC(r.items), j = D.itemsToJson(r.items), t = D.itemsToDsl(r.items);
    const rc = D.parseFrames(c), rj = D.parseFrames(D.jsonToDsl(j)), rt = D.parseFrames(t);
    return { c0: c.split('\\n')[1], jlen: JSON.parse(j).length,
             okC: rc.errors.length === 0 && rc.items.length === 2, okJ: rj.errors.length === 0 && rj.items.length === 3,
             okT: rt.errors.length === 0 && rt.items.length === 3,
             sameT: rt.items.every((it, i) => D.itemsToJson([it]) === D.itemsToJson([r.items[i]])) };`);
  ok(/^\{0x6b, 4, 3, 0x000000, 1, 492, NULL\},/.test(round.c0), `导出的 C 表行与表格列序一致：${round.c0}`);
  ok(round.okC && round.okJ && round.okT, `三条导出都能回灌（C ${round.okC} / JSON ${round.okJ} / 文本 ${round.okT}，JSON ${round.jlen} 条）`);
  ok(round.sameT === true || round.sameT === undefined, '文本回灌后每帧与原来一致');

  // 文件载入：读一个 .c 文件（用 DataTransfer 造一个 File，不需要真磁盘）
  const file = await ev(`
    const f = new File(['{0x9F, 1, 0, 0x000000, 0, 3, NULL},\\n{0x06, 1, 0, 0, 0, 0, NULL},'], 'test-table.c', { type: 'text/plain' });
    await window.__tools.spi.dslLoadFile(f);
    await new Promise(r => setTimeout(r, 300));
    return { text: document.getElementById('sp-dsl-text').value, sum: document.getElementById('sp-dsl-sum').textContent,
             log: document.getElementById('sp-log').textContent };`);
  ok(/\{0x9F/.test(file.text), '读文件把内容填进了文本框');
  ok(/解析通过：2 条帧/.test(file.sum), `载入后自动解析：${file.sum}`);
  ok(/已读入 test-table.c/.test(file.log), '日志里写明读了哪个文件');
}

// ==================================================================== 7
console.log('== 7. 回环自检（假探针自带回环）==');
{
  const lb = await ev(`
    document.getElementById('sp-lb-lens').value = '1,2,32,99,100,101,256,492';
    document.getElementById('sp-lb-lines').value = '1';
    document.getElementById('sp-lb-dma').checked = true;
    document.getElementById('sp-lb-run').click();
    for (let i = 0; i < 100 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    return { sum: document.getElementById('sp-lb-sum').textContent,
             rows: [...document.querySelectorAll('#sp-lb-body tr')].map(tr => tr.textContent),
             log: document.getElementById('sp-log').textContent };`);
  ok(lb.rows.length === 16, `8 个长度 × 2 条路径 = 16 行结果（实际 ${lb.rows.length}）`);
  ok(lb.sum === '16/16 PASS', `回环自检全部通过：${lb.sum}`, lb.rows.slice(0, 3).join(' / '));
  ok(/回环自检完成：16\/16 PASS/.test(lb.log), '日志里有总结行');

  // 🚨 tab 化之后的两条：跑的过程中胶囊要显示进度、**切 tab 不能打断**、中止按钮要亮
  //    ⚠️ 不要用"跑起来等 xx ms 再看"—— 假探针 8 帧是毫秒级的，等一下就结束了（实测这么红过）。
  //    `loopbackTest()` 里 `setBusy` / 胶囊 / 中止按钮都在**第一个 await 之前**同步做完，
  //    所以点完立刻读就是确定的。
  const mid = await ev(`
    document.getElementById('sp-lb-lens').value = '1,2,32,99,100,101,256,492';
    document.getElementById('sp-lb-dma').checked = false;
    document.getElementById('sp-lb-run').click();          // 故意不 await
    const pill0 = document.getElementById('sp-run-pill').textContent;
    const busyNow = window.__tools.spiSession.busy;
    const abortOn = document.getElementById('sp-run-abort').disabled === false;
    // 紧接着切到「Flash 测试」—— 同一个同步块里，回环还在跑
    document.querySelector('#sp-dock-tabs button[data-dock="flash"]').click();
    const busyAfterSwitch = window.__tools.spiSession.busy;
    const pillInOtherTab = document.getElementById('sp-run-pill').textContent;
    const shownInOtherTab = [...document.querySelectorAll('#sp-box-dock .dockpage.on')].map(p => p.dataset.dock);
    for (let i = 0; i < 100 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 150));
    const sum = document.getElementById('sp-lb-sum').textContent;
    const pillEnd = document.getElementById('sp-run-pill').textContent;
    const abortOff = document.getElementById('sp-run-abort').disabled;
    document.querySelector('#sp-dock-tabs button[data-dock="cmd"]').click();
    return { pill0, busyNow, abortOn, busyAfterSwitch, pillInOtherTab, shownInOtherTab, sum, pillEnd, abortOff,
             rows: document.querySelectorAll('#sp-lb-body tr').length };`);
  ok(mid.busyNow === true && /回环自检 0\/8/.test(mid.pill0), `起跑瞬间胶囊就显示进度：「${mid.pill0}」`);
  ok(mid.abortOn === true, '……「中止」按钮变成可点');
  ok(mid.busyAfterSwitch === true && mid.shownInOtherTab.join() === 'flash',
     '🚨 切到别的 tab 不打断回环自检（同步块里读仍是 busy，且确实切过去了）', JSON.stringify(mid.shownInOtherTab));
  ok(/回环自检/.test(mid.pillInOtherTab), `……胶囊在别的 tab 上照样是进度：「${mid.pillInOtherTab}」`);
  ok(mid.sum === '8/8 PASS' && mid.rows === 8, `跑完 8/8 PASS（实际 ${mid.sum} / ${mid.rows} 行）`);
  ok(/回环/.test(mid.pillEnd) && mid.abortOff === true, `结束后胶囊转成结果、中止按钮变灰：「${mid.pillEnd}」`);

  // 结果表的「清空」按钮（用户："测回环的结果窗口，没有清空按钮，需要一个"）
  const cleared = await ev(`
    document.querySelector('#sp-dock-tabs button[data-dock="loop"]').click();
    document.getElementById('sp-lb-clear').click();
    await new Promise(r => setTimeout(r, 120));
    return { rows: document.getElementById('sp-lb-body').children.length,
             sum: document.getElementById('sp-lb-sum').textContent,
             cls: document.getElementById('sp-lb-sum').className };`);
  ok(cleared.rows === 0, '「清空结果」把回环结果表清空了', String(cleared.rows));
  ok(cleared.sum === '未跑', `……摘要回到「未跑」（实际「${cleared.sum}」）`);
}

// ==================================================================== 8
console.log('== 8. 错误路径：必须看得见，不能静默 ==');
{
  // ① 没接跳线（读回 0x00）→ 回环必须 FAIL，且表格标红
  const bad = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.faults.loopback = false;
    document.getElementById('sp-lb-lens').value = '8';
    document.getElementById('sp-lb-dma').checked = false;
    document.getElementById('sp-lb-run').click();
    for (let i = 0; i < 100 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    const rows = [...document.querySelectorAll('#sp-lb-body tr')];
    p.faults.loopback = true;
    return { sum: document.getElementById('sp-lb-sum').textContent, cls: rows[0]?.className, n: rows.length };`);
  ok(bad.n === 1 && bad.cls === 'bad' && bad.sum === '0/1 PASS', `没接跳线 → FAIL 且行标红（${bad.sum} / class=${bad.cls}）`);

  // ② 桥失能后发帧 → 真固件 NAK，页面要报出来（不是"什么都没发生"）
  const off = await ev(`
    document.getElementById('sp-disable').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('sp-dsl-text').value = 'ping';
    document.getElementById('sp-dsl-send').click();
    await new Promise(r => setTimeout(r, 600));
    return { enabled: window.__tools.spiSession.mockProbe.enabled, log: document.getElementById('sp-log').textContent,
             errs: window.__tools.spiSession.transport.errors, sum: document.getElementById('sp-dsl-sum').textContent };`);
  ok(off.enabled === false, 'DISABLE 生效');
  ok(/没使能|NAK|写超时/.test(off.log) && off.errs >= 1, `失能后发帧被如实报错（transport.errors=${off.errs}）`);

  // ③ 丢应答 → 超时分支（不悬挂、不静默）
  const drop = await ev(`
    document.getElementById('sp-enable').click(); await new Promise(r => setTimeout(r, 300));
    const p = window.__tools.spiSession.mockProbe;
    p.faults.dropRsp = true;
    document.getElementById('sp-dsl-text').value = 'ping';
    document.getElementById('sp-dsl-send').click();
    await new Promise(r => setTimeout(r, 1800));
    p.faults.dropRsp = false;
    return { log: document.getElementById('sp-log').textContent, sum: document.getElementById('sp-dsl-sum').textContent };`);
  ok(/应答超时/.test(drop.log), '丢应答 → 页面报「应答超时」（不静默挂住）');
  ok(/没等到应答/.test(drop.sum), `DSL 摘要也点出没等到应答：「${drop.sum}」`);
}

// ==================================================================== 9
console.log('== 9. 统计对账（页面显示 = 探针计数）==');
{
  // 先造一个**真正的协议层错误**（收发不等长 → RANGE）：验证 frames_err 会涨
  const proto = await ev(`
    const spi = window.__tools.spiSession;
    const P = await import('/app/spi/protocol.js');
    const before = spi.mockProbe.stats.framesErr;
    const r = await spi.sendFrames([{ type: P.T.XFER, payload: P.xferPayload({ tcfg: 0, tx: new Uint8Array(2), rxLen: 3 }),
                                      flags: P.F.RSP, label: '不等长' }], { quiet: true });
    return { status: r.rsps[0]?.status, before, after: spi.mockProbe.stats.framesErr };`);
  ok(proto.status === 4 && proto.after === proto.before + 1,
     `协议层错误会被记账：RANGE(4) → frames_err ${proto.before}→${proto.after}`);

  const cmp = await ev(`
    const bus = window.__tools.spi, spi = window.__tools.spiSession;
    await spi.pollStatus(true);
    const s = bus.summary(), p = spi.mockProbe.stats;
    return { pageOk: s.framesOk, probeOk: p.framesOk, pageErr: s.framesErr, probeErr: p.framesErr,
             bytesTx: s.bytesTx, probeTx: p.bytesTx,
             dom: { ok: document.getElementById('sp-c-ok').textContent, err: document.getElementById('sp-c-err').textContent,
                    tx: document.getElementById('sp-c-tx').textContent } };`);
  ok(cmp.pageOk === cmp.probeOk, `frames_ok 对账一致（页面 ${cmp.pageOk} = 探针 ${cmp.probeOk}）`);
  ok(cmp.pageErr === cmp.probeErr, `frames_err 对账一致（${cmp.pageErr}）`);
  ok(cmp.bytesTx === cmp.probeTx, `bytes_tx 对账一致（${cmp.bytesTx} B）`);
  ok(cmp.dom.ok === String(cmp.pageOk), `计数器渲染到 DOM（ok=${cmp.dom.ok} · tx=${cmp.dom.tx}）`);
  ok(cmp.pageErr === 1,
     'frames_err **只**由协议层错误产生：回环失配是应用层判定、失能 NAK 在传输层、丢应答不改帧执行结果 —— 三类都不该混进这个计数');
}

// ==================================================================== 10
console.log('== 10. NOR flash 卡（假探针里挂着一颗 W25Q128 模型）==');
{
  // 10.0 排版回归：按钮别被拉伸、两个数据窗口等高
  //    （用户现场："布局是不是有点奇怪？高度有点太大？导致有效数据窗口变小了"）
  const lay = await ev(`
    document.querySelector('#sp-dock-tabs button[data-dock="flash"]').click();
    await new Promise(r => setTimeout(r, 200));
    const b = sel => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return Math.round(r.width); };
    const h = sel => Math.round(document.querySelector(sel).getBoundingClientRect().height);
    return {
      read: b('#sp-fl-read'), bench: b('#sp-fl-bench'), erase: b('#sp-fl-erase'),
      rowW: Math.round(document.querySelector('#sp-flash-card .row.btnrow').getBoundingClientRect().width),
      out: h('#sp-fl-out'), data: h('#sp-flash-card .datarow'), cardH: h('#sp-flash-card'),
      paramRows: document.querySelectorAll('#sp-flash-card .framegrid .row').length,
      paramGridRows: new Set([...document.querySelectorAll('#sp-flash-card .framegrid .row')].map(r => Math.round(r.getBoundingClientRect().top))).size,
    };`);
  ok(lay.read < 140 && lay.bench < 140, `动作按钮是**内容宽**、没被 flex:1 拉伸（读一段 ${lay.read}px / 读测速 ${lay.bench}px，之前是 591px）`);
  ok(lay.erase < 140, `擦除按钮同理（${lay.erase}px）`);
  ok(lay.paramRows === 4 && lay.paramGridRows === 1, `四个参数排**一行**而不是 2×2（实测 ${lay.paramGridRows} 行）`);
  ok(lay.out === lay.data, `🚨「读数据 / 写数据」两窗**精确等高**（${lay.out} vs ${lay.data}px）`);
  // 够不够大**跟窗口走**（900 高时 176px、820 高 136px、730 高 90px）——
  // 自测跑在用户那个窗口上，写死一个绝对值会随窗口大小假红；这里断的是"占比 + 地板"。
  ok(lay.out >= 80 && lay.out >= lay.cardH * 0.18,
     `两窗都够大（${lay.out}px / 卡片 ${lay.cardH}px；900 高的窗口下是 176px —— 原来写数据 90 而读数据 183）`);

  // 10.1 引脚下拉与固件拒绝规则对齐
  const pads = await ev(`
    const sel = document.getElementById('sp-pad-dc');
    const dis = [...sel.options].filter(o => o.disabled).map(o => o.dataset.pad);
    return { dis, note: document.getElementById('sp-pad-note').textContent };`);
  ok(pads.dis.includes('9') && pads.dis.includes('10'), `PY00/PY01 已灰掉（固件 v1 不支持）：${pads.dis.join(',')}`);
  /* 2026-09-30：桥搬到 SPI2 之后，灰名单变成"PB10~PB13（SPI2 固定脚）+ PA30（USB0_PWR 被 Q1 短到地）"，
     PA31 反而自由了（当年 qspi 档下灰 PA30/PA31 的规则已经删掉）。 */
  ok(pads.dis.includes('1') && pads.dis.includes('2') && pads.dis.includes('3') && pads.dis.includes('4'),
     `PB10~PB13 已灰掉（SPI2 的 CS/SCLK/MISO/MOSI）：${pads.dis.join(',')}`);
  ok(pads.dis.includes('12'), 'PA30 已灰掉（USB0_PWR 被板上 Q1 短到地）');
  ok(!pads.dis.includes('13'), 'PA31 是自由脚，不该灰');
  ok(/PB10~PB13/.test(pads.note) && /PA30/.test(pads.note), '提示文字里写明了为什么灰');
  ok(/PY00\/PY01/.test(pads.note), '提示文字里写明了为什么灰');

  /* 10.1b 默认值 + 切模式自动带 dummy（2026-10 用户现场要求）
   *   · 读模式默认 READ 0x03（1 线、不要 dummy）—— 不再一上来就是 QUAD I/O 0xEB
   *   · dummy 默认 0
   *   · 切模式 → dummy 自动跟着变（0x03→0、0x0B/0x3B/0x6B/0xEB→1），仍可手动改 */
  const flDefault = await ev(`
    const $ = id => document.getElementById(id);
    return { mode: $('sp-fl-mode').value, dummy: $('sp-fl-dummy').value };`);
  ok(flDefault.mode === '3' && flDefault.dummy === '0',
     `默认 = READ 0x03 + dummy 0（实际 mode=${flDefault.mode} dummy=${flDefault.dummy}）`);
  const flSwap = await ev(`
    const $ = id => document.getElementById(id);
    const out = [];
    for (const v of ['11', '3', '59', '107', '235']){
      $('sp-fl-mode').value = v;
      $('sp-fl-mode').dispatchEvent(new Event('change'));
      out.push([v, $('sp-fl-dummy').value]);
    }
    $('sp-fl-mode').value = '3'; $('sp-fl-mode').dispatchEvent(new Event('change'));
    return out;`);
  ok(JSON.stringify(flSwap) === JSON.stringify([['11','1'],['3','0'],['59','1'],['107','1'],['235','1']]),
     `切读模式自动带出 dummy：${JSON.stringify(flSwap)}`);

  // 10.2 读 ID
  const id = await ev(`
    document.getElementById('sp-fl-readid').click();
    await new Promise(r => setTimeout(r, 500));
    return { out: document.getElementById('sp-fl-out').textContent, log: document.getElementById('sp-log').textContent };`);
  ok(/Winbond/.test(id.out) && /16 MB/.test(id.out), `读 ID 显示厂商与容量：${id.out.split('\n')[1] || id.out}`);
  ok(/JEDEC ID/.test(id.log), '日志里也有');

  // 10.3 读 SFDP：**只出原始 256 B**（2026-10 用户要求：把后面的解读去掉）
  const sfdp = await ev(`
    document.getElementById('sp-fl-sfdp').click();
    for (let i = 0; i < 40 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    return { out: document.getElementById('sp-fl-out').textContent, dummy: document.getElementById('sp-fl-dummy').value };`);
  ok(/SFDP 原始 256 B/.test(sfdp.out), `标题写明是原始数据：${sfdp.out.split('\n')[0]}`);
  ok(/0000\s+53 46 44 50/.test(sfdp.out), 'hexdump 前 4 字节就是 "SFDP" 签名（原始字节）');
  ok(!/JESD216B|JESD216A|BFPT|DWORD|个参数表头|rev \d+\.\d+/.test(sfdp.out),
     '不再出现任何解读内容（版本名 / 参数表 / BFPT / DWORD 都没有）');
  ok(sfdp.dummy === '1', 'dummy 标定结果写回面板（模型用 8 拍，1 就对）');

  // 10.4 读状态：SR1/SR2 解码
  const sr = await ev(`
    document.getElementById('sp-fl-sr').click();
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('sp-fl-out').textContent;`);
  ok(/SR1/.test(sr) && /空闲/.test(sr), `读状态显示 SR1 且判为空闲`);
  ok(/QE=0/.test(sr), 'SR2 指出 QE=0（四线读不出来的头号原因，这里必须提示）');

  // 10.5 读一段：hexdump 出来
  const rd = await ev(`
    document.getElementById('sp-fl-mode').value = '3';   // READ 0x03（1 线，无 dummy）
    document.getElementById('sp-fl-addr').value = '0';
    document.getElementById('sp-fl-len').value = '64';
    document.getElementById('sp-fl-read').click();
    await new Promise(r => setTimeout(r, 600));
    return { out: document.getElementById('sp-fl-out').textContent, log: document.getElementById('sp-log').textContent };`);
  ok(/0000\s+ff ff ff/.test(rd.out), `擦除态读出全 FF（hexdump 带偏移）：${rd.out.split('\n')[1] || ''}`);
  ok(/Flash 读 64 B/.test(rd.log), '日志里有长度与速率');

  // 10.6 读测速：走 CS_HOLD 连续读，报实测与理论占比
  const bench = await ev(`
    document.getElementById('sp-fl-benchkb').value = '16';
    document.getElementById('sp-fl-bench').click();
    for (let i = 0; i < 60 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    return document.getElementById('sp-fl-out').textContent;`);
  ok(/MB\/s|KB\/s/.test(bench), `读测速给出速率：${bench.split('\n')[1] || bench}`);
  ok(/理论上限/.test(bench) && /%/.test(bench), '给出了"占理论值百分比"（不然不知道差在哪）');

  // 10.7 擦写要有闸：不勾确认时按钮是禁的
  const gate = await ev(`
    const ids = ['sp-fl-erase', 'sp-fl-write', 'sp-fl-writebench'];
    const off = ids.map(i => document.getElementById(i).disabled);
    document.getElementById('sp-fl-armed').checked = true;
    document.getElementById('sp-fl-armed').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 100));
    const on = ids.map(i => document.getElementById(i).disabled);
    return { off, on };`);
  ok(gate.off.every(Boolean), '没勾「我确认要擦写」时三个破坏性按钮全禁用');
  ok(gate.on.every(x => x === false), '勾上之后才可用');

  // 10.8 写 + 回读校验（写进 0x2000，之前是擦除态）
  const wr = await ev(`
    document.getElementById('sp-fl-addr').value = '0x2000';
    document.getElementById('sp-fl-len').value = '256';
    document.getElementById('sp-fl-fill').click();
    const data = document.getElementById('sp-fl-data').value.slice(0, 23);
    document.getElementById('sp-fl-write').click();
    for (let i = 0; i < 80 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    return { out: document.getElementById('sp-fl-out').textContent, data, log: document.getElementById('sp-log').textContent };`);
  ok(/回读一致 ✔/.test(wr.out), `写 256 B 后回读一致（写数据开头 ${wr.data}）`);
  ok(/写 \+ 校验/.test(wr.log), '日志里有写+校验的总结行');

  // 10.9 擦除扇区 + 再读回：应当变回 FF（证明确实擦掉了）
  const er = await ev(`
    document.getElementById('sp-fl-addr').value = '0x2000';
    document.getElementById('sp-fl-erase').click();
    for (let i = 0; i < 80 && window.__tools.spiSession.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    const out1 = document.getElementById('sp-fl-out').textContent;
    document.getElementById('sp-fl-len').value = '16';
    document.getElementById('sp-fl-read').click();
    await new Promise(r => setTimeout(r, 500));
    return { erased: out1, read: document.getElementById('sp-fl-out').textContent };`);
  ok(/擦除完成/.test(er.erased), `扇区擦除走完（${er.erased.split('\n')[0]}）`);
  ok(/0000\s+ff ff ff ff/.test(er.read), '擦完再读 → 全 FF（写入的内容确实没了）');

  // 10.10 四线读：QE=0 时页面必须看得出来不对（模型会说明原因）
  const quad = await ev(`
    document.getElementById('sp-fl-mode').value = '235';  // QUAD I/O 0xEB（4 线）
    document.getElementById('sp-fl-addr').value = '0';
    document.getElementById('sp-fl-len').value = '16';
    document.getElementById('sp-fl-read').click();
    await new Promise(r => setTimeout(r, 600));
    return { notes: window.__tools.spiSession.mockProbe.flashNotes.slice(-3), out: document.getElementById('sp-fl-out').textContent };`);
  ok(quad.notes.some(n => /QE=0/.test(n)), '四线读在 QE=0 时器件侧给出明确原因（页面按全 00 显示，与真机一致）');
}

// ==================================================================== 10b
console.log('== 10b. 「寄存器」面板：读一段 → 逐位改 → 只写改动 ==');
{
  // 假探针换成"寄存器器件"（BMP280 风格：读 0x80|reg + 1 字节 dummy、写 reg&0x7F、地址自增）
  const setup = await ev(`
    const s = window.__tools.spiSession, t = window.__tools.spi;
    const sel = document.getElementById('sp-mock-device');
    sel.value = 'regs'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    const dev = s.mockProbe.regdev;
    for (let i = 0; i < 128; i++) dev.regs[i] = (i * 3 + 5) & 0xff;
    document.querySelector('#sp-dock-tabs button[data-dock="reg"]').click();
    document.getElementById('sp-reg-profile').value = 'bmp280';
    document.getElementById('sp-reg-profile').dispatchEvent(new Event('change'));
    document.getElementById('sp-reg-start').value = '0x00';
    document.getElementById('sp-reg-count').value = '128';
    document.getElementById('sp-reg-read').click();
    await new Promise(r => setTimeout(r, 700));
    const cells = [...document.querySelectorAll('#sp-reg-body button.rb')];
    return { device: s.mockProbe.deviceKind, dock: t.dockTab,
             on: [...document.querySelectorAll('#sp-box-dock .dockpage.on')].map(p => p.dataset.dock),
             rows: document.querySelectorAll('#sp-reg-body tr').length, cells: cells.length,
             first: cells[0]?.textContent, last: cells[cells.length - 1]?.textContent,
             head: [...document.querySelectorAll('#sp-reg-head th')].map(x => x.textContent).join('|'),
             sum: document.getElementById('sp-reg-sum').textContent,
             notes: s.mockProbe.flashNotes.slice(-2) };`);
  ok(setup.device === 'regs', '假器件已切到「寄存器器件」');
  ok(setup.dock === 'reg' && setup.on.join(',') === 'reg', '切到「寄存器」tab 且只显示它');
  ok(setup.rows === 8 && setup.cells === 128, `128 个寄存器画成 16×8（实际 ${setup.rows} 行 / ${setup.cells} 格）`);
  ok(setup.first === '05' && setup.last === '82', `首末字节与假器件图案对账（${setup.first} … ${setup.last}）`);
  ok(setup.head === '地址|0|1|2|3|4|5|6|7|8|9|A|B|C|D|E|F|ASCII', '表头 = 地址 + 列号 0..F + ASCII', setup.head);
  ok(setup.notes.length === 0, 'dummy 给对（BMP280 档 = 0，手册核过）→ 器件侧没有报错', JSON.stringify(setup.notes));
  ok(/128 B/.test(setup.sum) && /一条命令连读|1 帧/.test(setup.sum), '摘要写明读回长度与帧数', setup.sum);

  // 点字节 → 位开关板 → 翻一位
  const edited = await ev(`
    const t = window.__tools.spi;
    document.querySelector('#sp-reg-body button.rb[data-off="0"]').click();
    await new Promise(r => setTimeout(r, 60));
    const pop = document.getElementById('sp-regpop');
    const open = !pop.hidden, bits = pop.querySelectorAll('#sp-regpop-bits button.bit').length;
    pop.querySelector('#sp-regpop-bits button.bit[data-k="0"]').click();      // 0x05 → 0x04
    await new Promise(r => setTimeout(r, 60));
    const cell = document.querySelector('#sp-reg-body button.rb[data-off="0"]');
    return { open, bits, cell: cell.textContent, chg: cell.classList.contains('chg'),
             chgBits: pop.querySelectorAll('#sp-regpop-bits button.bit.chg').length,
             cur: t.reg.cur[0], base: t.reg.base[0],
             writeDisabled: document.getElementById('sp-reg-write').disabled };`);
  ok(edited.open && edited.bits === 8, '点表里的字节 → 弹出 8 个 bit 的开关板');
  ok(edited.cur === 0x04 && edited.base === 0x05, '点 bit0 把 0x05 翻成 0x04（只改缓冲）');
  ok(edited.cell === '04' && edited.chg, '格子立刻变 04 并套上黄框');
  ok(edited.chgBits === 1, '开关板上"与原值不同的位"标了 1 个');
  ok(edited.writeDisabled === false, '有改动时「只写改动」可点');

  // 写回：只写改动落到假器件
  const wrote = await ev(`
    const s = window.__tools.spiSession, t = window.__tools.spi;
    document.getElementById('sp-reg-write').click();
    await new Promise(r => setTimeout(r, 600));
    const cell = document.querySelector('#sp-reg-body button.rb[data-off="0"]');
    return { dev0: s.mockProbe.regdev.regs[0], dev1: s.mockProbe.regdev.regs[1],
             base0: t.reg.base[0], chg: cell.classList.contains('chg'),
             writeDisabled: document.getElementById('sp-reg-write').disabled };`);
  ok(wrote.dev0 === 0x04, '「只写改动」真的写进了假器件（regs[0] = 0x04）');
  ok(wrote.dev1 === 0x08, '相邻没改的字节没动（regs[1] 仍是 0x08）', String(wrote.dev1));
  ok(wrote.base0 === 0x04 && wrote.chg === false, '写回成功后"器件现值"更新、黄框清掉');
  ok(wrote.writeDisabled === true, '没有改动了 → 「只写改动」自动灰掉');

  // dummy 给错 → 数据整体错位（假器件会如实报）。BMP280 的正确值是 **0**，
  // 所以这里故意填 1（网上"BMP280 要 1 个 dummy"那个误传就是这么来的）
  const badDummy = await ev(`
    const s = window.__tools.spiSession;
    s.mockProbe.flashNotes.length = 0;
    document.getElementById('sp-reg-dummy').value = '1';
    document.getElementById('sp-reg-dummy').dispatchEvent(new Event('change'));
    document.getElementById('sp-reg-read').click();
    await new Promise(r => setTimeout(r, 500));
    const out = { notes: s.mockProbe.flashNotes.slice(-2),
                  first: document.querySelector('#sp-reg-body button.rb')?.textContent };
    // 还原成 0（BMP280 的正确值）
    document.getElementById('sp-reg-dummy').value = '0';
    document.getElementById('sp-reg-dummy').dispatchEvent(new Event('change'));
    return out;`);
  ok(badDummy.notes.some(n => /dummy 不符/.test(n)), 'dummy 多给 1 字节 → 器件侧明确报"数据错位"', JSON.stringify(badDummy.notes));
  ok(badDummy.first !== '05', '……表里读到的第一个字节也确实错了（不是 0x05）', String(badDummy.first));
}

// ==================================================================== 10c
console.log('== 10c. 定时采集：loop + as 解码 + 实时值 ==');
{
  // 换成命令型 ADC（MCP3008 风格，采样值是活的正弦），跑一段 loop 采集
  const run = await ev(`
    const s = window.__tools.spiSession, t = window.__tools.spi;
    const sel = document.getElementById('sp-mock-device');
    sel.value = 'adc'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    document.getElementById('sp-dsl-text').value =
      'xfer tx=01,80,00 rx=3 as v=u16be(1)&0x3FF\\n' +
      'loop 25ms\\n  xfer tx=01,80,00 rx=3 as v=u16be(1)&0x3FF\\nend';
    document.getElementById('sp-dsl-run').click();
    await new Promise(r => setTimeout(r, 700));
    const liveRows = [...document.querySelectorAll('#sp-live-body tr')];
    const first = liveRows[0] ? { name: liveRows[0].children[0].textContent, last: liveRows[0].children[1].textContent,
                                  n: liveRows[0].children[4].textContent } : null;
    return { device: s.mockProbe.deviceKind, running: t.acq.running, ticks: t.acq.runner.stat.ticks,
             pill: document.getElementById('sp-acq-pill').textContent,
             rows: liveRows.length, first,
             sum: document.getElementById('sp-live-sum').textContent,
             spark: !!liveRows[0]?.querySelector('canvas'),
             samples: t.acq.live.get('v')?.n || 0,
             stopDisabled: document.getElementById('sp-dsl-stop').disabled };`);
  ok(run.device === 'adc' && run.running, '假器件切到 ADC，采集在跑');
  ok(run.ticks >= 8, `25 ms 周期在 700 ms 里跑了 ${run.ticks} 拍（≥8）`);
  ok(/采集/.test(run.pill) && /拍/.test(run.pill), '运行胶囊显示拍数（切到任何 tab 都看得见）', run.pill);
  ok(run.rows === 1 && run.first?.name === 'v', '实时值表里有 1 个变量 v', JSON.stringify(run.first));
  ok(run.samples >= 8, `v 采样了 ${run.samples} 次`);
  ok(run.spark, '……并画了迷你曲线');
  ok(run.stopDisabled === false, '「停止」可点');

  // 值在动（假 ADC 的采样是活的）
  const moving = await ev(`
    const t = window.__tools.spi;
    const a = t.acq.live.get('v')?.last;
    await new Promise(r => setTimeout(r, 300));
    const b = t.acq.live.get('v')?.last;
    return { a, b, ticks: t.acq.runner.stat.ticks };`);
  ok(moving.a !== moving.b, `采样值在变（${moving.a} → ${moving.b}）`);

  const stopped = await ev(`
    const t = window.__tools.spi;
    document.getElementById('sp-dsl-stop').click();
    await new Promise(r => setTimeout(r, 150));
    const ticks = t.acq.runner.stat.ticks;
    await new Promise(r => setTimeout(r, 200));
    return { running: t.acq.running, ticks, later: t.acq.runner.stat.ticks,
             pill: document.getElementById('sp-acq-pill').textContent };`);
  ok(!stopped.running && stopped.ticks === stopped.later, '点「停止」后不再采样');
  ok(!/采集 ·/.test(stopped.pill), '胶囊回到「未运行 / 已结束」', stopped.pill);

  // 收尾：假器件还原成 NOR（后面的收尾节与别的套件都按默认器件走）
  await ev(`
    const sel = document.getElementById('sp-mock-device');
    sel.value = 'flash'; sel.dispatchEvent(new Event('change'));
    document.querySelector('#sp-dock-tabs button[data-dock="cmd"]').click();
    await new Promise(r => setTimeout(r, 200));
    return true;`);
}

// ==================================================================== 11
console.log('== 11. 收尾：放掉探针（别的页签要用）==');
{
  const done = await ev(`
    const s = window.__tools.spiSession;
    s.setBusy(true);
    const protectedDuringSend = document.getElementById('sp-disconnect').disabled && document.getElementById('pn-disconnect').disabled;
    const rejected = (await s.disconnect()) === false && s.connected;
    s.setBusy(false);
    document.getElementById('sp-disconnect').click();
    await new Promise(r => setTimeout(r, 200));
    return { ...window.__tools.spi.summary(), protectedDuringSend, rejected,
      peerClosed: !window.__tools.panel.session.connected && !window.__tools.panel.session.dataReady,
      cleared: !s.usingMock && !s.mockProbe && !s.pollTimer };`);
  ok(done.connected === false && done.dataReady === false && done.peerClosed && done.cleared, '桥页关闭探针后，两页共用的连接与模拟状态全部释放');
  ok(done.protectedDuringSend && done.rejected, '传输中禁用关闭按钮，直接关闭调用也会拒绝');
  const err = await ev(`return window.__tools.summary().errors;`);
  ok(err.length === 0, '整场跑完页面无未捕获错误', JSON.stringify(err));
}

console.log(`\n${fail ? '❌' : '✅'} spi-bus-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
