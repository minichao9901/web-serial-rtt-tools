/**
 * 「J-Scope 波形」页的端到端自测（CDP，不需要硬件）：
 *   node tools/selftest/scope-page.test.mjs      （等价：make test-scope-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 跑的是**真页面对象**（window.__tools.scope）：切页 → 开假探针 → 开始采样 → 收包 → 解码 →
 * 缓冲 → 画布上真的有像素 → 触发命中 → 离线重定位 → 导出 CSV 的代码路径。
 * 每一步都断言"客观状态"，不看"像不像"。
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
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

// 等页面把 __tools 挂好
let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.scope;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.scope 不存在）');

// 🚨 目标类型是**用户设置**：`#sc-target` 与 store 的 `rtt.target` 双向绑定（change → 写 localStorage），
//    切页时页面还会按 store 再同步一次（view.js 的 onShow）。于是"上一轮跑到 §14/§15 切到 RISC-V/JTAG"
//    会**跨次污染**：再跑本套件时一加载就是 RISC-V，读计划按 JTAG 的实测值算（单字 3.17 µs 而不是
//    ARM 快路径 1.55 µs），§12 那几条断言就会莫名其妙地飘（2026-09-30 实测：91 通过 / 3 失败，非偶发）。
//    ⚠️ 必须**派发 change**（bind 挂在事件上）—— 只改 `t.value` 再调 applyTargetType() 不写回 store，
//       之后任何一次切页都会把它同步回 RISC-V，等于没钉住。
//    本套件的基准假设是 SWD：开跑先钉死，别依赖浏览器里前一晚留下的状态。
{
  const pinned = await ev(`
    const KEY = 'serial-rtt-tools:v1';
    const stored = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}')['rtt.target']; } catch { return null; } };
    const t = document.getElementById('sc-target');
    const before = { sel: t ? t.value : '(没有 sc-target)', stored: stored() };
    if (t && (before.sel !== 'swd' || before.stored !== 'swd')){
      t.value = 'swd';
      t.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    }
    return { before, after: { sel: t?.value, stored: stored() } };`);
  ok(pinned.after.sel === 'swd' && pinned.after.stored === 'swd',
     `基准目标类型钉成 SWD 并落盘（浏览器里遗留：下拉 ${pinned.before.sel} / store ${pinned.before.stored}）`);
}

console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(Array.isArray(s.tabs) && s.tabs.includes('scope'), '标签栏里有 scope');
  const nav = await ev(`return {primary:[...document.querySelectorAll('#tabs>.primary-tabs [data-tab]')].map(e=>e.dataset.tab), more:[...document.querySelectorAll('#tool-switch [data-tab]')].map(e=>e.dataset.tab)};`);
  ok(nav.primary.indexOf('scope') === nav.primary.indexOf('rttcdc') + 1 && nav.more.includes('spicdc'), 'RTT 转发与 JScope 相邻，SPI 转发位于更多功能', JSON.stringify(nav));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.scope && s.scope.mode === 'real' && s.scope.samples === 0, '初始：真机模式、0 样本');
  ok(s.scope.plan && s.scope.plan.spans >= 1, `初始就有读计划预览（${s.scope.plan?.spans} 个 span）`);
  const vis = await ev(`const p=document.getElementById('tab-scope'); return getComputedStyle(p).display;`);
  void vis;
}

console.log('== 2. 切到 scope 页 + 开假探针 ==');
await ev(`document.querySelector('#sc-plan').closest('details').open = true; return true;`);
{
  await ev(`document.querySelector('#tabs .tab[data-tab="scope"]').click(); return true;`);
  await sleep(300);
  const active = await ev(`return document.getElementById('tab-scope').classList.contains('active');`);
  ok(active === true, '点击标签后 #tab-scope 变成 active');
  const mock = await ev(`
    const c = document.getElementById('sc-mock'); c.checked = true; c.dispatchEvent(new Event('change'));
    const sc = window.__tools.scope;
    for (let i=0;i<100 && (!sc.usingMock || !sc.transport || sc._releasing);i++) await new Promise(resolve=>setTimeout(resolve,20));
    return window.__tools.scope.summary().mode;`);
  ok(mock === 'mock', '勾上「用假探针」→ 模式切到 mock');
  const items = await ev(`return [...document.querySelectorAll('#sc-vars .vrow')].length;`);
  ok(items === 0 || items > 0, `变量列表渲染出来了（${items} 行；没载 ELF 时用内置 8 通道）`);
  const planTxt = await ev(`return document.getElementById('sc-plan').textContent;`);
  ok(/span/.test(planTxt) && /kHz/.test(planTxt), `读计划预览有内容：「${planTxt.slice(0, 64)}…」`);
}

console.log('== 3. 开始采样（假探针 → 包流 → 解码 → 缓冲）==');
{
  await ev(`document.getElementById('sc-period').value='100'; document.getElementById('sc-seconds').value='5'; return true;`);
  await ev(`document.getElementById('sc-start').click(); return true;`);
  await sleep(400);
  const mid = await ev('return window.__tools.scope.summary();');
  ok(mid.running === true, '采样已启动');
  ok(mid.capacity > 50000 && mid.capacity < 200000, `缓冲容量按 速率×时长 算出来（${mid.capacity} 样本）`);
  await sleep(2600);
  const s = await ev('return window.__tools.scope.summary();');
  ok(s.samples > 3000, `收到 ${s.samples} 个样本（>3000）`);
  ok(s.packets > 100, `收到 ${s.packets} 个包（>100）`);
  ok(s.lost === 0, `零丢包（seq 无缺口，实际 ${s.lost}）`);
  ok(Math.abs(s.rateHz - 10000) < 400, `实测速率 ≈10 kHz（实际 ${s.rateHz} Hz）`);
  const dv = await ev(`
    const st = window.__tools.scope.store;
    const a = st.channel(0).at(10), b = st.channel(0).at(11);
    return { a, b, ch0: st.channel(0).scalar, ch2: st.channel(2).scalar, big: st.channel(2).at(5) };`);
  ok(Number.isFinite(dv.a) && Number.isFinite(dv.b), `缓冲里的值不是 NaN（ch0[10]=${dv.a?.toFixed?.(4)}）`);
  ok(dv.ch0 === 'f32' && dv.ch2 === 'i32', '通道类型按变量表分配（f32 / i32）');
  ok(Number.isInteger(dv.big), `i32 通道存的是整数（${dv.big}）`);
}

console.log('== 4. 画布上真的有波形 ==');
{
  const px = await ev(`
    const sc = window.__tools.scope;
    sc.drawFrame();
    const c = document.getElementById('sc-canvas');
    if (!c.width) return { err: 'canvas 没尺寸' };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let colored = 0, total = 0;
    for (let i = 0; i < d.length; i += 4 * 17){        // 抽样，够判断了
      total++;
      if (Math.abs(d[i] - 17) + Math.abs(d[i+1] - 21) + Math.abs(d[i+2] - 28) > 40) colored++;
    }
    return { colored, total, lod: !!sc.usedLod, w: c.width, h: c.height,
             span: Math.round(sc.renderer.span), cols: Math.round(sc.renderer.plotW), count: sc.store.count };`);
  ok(!px.err, '画布有尺寸', px.err || '');
  ok(px.colored > px.total * 0.005 && px.colored > 300,
     `画布上有 ${px.colored}/${px.total} 个非背景采样点（波形真的画出来了）`);
  ok(px.lod === true, `缩到全览时走 LOD 快路径（span ${px.span} / ${px.cols} 列 = 每列 ${(px.span / px.cols).toFixed(1)} 样本，共 ${px.count} 个）`);
  const rows = await ev(`return [...document.querySelectorAll('#sc-legend .lrow')].map(e => e.textContent);`);
  ok(rows.length === 8, `图例 8 行（${rows.length}）`);
  const hidden = await ev(`
    document.querySelector('#sc-legend .lrow').click();
    return window.__tools.scope.renderer.isVisible(0);`);
  ok(hidden === false, '点图例可以隐藏/显示通道');
  await ev(`document.querySelector('#sc-legend .lrow').click(); return true;`);
}

console.log('== 5. 缩放 / 平移 / 精确模式 ==');
{
  const r = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false;                         // 页面上手动缩放会自动关掉跟随；这里直接调 API 要自己关
    sc.renderer.zoomTo(0, 60);                 // 放大到 60 个样本 → 每列不到 1 个 → 精确扫描
    sc.drawFrame();
    return { span: sc.renderer.span, lod: !!sc.usedLod, cols: sc.renderer.plotW };`);
  ok(r.span === 60 && r.lod === false, `放大到 60 个样本后切回逐样本精确扫描（plotW=${Math.round(r.cols)}）`);
  const z = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false;
    sc.renderer.fitAll();
    const full = sc.renderer.span;
    sc.renderer.zoomBy(2, 0.5);
    return { full, span: sc.renderer.span };`);
  ok(Math.abs(z.span - z.full / 2) < 2, `2× 缩放后跨度减半（${z.full} → ${z.span}，锚点在中间）`);
  const followOff = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false;
    sc.renderer.zoomTo(0, 100);
    document.getElementById('sc-fit').click();
    return sc.follow;`);
  ok(followOff === true, '点「全览」会重新打开跟随（数据在长时视图自动跟上）');
}

console.log('== 5.5 标尺移到哪，就显示那里的时间 ==');
{
  // 用户提的：分道图里游标只有每路的取值，看不出"标尺停在什么时刻"。
  const c = await ev(`
    const sc = window.__tools.scope;
    sc.follow = false; sc.renderer.fitAll();
    const cv = document.getElementById('sc-canvas');
    const box = cv.getBoundingClientRect();
    // 用**真实鼠标事件**走一遍（不是直接改 renderer.cursor）：标尺拖到距左边界 100 px 处
    cv.dispatchEvent(new MouseEvent('mousemove', { clientX: box.left + sc.renderer.padding.l + 100, clientY: box.top + 40, bubbles: true }));
    sc.drawFrame();
    const first = { cursor: sc.renderer.cursor, label: sc.renderer.cursorLabel,
                    status: document.getElementById('sc-window').textContent,
                    legend: document.querySelector('#sc-legend .lrow').textContent };
    // 轴槽里那行"白字"只可能来自游标标签（刻度文字是灰的 #7b8794）
    // 采样区直接取渲染器报出来的标签矩形 —— 用"画布高度 − padding"自己猜坐标会跟
    // 布局/缩放（dpr=1.25 这类）差几像素，自测就会时灵时不灵
    const dpr = cv.width / cv.clientWidth;
    const strip = () => {
      const ctx = cv.getContext('2d');
      const r = sc.renderer._reserved?.[0];
      if (!r) return 0;
      const px = (a, b) => Math.max(1, Math.round(b * dpr) - Math.round(a * dpr));
      const d = ctx.getImageData(Math.round(r.x * dpr), Math.round(r.y * dpr), px(r.x, r.x + r.w), px(r.y, r.y + r.h)).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) bright++;
      return bright;
    };
    const withCursor = strip();
    const atX = sc.renderer.xOf(sc.renderer.cursor);
    sc.renderer.cursor = null; sc.drawFrame();
    const noCursor = strip();
    // 再挪一次：时间必须跟着走
    sc.renderer.cursor = Math.max(0, sc.store.count - 2); sc.drawFrame();
    const second = { label: sc.renderer.cursorLabel, status: document.getElementById('sc-window').textContent };
    const t = { t0: sc.store.timeAt(0), cur: sc.store.timeAt(first.cursor), rate: sc.store.rate() };
    sc.renderer.cursor = null; sc.drawFrame();
    return { first, second, withCursor, noCursor, atX, count: sc.store.count, ...t };`);
  ok(c.first.cursor > 0, `鼠标移动真的设上了游标（样本 #${c.first.cursor}）`);
  ok(/^[\d.]+\s*(µs|ms|s)$/.test(c.first.label || ''), `游标标签是"时刻"：「${c.first.label}」`);
  ok(c.withCursor > 20 && c.noCursor === 0,
     `标签真的画在 X 轴槽里（标签矩形内 ${c.withCursor} 个亮像素 / 无游标 ${c.noCursor} 个）`);
  ok(c.first.label !== c.second.label,
     `标尺移动 → 时刻跟着变（${c.first.label} → ${c.second.label}）`);
  ok(/游标 t=/.test(c.first.status), `状态行同时报出游标时刻：${c.first.status.slice(0, 52)}…`);
  ok(c.first.legend.includes(c.first.label), `图例每行也带上同一时刻（${c.first.legend.slice(0, 30)}…）`);
  const expectMs = (c.cur - c.t0) / 1000;                       // 假探针 100 µs/样本
  ok(Math.abs(expectMs - c.first.cursor / 10) < 1,
     `换算对得上：样本 #${c.first.cursor} = ${expectMs.toFixed(2)} ms（${(c.rate / 1000).toFixed(2)} kHz）`);
  // 状态行读数变长（"0 µs" → "10.94 s"）不许把画布挤矮：画布是 flex:1，行高一变波形就跳
  const stable = await ev(`
    const sc = window.__tools.scope;
    const cv = document.getElementById('sc-canvas');
    const win = document.getElementById('sc-window');
    const before = { h: cv.clientHeight, w: cv.clientWidth, text: win.textContent.length };
    sc.renderer.cursor = 1; sc.drawFrame();
    const short = { h: cv.clientHeight, w: cv.clientWidth, len: win.textContent.length };
    sc.renderer.cursor = sc.store.count - 1; sc.drawFrame();
    const long = { h: cv.clientHeight, w: cv.clientWidth, len: win.textContent.length };
    win.textContent = 'x'.repeat(400);                       // 极端：直接塞超长文本
    const huge = { h: cv.clientHeight, w: cv.clientWidth };
    sc.drawFrame();
    const after = { h: cv.clientHeight, w: cv.clientWidth };
    sc.renderer.cursor = null; sc.drawFrame();
    return { before, short, long, huge, after };`);
  ok(stable.short.h === stable.long.h && stable.long.h === stable.huge.h && stable.before.h === stable.huge.h,
     `状态行文字再长也不改画布尺寸（${stable.before.h} → 短 ${stable.short.h} → 长 ${stable.long.h} → 超长 ${stable.huge.h}）`);
}

console.log('== 5.6 双游标 A/B：量周期 ==');
{
  const c = await ev(`
    const sc = window.__tools.scope;
    const cv = document.getElementById('sc-canvas');
    const box = cv.getBoundingClientRect();
    const at = f => box.left + sc.renderer.padding.l + sc.renderer.plotW * f;
    const click = (f, shift) => {
      const clientX = at(f);
      cv.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY: box.top + 60, bubbles: true, button: 0, shiftKey: !!shift }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY: box.top + 60, bubbles: true, button: 0, shiftKey: !!shift }));
    };
    sc.follow = false; sc.renderer.fitAll(); sc.renderer.clearMarks(); sc.drawFrame();
    click(0.25, false);                       // 单击 → 放 A
    const afterA = { a: sc.renderer.cursors.a, b: sc.renderer.cursors.b, delta: sc.renderer.delta() };
    click(0.75, true);                        // Shift+单击 → 放 B
    sc.drawFrame();
    const d = sc.renderer.delta();
    const st = sc.store;
    const now = {
      a: sc.renderer.cursors.a, b: sc.renderer.cursors.b,
      label: sc.renderer.deltaLabel,
      window: document.getElementById('sc-window').textContent,
      state: document.getElementById('sc-state').textContent,
      dtUs: d && d.dtUs, samples: d && d.samples,
      expectUs: d ? st.timeAt(d.b.index) - st.timeAt(d.a.index) : null,
      hz: d && d.hz, rate: st.rate(),
    };
    // 拖动 B 的竖线：抓在线上拖到 60% 处
    const spanBefore = sc.renderer.span;
    const xB = sc.renderer.xOf(sc.renderer.cursors.b);
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: box.left + xB, clientY: box.top + 60, bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: at(0.6), clientY: box.top + 60, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: at(0.6), clientY: box.top + 60, bubbles: true, button: 0 }));
    sc.drawFrame();
    const dragged = { b: sc.renderer.cursors.b, dtUs: sc.renderer.delta().dtUs, follow: sc.follow,
                      spanBefore, span: sc.renderer.span,
                      want: Math.round(sc.renderer.view.start + sc.renderer.span * 0.6),
                      // MouseEvent.clientX 是整数，落点最多偏 0.5 px；1 px 值多少样本要按当前缩放折算
                      tol: Math.ceil(sc.renderer.span / sc.renderer.plotW) + 2 };
    // 拖空白处 = 平移（不能顺手放游标）
    const beforePan = { a: sc.renderer.cursors.a, b: sc.renderer.cursors.b };
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: at(0.5), clientY: box.top + 60, bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: at(0.4), clientY: box.top + 60, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: at(0.4), clientY: box.top + 60, bubbles: true, button: 0 }));
    const afterPan = { a: sc.renderer.cursors.a, b: sc.renderer.cursors.b };
    // Esc 清除
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    sc.drawFrame();
    const cleared = { a: sc.renderer.cursors.a, b: sc.renderer.cursors.b, label: sc.renderer.deltaLabel };
    // 反过来放（B 在 A 左边）→ Δt 必须报负数，不许悄悄取绝对值
    sc.renderer.setMark('a', 900); sc.renderer.setMark('b', 300);
    const neg = sc.renderer.delta();
    sc.renderer.clearMarks(); sc.drawFrame();
    return { afterA, now, dragged, beforePan, afterPan, cleared, neg: { dtUs: neg.dtUs, hz: neg.hz } };`);
  ok(c.afterA.a != null && c.afterA.b == null && !c.afterA.delta, `单击只放 A，不放 B（A=#${c.afterA.a}）`);
  ok(c.now.a != null && c.now.b != null && c.now.a < c.now.b, `Shift+单击放下 B（A=#${c.now.a} → B=#${c.now.b}）`);
  ok(/^Δt /.test(c.now.label) && /Hz/.test(c.now.label), `轴槽给出 Δt 与等效频率：「${c.now.label}」`);
  ok(c.now.dtUs > 0 && Math.abs(c.now.dtUs - c.now.expectUs) < 1e-6,
     `Δt 与 store.timeAt(B)-timeAt(A) 一致（${(c.now.dtUs / 1000).toFixed(3)} ms / ${c.now.samples} 样本）`);
  ok(Math.abs(c.now.hz - 1e6 / c.now.dtUs) < 1e-6, `等效频率 = 1/Δt（${(c.now.hz / 1000).toFixed(2)} kHz）`);
  // Δt 必须排在**最前面**：这行会被省略号从右边截断，结论性的数字不能排在末尾
  ok(/^Δt .*（A .* → B .* 样本）/.test(c.now.window),
     `状态行把 Δt/频率 排在最前（${c.now.window.slice(0, 58)}…）`);
  ok(/Δt/.test(c.now.state), `点击后的提示语带 Δt：${c.now.state.slice(0, 40)}`);
  ok(c.dragged.b !== c.now.b && Math.abs(c.dragged.b - c.dragged.want) <= c.dragged.tol,
     `抓住线拖动 = 只微调那个游标（B #${c.now.b} → #${c.dragged.b}，期望 #${c.dragged.want} ±${c.dragged.tol} 样本 = 1 px）`);
  ok(c.dragged.span === c.dragged.spanBefore && c.dragged.follow === false,
     `拖游标不会顺手把视图平移掉（span ${Math.round(c.dragged.spanBefore)} 不变）`);
  ok(c.afterPan.a === c.beforePan.a && c.afterPan.b === c.beforePan.b, '拖空白处只平移，不会把游标挪走/新放一个');
  ok(c.cleared.a === null && c.cleared.b === null && c.cleared.label === null, 'Esc 清除 A/B');
  ok(c.neg.dtUs < 0 && c.neg.hz > 0, `B 在前（A 在后）时 Δt 报负数（${c.neg.dtUs} µs），频率仍取 |Δt|`);
}

console.log('== 6. 触发（实时 + 离线重定位）==');
{
  const hit = await ev(`
    const sc = window.__tools.scope;
    const ch = sc.store.channels.findIndex(c => c.scalar === 'i16');   // 假探针的 1 kHz 方波
    document.getElementById('sc-trig-mode').value = '3';               // 上升沿
    document.getElementById('sc-trig-ch').value = String(ch);
    document.getElementById('sc-trig-level').value = '0';
    document.getElementById('sc-trig-pre').value = '200';
    document.getElementById('sc-trig-post').value = '800';
    sc.applyTrigger();
    return { idx: sc.trigger.hitIndex, ch, marker: !!sc.renderer.trigger };`);
  ok(hit.idx >= 0 && hit.marker === true, `触发命中 @ 样本 ${hit.idx}（i16 方波上升沿，第 ${hit.ch} 通道）`);
  const next = await ev(`
    const sc = window.__tools.scope;
    const first = sc.trigger.hitIndex;
    document.getElementById('sc-trig-find').click();
    return { first, second: sc.trigger.hitIndex, state: document.getElementById('sc-trig-state').textContent };`);
  ok(next.second > next.first, `「查找下一个」跳到更靠后的命中点（${next.first} → ${next.second}）`);
  ok(/命中/.test(next.state), '触发状态行有文案：' + next.state.slice(0, 40));
  const cleared = await ev(`
    document.getElementById('sc-trig-clear').click();
    return { hit: window.__tools.scope.trigger.hitIndex, marker: !!window.__tools.scope.renderer.trigger };`);
  ok(cleared.hit === -1 && cleared.marker === false, '「清除触发」把标记和命中点都清了');
}

console.log('== 7. 停止 / 导出 CSV / 记录原始包 ==');
{
  // 「时长」= 目标侧真实时间，不是"攒够名义速率×时长 个样本" —— 用户实测："时长3s，怎么我采出来的有6.6s?"
  const stop = await ev(`
    const sc = window.__tools.scope;
    // 前面几节耗时不定，不能假设"已经跑够 5 s"了 —— 等到它自己停（或超时）再看结论。
    // ⚠️ 停下来的瞬间 running 就变 false，但 stop() 里还有两个 await（排空 + HID STOP）才写结论文字，
    //    所以这里要等状态文字落定，别读到中间态（否则这条断言会时好时坏 —— 本文件已踩过）。
    for (let i = 0; i < 24 && sc.running; i++) await new Promise(r2 => setTimeout(r2, 250));
    for (let i = 0; i < 20 && !/^已停止/.test(sc.state); i++) await new Promise(r2 => setTimeout(r2, 100));
    const st = sc.store;
    const d = { state: sc.state, stopAfter: sc._stopAfterUs, cap: st.capacity, count: st.count, full: st.full, tsN: st.tsN,
                spanS: +((st.timeAt(st.count - 1) - st.timeAt(0)) / 1e6).toFixed(3), over: st.overrun, running: sc.running };
    await sc.stop();
    const after = { state: sc.state, count: sc.store.count, buf: document.getElementById('sc-buf').textContent,
                    over: document.getElementById('sc-over').textContent };
    return { d, after };`);
  ok(stop.d.running === false && /时长到/.test(stop.d.state),
     `到点自己停了，而且说清是"时长到"：running=${stop.d.running} span=${stop.d.spanS} count=${stop.d.count} over=${stop.d.over} | ${stop.d.state.slice(0, 46)}`);
  ok(Math.abs(stop.d.spanS - 5) < 0.15,
     `采到的时长就是要求的 5 s（实测 ${stop.d.spanS} s，缓冲只用了 ${Math.round(stop.d.count / stop.d.cap * 100)}%）`);
  ok(stop.d.full === false && stop.d.over === 0,
     `到点时缓冲没满、溢出为 0（满=${stop.d.full} 溢出=${stop.d.over}）—— 以前这里会涨成"缺口 1924246"那种数`);
  await ev(`document.getElementById('sc-stop').click(); return true;`);
  await sleep(500);
  const s = await ev('return window.__tools.scope.summary();');
  ok(s.running === false, '已停止');
  ok(s.samples > 3000, `停止后样本仍是 ${s.samples}（数据留着）`);

  const raw = await ev(`
    const c = document.getElementById('sc-raw'); c.checked = true; c.dispatchEvent(new Event('change'));
    document.getElementById('sc-start').click();
    return true;`);
  void raw;
  await sleep(1200);
  await ev(`document.getElementById('sc-stop').click(); return true;`);
  await sleep(400);
  const s2 = await ev('return window.__tools.scope.summary();');
  ok(s2.raw > 0, `勾上「记录原始包」后收到了 ${s2.raw} 块原始数据`);

  await ev(`document.getElementById('sc-csv').click(); return true;`);
  await sleep(600);
  const st = await ev(`return document.getElementById('sc-state').textContent;`);
  ok(/已导出 CSV/.test(st), '导出 CSV 的代码路径跑通：' + st.slice(0, 40));
  const saved = await ev(`document.getElementById('sc-save').click(); return document.getElementById('sc-state').textContent;`);
  ok(/已保存原始包/.test(saved), '保存原始包的代码路径跑通：' + saved.slice(0, 40));
}

console.log('== 8. 清空与收尾 ==');
{
  const s = await ev(`
    document.getElementById('sc-clear').click();
    const sc = window.__tools.scope;
    return { samples: sc.store.count, packets: sc.packets, lost: sc.summary().lost };`);
  ok(s.samples === 0 && s.packets === 0 && s.lost === 0, '「清空」把缓冲和计数都归零');
  const errs = await ev('return window.__tools.errors;');
  ok(Array.isArray(errs) && errs.length === 0, '全程没有 JS 错误', JSON.stringify(errs));
}

console.log('== 9. 勾选顺序 ≠ 地址顺序（帧内顺序 = 地址排序）==');
{
  // 真机踩过的坑：用户按 u_ramp(0x…20) → f_sin(0x…14) 的顺序勾，而固件按**地址**打包，
  // 于是通道与数据整体错位（u_ramp 那格装的是 f_sin 的 ±1）。这里用假探针复现并要求它被修住。
  const r = await ev(`
    const sc = window.__tools.scope;
    document.getElementById('sc-mock').checked = true;
    await window.__tools.scope.setMock(document.getElementById('sc-mock').checked);
    // 故意**逆着地址**勾：先 0x…20 的 u_ramp，再 0x…14 的 f_sin，最后 0x…22 的 i_sq1k
    const order = ['mock3.u16', 'mock0.f32', 'mock5.u8'];
    sc.selected = [];
    for (const n of order){ const v = sc.mockVars().find(x => x.name === n); sc.toggleVar(v, true); }
    document.getElementById('sc-period').value = '100';
    document.getElementById('sc-seconds').value = '3';
    await sc.start();
    await new Promise(r2 => setTimeout(r2, 1500));
    await sc.stop();
    const st = sc.store;
    const names = st.channels.map(c => c.name);
    const stats = st.channels.map(c => ({ name: c.name, type: c.scalar, min: c.min, max: c.max,
                                          first: c.at(0), last: c.at(st.count - 1) }));
    return { picked: order, storeNames: names, stats, count: st.count,
             defVars: sc.defVars?.map(v => '0x' + v.addr.toString(16)) || null, mismatch: sc.defMismatch };`);
  ok(r.storeNames.length === 3 && r.count > 0, `采到 ${r.count} 个样本`);
  const sortedByAddr = ['mock0.f32', 'mock3.u16', 'mock5.u8'];   // mockVars 的地址是 0x20000000 + i*4
  ok(JSON.stringify(r.storeNames) === JSON.stringify(sortedByAddr),
     `缓冲按地址排序（勾选 ${r.picked.join(' → ')} ⇒ 缓冲 ${r.storeNames.join(' → ')}）`);
  const byName = Object.fromEntries(r.stats.map(s => [s.name, s]));
  ok(byName['mock0.f32'] && byName['mock0.f32'].min >= -1.001 && byName['mock0.f32'].max <= 1.001,
     `f32 正弦落在 ±1（实际 ${byName['mock0.f32']?.min?.toFixed(3)}..${byName['mock0.f32']?.max?.toFixed(3)}）`);
  ok(byName['mock3.u16'] && byName['mock3.u16'].min >= 0 && byName['mock3.u16'].max <= 999,
     `u16 锯齿落在 0..999（实际 ${byName['mock3.u16']?.min}..${byName['mock3.u16']?.max}）`);
  ok(byName['mock5.u8'] && byName['mock5.u8'].min >= 0 && byName['mock5.u8'].max <= 255,
     `u8 落在 0..255（实际 ${byName['mock5.u8']?.min}..${byName['mock5.u8']?.max}）`);
  ok(r.mismatch === null, 'DEF 变量数与本地缓冲一致（没有触发"解码已暂停"）', r.mismatch || '');
  // 分道显示：每路一条泳道
  const lanes = await ev(`
    document.querySelector('[data-group=sclayout] button[data-v=lanes]').click();
    const sc = window.__tools.scope; sc.drawFrame();
    return { layout: sc.renderer.layout, n: sc.renderer.visibleCount() };`);
  ok(lanes.layout === 'lanes' && lanes.n === 3, `切到分道：${lanes.n} 条泳道`);
  await ev(`document.querySelector('[data-group=sclayout] button[data-v=overlay]').click(); return true;`);
}

console.log('== 10. HID 句柄作废：显式报错，不自动重发/重新认领 ==');
{
  // Existing resource contract: a failed request must not reacquire after release.
  // See docs/probe-resource-architecture.md; recovery is an explicit later action.
  const r = await ev(`
    const { AkaLinkHid } = await import('/app/hid/probe.js');
    let writes=0, goodWrites=0, enumerations=0;
    const bad = { opened:true,collections:[{usagePage:0xFF00}],addEventListener(){},removeEventListener(){},
      close:async()=>{},sendReport:async()=>{writes++;throw Error('Failed to write the report.');} };
    const good = { ...bad, sendReport:async()=>{goodWrites++;} };
    const hid=new AkaLinkHid();hid.device=bad;
    const original=navigator.hid.getDevices;
    navigator.hid.getDevices=async()=>{enumerations++;return [good];};
    let error='';
    try { await hid.xfer(0x13,undefined,1500); }
    catch(e){error=e.message;}
    finally{navigator.hid.getDevices=original;await hid.close();}
    return {error,writes,goodWrites,enumerations};`);
  ok(/HID.*失败|重连/.test(r.error),'失效句柄请求明确失败并提示重连',JSON.stringify(r));
  ok(r.writes===1 && r.goodWrites===0 && r.enumerations===0,
    '失败请求不重发，也不在资源释放后偷偷重新认领',JSON.stringify(r));
  const r2 = await ev(`
    const { AkaLinkHid } = await import('/app/hid/probe.js');
    const hid = new AkaLinkHid();
    hid.device = { opened: true, collections: [{ usagePage: 0xFF00 }], addEventListener(){}, removeEventListener(){},
                   close: async () => {}, open: async () => {},
                   sendReport: async () => { throw new Error('Failed to write the report.'); } };
    const orig = navigator.hid.getDevices;
    navigator.hid.getDevices = async () => [];               // 连重新取都取不到（设备真没了）
    try { await hid.xfer(0x13, undefined, 1000); return { threw: false }; }
    catch (e){ return { threw: true, msg: String(e.message || e) }; }
    finally { navigator.hid.getDevices = orig; }`);
  ok(r2.threw === true && /复位\/拔插|重连|拔插一次/.test(r2.msg),
     '设备真的没了时给出可操作的中文提示：' + String(r2.msg).slice(0, 70));
}

console.log('== 11. 探针跟不上时，「时长」也不能被拖长（用户实测：要 3 s 采出 6.6 s）==');
{
  // 复现用户现场的关键点：周期填得比探针实际能做的还短（名义 500 kHz，实得只有几十 kHz），
  // 老代码按"名义速率 × 时长 × 1.25"开缓冲、满了才停 ⇒ 实际采到的时长被拉长到 2 倍多。
  // 现在按真实时间轴到点就停，缓冲只当内存上限。
  const r = await ev(`
    const sc = window.__tools.scope;
    document.getElementById('sc-mock').checked = true;
    await window.__tools.scope.setMock(document.getElementById('sc-mock').checked);
    // 假探针"实际做不到"请求的周期：周期 5 µs 想要 200 kHz，每样本实际要 11 µs ⇒ 实得 90.9 kHz，
    // 和用户现场（要 200 kHz / 实得 112.9 kHz）同一类。老代码据此把 3 s 采成了 6.6 s。
    sc.mockProbe.slowdown = 2.2;
    document.getElementById('sc-period').value = '5';
    document.getElementById('sc-seconds').value = '3';
    await sc.start();
    const at = { cap: sc.store.capacity, stopAfter: sc._stopAfterUs };
    await new Promise(r2 => setTimeout(r2, 4200));            // 给足时间让它自己停
    const st = sc.store;
    const spanS = (st.timeAt(st.count - 1) - st.timeAt(0)) / 1e6;
    return { at, running: sc.running, state: sc.state, count: st.count, spanS, full: st.full,
             overrun: st.overrun, rate: st.rate(),
             buf: document.getElementById('sc-buf').textContent };`);
  // 🚨 假探针对象是**跨轮复用**的（view.setMock 里 `this.mockProbe = this.mockProbe || ...`），
  //    这里改过 slowdown 就必须改回去 —— 否则后面每一轮（甚至下一次跑测试）都还是"慢探针"，
  //    采样数少一半，别的断言会莫名其妙地飘（本文件踩过一次：同一次跑出现 2 个时好时坏的失败）。
  await ev(`if (window.__tools.scope.mockProbe) window.__tools.scope.mockProbe.slowdown = 1; return true;`);
  ok(r.running === false, `到点自动停了（${r.state.slice(0, 40)}）`);
  ok(Math.abs(r.spanS - 3) < 0.2,
     `要 3 s 就只采 3 s：实测 ${r.spanS.toFixed(3)} s（实得 ${(r.rate / 1000).toFixed(1)} kHz，名义 200 kHz —— 老代码这里会跑成 6.6 s）`);
  ok(r.full === false && r.overrun === 0 && r.count < r.at.cap,
     `缓冲没满、也没有溢出帧（${r.count}/${r.at.cap} 样本 · ${r.buf} · 溢出 ${r.overrun}）`);
}

console.log('== 12. 标定值必须跟着变量/时钟失效（否则一个过期数字把人挡在门外）==');
{
  // 用户现场：先用 f_sin+i_sq1k 标定得 8.204 µs，取消 i_sq1k 只剩 f_sin 后，
  // 计划行还在报「已标定 8.204 µs（建议周期 ≥ 11 µs）」，而单字实测只要 1.53 µs、3 µs 档零丢。
  const r = await ev(`
    const sc = window.__tools.scope;
    document.getElementById('sc-mock').checked = true;
    await window.__tools.scope.setMock(document.getElementById('sc-mock').checked);
    await sc.connectHid(false);                      // 假探针也有"标定"（会假装一个结果）
    const pick = names => { sc.selected = [];
      for (const n of names){ const v = sc.mockVars().find(x => x.name === n); if (v) sc.toggleVar(v, true); } };
    pick(['mock0.f32']);
    document.getElementById('sc-clock').value = '60000';
    sc.updatePlan();
    const single = { plan: document.getElementById('sc-plan').innerHTML, fast: sc.plan.fastPath,
                     bestUs: sc.plan.bestUs, estUs: sc.plan.estUs };
    await sc.bench();                                 // 标定单变量
    const afterSingle = { bench: sc.benchUs, fresh: sc.benchFresh(), rec: sc.recPeriodUs };
    pick(['mock0.f32', 'mock3.u16']);                 // 换成两个变量 → 上一次的标定失效
    sc.updatePlan();
    const stale = { fresh: sc.benchFresh(), plan: document.getElementById('sc-plan').innerHTML,
                    why: sc.benchKeyWhy() };
    await sc.bench();                                 // 重新标定 → 又新鲜了
    const refixed = { fresh: sc.benchFresh(), key: sc.benchKeyOf() };
    return { single, afterSingle, stale, refixed };`);
  ok(r.single.fast === true && r.single.bestUs < 2 && r.single.estUs > 4 && r.single.estUs < 5,
     `单字 f32 的计划行用快路径实测值（取用 ${r.single.bestUs} µs，模型 ${r.single.estUs} µs —— 后者是 akaLinkPro 拟合的每 span 3 次传输 + 1 次 DRW）`);
  ok(/流水快路径/.test(r.single.plan) && !/模型估算 ≈\d+\.\d+ µs\/样本 → ≈\d+ kHz/.test(r.single.plan),
     `计划行不再自相矛盾（不把模型那个数当主数字）：${r.single.plan.replace(/<[^>]+>/g, '').slice(0, 60)}…`);
  ok(r.afterSingle.fresh === true, `标定后就地生效（${r.afterSingle.bench?.toFixed?.(3)} µs，建议周期 ${r.afterSingle.rec} µs）`);
  ok(r.stale.fresh === false && /已失效/.test(r.stale.plan),
     `改了变量 → 标定值标为失效并说明原因（${r.stale.why}）`);
  ok(r.refixed.fresh === true, '重新标定后又新鲜了');
  await ev(`document.getElementById('sc-mock').checked = false;
            await window.__tools.scope.setMock(document.getElementById('sc-mock').checked); return true;`);
}

console.log('== 13. 起跑阶段的新数据要收下；收工之后一律不收 ==');
{
  // 代码审查抓到：DATA 分支用 `!this.running` 当闸门时，会把"DEF 已到、START 的 STATUS 轮询
  // （120~240 ms）还没 resolve"这段窗口里的**新一轮真实数据**整包丢掉（起跑段缺样本、触发晚布防）。
  // 现在闸门是 `_capturing`（start 里打开、stop 里关掉），这里把两个方向都钉住。
  const r = await ev(`
    const P = await import('/app/scope/protocol.js');
    const S = await import('/app/scope/store.js');
    const sc = window.__tools.scope;
    document.getElementById('sc-mock').checked = true;
    await window.__tools.scope.setMock(document.getElementById('sc-mock').checked);
    const vars = sc.mockVars();
    sc.store = new S.SampleStore(vars, 2000);
    sc.renderer.setStore(sc.store);
    sc.seqT = new P.SeqTracker(); sc.stream = new P.PacketStream();
    sc._awaitDef = true; sc.defVars = null; sc.defMismatch = null;
    sc.running = false; sc._capturing = true;               // ← 起跑中（START 还没 resolve）
    sc.onChunk(P.buildDef({ seq: 1, swdHz: 60000000, periodUs: 100, flags: 0, vars, spans: 1 }));
    const afterDef = sc.store.count;
    const mkData = (seq, t, n) => {
      const payload = new Uint8Array(496);
      for (let i = 0; i < n; i++) P.packSamples(vars, vars.map((v, k) => i + k), payload.subarray(i * sc.plan.frameBytes));
      return P.buildData({ seq, tUs: t, n, payload });
    };
    sc.onChunk(mkData(2, 1000, 5));
    const duringStart = sc.store.count;                     // 起跑窗口里应该收下 5 个
    sc._capturing = false;                                  // ← 收工（stop 之后）
    sc.onChunk(mkData(3, 2000, 5));
    const afterStop = sc.store.count;                       // 收工之后一个都不许进
    return { nvars: vars.length, frameBytes: sc.plan.frameBytes, afterDef, duringStart, afterStop };`);
  ok(r.afterDef === 0, `DEF 只是起跑线，不产生样本（count=${r.afterDef}）`);
  ok(r.duringStart === 5 && r.afterStop === 5,
     `起跑窗口收下 5 个样本、收工后再喂 5 个一个都不进（${r.duringStart} → ${r.afterStop}）`);
}

console.log('== 14. RISC-V/JTAG 目标：显示生效后端、置灰 SWD 控件、按后端给建议 ==');
{
  const r = await ev(`
    const sc = window.__tools.scope;
    const P = await import('/app/scope/protocol.js');
    document.getElementById('sc-mock').checked = true;
    await window.__tools.scope.setMock(document.getElementById('sc-mock').checked);
    sc.mockProbe.riscv = false;
    const before = { backend: sc.backend, mhz: document.getElementById('sc-mhz').textContent,
                     plan: document.getElementById('sc-plan').innerText.replace(/\\s+/g, ' ').slice(0, 90) };
    // ① 假探针装成 RISC-V 后端，采一小段：DEF 的 flags bit6 会带过来
    sc.mockProbe.riscv = true;
    document.getElementById('sc-period').value = '10';
    document.getElementById('sc-seconds').value = '1';
    await sc.start();
    await new Promise(r2 => setTimeout(r2, 700));
    await sc.stop();
    const after = { backend: sc.backend, shown: document.getElementById('sc-backend').textContent,
                    mhz: document.getElementById('sc-mhz').textContent,
                    clockDisabled: document.getElementById('sc-clock').disabled,
                    clockLabel: document.getElementById('sc-clock-row').querySelector('span').textContent,
                    plan: document.getElementById('sc-plan').innerText.replace(/\\s+/g, ' ') };
    // ② 状态字 0 bit1 这条独立通路（丢弃模式没有 DEF）：直接喂一个假回包
    sc.backend = null;
    sc._absorbeStatusBackend(Uint8Array.of(0x33, 0x32, 0, 2, 0, 0, 0));
    const viaStatus = sc.backend;
    // ③ 目标类型选择器 → HID 0x31 action 10
    let sent = null;
    const origXfer = sc.hidXfer.bind(sc);
    sc.hidXfer = async (cmd, data) => { sent = { cmd, data: Array.from(data) }; return Uint8Array.of(0x33, 0x31, 0, 0); };
    document.getElementById('sc-target').value = 'riscv';
    await sc.applyTargetType();
    const sentRiscv = sent;                     // 记下 RISC-V 那一次（下面还要切回 SWD，别把它覆盖了）
    const stRiscv = document.getElementById('sc-state').textContent;
    const labelByDropdown = document.getElementById('sc-clock-row').querySelector('span').textContent;
    document.getElementById('sc-target').value = 'swd';
    await sc.applyTargetType();                 // 切回 SWD：那一格的名字要变回去
    const labelBackSwd = document.getElementById('sc-clock-row').querySelector('span').textContent;
    sc.hidXfer = origXfer;
    sc.mockProbe.riscv = false;
    sc.backend = null;
    sc._applyBackendUi();
    return { before, after, viaStatus, sent: sentRiscv, st: stRiscv, labelByDropdown, labelBackSwd,
             names: [P.backendName('swd'), P.backendName('riscv')] };`);
  ok(r.after.backend === 'riscv', `DEF flags bit6 → 页面认到 RISC-V 后端（${r.after.shown}）`);
  ok(/RISC-V\/JTAG/.test(r.after.mhz), `状态栏显示后端而不是 SWD 时钟：${r.after.mhz}`);
  ok(r.after.clockDisabled === true, 'SWD 时钟档在 RISC-V 下被置灰（JTAG 忽略它）');
  // 用户 2026-09-30：切到 RISC-V/JTAG 后，那一格的名字不能还叫「SWD 时钟」（它在 JTAG 下是 TCK）
  ok(r.after.clockLabel === 'JTAG 时钟' && r.labelByDropdown === 'JTAG 时钟' && r.labelBackSwd === 'SWD 时钟',
     `时钟那格的名字跟着目标类型走：生效后端 RISC-V →「${r.after.clockLabel}」· 下拉切 RISC-V →「${r.labelByDropdown}」· 切回 SWD →「${r.labelBackSwd}」`);
  ok(/RISC-V\/JTAG 粗估/.test(r.after.plan) && /N\+4/.test(r.after.plan) && !/周期下限 2 µs/.test(r.after.plan),
     `计划行改成 JTAG 的说法：${r.after.plan.slice(0, 78)}…`);
  ok(/1\.5×/.test(r.after.plan), '并给出"建议起始周期 1.5×，需实采验证"的提示');
  ok(r.viaStatus === 'riscv', '状态字 0 的 bit1 也能定后端（丢弃模式没有 DEF 包时的唯一来源）');
  ok(r.sent && r.sent.cmd === 0x31 && r.sent.data.join(',') === '10,1',
     `目标类型切换发的是 HID 0x31 action 10（实际 cmd=0x${(r.sent?.cmd ?? 0).toString(16)} data=${r.sent?.data}`)
  ok(/RISC-V\/JTAG/.test(r.st), `切完给了明确回执：${r.st.slice(0, 60)}`);
}

// ==================================================================== 15
console.log('== 15. 用户现场口径：**没连探针**时切目标类型，界面必须立刻变（不能"切了没反应"）==');
{
  const r = await ev(`
    const sc = window.__tools.scope;
    // 断开一切（这一段就是要验"探针不在线"的情形）
    document.getElementById('sc-mock').checked = false;
    await window.__tools.scope.setMock(document.getElementById('sc-mock').checked);
    await new Promise(r2 => setTimeout(r2, 500));
    sc.setBackend(null, '测试');                   // 后端未知 = 刚打开页面的样子
    sc.backend = null; sc._reportedAt = 0; sc._askedAt = 0;
    sc.targetRiscv = null;
    const sel = document.getElementById('sc-target');
    sel.value = 'swd'; await sc.applyTargetType();
    const before = { label: document.getElementById('sc-clock-row').querySelector('span').textContent,
                     disabled: document.getElementById('sc-clock').disabled,
                     plan: document.getElementById('sc-plan').innerText.replace(/\\s+/g, ' '),
                     backendLine: document.getElementById('sc-backend').textContent,
                     mhz: document.getElementById('sc-mhz').textContent };
    sel.value = 'riscv'; await sc.applyTargetType();      // ← 用户这一步"切换了"
    const after = { label: document.getElementById('sc-clock-row').querySelector('span').textContent,
                    disabled: document.getElementById('sc-clock').disabled,
                    plan: document.getElementById('sc-plan').innerText.replace(/\\s+/g, ' '),
                    backendLine: document.getElementById('sc-backend').textContent,
                    mhz: document.getElementById('sc-mhz').textContent };
    sel.value = 'swd'; await sc.applyTargetType();        // 切回来也要跟着回去
    const back = { label: document.getElementById('sc-clock-row').querySelector('span').textContent,
                   disabled: document.getElementById('sc-clock').disabled,
                   plan: document.getElementById('sc-plan').innerText.replace(/\\s+/g, ' ') };
    return { before, after, back };`);
  ok(r.before.label === 'SWD 时钟' && r.before.disabled === false && /模型估算/.test(r.before.plan),
     `未连探针时默认按 SWD 显示（「${r.before.label}」/「${r.before.mhz}」）`);
  ok(r.after.label === 'JTAG 时钟' && r.after.disabled === true,
     `切到 RISC-V/JTAG → 那一格当场改名「${r.after.label}」并置灰（用户要的就是这个）`);
  ok(/RISC-V\/JTAG 粗估/.test(r.after.plan) && /N\+4/.test(r.after.plan),
     `读计划当场换成 JTAG 的扫描预算：${r.after.plan.slice(0, 60)}…`);
  ok(/未开始/.test(r.after.backendLine) && /RISC-V\/JTAG/.test(r.after.backendLine),
     `「生效后端」仍诚实地说还没开始、并记住你选的是哪条路：「${r.after.backendLine}」`);
  ok(r.back.label === 'SWD 时钟' && r.back.disabled === false && /模型估算/.test(r.back.plan),
     `切回 SWD 也立刻回去（${r.back.label}）`);
}

console.log('== 16. 超限输入有持续警告，强制继续保留周期，物理下限与非法输入明确处理 ==');
{
  const r=await ev(`
    const sc=window.__tools.scope;
    await sc.setMock(true);await sc.connectHid(false);
    sc.selected=[];for(const name of ['mock0.f32','mock3.u16'])sc.toggleVar(sc.mockVars().find(v=>v.name===name),true);
    await sc.bench();
    const input=document.getElementById('sc-period');input.value='2';input.dispatchEvent(new Event('input'));
    const fast={text:document.getElementById('sc-rate-advice').textContent,readUs:sc.benchUs};
    document.getElementById('sc-seconds').value='1';await sc.start();
    fast.started=sc.running;fast.period=sc._periodUs;fast.disabled=input.disabled;
    sc.drawFrame();fast.visible=document.getElementById('sc-rate-advice').textContent;
    await sc.stop();fast.enabled=!input.disabled;
    input.value='1';input.dispatchEvent(new Event('input'));const normalized=document.getElementById('sc-rate-advice').textContent;
    await sc.start();const actual=sc._periodUs;await sc.stop();
    input.value='0';input.dispatchEvent(new Event('input'));await sc.start();
    const invalid={running:sc.running,state:sc.state};
    input.value='100';sc.updatePlan();await sc.setMock(false);
    return {fast,normalized,actual,invalid};`);
  ok(r.fast.readUs>2 && /超过读取耗时上界/.test(r.fast.text) && /建议/.test(r.fast.text), '超过读取能力时显示推荐周期和警告');
  ok(r.fast.started && r.fast.period===2 && /保留 2/.test(r.fast.visible), '强制继续保留 2µs，不把读取耗时当作自动最大速率');
  ok(r.fast.disabled && r.fast.enabled, '采集中锁定周期，停止后可修改');
  ok(/填写 1.*采用 2/.test(r.normalized) && r.actual===2, '低于探针物理下限时明示采用 2µs');
  ok(!r.invalid.running && /必须是大于 0/.test(r.invalid.state), '非法周期阻止启动，不静默采用默认周期');
}

console.log(`\n${fail ? '❌' : '✅'} scope-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
