/**
 * 入口：把三个标签页接起来。
 * 串口助手与终端共用同一个串口会话（一个 COM 口只能被一个程序打开，
 * 两个标签是同一路数据的两种看法）；RTT 是独立的调试器会话。
 */
import { installProbeManager } from './core/probe-users.js';
import { initTabs } from './ui/tabs.js';
import { initWorkspaces } from './ui/workspace.js';
import { initProbeStatus } from './ui/probe-status.js';
import { initEventLogs } from './ui/event-logs.js';
import { SerialSession } from './serial/session.js';
import { Assistant } from './serial/assistant.js';
import { TerminalView } from './serial/terminal.js';
import { RttView } from './rtt/view.js';
import { FlashView } from './flash/view.js';
import { GenView } from './gen/view.js';
import { RttCdcView } from './hid/view.js';
import { RttCdcStreamView } from './hid/stream.js';
import { ScopeView } from './scope/view.js';
import { DbgView } from './dbg/view.js';
import { SpiSession } from './spi/session.js';
import { SpiBusView } from './spi/bus-view.js';
import { SpiPanelView } from './spi/panel-view.js';
import { AnalogView } from './analog/view.js';
import { installAcquisitionDiagnostics } from './diagnostics/acquisition.js';
import { I2cView } from './i2c/view.js';
import { SpiCdcView } from './spi-cdc/view.js';
import { ProbeBus, closeProbeUsbDevices } from './core/probe-bus.js';
import { toast } from './ui/toast.js';
import { BUILD } from './core/build.js';

// ---------- 错误收集（自检/排障用；平时看不见） ----------
const errors = [];
window.addEventListener('error', e => errors.push(`[error] ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => errors.push(`[promise] ${e.reason?.message || e.reason}`));

const session = new SerialSession();
const assistant = new Assistant(session);
const terminal = new TerminalView(session);
const rtt = new RttView();
const flash = new FlashView();
const gen = new GenView();
const hid = new RttCdcView();
const stream = new RttCdcStreamView(session);
const scope = new ScopeView();
// 调试器（#dbg）：零安装的极简调试前端（暂停/单步/寄存器/内存/FPB 断点/命令行/RTT 同屏）
const dbg = new DbgView();
// SPI 桥：**一次连接，两页共用**（桥页管链路与通用帧，屏页管面板档/初始化/刷图）
const spiSession = new SpiSession();
const spi = new SpiBusView(spiSession);
const panel = new SpiPanelView(spiSession);
// USB→I2C 转发桥（#i2c）：HID 0x36，只走 HID 一条通路（没有 bulk 端点）
const i2c = new I2cView();
const analog = new AnalogView();
const spiCdc = new SpiCdcView(session);

// Install ownership before init(): automatic reconnect/start paths use the same manager.
const probeBus = new ProbeBus('page');
const tools = { session, assistant, terminal, rtt, flash, gen, hid, stream, scope, spi, panel, dbg, i2c, analog, spiCdc, spiSession, probeBus, summary, errors };
const probeManager = installProbeManager(tools, { bus: probeBus });
initProbeStatus(tools);
initEventLogs();
window.__tools = tools;
const workspace = initWorkspaces();

assistant.init();
terminal.init();
rtt.init();
flash.init();
gen.init();
hid.init();
stream.init();
scope.init();
spi.init();
panel.init();
dbg.init();
i2c.init();
analog.init();
spiCdc.init();
installAcquisitionDiagnostics(tools);

initTabs(name => {
  workspace.sync();
  if (name === 'serial') requestAnimationFrame(() => assistant.onShow());
  if (name === 'terminal') requestAnimationFrame(() => terminal.onShow());
  if (name === 'rtt') requestAnimationFrame(() => rtt.onShow());
  if (name === 'rttcdc') requestAnimationFrame(() => stream.onShow());
  if (name === 'scope') requestAnimationFrame(() => scope.onShow());
  if (name === 'spi') requestAnimationFrame(() => spi.onShow());
  if (name === 'panel') requestAnimationFrame(() => panel.onShow());
  if (name === 'dbg') requestAnimationFrame(() => dbg.onShow());
  if (name === 'i2c') requestAnimationFrame(() => i2c.onShow());
  if (name === 'analog') requestAnimationFrame(() => analog.onShow());
  if (name === 'spicdc') requestAnimationFrame(() => spiCdc.onShow());
  if (name === 'gen') requestAnimationFrame(() => gen.onShow());
});

/**
 * 跨标签页的探针协调：别的页签要占用探针时，本页把会话收干净（详见 core/probe-bus.js）。
 * 🚨 这是**必需**的一层，不是锦上添花：WebUSB 一个接口同时只能被一个连接认领，
 *    两个页签一起用时第二个只会拿到 `Unable to claim interface`（实测 reset 也救不回来）。
 *    以前只能让用户自己去关别的页签 —— 用户的原话是"有时候打开就卡住"。
 */
probeBus.onRelease = async why => {
  await probeManager.releaseOthers(null, why || '另一个页签要使用探针');
  const closed = await closeProbeUsbDevices();
  if (closed) console.info(`[probe-bus] 已释放探针会话，关闭 ${closed} 个 USB 句柄`);
};
/** 让出的记录也让用户看得见（页签之间的事不该神神秘秘的） */
probeBus.log = s => { try { toast(s, 'warn', 4000); } catch {} };

document.getElementById('btn-help').addEventListener('click', () => document.getElementById('help').showModal());

// ---------- 自检摘要（无头验证 / 用户报障时可直接看） ----------
function summary(){
  return {
    ok: errors.length === 0,
    errors,
    serialSupported: SerialSession.supported(),
    webusbSupported: typeof navigator !== 'undefined' && 'usb' in navigator,
    xtermLoaded: !!window.Terminal,
    tabs: [...document.querySelectorAll('#tabs .tab')].map(t => t.dataset.tab),
    quickSlots: document.querySelectorAll('#s-quick .qrow').length,
    genFiles: (gen?.files || []).map(f => f.name),
    hid: hid?.summary?.() || null,
    stream: stream?.summary?.() || null,
    spiCdc: {connected:spiCdc.session.connected,running:spiCdc.session.running,status:spiCdc.session.last,stream:spiCdc.stream.summary()},
    scope: scope?.summary?.() || null,
    spi: spi?.summary?.() || null,
    panel: panel?.summary?.() || null,
    dbg: dbg?.summary?.() || null,
    i2c: i2c?.summary?.() || null,
    analog: analog.summary(),
    probeResources: probeManager.summary(),
    vendor: 'serial-rtt-tools',
  };
}
const box = document.createElement('div');
box.id = 'selftest';
box.hidden = true;
document.body.appendChild(box);

/**
 * 拆掉加载遮罩 —— 放在这里（所有 view 都 init 完、__tools 挂好之后）。
 * 🚨 顺序很重要：遮罩**必须最后摘**。之前出过一次"线上页面看着像坏的"：
 *    模块多（20+），走代理加载要好几秒，那期间下拉是空的、按钮点了没反应（事件还没绑上），
 *    用户以为是功能缺失 —— 遮罩能把这个阶段说清楚。
 */
{
  const mask = document.getElementById('boot-mask');
  if (mask) requestAnimationFrame(() => mask.remove());
}

/**
 * **构建标记 + 陈旧页面自检**（见 app/core/build.js 的注释）。
 *
 * 背景：GitHub Pages 对 HTML/JS 都发 `max-age=600`，推完修复后浏览器最长 10 分钟还在跑旧模块，
 * 而本机开发服务发 `no-store` 永远最新 —— 于是会看到"本地流畅、线上卡顿"这种**假象**。
 * 这里做两件事：① 把 BUILD 显示在标题栏（一眼可辨）；② 用 cache-buster 重新拉本文件比对，
 * 不一致就提示刷新（不能自动 reload 解决：`location.reload()` 仍可能命中 HTTP 缓存，
 * 得让用户 Ctrl+Shift+R）。
 */
{
  const self = new URL('./core/build.js', import.meta.url);
  const stamp = document.createElement('span');
  stamp.id = 'build-stamp';
  stamp.title = '当前页面加载的代码版本（GitHub Pages 有 10 分钟 HTTP 缓存：推完修复要硬刷新才生效）';
  stamp.className = 'build-stamp';
  stamp.textContent = BUILD.split(' ')[0] + ' 版';
  (document.querySelector('.more-menu') || document.querySelector('.topright') || document.body).appendChild(stamp);
  (async () => {
    try {
      const r = await fetch(self.href + '?t=' + Date.now(), { cache: 'no-store' });
      const txt = await r.text();
      if (!r.ok || !txt.includes(`BUILD = '${BUILD}'`)){
        stamp.textContent = '⚠ 页面是旧版，请 Ctrl+Shift+R';
        stamp.style.color = '#c60';
        stamp.title = '线上有更新的版本（HTTP 缓存最多 10 分钟）；按 Ctrl+Shift+R 强制刷新即可';
        const menu = document.querySelector('#app-more>summary');
        if (menu){ menu.textContent = '更多 · 有更新'; menu.style.color = 'var(--warn)'; }
        console.warn('[build] 页面模块是旧版（HTTP 缓存）：线上已有更新，Ctrl+Shift+R 刷新');
        errors.push?.('页面是旧版（HTTP 缓存），建议 Ctrl+Shift+R');
      }
    } catch { /* 离线/取不到就算了，不影响功能 */ }
  })();
}

// ---------- 浏览器端端到端自检：?demo=serial&selftest=1 ----------
const q = new URLSearchParams(location.search);
if (q.get('selftest') === '1'){
  box.textContent = 'selftest: running';
  (async () => {
    try {
      const { runUiSelfTest } = await import('../tools/selftest/ui.selftest.mjs');
      const res = await runUiSelfTest(window.__tools);
      box.textContent = JSON.stringify({ ...summary(), selftest: res });
    } catch (e){
      box.textContent = JSON.stringify({ ...summary(), selftestError: String(e?.message || e) });
    }
  })();
} else {
  setTimeout(() => { box.textContent = JSON.stringify(summary()); }, 500);
}
