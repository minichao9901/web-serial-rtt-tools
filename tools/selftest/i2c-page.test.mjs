/**
 * 「USB→I2C」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/i2c-page.test.mjs        （等价：make test-i2c-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个，见 page-prep）。
 *
 * 跑的是**真页面对象**（`window.__tools.i2c` 是本页视图），走的是**假探针**（内置
 * AT24C02/MPU6050/ADS1115/Si5351 四个假器件，传感器数据是活的）。
 * 每一步都断言"客观状态"（假器件里的内容、表格里的结果、解析出来的任务结构），不看"像不像"。
 *
 * 这里特别咬三件事：
 *   ① **表格与脚本区必须走同一套解析**（表格生成的脚本能被同一套 parser 解析、字段一致）；
 *   ② **while(1) 真的在定时跑**：实时值面板要有连续采样、曲线缓冲要长起来、停止要立刻停；
 *   ③ 排版回归：命令表的每个格子必须在 `<td>` 里（直接挂 `<tr>` 上会让整行竖着堆 —— 踩过）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const URL_ = APP + '?t=' + Date.now() + '#i2c';

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

await send('Page.enable');
await send('Runtime.enable');
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.i2c;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.i2c 不存在）');
// 🚨 自带前置：右列 tab 是**持久化的用户设置**，上一个套件（比如 i2c-hw 的"切到实时值再停"）
//    会把它留在别的 tab 上。不先清掉的话，下面"默认 tab 是扫描总线"那条会莫名其妙地红
//    （实测踩过：i2c-hw 跑完接着跑本套件，一次红两条）。
await ev(`const k='serial-rtt-tools:v1'; const st=JSON.parse(localStorage.getItem(k)||'{}');
          delete st['i2c.dock']; localStorage.setItem(k, JSON.stringify(st)); true`);
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 40; i++){
  await sleep(400);
  try { if (await ev('return !!window.__tools?.i2c;')) break; } catch {}
}
// 同样自带前置：别的页面测试会把"当前标签"留在自己那一页，不显式点一下本页可能根本没显示
// （各页测试都这么做，见 spi/scope/dbg 的 page 测试）
await ev(`document.querySelector('#tabs .tab[data-tab="i2c"]').click(); return true;`);
await sleep(200);

// ==================================================================== 1
console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(s.tabs.includes('i2c'), '标签栏里有 i2c（USB→I2C）');
  const i2cIndex = s.tabs.indexOf('i2c'), analogIndex = s.tabs.indexOf('analog'), genIndex = s.tabs.indexOf('gen');
  ok(i2cIndex >= 0 && i2cIndex < analogIndex && analogIndex < genIndex && genIndex === s.tabs.length - 1,
     `I²C、ADC/DAC、工程生成的顺序正确（${s.tabs.slice(-3).join(' → ')}）`, s.tabs.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.i2c && s.i2c.connected === false, '初始：未连接');
  ok(s.i2c.rows === 3, `命令表默认 3 行（实际 ${s.i2c?.rows}）`);
  ok(s.i2c.preset === 'quick', '默认选中「快速上手」示例');
  ok(s.i2c.dock === 'scan', '右列默认 tab 是「扫描总线」');
  const ta = await ev(`return document.getElementById('i2-dsl-text').value.slice(0, 20);`);
  ok(/快速上手/.test(ta), '脚本区载入了默认示例', ta);
  const dis = await ev(`return { scan: document.getElementById('i2-scan').disabled,
                                stop: document.getElementById('i2-run-stop').disabled,
                                pill: document.getElementById('i2-run-pill').textContent };`);
  ok(dis.scan === true, '未连接时「扫描总线」是灰的');
  ok(dis.stop === true, '没在跑时「停止」是灰的');
  ok(/未运行/.test(dis.pill), '运行胶囊初始显示「未运行」', dis.pill);
}

// ==================================================================== 1b
console.log('== 1b. 右列分 tab（照 #dbg 那套：一次只显示一个）==');
{
  const t = await ev(`
    const ids = [...document.querySelectorAll('#i2-dock-tabs button[data-dock]')].map(b => b.dataset.dock);
    const pages = [...document.querySelectorAll('#i2-box-dock .dockpage')].map(p => p.dataset.dock);
    return { ids, pages, shown: [...document.querySelectorAll('#i2-box-dock .dockpage.on')].map(p => p.dataset.dock) };`);
  ok(t.ids.join(',') === 'scan,cmd,reg,dsl,live', `五个 tab：扫描/命令表/寄存器/脚本/实时值（${t.ids.join(',')}）`, t.ids.join(','));
  ok(t.pages.join(',') === t.ids.join(','), '每个 tab 都有对应的内容块（顺序一致）');
  ok(t.shown.length === 1 && t.shown[0] === 'scan', '🚨 同时**只有一个**内容块可见', JSON.stringify(t.shown));

  const sw = await ev(`
    const click = d => document.querySelector('#i2-dock-tabs button[data-dock="' + d + '"]').click();
    const out = [];
    for (const d of ['cmd', 'dsl', 'live', 'scan']){
      click(d);
      out.push({
        d,
        on: [...document.querySelectorAll('#i2-box-dock .dockpage.on')].map(p => p.dataset.dock),
        btnOn: [...document.querySelectorAll('#i2-dock-tabs button.on')].map(b => b.dataset.dock),
        saved: (JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}') || {})['i2c.dock'],
        bodyRows: document.querySelectorAll('#i2-cmd-body tr').length,
      });
    }
    return out;`);
  for (const r of sw){
    ok(r.on.length === 1 && r.on[0] === r.d, `切到「${r.d}」：只有它显示`, JSON.stringify(r.on));
    ok(r.btnOn.length === 1 && r.btnOn[0] === r.d, `……tab 按钮也只有一个高亮`, JSON.stringify(r.btnOn));
    ok(r.saved === r.d, '……选择落进 localStorage（刷新/切页回来还在）', String(r.saved));
  }
  ok(sw.every(r => r.bodyRows === 3), '切 tab 不重建表格（3 行始终在）', JSON.stringify(sw.map(r => r.bodyRows)));

  // tab 栏那一行（胶囊 + 停止）不在任何 dockpage 里 —— 切到哪个 tab 都看得见
  const pillOutside = await ev(`
    return { inPage: !!document.querySelector('#i2-box-dock .dockpage #i2-run-pill'),
             inHeader: !!document.querySelector('#i2-box-dock > .dockhead #i2-run-pill'),
             stopInHeader: !!document.querySelector('#i2-box-dock > .dockhead #i2-run-stop') };`);
  ok(pillOutside.inHeader && !pillOutside.inPage, '运行状态在卡片内的公共工具栏，切 tab 仍可见');
  ok(pillOutside.stopInHeader === true, '「停止」按钮在卡片内的公共工具栏');
}

// ==================================================================== 2
console.log('== 2. 命令表的排版与格子联动（踩过的坑）==');
{
  await ev(`document.querySelector('#i2-dock-tabs button[data-dock="cmd"]').click(); return true;`);
  const lay = await ev(`
    const tr = document.querySelector('#i2-cmd-body tr');
    return {
      cells: tr.children.length,
      tags: [...tr.children].map(c => c.tagName),
      directInputs: [...tr.children].filter(c => c.tagName === 'INPUT' || c.tagName === 'SELECT').length,
      tops: [...tr.children].map(c => c.offsetTop),
    };`);
  ok(lay.cells === 9, `一行 9 个格子（实际 ${lay.cells}）`);
  ok(lay.tags.every(t => t === 'TD'), '🚨 每个格子都包在 <td> 里（直接挂 <tr> 上整行会竖着堆）', lay.tags.join(','));
  ok(lay.directInputs === 0, '……没有裸露的 input/select 直接挂在 <tr> 上');
  ok(new Set(lay.tops).size === 1, '……所有格子在同一行（offsetTop 一致）', JSON.stringify(lay.tops));

  const mask = await ev(`
    const t = window.__tools.i2c;
    t.rows = [{ op:'rd', dev:'0x68', addr:'0x3B', data:'', rd:'14', as:'ax=u8(0)', period:'' }];
    t._renderTable();
    const cells = t.rowEls[0].cells;
    const read = { data: cells.data.disabled, dev: cells.dev.disabled, rd: cells.rd.disabled, as: cells.as.disabled };
    t.rows[0].op = 'wr'; t._renderTable();
    const c2 = t.rowEls[0].cells;
    const write = { data: c2.data.disabled, rd: c2.rd.disabled, as: c2.as.disabled, dev: c2.dev.disabled };
    t.rows[0].op = 'delay'; t._renderTable();
    const c3 = t.rowEls[0].cells;
    const delay = { data: c3.data.disabled, dev: c3.dev.disabled, rd: c3.rd.disabled };
    return { read, write, delay };`);
  ok(mask.read.data === true && mask.read.rd === false && mask.read.as === false, '「读」：数据格灰掉、读长/解码可编辑', JSON.stringify(mask.read));
  ok(mask.write.data === false && mask.write.rd === true && mask.write.as === true, '「写」：读长/解码灰掉、数据可编辑', JSON.stringify(mask.write));
  ok(mask.delay.data === false && mask.delay.dev === true && mask.delay.rd === true, '「延时」：只有数据格（填时长）可编辑', JSON.stringify(mask.delay));
}

// ==================================================================== 3
console.log('== 3. 连接假探针 → 配置 → 使能 ==');
{
  const r = await ev(`
    const t = window.__tools.i2c;
    t.session.log = () => {};                    // 自测不刷日志 DOM（省时间）
    document.getElementById('i2-mock').checked = true;
    document.getElementById('i2-connect').click();
    await new Promise(r => setTimeout(r, 800));
    return { connected: t.session.connected, enabled: t.session.enabled,
             scl: t.session.actualSclHz, mock: t.session.usingMock,
             state: document.getElementById('i2-state').textContent,
             info: document.getElementById('i2-info').textContent,
             scanDisabled: document.getElementById('i2-scan').disabled,
             buttons: document.getElementById('i2-connect').disabled && !document.getElementById('i2-disconnect').disabled };`);
  ok(r.connected === true && r.mock === true, '假探针已连接');
  ok(r.buttons, '连接成功后连接按钮变灰，关闭探针可用');
  ok(r.enabled === true, '连上后自动使能了（探针复位后桥是未使能状态）');
  ok(r.scl === 100000, `默认档 100 kHz（实际 ${r.scl}）`);
  ok(/已使能/.test(r.state), '状态栏说清了"桥已使能"', r.state);
  ok(/假探针/.test(r.info) && /已使能/.test(r.info), '连接信息显示假探针 + 已使能', r.info);
  ok(r.scanDisabled === false, '连接后「扫描总线」可点');

  const cfg = await ev(`
    const t = window.__tools.i2c;
    document.getElementById('i2-scl').value = '400000';
    document.getElementById('i2-pullup').checked = true;
    document.getElementById('i2-retries').value = '2';
    document.getElementById('i2-cfg-set').click();
    await new Promise(r => setTimeout(r, 400));
    return { cfg: t.session.cfg, actual: document.getElementById('i2-scl-actual').textContent };`);
  ok(cfg.cfg.sclHz === 400000 && cfg.cfg.actualSclHz === 400000, '写配置 → 400 kHz 生效');
  ok(cfg.cfg.pullup === 1 && cfg.cfg.retries === 2, '内部上拉 / 重试次数也写进去了');
  ok(/400 kHz/.test(cfg.actual), '「实际生效」那一行回读了 400 kHz', cfg.actual);
}

// ==================================================================== 4
console.log('== 4. 扫描总线 ==');
{
  await ev(`
    document.getElementById('i2-scan').click();
    await new Promise(r => setTimeout(r, 900));
    return true;`);
  const s = await ev(`
    return { sum: document.getElementById('i2-scan-sum').textContent,
             rows: [...document.querySelectorAll('#i2-scan-body tr')].map(tr => tr.children[0].textContent + '|' + tr.children[1].textContent),
             addrs: window.__tools.i2c.scanAddrs.map(a => '0x' + a.toString(16)) };`);
  ok(s.addrs.join(',') === '0x48,0x50,0x60,0x68', '扫到四个假器件', s.addrs.join(','));
  ok(s.rows.length === 4, '扫描结果表 4 行');
  ok(s.rows.some(r => /0x50\|AT24Cxx/.test(r)), '0x50 被认成 AT24Cxx EEPROM', s.rows.join(' / '));
  ok(s.rows.some(r => /0x68\|MPU6050/.test(r)), '0x68 被认成 MPU6050');

  const pick = await ev(`
    document.querySelectorAll('#i2-scan-body tr')[2].querySelector('button').click();
    await new Promise(r => setTimeout(r, 120));
    return { dev: document.getElementById('i2-dev').value,
             onRows: [...document.querySelectorAll('#i2-scan-body tr')].filter(tr => tr.classList.contains('on')).length };`);
  ok(pick.dev === '0x60', '点「选用」把地址填进了选中框', pick.dev);
  ok(pick.onRows === 1, '……并且高亮了那一行');
}

// ==================================================================== 5
console.log('== 5. 命令表：跑一次性 + while(1) 定时 ==');
{
  const one = await ev(`
    const t = window.__tools.i2c;
    t.rows = [
      { op:'rd', dev:'0x68', addr:'0x75', data:'', rd:'1', as:'id=u8(0)', period:'' },
      { op:'wr', dev:'0x50', addr:'0x00', data:'A5 5A DE AD BE EF 12 34', rd:'', as:'', period:'' },
      { op:'rd', dev:'', addr:'', data:'', rd:'', as:'', period:'' },          // 空器件 → 跳过
    ];
    t.results.clear(); t._renderTable();
    document.getElementById('i2-cmd-send').click();
    await new Promise(r => setTimeout(r, 1200));
    const res = [...document.querySelectorAll('#i2-cmd-body td.res')].map(td => td.textContent);
    const mem = t.session.hid.devices.get(0x50).mem;
    return { res, mem: [...mem.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join(' ') };`);
  ok(/68/.test(one.res[0]) && /id=104/.test(one.res[0]), '第 1 行读 WHO_AM_I → 68 且解出 id=104', one.res[0]);
  ok(/无数据/.test(one.res[1]), '第 2 行是写（没有回读数据）', one.res[1]);
  ok(/跳过/.test(one.res[2]), '空器件格的那一行被跳过并写明原因', one.res[2]);
  ok(one.mem === 'a5 5a de ad be ef 12 34', '🚨 写真的落到假器件里了（逐字节对得上）', one.mem);

  // 定时：把第 2 行换成 50ms 的读，跑起来看实时值
  const timed = await ev(`
    const t = window.__tools.i2c;
    t.rows = [
      { op:'rd', dev:'0x68', addr:'0x75', data:'', rd:'1', as:'id=u8(0)', period:'' },
      { op:'rd', dev:'0x68', addr:'0x3B', data:'', rd:'14', as:'ax=i16be(0)/16384, az=i16be(4)/16384', period:'50ms' },
      { op:'delay', dev:'—', addr:'', data:'5ms', rd:'', as:'', period:'' },
    ];
    t.results.clear(); t._renderTable();
    document.getElementById('i2-cmd-run').click();
    await new Promise(r => setTimeout(r, 1600));
    const running = t.runner.running;
    const pill = document.getElementById('i2-run-pill').textContent;
    const stopDis = document.getElementById('i2-run-stop').disabled;
    // 🚨 tab 化之后的关键一条：切到别的 tab，定时任务**不能**被打断、胶囊也要还在
    document.querySelector('#i2-dock-tabs button[data-dock="live"]').click();
    await new Promise(r => setTimeout(r, 500));
    const stillRunning = t.runner.running;
    const pillAfterSwitch = document.getElementById('i2-run-pill').textContent;
    const live = t.live.get('ax');
    const snap = { running, pill, stopDis, stillRunning, pillAfterSwitch, vars: [...t.live.keys()],
                   n: live ? live.n : 0, buf: live ? live.buf.length : 0, last: live ? live.last : null };
    // 从胶囊旁边的「停止」停（不是命令表里那个按钮 —— 已经没有了）
    document.getElementById('i2-run-stop').click();
    await new Promise(r => setTimeout(r, 500));
    return { ...snap, afterStop: t.runner.running, pillAfterStop: document.getElementById('i2-run-pill').textContent,
             res1: document.querySelectorAll('#i2-cmd-body td.res')[1].textContent };`);
  ok(timed.running === true, 'while(1) 跑起来了');
  ok(/运行中/.test(timed.pill) && /拍/.test(timed.pill), '运行胶囊显示「运行中 · N 拍」', timed.pill);
  ok(timed.stopDis === false, '……并且「停止」按钮变成可点');
  ok(timed.stillRunning === true, '🚨 切到「实时值」tab 后定时任务仍在跑（tab 化不打断执行）');
  ok(/运行中/.test(timed.pillAfterSwitch), '……胶囊在别的 tab 上照样看得到', timed.pillAfterSwitch);
  ok(timed.vars.includes('ax') && timed.vars.includes('az'), '实时值里有 ax / az 两个变量', timed.vars.join(','));
  ok(timed.n >= 20, `1.6 s 内按 50 ms 采了 ${timed.n} 次（应当 ≥20）`);
  ok(timed.buf === timed.n, '曲线缓冲跟采样次数同步长起来', String(timed.buf));
  ok(timed.last !== null && Number.isFinite(timed.last), 'ax 有实际数值', String(timed.last));
  ok(timed.afterStop === false, '点 tab 栏的「停止」后不再跑');
  ok(/已结束/.test(timed.pillAfterStop), '……胶囊转成「已结束」', timed.pillAfterStop);
  ok(/⟳/.test(timed.res1) && /实测/.test(timed.res1), '结果列显示了实测周期（定时行的拍数）', timed.res1);

  const liveDom = await ev(`
    return { rows: document.querySelectorAll('#i2-live-body tr').length,
             canvases: document.querySelectorAll('#i2-live-body canvas.spark').length,
             canvasW: document.querySelector('#i2-live-body canvas.spark')?.width || 0,
             sum: document.getElementById('i2-live-sum').textContent };`);
  ok(liveDom.rows === 3, `实时值表 3 行（实际 ${liveDom.rows}）`);
  ok(liveDom.canvases === 3, '……每行一条迷你曲线');
  ok(liveDom.canvasW > 100, `曲线背板宽度跟着实际宽度走（${liveDom.canvasW}px）`);
  ok(/个变量/.test(liveDom.sum), '实时值摘要写明了变量数与采样数', liveDom.sum);
}

// ==================================================================== 5b
console.log('== 5b. 长读自动分片：填 256，外部看不见那 5 笔 ==');
{
  const big = await ev(`
    const t = window.__tools.i2c;
    // 往假 EEPROM 里铺 256 B 已知图案（直接铺内存，省得等 tWR）
    const ee = t.session.hid.devices.get(0x50);
    for (let i = 0; i < 256; i++) ee.mem[i] = i & 0xff;
    t.rows = [
      { op:'rd', dev:'0x50', addr:'0x00', data:'', rd:'256', as:'b0=u8(0), b255=u8(255)', period:'' },
    ];
    t.results.clear(); t._renderTable();
    // 前面几节把 session.log 打桩静音了（省 DOM）；这里要数日志行数，先接回真的
    const proto = Object.getPrototypeOf(t.session);
    t.session.log = proto.log.bind(t.session);
    t.session.ring.length = 0;
    document.getElementById('i2-cmd-send').click();
    await new Promise(r => setTimeout(r, 1500));
    const out = {
      res: document.querySelector('#i2-cmd-body td.res').textContent,
      logs: t.session.ring.filter(e => e.kind === 'ok').map(e => e.text),
      live: [...t.live.entries()].map(([k, v]) => k + '=' + v.last),
    };
    t.session.log = () => {};                 // 还原成静音，别让后面的断言被日志干扰
    return out;`);
  ok(/共 256 B/.test(big.res) && /分 5 笔/.test(big.res), '结果列写明「共 256 B · 分 5 笔」', big.res);
  ok(big.logs.length === 1, `🚨 日志只出一行（不是 5 行）—— 分片对外不可见（实际 ${big.logs.length} 行）`, JSON.stringify(big.logs));
  ok(/256 B/.test(big.logs[0]) && /分 5 笔/.test(big.logs[0]), '……那一行说清了总长与笔数', big.logs[0]);
  ok(/b0=0/.test(big.live.find(x => x.startsWith('b0')) || '') || big.live.some(x => x === 'b0=0'),
     'as 解码作用在**拼起来的整块**上（b0 = 0x00）', JSON.stringify(big.live));
  ok(big.live.some(x => x === 'b255=255'), '……偏移 255 也能解到（b255 = 0xFF）', JSON.stringify(big.live));

  // 读长超上限要当行报错
  const tooBig = await ev(`
    const t = window.__tools.i2c;
    t.rows = [{ op:'rd', dev:'0x50', addr:'0x00', data:'', rd:'99999', as:'', period:'' }];
    t._renderTable();
    return document.querySelector('#i2-cmd-body td.res').textContent;`);
  ok(/✗/.test(tooBig) && /4096/.test(tooBig), '读长超 4096 当行红字报出来', tooBig);

  // 写超 51 B 要报"写不自动分片"
  const wrBig = await ev(`
    const t = window.__tools.i2c;
    t.rows = [{ op:'wr', dev:'0x50', addr:'0x00', data: Array(52).fill('11').join(' '), rd:'', as:'', period:'' }];
    t._renderTable();
    return document.querySelector('#i2-cmd-body td.res').textContent;`);
  ok(/✗/.test(wrBig) && /不自动分片/.test(wrBig), '写超 51 B 报"写不自动分片"（EEPROM 跨页会绕回页首）', wrBig);
}

// ==================================================================== 5c
console.log('== 5c. 寄存器面板：读 128 B → 点字节改 bit → 只写改动 ==');
{
  // 假 Si5351（0x60）是纯寄存器器件（无页写回卷）—— 铺一段有规律的图案当"器件现值"
  const setup = await ev(`
    const t = window.__tools.i2c;
    const dev = t.session.hid.devices.get(0x60);
    for (let i = 0; i < 128; i++) dev.regs[i] = (i * 5 + 1) & 0xff;
    document.querySelector('#i2-dock-tabs button[data-dock="reg"]').click();
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
    set('i2-reg-dev', '0x60'); set('i2-reg-start', '0x00'); set('i2-reg-len', '128');
    document.getElementById('i2-reg-alen').value = '1';
    const btn = document.getElementById('i2-reg-read');
    const wasDisabled = btn.disabled;
    btn.click();
    await new Promise(r => setTimeout(r, 1200));
    const cells = [...document.querySelectorAll('#i2-reg-body button.rb')];
    return {
      wasDisabled,
      dock: t.dockTab,
      on: [...document.querySelectorAll('#i2-box-dock .dockpage.on')].map(p => p.dataset.dock),
      rows: document.querySelectorAll('#i2-reg-body tr').length,
      cells: cells.length,
      first: cells[0]?.textContent, last: cells[cells.length - 1]?.textContent,
      head: [...document.querySelectorAll('#i2-reg-head th')].map(th => th.textContent).join('|'),
      addr0: document.querySelector('#i2-reg-body td.ra')?.textContent,
      ascii0: document.querySelector('#i2-reg-body td.rascii')?.textContent,
      sum: document.getElementById('i2-reg-sum').textContent,
      len: t.reg.base.length,
    };`);
  ok(setup.wasDisabled === false, '连上假探针后「读取」是可点的');
  ok(setup.dock === 'reg' && setup.on.join(',') === 'reg', '切到「寄存器」tab 且只显示这一块');
  ok(setup.rows === 8 && setup.cells === 128, `128 B 画成 16×8（实际 ${setup.rows} 行 / ${setup.cells} 格）`);
  ok(setup.first === '01' && setup.last === '7C', `首末字节与假器件图案对账（${setup.first} … ${setup.last}）`);
  ok(setup.head === '地址|0|1|2|3|4|5|6|7|8|9|A|B|C|D|E|F|ASCII', '表头 = 地址 + 列号 0..F + ASCII', setup.head);
  ok(setup.addr0 === '0x00', '第一行的地址标注按地址宽度写（0x00）', setup.addr0);
  ok(setup.len === 128 && /128 B/.test(setup.sum), '摘要报出读回长度', setup.sum);

  // 点字节点开开关板 → 翻一位
  const edited = await ev(`
    const t = window.__tools.i2c;
    document.querySelector('#i2-reg-body button.rb[data-off="0"]').click();
    await new Promise(r => setTimeout(r, 60));
    const pop = document.getElementById('i2-regpop');
    const open = !pop.hidden;
    const bits = pop.querySelectorAll('#i2-regpop-bits button.bit').length;
    pop.querySelector('#i2-regpop-bits button.bit[data-k="0"]').click();     // 0x01 → 0x00
    await new Promise(r => setTimeout(r, 60));
    const cell = document.querySelector('#i2-reg-body button.rb[data-off="0"]');
    return { open, bits, cell: cell.textContent, chg: cell.classList.contains('chg'),
             chgBits: pop.querySelectorAll('#i2-regpop-bits button.bit.chg').length,
             hexBox: document.getElementById('i2-regpop-hex').value,
             sum: document.getElementById('i2-reg-sum').textContent,
             cur: t.reg.cur[0], base: t.reg.base[0],
             writeDisabled: document.getElementById('i2-reg-write').disabled };`);
  ok(edited.open && edited.bits === 8, '点表里的字节 → 弹出 8 个 bit 的开关板');
  ok(edited.cur === 0x00 && edited.base === 0x01, '点 bit0 把 0x01 翻成 0x00（只改缓冲，器件现值没动）');
  ok(edited.cell === '00' && edited.chg, '格子立刻变 00 并套上黄框');
  ok(edited.chgBits === 1, '开关板上"与原件不同的位"标了 1 个');
  ok(edited.hexBox === '00', '开关板的十六进制框与点 bit 同步');
  ok(/改了 1 个字节/.test(edited.sum), '摘要报出改动个数', edited.sum);
  ok(edited.writeDisabled === false, '有改动时「只写改动」自动变可点');

  // 写回：器件里真的变了、没改的字节没动、黄框清掉
  const wrote = await ev(`
    const t = window.__tools.i2c;
    document.getElementById('i2-reg-write').click();
    await new Promise(r => setTimeout(r, 900));
    const dev = t.session.hid.devices.get(0x60);
    const cell = document.querySelector('#i2-reg-body button.rb[data-off="0"]');
    return { dev0: dev.regs[0], dev1: dev.regs[1], base0: t.reg.base[0],
             chg: cell.classList.contains('chg'),
             sum: document.getElementById('i2-reg-sum').textContent,
             writeDisabled: document.getElementById('i2-reg-write').disabled,
             errs: window.__tools.summary().errors.length };`);
  ok(wrote.dev0 === 0x00, '「只写改动」真的写进了假器件（0x60 regs[0] = 0x00）');
  ok(wrote.dev1 === 6, '相邻没改的字节一个都没动（regs[1] 仍是 0x06）', String(wrote.dev1));
  ok(wrote.base0 === 0x00 && wrote.chg === false, '写回成功后"器件现值"跟着更新、黄框清掉');
  ok(wrote.writeDisabled === true, '没有改动了 → 「只写改动」自动灰掉');
  ok(wrote.errs === 0, '这一轮没有未捕获错误');

  // 丢弃改动：改一格再丢弃，回到器件现值
  const discard = await ev(`
    const t = window.__tools.i2c;
    document.querySelector('#i2-reg-body button.rb[data-off="3"]').click();
    await new Promise(r => setTimeout(r, 40));
    document.getElementById('i2-regpop-bits').querySelector('button.bit[data-k="7"]').click();
    await new Promise(r => setTimeout(r, 40));
    const changed = t.reg.cur[3] !== t.reg.base[3];
    document.getElementById('i2-reg-discard').click();
    await new Promise(r => setTimeout(r, 60));
    const cell = document.querySelector('#i2-reg-body button.rb[data-off="3"]');
    return { changed, same: t.reg.cur[3] === t.reg.base[3],
             cell: cell.textContent, chg: cell.classList.contains('chg'),
             dev: t.session.hid.devices.get(0x60).regs[3] };`);
  ok(discard.changed && discard.same, '「丢弃改动」把缓冲还原成器件现值');
  ok(discard.chg === false && discard.cell === discard.dev.toString(16).toUpperCase().padStart(2, '0'),
     '格子上的黄框也一起清掉（内容回到器件现值）');

  // 非法输入：地址超出范围要**报错并保持原表**（不是静默清空）
  const bad = await ev(`
    const t = window.__tools.i2c;
    const proto = Object.getPrototypeOf(t.session);
    t.session.log = proto.log.bind(t.session);      // 本节要数日志，先接回真的
    t.session.ring.length = 0;
    const dev = document.getElementById('i2-reg-dev');
    dev.value = '0x80'; dev.dispatchEvent(new Event('change'));
    document.getElementById('i2-reg-read').click();
    await new Promise(r => setTimeout(r, 300));
    const out = { logs: t.session.ring.map(e => e.text).join(' | '),
                  cells: document.querySelectorAll('#i2-reg-body button.rb').length };
    // 还原成安静模式 + 合法器件地址
    t.session.log = () => {};
    dev.value = '0x60'; dev.dispatchEvent(new Event('change'));
    return out;`);
  ok(bad.cells === 128, '器件地址非法时表**不被动过**（还是那 128 格）', String(bad.cells));
  ok(/0x08\.\.0x77|超出 7 位/.test(bad.logs), '……并在日志里说清哪里不合法', bad.logs.slice(0, 120));

  // 🚨 读完之后改过器件/起始地址 → **必须拒绝写回**（否则会把旧地址的数据糊到新地址上）
  const guard = await ev(`
    const t = window.__tools.i2c;
    const proto = Object.getPrototypeOf(t.session);
    t.session.log = proto.log.bind(t.session);
    t.session.ring.length = 0;
    // 先改一格（有"改动"才谈得上写回），再把器件地址改掉
    t.reg.cur = t.reg.cur.slice(); t.reg.cur[1] = (t.reg.cur[1] ^ 0xff) & 0xff;
    t.reg._render(); t.reg._renderSummary();
    const dev = document.getElementById('i2-reg-dev');
    dev.value = '0x68'; dev.dispatchEvent(new Event('change'));
    const before = t.session.hid.devices.get(0x68).regs[1];
    document.getElementById('i2-reg-write').click();
    await new Promise(r => setTimeout(r, 400));
    const out = { logs: t.session.ring.map(e => e.text).join(' | '),
                  dev68: t.session.hid.devices.get(0x68).regs[1], before,
                  dev60: t.session.hid.devices.get(0x60).regs[1],
                  base: t.reg.base[1] };
    // 复原：器件回到 0x60、重新读一次（后面没有小节了，但保持页面干净）
    dev.value = '0x60'; dev.dispatchEvent(new Event('change'));
    t.session.log = () => {};
    return out;`);
  ok(/读取.*之后被改过|先重新「读取」/.test(guard.logs), '读取后改过器件地址 → 写回被拦下并说明原因', guard.logs.slice(0, 140));
  ok(guard.dev68 === guard.before, '……假器件 0x68 一个字节都没被写（没有"糊到新地址"）');
  ok(guard.dev60 === guard.base, '……0x60 里那份也没动（改动只留在页面上）');
}

// ==================================================================== 6
console.log('== 6. 表格 ⇄ 脚本（同一套解析）==');
{
  const rt = await ev(`
    const t = window.__tools.i2c;
    t.rows = [
      { op:'rd', dev:'0x50', addr:'0x00', data:'', rd:'8', as:'', period:'' },
      { op:'wr', dev:'0x50', addr:'0x10', data:'A5 5A', rd:'', as:'', period:'' },
      { op:'delay', dev:'—', addr:'', data:'10ms', rd:'', as:'', period:'' },
      { op:'rd', dev:'0x68', addr:'0x3B', data:'', rd:'14', as:'ax=i16be(0)/16384', period:'100ms×5' },
    ];
    t._renderTable();
    document.getElementById('i2-dsl-fromtable').click();
    await new Promise(r => setTimeout(r, 250));
    const script = document.getElementById('i2-dsl-text').value;
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 250));
    return { script, sum: document.getElementById('i2-dsl-sum').textContent,
             errRows: document.querySelectorAll('#i2-dsl-err tr').length,
             tasks: window.__tools.i2c.runner.constructor ? null : null };`);
  ok(/rd 0x50 0x00 8/.test(rt.script), '命令表 → 脚本：读那一行', rt.script.split('\n').slice(0, 6).join(' | '));
  ok(/wr 0x50 0x10 A5 5A/.test(rt.script), '命令表 → 脚本：写那一行');
  ok(/delay 10ms/.test(rt.script), '命令表 → 脚本：延时那一行');
  ok(/every 100ms 5/.test(rt.script), '命令表 → 脚本：周期 100ms×5');
  ok(rt.errRows === 0, '生成的脚本零语法错');
  ok(/1 个循环任务/.test(rt.sum) && /100ms/.test(rt.sum), '解析摘要报出了循环任务与周期', rt.sum);

  const back = await ev(`
    const t = window.__tools.i2c;
    document.getElementById('i2-dsl-to-table').click();
    await new Promise(r => setTimeout(r, 250));
    return { rows: t.rows.map(r => [r.op, r.dev, r.addr, r.data, r.rd, r.as, r.period].join('|')),
             dom: document.querySelectorAll('#i2-cmd-body tr').length,
             sum: document.getElementById('i2-dsl-sum').textContent };`);
  ok(back.dom === 4, `脚本 → 命令表：装回 4 行（实际 ${back.dom}）`);
  ok(back.rows[0] === 'rd|0x50|0x00||8||', '……第 1 行字段原样', back.rows[0]);
  ok(back.rows[2] === 'delay|—||10ms|||', '……延时行的时长落在「数据」格', back.rows[2]);
  ok(back.rows[3] === 'rd|0x68|0x3B||14|ax=i16be(0)/16384|100ms×5', '……定时 + 解码都带回来了', back.rows[3]);
}

// ==================================================================== 7
console.log('== 7. 脚本区：预设 / 错误表 / 长读 / 导出 ==');
{
  const pres = await ev(`
    const sel = document.getElementById('i2-preset');
    const opts = [...sel.options].map(o => o.value);
    sel.value = 'ads1115';
    document.getElementById('i2-dsl-load').click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 200));
    return { opts, sum: document.getElementById('i2-dsl-sum').textContent,
             errRows: document.querySelectorAll('#i2-dsl-err tr').length,
             help: document.getElementById('i2-dsl-help').textContent.length };`);
  ok(pres.opts.join(',') === 'quick,at24c02-read,at24c02-write,mpu6050,ads1115,si5351',
     '示例下拉里有六个：快速上手 + 四个模块 + EEPROM 写', pres.opts.join(','));
  ok(/1 个循环任务/.test(pres.sum) && /200ms/.test(pres.sum), 'ADS1115 示例解析出 200 ms 的循环任务', pres.sum);
  ok(/12 条@200ms/.test(pres.sum), '……循环体是 12 条（四通道 × 写配置+等+读）', pres.sum);
  ok(pres.errRows === 0, 'ADS1115 示例零语法错');
  ok(pres.help > 800, `语法速查有内容（${pres.help} 字符）`);

  // AT24C02 只读示例：全片 256 B 现在是**一条**命令（自动分片），不再是 6 行手拆
  const eep = await ev(`
    document.getElementById('i2-preset').value = 'at24c02-read';
    document.getElementById('i2-dsl-load').click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 200));
    return { sum: document.getElementById('i2-dsl-sum').textContent,
             text: document.getElementById('i2-dsl-text').value };`);
  ok(/一次性 3 /.test(eep.sum), 'AT24C02 只读示例：ping + 读 16 B + 读 256 B（一次性 3 条）', eep.sum);
  ok(/^rd 0x50 0x00 256$/m.test(eep.text), '全片读写成一条 `rd 0x50 0x00 256`（不再手动拆 5 行）');
  ok(!/^rd 0x50 - 54$/m.test(eep.text), '……旧的手拆分片行已经不在了');

  const bad = await ev(`
    const ta = document.getElementById('i2-dsl-text');
    const tooLong = Array(56).fill('11').join(' ');       // 56 B > 单次写上限 51
    ta.value = 'scan\\nrd 0x50 0x00 99999\\nwr 0x50 0x00 ' + tooLong;
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 250));
    const rows = [...document.querySelectorAll('#i2-dsl-err tr')].map(tr => [...tr.children].map(td => td.textContent));
    return { n: rows.length, rows, sum: document.getElementById('i2-dsl-sum').textContent,
             visible: document.getElementById('i2-dsl-errwrap').style.display !== 'none' };`);
  ok(bad.n === 2, `两处语法错都列出来了（实际 ${bad.n}）`, JSON.stringify(bad.rows));
  ok(bad.rows.some(r => r[0] === '2' && /4096/.test(r[2])), '第 2 行：一次逻辑读超上限并说清是 4096', JSON.stringify(bad.rows[0]));
  ok(bad.rows.some(r => r[0] === '3' && /51/.test(r[2])), '第 3 行：写数据超上限并说清上限是 51', JSON.stringify(bad.rows[1]));
  ok(bad.visible === true && /2 处语法错/.test(bad.sum), '错误表显示出来了，摘要点名了处数', bad.sum);

  // 导出：长读在 C 表里被展开（rd_len 是线上字段），JSON 里保持一条
  const exp = await ev(`
    const t = window.__tools.i2c;
    const D = t.__dsl;
    return null;`).catch(() => null);
  const exp2 = await ev(`
    const ta = document.getElementById('i2-dsl-text');
    ta.value = 'rd 0x50 0x00 256';
    document.getElementById('i2-dsl-parse').click();
    await new Promise(r => setTimeout(r, 200));
    // 不点下载（CDP 下会弹保存框），直接用模块函数算一遍看形状
    const m = await import('./app/i2c/dsl.js');
    const items = m.parseScript(ta.value).items;
    return { c: m.toCTable(items), json: m.toJson(items), text: m.toText(items) };`);
  const cRows = exp2.c.split('\n').filter(l => l.startsWith('{'));
  ok(cRows.length === 5, `导出 C 表：256 B 被展开成 5 行（实际 ${cRows.length}）`, exp2.c.split('\n').slice(0, 8).join(' | '));
  ok(cRows.every(l => /, ([0-9]+), (NULL|\(uint8_t)/.test(l)), '……每行的 rd_len 都在线上范围内');
  ok(/rd_len 是线上字段/.test(exp2.c), '……并注释说明为什么被展开');
  ok(/"chunk": "reset"/.test(exp2.json), '导出 JSON 保住 chunk（无损往返）');
  ok(/自动分片 5 笔/.test(exp2.text), '导出文本写明「自动分片 5 笔」', exp2.text.trim());
}

// ==================================================================== 8
console.log('== 8. 错误路径与状态显示 ==');
{
  const e = await ev(`
    const t = window.__tools.i2c;
    await t.session.setEnabled(false);
    const disabled = await t.session.transaction({ dev:0x50, addr:[0], wr:[], rd:1 }, { quiet:true });
    await t.session.transaction({ dev:0x21, addr:[0], wr:[], rd:1 }, { quiet:true });   // 不存在的地址
    await t.session.setEnabled(true);
    const noAddr = await t.session.transaction({ dev:0x21, addr:[0], wr:[], rd:1 }, { quiet:true });
    const pt = await t.session.pinTest();
    await t.session.readStatus({ quiet:true });
    return { disabled: disabled.err, noAddr: noAddr.err, bridgeOk: pt.bridgeOk,
             word: document.getElementById('i2-word').textContent,
             wordText: document.getElementById('i2-word-text').textContent,
             ok: document.getElementById('i2-c-ok').textContent,
             na: document.getElementById('i2-c-na').textContent,
             lastUs: document.getElementById('i2-last-us').textContent };`);
  ok(e.disabled === 1, '未使能时事务回 E_DISABLED(1)', String(e.disabled));
  ok(e.noAddr === 3, '不存在的地址回 E_NO_ADDR(3)', String(e.noAddr));
  ok(e.bridgeOk === true, 'PINTEST 判「桥这一侧正常」');
  ok(/^0x[0-9a-f]{8}$/.test(e.word), '状态字按 8 位十六进制显示', e.word);
  ok(/总线空闲/.test(e.wordText) && /SDA=1/.test(e.wordText), '状态字文字说明里有总线/线电平', e.wordText);
  ok(Number(e.ok) >= 4, `成功计数在涨（${e.ok}）`);
  ok(Number(e.na) >= 1, `地址 NACK 计数在涨（${e.na}）`);
  ok(Number(e.lastUs) > 0, `单笔耗时显示出来了（${e.lastUs} µs）`);

  // 坏行必须在结果列里当行报错，而不是等到发送才炸
  const badRow = await ev(`
    const t = window.__tools.i2c;
    document.querySelector('#i2-dock-tabs button[data-dock="cmd"]').click();
    t.rows = [{ op:'rd', dev:'0x50', addr:'0x00', data:'', rd:'99999', as:'', period:'' }];
    t._renderTable();
    return { text: document.querySelector('#i2-cmd-body td.res').textContent,
             cls: document.querySelector('#i2-cmd-body td.res').className };`);
  ok(/✗/.test(badRow.text) && /4096/.test(badRow.text), '填错的行在结果列里就报出来了', badRow.text);
  ok(/bad/.test(badRow.cls), '……并且染成错误色', badRow.cls);
}

// ==================================================================== 9
console.log('== 9. 收尾：放掉探针 ==');
{
  const done = await ev(`
    const t = window.__tools.i2c;
    t.runner.stop();
    document.getElementById('i2-disconnect').click();
    await new Promise(r => setTimeout(r, 250));
    return { s: t.summary(), state: document.getElementById('i2-state').textContent,
      buttons: !document.getElementById('i2-connect').disabled && document.getElementById('i2-disconnect').disabled && !document.getElementById('i2-reconnect') };`);
  ok(done.s.connected === false, 'disconnect 后已放掉 HID');
  ok(done.buttons, '关闭探针后恢复连接按钮；已移除旧重连入口');
  ok(done.s.running === false, '定时已停');
  ok(['scan', 'cmd', 'reg', 'dsl', 'live'].includes(done.s.dock), 'summary 里能报出当前 tab', done.s.dock);
  // 把 tab 还原成默认，别给下一次测试留个"停在实时值"的状态
  await ev(`document.querySelector('#i2-dock-tabs button[data-dock="scan"]').click();
            localStorage.setItem('serial-rtt-tools:v1', JSON.stringify(
              Object.assign(JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}'), { 'i2c.dock': 'scan' })));
            return true;`);
  const err = await ev('return window.__tools.summary().errors;');
  ok(err.length === 0, '整场跑完页面无未捕获错误', JSON.stringify(err));
}

console.log(`\n${fail ? '❌' : '✅'} i2c-page.test: ${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
