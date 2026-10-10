/**
 * 「SPI/QSPI 屏」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/spi-panel-page.test.mjs   （等价：make test-spi-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 这一页的活儿是"把屏点亮"：**面板初始化代码**（贴 C 数组 → 解析 → 重放）、**图片/图案刷屏**、
 * 面板档与按屏套用推荐值。连同**共享会话**一起验：在屏页连接一次，桥页那边也得是同一个会话 ——
 * 这是拆页之后最容易退化的地方。
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

async function ev(expr){
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面里报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

/**
 * 切右列 tab（刷屏 / 面板初始化 / 读回）。
 * 每一节开始前显式切一次 —— **真实用户只能点看得见的那块**，测试也照这个来：
 * 页签不对时 getBoundingClientRect() 全是 0，断言会莫名其妙地失败。
 */
async function selectDock(name){
  await ev(`document.querySelector('#pn-dock-tabs button[data-dock="${name}"]').click(); return true;`);
  await sleep(220);
}

await send('Page.enable');
await send('Runtime.enable');
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
/**
 * 🚨 **先把窗口提到前台**：窗口被最小化/完全遮住时 `document.visibilityState === 'hidden'`，
 * 而 Chrome **不为隐藏页面渲染 `<video>`** —— `play()` 照样 resolve，但 `currentTime` 不走、
 * `requestVideoFrameCallback` 一帧都不回调。症状是 §9b（视频那条路）"0 帧"，而同节的
 * GIF/PNG（ImageDecoder 那条路）一切正常 —— 极易误判成代码坏了（2026-10 本文件踩过，
 * 当时排查了半天才发现是窗口被遮住）。
 */
await send('Page.bringToFront').catch(() => {});
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

/**
 * **预置清理**（跑之前先擦干净，跟 spi-bus-page 一个道理）：
 * `panel.dock`（上次停在哪张 tab）、`panel.logH` / `panel.codeH`（两条分隔条的记忆）
 * 都会跨次污染 —— 上一次把 dock 停在「读回」，这一节的"默认停在刷屏"就直接错。
 */
await sleep(800);
await ev(`(() => {
  const k = 'serial-rtt-tools:v1';
  const d = JSON.parse(localStorage.getItem(k) || '{}');
  for (const key of ['panel.dock', 'panel.logH', 'panel.codeH']) delete d[key];
  localStorage.setItem(k, JSON.stringify(d));
  return 1;
})()`);
await send('Page.reload', { ignoreCache: true });

let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.panel;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.panel 不存在）');

// ==================================================================== 1
console.log('== 1. 切到屏页 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(s.tabs.includes('spi') && s.tabs.includes('panel'), '桥页与屏页两个标签都在');
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  await ev(`document.querySelector('#tabs .tab[data-tab="panel"]').click(); return true;`);
  await sleep(300);
  ok(await ev(`return document.getElementById('tab-panel').classList.contains('active');`), '#tab-panel 变成 active');
  const preset = await ev(`return [...document.getElementById('pn-preset').options].map(o => o.value);`);
  ok(preset.join(',') === 'axs15352,st77916', `内置两块屏的推荐值都在（${preset.join('/')}）`);
}

// ==================================================================== 1b
console.log('== 1b. 布局（用户 2026-10 定稿）：右列 tab 化（刷屏 / 面板初始化 / 读回）+ 常驻日志 ==');
{
  const L = await ev(`
    const main = document.querySelector('#tab-panel .main');
    const dock = document.getElementById('pn-box-dock');
    const box = document.getElementById('pn-logbox');
    return {
      tabs: [...document.querySelectorAll('#pn-dock-tabs button[data-dock]')].map(b => b.dataset.dock),
      pages: [...dock.querySelectorAll('.dockpage')].map(p => p.dataset.dock),
      onPages: [...dock.querySelectorAll('.dockpage.on')].map(p => p.dataset.dock),
      mainOver: getComputedStyle(main).overflowY,
      mainScroll: main.scrollHeight - main.clientHeight,
      pill: document.getElementById('pn-run-pill').textContent,
      abort: !!document.getElementById('pn-run-abort'),
      abortDisabled: document.getElementById('pn-run-abort').disabled,
      logInsideDock: !!dock.querySelector('#pn-logbox'),
      logH: Math.round(box.getBoundingClientRect().height),
      logGrip: !!document.getElementById('pn-grip-log'),
      fold: document.querySelectorAll('#tab-panel .foldbtn').length,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };`);
  ok(L.tabs.join(',') === 'img,img-settings,anim,code,read', `tab 段 = 刷屏 / 图片设置 / 动画 / 面板初始化 / 读回（实测 ${L.tabs.join(' / ')}）`);
  ok(L.pages.join(',') === 'img,img-settings,anim,code,read' && L.onPages.join(',') === 'img',
     `三个 tab 页按序排、默认停在「刷屏」（本页最高频的动作；实测 ${L.pages.join(' → ')} / 亮着 ${L.onPages}）`);
  ok(L.mainOver === 'hidden' && L.mainScroll <= 1,
     `右列**自己不再滚动**（overflow-y=${L.mainOver}，差 ${L.mainScroll}px）—— 高度交给当前 tab（原来要滚 761px）`);
  ok(L.logInsideDock === false && L.logH >= 60 && L.logGrip,
     `日志常驻在 dock 之外（${L.logH}px + 分隔条）—— 不占 tab、切到哪一页都在（用户 2026-09-30/2026-10 两条要求同时满足）`);
  ok(L.abort && L.abortDisabled === true && /空闲|未连接/.test(L.pill),
     `tab 栏上有运行胶囊「${L.pill}」+ 中止按钮（空闲时禁用）`);

  /**
   * 胶囊 / 中止的联动（直接驱动，不跟毫秒级的假探针抢时序 —— 跑起来再读会 flaky）：
   * 有操作在跑 → 胶囊变绿、中止可点；中止 → 三个 abort 旗一起竖起来；跑完 → 退回空闲。
   */
  const act = await ev(`
    const pill = document.getElementById('pn-run-pill'), ab = document.getElementById('pn-run-abort');
    const panel = window.__tools.panel;
    panel.setActivity('重放 0..191', { done: 12, total: 194 });
    const on = { text: pill.textContent, cls: pill.className, disabled: ab.disabled };
    ab.click();
    const flags = { play: panel.playAbort, read: panel.readAbort, img: panel.imgAbort };
    panel.playAbort = false; panel.readAbort = false; panel.imgAbort = false;   // 放开，别影响后面几节
    panel.setActivity(null);
    const off = { text: pill.textContent, disabled: ab.disabled };
    return { on, flags, off };`);
  ok(/重放 0\.\.191 12\/194/.test(act.on.text) && /dockrun on/.test(act.on.cls) && act.on.disabled === false,
     `有操作在跑 → 胶囊「${act.on.text}」高亮、中止可点`);
  ok(act.flags.play === true && act.flags.read === true && act.flags.img === true,
     '点中止 → 重放 / 读回 / 刷图三个旗一起竖起来（切到哪个 tab 都按得到同一个按钮）');
  ok(/空闲|未连接/.test(act.off.text) && act.off.disabled === true,
     `跑完退回「${act.off.text}」（第 1b 节还没连探针，所以是"未连接"而不是"空闲"）、中止重新禁用`);
  ok(L.fold === 0, '折叠按钮**全部删除**（tab 本身就是显示 / 隐藏）');
  ok(L.docOverflow === false, '整页没有横向滚动条');

  // 每个 tab 页**吃满整块高度**、不出现纵向滚动（矮窗口才允许内部兜底滚动）
  for (const t of ['img', 'code', 'read']){
    await selectDock(t);
    const m = await ev(`
      const pg = document.querySelector('#pn-box-dock .dockpage.on');
      const dock = document.getElementById('pn-box-dock').getBoundingClientRect();
      // "被压扁"= overflow:hidden 的元素被 flex 缩到内容以下（字会被切掉一半）——
      // 用户 2026-10 截图就是摘要行被压成 4px。auto/scroll 的那两块本来就该自己滚，不算。
      const clipped = [...pg.children].filter(el => {
        const cs = getComputedStyle(el);
        return cs.overflowY === 'hidden' && el.getBoundingClientRect().height + 1 < el.scrollHeight;
      }).map(el => el.id || el.className);
      // 空间真的不够时，允许 tab 页自己滚 —— 但前提是"该让位的那块已经缩到 min-height 了"
      const flexEl = pg.querySelector('#pn-code-wrap, .canvasrow, .readrow');
      const minH = parseFloat(getComputedStyle(flexEl).minHeight) || 0;
      return { tab: pg.dataset.dock, h: Math.round(pg.getBoundingClientRect().height),
               dockH: Math.round(dock.height), legendH: Math.round(document.querySelector('#pn-box-dock>.dockhead').getBoundingClientRect().height),
               over: pg.scrollHeight - pg.clientHeight, clipped,
               flexH: Math.round(flexEl.getBoundingClientRect().height), minH, flexName: flexEl.id || flexEl.className };`);
    // 断言用**相对量**：窗口多大都不该假红（自测跑在用户那个窗口上，尺寸不由我们定）
    ok(m.tab === t && m.h >= m.dockH - m.legendH - 24,
       `「${t}」tab 吃满整块高度（${m.h}px ≈ dock ${m.dockH} − tab栏 ${m.legendH}）`);
    ok(m.clipped.length === 0,
       `「${t}」里没有控件行被压扁（${m.flexName} 让位到 ${m.flexH}px / 下限 ${m.minH}）` + (m.clipped.length ? ` —— 被压的是 ${m.clipped.join(', ')}` : ''));
    ok(m.over <= 1 || m.flexH <= m.minH + 1,
       `「${t}」装得下就不滚（溢出 ${m.over}px；真装不下时是"${m.flexName}"先缩到下限 ${m.minH}px 再让整页滚）`);
  }

  // 刷屏 tab：预览画布填满所在行（原来 max-height:170px 写死，360×360 的屏缩到 138×170 根本看不清）
  await selectDock('img');
  const cv = await ev(`
    const c = document.getElementById('pn-canvas'), r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    const row = c.closest('.canvasrow').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), rowH: Math.round(row.height),
             of: cs.objectFit, pos: cs.position, attr: c.width + 'x' + c.height };`);
  ok(cv.pos === 'absolute' && cv.of === 'contain' && cv.h > 150 && Math.abs(cv.h - cv.rowH) <= 1,
     `刷屏预览画布 ${cv.w}×${cv.h} 正好填满所在行（行高 ${cv.rowH}）· object-fit=${cv.of} 保比例不拉变形 · 绝对定位（不然它会把整页顶爆）`);
  ok(cv.attr === '240x296', `画布的位图尺寸仍是屏几何（${cv.attr}）`);

  const sendVisible = await ev(`const b=document.getElementById('pn-img-send'),r=b.getBoundingClientRect(),p=document.getElementById('pn-img-card').getBoundingClientRect();return !!b.closest('.pn-image-tools')&&!b.closest('.imginfo')&&r.top>=p.top&&r.bottom<=p.bottom&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b;`);
  ok(sendVisible, '刷图按钮独立于预览设置滚动区，完整可见且未被遮挡');
  const previewLayout=await ev(`const p=document.getElementById('pn-img-card'),c=document.getElementById('pn-canvas').getBoundingClientRect(),box=document.getElementById('pn-image-drop').getBoundingClientRect();return p.scrollHeight<=p.clientHeight+1&&Math.abs(c.width-box.width)<=1&&document.querySelectorAll('#pn-patterns .pattern-group').length===2;`);
  ok(previewLayout, '刷屏页无纵向滚动，预览占满区域，图案分为两组');

  // 面板初始化 tab：解析表**不再写死 360px**，改为吃剩余高度 + 一条可拖的分隔条
  await selectDock('code');
  const tb = await ev(`
    const wrap = document.getElementById('pn-code-wrap'), ta = document.getElementById('pn-code-text');
    const pg = document.querySelector('#pn-box-dock .dockpage.on').getBoundingClientRect();
    return { tableH: Math.round(wrap.getBoundingClientRect().height), rows: document.querySelectorAll('#pn-code-body tr').length,
             taH: Math.round(ta.getBoundingClientRect().height), taMin: parseFloat(getComputedStyle(ta).minHeight), grow: getComputedStyle(wrap).flexGrow,
             pageH: Math.round(pg.height), grip: !!document.getElementById('pn-grip-code') };`);
  ok(tb.grow === '1' && tb.tableH >= 120,
     `解析表是**弹性**的那一块（flex-grow=1：${tb.tableH}px / ${tb.pageH}px 页高 / ${tb.rows} 行）—— 不再是写死的 360px`);
  ok(tb.taH >= tb.taMin && tb.taMin >= 56 && tb.grip, `源码文本框 ${tb.taH}px ≥ CSS 下限 ${tb.taMin}px，保留可拖分隔条`);

  // 拖分隔条：文本框长高 → **表格同步变矮**（这条才是"吃剩余高度"的功能性证据，与窗口尺寸无关）
  const drag = await ev(`
    const wrap = document.getElementById('pn-code-wrap');
    const grip = document.getElementById('pn-grip-code'), ta = document.getElementById('pn-code-text');
    // 自动高度可低于手动拖动下限；从范围内的 100px 验证往返，避免把下限钳制误判成布局失败。
    ta.style.height = '100px';
    const before = Math.round(ta.getBoundingClientRect().height);
    const tableBefore = Math.round(wrap.getBoundingClientRect().height);
    const r = grip.getBoundingClientRect();
    const drag = dy => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { clientY: r.top + 4, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: r.top + 4 + dy, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: r.top + 4 + dy, bubbles: true }));
    };
    drag(-30);
    await new Promise(r2 => setTimeout(r2, 150));
    const after = Math.round(ta.getBoundingClientRect().height);
    const tableAfter = Math.round(wrap.getBoundingClientRect().height);
    const saved = JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}')['panel.codeH'];
    drag(30);
    await new Promise(r2 => setTimeout(r2, 150));
    return { before, after, tableBefore, tableAfter, tableMin: parseFloat(getComputedStyle(wrap).minHeight),
             back: Math.round(ta.getBoundingClientRect().height), saved };`);
  ok(drag.after > drag.before && Math.abs(drag.saved - drag.after) <= 2,
     `拖分隔条：文本框 ${drag.before} → ${drag.after}px，并记进 store（panel.codeH=${drag.saved}）`);
  // 表格已经被压到 min-height 时，让不出来的部分由"整页滚"接手 —— 所以按"还能让多少"来断
  const canGive = Math.max(10, drag.tableBefore - drag.tableMin - 2);
  ok(drag.tableBefore - drag.tableAfter >= Math.min(25, canGive),
     `文本框长高的那 30px 是从表格里让出来的（表格 ${drag.tableBefore} → ${drag.tableAfter}px，下限 ${drag.tableMin}）—— 弹性而非写死`);
  ok(Math.abs(drag.back - drag.before) <= 2, `拖回去复原（${drag.back}px）`);

  // 读回 tab：**它自己的**画布（#pn-canvas 在刷屏 tab 里，非活动 tab 是 display:none）
  await selectDock('read');
  const rd = await ev(`
    const c = document.getElementById('pn-read-canvas'), r = c.getBoundingClientRect();
    const row = c.closest('.readrow').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), rowH: Math.round(row.height),
             of: getComputedStyle(c).objectFit,
             same: c === document.getElementById('pn-canvas'),
             sum: document.getElementById('pn-read-sum').textContent,
             bo: !!document.getElementById('pn-read-byteorder'), sw: !!document.getElementById('pn-read-swap') };`);
  ok(rd.same === false && rd.h > 120 && Math.abs(rd.h - rd.rowH) <= 1,
     `读回有**自己的**画布 ${rd.w}×${rd.h}（填满所在行 ${rd.rowH}）—— 不能再和静图/动画共用 #pn-canvas（否则结果画进隐藏页，用户什么也看不到）`);
  ok(rd.of === 'contain', `读回画布也按比例铺满（object-fit=${rd.of}）`);
  ok(rd.bo && rd.sw, '读回 tab 里带一份「字节序 / R-B 交换」（翻颜色不用切回刷屏 tab）');

  // 两个显示开关双向同步（改哪边都一样）
  const sw = await ev(`
    const a = document.getElementById('pn-byteorder'), b = document.getElementById('pn-read-byteorder');
    b.value = 'le'; b.dispatchEvent(new Event('change'));
    const r1 = { a: a.value, b: b.value };
    a.value = 'be'; a.dispatchEvent(new Event('change'));
    const r2 = { a: a.value, b: b.value };
    return { r1, r2 };`);
  ok(sw.r1.a === 'le' && sw.r2.b === 'be', `读回 tab 的「字节序」与刷屏 tab 双向同步（读回改 → 刷屏 ${sw.r1.a}；刷屏改 → 读回 ${sw.r2.b}）`);

  // 表头吸顶（用户 2026-09-30："往下拉表头就上去了，看不到 byte 索引了"）—— 在初始化 tab 里量
  await selectDock('code');
  const sticky = await ev(`
    const wrap = document.getElementById('pn-code-wrap');
    const th = document.querySelector('#pn-code-tab thead th');
    const ruler = document.getElementById('pn-code-ruler');
    const off = () => Math.round(th.getBoundingClientRect().top - wrap.getBoundingClientRect().top);
    const off0 = off();
    wrap.scrollTop = wrap.scrollHeight;
    await new Promise(r => setTimeout(r, 250));
    const off1 = off();
    const rulerVisible = ruler.getBoundingClientRect().top >= wrap.getBoundingClientRect().top - 1;
    const rowVisible = document.querySelectorAll('#pn-code-body tr')[20].getBoundingClientRect().top;
    wrap.scrollTop = 0;
    await new Promise(r => setTimeout(r, 100));
    return { off0, off1, rulerVisible, rowVisible: Math.round(rowVisible),
             pos: getComputedStyle(th).position, bg: getComputedStyle(th).backgroundColor };`);
  ok(sticky.pos === 'sticky' && Math.abs(sticky.off0) <= 1 && Math.abs(sticky.off1) <= 1 && sticky.rulerVisible,
     `表头（含字节标尺）吸顶：滚到底仍在容器顶部（偏移 ${sticky.off0} → ${sticky.off1}px，尺子可见=${sticky.rulerVisible}）`);
  ok(sticky.bg !== 'rgba(0, 0, 0, 0)', `吸顶表头有不透明背景（${sticky.bg}）—— 不然行会从底下透出来`);
  await selectDock('img');             // 后面的用例从"刷屏"这条常识路径接着跑
}

// ==================================================================== 2
console.log('== 2. 共享会话：在屏页连接，桥页也是同一个会话 ==');
{
  const linked = await ev(`
    const c = document.getElementById('pn-mock'); c.checked = true; c.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    const bus = window.__tools.spi.summary(), pn = window.__tools.panel.summary();
    return { busConn: bus.connected, busData: bus.dataReady, pnConn: pn.connected, pnData: pn.dataReady,
             sameProbe: window.__tools.spiSession.mockProbe === window.__tools.spiSession.hid,
             busState: document.getElementById('sp-state').textContent,
             pnState: document.getElementById('pn-state').textContent };`);
  ok(linked.pnConn && linked.pnData, '屏页勾「用假探针」→ 屏页就绪');
  ok(linked.busConn && linked.busData, '**桥页也同时就绪**（一次连接，两页共用）');
  ok(linked.sameProbe === true, '假探针只有一个实例（HID 与数据面共用）');
  ok(/假探针/.test(linked.busState) && /假探针/.test(linked.pnState),
     `两页的状态行都更新了（桥「${linked.busState}」/ 屏「${linked.pnState}」）`);
}

// ==================================================================== 3
console.log('== 3. 面板档：默认 raw → 写 spi_dcx → 写 qspi ==');
{
  const def = await ev(`
    document.getElementById('pn-prof-get').click();
    await new Promise(r => setTimeout(r, 300));
    return { sel: document.getElementById('pn-profile').value, sum: document.getElementById('pn-sum-profile').textContent };`);
  ok(def.sel === '0' && /raw/.test(def.sum), `默认档 0 raw（select=${def.sel} · 摘要「${def.sum}」）`);

  const p1 = await ev(`
    document.getElementById('pn-profile').value = '1';
    document.getElementById('pn-deflines').value = '1';
    document.getElementById('pn-dcactive').checked = true;
    document.getElementById('pn-cshold').checked = true;
    document.getElementById('pn-prof-set').click();
    await new Promise(r => setTimeout(r, 400));
    return window.__tools.spiSession.profile;`);
  ok(p1.profile === 1 && p1.dcActiveHigh === true && p1.csHoldInStep === true,
     '档 1（spi_dcx）写进去了：DC 高=数据、翻 DC 保持 CS');

  const p2 = await ev(`
    document.getElementById('pn-profile').value = '2';
    document.getElementById('pn-qspiwr').value = '0x02';
    document.getElementById('pn-qspicolor').value = '0x32';
    document.getElementById('pn-qspiaddr').value = '3';
    document.getElementById('pn-prof-set').click();
    await new Promise(r => setTimeout(r, 400));
    return { prof: window.__tools.spiSession.profile, busProf: window.__tools.spi.summary().profile };`);
  ok(p2.prof.profile === 2 && p2.prof.qspiColorOpcode === 0x32 && p2.prof.qspiAddrBytes === 3,
     '档 2（qspi）写进去了：0x02 / 0x32 / 3 字节地址');
  ok(p2.busProf?.profile === 2, '桥页摘要里也是同一个档位（共享会话）');
}

// ==================================================================== 4
console.log('== 4. 按屏套用推荐值（档位 + SCLK + 引脚）==');
{
  const applied = await ev(`
    document.getElementById('pn-preset').value = 'st77916';
    document.getElementById('pn-preset').dispatchEvent(new Event('change'));
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    const s = window.__tools.spiSession;
    return { cfg: s.cfg, prof: s.profile, probe: { sclk: s.mockProbe.cfg.sclkHz, dc: s.mockProbe.cfg.padDc, rst: s.mockProbe.cfg.padRst },
             log: document.getElementById('pn-log').textContent,
             sum: { sclk: document.getElementById('pn-sum-sclk').textContent, pads: document.getElementById('pn-sum-pads').textContent } };`);
  ok(applied.prof.profile === 2, 'ST77916 → 档 2（qspi）');
  ok(applied.cfg.sclkHz === 40000000 && applied.probe.sclk === 40000000, 'ST77916 → SCLK 40 MHz（页面与探针都对）');
  // RST = **PA02**（2026-09-30 实测：PA02 抓得到复位波形、PA31 抓不到）。
  // 这条要紧：「重放前先复位」就发在这个脚上，默认值配错等于没复位。
  ok(applied.cfg.padDc === 0 && applied.cfg.padRst === 5 && applied.cfg.padBl === 13,
     `引脚按屏改了：DC=${applied.cfg.padDc}（不用）/ RST=PA02（pad ${applied.cfg.padRst}）/ BL=PA31（pad ${applied.cfg.padBl}）`);
  ok(/40 MHz/.test(applied.sum.sclk), `只读摘要显示 SCLK ${applied.sum.sclk}`);
  ok(/RST=PA02/.test(applied.sum.pads), `只读摘要显示引脚「${applied.sum.pads}」`);
  ok(/回读对账一致/.test(applied.log), '套用走的还是回读对账那条路（不靠状态字的 err）');

  const back = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    const s = window.__tools.spiSession;
    return { prof: s.profile.profile, sclk: s.cfg.sclkHz, dc: s.cfg.padDc, rst: s.cfg.padRst, bl: s.cfg.padBl };`);
  /* 2026-10 用户要求：AXS15352 的引脚**跟引脚分配图的推荐值一致**（AUX_DEFAULT），
   * 不再各屏一套 —— DC=PA26 / RST=PA02 / BL=PA31。 */
  ok(back.prof === 1 && back.sclk === 40000000 && back.dc === 14 && back.rst === 5 && back.bl === 13,
     `换回 AXS15352 → 档 1 + 40 MHz + DC=PA26/RST=PA02/BL=PA31（实测 ${back.prof}/${back.sclk}/${back.dc}/${back.rst}/${back.bl}）`);
}

// ==================================================================== 4b
console.log('== 4b. 自定义分辨率（内置两款之外的屏，如 240×240 的 GC9A01）==');
{
  const list = await ev(`return [...document.querySelectorAll('#pn-geom option')].map(o => o.value);`);
  ok(list.includes('gc9a01'), `屏列表里有 gc9a01（240×240）：${list.join(',')}`);
  ok(list.includes('custom'), '屏列表里有「自定义…」');

  const cg = await ev(`
    const $ = id => document.getElementById(id);
    $('pn-geom').value = 'custom';
    $('pn-geom').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 150));
    const editable = !$('pn-w').disabled && !$('pn-h').disabled;
    $('pn-w').value = '240'; $('pn-w').dispatchEvent(new Event('change'));
    $('pn-h').value = '240'; $('pn-h').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    const s = window.__tools.panel.summary();
    return { editable, geom: s.geom, w: s.geomW, h: s.geomH,
             cw: $('pn-canvas').width, ch: $('pn-canvas').height };`);
  ok(cg.editable, '选「自定义…」后宽高两个框变成可编辑');
  ok(cg.geom === 'custom' && cg.w === 240 && cg.h === 240, `自定义 240×240 生效（summary：${cg.geom} ${cg.w}×${cg.h}）`);
  ok(cg.cw === 240 && cg.ch === 240, `画布跟着变 240×240（实测 ${cg.cw}×${cg.ch}）`);

  const named = await ev(`
    const $ = id => document.getElementById(id);
    $('pn-geom').value = 'gc9a01'; $('pn-geom').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    const s = window.__tools.panel.summary();
    return { w: $('pn-w').value, h: $('pn-h').value, sw: s.geomW, sh: s.geomH, disabled: $('pn-w').disabled,
             cw: $('pn-canvas').width, ch: $('pn-canvas').height };`);
  ok(named.sw === 240 && named.sh === 240 && named.cw === 240 && named.ch === 240,
     `选中 gc9a01 后几何 240×240（画布 ${named.cw}×${named.ch}）`);
  ok(named.w === '240' && named.h === '240' && named.disabled,
     '选命名款时宽高框自动填成该屏尺寸并灰掉（避免误改内置屏）');
}

// ==================================================================== 5
console.log('== 5. 面板初始化：内置示例 + 解析 + 表格 ==');
{
  await selectDock('code');            // 这一节的控件都在「面板初始化」tab 里
  const onLoad = await ev(`
    return { text: document.getElementById('pn-code-text').value.length,
             sum: document.getElementById('pn-code-sum').textContent,
             rows: window.__tools.panel.summary().rows,
             table: document.querySelectorAll('#pn-code-body tr').length };`);
  ok(onLoad.text > 500, `一进来就载入了内置示例（${onLoad.text} 字符）`);
  // 面板**不再替用户的表补命令**（2026-09-30 用户要求去掉"自动补 MADCTL/COLMOD"）：
  // 表格行数 == 解析出的条数，摘要里也不该再出现"自动补"字样。
  ok(onLoad.rows === 30 && onLoad.table === 30, `默认示例 = AXS15352 的 30 条，表格 30 行（不再自动补前缀）（${onLoad.rows}/${onLoad.table}）`);
  ok(/认出 30 条/.test(onLoad.sum) && !/自动补/.test(onLoad.sum), `摘要只报解析结果、不提"自动补"：「${onLoad.sum.slice(0, 72)}」`);

  // 切到 ST77916 示例（192 条 / 215 参数字节 / 120 ms）
  const st = await ev(`
    document.getElementById('pn-code-preset').value = 'st77916';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 400));
    return { sum: document.getElementById('pn-code-sum').textContent,
             rows: window.__tools.panel.summary().rows,
             table: document.querySelectorAll('#pn-code-body tr').length };`);
  ok(st.rows === 192 && st.table === 192, `ST77916 示例解析出 192 条，表格 192 行（去掉前缀后不再多 2 行，实测 ${st.rows}/${st.table}）`);
  ok(/215 参数字节/.test(st.sum) && /累计延时 120 ms/.test(st.sum), `统计与源文件声明一致：「${st.sum.replace(/ · 格式 \w+/, '')}」`);

  // 自己贴一段：C 数组（含一行故意写坏的）
  const pasted = await ev(`
    document.getElementById('pn-code-text').value =
      '/* 我自己贴的 */\\n' +
      'static const x y[] = {\\n' +
      '  {0xCE, (uint8_t[]){0x5A, 0xA5}, 2, 0},\\n' +
      '  {0x11, NULL, 0, 100},\\n' +
      '  {0xZZ, NULL, 0, 0},\\n' +
      '};\\n';
    document.getElementById('pn-code-parse').click();
    await new Promise(r => setTimeout(r, 300));
    return { sum: document.getElementById('pn-code-sum').textContent,
             rows: window.__tools.panel.summary().rows,
             errs: window.__tools.panel.summary().parseErrors,
             log: document.getElementById('pn-log').textContent };`);
  ok(pasted.rows === 2, `贴进去的 C 数组解析出 2 条（坏的那行不算：${pasted.rows}）`);
  ok(pasted.errs >= 1 && /没认出来/.test(pasted.log), `写坏的那行被点出来（${pasted.errs} 条错误，日志里有「第 N 行没认出来」）`);

  // 导出的 C 片段能被自己再解析回来（往返）
  const round = await ev(`
    const P = await import('/app/spi/panel-code.js');
    const rows = window.__tools.panel.rows;
    const c = P.rowsToC(rows);
    const back = P.parsePanelCode(c);
    return { text: c.slice(0, 48), n: back.rows.length, first: back.rows[0]?.cmd };`);
  ok(round.n === 2 && round.first === 0xce, `导出的 C 片段能再解析回来（${round.n} 条）`);
}

// ==================================================================== 5b
console.log('== 5b. 字节编辑（照 bmp_sender.html）：每格一个字节可直接敲 + 点开位开关板 ==');
{
  await selectDock('code');            // 位开关板按格子的位置弹（元素必须在可见 tab 里才有真实坐标）
  const opened = await ev(`
    // 用内置 AXS15352 示例。去掉自动补前缀后首行 = 厂家表第一条 0xCE ← 5A A5，
    // 这里点**第 2 个参数字节**（0xA5）—— 位开关板要能对着任意一个参数字节打开。
    document.getElementById('pn-code-preset').value = 'axs15352';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 300));
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx:nth-of-type(2)');
    cell.click();
    await new Promise(r => setTimeout(r, 80));
    const pop = document.getElementById('pn-bitpop');
    const bits = [...pop.querySelectorAll('#pn-bitpop-bits button.bit')];
    return { hidden: pop.hidden, bits: bits.length,
             onBits: bits.filter(b => b.classList.contains('on')).length,
             chgBits: bits.filter(b => b.classList.contains('chg')).length,
             firstBit: bits[0]?.textContent.replace(/\\s+/g, ' ').trim(),
             title: document.getElementById('pn-bitpop-title').textContent,
             val: document.getElementById('pn-bitpop-val').textContent,
             hint: document.getElementById('pn-bitpop-hint').textContent,
             acts: [...pop.querySelectorAll('button[data-bit]')].map(b => b.dataset.bit),
             ruler: document.getElementById('pn-code-ruler').textContent.trim(),
             cellCount: document.querySelectorAll('#pn-code-body tr:nth-child(1) td.params input.bx').length,
             text: document.getElementById('pn-code-text').value };`);
  ok(opened.hidden === false && opened.bits === 8, `点参数字节弹出 8 个 bit 方块（bit 数 ${opened.bits}）`);
  // 去掉自动补前缀后，首行是厂家表第一条（AXS15352 = 0xCE ← 5A A5），
  // 位开关板这时指的第 2 个参数字节 = 0xA5
  ok(opened.onBits === 4 && opened.chgBits === 0 && /0xA5 = 165 = 0b10100101/.test(opened.val),
     `当前值 0xA5 亮 4 位（「${opened.val}」）`);
  ok(/bit7/.test(opened.firstBit) && /128/.test(opened.firstBit), `方块是"bit号 + 0/1 + 权重"三行：${opened.firstBit}`);
  ok(/第 0 条（0xCE）· 第 1 字节/.test(opened.title), `标题带行号与字节号：「${opened.title}」`);
  ok(!/MADCTL|BGR/.test(opened.hint), `0xCE 不在位名表里 → 只给位号/权重、不猜位名（${opened.hint.slice(0, 40)}…）`);
  ok(opened.acts.join(',') === 'zero,ones,inv,orig,close', `一排快捷键齐了（${opened.acts.join('/')}）`);
  ok(/^0 1 2 3/.test(opened.ruler), `表头有字节序号标尺：「${opened.ruler.slice(0, 24)}…」`);
  ok(opened.cellCount >= 1, `参数字节每格一个输入框（第 0 行 ${opened.cellCount} 格）`);

  const toggled = await ev(`
    const pop = document.getElementById('pn-bitpop');
    pop.querySelector('#pn-bitpop-bits button.bit[data-k="3"]').click();      // 0xA5 的 bit3（0xA5 该位本来就是 0）
    await new Promise(r => setTimeout(r, 80));
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx:nth-of-type(2)');
    const row = window.__tools.panel.effectiveRows[0];
    return { val: document.getElementById('pn-bitpop-val').textContent,
             onBits: [...pop.querySelectorAll('#pn-bitpop-bits button.bit')].filter(b => b.classList.contains('on')).length,
             chgBits: [...pop.querySelectorAll('#pn-bitpop-bits button.bit')].filter(b => b.classList.contains('chg')).length,
             cell: cell.value, dirty: document.querySelectorAll('#pn-code-body tr.dirty').length,
             data: Array.from(row.data),
             sum: document.getElementById('pn-code-sum').textContent,
             text: document.getElementById('pn-code-text').value };`);
  ok(/0xAD = 173 = 0b10101101/.test(toggled.val) && /原 0xA5/.test(toggled.val), `勾 bit3 → 0xAD 并标出原值（${toggled.val}）`);
  ok(toggled.onBits === 5 && toggled.chgBits === 1,
     `0xAD 亮 5 位（bit7/5/3/2/0），其中刚勾的 bit3 被标成"和原值不同"（黄框）`);
  ok(toggled.data[1] === 0xad && toggled.cell === 'ad', `表格格子与行数据同步（cell=${toggled.cell} data=${toggled.data}）`);
  ok(toggled.dirty === 1 && /已改 1 行/.test(toggled.sum), `行变脏 + 摘要说明「${toggled.sum.slice(0, 60)}…」`);
  ok(toggled.text === opened.text && opened.text.length > 500,
     `上面的文本框一个字符都没动（${opened.text.length} 字符逐字节相同 —— 原文是用户的资产）`);

  const typed = await ev(`
    // 表格里**直接敲十六进制**（与点 bit 走同一条路） + 一键快捷键 + 「改回」
    // 位开关板当前指着第 1 个参数字节（0xA5），敲 5A 后它要跟着同步
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx:nth-of-type(2)');
    cell.value = '5a'; cell.dispatchEvent(new Event('change', { bubbles: true }));   // 真浏览器里 change 会冒泡
    await new Promise(r => setTimeout(r, 60));
    const afterType = { data: Array.from(window.__tools.panel.effectiveRows[0].data), val: document.getElementById('pn-bitpop-val').textContent };
    document.getElementById('pn-bitpop').querySelector('button[data-bit="inv"]').click();      // 逐位取反
    await new Promise(r => setTimeout(r, 60));
    const afterInv = Array.from(window.__tools.panel.effectiveRows[0].data);
    document.getElementById('pn-bitpop').querySelector('button[data-bit="orig"]').click();     // 恢复原值
    await new Promise(r => setTimeout(r, 60));
    const afterOrig = { data: Array.from(window.__tools.panel.effectiveRows[0].data),
                        dirty: document.querySelectorAll('#pn-code-body tr.dirty').length,
                        sum: document.getElementById('pn-code-sum').textContent };
    // 再改一次，然后点行尾「改回」
    document.getElementById('pn-bitpop').querySelector('button[data-bit="ones"]').click();
    await new Promise(r => setTimeout(r, 60));
    const dirtyBefore = document.querySelectorAll('#pn-code-body tr.dirty').length;
    document.querySelector('#pn-code-body button[data-act="revert"]').click();
    await new Promise(r => setTimeout(r, 80));
    const afterRevert = { data: Array.from(window.__tools.panel.effectiveRows[0].data),
                          dirty: document.querySelectorAll('#pn-code-body tr.dirty').length,
                          cell: document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx:nth-of-type(2)').value,
                          sum: document.getElementById('pn-code-sum').textContent };
    document.getElementById('pn-bitpop').querySelector('button[data-bit="close"]').click();
    await new Promise(r => setTimeout(r, 60));
    return { afterType, afterInv, afterOrig, dirtyBefore, afterRevert, hidden: document.getElementById('pn-bitpop').hidden };`);
  ok(typed.afterType.data[1] === 0x5a && /0x5A/.test(typed.afterType.val), '直接在格子里敲十六进制就改了字节（位开关板同步）');
  ok(typed.afterInv[1] === 0xa5, `逐位取反 = 0xA5（0x${typed.afterInv[1].toString(16)}）`);
  ok(typed.afterOrig.data[1] === 0xa5 && typed.afterOrig.dirty === 0 && !/已改/.test(typed.afterOrig.sum),
     '「恢复原值」把这一字节改回 0xA5（出厂值），行也自己变干净了（脏标记是跟原值比对，不是粘住的 flag）');
  ok(typed.dirtyBefore === 1 && typed.afterRevert.data[1] === 0xa5 && typed.afterRevert.dirty === 0 &&
     typed.afterRevert.cell === 'a5', `行尾「改回」还原整行（格子回到 ${typed.afterRevert.cell}）`);
  ok(typed.hidden === true, '「完成」把位开关板收起来');

  // 改过的值必须进到"重放"要发的那一串 STEP 里（用假探针看线上字节：档 1 = 命令 + 参数）
  const replay = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    document.getElementById('pn-enable').click();
    await new Promise(r => setTimeout(r, 400));
    const s = window.__tools.spiSession, p = s.mockProbe;
    const cell = document.querySelector('#pn-code-body tr:nth-child(1) td.params input.bx:nth-of-type(2)');
    cell.click();
    await new Promise(r => setTimeout(r, 60));
    document.getElementById('pn-bitpop-bits').querySelector('button.bit[data-k="3"]').click();   // 0xA5 → 0xAD
    await new Promise(r => setTimeout(r, 60));
    document.getElementById('pn-bitpop').querySelector('button[data-bit="close"]').click();
    // 🚨 读日志必须在 p.resetState() **之前** —— 它会把 #pn-log 清空（本文件踩过：
    //    先 resetState 再断言"日志里有改过记录"，必然落空）
    const changeLog = document.getElementById('pn-log').textContent;
    p.resetState();
    document.getElementById('pn-code-play').click();
    for (let i = 0; i < 200 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    const hex = w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ');
    return { wire: p.wire.slice(0, 2).map(hex), ok: p.stats.framesOk, err: p.stats.framesErr,
             changeLog };`);
  ok(replay.wire[0] === 'ce 5a ad', `改过的参数字节真的按 0xAD 发出去（档 1 线上字节「${replay.wire[0]}」，原文是 ce 5a a5）`);
  ok(replay.err === 0 && replay.ok >= 32, `整表照样跑完（frames_ok=${replay.ok} err=${replay.err}）`);
  // 日志里那条记的是小写十六进制（`hx()` 的输出），所以用 i 标志比对
  ok(/改成 0xad/i.test(replay.changeLog) && /第 0 行/.test(replay.changeLog),
     `日志里留了"哪一行改成什么"的记录（可追溯）：「${(replay.changeLog.match(/第 0 行[^\n]*/) || [''])[0]}」`);

  // 复位：重新「解析并预览」把改动丢掉（按原文重建）——这是有意的，得让用户看得见
  const reset = await ev(`
    document.getElementById('pn-code-parse').click();
    await new Promise(r => setTimeout(r, 200));
    return { data: Array.from(window.__tools.panel.effectiveRows[0].data),
             edited: window.__tools.panel.summary().editedRows,
             sum: document.getElementById('pn-code-sum').textContent };`);
  ok(reset.data[1] === 0xa5 && reset.edited === 0 && !/已改/.test(reset.sum),
     '重新解析 → 改动清空、回到原文（步骤表按贴进来的文本重建）');
}

// ==================================================================== 6
console.log('== 6. 重放：整表下发 + 单发（假探针逐帧对账）==');
{
  await selectDock('code');
  const replay = await ev(`
    // 先把"屏"定死：ST77916 = 档 2 + 360×360 + 40 MHz（否则下面每条的展开形态都不确定）
    document.getElementById('pn-preset').value = 'st77916';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 1000));
    document.getElementById('pn-enable').click();
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('pn-code-preset').value = 'st77916';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 400));
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    const t0 = performance.now();
    document.getElementById('pn-code-play').click();
    for (let i = 0; i < 200 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    return { wireLog: p.wireLog.slice(0, 3),
             enabled: s.enabled, profile: s.profile?.profile, geom: document.getElementById('pn-geom').value,
             framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             bytesTx: p.stats.bytesTx, ms: performance.now() - t0,
             prog: document.getElementById('pn-code-prog').textContent,
             log: document.getElementById('pn-log').textContent };`);
  ok(replay.wireLog[0] === 'RESET low=10ms post=120ms' && replay.wireLog[1] === 'GPIO bl=1',
     `重放第一批就是"复位 → 开背光"（实测「${replay.wireLog.slice(0, 2).join(' | ')}」）`);
  ok(replay.enabled === true, '桥已使能（未使能时帧只会被 NAK）');
  ok(replay.profile === 2 && replay.geom === 'st77916', `已套用 ST77916：档 2 + 几何 st77916（实测 档${replay.profile} / ${replay.geom}）`);
  ok(replay.framesOk === 194 && replay.framesErr === 0, `重放前置 2 帧（RST + 背光）+ 表 192 条 = 194 帧全成功（不再自动补前缀，实测 frames_ok=${replay.framesOk} err=${replay.framesErr}）`);
  ok(replay.bytesTx >= 215, `线上字节 ≥ 参数字节 215（实测 ${replay.bytesTx}，含每条 4 B STEP 头与档 2 的 4 B 前缀）`);
  ok(/完成/.test(replay.prog), `进度行收尾：「${replay.prog}」`);

  // 单发第 3 行 = index 2（表格就是厂家表本身，不再有那 2 行自动前缀）
  const one = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    document.querySelector('#pn-code-body button[data-act="one"][data-i="2"]').click();
    for (let i = 0; i < 60 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 200));
    return { framesOk: p.stats.framesOk, wire: p.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')) };`);
  ok(one.framesOk === 3 && one.wire.length === 1, `「单发」= 前置 2 帧 + 目标那 1 帧（${one.framesOk} 帧，其中数据帧 ${one.wire.length} 条）`);
  ok(one.wire[0] === '02 00 73 00 f0', `档 2 展开正确：0x02 + 地址 00 73 00（命令字在中间字节）+ 参数 0xF0（实测 ${one.wire[0]}）`);

  // 去掉自动补前缀之后，表格第一行**就是厂家表第一条**（ST77916 是 0xF0 ← 0x28）
  const firstRow = await ev(`
    const tr = document.querySelector('#pn-code-body tr');
    return { cmd: tr.querySelector('input.bx.cmd').value,
             p0: tr.querySelector('td.params input.bx')?.value || '',
             txt: tr.textContent.replace(/\\s+/g, ' ').trim() };`);
  ok(firstRow.cmd === 'f0' && firstRow.p0 === '28',
     `表格第一行 = 厂家表首条 0xF0 ← 0x28（面板不再插 MADCTL/COLMOD）：「0x${firstRow.cmd} 0x${firstRow.p0} ${firstRow.txt.slice(0, 24)}」`);

  /**
   * 重放前的「复位 + 开背光」（默认勾上）：
   * ① 勾着 → 每条重放路径（整表 / 单发 / 从此重放）都先发 RST 脉冲 + 背光开，且**排在最前面**；
   * ② 取消勾选 → 之前的行为一字不差地回来（只有数据帧，不多打扰屏）。
   * 复用同一个「单发」按钮 = 三条路径共用 `playRows`，验一条就够。
   */
  const pre = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    // 显式载一次 ST77916 表（不依赖上一节留下的状态）；下面单发第 4 行
    document.getElementById('pn-code-preset').value = 'st77916';
    document.getElementById('pn-code-load').click();
    await new Promise(r => setTimeout(r, 400));
    const wantStep = 'STEP cmd=0x' + window.__tools.panel.effectiveRows[3].cmd.toString(16);
    const fire = async () => {
      p.resetState();
      document.querySelector('#pn-code-body button[data-act="one"][data-i="3"]').click();
      for (let i = 0; i < 60 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
      await new Promise(r => setTimeout(r, 250));
      return { ok: p.stats.framesOk, err: p.stats.framesErr, types: p.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')),
               actions: p.wireLog.filter(x => /RESET|GPIO|STEP/.test(x)), delays: p.delays };
    };
    const chk = document.getElementById('pn-replay-prereset');
    const defaultOn = chk.checked;
    const on = await fire();
    chk.checked = false;
    const off = await fire();
    chk.checked = true;
    return { defaultOn, on, off, wantStep };`);
  ok(pre.defaultOn === true, '「重放前先复位 + 开背光」默认就是勾上的');
  ok(pre.on.actions.slice(0, 2).join(' | ') === 'RESET low=10ms post=120ms | GPIO bl=1' &&
     pre.on.actions[2]?.startsWith(pre.wantStep),
     `勾着：复位 → 开背光 → 再发数据，顺序对（期望第三步 ${pre.wantStep}；实测「${pre.on.actions.join(' | ')}」）`);
  ok(pre.on.delays.includes(130) && pre.on.err === 0,
     `复位时序沿用那一行的 10 / 120（登记 ${pre.on.delays.join(',')}）`);
  ok(pre.off.actions.length === 1 && pre.off.actions[0].startsWith(pre.wantStep) && pre.off.err === 0,
     `取消勾选 → 只发数据那条，不碰 RST/BL（实测「${pre.off.actions.join(' | ')}」）`);
  ok(pre.off.ok === 1 && pre.on.ok === 3, `取消勾选后帧数从 ${pre.on.ok} 回到 ${pre.off.ok}（前置 2 帧真的没了）`);
}

// ==================================================================== 7
console.log('== 7. 图片 / 图案刷屏 ==');
{
  await selectDock('img');
  const pat = await ev(`
    const btns = [...document.querySelectorAll('#pn-patterns button')];
    btns.find(b => b.textContent === '色条 8').click();
    await new Promise(r => setTimeout(r, 300));
    const cv = document.getElementById('pn-canvas');
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let nonBlack = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) nonBlack++;
    return { w: cv.width, h: cv.height, nonBlack, sum: document.getElementById('pn-img-sum').textContent,
             src: window.__tools.panel.summary().source };`);
  ok(pat.nonBlack > pat.w * pat.h * 0.5, `图案画到预览上了（${pat.nonBlack} 个非黑像素 / ${pat.w * pat.h}）`);
  ok(/527 片/.test(pat.sum), `预览信息给出切片数：「${pat.sum.split('\n')[1] || pat.sum}」`);

  // 开窗对齐：x=3 → 窗口被扩到 4 的倍数
  const align = await ev(`
    document.getElementById('pn-x').value = '3';
    document.getElementById('pn-x').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    return document.getElementById('pn-img-sum').textContent;`);
  ok(/窗口 0\.\./.test(align) && /对齐补/.test(align), `x=3 被对齐到 0（列 4 对齐提示可见）：「${align.split('\n')[0]}」`);
  await ev(`document.getElementById('pn-x').value = '0'; document.getElementById('pn-x').dispatchEvent(new Event('input')); return true;`);

  // 刷一张 ST77916 整屏（360×360 = 259200 B → 527 片）
  const send = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    const before = p.stats.bytesTx;
    document.getElementById('pn-img-send').click();
    for (let i = 0; i < 300 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400));
    return { framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             bytesTx: p.stats.bytesTx - before, geom: document.getElementById('pn-geom').value,
             log: document.getElementById('pn-log').textContent };`);
  ok(send.geom === 'st77916', '屏幕几何跟着"套用推荐值"切到了 ST77916');
  // 刷图**不**走重放前置（见 §8 那条），所以这里是 2 条开窗 + 527 片像素，没有 RST/BL
  ok(send.framesOk === 529 && send.framesErr === 0, `整屏 529 帧全成功（2 条开窗 + 527 片像素，实测 ${send.framesOk}）`);
  // 开窗在档 2 是两条 XFER（opcode + 00 XX 00 + 4 字节坐标），所以是 2×4 而不是老写法两条 STEP 的 16
  ok(send.bytesTx === 259200 + 8, `线上字节 = 像素 259200 + 开窗 8（QSPI 两条 XFER 各 4 字节坐标，实测 ${send.bytesTx}）`);
  ok(/刷图完成[^：]*：527 片/.test(send.log), `日志里给了切片数与速率（「${(send.log.match(/刷图完成[^\n]*/) || [''])[0]}」）`);

  // R/B 交换：同一张图，勾上之后首片像素字节不同（抽验第一片的前 2 字节）
  const swap = await ev(`
    const I = await import('/app/spi/image.js');
    const g = I.PANEL_GEOMETRY.st77916;
    const im = I.makePattern('R', g.w, g.h);
    const a = I.rgbaTo565(im.rgba.subarray(0, 4), { swap: false });
    const b = I.rgbaTo565(im.rgba.subarray(0, 4), { swap: true });
    return { a: [...a], b: [...b] };`);
  ok(swap.a.join(',') === '248,0' && swap.b.join(',') === '0,31',
     `R/B 交换真的换了个字节序（不勾 ${swap.a.join('/')} → 勾上 ${swap.b.join('/')}）`);
}

// ==================================================================== 8
console.log('== 8. 面板电源 / 显示 4 个命令 + RST 脉冲 ==');
{
  const disp = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.wire = []; p.delays = [];
    for (const id of ['pn-pwr-on', 'pn-disp-on', 'pn-disp-off', 'pn-pwr-off']){
      document.getElementById(id).click();
      await new Promise(r => setTimeout(r, 260));
    }
    return { wire: p.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')), delays: p.delays };`);
  ok(disp.wire.length === 4, `4 个按钮各发一条 STEP（实测 ${disp.wire.length} 条：${disp.wire.join(' | ')}）`);
  // 档 2 的 STEP 展开：opcode + 地址 `00 XX 00` + 参数（命令字在**中间**字节，与手册一致）
  ok(disp.wire[0]?.startsWith('02 00 11 00') && disp.wire[1]?.startsWith('02 00 29 00') &&
     disp.wire[2]?.startsWith('02 00 28 00') && disp.wire[3]?.startsWith('02 00 10 00'),
     `顺序与命令字对：上电 11h → 开显示 29h → 关显示 28h → 下电 10h（地址 00 XX 00）`);
  ok(disp.delays.filter(d => d === 120).length === 2, `上电/下电各带 120 ms 等待（实测 ${disp.delays.join(',')}）`);

  const backlight = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe, cfg = { ...s.cfg };
    const levels = [];
    for (const low of [false, true]) {
      await s.applyConfig({ ...cfg, padActiveLow: low ? cfg.padActiveLow | 8 : cfg.padActiveLow & ~8 }, 'panel');
      p.resetState();
      for (const id of ['pn-bl-on', 'pn-bl-off']) {
        document.getElementById(id).click();
        for (let i = 0; i < 100 && s.busy; i++) await new Promise(r => setTimeout(r, 20));
        levels.push(p.pins.bl);
      }
      if (p.wireLog.filter(x => /^GPIO/.test(x)).join('|') !== 'GPIO bl=1|GPIO bl=0') throw new Error('背光命令顺序错误');
    }
    await s.applyConfig(cfg, 'panel');
    return { levels, owner: ['pn-bl-on', 'pn-bl-off'].every(id => document.getElementById(id).closest('#pn-power-card')),
      bridge: !!document.querySelector('#sp-bl-on, #sp-bl-off, #sp-pin-rst-send') };`);
  ok(backlight.levels.join(',') === '1,0,0,1', '屏页背光开/关：高有效与低有效的物理电平都正确');
  ok(backlight.owner && !backlight.bridge, '背光按钮归属电源与显示；桥页无背光和屏复位入口');

  const rst = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.delays = [];
    document.getElementById('pn-rst-low').value = '10';
    document.getElementById('pn-rst-post').value = '120';
    document.getElementById('pn-rst-send').click();
    await new Promise(r => setTimeout(r, 500));
    return { delays: p.delays, log: document.getElementById('pn-log').textContent };`);
  ok(rst.delays.includes(130), `RST 脉冲 = 拉低 10 ms + 释放后等 120 ms（登记 ${rst.delays.join(',')}）`);

  /**
   * 「复位并开背光」一键按钮：= RST 脉冲 + 开背光两条，顺序不能反
   * （背光必须在复位时序走完、屏内部初始化稳下来之后才点亮）。
   */
  const both = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-rst-low').value = '12';
    document.getElementById('pn-rst-post').value = '130';
    document.getElementById('pn-rst-bl').click();
    await new Promise(r => setTimeout(r, 900));
    return { ok: p.stats.framesOk, err: p.stats.framesErr, delays: p.delays, pins: p.pins,
             log: p.wireLog.filter(x => /RESET|GPIO/.test(x)),
             pageLog: document.getElementById('pn-log').textContent };`);
  ok(both.ok === 2 && both.err === 0, `一键 = 2 帧（RST + 背光开），实测 ${both.ok} 帧 / ${both.err} 错`);
  ok(both.log.join(' | ') === 'RESET low=12ms post=130ms | GPIO bl=1',
     `先复位后开背光，顺序与参数都对（实测「${both.log.join(' | ')}」）`);
  ok(both.delays.includes(142), `延时按填的数字登记 12+130=142 ms（登记 ${both.delays.join(',')}）`);
  // ST77916 档里 padActiveLow=0x06 = bit1(RST) + bit2(CS) 低有效，**BL 不在内**（bit3）
  // → 开背光（逻辑 1）就是物理高；复位结束后 RST 也回到无效=高
  ok(both.pins.bl === 1 && both.pins.rst === 1,
     `物理电平按电平表来：BL 不在低有效位图里 → 开背光=高（pins.bl=${both.pins.bl} rst=${both.pins.rst}）`);

  /**
   * 没配 RST 脚（协议里 **0 = （不用）**，见 protocol.PADS[0]）时必须**跳过复位但照常开背光**，
   * 并在日志里说清原因 —— 这条挡的是"重放前悄悄什么都没做、用户以为复位过了"这种最坑的静默失败。
   *
   * 🚨 `applyConfig` 里是一串 HID 往返（4 条 PIN_CFG + SET_CFG + 回读），必须 **await + 等回读到**，
   *    否则下面读到的还是旧 padRst，"跳过"分支根本不会走（本文件踩过：只 sleep 300 ms 不够）。
   */
  const noRst = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    const c0 = { ...s.cfg };
    const rst0 = c0.padRst;                             // 不写死 13/5：跟着当前推荐值走
    await s.applyConfig({ ...c0, padRst: 0 }, 'panel');
    const applied = s.cfg.padRst;                       // 回读对账：真变成 0 了才继续
    p.resetState();
    document.getElementById('pn-log').innerHTML = '';
    const sent = await window.__tools.panel.resetAndBacklight();
    await new Promise(r => setTimeout(r, 400));
    const log = p.wireLog.filter(x => /RESET|GPIO/.test(x));
    const pageLog = document.getElementById('pn-log').textContent;
    await s.applyConfig(c0, 'panel');
    return { sent, log, pageLog, applied, rst0, rstBack: s.cfg.padRst };`);
  ok(noRst.applied === 0, `（前置条件）padRst 确实写进了 0 =「不用」（实测 ${noRst.applied}）`);
  ok(noRst.sent === true && noRst.log.join(' | ') === 'GPIO bl=1',
     `RST 脚没配 → 跳过复位、背光照开（实测「${noRst.log.join(' | ')}」）`);
  ok(/跳过复位/.test(noRst.pageLog) && /pad 0/.test(noRst.pageLog),
     `日志明确告警"跳过复位"并给出原因（「${(noRst.pageLog.match(/[^\n]*跳过复位[^\n]*/) || [''])[0]}」）`);
  ok(noRst.rstBack === noRst.rst0, `测完把 padRst 还原成 ${noRst.rstBack}（不脏化后续用例）`);

  /**
   * 「刷这一张」**不**走重放前置（用户 2026-09-30 只点名了重放）：刷屏是高频动作，
   * 每刷一次就复位会闪。要复位就走上面那个一键按钮 —— 这条把"范围"钉死，防止以后被顺手扩大。
   */
  const blOffset = await ev(`
    const s = window.__tools.spiSession, p = s.mockProbe;
    p.resetState();
    document.getElementById('pn-img-send').click();
    for (let i = 0; i < 300 && s.busy; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 400));
    return { host: p.wireLog.filter(x => /RESET|GPIO/.test(x)).length, ok: p.stats.framesOk };`);
  ok(blOffset.host === 0, `刷图路径不发 RST/BL（实测 ${blOffset.host} 条 —— 前置只管重放那三条路）`);
}

// ==================================================================== 9
console.log('== 9. 两页联动：屏页失能 → 桥页立刻看到 ==');
{
  const off = await ev(`
    document.getElementById('pn-disable').click();
    await new Promise(r => setTimeout(r, 500));
    await window.__tools.spiSession.pollStatus(true);
    return { enabled: window.__tools.spiSession.enabled,
             busWord: document.getElementById('sp-word-text').textContent,
             pnEnableDisabled: document.getElementById('pn-enable').disabled };`);
  ok(off.enabled === false, '屏页点「失能」→ 会话状态里 enabled=false');
  ok(off.pnEnableDisabled === false, '屏页按钮状态正常（连接还在）');

  // 切回桥页：日志是按 ring 重建的（在屏页期间的操作不会丢）
  await ev(`document.querySelector('#tabs .tab[data-tab="spi"]').click(); return true;`);
  await sleep(400);
  const busLog = await ev(`return document.getElementById('sp-log').textContent;`);
  ok(/\[屏\]/.test(busLog), '桥页日志里能看到屏页发起的操作（带 [屏] 前缀）');
  ok(/STEP/.test(busLog), '屏页发的 STEP 也补进了桥页日志（切页按 ring 重放）');
}

// ==================================================================== 9b
console.log('== 9b. 动画 / 视频：录一段 WebM 当源 → 逐帧整屏刷（假探针对账）==');
{
  await selectDock('anim');            // 动画有独立页签，视频元素必须显示才能解码推进
  // ① 源：页面里现录一段（canvas.captureStream + MediaRecorder），不依赖任何外部素材
  //    🚨 用 `captureStream(0)` + `track.requestFrame()` 手动推帧：自动帧率那条路在
  //    "画布不在 DOM 里 / 窗口被遮住"时会一帧都录不到（实测只录出 110 字节的裸头）。
  //    🚨 而且**录出来"有字节"不等于"能播"**：偶发（机器忙时）会录出一个浏览器解不开的 blob，
  //    下游就变成"加载失败：读视频元数据超时"—— 2026-09-30 全量自测扫的时候撞到过（7 条连带失败），
  //    单跑又全绿。所以这里当场用 `<video>` 自检一遍，不能播就**重录**（最多 3 次），
  //    别让"素材没录好"伪装成"页面坏了"。
  let rec = null;
  for (let attempt = 1; attempt <= 3; attempt++){
    rec = await ev(`
      const cv = document.createElement('canvas'); cv.width = 96; cv.height = 120;
      cv.style.cssText = 'position:fixed;right:6px;bottom:6px;width:96px;height:120px;z-index:9';
      document.body.appendChild(cv);
      const ctx = cv.getContext('2d');
      const stream = cv.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise(r => { rec.onstop = r; });
      rec.start();
      for (let i = 0; i < 10; i++){
        ctx.fillStyle = i % 2 ? '#ff0000' : '#0000ff';
        ctx.fillRect(0, 0, 96, 120);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(i * 8, 40, 16, 16);
        track.requestFrame();
        await new Promise(r => setTimeout(r, 80));
      }
      rec.stop();
      await stopped;
      track.stop();
      cv.remove();
      const blob = new Blob(chunks, { type: 'video/webm' });
      window.__animFile = new File([blob], 'selftest.webm', { type: 'video/webm' });
      // 自检：这个 blob 到底能不能被 <video> 解析出元数据？
      const probe = document.createElement('video');
      probe.muted = true; probe.playsInline = true;
      probe.src = URL.createObjectURL(blob);
      const playable = await new Promise(res => {
        const t = setTimeout(() => res(false), 5000);
        probe.addEventListener('loadedmetadata', () => { clearTimeout(t); res(probe.videoWidth > 0); });
        probe.addEventListener('error', () => { clearTimeout(t); res(false); });
      });
      probe.removeAttribute('src');
      return { bytes: blob.size, chunks: chunks.length, playable };`);
    if (rec.playable && rec.bytes > 500) break;
    console.log(`  ↻ 录出来的 WebM 不能被浏览器解析（${rec.bytes} 字节 / playable=${rec.playable}），重录第 ${attempt} 次`);
  }
  ok(rec.bytes > 500 && rec.playable === true,
     `页面里现录了一段 WebM 当测试素材（${rec.bytes} 字节 / ${rec.chunks} 块 / 元数据可读=${rec.playable}）`);

  const loaded = await ev(`
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(window.__animFile);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40 && !window.__tools.panel.summary().anim.src; i++) await new Promise(r => setTimeout(r, 100));
    const s = window.__tools.panel.summary();
    return { anim: s.anim, videoOn: document.getElementById('pn-anim-video').classList.contains('on'),
             playDisabled: document.getElementById('pn-anim-play').disabled,
             info: document.getElementById('pn-anim-info').textContent.slice(0, 80) };`);
  ok(loaded.anim?.src && /selftest\.webm/.test(loaded.anim.src) && loaded.anim.src.includes('video'),
     `源已装载：${loaded.anim?.src}`);
  ok(loaded.videoOn === true && loaded.playDisabled === false, '源片段预览出现、「播放到屏」可用');

  // ② 播放：先定死 AXS15352（档 1）+ 使能，再开播 ~2 s
  const played = await ev(`
    document.getElementById('pn-preset').value = 'axs15352';
    document.getElementById('pn-preset-apply').click();
    await new Promise(r => setTimeout(r, 900));
    await window.__tools.spiSession.setEnabled(true, 'bus');
    await new Promise(r => setTimeout(r, 300));
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-anim-play').click();
    await new Promise(r => setTimeout(r, 2200));
    const during = window.__tools.panel.summary().anim;
    const stopDisabled = document.getElementById('pn-anim-stop').disabled;
    document.getElementById('pn-anim-stop').click();
    await new Promise(r => setTimeout(r, 800));
    const after = window.__tools.panel.summary().anim;
    return { during, after, stopDisabled,
             framesOk: p.stats.framesOk, framesErr: p.stats.framesErr, bytesTx: p.stats.bytesTx,
             info: document.getElementById('pn-anim-info').textContent,
             log: document.getElementById('pn-log').textContent };`);
  ok(played.during.running === true && played.stopDisabled === false, '播放中：停止按钮可用');
  ok(played.after.frames >= 3, `2.2 s 内发了 ${played.after.frames} 帧（整帧 292 帧/次）`);
  ok(played.after.frames * 292 <= played.framesOk, `假探针执行帧数对账：${played.framesOk} ≥ ${played.after.frames}×292`);
  ok(played.framesErr === 0, `零错误（frames_err=${played.framesErr}）`);
  ok(played.after.bytes >= played.after.frames * 142080 * 0.99,
     `字节对账：${(played.after.bytes / 1024).toFixed(0)} KB ≈ ${played.after.frames} 帧 × 142080 B`);
  ok(played.after.fps > 0 && played.after.kbs > 0 && played.after.fps < 60, `实测速率合理：${played.after.fps} fps / ${played.after.kbs} KB/s`);
  ok(played.after.running === false && /停止|上次/.test(played.info) && !/NaN/.test(played.info),
     `停止后状态行给了总结：「${played.info.slice(0, 70)}」`);
  ok(/动画开始/.test(played.log) && /动画结束/.test(played.log), '日志里有开始/结束（含实测 fps）');
  ok(played.after.dropped >= 0, `丢帧计数存在（${played.after.dropped}）—— 发送是节拍器，解码更快就丢`);

  // ③ GIF/PNG 那条路（ImageDecoder）：拿刚画的 canvas 存一张 PNG 当"单帧动画"
  const img = await ev(`
    const cv = document.createElement('canvas'); cv.width = 240; cv.height = 296;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0f0'; ctx.fillRect(0, 0, 240, 296);
    ctx.fillStyle = '#f0f'; ctx.fillRect(20, 20, 60, 60);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'frame.png', { type: 'image/png' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 30 && !/png/.test(window.__tools.panel.summary().anim?.src || ''); i++) await new Promise(r => setTimeout(r, 100));
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-anim-play').click();
    await new Promise(r => setTimeout(r, 1000));
    document.getElementById('pn-anim-stop').click();
    await new Promise(r => setTimeout(r, 600));
    return { anim: window.__tools.panel.summary().anim, framesErr: p.stats.framesErr };`);
  ok(/frame\.png/.test(img.anim?.src || '') && img.anim.frames >= 2,
     `ImageDecoder 那条路也通（PNG 单帧循环发了 ${img.anim?.frames} 帧，零错误=${img.framesErr === 0}）`);
}

// ==================================================================== 9c
console.log('== 9c. 仓库自带素材（samples/anim）：帧数认得出来 · 不勾循环播完就停 ==');
{
  await selectDock('img');
  // 🚨 这一条钉的是两个真出现过的坑（2026-10 实测 Chrome 153）：
  //    ① `await decoder.completed` 之后 `tracks.selectedTrack` 还是 null → frameCount 记成 0，
  //       状态行写成"0 帧"，用户以为素材坏了；
  //    ② 帧数 0 时 `_runGif` 里 `i >= 0` 第一帧就成立 → **不勾循环时只播一帧**。
  //    素材由 tools/dev/make-anim-samples.py 生成，静态服务 8899 的根目录就是仓库根 —— 同源 fetch 得到。
  const gif = await ev(`
    const r = await fetch('samples/anim/bars-sweep-240x296.gif').catch(() => null);
    if (!r || !r.ok) return { skip: r ? 'HTTP ' + r.status : '取不到' };
    const b = await r.blob();
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(new File([b], 'bars-sweep-240x296.gif', { type: 'image/gif' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60 && !/bars-sweep/.test(window.__tools.panel.summary().anim?.src || ''); i++) await new Promise(r => setTimeout(r, 100));
    return { bytes: b.size, anim: window.__tools.panel.summary().anim,
             info: document.getElementById('pn-anim-info').textContent };`);
  if (gif.skip){
    console.log(`  ⚠ 跳过：本地静态服务里没有 samples/anim（${gif.skip}）—— 先跑 make samples-anim`);
  } else {
    ok(gif.anim?.srcFrames === 50, `GIF 帧数认得出来：srcFrames=${gif.anim?.srcFrames}（素材 50 帧 / ${gif.bytes} B）`);
    ok(/50 帧/.test(gif.info), `状态行如实写帧数：「${gif.info.slice(0, 64)}」`);
    const once = await ev(`
      const loop = document.getElementById('pn-anim-loop');
      loop.checked = false; loop.dispatchEvent(new Event('change', { bubbles: true }));
      const p = window.__tools.spiSession.mockProbe; p.resetState();
      document.getElementById('pn-anim-play').click();
      for (let i = 0; i < 120; i++){ await new Promise(r => setTimeout(r, 100)); if (!window.__tools.panel.summary().anim.running) break; }
      const a = window.__tools.panel.summary().anim;
      loop.checked = true; loop.dispatchEvent(new Event('change', { bubbles: true }));
      return { a, framesErr: p.stats.framesErr, info: document.getElementById('pn-anim-info').textContent };`);
    ok(once.a.running === false && once.a.frames >= 40,
       `不勾循环：播完自己停，共 ${once.a.frames} 帧（曾经只播 1 帧）`);
    ok(once.framesErr === 0, `零错误（frames_err=${once.framesErr}）`);
    ok(!/NaN/.test(once.info), `停止后状态行没有 NaN：「${once.info.slice(0, 64)}」`);
  }
}

// ==================================================================== 9d
console.log('== 9d. 攒批：USB 调用次数降一个数量级，设备侧收到的帧一个不少 ==');
{
  await selectDock('img');
  // 背景（2026-10，用户现场 "3 MB/s 瓶颈在哪"）：一帧 240×296 = 142 KB 被"一帧不跨包"切成
  // 289 片像素 + 3 条命令 = 292 个帧。固件每次只 arm 一个 512 B 槽，但 **USB 层面一次 bulk 传输
  // 可以带任意多个 512 B 包** —— 所以"每片一次 transferOut"是主机侧自找的开销（每次 ~150 µs ⇒ 44 ms/帧）。
  // 这条自测钉住两件事：① 攒批后调用次数掉到 ~11 次/帧；② 设备（假探针按 512 B 槽解析）收到的
  // 协议帧数与不攒批时**完全一样**。
  const run = async (batchBytes, ms) => ev(`
    const sel = document.getElementById('pn-batch');
    sel.value = '${batchBytes}'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    /* 这一节量的是**攒批**：必须把局部刷新关掉，否则每帧只发变化区，
       "292 帧/帧"这个基线就不成立了（局部刷新有它自己的 9f）。 */
    const pc = document.getElementById('pn-partial');
    if (pc.checked){ pc.checked = false; pc.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 100));
    const p = window.__tools.spiSession.mockProbe;
    p.resetState();
    document.getElementById('pn-anim-play').click();
    await new Promise(r => setTimeout(r, ${ms}));
    document.getElementById('pn-anim-stop').click();
    await new Promise(r => setTimeout(r, 500));
    const a = window.__tools.panel.summary().anim;
    return { a, framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             perFrame: a.frames ? p.stats.framesOk / a.frames : 0 };`);

  const big = await run(16384, 1200);
  ok(big.a.callsPerFrame > 0 && big.a.callsPerFrame <= 12,
     `16 KB 攒批：每帧只喊 ${big.a.callsPerFrame} 次 USB（不攒批要 ~290 次）`);
  ok(big.framesErr === 0, `攒批后设备侧零错误（frames_err=${big.framesErr}）`);
  ok(Math.abs(big.perFrame - 292) <= 6,
     `设备侧每帧收到的协议帧数不变：${big.perFrame.toFixed(1)} ≈ 292（289 片 + 3 条命令）`);

  const small = await run(512, 1200);
  ok(small.a.callsPerFrame >= 250,
     `512 B 档 = 老行为：每帧 ${small.a.callsPerFrame} 次调用（一包一次 transferOut）`);
  ok(Math.abs(small.perFrame - big.perFrame) <= 6 && small.framesErr === 0,
     `两档的设备侧帧数一致（${small.perFrame.toFixed(1)} vs ${big.perFrame.toFixed(1)}）—— 攒批只改提交粒度`);

  // 收尾：把档位放回默认的 16 KB，别影响后面的用例
  await ev(`const sel = document.getElementById('pn-batch');
            sel.value = '16384'; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1;`);
}

// ==================================================================== 9f
console.log('== 9f. 局部刷新：只发变化包围盒（静图重复刷会整帧跳过，动画按面积提速）==');
{
  await selectDock('img');
  // ① 两个开关是同一份状态（刷屏 tab 一个、动画行一个），HTML 默认都是勾上的
  const sw = await ev(`
    const a = document.getElementById('pn-partial'), b = document.getElementById('pn-anim-partial');
    // 前几节可能把开关拨到关（9d 为了量攒批基线会关掉），这里先复位成"开"
    for (const el of [a, b]) if (!el.checked){ el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
    const defaults = { a: a.defaultChecked, b: b.defaultChecked };
    const before = { a: a.checked, b: b.checked };
    a.checked = false; a.dispatchEvent(new Event('change', { bubbles: true }));
    const after = { a: a.checked, b: b.checked };
    a.checked = true; a.dispatchEvent(new Event('change', { bubbles: true }));
    const back = { a: a.checked, b: b.checked };
    return { defaults, before, after, back, tol: document.getElementById('pn-partial-tol').value,
             sum: document.getElementById('pn-img-sum').textContent };`);
  ok(sw.defaults.a === true && sw.defaults.b === true, '两个开关在 HTML 里默认都是勾上的（刷屏 tab + 动画行）');
  ok(sw.before.a === true && sw.before.b === true, '当前两边都是开');
  ok(sw.after.b === false, '改刷屏 tab 那个 → 动画行的副本跟着变（同一份状态双向同步）');
  ok(sw.back.b === true, '再改回来 → 两边又一致');
  ok(sw.tol === '1', `容差默认 1 位（视频/JPEG 的量化噪声靠它吃掉）`);
  ok(/局部刷新：开/.test(sw.sum), `摘要里写清了局部刷新状态：「${sw.sum.split('\n').pop()}」`);

  // ② 静图：第一次整帧 → 第二次（同一个图案，什么都没改）整帧跳过
  const twice = await ev(`
    const p = window.__tools.spiSession.mockProbe;
    const v = window.__tools.panel;
    v.setPattern('BAR');
    p.resetState();
    await v.sendImage();
    const first = v.summary();
    const ok1 = p.stats.framesOk;
    p.resetState();
    await v.sendImage();
    const second = v.summary();
    return { first: { action: first.partial.lastAction, bytes: first.lastRun.bytes, frames: first.lastRun.frames, ok: ok1 },
             second: { action: second.partial.lastAction, reason: second.partial.lastReason, framesOk: p.stats.framesOk },
             sum: document.getElementById('pn-img-sum').textContent };`);
  ok(twice.first.action === 'full' && twice.first.frames > 200,
     `第 1 次「刷这一张」：整帧 ${twice.first.frames} 帧（${twice.first.ok} 个协议帧到设备侧）`);
  ok(twice.second.action === 'skip' && twice.second.framesOk === 0,
     `第 2 次（图没变）：整帧跳过 —— 设备侧一个帧都没收到（${twice.second.reason}）`);
  ok(/整帧跳过/.test(twice.sum), `摘要如实写「整帧跳过」：「${twice.sum.slice(0, 60)}」`);

  // ③ 改一小块 → 只发那个包围盒：把图案换成"同尺寸但只有 8×8 不同"的图
  const partial = await ev(`
    const v = window.__tools.panel;
    const p = window.__tools.spiSession.mockProbe;
    // 用同一个图案当底，再在 (100,100) 涂一个 8×8 的白块 —— 模拟"画面几乎没动"
    const g = v.geometry();
    const src = window.__tools.spiSession;   // 只为拿引用，不用它
    const base = { w: g.w, h: g.h, rgba: v.src.rgba.slice(), name: '局部测试' };
    for (let y = 100; y < 108; y++) for (let x = 100; x < 108; x++){ const i = (y * g.w + x) * 4; base.rgba[i] = base.rgba[i+1] = base.rgba[i+2] = 255; }
    v.src = base;
    p.resetState();
    await v.sendImage();
    const r = v.summary();
    return { action: r.partial.lastAction, win: r.partial.lastWin, area: r.partial.lastArea, fullArea: r.partial.lastFullArea,
             bytes: r.lastRun.bytes, frames: r.lastRun.frames, framesOk: p.stats.framesOk, framesErr: p.stats.framesErr,
             slices: r.lastRun.slices, reason: r.partial.lastReason };`);
  ok(partial.action === 'partial' && partial.win && partial.win.x0 === 100 && partial.win.x1 === 107,
     `第 3 次（只有 8×8 变了）：局部开窗 ${JSON.stringify(partial.win)}`);
  ok(partial.bytes === 8 * 8 * 2, `只发 ${partial.bytes} B（8×8×2），整帧要 142080 B —— 省 ${(100 - partial.bytes / 142080 * 100).toFixed(2)}%`);
  ok(partial.framesErr === 0, `局部刷屏设备侧零错误（frames_err=${partial.framesErr}）`);
  ok(partial.area < partial.fullArea / 100, `包围盒面积只有整窗的 ${(partial.area / partial.fullArea * 100).toFixed(2)}%`);

  // ④ 动画：换一个"只有小球在动"的源（网格弹跳球），局部刷新开/关各播一段
  //    ⚠️ 不能用 9c 那个 bars-sweep：它每帧都在底部重画一行**计数字**，变化像素横跨大半个屏，
  //       包围盒必然超过 60% → 按设计回落到整帧。那是"动效里有没有大范围变化"的真实分界，
  //       拿它测局部刷新只会得到"没省"的结论。
  const anim = await ev(`
    const r = await fetch('samples/anim/ball-grid-240x296.gif').catch(() => null);
    if (!r || !r.ok) return { skip: r ? 'HTTP ' + r.status : '取不到' };
    const b = await r.blob();
    const input = document.getElementById('pn-anim-input');
    const dt = new DataTransfer(); dt.items.add(new File([b], 'ball-grid-240x296.gif', { type: 'image/gif' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 60 && !/ball-grid/.test(window.__tools.panel.summary().anim?.src || ''); i++) await new Promise(r => setTimeout(r, 100));
    const p = window.__tools.spiSession.mockProbe;
    const pc = document.getElementById('pn-partial');
    const run = async (on, ms) => {
      pc.checked = on; pc.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      p.resetState();
      document.getElementById('pn-anim-play').click();
      await new Promise(r => setTimeout(r, ms));
      document.getElementById('pn-anim-stop').click();
      await new Promise(r => setTimeout(r, 500));
      const a = window.__tools.panel.summary().anim;
      return { frames: a.frames, partial: a.partial, skipped: a.skipped, savePct: a.savePct, fps: a.fps,
               perFrame: a.frames ? p.stats.framesOk / a.frames : 0, framesErr: p.stats.framesErr,
               info: document.getElementById('pn-anim-info').textContent };
    };
    const off = await run(false, 1500);
    const on = await run(true, 1500);
    return { off, on };`);
  if (anim.skip){
    console.log(`  ⚠ 跳过动画局部刷新：${anim.skip}（先跑 make samples-anim）`);
  } else {
    ok(anim.off.perFrame > 250, `局部刷新关：每帧 ${anim.off.perFrame.toFixed(1)} 个协议帧（整帧 292）`);
    ok(anim.on.perFrame < anim.off.perFrame * 0.9,
       `局部刷新开：每帧只有 ${anim.on.perFrame.toFixed(1)} 个协议帧（省 ${(100 - anim.on.perFrame / anim.off.perFrame * 100).toFixed(0)}%）`);
    ok(anim.on.partial > 0 && anim.on.savePct > 10,
       `像素省了 ${anim.on.savePct.toFixed(1)}%（局部 ${anim.on.partial} 帧 / 跳过 ${anim.on.skipped} / 共 ${anim.on.frames} 帧）`);
    ok(anim.on.framesErr === 0 && anim.off.framesErr === 0, `两条路都零错误（${anim.off.framesErr} / ${anim.on.framesErr}）`);
    ok(/fps/.test(anim.on.info), `状态行照样有 fps：「${anim.on.info.slice(0, 72)}」`);
  }

  // 收尾：局部刷新放回默认开，图案放回色条
  await ev(`const pc = document.getElementById('pn-partial');
            pc.checked = true; pc.dispatchEvent(new Event('change', { bubbles: true }));
            window.__tools.panel.setPattern('BAR'); return 1;`);
}

// ==================================================================== 9e
console.log('== 9e. 回读：读寄存器 + 读 GRAM（假探针 GRAM → 预览 → BMP）==');
{
  // 用户 2026-10 的需求："spi/qspi 屏的回读功能（读一般都是 1 线读）：读寄存器；读 gram 值
  // （发 2A+2B 开窗，2E 读数据，3E 是续读），把读出的数据还原成一帧图片并显示在预览窗口，
  // 并提供保存为 bmp 的功能。"
  // tab 化之后（用户 2026-10"右边部分做成分 tab"）：读回是**独立一页**，画面有**自己的画布**。
  await selectDock('read');
  const order = await ev(`
    const dock = document.getElementById('pn-box-dock');
    return { pages: [...dock.querySelectorAll('.dockpage')].map(p => p.dataset.dock),
             ids: [...dock.querySelectorAll('.dockpage')].map(p => p.id),
             logOutside: !dock.contains(document.getElementById('pn-logbox')) };`);
  ok(order.pages.join(',') === 'img,img-settings,anim,code,read' && order.ids.join(',') === 'pn-img-card,pn-img-settings-card,pn-anim-card,pn-code-card,pn-read-card',
     `屏页三块 = 刷屏 → 面板初始化 → 读回（${order.ids.join(' → ')}）`);
  ok(order.logOutside === true, '日志在 dock 之外（常驻）—— 读回 / 重放完第一眼就能看到它有没有报错');

  const reg = await ev(`
    const s = window.__tools.spiSession;
    document.getElementById('pn-read-reg').value = '4';
    document.getElementById('pn-read-reg').dispatchEvent(new Event('change'));
    document.getElementById('pn-read-reg-go').click();
    await new Promise(r => setTimeout(r, 500));
    return { reg: window.__tools.panel.summary().lastReg,
             out: document.getElementById('pn-read-reg-out').textContent,
             cmd: document.getElementById('pn-read-reg-cmd').value, len: document.getElementById('pn-read-reg-len').value };`);
  ok(reg.reg?.bytes === 3 && reg.reg.hex === '00 93 96',
     `读寄存器 RDDID 04h → ${reg.reg?.hex}（假探针的确定值；下拉选中会自动填命令/长度：${reg.cmd}/${reg.len}）`);

  const rb = await ev(`
    const RD = await import('./app/spi/panel-read.js');
    const s = window.__tools.spiSession;
    // 前面几节往假探针的 GRAM 里写过东西（刷图/动画），这里换回干净的面板：
    // 假探针的"没写过的像素"是**确定性图案**，所以可以逐像素断言。
    document.getElementById('pn-geom').value = 'axs15352';
    document.getElementById('pn-geom').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    s.mockProbe.setPanelGeometry(240, 296);
    document.getElementById('pn-read-x0').value = 8; document.getElementById('pn-read-y0').value = 4;
    document.getElementById('pn-read-x1').value = 47; document.getElementById('pn-read-y1').value = 23;
    const p = s.mockProbe;
    p.resetState();
    await window.__tools.panel.readGram();
    const r = window.__tools.panel.summary().readBack;
    // 🚨 量的是**读回 tab 自己那张**画布：它和刷屏的 #pn-canvas 是两张独立元素。
    const canvas = document.getElementById('pn-read-canvas');
    const px = [...canvas.getContext('2d').getImageData(8, 4, 1, 1).data];
    const bmp = RD.encodeBMP(window.__tools.panel.readBack.rgba, r.w, r.h);
    const dv = new DataView(bmp.buffer);
    return { r, px, progress: document.getElementById('pn-read-prog').textContent,
             bmp: { len: bmp.length, magic: String.fromCharCode(bmp[0], bmp[1]), w: dv.getInt32(18, true), h: dv.getInt32(22, true), bpp: dv.getUint16(28, true) },
             wire: p.wireLog.filter(x => /GRAM|寄存器/.test(x)).slice(0, 5) };`);
  // 假探针的图案在 (8,4)：r = round(8*31/239)=1、g = round(4*63/295)=1、b = (8^4)&31=12 → RGB565 0x082C
  ok(rb.r?.bytes === 40 * 20 * 2 && rb.r.chunks === 4 && rb.r.missed === 0,
     `读回 40×20：${rb.r?.bytes} B / ${rb.r?.chunks} 片 / 丢 ${rb.r?.missed} 片（${rb.progress}）`);
  ok(rb.r?.sample?.[0]?.join(',') === '8,4,98',
     `解码后的第一个像素 = 假探针图案的 (8,4) → (${rb.r?.sample?.[0]?.join(',')})`);
  ok(rb.px?.join(',') === '8,4,98,255', `读回 tab 自己的画布里画的就是它（#pn-read-canvas(8,4) = ${rb.px?.join(',')}）`);
  ok(rb.bmp.magic === 'BM' && rb.bmp.w === 40 && rb.bmp.h === 20 && rb.bmp.bpp === 24 && rb.bmp.len === 54 + 40 * 3 * 20,
     `BMP：${rb.bmp.w}×${rb.bmp.h} 24bpp · ${rb.bmp.len} B（54 + 40×3×20）`);

  // 读回用的是"读"时序，不该把屏上的内容改掉：整场里没有任何 GRAM 写
  const clean = await ev(`const w = window.__tools.spiSession.mockProbe.wireLog.filter(x => /^GRAM 写/.test(x)).length; return w;`);
  ok(clean === 0, `读回全程只读不写（GRAM 写 ${clean} 次）`);
}

// ==================================================================== 10
console.log('== 10. 收尾 ==');
{
  const done = await ev(`
    document.getElementById('pn-disconnect').click();
    await new Promise(r => setTimeout(r, 300));
    return { bus: window.__tools.spi.summary(), pn: window.__tools.panel.summary(),
             cleared: !window.__tools.spiSession.mockProbe && !window.__tools.spiSession.pollTimer && !document.getElementById('pn-mock').checked && !document.getElementById('sp-mock').checked,
             buttons: ['sp-disconnect', 'pn-disconnect', 'pn-bl-on', 'pn-bl-off'].every(id => document.getElementById(id).disabled) && !document.getElementById('sp-connect').disabled && !document.getElementById('pn-connect').disabled,
             pnState: document.getElementById('pn-state').textContent };`);
  ok(done.bus.connected === false && done.pn.connected === false && !done.bus.dataReady, '屏页关闭探针后，两页的配置与数据连接都释放');
  ok(done.cleared && done.buttons, '关闭后清除模拟状态及轮询，更新两页连接和背光按钮');
  ok(/未连接/.test(done.pnState), `屏页状态行 = ${done.pnState}`);
  const err = await ev(`return window.__tools.summary().errors;`);
  ok(err.length === 0, '整场跑完页面无未捕获错误', JSON.stringify(err));
}

console.log(`\n${fail ? '❌' : '✅'} spi-panel-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
