/**
 * HPM6800EVK（HPM6880，RISC-V/JTAG）真机场景基准 —— 与 `hw-campaign.mjs`（F103/ARM 那份）
 * 同一套编排，按用户的 HPM 口径改：
 *
 *   · **板子是 riscv**：探针的全局目标类型要设成 RISC-V/JTAG；SWD 时钟那两格在 JTAG 下
 *     是 DMI idle 覆盖值，**必须留 0/空**（塞 45 MHz 进去会让 RISC-V 引擎再也读不出内存）。
 *   · **RTT 控制块不在 0x20000000**：HPM 的 RTT 放在 AXI SRAM（本固件 = 0x01240000），
 *     所以"自动搜控制块"那套（从 0x20000000 扫）找不到 —— 这里直接从 ELF 的符号表取
 *     `_SEGGER_RTT` 当搜索起点（`app/rtt/elf.js` 的 findSymbol，同一份解析器页面也在用）。
 *   · **RTT Viewer 走的是新加的 RISC-V 通路**（2026-10 起，`app/rtt/riscv-mem.js`）：
 *     HID 切 SWD+JTAG → WebUSB 的 DAP_JTAG_Sequence → DMI → SBA 读内存，全程零安装。
 *     它比探针固件那条转发通路**慢一个量级**（SBA 一个字一个字搬、每字两次 USB 往返），
 *     所以判决线是它自己量出来的 × 80%。
 *   · 速度跟 F103 完全不是一个量级，**不能拿 F103 的线卡**：
 *     第一遍用 `--record` 只记录不判决，末尾会打印"本次实测 × 80%"的 spec 建议，
 *     把它抄回下面的 SPEC 表，再跑一遍才是正式判决。
 *
 *   node tools/selftest/hw-campaign-hpm.mjs --record        # 第一遍：只记录 + 给 spec 建议
 *   node tools/selftest/hw-campaign-hpm.mjs                 # 之后：按 SPEC 判决
 *   node tools/selftest/hw-campaign-hpm.mjs --cycles=1 --alt=1   # 冒烟
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findSymbol } from '../../app/rtt/elf.js';
import { printSummary } from './campaign-summary.mjs';
import { artifact, getBoard } from './board-matrix.mjs';
import { waitForFirstRttData, waitForNextRttPoll } from './rtt-campaign-wait.mjs';

const arg = k => process.argv.find(a => a.startsWith(`--${k}=`));
const has = k => process.argv.includes(`--${k}`);
const argN = (k, d) => { const a = arg(k); return a ? Number(a.split('=')[1]) : d; };

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const LOCAL = has('local');
const REMOTE = 'https://minichao9901.github.io/web-serial-rtt-tools/';
const APP = (LOCAL ? (process.env.APP || 'http://127.0.0.1:8899/index.html') : REMOTE) + '?t=' + Date.now() + '#flash';
const ORIGIN = LOCAL ? 'http://127.0.0.1:8899' : 'https://minichao9901.github.io:443';
const PROFILE = path.join(process.env.TEMP, 'chrome-rtt-authorized');
const BOARD_ID = (arg('board') || '--board=6800evk').split('=')[1];
const BOARD = getBoard(BOARD_ID);
if (BOARD.target !== 'riscv') throw new Error(`HPM campaign 只支持 RISC-V 板卡，${BOARD_ID} 的 target=${BOARD.target}`);
const CHIP = (arg('chip') || `--chip=${BOARD.chip}`).split('=')[1];
const FW = {
  flood: artifact(BOARD_ID, 'rtt'),        // RTT flood（ELF 符号定位控制块）
  scope: artifact(BOARD_ID, 'scope'),      // J-Scope 靶子（契约变量块 g_v）
};
const COM = (arg('com') || '--com=COM5').split('=')[1];
const CYCLES = argN('cycles', 2);
const ALT = argN('alt', 5);
const OUT = arg('out') ? arg('out').split('=').slice(1).join('=')
  : BOARD_ID === '6800evk' ? 'tmp/hpm-campaign-result.json' : `tmp/hpm-${BOARD_ID}-campaign-result.json`;
const KEEP_GOING = has('keep-going');
const RECORD_ONLY = has('record');
const VIEWER_SECS = 8;
const FWD_SECS = 8;
const REC_SECS = 10;
const SCOPE_SECS = 3;
const SCOPE_MATRIX = has('scope-matrix');
const MATRIX_SECONDS = Math.max(1, Math.min(30, argN('matrix-seconds', 3)));
const MATRIX_PERIODS = (arg('matrix-periods') || '2,5,10,20,30,50,100').split(',').map(Number);
const MATRIX_COUNTS = (arg('matrix-vars') || '1,2,3,4,8').split(',').map(Number);
const MATRIX_PATH = arg('matrix-out')
  ? arg('matrix-out').split('=').slice(1).join('=')
  : `docs/validation/2026-10-10-hpm-${BOARD_ID}-jscope-matrix.json`;
if (SCOPE_MATRIX && (!MATRIX_PERIODS.length || MATRIX_PERIODS.some(n => !Number.isFinite(n) || n <= 0)
    || !MATRIX_COUNTS.length || MATRIX_COUNTS.some(n => !Number.isInteger(n) || n < 1 || n > 8))) {
  throw new Error('--matrix-periods 必须是正数，--matrix-vars 仅支持 1..8');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * **spec = 实测值的 80%**（用户口径：先跑一遍记录，再拿跑出来的值定线）。
 *
 * 下表来自 2026-10 那次 `--record` 全口径跑（2 轮 + 交替 5 遍）+ 一次判决跑的实测：
 *   烧 flood 8.8~10.5 s · 烧 scope 8.4~10.3 s · RTT Viewer 63.5~77.3 KB/s · 转发 1.376~1.377 MB/s ·
 *   存盘一致性 99.6~100% · J-Scope 1 变量 257~259 kHz / 3 变量 40.8 kHz · 低速率档零丢
 *   （1 变量 @20µs = 50.00 kHz 零跳拍；3 变量上限只有 ~41 kHz，所以那一档按 30 µs 跑 —— 见 scopeRun 调用处的注释）
 * 速率类取均值 × 0.8（更严）；**耗时类按"实测最坏值 + 15% 余量"**：
 *   把 8.5 s × 0.8 当线是要它比最坏情况还快 20%，那不是能力、是宿主的抖动
 *   （同一份固件同一根线，实测 8.4~10.5 s，慢的那次多半是宿主调度/JTAG 批次被挤）；
 *   线定 12 s 仍能抓住真正的回归（当年后台页限速那次是 17 s → 47 s）。
 * 一致性/错位读这类"正确性"项直接钉死。
 */
const HPM6800_SPEC = {
  flashFloodS: 12.0,     // 实测 8.4~10.5 s（最坏值 + 15%）
  flashScopeS: 12.0,     // 实测 8.4~10.3 s
  viewerKBps: 56.5,      // RTT Viewer（RISC-V）：实测均 70.6 KB/s × 80%
  viewerCorrupt: 0,      // RISC-V 读法必须零错位读
  fwdMBps: 1.101,        // RTT 转发：实测均 1.377 MB/s × 80%
  recordBytesRatio: 0.98,// 存盘字节 / 同窗口收数（实测 99.6~100%）
  j1kHz: 206.6,          // J-Scope 1 变量：实测均 258.3 kHz × 80%
  j3kHz: 32.6,           // J-Scope 3 变量：实测均 40.8 kHz × 80%
  j50k: true,            // 低速率档（1 变量 @20µs = 50 kHz · 3 变量 @30µs）必须零丢样本
};
// HPM5301EVKLite 独立基线：2026-10-09 首轮实测，速度按实测 × 80%，烧录耗时留 15% 调度余量。
// RTT Viewer 44.5 KB/s；转发 1.384 MB/s；J-Scope 1/3 变量 308/52.1 kHz。
const HPM5301_SPEC = {
  flashFloodS: 5.3,
  flashScopeS: 5.3,
  viewerKBps: 35.6,
  viewerCorrupt: 0,
  fwdMBps: 1.107,
  recordBytesRatio: 0.98,
  j1kHz: 246.7,
  j3kHz: 41.7,
  j50k: true,
};
const SPEC = BOARD_ID === '6800evk' ? HPM6800_SPEC : BOARD_ID === '5301evklite' ? HPM5301_SPEC : {
  flashFloodS: null, flashScopeS: null, viewerKBps: null, viewerCorrupt: 0,
  fwdMBps: null, recordBytesRatio: null, j1kHz: null, j3kHz: null, j50k: true,
};

const WD = setTimeout(() => { console.log('!! 看门狗超时（25 分钟），退出'); process.exit(9); }, 25 * 60 * 1000);

/* =============================================================== 环境自愈（同 F103 那份） */
function chromeExe(){
  const cands = [path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Bin/chrome.exe'),
                 path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
                 path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
                 path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')];
  return cands.find(p => fs.existsSync(p));
}
const cdpUp = async () => { try { await (await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2000) })).json(); return true; } catch { return false; } };

function ensureAuthorizedProfile(){
  const prefPath = path.join(PROFILE, 'Default', 'Preferences');
  const src = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
  if (!fs.existsSync(prefPath)){
    console.log('   [prep] 复制授权 profile（用户 Chrome 的 Preferences）…');
    fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
    for (const f of ['Local State', 'Default/Preferences', 'Default/Secure Preferences']){
      try { fs.copyFileSync(path.join(src, f), path.join(PROFILE, f)); } catch {}
    }
  }
  let instance = '';
  try { instance = fs.readFileSync('tmp/cdc-instance.txt', 'utf8').trim(); } catch {}
  if (!instance || !fs.existsSync(prefPath)) return { instance, patched: false };
  const pref = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
  pref.profile = pref.profile || {};
  pref.profile.content_settings = pref.profile.content_settings || {};
  pref.profile.content_settings.exceptions = pref.profile.content_settings.exceptions || {};
  const exc = pref.profile.content_settings.exceptions;
  exc.serial_chooser_data = exc.serial_chooser_data || {};
  const key = ORIGIN + ',*';
  const cur = exc.serial_chooser_data[key] || { last_modified: String((Date.now() + 11644473600000) * 1000), setting: { 'chosen-objects': [] } };
  const ids = new Set((cur.setting['chosen-objects'] || []).map(o => o.device_instance_id));
  if (!ids.has(instance)){
    cur.setting['chosen-objects'] = [...(cur.setting['chosen-objects'] || []), { name: 'akaLinkPro CMSIS-DAP', device_instance_id: instance }];
    exc.serial_chooser_data[key] = cur;
    fs.writeFileSync(prefPath, JSON.stringify(pref));
    return { instance, patched: true };
  }
  return { instance, patched: false };
}
async function killBrowsers(){
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | `
    + `Where-Object { $_.CommandLine -match 'edge-rtt-tools-test|chrome-rtt-authorized' } | `
    + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; `
    + `Get-NetTCPConnection -State Listen -LocalPort 9333 -ErrorAction SilentlyContinue | `
    + `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`;
  await new Promise(res => { const c = spawn('pwsh', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); c.on('exit', res); setTimeout(res, 20000); });
  await sleep(2500);
}
async function launchAuthorized(){
  const exe = chromeExe();
  if (!exe) throw new Error('找不到 Chrome/Edge');
  await killBrowsers();
  let info = { patched: false };
  try { info = ensureAuthorizedProfile(); } catch (e){ console.log('   [prep] profile 处理失败（继续）：' + e.message); }
  console.log(`   [prep] 起浏览器：${path.basename(exe)} + 授权 profile${info.patched ? '（已补当前串口实例 ID）' : ''}`);
  spawn(exe, ['--remote-debugging-port=9333', '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--window-size=1400,950', LOCAL ? (process.env.APP || 'http://127.0.0.1:8899/index.html') : REMOTE],
    { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 60; i++){ await sleep(500); if (await cdpUp()) break; }
  if (!await cdpUp()) throw new Error('CDP 起不来：手动跑 tools/selftest/launch-browser.ps1 看看');
}
async function ensureBrowser(){
  if (await cdpUp()){
    let name = '';
    try { name = (await (await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2000) })).json()).Browser || ''; } catch {}
    if (/Edg\//.test(name)){ console.log(`   9333 上是 ${name}（不是带串口授权的 Chrome）→ 换掉它`); await launchAuthorized(); return; }
    console.log(`   浏览器已在跑：${name}`);
    return;
  }
  await launchAuthorized();
}

/* ================================================================== CDP */
class Cdp {
  constructor(){ this.seq = 0; this.pending = new Map(); this.handlers = new Map(); this.prompts = []; }
  _open(url, onMsg){
    const ws = new WebSocket(url);
    return new Promise((res, rej) => {
      ws.onopen = () => res(ws);
      ws.onerror = () => rej(new Error('CDP 连不上：' + url));
      ws.onmessage = ev => onMsg(ws, JSON.parse(ev.data));
    });
  }
  _dispatch(ws, m){
    if (m.id && this.pending.has(m.id)){
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === 'DeviceAccess.deviceRequestPrompted') this.prompts.push(m.params);
    const hs = this.handlers.get(m.method);
    if (hs) for (const h of hs) h(m.params);
  }
  async connect(){
    let ver = null;
    try { ver = await (await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(3000) })).json(); }
    catch { throw new Error(`连不上 CDP 浏览器（${CDP}）—— 跑 \`make hw-campaign-hpm\` 会自己拉起`); }
    this.browserWs = await this._open(ver.webSocketDebuggerUrl, (ws, m) => this._dispatch(ws, m));
    let page = null;
    for (let i = 0; i < 40 && !page; i++){
      const list = await (await fetch(CDP + '/json/list')).json();
      page = list.find(t => t.type === 'page' && (LOCAL ? t.url.includes('8899') : t.url.includes('minichao9901')))
          || list.find(t => t.type === 'page' && t.url.startsWith('http'));
      if (!page) await sleep(400);
    }
    if (!page) throw new Error('没有可用的页面目标');
    this.ws = await this._open(page.webSocketDebuggerUrl, (ws, m) => this._dispatch(ws, m));
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    try { await this.send('Network.enable'); await this.send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
    this.on('Page.javascriptDialogOpening', () => { this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    return this;
  }
  send(method, params = {}){ return this._call(this.ws, method, params); }
  sendBrowser(method, params = {}){ return this._call(this.browserWs, method, params); }
  _call(ws, method, params){
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`CDP ${method} 超时`)); }, 60000);
    });
  }
  on(m, fn){ if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); }
  async eval(expr, userGesture = false){
    const r = await this.send('Runtime.evaluate', { expression: expr, userGesture, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  }
  async evalJson(expr){ return JSON.parse(await this.eval(`(async()=>JSON.stringify(await (${expr})))()`)); }
  async waitFor(expr, timeout = 15000, label = expr){
    const t0 = Date.now();
    for (;;){
      await pump();
      let v = false;
      try { v = await this.eval(`!!(${expr})`); } catch {}
      if (v) return true;
      if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
      await sleep(150);
    }
  }
}

let cdp = null;
async function pump(){
  if (!cdp?.prompts?.length) return;
  const p = cdp.prompts.shift();
  const dev = p.devices.find(d => /akaLink|DAP|CMSIS|MicroLink|串行|Serial/i.test(d.name)) || p.devices[0];
  if (!dev) return;
  await cdp.sendBrowser('DeviceAccess.selectPrompt', { id: p.id, deviceId: dev.id }).catch(() => {});
  console.log(`   [授权框] 选中：${dev.name}`);
}
async function nap(ms){
  const t0 = Date.now();
  for (;;){ await pump(); const left = ms - (Date.now() - t0); if (left <= 0) return; await sleep(Math.min(200, left)); }
}

/* ================================================================= 判决/记录 */
let pass = 0, fail = 0;
const measured = {};          // 记录模式里攒实测值，末尾算 80%
function judge(name, key, ok, detail = '', raw = null){
  if (raw != null) measured[key] = raw;
  if (RECORD_ONLY || SPEC[key] == null){
    console.log(`   📝 记录  ${name} —— ${detail}`);
    return;
  }
  if (ok){ pass++; console.log(`   ✅ 判决 PASS  ${name} —— ${detail}`); }
  else {
    fail++;
    console.log(`   ❌ 判决 FAIL  ${name} —— ${detail}（spec：${SPEC[key]}）`);
    if (!KEEP_GOING) throw new Error(`判决未通过：${name}（${detail}）`);
  }
}

/* ================================================================== 主流程 */
await ensureBrowser();
cdp = await new Cdp().connect();
console.log(`== ${BOARD.label} 场景基准 ==  ${LOCAL ? '本地' : '线上'}页面 ${APP.split('?')[0]}  芯片 ${CHIP}`);
console.log(`   口径：烧 flood → RTT Viewer（RISC-V 新通路，判决）→ RTT 转发（判决+10s 存盘）→ 烧 scope → J-Scope 1/3 变量；重复 ${CYCLES} 轮 + 交替 ${ALT} 遍`);
console.log(RECORD_ONLY || SPEC.fwdMBps == null ? '   模式：**只记录不判决**（跑完给出"实测 × 80%"的 spec 建议）' : '   模式：按 SPEC 判决');

await cdp.send('Page.navigate', { url: APP });
await cdp.waitFor('window.__tools?.flash && window.__tools?.hid && window.__tools?.stream', 25000, '页面模块加载');

const report = { startedAt: new Date().toISOString(), board: CHIP, app: APP, cycles: [], alt: [], errors: [], spec: SPEC };
const dump = () => { try { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); } catch {} };

/** 开跑前校准：芯片 = HPM6800EVK、后端 webusb、**目标类型 = RISC-V**、SWD 时钟清 0 */
async function preflight(){
  /**
   * 🚨 先把测试页拉到前台（2026-10 现场踩到）：窗口被遮住/最小化时
   *    `document.hidden === true`，浏览器会把**短延时钳到 ≥1 s**、把 File System Access
   *    的写盘降到几十 KB/s —— 转发/存盘那一相会积压到把渲染进程顶住（现象是 CDP
   *    `Runtime.evaluate` 直接超时、页面像死了）。bringToFront 是零成本的保险。
   */
  try { await cdp.send('Page.bringToFront'); } catch {}
  const st = await cdp.evalJson(`(()=>{
    document.querySelector('.tab[data-tab="flash"]').click();
    const c = document.getElementById('f-chip'); const chipBefore = c.value;
    c.value = ${JSON.stringify(CHIP)}; c.dispatchEvent(new Event('change'));
    const b = document.getElementById('f-backend'); b.value = 'webusb'; b.dispatchEvent(new Event('change'));
    const v = document.getElementById('f-verify'); if (v) v.checked = true;
    const r = document.getElementById('f-reset'); if (r) r.checked = true;
    // 目标类型：桥与波形页都要 RISC-V/JTAG
    const t = document.getElementById('h-target'); const tBefore = t.value;
    if ([...t.options].some(o => o.value === 'riscv')){ t.value = 'riscv'; t.dispatchEvent(new Event('change')); }
    const sc = document.getElementById('sc-target'); const scBefore = sc ? sc.value : null;
    if (sc && [...sc.options].some(o => o.value === 'riscv')){ sc.value = 'riscv'; sc.dispatchEvent(new Event('change')); }
    // SWD 时钟在 JTAG 下是 DMI idle 覆盖值：必须清 0（塞数字进去会让 RISC-V 引擎读不出内存）
    const k = document.getElementById('h-clock'); const kBefore = k.value;
    if (k){ k.value = ''; k.dispatchEvent(new Event('change')); }
    const rc = document.getElementById('r-usb-clock'); if (rc) rc.value = '0';
    const sck = document.getElementById('sc-clock'); if (sck) sck.value = '0';
    const ra = document.getElementById('r-addr'); if (ra) ra.value = '';
    return { chipBefore, chip: c.value, chipText: c.options[c.selectedIndex]?.textContent || '',
             backend: b.value, targetBefore: tBefore, target: t.value,
             vis: document.visibilityState, hidden: document.hidden, focus: document.hasFocus(),
             scBefore, sc: sc ? sc.value : null, clockBefore: kBefore, clock: k ? k.value : null };
  })()`);
  console.log(`   前置：芯片 ${st.chipBefore || '(空)'} → ${st.chip}（${st.chipText}）· 后端 ${st.backend}`
    + ` · 页面 ${st.hidden ? '后台/被遮住 ⚠（短延时会被钳到 1 s、写盘会降速）' : '前台 ✓'}（${st.vis}，focus=${st.focus}）`);
  console.log(`         目标类型：桥 ${st.targetBefore} → ${st.target} · 波形页 ${st.scBefore} → ${st.sc} · SWD 时钟 ${st.clockBefore || '(空)'} → ${st.clock === '' ? '(空/0，JTAG 下正确)' : st.clock}`);
  if (st.chip !== CHIP) throw new Error(`芯片下拉里没有 ${CHIP}`);
  if (st.target !== 'riscv') throw new Error('探针目标类型没能设成 RISC-V —— HPM 上这一步不能少');
  return st;
}

async function quietProbe(){
  await cdp.eval(`(async()=>{ const t=window.__tools;
      try{ await t.rtt.disconnect(); }catch(e){}
      try{ await t.scope.releaseProbe('切换'); }catch(e){}
      try{ await t.hid.stop(); }catch(e){}
      try{ await t.session.close(); }catch(e){}
      try{ await t.hid.dev?.close?.(); }catch(e){} })()`).catch(() => {});
  await nap(300);
}

/* ------------------------------------------------------------ 烧录（HPM 慢，超时放宽） */
async function flash(which, label){
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++){
    try { return await flashOnce(which, attempt === 1 ? label : `${label}·重试`); }
    catch (e){
      lastErr = e;
      if (!/响应回显|陈旧响应|Unable to claim|占用 USB 接口|SWD ACK|FAULT|NO ACK|超时/.test(e.message)) throw e;
      console.log(`   [烧录] ${label} 第 ${attempt} 次失败，等 3 s 重试：${e.message.split('\n')[0]}`);
      await nap(3000);
    }
  }
  throw lastErr;
}
async function flashOnce(which, label){
  await quietProbe();
  await cdp.eval(`document.querySelector('.tab[data-tab="flash"]').click()`);
  const b64 = fs.readFileSync(FW[which]).toString('base64');   // 线上取不到仓库里的固件，直接把字节喂进页面
  const f = await cdp.evalJson(`(async()=>{ const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i);
      await window.__tools.flash._onFile(new File([u], ${JSON.stringify(path.basename(FW[which]))}));
      return { name: window.__tools.flash.file.name, size: window.__tools.flash.file.size }; })()`);
  await cdp.eval(`document.getElementById('f-log').textContent='';
                  document.getElementById('f-result').textContent='—';
                  document.getElementById('f-status').textContent='空闲';`);
  const t0 = Date.now();
  await cdp.eval(`document.getElementById('f-flash').click()`, true);
  for (let i = 0; i < 80; i++){ await pump(); if (await cdp.evalJson(`!!window.__tools.flash.busy`)) break; await sleep(100); }
  let seenStatus = '';
  for (let i = 0; i < 2400; i++){                 // HPM 是 XPI flash + JTAG，慢得多（最多等 6 分钟）
    await pump();
    const busy = await cdp.evalJson(`!!window.__tools.flash.busy`);
    if (i % 8 === 0){
      const s = await cdp.evalJson(`document.getElementById('f-status').textContent`);
      if (s && !/空闲/.test(s) && !/上次烧录/.test(s)) seenStatus = s;
    }
    if (!busy) break;
    if (i % 40 === 0) console.log(`   [烧录] ${label} 进行中… 已 ${((Date.now() - t0) / 1000).toFixed(0)}s${seenStatus ? ' · ' + seenStatus.trim().slice(0, 60) : ''}`);
    await sleep(150);
  }
  const wall = Date.now() - t0;
  /**
   * 🚨 判定看**日志里的「小结」行**，不要看状态栏：
   *    · RISC-V 那条零安装通路**不写 `#f-result`**（那是 ARM 通路的结论行），只在过程里把
   *      `#f-status` 写成「烧录完成：…」，**结束时又把它翻回「空闲（上次烧录用时 …）」** —— 
   *      第一版在这里采样状态栏，于是把烧成功的判成了失败（连错两次）。
   *    · 成功一定会留一行 `小结：45.6 KB · 校验开 · 复位开 · JTAG 批次 …`（ARM 通路是「耗时小结」）。
   *    · 失败进 `#f-result`（`❌ …`）。
   */
  const st = await cdp.evalJson(`({ res: document.getElementById('f-result').textContent,
      status: document.getElementById('f-status').textContent,
      log: document.getElementById('f-log').textContent.split('\\n') })`);
  const sum = [...st.log].reverse().find(l => /小结/.test(l)) || '';
  const bad = st.res.includes('❌') || /失败|错误/.test(st.status) || /失败/.test(seenStatus);
  const okFlash = !bad && !!sum;
  console.log(`   [烧录] ${label}：${(wall / 1000).toFixed(1)}s ${okFlash ? '✅ ' + (seenStatus.trim() || st.res.trim()) : '❌ ' + st.res + ' / ' + st.status}`);
  if (sum) console.log('          ' + sum.trim());
  if (!okFlash){
    const tail = st.log.filter(Boolean).slice(-6).join('\n          ');
    throw new Error(`${label} 烧录失败：${st.res} / ${st.status} / ${seenStatus}\n          页面日志尾部：\n          ${tail}`);
  }
  return { label, fw: f.name, size: f.size, ms: wall, summary: sum.trim(), status: (seenStatus.trim() || st.res.trim()) };
}

/* ------------------------------------- 0) RTT Viewer（RISC-V/JTAG 通路，判决） */
/**
 * RTT Viewer 的 RISC-V 通路（2026-10 新加，见 `app/rtt/riscv-mem.js`）：
 * 同一个"零安装"思路，但底层换成 **HID 切 SWD+JTAG → WebUSB 的 DAP_JTAG_Sequence → DMI → SBA 读内存**。
 * 与 ARM 那条路的差别（也是本项存在的意义 —— 它是**独立于探针固件**的第二条读法）：
 *   · ARM 走 AHB-AP，RISC-V 走 SBA，同一个 RTT 环两边都能读；
 *   · 地址要自己给（HPM 的控制块在 AXI SRAM，自动扫 0x20000000 找不到），campaign 这里从 ELF 的
 *     `_SEGGER_RTT` 取；
 *   · 速率比探针固件那条转发通路低一个量级（SBA 是一个字一个字搬 + 每字两次 USB 往返），
 *     所以判决线是**它自己量出来的 × 80%**，别拿 F103 的 300 KB/s 卡它。
 */
async function rttViewerRiscv(secs, cbAddr){
  await cdp.eval(`document.querySelector('.tab[data-tab="rtt"]').click()`);
  // 基准脚本不把自动记录算进 Viewer 速率窗口：保存框/文件句柄会持有 RTT
  // manager lease，切换到转发或 scope 时还会把浏览器的文件选择流程带进来。
  await cdp.eval(`(()=>{ const a=document.getElementById('r-record-auto');
      if (a?.checked){ a.checked=false; a.dispatchEvent(new Event('change')); }
    })()`);
  await cdp.eval(`(()=>{
      const b=document.getElementById('r-backend'); b.value='webusb'; b.dispatchEvent(new Event('change'));
      const t=document.getElementById('r-target'); t.value='riscv'; t.dispatchEvent(new Event('change'));
      document.getElementById('r-addr').value = '0x' + (${cbAddr}).toString(16);
      /**
       * JTAG TCK 留「自动」：真机实测 1/5/10/20/30/45/60 MHz 下**读取耗时几乎一样**
       * （瓶颈是每条 DAP 命令的 USB 往返，不是 JTAG 时钟），内容也都对。
       * 留着上一次会话的 60 MHz 反而不可复现（F103 那轮把 rtt.clockKhz 存成了 60000）。
       */
      const k=document.getElementById('r-usb-clock'); k.value='0'; k.dispatchEvent(new Event('change'));
    })()`);
  await nap(400);
  console.log(`   [RTT Viewer] RISC-V 通路：控制块 0x${cbAddr.toString(16)}（ELF 的 _SEGGER_RTT）`);
  /**
   * 连之前先把可能残留的会话拆干净：上一次读（比如 board-check 的「读 IDCODE」、
   * 上一步烧录、或者上一轮的 J-Scope 采样）都可能还挂着**在飞的 USB 传输**，
   * 直接连的话第一笔 transferIn 会撞 "device state is in progress" / 超时，页面的自愈
   * 要花好几秒 —— 那几秒正好落在计时窗口里，会被判成 0 KB/s（实测踩到两次：
   * 第一次是 board-check 之后，第二次是上一轮 J-Scope 采样之后）。
   * `disconnect()` 是幂等的，而且它内部会把"上次会话超时"这个状态记下来，
   * 下一次认领前**先复位 USB 端口并清队列**（页面日志里能看到那两行）。
   */
  const preClean = async () => {
    /* 采样器那边也要停干净：它的 transport 在 0x83 上一直有在飞的 bulk 读，
     * 不静下来，RTT Viewer 这次的 WebUSB 会话就会被"设备状态在变"顶掉。 */
    try { await cdp.eval(`(async()=>{ const s=window.__tools.scope;
        try{ if (s.running) await s.stop('清理'); }catch(e){}
        try{ await s.transport?.stop?.(); }catch(e){} })()`); } catch {}
    try { await cdp.eval(`window.__tools.rtt.disconnect()`); } catch {}
    await nap(400);
  };
  await preClean();
  // Each throughput window starts with the same display history.
  await cdp.eval(`document.getElementById('r-clear').click()`);
  /**
   * 等**第一次轮询真的跑完**再开始计时。
   *
   * RISC-V 这条路的一次轮询 = 读控制块 + 读整段环（十几条 DAP 命令）；"running 为真"
   * 在首轮**开始**时就成立，不等它就会把启动开销算进 8 s 窗口（甚至 0 次轮询 → 0.0 KB/s）。
   *
   * 状态栏也显示成功消息，非空不代表故障。首轮 readUp 仍在进行时
   * recover()/init() 会重置 TAP，与读指针写入重叠，制造 DMI_INVALID。
   * 这里只观察；轮询停止报错或超时后，外层先断开再重连。
   */
  const waitFirstPoll = async () => {
    return await waitForFirstRttData({
      pause: nap,
      readState: () => cdp.evalJson(`({ polls: window.__tools.rtt.stats.polls, bytes: window.__tools.rtt.stats.bytes,
          running: !!window.__tools.rtt.running,
          err: document.getElementById('r-err').textContent,
          error: document.getElementById('r-err').classList.contains('err'),
          slow: !!window.__tools.rtt.probe?.health?.slow, health: window.__tools.rtt.probe?.health || null })`),
    });
  };
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++){
    await cdp.eval(`document.getElementById('r-usb-connect').click()`, true);
    try {
      await cdp.waitFor(`window.__tools.rtt.rtt`, attempt === 1 ? 25000 : 15000, 'RTT 控制块定位');
      /**
       * 🚨 "连上了但没开始轮询"也要算**连接失败**并重走整个连接流程（含上面的清场）。
       *    实测：上一轮 J-Scope 采样留下的在飞 USB 传输会让这一轮 rtt.rtt 定位成功、
       *    但轮询循环起不来（running 一直是 false）—— 这时候光等没用，必须断开重来
       *    （disconnect 会顺手复位 USB 端口 + 清队列）。
       */
      await cdp.waitFor(`window.__tools.rtt.running`, 8000, 'RTT 轮询在跑');
      const st = await waitFirstPoll();
      console.log(`   [RTT Viewer] 首轮完成（polls=${st.polls} bytes=${st.bytes}）`);
      lastErr = '';
      break;
    } catch (e){
      const st = await cdp.evalJson(`({ probe: !!window.__tools.rtt.probe, kind: window.__tools.rtt.probe?.isRiscv,
          running: !!window.__tools.rtt.running, polls: window.__tools.rtt.stats?.polls,
          health: window.__tools.rtt.probe?.health || null,
          err: document.getElementById('r-err').textContent, addr: document.getElementById('r-addr').value,
          target: document.getElementById('r-target').value })`);
      lastErr = `${e.message}（probe=${st.probe} riscv=${st.kind} running=${st.running} polls=${st.polls} 目标类型=${st.target} 地址格=${st.addr || '(空)'} 状态栏=${st.err || '—'}）`;
      console.log(`   [RTT Viewer] 第 ${attempt} 次没连上，清场后重试：${lastErr}`);
      await preClean();
      await nap(1500);
    }
  }
  if (lastErr) throw new Error('RTT Viewer（RISC-V）连不上（试了 3 次）：' + lastErr);
  // Align both snapshots with completed polls; ~32 KiB per poll otherwise
  // introduces several KiB/s of boundary quantization into an 8 s window.
  const boundary = () => cdp.evalJson(`(${waitForNextRttPoll.toString()})({
    now: () => performance.now(), pause: ms => new Promise(r => setTimeout(r, ms)),
    readState: () => ({ bytes: window.__tools.rtt.stats.bytes, polls: window.__tools.rtt.stats.polls,
      b: window.__tools.rtt.stats.bytes, p: window.__tools.rtt.stats.polls, t: performance.now(),
      running: !!window.__tools.rtt.running,
      lost: window.__tools.rtt.stats.lost, corrupt: window.__tools.rtt.stats.corrupt,
      rate: document.getElementById('r-rate').textContent, hz: document.getElementById('r-hz').textContent,
      cb: document.getElementById('r-cb').textContent, up: document.getElementById('r-up').textContent,
      err: document.getElementById('r-err').textContent })
  })`);
  const a = await boundary();
  console.log(`   [RTT Viewer] 量速率 ${secs}s…（JTAG TCK 档 ${await cdp.evalJson(`document.getElementById('r-usb-clock')?.value`)}）`);
  await nap(secs * 1000);
  const b = await boundary();
  const dt = (b.t - a.t) / 1000;
  const kbps = (b.b - a.b) / dt / 1024;
  const out = { bytesPerSec: Math.round((b.b - a.b) / dt), kbps: +kbps.toFixed(1), pollHz: +((b.p - a.p) / dt).toFixed(1),
                seconds: +dt.toFixed(1), pageRate: b.rate, cb: b.cb, up: b.up, lost: b.lost, corrupt: b.corrupt, err: b.err };
  await cdp.eval(`window.__tools.rtt.disconnect()`).catch(() => {});
  await nap(500);
  console.log(`   [RTT Viewer] ${kbps.toFixed(1)} KB/s（页面显示 ${out.pageRate} · 轮询 ${out.pollHz} Hz · 控制块 ${out.cb}`
    + ` · 溢出丢 ${out.lost} B · 错位读 ${out.corrupt}）`);
  // Retain the measurement even when the following assertion stops the cycle.
  if (report.cycles.length) report.cycles.at(-1).viewer = out;
  judge('RTT Viewer（RISC-V）速率', 'viewerKBps', SPEC.viewerKBps == null || kbps >= SPEC.viewerKBps,
    `${kbps.toFixed(1)} KB/s（轮询 ${out.pollHz} Hz）`, +kbps.toFixed(1));
  judge('RTT Viewer 无错位读', 'viewerCorrupt', SPEC.viewerCorrupt == null || out.corrupt <= SPEC.viewerCorrupt,
    `错位读 ${out.corrupt} 次 / 溢出丢 ${out.lost} B`, out.corrupt);
  return out;
}

/* ------------------------------------------- RTT 转发（RISC-V：地址要自己给） */
/**
 * 探针的"目标类型"是**探针侧粘性**状态，不是页面状态：页面下拉显示 RISC-V 不代表探针现在是
 * RISC-V（探针被复位/被别的页面重设过就回 SWD 了）。所以 HID 连上之后**必须再切一次**，
 * 让页面把 HID 0x31 action 10 真发出去。这里用 swd → riscv 来回切，保证 change 事件一定触发。
 */
async function forceRiscv(page){
  const ids = page === 'scope' ? { sel: 'sc-target' } : { sel: 'h-target' };
  const r = await cdp.evalJson(`(async()=>{ const e=document.getElementById(${JSON.stringify(ids.sel)});
      const set = v => { e.value = v; e.dispatchEvent(new Event('change')); };
      set('swd'); await new Promise(r => setTimeout(r, 250)); set('riscv');
      await new Promise(r => setTimeout(r, 600));
      return { value: e.value, hasRiscv: [...e.options].some(o => o.value === 'riscv') }; })()`);
  if (r.value !== 'riscv' || !r.hasRiscv) throw new Error(`${ids.sel} 切不到 riscv：${JSON.stringify(r)}`);
  console.log(`   [目标类型] ${ids.sel} → swd → riscv（已把 action 10 发给探针）`);
}
/** 从固件 ELF 里取 RTT 控制块地址（`_SEGGER_RTT`）—— HPM 的控制块不在 0x20000000，自动扫不到 */
function cbAddrOf(elfPath){
  const s = findSymbol(new Uint8Array(fs.readFileSync(elfPath)), '_SEGGER_RTT');
  if (!s) throw new Error(`${elfPath} 的 ELF 里没有 _SEGGER_RTT 符号`);
  return s.addr >>> 0;
}
async function rttForward(){
  const cbAddr = cbAddrOf(FW.flood);
  await quietProbe();       // 上一格（RTT Viewer）可能还占着 WebUSB 句柄，先放开
  await cdp.eval(`document.querySelector('.tab[data-tab="rttcdc"]').click()`);
  // 先把控制块地址填好（HPM 在 AXI SRAM，自动搜从 0x20000000 起扫不到）
  await cdp.eval(`(()=>{ document.getElementById('h-addr').value = '0x' + (${cbAddr}).toString(16);
                         document.getElementById('h-size').value = '0x1000'; })()`);
  console.log(`   [转发] 控制块地址取自 ELF：0x${cbAddr.toString(16)}（HPM 自动搜扫不到这个区）`);
  await cdp.eval(`document.getElementById('h-reconnect').click()`, true);
  await nap(800);
  if (!await cdp.evalJson(`!!window.__tools.hid.dev?.connected`)){
    await cdp.eval(`document.getElementById('h-connect').click()`, true);
    await nap(1500);
  }
  await cdp.waitFor(`window.__tools.hid.dev?.connected`, 15000, 'HID 探针连接');
  await forceRiscv('rtt');
  await cdp.eval(`document.getElementById('h-start').click()`, true);
  for (let i = 0; i < 3; i++){
    try { await cdp.waitFor(`window.__tools.hid.last?.running && window.__tools.hid.last?.cbAddr`, 15000, '转发已启动并找到控制块'); break; }
    catch (e){
      if (i === 2) throw new Error('转发起来了但找不到控制块（确认 h-addr 是对的）');
      console.log('   [转发] 还没找到控制块，重来一次');
      await cdp.eval(`document.getElementById('h-start').click()`, true);
      await nap(1500);
    }
  }
  const st0 = await cdp.evalJson(`({ cb: window.__tools.hid.last?.cbAddr, mhz: window.__tools.hid.last?.swdMhz,
      state: document.getElementById('h-state').textContent.slice(0, 90) })`);
  console.log(`   [转发] 探针报：控制块 0x${Number(st0.cb || 0).toString(16)} · 状态「${st0.state}」`);

  /**
   * 🚨 开 CDC 口**之前**先用「丢弃模式」把积压抽干。
   *
   * HPM 的 flood 靶子环很大（8 MB），而上一格 RTT Viewer 走 SBA 只有 ~70 KB/s ——
   * 到这一格环里已经攒满了。桥一起来就把这几 MB 以 ~6.5 MB/s 往 CDC 里灌
   * （2026-10 实测：探针侧 6.460 MB/s vs 页面 1.392 MB/s，差值全被 Windows 串口
   * 驱动的缓冲吃掉/丢掉），而页面在这个突发里要按 6.5 MB/s 处理数据 —— 实测会把
   * 渲染进程顶住：CDP `Runtime.evaluate` 直接超时、页面看着像死了（整轮编排报废）。
   *
   * 探针自带丢弃模式（HID 0x31 action 7 的 flags bit0：照常从目标环搬到 stage，
   * 但**不写 CDC**）—— 用它把积压扔掉，再切回正常模式量**稳态**速率（spec 要的就是稳态；
   * 积压是这台基准自己的编排造出来的，不该算进"转发速率"）。
   */
  console.log('   [转发] 丢弃模式抽干积压（HPM 环 8 MB，直接开会把页面顶住）…');
  const drainedA = await cdp.evalJson(`window.__tools.hid.last?.moved || 0`);
  await cdp.eval(`window.__tools.hid.dev.configure({ discard: true })`);
  await nap(4000);
  await cdp.eval(`window.__tools.hid.dev.configure({ discard: false })`);
  await nap(600);
  const drainedB = await cdp.evalJson(`window.__tools.hid.last?.moved || 0`);
  console.log(`   [转发] 丢掉 ${((drainedB - drainedA) / 1048576).toFixed(2)} MB 积压（丢弃模式 4 s；之后量的是稳态）`);

  // 页面 CDC 口（已授权 → 直接连）
  await cdp.eval(`window.__tools.stream.refreshPorts()`).catch(() => {});
  await nap(600);
  const ports = await cdp.evalJson(`(async()=>{ const S=window.__tools.session.constructor; return (await S.listPorts()).length; })()`);
  if (!ports) throw new Error('页面没有已授权的串口 —— 跑 `node tools/selftest/serial-grant.mjs`，或在页面上点「选择…」手工选一次');
  await cdp.eval(`document.getElementById('c-open').click()`, true);
  await cdp.waitFor(`window.__tools.session.isOpen`, 15000, 'CDC 串口已打开（页面侧）');
  await nap(800);

  /* 速率 */
  const a = await cdp.evalJson(`({ rx: window.__tools.stream.rxc.total, m: window.__tools.hid.last?.moved || 0, t: performance.now() })`);
  console.log(`   [转发速率] 量 ${FWD_SECS}s…`);
  await nap(FWD_SECS * 1000);
  const b = await cdp.evalJson(`({ rx: window.__tools.stream.rxc.total, m: window.__tools.hid.last?.moved || 0, t: performance.now(),
      rate: document.getElementById('c-rxrate').textContent })`);
  const dt = (b.t - a.t) / 1000;
  const rxRate = (b.rx - a.rx) / dt, probeRate = (b.m - a.m) / dt;
  const rxMB = rxRate / 1048576;
  console.log(`   [转发速率] 页面 RX ${rxMB.toFixed(3)} MB/s（页面显示 ${b.rate}）· 探针侧 ${(probeRate / 1048576).toFixed(3)} MB/s · 窗口 ${dt.toFixed(1)}s`);
  judge('RTT 转发速率', 'fwdMBps', SPEC.fwdMBps == null || rxMB >= SPEC.fwdMBps,
    `${rxMB.toFixed(3)} MB/s（探针侧 ${(probeRate / 1048576).toFixed(3)}）`, +rxMB.toFixed(3));
  report.fwdRateMBs = (report.fwdRateMBs || []).concat(+rxMB.toFixed(3));

  /* 10 s 存盘（页面「记录到文件」→ OPFS → 导出核对） */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const savePath = `tmp/hpm-forward-${stamp}.bin`;
  await cdp.eval(`(async()=>{
    window.__recStat = { writes: 0, bytes: 0, name: '' };
    const root = await navigator.storage.getDirectory();
    window.showSaveFilePicker = async () => {
      const name = 'hpm-' + Date.now() + '.bin'; window.__recStat.name = name;
      const fh = await root.getFileHandle(name, { create: true });
      const orig = fh.createWritable.bind(fh);
      fh.createWritable = async (o) => { const w = await orig(o); const wo = w.write.bind(w);
        w.write = async (c) => { const n = c?.length ?? c?.byteLength ?? 0; const r = await wo(c); window.__recStat.writes++; window.__recStat.bytes += n; return r; };
        return w; };
      return fh;
    };
    return 'stub';
  })()`);
  await cdp.eval(`document.getElementById('c-record-ts').checked = false`);
  const r0 = await cdp.evalJson(`({ rx: window.__tools.stream.rxc.total, t: performance.now() })`);
  await cdp.eval(`document.getElementById('c-record').click()`, true);
  await cdp.waitFor(`window.__tools.stream.rec.active`, 8000, '记录已开始');
  console.log(`   [存盘] 记录 ${REC_SECS}s…`);
  await nap(REC_SECS * 1000);
  const mid = await cdp.evalJson(`({ pushed: window.__tools.stream.rec.pushed, written: window.__tools.stream.rec.written,
      backlog: window.__tools.stream.rec.backlog(), rx: window.__tools.stream.rxc.total, t: performance.now(),
      btn: document.getElementById('c-record').textContent })`);
  await cdp.eval(`document.getElementById('c-record').click()`, true);
  await cdp.waitFor(`!window.__tools.stream.rec.active && !window.__tools.stream.rec.draining`, 180000, '记录落盘完成');
  const recDt = (mid.t - r0.t) / 1000, recRx = mid.rx - r0.rx;
  const fileInfo = await cdp.evalJson(`(async()=>{ const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(window.__recStat.name); const f = await fh.getFile();
      const head = await f.slice(0, 4096).text();
      return { size: f.size, head: head.slice(0, 60).replace(/\\s+/g, ' '), words: (head.match(/hello world!/g) || []).length,
               writes: window.__recStat.writes }; })()`);
  const CH = 1024 * 1024;
  const bufs = [];
  for (let off = 0; off < fileInfo.size; off += CH){
    const b64 = await cdp.eval(`(async()=>{ const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(window.__recStat.name); const f = await fh.getFile();
        const buf = new Uint8Array(await f.slice(${off}, ${Math.min(off + CH, fileInfo.size)}).arrayBuffer());
        let s = ''; const C = 0x8000;
        for (let i = 0; i < buf.length; i += C) s += String.fromCharCode.apply(null, buf.subarray(i, i + C));
        return btoa(s); })()`);
    bufs.push(Buffer.from(b64, 'base64'));
  }
  fs.writeFileSync(savePath, Buffer.concat(bufs));
  const ratio = fileInfo.size / Math.max(1, recRx);
  const fin = await cdp.evalJson(`({ err: window.__tools.stream.rec.error ? String(window.__tools.stream.rec.error) : '',
      name: window.__tools.stream.rec.name, written: window.__tools.stream.rec.written, pushed: window.__tools.stream.rec.pushed })`);
  console.log(`   [存盘] 记录 ${recDt.toFixed(1)}s（页面收 ${(recRx / 1048576).toFixed(2)} MB）→ 文件 ${(fileInfo.size / 1048576).toFixed(2)} MB`
    + ` · write ${fileInfo.writes} 次 · 积压 ${(mid.backlog / 1024).toFixed(0)} KB · 导出 ${savePath}`);
  /**
   * 🚨 落盘是"**先写 .crswap、close() 时才改名**"：close 没落地时正式文件就是 0 字节。
   *    这里必须当成**硬失败**抛出来（第一版就这么白跑过一轮：10 秒 13.98 MB 的记录被记成 0.00 MB）。
   */
  if (fin.err) throw new Error(`记录落盘报错：${fin.err}（已写 ${fin.written} / 共 ${fin.pushed} B，文件「${fin.name}」）`);
  if (!(fileInfo.size > 0)) throw new Error(`落盘后文件是 0 字节（记录 ${(recRx / 1048576).toFixed(2)} MB、已写 ${fin.written} B）`
    + ` —— .crswap 没被改成正式文件；recorder 的 draining/close 顺序不对就会这样`);
  judge('存盘字节一致性', 'recordBytesRatio', ratio >= (SPEC.recordBytesRatio ?? 0.98), `文件/收数 = ${(ratio * 100).toFixed(1)}%`, +ratio.toFixed(4));
  judge('存盘内容可读', 'recordWords', fileInfo.words > 10, `头 4 KB 有 ${fileInfo.words} 个 hello world!`, fileInfo.words);
  judge('记录无积压', 'recordBacklogKB', mid.backlog < 4 * 1024 * 1024, `积压 ${(mid.backlog / 1024).toFixed(0)} KB`, Math.round(mid.backlog / 1024));

  await cdp.eval(`window.__tools.session.close()`).catch(() => {});
  await cdp.eval(`document.getElementById('h-stop').click()`, true).catch(() => {});
  await nap(500);
  return { cbAddr: '0x' + cbAddr.toString(16), rateMB: rxMB, probeRateMB: probeRate / 1048576, seconds: +dt.toFixed(1),
           record: { seconds: +recDt.toFixed(1), rxBytes: recRx, fileBytes: fileInfo.size, ratio: +ratio.toFixed(4),
                     backlogKB: Math.round(mid.backlog / 1024), path: savePath, words: fileInfo.words } };
}

/* ------------------------------------------------------------ J-Scope（RISC-V） */
async function scopeConnect(){
  await cdp.eval(`(async()=>{ try{ await window.__tools.hid.stop(); }catch(e){}
                              try{ await window.__tools.hid.dev?.close?.(); }catch(e){} })()`).catch(() => {});
  await nap(300);
  await cdp.eval(`(async()=>{ const s=window.__tools.scope; if (!s.hid) await s.connectHid(false); })()`);
  if (!await cdp.evalJson(`!!window.__tools.scope.hid`)){
    await cdp.eval(`document.getElementById('sc-connect').click()`, true);
    await nap(2000);
  }
  await cdp.eval(`(async()=>{ const s=window.__tools.scope; if (!s.transport) await s.connectUsb(false); })()`);
  if (!await cdp.evalJson(`!!window.__tools.scope.transport`)){
    await cdp.eval(`document.getElementById('sc-usb').click()`, true);
    await nap(2000);
  }
  const conn = { hid: await cdp.evalJson(`!!window.__tools.scope.hid`), usb: await cdp.evalJson(`!!window.__tools.scope.transport`) };
  if (conn.hid) await forceRiscv('scope');      // 采样器后端 = 探针粘性目标类型，连上后必须再切一次
  return conn;
}
async function scopeEnsureElf(){
  const cached = await cdp.evalJson(`(window.__tools.scope.all || []).length`);
  if (cached) return { cached: true, n: cached };
  const b64 = fs.readFileSync(FW.scope).toString('base64');
  const r = await cdp.evalJson(`(async()=>{ const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i);
      await window.__tools.scope.loadElfFile(new File([u], 'fw.elf'));
      return { cached: false, n: (window.__tools.scope.all || []).length }; })()`);
  if (!r.n) throw new Error('scope 固件里没解析出变量（ELF 载入失败？）');
  return r;
}
async function scopeRun({ idxs, periodUs, secs, label, specKey, judgeResult = true }){
  await cdp.eval(`document.querySelector('.tab[data-tab="scope"]').click()`);
  const conn = await scopeConnect();
  if (!conn.hid || !conn.usb) throw new Error(`J-Scope 链路没连上（hid=${conn.hid} usb=${conn.usb}）`);
  const sel = await cdp.evalJson(`(()=>{ const s=window.__tools.scope; s.selected=[];
      for (const i of ${JSON.stringify(idxs)}) s.toggleVar(s.all[i], true);
      document.getElementById('sc-period').value = String(${periodUs});
      document.getElementById('sc-seconds').value = String(${secs});
      s.updatePlan();
      return { vars: s.selected.map(v => v.name + '@0x' + v.addr.toString(16)), spans: s.plan.spans.length,
               frameBytes: s.plan.frameBytes, estUs: +s.plan.estUs.toFixed(2), estHz: s.plan.estHz }; })()`);
  const startedAt = Date.now();
  await cdp.eval(`window.__tools.scope.start()`);
  let autoStopped = false;
  for (let i = 0; i < (secs + 15) * 5; i++){
    await pump();
    const st = await cdp.evalJson(`({ running: !!window.__tools.scope.running, count: window.__tools.scope.store?.count || 0,
        state: String(window.__tools.scope.state || ''), err: document.getElementById('sc-err').textContent })`);
    if (!st.running && st.count > 0){ autoStopped = true; break; }
    if (!st.running && i > 8 && (/失败|错误|没连|先选|先连/.test(st.state) || st.err)) throw new Error(`J-Scope 起不来：${st.state} ${st.err}`);
    await sleep(200);
  }
  if (!autoStopped) await cdp.eval(`window.__tools.scope.stop('测试收尾')`).catch(() => {});
  await nap(400);
  const sum = await cdp.evalJson(`window.__tools.scope.summary()`);
  const out = { label, periodUs, wantHz: Math.round(1e6 / periodUs), vars: sel.vars, spans: sel.spans, frameBytes: sel.frameBytes,
                samples: sum.samples, rateHz: sum.rateHz, lostProbe: sum.lostProbe, lostUsb: sum.lostUsb, lostGap: sum.lostGap,
                state: sum.state, autoStopped, elapsedMs: Date.now() - startedAt };
  const kHz = out.rateHz / 1000;
  console.log(`   [J-Scope] ${label}：${sel.vars.length} 变量 ${sel.spans} span/${sel.frameBytes}B · 实测 ${kHz.toFixed(2)} kHz`
    + `（名义 ${(out.wantHz / 1000).toFixed(1)} kHz）· ${out.samples} 样本 · 丢：探针 ${out.lostProbe}/USB ${out.lostUsb}/缺口 ${out.lostGap}`);
  if (judgeResult){
    if (specKey) judge(`J-Scope ${label}`, specKey, SPEC[specKey] == null || kHz >= SPEC[specKey], `${kHz.toFixed(2)} kHz`, +kHz.toFixed(2));
    else judge(`J-Scope ${label} 零丢样本`, 'j50k', out.lostProbe === 0 && out.lostUsb === 0, `探针 ${out.lostProbe}/USB ${out.lostUsb}/缺口 ${out.lostGap}`, out.lostProbe + out.lostUsb);
  }
  await cdp.eval(`window.__tools.scope.stop('下一步')`).catch(() => {});
  await nap(400);
  return out;
}
/**
 * 选变量：**只挑非缓存区那份**。
 *
 * HPM 这块 scope 固件故意放了两份数据做对照（见它 main.c 头注释）：
 *   · `g_v` / `g_updates`  —— 非缓存 AXI SRAM（0x01240000+），SBA 直读拿到的就是真值 ✓
 *   · `g_v_cached` / `g_updates_cached` —— 可缓存区且**从不写回**，SBA 读回来是陈旧值 ✗
 * 挑错了现象是"波形一条平线、速率照样对"—— 速率判决看不出问题，所以这里硬排除 `*_cached`。
 * 1 变量 = `g_v.tick`（10 kHz 时基）；3 变量 = 结构体里地址相邻的成员（能合并成 1 个 span，
 * 与 hpm6800evk_scope/README.md 里 8 变量/32 B 那组口径对得上）。
 */
function chooseVars(meta){
  const scalar = meta.filter(v => v.scalar && !/_cached$/i.test(v.name));
  const members = scalar.filter(v => /^g_v\./.test(v.name)).sort((a, b) => a.addr - b.addr);
  if (members.length >= 3){
    const one = members.find(v => /\.tick$/i.test(v.name)) || members[0];
    const three = [one, ...members.filter(v => v.i !== one.i)].slice(0, 3);
    return { one: [one.i], three: three.map(v => v.i), oneName: one.name, threeNames: three.map(v => v.name), from: 'g_v 结构体成员' };
  }
  const top = scalar.filter(v => !v.name.includes('.'));
  const pool = top.length >= 3 ? top : scalar;
  if (!pool.length) throw new Error('scope 固件里没解析出可采的标量变量');
  const one = pool.find(v => /g_updates|g_tick|g_lfsr|u_ramp/i.test(v.name)) || pool[0];
  const three = [one];
  for (const v of pool){ if (three.length >= 3) break; if (v.i !== one.i && v.addr !== one.addr) three.push(v); }
  return { one: [one.i], three: three.map(v => v.i), oneName: one.name, threeNames: three.map(v => v.name), from: '顶层标量' };
}

function writeScopeMatrix(rows, info){
  const totalLost = r => r.lostProbe + r.lostUsb + r.lostGap;
  const denominator = r => Math.max(1, r.samples + totalLost(r));
  for (const r of rows){
    r.probeDropPct = +(100 * r.lostProbe / denominator(r)).toFixed(4);
    r.usbDropPct = +(100 * r.lostUsb / denominator(r)).toFixed(4);
    r.sequenceGapPct = +(100 * r.lostGap / denominator(r)).toFixed(4);
    r.totalLossPct = +(100 * totalLost(r) / denominator(r)).toFixed(4);
  }
  const output = path.resolve(MATRIX_PATH);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ...info, results: rows }, null, 2));
  const csvPath = output.replace(/\.json$/i, '.csv');
  const columns = ['periodUs','wantHz','varsCount','frameBytes','spans','samples','rateHz','lostProbe','lostUsb','lostGap','probeDropPct','usbDropPct','sequenceGapPct','totalLossPct','elapsedMs'];
  const csv = [columns.join(','), ...rows.map(r => [r.periodUs,r.wantHz,r.vars.length,r.frameBytes,r.spans,r.samples,r.rateHz,r.lostProbe,r.lostUsb,r.lostGap,r.probeDropPct,r.usbDropPct,r.sequenceGapPct,r.totalLossPct,r.elapsedMs].join(','))].join('\n') + '\n';
  fs.writeFileSync(csvPath, csv);
  console.log(`   J-Scope 矩阵已保存：${output} 和 ${csvPath}`);
}

/* ================================================================== 跑起来 */
try {
  await preflight();
  for (let c = 1; c <= CYCLES; c++){
    console.log(`\n========== 第 ${c}/${CYCLES} 轮 ==========`);
    const rec = { cycle: c };
    report.cycles.push(rec); // Preserve completed stages if a later stage fails.
    rec.flashFlood = await flash('flood', `flood #${c}`);
    judge('烧 flood 固件耗时', 'flashFloodS', SPEC.flashFloodS == null || rec.flashFlood.ms / 1000 <= SPEC.flashFloodS,
      `${(rec.flashFlood.ms / 1000).toFixed(1)} s`, +(rec.flashFlood.ms / 1000).toFixed(1));
    rec.cbAddr = cbAddrOf(FW.flood);
    rec.viewer = await rttViewerRiscv(VIEWER_SECS, rec.cbAddr);
    rec.fwd = await rttForward();
    rec.flashScope = await flash('scope', `scope #${c}`);
    judge('烧 scope 固件耗时', 'flashScopeS', SPEC.flashScopeS == null || rec.flashScope.ms / 1000 <= SPEC.flashScopeS,
      `${(rec.flashScope.ms / 1000).toFixed(1)} s`, +(rec.flashScope.ms / 1000).toFixed(1));
    rec.elf = await scopeEnsureElf();
    const meta = await cdp.evalJson(`window.__tools.scope.all.map((v, i) => ({ i, name: v.name, addr: v.addr, scalar: v.scalar }))`);
    if (c === 1){
      const named = meta.filter(v => v.scalar).slice(0, 40).map(v => `${v.name}@0x${v.addr.toString(16)}`);
      console.log(`   ELF 里 ${meta.length} 个变量（标量 ${meta.filter(v => v.scalar).length}），前 40：${named.join(' ')}`);
    }
    const picks = chooseVars(meta);
    console.log(`   变量（来源 ${picks.from}）：1 个 = ${picks.oneName}；3 个 = ${picks.threeNames.join(', ')}`);
    rec.picks = picks;
    rec.j1 = await scopeRun({ idxs: picks.one, periodUs: 2, secs: SCOPE_SECS, label: '1 变量 @2µs', specKey: 'j1kHz' });
    rec.j3 = await scopeRun({ idxs: picks.three, periodUs: 2, secs: SCOPE_SECS, label: '3 变量 @2µs', specKey: 'j3kHz' });
    rec.j50k1 = await scopeRun({ idxs: picks.one, periodUs: 20, secs: SCOPE_SECS, label: '1 变量 @20µs' });
    /**
     * 3 变量那只用 **30 µs**（= 33 kHz），不是 20 µs。
     *
     * 🚨 原因（2026-10 真机实测，别改回去）：HPM 这条 RISC-V/SBA 通路上，
     *    3 个相邻成员合成 **1 个 span / 12 B** 的读循环实测 **~24.3 µs**（@2µs 名义跑出
     *    40.64 kHz、@20µs 名义跑出 41.13 kHz，两处一致 ⇒ 就是能力上限 ~41 kHz）。
     *    20 µs 的周期**低于**这个上限，探针只能每拍跳一次（3 s 里丢 26182 拍），
     *    那是"请求超过了能力"，不是丢包/回归 —— 而 USB 丢样本与 seq 缺口都是 0。
     *    要判"低速率档不许跳拍"，就得挑设备**跑得住**的周期：30 µs 有 ~20% 余量。
     *    （F103 那边 3 变量 @20µs 能跑（60 MHz 档 3 span 也有 ~60 kHz 能力），所以那边不用改。）
     */
    rec.j50k3 = await scopeRun({ idxs: picks.three, periodUs: 30, secs: SCOPE_SECS, label: '3 变量 @30µs' });
    if (SCOPE_MATRIX){
      const members = meta.filter(v => v.scalar && /^g_v\./.test(v.name) && !/_cached$/i.test(v.name)).sort((a, b) => a.addr - b.addr);
      if (members.length < Math.max(...MATRIX_COUNTS)) throw new Error(`J-Scope 矩阵需要 ${Math.max(...MATRIX_COUNTS)} 个连续标量变量，ELF 只有 ${members.length}`);
      console.log(`\n========== J-Scope 跳拍矩阵：${MATRIX_COUNTS.join('/')} 个变量 × ${MATRIX_PERIODS.join('/')} µs × ${MATRIX_SECONDS}s ==========`);
      rec.scopeMatrix = [];
      for (const count of MATRIX_COUNTS){
        const idxs = members.slice(0, count).map(v => v.i);
        for (const periodUs of MATRIX_PERIODS){
          const cell = await scopeRun({ idxs, periodUs, secs: MATRIX_SECONDS, label: `${count}变量 @${periodUs}µs`, judgeResult: false });
          rec.scopeMatrix.push(cell);
          writeScopeMatrix(rec.scopeMatrix, {
            schema: 1, board: CHIP, firmware: path.relative(process.cwd(), FW.scope).replaceAll('\\','/'),
            elfSha256: createHash('sha256').update(fs.readFileSync(FW.scope)).digest('hex'),
            startedAt: report.startedAt, updatedAt: new Date().toISOString(),
            method: '页面 J-Scope summary；总丢失率=(probe+USB+序号缺口)/(录制样本+三类丢失)，各类按同一分母计算。',
            requestedPeriodsUs: MATRIX_PERIODS, requestedVariableCounts: MATRIX_COUNTS, durationSeconds: MATRIX_SECONDS,
          });
        }
      }
    }
    dump();
  }

  console.log(`\n========== 4) flood ↔ scope 交替烧录 ${ALT} 遍 ==========`);
  for (let i = 1; i <= ALT; i++){
    const a = await flash('flood', `交替#${i} flood`);
    const b = await flash('scope', `交替#${i} scope`);
    report.alt.push({ i, floodMs: a.ms, scopeMs: b.ms });
    console.log(`   第 ${i} 遍：flood ${(a.ms / 1000).toFixed(1)}s · scope ${(b.ms / 1000).toFixed(1)}s`);
    dump();
  }
} catch (e){
  console.log('\n!! 出错，立刻停：' + (e?.message || e));
  report.errors.push(String(e?.message || e));
}

// 无论哪一步失败，都先把页面里的 RTT、Scope、HID 和会话句柄收回；这样同一条
// `make full_flow_6800evk` 在下一阶段烧调试固件时不会继承半开的 RISC-V 传输。
await quietProbe();

/* ================================================================== 汇总 */
/**
 * 先逐轮列明细，最后打一张**小结表**（与 F103 那份口径一致的表格，方便直接贴进 issue/README）。
 * 表格实现在 `campaign-summary.mjs`：事后也能对着 `tmp/hpm-campaign-result.json` 单独重打，
 * 不用再跑一遍硬件。
 */
console.log('\n================ 汇总 ================');
for (const r of report.cycles){
  if (!r.viewer || !r.fwd || !r.j1 || !r.j3 || !r.j50k1 || !r.j50k3){
    console.log(`第 ${r.cycle} 轮未完成；已完成项目见下表，失败原因见错误列表。`);
    continue;
  }
  console.log(`第 ${r.cycle} 轮：烧 flood ${(r.flashFlood.ms / 1000).toFixed(1)}s → RTT Viewer ${(r.viewer?.kbps ?? 0).toFixed(1)} KB/s`
    + ` → 转发 ${r.fwd.rateMB.toFixed(3)} MB/s（探针侧 ${r.fwd.probeRateMB.toFixed(3)}）`
    + ` → 存盘 ${(r.fwd.record.fileBytes / 1048576).toFixed(2)} MB/${r.fwd.record.seconds}s`
    + `（一致性 ${(r.fwd.record.ratio * 100).toFixed(1)}%）→ 烧 scope ${(r.flashScope.ms / 1000).toFixed(1)}s`);
  console.log(`        J-Scope：1 变量 ${(r.j1.rateHz / 1000).toFixed(2)} kHz · 3 变量 ${(r.j3.rateHz / 1000).toFixed(2)} kHz`
    + ` · 低速率档丢样本 探针 ${r.j50k1.lostProbe + r.j50k3.lostProbe}/USB ${r.j50k1.lostUsb + r.j50k3.lostUsb}`
    + `（1 变量@20µs ${(r.j50k1.rateHz / 1000).toFixed(2)} kHz · 3 变量@30µs ${(r.j50k3.rateHz / 1000).toFixed(2)} kHz）`);
}
if (report.alt.length){
  const f = report.alt.map(a => a.floodMs / 1000), s = report.alt.map(a => a.scopeMs / 1000);
  const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  console.log(`交替烧录：flood ${f.map(x => x.toFixed(1)).join('/')}s（均 ${avg(f)}s）· scope ${s.map(x => x.toFixed(1)).join('/')}s（均 ${avg(s)}s）`);
}

/* -------- 记录模式：把"实测 × 80%"算出来，直接抄回脚本顶部 -------- */
const avgOf = key => {
  const v = report.cycles.map(c => key(c)).filter(x => typeof x === 'number' && x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};
const m = {
  floodS: avgOf(c => c.flashFlood?.ms / 1000),
  scopeS: avgOf(c => c.flashScope?.ms / 1000),
  viewerKBps: avgOf(c => c.viewer?.kbps),
  viewerCorrupt: report.cycles.reduce((s, c) => s + (c.viewer?.corrupt || 0), 0),
  fwdMBps: avgOf(c => c.fwd?.rateMB),
  j1kHz: avgOf(c => c.j1?.rateHz / 1000),
  j3kHz: avgOf(c => c.j3?.rateHz / 1000),
  recordRatio: avgOf(c => c.fwd?.record?.ratio),
};
if (RECORD_ONLY || SPEC.fwdMBps == null || SPEC.viewerKBps == null){
  console.log('\n---------- spec 建议（实测均值 × 80%）----------');
  console.log('实测均值：' + JSON.stringify({
    烧flood秒: +m.floodS.toFixed(1), 烧scope秒: +m.scopeS.toFixed(1), ViewerKBps: +m.viewerKBps.toFixed(1),
    转发MBps: +m.fwdMBps.toFixed(3), J1kHz: +m.j1kHz.toFixed(1), J3kHz: +m.j3kHz.toFixed(1), 存盘一致性: +m.recordRatio.toFixed(4),
  }));
  console.log(`const SPEC = {
  flashFloodS: ${Math.max(1, m.floodS * 1.2).toFixed(1)},     // 实测均 ${m.floodS.toFixed(1)} s（耗时给 1.2× 余量）
  flashScopeS: ${Math.max(1, m.scopeS * 1.2).toFixed(1)},     // 实测均 ${m.scopeS.toFixed(1)} s
  viewerKBps: ${(m.viewerKBps * 0.8).toFixed(1)},                   // RTT Viewer（RISC-V）：实测均 ${m.viewerKBps.toFixed(1)} KB/s × 80%
  viewerCorrupt: 0,                  // 实测共 ${m.viewerCorrupt} 次错位读
  fwdMBps: ${(m.fwdMBps * 0.8).toFixed(3)},                   // 实测均 ${m.fwdMBps.toFixed(3)} MB/s × 80%
  recordBytesRatio: ${Math.max(0.9, m.recordRatio * 0.98).toFixed(3)},
  j1kHz: ${(m.j1kHz * 0.8).toFixed(1)},                       // 实测均 ${m.j1kHz.toFixed(1)} kHz × 80%
  j3kHz: ${(m.j3kHz * 0.8).toFixed(1)},                       // 实测均 ${m.j3kHz.toFixed(1)} kHz × 80%
  j50k: true,
};`);
  console.log('（把这几行抄回 tools/selftest/hw-campaign-hpm.mjs 的 SPEC 表，再跑一遍就是正式判决）');
}
dump();
printSummary({ ...report, boardLabel: `${BOARD.label}（${CHIP} / RISC-V + JTAG）` });
console.log(`\n判决：${pass} 通过 / ${fail} 失败`);
if (report.errors.length) console.log('错误：' + JSON.stringify(report.errors));
console.log('结果已写 ' + OUT);
clearTimeout(WD);
try { cdp?.ws?.close(); } catch {}
try { cdp?.browserWs?.close(); } catch {}
process.exit(fail || report.errors.length ? 1 : 0);
