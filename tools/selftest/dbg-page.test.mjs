/**
 * 「调试器」页的端到端自测（CDP，**不需要硬件**）：
 *   node tools/selftest/dbg-page.test.mjs        （等价：make test-dbg-page）
 * 前置：静态服务 8899 + 带 CDP 的浏览器 9333（没有就自己拉一个）。
 *
 * 跑的是**真页面对象**（`window.__tools.dbg` 是调试页视图）+ 页面里的**真按钮**，
 * 目标用内置的「模拟目标」（app/dbg/mock.js）——它有真的寄存器/内存/FPB 比较器，
 * 所以「下断点 → 继续 → 命中断点 → 单步 → 复位」这条链是在页面上真跑一遍的。
 * 符号用仓库里的真 ELF（tools/fixtures/dwarf/stm32f103_rtt_speed.elf，页面自己 fetch 得到）。
 *
 * 每一步都断言"客观状态"（会话里的寄存器/内存/断点表、DOM 里给用户看的文字），不看"像不像"。
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
const page = process.env.CDP_PAGE
  ? list.find(t => t.type === 'page' && t.id === process.env.CDP_PAGE)
  : list.find(t => t.type === 'page');
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
/** 轮询等条件成立（页面里的表达式为真） */
async function until(expr, ms = 6000, step = 120){
  const t0 = Date.now();
  for (;;){
    if (await ev(`return !!(${expr});`)) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}

await send('Page.enable');
await send('Runtime.enable');
// 🚨 必须关缓存：python http.server 不发 Cache-Control，改完模块会拿到旧的（本仓库踩过）
try { await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch {}
// Layout assertions use a fixed viewport rather than desktop browser chrome height.
await send('Emulation.setDeviceMetricsOverride', { width:1600, height:1000, deviceScaleFactor:1, mobile:false });
await send('Page.navigate', { url: URL_ });
console.log('目标: ' + URL_);

let ready = false;
for (let i = 0; i < 60; i++){
  await sleep(500);
  try { if (await ev('return !!window.__tools?.dbg;')) { ready = true; break; } } catch {}
}
if (!ready) throw new Error('页面没起来（__tools.dbg 不存在）');

// ==================================================================== 1
console.log('== 1. 标签页与初始状态 ==');
{
  const s = await ev('return window.__tools.summary();');
  ok(Array.isArray(s.tabs) && s.tabs.includes('dbg'), '标签栏里有 dbg（调试器）');
  /* 「调试器」紧跟「烧录器」——用 indexOf 定位而不是数倒数第几个：
   * 标签页数量会变（后来又加了 SPI/I2C/工程生成），写死下标会变成"数量一变就红"的假故障。 */
  ok(s.tabs[s.tabs.indexOf('flash') + 1] === 'dbg', `调试器排在烧录器之后（${s.tabs.join(' → ')}）`, s.tabs.join(','));
  ok(s.ok === true, '页面无 JS 错误', JSON.stringify(s.errors));
  ok(s.dbg && s.dbg.connected === false, 'summary 里有 dbg 段且初始未连接');

  const dom = await ev(`
    document.querySelector('#tabs .tab[data-tab="dbg"]').click();
    await new Promise(r => setTimeout(r, 60));
    const sec = document.getElementById('tab-dbg');
    return { active: sec.classList.contains('active'),
             regs: document.querySelectorAll('#d-regs .table-body>.hint').length,
             mem: document.getElementById('d-mem').textContent.slice(0, 12),
             flag: document.getElementById('d-state').textContent,
             connectBtn: !!document.getElementById('d-connect') };`);
  ok(dom.active && dom.connectBtn, '切到调试器页，控件齐');
  ok(dom.regs === 1 && /未连接|没有数据/.test(dom.mem), '未连接时寄存器/内存区显示占位提示', JSON.stringify(dom));
  ok(dom.flag === '未连接', '状态灯显示未连接');
}

// ==================================================================== 2
console.log('== 2. SWD 时钟默认值（老设置迁移）+ 载入 ELF 符号 ==');
{
  // ① 迁移：塞一个老版本的 1 MHz 设置 → 重载页面 → 应该被迁到新的 10 MHz 默认
  await ev(`
    const st = JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}');
    st['dbg.clock'] = '1000';
    localStorage.setItem('serial-rtt-tools:v1', JSON.stringify(st));
    return 1;`);
  await send('Page.reload', { ignoreCache: true });
  let back = false;
  for (let i = 0; i < 40; i++){
    await sleep(300);
    try { if (await ev('return !!window.__tools?.dbg;')){ back = true; break; } } catch {}
  }
  ok(back, '重载页面（验证时钟默认值迁移）');
  const mig = await ev(`
    document.querySelector('#tabs .tab[data-tab="dbg"]').click();
    await new Promise(r => setTimeout(r, 120));
    const sel = document.getElementById('d-clock');
    return { clk: sel.value, opts: [...sel.options].map(o => o.value),
             stored: JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}')['dbg.clock'] };`);
  ok(mig.opts.includes('10000') && mig.opts.includes('20000') && mig.opts.includes('1000') && mig.opts.includes('200'),
    'SWD 时钟候选：200 / 1000 / 2000 / 5000 / 10000 / 20000 都在', JSON.stringify(mig.opts));
  ok(mig.clk === '10000' && mig.stored === '10000', '老版本留下的 1 MHz 会被迁到新的 10 MHz 默认（手选过 500/200 的不动）', JSON.stringify(mig));

  // ② 载入 ELF（真文件，页面自己 fetch）
  const r = await ev(`
    const res = await fetch('/tools/fixtures/dwarf/stm32f103_rtt_speed.elf');
    if (!res.ok) throw new Error('取 ELF 失败 ' + res.status);
    const buf = await res.arrayBuffer();
    const st = window.__tools.dbg.loadElfBuffer(buf, 'stm32f103_rtt_speed.elf');
    return { n: st ? st.size : 0, vars: st ? st.varCount : 0, info: document.getElementById('d-elf-info').textContent,
             hint: document.getElementById('d-src-file')?.textContent || '',
             tip: document.getElementById('d-src-pick')?.title || '' };`);
  ok(r.n > 50 && r.vars > 0, `符号载入：${r.n} 个符号、${r.vars} 个带类型变量`, JSON.stringify(r));
  ok(/符号/.test(r.info), '侧栏显示符号摘要', r.info);
  /**
   * 载入 ELF 就该给出「选哪个源码目录」的建议（DWARF 里存的是编译时绝对路径）：
   * 推荐目录 + 覆盖数 + （有的话）跨机器的簇。
   */
  /**
   * 载入 ELF 就该说清"该选哪个源码目录"（DWARF 里存的是编译时绝对路径）：
   * 标题栏那行给紧凑版，按钮 tooltip 给完整版（含别的簇 / 跨机器提示）。
   * 不往源码行那块加元素 —— 那儿每多一行，一屏就少看一行源码。
   */
  ok(/^推荐：.*（\d+\/\d+）/.test(r.hint), '载入 ELF 后提示推荐源码目录（带覆盖数）', r.hint);
  ok(/DWARF 路径/.test(r.tip), '「选择源码目录…」的 tooltip 带完整建议', r.tip.slice(0, 80));
}

// ==================================================================== 3
console.log('== 3. 连接模拟目标 + 寄存器表（SWD 时钟 10 MHz）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    document.getElementById('d-backend').value = 'mock';
    document.getElementById('d-backend').dispatchEvent(new Event('change'));
    const okc = await d.connect();
    return { okc, sum: d.summary(), clk: document.getElementById('d-clock').value };`);
  ok(r.okc === true && r.sum.connected, '连上模拟目标', JSON.stringify(r.sum));
  ok(r.sum.regs === 23, `读到 23 个寄存器（含 CFBP 拆出的 4 个）`, String(r.sum.regs));
  ok(r.sum.bpCap === 8, '读到 FPB 硬件断点上限 8');
  ok(r.sum.pc === 0x08000100, 'PC = 复位向量', '0x' + r.sum.pc.toString(16));
  ok(r.sum.clockKhz === 10000 && r.clk === '10000', 'SWD 时钟 10 MHz（下拉与 session 一致）', JSON.stringify({ sum: r.sum.clockKhz, clk: r.clk }));

  const dom = await ev(`
    const rows = [...document.querySelectorAll('#d-regs .regrow')];
    return { rows: rows.length,
             first: rows[0]?.textContent.trim(),
             pcRow: rows.find(r => r.querySelector('.rn').textContent === 'PC')?.querySelector('input').value,
             note: rows.find(r => r.querySelector('.rn').textContent === 'PC')?.querySelector('.note').textContent || '',
             flag: document.getElementById('d-state').textContent,
             stepDisabled: document.getElementById('d-step').disabled,
             pcText: document.getElementById('d-pc').textContent };`);
  ok(dom.rows === 23 && /^R0/.test(dom.first), '寄存器表渲染出 23 行', JSON.stringify(dom));
  ok(dom.pcRow === '0x08000100', 'PC 行的值是 0x08000100', dom.pcRow);
  ok(/[A-Za-z_][\w.]*\+0x[0-9a-f]+/.test(dom.note) || dom.note === '', 'PC 行旁边的符号落点（有符号表就显示函数名+偏移）', dom.note);
  ok(dom.flag === '已停止' && dom.stepDisabled === false, '状态灯=已停止，单步可用');
  ok(/PC 0x08000100/.test(dom.pcText), '工具条上显示 PC', dom.pcText);
}

// ==================================================================== 4
console.log('== 4. 单步 / 继续 / 暂停（真按钮）==');
{
  /**
   * 🚨 这里等 600 ms（原来是 300 ms）：动作本身只要几毫秒，但**机器被别的重活占着**时
   *    点击 → 事件 → `exclusive()` 排队这条链可能被拖过 300 ms，于是本组 5 条断言会**成片**
   *    假红（2026-10 实测：后台跑着真机压测时一次红 5 条，同一份代码重跑就 142/142）。
   *    600 ms 仍然足够抓住"点了没反应"（那种是真的一直不动）。
   */
  await ev(`document.getElementById('d-step').click(); await new Promise(r=>setTimeout(r,600));`);
  const r = await ev('return window.__tools.dbg.summary();');
  ok(r.pc === 0x08000102, '点「单步」走了一条指令（PC +2）', '0x' + r.pc.toString(16));
  ok(r.halted === true, '单步后仍是停止状态');

  const cont = await ev(`
    document.getElementById('d-cont').click();
    await new Promise(r=>setTimeout(r, 600));
    const d = window.__tools.dbg;
    return { sum: d.summary(), livePc: await d.session.readReg('PC') };`);
  ok(cont.sum.halted === false, '点「继续」之后目标在跑');
  ok(cont.livePc !== 0x08000102, '目标真的在往前走（直接读 PC 看）', '0x' + cont.livePc.toString(16));

  await sleep(600);
  const stillRunning = await ev('return !window.__tools.dbg.session.halted;');
  ok(stillRunning, '没有断点时它会一直跑（观察循环不会误判成"已停止"）');

  await ev(`document.getElementById('d-halt').click(); await new Promise(r=>setTimeout(r,600));`);
  const st = await ev('return { h: window.__tools.dbg.session.halted, flag: document.getElementById("d-state").textContent };');
  ok(st.h && st.flag === '已停止', '点「暂停」能停住', JSON.stringify(st));
}

// ==================================================================== 5
console.log('== 5. 命令行 ==');
const outText = () => ev('return document.getElementById("d-out").textContent;');
{
  const run = async line => {
    await ev(`document.getElementById('d-cmd').value = ${JSON.stringify(line)};
              document.getElementById('d-run').click();
              await new Promise(r=>setTimeout(r, 250));`);
    return await outText();
  };

  let t = await run('h');
  ok(/md <地址>/.test(t) && /b <地址\|符号/.test(t) && /文件:行/.test(t), 'h 打出帮助（含新增的「文件:行」下断点）', t.slice(-140));

  const follow = await ev(`
    const d = window.__tools.dbg, el = document.getElementById('d-out');
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const history = () => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); };
    const bottom = () => el.scrollHeight - el.clientHeight - el.scrollTop < 2;
    await frame(); history();
    const scrollable = el.scrollHeight > el.clientHeight && !el._stick;
    d._out('后台日志：翻看历史时保留位置'); await frame();
    const keptHistory = el.scrollTop === 0;
    await d.runLine('h'); await frame(); const commandBottom = bottom();
    history(); await d.runLine('invalid-command'); await frame(); const errorBottom = bottom();
    history(); await d._act('测试动作', async () => d._out('动作结果')); await frame();
    return { scrollable, keptHistory, commandBottom, errorBottom, actionBottom: bottom() };`);
  ok(follow.scrollable && follow.keptHistory, '翻看历史时后台日志保留滚动位置', JSON.stringify(follow));
  ok(follow.commandBottom && follow.errorBottom && follow.actionBottom, '新命令、报错和按钮动作都回到最新输出', JSON.stringify(follow));

  t = await run('r');
  ok(/R0/.test(t) && /XPSR/.test(t) && /CONTROL/.test(t), 'r 打印全部寄存器（含 CFBP 拆出的特殊寄存器）');

  t = await run('r r0 0x1234');
  ok(/R0/.test(t) && /0x00001234/.test(t), 'r r0 <值> 写入并回显');
  const r0 = await ev('return await window.__tools.dbg.session.readReg("R0");');
  ok(r0 === 0x1234, '页面会话里的 R0 真的变了', '0x' + r0.toString(16));

  t = await run('mw 0x20000040 de ad be ef');
  ok(/回读一致/.test(t), 'mw 写内存并回读对账', t.slice(-100));
  t = await run('md 0x20000040 16');
  ok(/0x20000040  DE AD BE EF/.test(t), 'md 的 hexdump 内容正确', t.slice(-160));

  t = await run('p g_bytes');
  ok(/g_bytes/.test(t), 'p <变量> 从 ELF 符号里找到了变量', t.slice(-120));

  t = await run('sym RTT');
  ok(/_SEGGER_RTT/.test(t), 'sym <子串> 搜符号');

  t = await run('b SysTick_Handler');
  ok(/断点 #1/.test(t) && /SysTick_Handler/.test(t), 'b <符号> 下硬件断点（符号解析）', t.slice(-120));
  const bpl = await ev('return document.getElementById("d-bp-list").textContent;');
  ok(/SysTick_Handler/.test(bpl), '侧栏断点列表里出现了它', bpl);
  t = await run('bl');
  ok(/#1/.test(t) && /硬件上限 8/.test(t), 'bl 列出断点与硬件上限');

  t = await run('nosuchcmd');
  ok(/不认识的命令/.test(t), '不认识的命令给红字提示（不静默）', t.slice(-80));
}

// ==================================================================== 6
console.log('== 6. 断点：继续 → 命中 → 再继续（跨过断点）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000200);
    await d.session.refreshRegs();
    d.renderRegs(); d.renderBps();
    await d.runLine('b 0x08000300');
    await d.runLine('c');                      // 命令行的「继续」
    return { bps: d.session.bps.map(a=>'0x'+a.toString(16)), wires: !!d.watching };`);
  ok(r.bps.length === 1 && r.bps[0] === '0x8000300', '下了一个断点', JSON.stringify(r));
  ok(await until('window.__tools.dbg.session.halted', 6000), '继续之后命中断点并停下');
  const hit = await ev(`
    const d = window.__tools.dbg;
    return { pc: d.session.pc, out: document.getElementById('d-out').textContent };`);
  ok(hit.pc === 0x08000300, 'PC 停在断点地址上', '0x' + hit.pc.toString(16));
  ok(/命中断点/.test(hit.out), '命令行里明确写了「命中断点」', hit.out.slice(-120));

  // 再继续：会话内部要"先单步跨过断点"，然后绕一圈再命中
  await ev(`
    window.__tools.dbg.runLine('c');
    await new Promise(r=>setTimeout(r, 50));
    return 1;`);
  ok(await until('window.__tools.dbg.session.halted', 8000), '第二次继续后仍然会命中（没有卡在断点上）');
  const pc2 = await ev('return window.__tools.dbg.session.pc;');
  ok(pc2 === 0x08000300, '还是同一个断点地址', '0x' + pc2.toString(16));

  // 侧栏的「×」删断点
  const after = await ev(`
    document.querySelector('#d-bp-list .bprow button').click();
    await new Promise(r=>setTimeout(r, 250));
    return { n: window.__tools.dbg.session.bps.length, text: document.getElementById('d-bp-list').textContent };`);
  ok(after.n === 0 && /还没有断点/.test(after.text), '点断点列表里的 × 能删掉', JSON.stringify(after));
}

// ==================================================================== 7
console.log('== 7. 寄存器 / 内存的界面编辑 ==');
{
  const r = await ev(`
    const rows = [...document.querySelectorAll('#d-regs .regrow')];
    const inp = rows.find(r => r.querySelector('.rn').textContent === 'R1').querySelector('input');
    inp.value = '0xCAFEBABE';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { v: await window.__tools.dbg.session.readReg('R1'),
             shown: inp.value, out: document.getElementById('d-out').textContent.slice(-80) };`);
  ok(r.v === 0xcafebabe, '在寄存器表里改 R1 并回车 → 真写进去了', JSON.stringify(r));
  ok(/0xCAFEBABE/i.test(r.shown), '输入框回填了读回值', r.shown);

  const mem = await ev(`
    // 打开「可写」，读一段内存，点一个字节，改它
    const w = document.getElementById('d-mem-write-on');
    w.checked = true; w.dispatchEvent(new Event('change'));
    document.getElementById('d-mem-addr').value = '0x20000080';
    document.getElementById('d-mem-len').value = '32';
    document.getElementById('d-mem-read').click();
    await new Promise(r => setTimeout(r, 300));
    const cells = [...document.querySelectorAll('#d-mem .by.w')];
    cells[2].click();                                  // 0x20000082
    const ea = document.getElementById('d-mem-ea').value;
    document.getElementById('d-mem-ev').value = '5A';
    document.getElementById('d-mem-write').click();
    await new Promise(r => setTimeout(r, 300));
    const bytes = await window.__tools.dbg.session.memRead(0x20000080, 4);
    return { ea, cells: cells.length, hex: [...bytes].map(b=>b.toString(16).padStart(2,'0')).join(' '),
             dump: document.getElementById('d-mem').textContent };`);
  ok(mem.cells >= 32, '内存区渲染出可点的字节格子', String(mem.cells));
  ok(/0x20000082/i.test(mem.ea), '点字节会把地址填进「改」那一行', mem.ea);
  ok(/^80 00 5a a5$/.test(mem.hex) || mem.hex.includes('5a'), '点格子改字节真的写进了内存', mem.hex);
  ok(/20000080/.test(mem.dump), 'dump 里的地址列正确', mem.dump.slice(0, 40));
}

// ==================================================================== 8
console.log('== 8. 复位与运行状态按钮 ==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.session.bpClear();
    document.getElementById('d-reset-halt').click();
    await new Promise(r => setTimeout(r, 600));
    const a = { pc: d.session.pc, h: d.session.halted, flag: document.getElementById('d-state').textContent };
    document.getElementById('d-reset-run').click();
    await new Promise(r => setTimeout(r, 400));
    const b = { pc: d.session.pc, h: d.session.halted, flag: document.getElementById('d-state').textContent };
    document.getElementById('d-halt').click();
    await new Promise(r => setTimeout(r, 400));
    return { a, b, c: { h: d.session.halted } };`);
  ok(r.a.pc === 0x08000100 && r.a.h === true, '「复位并停」把 PC 拉回复位向量且停住', JSON.stringify(r.a));
  ok(r.b.h === false && r.b.flag === '运行中', '「复位并跑」进入运行状态', JSON.stringify(r.b));
  ok(r.c.h === true, '点「暂停」能停住', JSON.stringify(r.c));
}

// ==================================================================== 9
console.log('== 9. RTT 同屏（模拟目标里有一个合法的 RTT 控制块）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    document.getElementById('d-rtt-addr').value = '0x20000100';
    document.getElementById('d-rtt-locate').click();
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('d-reset-run').click();          // 让它跑起来，假目标会往 RTT 环里写
    await new Promise(r => setTimeout(r, 1200));
    document.getElementById('d-halt').click();
    await new Promise(r => setTimeout(r, 400));
    return { rtt: d.rtt ? { addr: '0x' + d.rtt.addr.toString(16), maxUp: d.rtt.maxUp } : null,
             wired: d.rtt ? { sameProbe: d.rtt.mem === d.session.probe,
                              hasRead: typeof d.rtt.mem?.readMem === 'function',
                              hasWrite: typeof d.rtt.mem?.writeMem === 'function' } : null,
             text: document.getElementById('d-rtt').textContent.slice(0, 200),
             info: document.getElementById('d-rtt-info').textContent };`);
  ok(r.rtt && r.rtt.addr === '0x20000100' && r.rtt.maxUp === 1, 'RTT 控制块定位成功', JSON.stringify(r.rtt));
  /**
   * 🚨 给 `Rtt` 的必须是**后端感知的内存访问器**（session.memRead/memWrite），不能是 `session.probe`：
   *    ARM 后端 probe 是 SWD/AHB-AP 还能用，RISC-V 后端 probe 只是 WebUSB 壳子，传它就会按 SWD
   *    去读 0x4C0003C0 → `SWD FAULT`，而且会把 DM 的 SBA 打脏（之后静默读到全 0，要 dm.init() 才恢复）。
   *    真机现场 2026-10（HPM6800EVK + tcpecho）：定位 RTT 失败 → 之后调试读什么都变味了。
   */
  ok(r.wired && r.wired.sameProbe === false && r.wired.hasRead && r.wired.hasWrite,
     'RTT 走的是后端自己的内存访问器（不是直接抓 session.probe）', JSON.stringify(r.wired));
  ok(/tick|dbg/.test(r.text), 'RTT 输出窗里真的出现了目标打印的内容', r.text.slice(0, 80));

  const clear = await ev(`
    const d = window.__tools.dbg, rtt = d.rtt, el = document.getElementById('d-rtt');
    const before = el.textContent.length;
    const info = document.getElementById('d-rtt-info').textContent;
    document.getElementById('d-rtt-clear').click();
    const empty = el.textContent === '';
    await d.runLine('c');
    await new Promise(r => setTimeout(r, 900));
    await d.runLine('halt');
    return { before, empty, same: d.rtt === rtt,
      infoSame: document.getElementById('d-rtt-info').textContent === info,
      resumed: /tick|dbg/.test(el.textContent) };`);
  ok(clear.before > 0 && clear.empty, 'RTT 清屏按钮清掉已有显示', JSON.stringify(clear));
  ok(clear.same && clear.infoSame && clear.resumed, 'RTT 清屏保留连接且后续输出继续显示', JSON.stringify(clear));
}

// ==================================================================== 10
console.log('== 10. 符号列表（载入 ELF 后能一眼看到全局变量）==');
{
  const r = await ev(`
    const box = document.getElementById('d-sym-list');
    const rows = [...box.querySelectorAll('.symrow')];
    return { rows: rows.length,
             first: rows[0]?.textContent.trim(),
             hasRtt: rows.some(x => x.dataset.name === '_SEGGER_RTT'),
             typed: rows.slice(0, 3).every(x => x.querySelector('.ty').textContent.length > 0) };`);
  ok(r.rows > 10, `符号列表渲染出 ${r.rows} 行`, JSON.stringify(r));
  ok(r.hasRtt, '列表里有 _SEGGER_RTT（全局变量）', r.first);
  ok(r.typed, '带类型的变量显示类型（DWARF 生效）', r.first);

  const f = await ev(`
    const q = document.getElementById('d-sym-q');
    q.value = 'SEGGER'; q.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 120));
    const names = [...document.querySelectorAll('#d-sym-list .symrow')].map(x => x.dataset.name);
    q.value = ''; q.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 120));
    const back = document.querySelectorAll('#d-sym-list .symrow').length;
    return { names, back };`);
  ok(f.names.length > 0 && f.names.every(n => /SEGGER/i.test(n)), '搜索框按子串过滤符号', JSON.stringify(f.names.slice(0, 4)));
  ok(f.back > f.names.length, '清空搜索后列表恢复');

  const click = await ev(`
    const row = [...document.querySelectorAll('#d-sym-list .symrow')].find(x => x.dataset.name === 'g_bytes');
    row.click();
    await new Promise(r => setTimeout(r, 80));
    return document.getElementById('d-cmd').value;`);
  ok(click === 'p g_bytes', '点符号名 → 填进命令行（直接回车就能打）', click);

  /**
   * 版面护栏（用户 2026-10 提的）：符号列表与监视窗口**各占一半高度**。
   * 之前两个都是 `flex:1 1 auto`，flex-basis 取内容高度 —— 符号列表上百行、监视窗口两三行，
   * 剩余空间按内容比分配，监视窗口被压到只剩一条缝（截图里就是这样）。
   * 判据：两边可视高度差 ≤ 25%（同一 tab 内，工具栏占掉的高度不影响这个比较）。
   */
  const half = await ev(`
    const d = window.__tools.dbg;
    d.addWatch('g_tick'); d.addWatch('g_loops');
    document.querySelector('#d-dock-tabs button[data-dock="var"]').click();
    await new Promise(r => setTimeout(r, 250));
    const a = document.getElementById('d-sym-list').getBoundingClientRect().height;
    const b = document.getElementById('d-watch-list').getBoundingClientRect().height;
    return { sym: Math.round(a), watch: Math.round(b), ratio: +(Math.min(a, b) / Math.max(a, b)).toFixed(3) };`);
  ok(half.ratio >= 0.75, `符号列表与监视窗口差不多各占一半（${half.sym}px vs ${half.watch}px，比值 ${half.ratio}）`, JSON.stringify(half));
}

// ==================================================================== 11
console.log('== 11. 监视窗口（选 ELF 里的变量，停下来看它的值）==');
{
  const add = await ev(`
    const d = window.__tools.dbg;
    d.clearWatch();
    const row = [...document.querySelectorAll('#d-sym-list .symrow')].find(x => x.dataset.name === 'g_bytes');
    row.querySelector('button[data-watch]').click();          // 符号列表里的 ＋
    await new Promise(r => setTimeout(r, 400));
    return { n: d.watch.items.length, dom: document.getElementById('d-watch-list').textContent.trim(),
             expr: d.watch.items[0]?.expr, addr: d.watch.items[0]?.addr };`);
  ok(add.n === 1 && add.expr === 'g_bytes', '符号列表点 ＋ 加进监视窗口', JSON.stringify(add));
  ok(add.addr === 0x20000000, '监视项的地址来自符号表', '0x' + Number(add.addr).toString(16));

  const val = await ev(`
    const d = window.__tools.dbg;
    await d.session.memWrite(0x20000000, Uint8Array.from([0x11,0x22,0x33,0x44]));
    await d.refreshWatch({ force: true });
    await new Promise(r => setTimeout(r, 150));
    return { text: d.watch.items[0].value?.text, hex: d.watch.items[0].value?.hex,
             dom: document.getElementById('d-watch-list').textContent };`);
  ok(/44332211|11 22 33 44/.test(`${val.text} ${val.hex} ${val.dom}`), '监视窗口读到了变量的值', JSON.stringify(val));

  // 停止时自动刷新：下断点 → 继续 → 命中后值应该已经是最新的
  const auto = await ev(`
    const d = window.__tools.dbg;
    await d.session.memWrite(0x20000000, Uint8Array.from([0xaa,0xbb,0xcc,0xdd]));
    d.watch.items[0].value = null;                       // 清掉，看它会不会自己回来
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000200);
    await d.session.refreshRegs();
    await d.runLine('b 0x08000300');
    await d.runLine('c');
    return 1;`);
  void auto;
  ok(await until('window.__tools.dbg.session.halted', 6000), '继续之后命中断点');
  const after = await ev(`
    const d = window.__tools.dbg;
    await new Promise(r => setTimeout(r, 400));
    // 假目标跑起来之后自己也会写 RAM，所以不能拿"我们刚写进去的"去比 —— 跟**现值**对账
    const raw = await d.session.memRead(0x20000000, 4);
    const expect = String(((raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0));
    return { v: d.watch.items[0].value?.text, expect, bps: d.session.bps.length };`);
  ok(after.v != null && after.v === after.expect, '停下来时监视值自动刷新，且与内存现值一致', JSON.stringify(after));

  const wl = await ev(`
    const d = window.__tools.dbg;
    await d.runLine('wl');
    return document.getElementById('d-out').textContent.slice(-260);`);
  ok(/g_bytes/.test(wl) && /#1/.test(wl), '命令行 wl 列出监视项', wl.slice(-100));

  const del = await ev(`
    const d = window.__tools.dbg;
    await d.runLine('wd all');
    await new Promise(r => setTimeout(r, 150));
    return { n: d.watch.items.length, dom: document.getElementById('d-watch-list').textContent };`);
  ok(del.n === 0 && /还没有监视项/.test(del.dom), 'wd all 清空监视窗口', JSON.stringify(del).slice(0, 120));

  const removeButtons = await ev(`
    const d = window.__tools.dbg, names=['g_bytes','g_bytes+4','0x20000010','main'];
    const expressions=()=>d.watch.items.map(it=>it.expr);
    const click=i=>document.querySelectorAll('#d-watch-list button[data-del]')[i].click();
    d.addWatch(names[0]); click(0);
    const single=expressions();
    for(const name of names)d.addWatch(name);
    const ids=[...document.querySelectorAll('#d-watch-list button[data-del]')].map(b=>Number(b.dataset.del));
    click(1);const middle=expressions();
    click(2);const last=expressions();
    click(0);const first=expressions();
    click(0);await new Promise(r=>setTimeout(r,150));
    return {single,ids,middle,last,first,empty:expressions(),dom:document.getElementById('d-watch-list').textContent};`);
  ok(removeButtons.single.length===0, '唯一监视项的 × 可以删除', JSON.stringify(removeButtons.single));
  ok(JSON.stringify(removeButtons.ids)==='[1,2,3,4]', '删除按钮编号与 wd 的 1 起编号一致', JSON.stringify(removeButtons.ids));
  ok(JSON.stringify(removeButtons.middle)==='["g_bytes","0x20000010","main"]', '点中间项 × 只删除该项', JSON.stringify(removeButtons.middle));
  ok(JSON.stringify(removeButtons.last)==='["g_bytes","0x20000010"]', '中间项删除后再删末项不偏移', JSON.stringify(removeButtons.last));
  ok(JSON.stringify(removeButtons.first)==='["0x20000010"]', '多项中的首项也能删除', JSON.stringify(removeButtons.first));
  ok(removeButtons.empty.length===0&&/还没有监视项/.test(removeButtons.dom), '连续删除后保持空列表，不被异步刷新恢复', JSON.stringify(removeButtons.empty));
}

// ==================================================================== 12
console.log('== 12. RTT 地址（载入 ELF 后直接显示 _SEGGER_RTT）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    document.getElementById('d-rtt-addr').value = '';
    d._renderRttSym();
    return { sym: document.getElementById('d-rtt-sym').textContent, addr: d.sym.rttSym()?.addr };`);
  ok(r.addr === 0x2000000c, '_SEGGER_RTT 的地址从 ELF 里解析出来', '0x' + Number(r.addr).toString(16));
  ok(/_SEGGER_RTT = 0x2000000C/i.test(r.sym) && /留空就用它/.test(r.sym), 'RTT 那一栏把地址显示给用户（并说明留空即用）', r.sym);
}

// ==================================================================== 13
console.log('== 13. 源码行（停下来显示当前代码行 + 点行号下断点）==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000040);          // SysTick_Handler 的首地址 = src/main.c:24
    await d.session.refreshRegs();
    await d.afterStop();
    await new Promise(r => setTimeout(r, 150));
    return { pos: document.getElementById('d-src-pos').textContent,
             leg: document.getElementById('d-src-file').textContent,
             cur: document.querySelector('#d-src .srcrow.cur')?.dataset.line,
             rows: document.querySelectorAll('#d-src .srcrow').length,
             text: document.getElementById('d-src').textContent.slice(0, 160) };`);
  ok(/main\.c:24/.test(r.pos), '工具条显示当前源码位置 main.c:24', r.pos);
  ok(/main\.c:24/.test(r.leg), '源码框标题也显示文件名:行号', r.leg);
  ok(r.cur === '24' && r.rows >= 1, '源码视图把当前行标出来（还没选源码目录时只显示行号 + 提示）', JSON.stringify(r).slice(0, 160));

  const bp = await ev(`
    const d = window.__tools.dbg;
    await d.session.bpClear();
    document.querySelector('#d-src .srcrow.cur .ln').click();
    await new Promise(r => setTimeout(r, 400));
    return { bps: d.session.bps.map(a => '0x' + a.toString(16)),
             out: document.getElementById('d-out').textContent.slice(-90),
             bpRows: document.querySelectorAll('#d-bp-list .bprow').length };`);
  ok(bp.bps.length === 1 && bp.bps[0] === '0x8000040', '点源码行号 → 在对应地址下硬件断点', JSON.stringify(bp));
  ok(/下了断点/.test(bp.out) && bp.bpRows === 1, '命令行与断点列表都反映了这次操作', bp.out.slice(-60));

  // 再点一下 = 删掉
  const bp2 = await ev(`
    const d = window.__tools.dbg;
    document.querySelector('#d-src .srcrow.cur .ln').click();
    await new Promise(r => setTimeout(r, 400));
    return d.session.bps.length;`);
  ok(bp2 === 0, '再点一下同一行 → 断点删掉（切换语义）', String(bp2));

  const sl = await ev(`
    const d = window.__tools.dbg;
    await d.runLine('sl');
    return document.getElementById('d-out').textContent.slice(-160);`);
  ok(/main\.c:24/.test(sl), '命令行 sl 打印当前源码位置', sl.slice(-80));

  /**
   * 真源码文本：CDP 点不了原生的「选择目录」弹框，所以这里塞一个**假的文件仓**
   * （只实现 view 用到的 ready/read），验证"拿到文本之后"的渲染与高亮这条链。
   */
  const view = await ev(`
    const d = window.__tools.dbg;
    const text = Array.from({ length: 60 }, (_, i) => '  code line ' + (i + 1)).join('\\n');
    window.__srcReal = d.src;
    d.src = { ready: true, count: 1, summary: () => '假仓', read: async () => text, resolve: () => ({ rel: 'src/main.c' }) };
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000040);
    await d.session.refreshRegs();
    await d.afterStop();
    await new Promise(r => setTimeout(r, 250));
    const rows = [...document.querySelectorAll('#d-src .srcrow')];
    const cur = document.querySelector('#d-src .srcrow.cur');
    return { rows: rows.length, first: rows[0]?.dataset.line, last: rows[rows.length - 1]?.dataset.line,
             curLine: cur?.dataset.line, curText: cur?.querySelector('.srctx').textContent,
             rowH: Math.round((cur?.getBoundingClientRect().height || 0) * 10) / 10,
             paneH: Math.round(document.getElementById('d-src').getBoundingClientRect().height),
             rowsVisible: Math.floor(document.getElementById('d-src').getBoundingClientRect().height / (cur?.getBoundingClientRect().height || 1)) };`);
  ok(view.rows >= 30 && view.curLine === '24', '有源码文本时画出行号窗口并高亮当前行', JSON.stringify(view).slice(0, 150));
  ok(/code line 24/.test(view.curText), '当前行的源码文本正确', view.curText);
  /**
   * 🚨 回归护栏：源码行原来叫 `.tx`，被「文本发送」输入框那条全局规则（`.tx{min-height:52px}`）命中，
   *    **每一行都被撑到 52px**（用户原话"行距太大太大了"，一屏只看得见 5 行）。
   *    现在类名是 `.srctx`，一行就是一行高（12px 字号 × 1.4 ≈ 17px）。
   */
  ok(view.rowH > 0 && view.rowH <= 22, `源码行高是正常的一行：${view.rowH}px（不是被撑到 52px）`, JSON.stringify(view));
  ok(view.rowsVisible >= 12, `一屏能看 ${view.rowsVisible} 行源码（面板 ${view.paneH}px）`, JSON.stringify(view));
  ok(Number(view.first) === 12 && Number(view.last) === 49, `上下文窗口是当前行前后若干行（${view.first}~${view.last}）`, JSON.stringify(view));

  const bpMark = await ev(`
    const d = window.__tools.dbg;
    await d.runLine('b 0x08000040');            // 当前行（main.c:24）对应的地址
    await new Promise(r => setTimeout(r, 250));
    return document.querySelectorAll('#d-src .srcrow.bp').length;`);
  ok(bpMark === 1, '源码行上已有断点时标出来（.bp 样式）', String(bpMark));
  await ev(`
    const d = window.__tools.dbg;
    d.src = window.__srcReal;
    d.srcShown = null;
    await d.session.bpClear();
    await d.renderSource();
    return 1;`);
}

// ==================================================================== 14
console.log('== 14. 命令行交互（Tab 补全 / Ctrl+C / Ctrl+L / 点输出区回焦点）==');
{
  const tab = await ev(`
    const cmd = document.getElementById('d-cmd');
    cmd.value = 'b SysT';
    cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 80));
    return cmd.value;`);
  ok(tab === 'b SysTick_Handler', 'Tab 补全符号名（唯一候选直接补上）', tab);

  const tab2 = await ev(`
    const cmd = document.getElementById('d-cmd');
    cmd.value = 'he';
    cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 80));
    return cmd.value;`);
  ok(tab2 === 'help ', 'Tab 补全命令名（补一个空格）', JSON.stringify(tab2));

  const clear = await ev(`
    const d = window.__tools.dbg;
    d._out('一堆日志');
    const before = document.getElementById('d-out').childNodes.length;
    const cmd = document.getElementById('d-cmd');
    cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 80));
    return { before, after: document.getElementById('d-out').childNodes.length };`);
  ok(clear.before > 0 && clear.after === 0, 'Ctrl+L 清屏', JSON.stringify(clear));

  const ctrlU = await ev(`
    const cmd = document.getElementById('d-cmd');
    cmd.value = 'md 0x20000000';
    cmd.focus();
    cmd.setSelectionRange(3, 3);
    cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 50));
    const v = cmd.value;
    cmd.value = '';
    return v;`);
  ok(ctrlU === '0x20000000', 'Ctrl+U 删掉光标前的内容（行编辑）', JSON.stringify(ctrlU));

  const ctrlC = await ev(`
    const cmd = document.getElementById('d-cmd');
    cmd.value = 'md 0x20000000';
    cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 100));
    return { v: cmd.value, cancel: window.__tools.dbg.cancelFlag, out: document.getElementById('d-out').textContent.slice(-40) };`);
  ok(ctrlC.cancel === true && ctrlC.v === '' && /\^C/.test(ctrlC.out), 'Ctrl+C 中断并清空输入行（输出里留 ^C）', JSON.stringify(ctrlC));
  await ev('window.__tools.dbg.cancelFlag = false; return 1;');

  const focus = await ev(`
    document.getElementById('d-cmd').blur();
    const out = document.getElementById('d-out');
    out.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    return document.activeElement?.id;`);
  ok(focus === 'd-cmd', '点输出区把焦点还给输入行（终端手感）', String(focus));

  const paste = await ev(`
    const cmd = document.getElementById('d-cmd');
    const dt = new DataTransfer();
    dt.setData('text', 'p g_bytes\\nmd 0x20000000 8');
    cmd.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 900));
    const d = window.__tools.dbg;
    return { queue: d.queue.length, out: document.getElementById('d-out').textContent.slice(-220) };`);
  ok(/粘贴了 2 行/.test(paste.out) && paste.queue === 0, '多行粘贴会排队一条条执行', paste.out.slice(-90));
}

// ==================================================================== 15
console.log('== 15. 版式：源码 + 命令行各占一块大的，右侧是「局部 tab」面板 ==');
{
  // 🚨 前置：本 profile 是共用的，版式尺寸/选中的 tab 会被上一次（手工或上一个套件）带偏 ——
  //    先清成默认值再量，否则断言的是"上一次留下的布局"（本仓踩过：命令行只剩 205px 直接判失败）
  await ev(`
    const st = JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}');
    delete st['dbg.termH']; delete st['dbg.dockW']; st['dbg.dock'] = 'regs';
    localStorage.setItem('serial-rtt-tools:v1', JSON.stringify(st));
    document.getElementById('d-box-term').style.flexBasis = '';
    document.getElementById('d-box-dock').style.flexBasis = '';
    window.__tools.dbg._dockSelect('regs', { save: false });
    await new Promise(r => setTimeout(r, 250));
    return 1;`);

  const r = await ev(`
    const rect = sel => document.querySelector(sel)?.getBoundingClientRect() || { width: 0, height: 0 };
    const src = rect('#d-box-src'), term = rect('#d-box-term'), dock = rect('#d-box-dock'), work = rect('.dbgwork');
    return { src: src.height, term: term.height, dockW: dock.width, dockH: dock.height, workW: work.width,
             leftW: rect('.dbgleft').width, out: rect('#d-out').height,
             rowLayout: Math.abs(src.left - dock.left) > 40 ? 'row' : 'stack',
             srcLeft: src.left, dockLeft: dock.left };`);
  ok(r.rowLayout === 'row' && r.dockH > r.src * 0.9, `右侧面板与源码并排、且和左列一样高（dock ${Math.round(r.dockH)} / src ${Math.round(r.src)}）`, JSON.stringify(r));
  /**
   * 🚨 这两个下限是**回归护栏**：源码那块是 `flex:1 1 0`，一旦被改回 `flex-basis:auto`，
   *    它会拿"整份源码的行数"当基准且不肯让 —— 实测命令行被压到 128px（拖都拖不动）。
   */
  ok(r.src >= 200, `源码区有足够高度：${Math.round(r.src)}px（≥200）`, JSON.stringify(r));
  ok(r.term >= 140 && r.out >= 100, `命令行输出可用：${Math.round(r.term)}px（输出区 ${Math.round(r.out)}px）`, JSON.stringify(r));
  ok(r.dockW >= 250 && r.dockW <= 760, `右侧面板宽度合理：${Math.round(r.dockW)}px`, JSON.stringify(r));
  ok(r.src + r.term > 300, '源码 + 命令行合起来占满左列（一块都没被挤扁）', JSON.stringify(r));

  // 局部 tab：一次只显示一个面板，点哪个显示哪个，选择记进 localStorage
  const tab = await ev(`
    const d = window.__tools.dbg;
    const pages = [...document.querySelectorAll('#d-box-dock .dockpage')];
    const visible = () => pages.filter(p => getComputedStyle(p).display !== 'none').map(p => p.dataset.dock);
    const seq = [visible()];
    for (const name of ['mem', 'var', 'svd', 'rtt', 'regs']){
      document.querySelector('#d-dock-tabs button[data-dock="' + name + '"]').click();
      await new Promise(r => setTimeout(r, 120));
      seq.push(visible());
    }
    return { seq, saved: JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}')['dbg.dock'], tabs: pages.length,
             on: [...document.querySelectorAll('#d-dock-tabs button')].filter(b => b.classList.contains('on')).map(b => b.dataset.dock) };`);
  ok(tab.tabs === 6, '右侧面板有 6 个 tab（寄存器/内存/变量/SVD/RTT/异常）', String(tab.tabs));
  ok(tab.seq.every(v => v.length === 1), '任何时刻只显示一个面板（不再平铺成小格子）', JSON.stringify(tab.seq));
  ok(JSON.stringify(tab.seq.map(v => v[0])) === JSON.stringify(['regs', 'mem', 'var', 'svd', 'rtt', 'regs']), '点 tab 真的切换面板', JSON.stringify(tab.seq));
  ok(tab.saved === 'regs' && tab.on.length === 1, 'tab 选择落进 localStorage，且只有一个是选中态', JSON.stringify(tab));

  // SVD 位域表：位段与访问权限必须保持单行，且所有行的右列边界一致，避免
  // `read-write` 换行后出现截图中那种行高和基线错乱。
  const svd = await ev(`
    const d = window.__tools.dbg;
    await d.loadBundledSvd();
    d._dockSelect('svd', { save: false });
    await new Promise(r => setTimeout(r, 120));
    const box = document.getElementById('d-svd-fields');
    const rows = [...box.querySelectorAll('.svdfield')];
    const rects = rows.map(row => ({ h: row.getBoundingClientRect().height,
      right: row.querySelector('.fb')?.getBoundingClientRect().right || 0 }));
    return { rows: rows.length, heights: [...new Set(rects.map(x => Math.round(x.h * 10) / 10))],
      rights: [...new Set(rects.map(x => Math.round(x.right * 10) / 10))],
      rightSpread: rects.length ? Math.max(...rects.map(x => x.right)) - Math.min(...rects.map(x => x.right)) : Infinity,
      nowrap: rows.every(row => getComputedStyle(row.querySelector('.fb')).whiteSpace === 'nowrap'),
      grid: rows[0] ? getComputedStyle(rows[0]).gridTemplateColumns : '' };
  `);
  ok(svd.rows > 0 && svd.heights.length === 1 && svd.rightSpread <= 1 && svd.nowrap,
    `SVD 位域表等高，右列误差 ≤1px（${svd.rows} 行，行高 ${svd.heights.join('/')}px）`, JSON.stringify(svd));
  await ev(`window.__tools.dbg._dockSelect('regs', { save: false }); return true;`);

  // 内存 tab 窄面板：一行字节数要按宽度自适应（否则横向溢出）
  const mem = await ev(`
    const d = window.__tools.dbg;
    document.querySelector('#d-dock-tabs button[data-dock="mem"]').click();
    document.getElementById('d-mem-addr').value = '0x20000000';
    document.getElementById('d-mem-len').value = '32';
    await d.readMem({ silent: true });
    await new Promise(r => setTimeout(r, 150));
    const rows = [...document.querySelectorAll('#d-mem .hxrow')];
    const box = document.getElementById('d-mem');
    return { cells: rows[0] ? rows[0].querySelectorAll('.by').length : 0, rows: rows.length,
             overflow: box.scrollWidth - box.clientWidth, width: Math.round(box.getBoundingClientRect().width) };`);
  ok(mem.cells === 8 || mem.cells === 16, `一格 ${mem.cells} 字节（按面板宽度 ${mem.width}px 自适应）`, JSON.stringify(mem));
  ok(mem.overflow <= 2, 'hexdump 不会横向溢出面板', JSON.stringify(mem));

  // 分隔条：拖动改尺寸并记住
  const grip = await ev(`
    const grip = document.getElementById('d-grip-term');
    const term = document.getElementById('d-box-term');
    const before = term.getBoundingClientRect().height;
    const y = grip.getBoundingClientRect().top + 3;
    const x = grip.getBoundingClientRect().left + 60;
    grip.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y - 90, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y - 90, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const after = term.getBoundingClientRect().height;
    const g2 = document.getElementById('d-grip-dock');
    const dock = document.getElementById('d-box-dock');
    const w0 = dock.getBoundingClientRect().width;
    const gx = g2.getBoundingClientRect().left + 4, gy = g2.getBoundingClientRect().top + 40;
    g2.dispatchEvent(new PointerEvent('pointerdown', { clientX: gx, clientY: gy, bubbles: true, cancelable: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: gx - 70, clientY: gy, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: gx - 70, clientY: gy, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const w1 = dock.getBoundingClientRect().width;
    const st = JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}');
    return { before, after, w0, w1, savedTerm: st['dbg.termH'], savedDock: st['dbg.dockW'] };`);
  ok(grip.after > grip.before + 60, `拖横分隔条把命令行拉高（${Math.round(grip.before)} → ${Math.round(grip.after)}px）`, JSON.stringify(grip));
  ok(grip.w1 > grip.w0 + 40, `拖竖分隔条把右侧面板拉宽（${Math.round(grip.w0)} → ${Math.round(grip.w1)}px）`, JSON.stringify(grip));
  ok(grip.savedTerm > 0 && grip.savedDock > 0, '两处尺寸都记进了 localStorage', JSON.stringify(grip));

  // 复原（共用 profile，别给下一个套件留坑）
  const reset = await ev(`
    const st = JSON.parse(localStorage.getItem('serial-rtt-tools:v1') || '{}');
    delete st['dbg.termH']; delete st['dbg.dockW']; st['dbg.dock'] = 'regs';
    localStorage.setItem('serial-rtt-tools:v1', JSON.stringify(st));
    document.getElementById('d-box-term').style.flexBasis = '';
    document.getElementById('d-box-dock').style.flexBasis = '';
    window.__tools.dbg._dockSelect('regs');
    await new Promise(r => setTimeout(r, 120));
    return true;`);
  ok(reset === true, '复原版式设置（不给下一个套件留坑）');
}

// ==================================================================== 16
console.log('== 16. 源码级单步：跳过 / 进入 / 跳出（真按钮 + 假目标）==');
{
  const has = await ev(`return ['d-step-over','d-step-into','d-step-out'].every(id => !!document.getElementById(id));`);
  ok(has === true, '工具栏上有「跳过 / 进入 / 跳出」三个按钮');

  const setPc = async (pc) => {
    await ev(`const d = window.__tools.dbg;
      await d.session.bpClear();
      await d.session.writeReg('PC', ${pc});
      await d.session.refreshRegs();
      await d.afterStop();
      await new Promise(r => setTimeout(r, 120));
      return true;`);
  };

  // ① 单步跳过：从 0x08000100 走到"下一行"（fixture 的行号表覆盖这里，是 SEGGER_RTT.c）
  await setPc('0x08000100');
  const next = await ev(`const L = window.__tools.dbg.sym.lines; const n = L.nextStmtAddr(0x08000100); return n ? n.addr : null;`);
  ok(typeof next === 'number' && next > 0x08000100, '页面里能算出"下一行地址"：0x' + (next >>> 0).toString(16));
  const over = await ev(`const d = window.__tools.dbg;
    document.getElementById('d-step-over').click();
    await new Promise(r => setTimeout(r, 1500));
    return { pc: '0x' + (d.session.pc >>> 0).toString(16), mode: d.session.lastStepMode,
             out: document.getElementById('d-out').textContent.slice(-120),
             bps: d.session.bps.length, pos: document.getElementById('d-src-pos').textContent };`);
  ok(over.pc === '0x' + (next >>> 0).toString(16) && over.mode === 'over', '「跳过」落在下一行：' + over.pc + '（' + over.pos + '）', JSON.stringify(over).slice(0, 160));
  ok(/单步跳过/.test(over.out), '日志里说明这一步做了什么', over.out.slice(-70));
  ok(over.bps === 0, '临时比较器收干净了');

  // ② 单步进入：当前位置不是调用 → 按指令级单步（并把原因写进日志）
  const into = await ev(`const d = window.__tools.dbg;
    const before = d.session.pc >>> 0;
    document.getElementById('d-step-into').click();
    await new Promise(r => setTimeout(r, 1500));
    return { before, pc: d.session.pc >>> 0, mode: d.session.lastStepMode,
             out: document.getElementById('d-out').textContent.slice(-160) };`);
  ok(into.pc > into.before && /into/.test(String(into.mode)), '「进入」在非调用处退化成指令级单步（PC 前进）', JSON.stringify(into).slice(0, 160));
  ok(/不是可静态解析的调用|指令级/.test(into.out), '日志里说清"为什么走指令级"（不许静默）', into.out.slice(-80));

  // ③ 单步跳出：LR 不是返回地址时必须拒绝（不许瞎跳）
  const outBad = await ev(`const d = window.__tools.dbg;
    await d.session.writeReg('LR', 0);
    document.getElementById('d-step-out').click();
    await new Promise(r => setTimeout(r, 800));
    return document.getElementById('d-out').textContent.slice(-160);`);
  ok(/不是返回地址|EXC_RETURN/.test(outBad), 'LR 无效时「跳出」明确拒绝并说明原因', outBad.slice(-90));

  // ④ 单步跳出：LR 被**本函数内部的调用**覆盖时（非叶子函数）也要能正确跳回调用者
  //    造一个有真栈帧的函数：PUSH{r7,lr} / BL / NOP / POP{r7,pc}，被调函数是 BX LR。
  //    走到"刚从一个内部调用返回"的位置时 LR 已变成 0x…46|1（不是返回地址）——
  //    页面必须能识别出这一点，用"单步走完本函数 + 看 SP 弹回"的方式回到调用者。
  const outOk = await ev(`
    const d = window.__tools.dbg, P = d.session.probe;
    const T = await import('/app/dbg/thumb.js');
    const put16 = (a, v) => { const o = a - 0x08000000; P.flash[o] = v & 0xff; P.flash[o + 1] = (v >> 8) & 0xff; };
    const [c1, c2] = T.encodeCall(0x08000242, 0x08000260);
    put16(0x08000240, 0xb580); put16(0x08000242, c1); put16(0x08000244, c2);
    put16(0x08000246, 0xbf00); put16(0x08000248, 0xbd80); put16(0x08000260, 0x4770);
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000240);
    await d.session.writeReg('LR', 0x08000050);          // 真正的返回地址（调用者）
    await d.session.refreshRegs();
    await d.session.step();                              // PUSH
    await d.session.step();                              // BL：LR 被覆盖
    await d.session.step();                              // BX LR：回到 0x08000246
    const lrMid = (await d.session.readReg('LR')) >>> 0;
    const sp0 = (await d.session.readReg('SP')) >>> 0;
    document.getElementById('d-step-out').click();
    await new Promise(r => setTimeout(r, 2500));
    return { lrMid: '0x' + lrMid.toString(16), sp0: '0x' + sp0.toString(16),
             pc: '0x' + (d.session.pc >>> 0).toString(16), sp: '0x' + ((await d.session.readReg('SP')) >>> 0).toString(16),
             mode: d.session.lastStepMode, out: document.getElementById('d-out').textContent.slice(-160), bps: d.session.bps.length };
  `);
  ok(outOk.pc === '0x8000050' && outOk.mode === 'out',
    `LR 被内部调用覆盖时「跳出」仍回到调用者：LR=${outOk.lrMid} → PC=${outOk.pc}（SP ${outOk.sp0} → ${outOk.sp}）`, JSON.stringify(outOk).slice(0, 200));
  ok(/覆盖/.test(outOk.out), '日志说清"LR 被覆盖、所以是一步步走回来的"', outOk.out.slice(-90));
  ok(outOk.bps === 0, '「跳出」之后比较器也收干净了');
  // 把造栈帧时占用的几个半字还原成 NOP（假目标的 flash 是共享的，别给后面的用例留坑）
  await ev(`const P = window.__tools.dbg.session.probe;
    for (const a of [0x08000240, 0x08000242, 0x08000244, 0x08000246, 0x08000248, 0x08000260]){
      const o = a - 0x08000000; P.flash[o] = 0x00; P.flash[o + 1] = 0xbf;
    }
    return true;`);
}

// ==================================================================== 17
console.log('== 17. 结构体树（监视窗口展开 + p 打成树）==');
{
  const add = await ev(`const d = window.__tools.dbg;
    d.clearWatch();
    const r = d.addWatch('_SEGGER_RTT');
    await new Promise(r2 => setTimeout(r2, 700));
    const row = document.querySelector('#d-watch-list .wrow');
    return { kind: d.watch.items[0]?.kind, typeName: d.watch.items[0]?.typeName,
             hasExp: !!row?.querySelector('button[data-exp]'), expText: row?.querySelector('button[data-exp]')?.textContent,
             val: d.watch.items[0]?.value?.text, dom: document.getElementById('d-watch-list').textContent.slice(0, 160) };`);
  ok(add.kind === 'struct' && add.hasExp === true, '结构体监视项带展开箭头（▸）', JSON.stringify(add).slice(0, 160));
  ok(add.expText === '▸', '默认是折叠的（▸）', String(add.expText));
  ok(/^\{/.test(String(add.val)) && /MaxNumUpBuffers/.test(String(add.val)), '折叠时给一行摘要：' + add.val);

  const expanded = await ev(`const d = window.__tools.dbg;
    document.querySelector('#d-watch-list button[data-exp]').click();
    await new Promise(r => setTimeout(r, 200));
    const kids = [...document.querySelectorAll('#d-watch-list .wkid')];
    return { n: kids.length, names: kids.map(k => k.querySelector('.nm').textContent),
             indents: kids.slice(0, 6).map(k => parseFloat(getComputedStyle(k.querySelector('.cell-name')).paddingLeft) || 0),
             expText: document.querySelector('#d-watch-list button[data-exp]')?.textContent,
             text: document.getElementById('d-watch-list').textContent.slice(0, 200) };`);
  ok(expanded.n >= 4 && expanded.names.includes('MaxNumUpBuffers'), `展开后画出成员行（${expanded.n} 行）`, JSON.stringify(expanded.names));
  ok(expanded.names.includes('acID') && expanded.names.includes('aUp'), '数组成员也在树里（acID / aUp）', JSON.stringify(expanded.names));
  ok(expanded.expText === '▾', '展开后箭头变 ▾');
  ok(Math.max(...expanded.indents) > 8, '成员行有缩进（比父行右）', JSON.stringify(expanded.indents));

  const collapsed = await ev(`const d = window.__tools.dbg;
    document.querySelector('#d-watch-list button[data-exp]').click();
    await new Promise(r => setTimeout(r, 150));
    return { kids: document.querySelectorAll('#d-watch-list .wkid').length,
             kept: d.watch.items[0].expanded === false };`);
  ok(collapsed.kids === 0 && collapsed.kept, '再点一下收起（成员行消失）');

  const pTree = await ev(`const d = window.__tools.dbg;
    await d.runLine('p _SEGGER_RTT');
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('d-out').textContent.slice(-20000);`);
  ok(/MaxNumUpBuffers/.test(pTree) && /RdOff|Flags/.test(pTree), '命令行 p <结构体> 打出成员行', pTree.slice(-120));
  ok(/@ 0x2000000c/.test(pTree), '树头写明变量地址（@ 0x2000000c）', pTree.slice(0, 120));
}

// ==================================================================== 18
console.log('== 18. 快捷键（F10/F11/Shift+F11）+ 源码行双击运行到光标 ==');
{
  const hot = await ev(`
    const d = window.__tools.dbg;
    document.querySelector('#tabs .tab[data-tab="dbg"]').click();      // 快捷键只在调试器页可见时生效
    await new Promise(r => setTimeout(r, 200));
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000100);
    await d.session.refreshRegs();
    await d.afterStop();
    await new Promise(r => setTimeout(r, 150));
    const before = d.session.pc >>> 0;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    const after = d.session.pc >>> 0;
    return { visible: d._visible(), before, after, mode: d.session.lastStepMode,
             out: document.getElementById('d-out').textContent.slice(-120) };`);
  ok(hot.visible === true, '调试器页当前可见（快捷键生效的前提）');
  ok(hot.after > hot.before && hot.mode === 'over', `F10 = 单步跳过（0x${hot.before.toString(16)} → 0x${hot.after.toString(16)}）`, JSON.stringify(hot).slice(0, 150));
  ok(/单步跳过/.test(hot.out), '快捷键走的是与按钮同一条路径（日志一致）', hot.out.slice(-70));

  const other = await ev(`const d = window.__tools.dbg;
    document.querySelector('#tabs .tab[data-tab="serial"]').click();  // 切走后快捷键必须失效
    await new Promise(r => setTimeout(r, 200));
    const before = d.session.pc >>> 0;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const after = d.session.pc >>> 0;
    document.querySelector('#tabs .tab[data-tab="dbg"]').click();
    await new Promise(r => setTimeout(r, 150));
    return { before, after };`);
  ok(other.after === other.before, '切到别的页签后 F10 不再拦（不影响别页）', JSON.stringify(other));

  const dbl = await ev(`const d = window.__tools.dbg;
    /**
     * 源码视图要有**行窗口**才能双击别的行 —— 没授权目录时只显示当前那一行。
     * 这里按 §13 的办法塞一个假文件仓（只实现 view 用到的 ready/read），测完就还原。
     */
    window.__srcReal2 = d.src;
    const text = Array.from({ length: 600 }, (_, i) => '  line ' + (i + 1)).join('\\n');
    d.src = { ready: true, count: 1, summary: () => '假仓', read: async () => text, resolve: () => ({ rel: 'SEGGER_RTT.c' }) };
    await d.session.bpClear();
    await d.session.writeReg('PC', 0x08000100);
    await d.session.refreshRegs();
    await d.afterStop();
    await new Promise(r => setTimeout(r, 300));
    const file = d.srcCur?.file || document.getElementById('d-src').dataset.file;
    let hit = null;
    for (const row of document.querySelectorAll('#d-src .srcrow')){
      const ln = Number(row.dataset.line);
      const a = d.sym.lines.addrOfLine(file, ln);
      if (a != null && a > 0x08000100 && a < 0x08000130){ hit = { row, ln, a }; break; }
    }
    if (!hit){ d.src = window.__srcReal2; return { err: '没有找到可用的目标行（源码视图里）' }; }
    hit.row.querySelector('.srctx').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    const out = { ln: hit.ln, want: '0x' + hit.a.toString(16), pc: '0x' + (d.session.pc >>> 0).toString(16),
                  out: document.getElementById('d-out').textContent.slice(-160), bps: d.session.bps.length,
                  kids: document.querySelectorAll('#d-src .srcrow').length };
    d.src = window.__srcReal2;                                  // 还原真仓库（不给下一个套件留坑）
    return out;`);
  ok(!dbl.err && dbl.pc === dbl.want && dbl.kids >= 20, `双击源码行 = 运行到这一行（第 ${dbl.ln} 行 → ${dbl.pc}）`, JSON.stringify(dbl).slice(0, 170));
  ok(/已运行到/.test(dbl.out || ''), '日志记下"已运行到哪一行"', String(dbl.out).slice(-70));
  ok(dbl.bps === 0, '运行到光标不会留下临时断点');
}

// ==================================================================== 19
console.log('== 19. 断开 + 收尾 ==');
{
  const r = await ev(`
    const d = window.__tools.dbg;
    await d.disconnect();
    await new Promise(r => setTimeout(r, 200));
    // 把界面选项复原（本 profile 是共用的：留在"模拟目标"上会让下一个套件/下次手工打开时意外）
    const be = document.getElementById('d-backend');
    be.value = 'webusb'; be.dispatchEvent(new Event('change'));
    d.clearWatch();
    return { sum: d.summary(), flag: document.getElementById('d-state').textContent,
             bus: d.bus === window.__tools.probeBus, backend: be.value };`);
  ok(r.sum.connected === false && r.flag === '未连接', '断开后状态回到未连接', JSON.stringify(r.sum));
  ok(r.bus === true, '调试页挂着跨页签的探针协调对象（probeBus）');
  ok(r.backend === 'webusb', '收尾把后端选回 WebUSB（不给下一个套件留坑）', r.backend);
  ok(r.sum.watch.length === 0, '收尾清空监视列表', JSON.stringify(r.sum.watch));
  const errs = await ev('return window.__tools.errors;');
  ok(Array.isArray(errs) && errs.length === 0, '整轮跑完页面没有未捕获错误', JSON.stringify(errs));
}

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
try { ws.close(); } catch {}
process.exit(fail ? 1 : 0);
