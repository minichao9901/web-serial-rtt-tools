/**
 * 把一份 ELF **用页面烧录器（WebUSB）烧进板子** —— 真机全流程 Makefile 目标共用的那一步。
 *
 *   node tools/selftest/flash-elf.mjs --board=f103ze        # 烧 F103ZE 的调试压测靶子
 *   node tools/selftest/flash-elf.mjs --board=h743          # 烧 H743 的调试压测靶子
 *   node tools/selftest/flash-elf.mjs --board=6800evk       # 烧 HPM6800EVK 的调试压测靶子
 *   node tools/selftest/flash-elf.mjs --chip=stm32f103 --elf=/tools/.../fw.elf    # 手填
 *
 * 为什么要有这个文件（而不是继续用 tmp/ 里的脚手架）：
 *   `make full_flow_*` 要能**一条命令跑完**，而流程中间必须把靶子固件换掉 ——
 *   跑完 `hw-campaign` 的板子上是"狂发/scope"固件，不是调试压测固件。
 *   以前这一步是 `node tmp/dbg-flash.mjs …` / `node tmp/rv-flash-and-smoke.mjs`，
 *   而 **tmp/ 在 .gitignore 里**（新克隆的仓库里根本没有这两个脚本）。
 *
 * 三条踩过的坑（照抄页面里那套，别自己发明）：
 *   ① **RISC-V 那条零安装通路不写 `#f-result`**（那是 ARM 通路的结论行）—— 判据要换成
 *      "忙过一轮 + 现在空闲 + 日志里有『烧写 OK / 校验 OK』"，否则要白等好几分钟；
 *   ② 烧之前先把别的会话（RTT / 转发 / 波形 / 调试器）**收干净**：探针的 vendor 接口
 *      同一时刻只能被一个句柄认领，留着就是 `Unable to claim interface`；
 *   ③ 烧完页面会自己看一眼"复位后核在哪取指"（`_bootCheck`）—— 那句日志直接透传出来，
 *      F103 那块板"只靠探针供电时 BOOT0 悬空 → 掉进 ROM"就是这个提示。
 */
import { Cdp, sleep, DEV_RE } from './cdp-lib.mjs';
import { artifact } from './board-matrix.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : (argv.includes('--' + k) ? true : d); };

/** 板子档案：芯片下拉 / 后端 / 目标类型 / 靶子固件 —— 与 dbg-hw-stress.mjs、hw-campaign*.mjs 对得上 */
const flowElf = id => '/' + artifact(id, 'dbgstress').replaceAll('\\', '/');
const BOARDS = {
  f103ze:  { label: 'STM32F103ZE', chip: 'stm32f103',  backend: 'webusb', target: 'swd',   elf: flowElf('f103ze'),  waitMs: 120000 },
  f103cb:  { label: 'STM32F103CB', chip: 'stm32f103',  backend: 'webusb', target: 'swd',   elf: flowElf('f103cb'), waitMs: 120000 },
  h743:    { label: 'STM32H743',   chip: 'stm32h7',    backend: 'webusb', target: 'swd',   elf: flowElf('h743'),  waitMs: 120000 },
  '6800evk': { label: 'HPM6800EVK', chip: 'hpm6800evk', backend: 'webusb', target: 'riscv', elf: flowElf('6800evk'), waitMs: 360000 },
  '5301evklite': { label: 'HPM5301EVKLite', chip: 'hpm5301evklite', backend: 'webusb', target: 'riscv', elf: flowElf('5301evklite'), waitMs: 360000 },
};
const BOARD_ID = String(arg('board', 'f103ze'));
const BOARD = BOARDS[BOARD_ID];
if (!BOARD) throw new Error(`--board 只认 ${Object.keys(BOARDS).join(' / ')}（给的是 ${BOARD_ID}）`);
const CHIP = String(arg('chip', BOARD.chip));
const BACKEND = String(arg('backend', BOARD.backend));
const TARGET = String(arg('target', BOARD.target));
const ELF = String(arg('elf', BOARD.elf));
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const CDP = process.env.CDP || 'http://127.0.0.1:9333';

/** 静态服务只能给"仓库内的绝对 URL 路径"；这里顺手把磁盘路径也认了，省得手算 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELF_URL = /^https?:/.test(ELF) ? ELF
  : (ELF.startsWith('/') ? ELF : '/' + resolve(ELF).slice(ROOT.length + 1).split('\\').join('/'));
const ELF_DISK = existsSync(resolve(ROOT, ELF_URL.replace(/^\//, '').split('/').join('\\')))
  ? resolve(ROOT, ELF_URL.replace(/^\//, '').split('/').join('\\')) : null;
if (!ELF_DISK) throw new Error(`找不到固件：${ELF}（换算成 URL 是 ${ELF_URL}；8899 的根 = 仓库根）`);

const WD = setTimeout(() => { console.error('[WATCHDOG] 8 分钟'); process.exit(9); }, 8 * 60 * 1000);
const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(6)}ms]`;

console.log(`== 烧录靶子固件 ==  板子 ${BOARD.label}（--board=${BOARD_ID}）`);
console.log(`   ${ELF_DISK}`);
console.log(`   (${(readFileSync(ELF_DISK).length / 1024).toFixed(1)} KB) · 芯片 ${CHIP} · 后端 ${BACKEND} · 目标类型 ${TARGET}`);

const cdp = new Cdp(CDP);
await cdp.connect();
await cdp.send('Page.navigate', { url: APP + '?t=' + Date.now() });
for (let i = 0; i < 100; i++){ await sleep(300); if (await cdp.eval('return !!window.__tools?.flash;').catch(() => false)) break; }
if (!await cdp.eval('return !!window.__tools?.flash;')) throw new Error('页面没起来（8899 服务 + 9333 浏览器在跑吗？见 make page-prep）');

/** ① 别的会话先让位（探针 vendor 接口一次只能一个句柄） */
await cdp.eval(`(async()=>{ const t = window.__tools;
    try { await t.dbg?.disconnect?.(); } catch (e){}
    try { await t.rtt?.disconnect?.(); } catch (e){}
    try { await t.scope?.releaseProbe?.('烧录前让位'); } catch (e){}
    try { await t.hid?.stop?.(); } catch (e){}
    try { await t.session?.close?.(); } catch (e){}
    try { await t.hid?.dev?.close?.(); } catch (e){}
    return true; })()`).catch(() => {});
await sleep(400);

/** ② 前置：芯片 / 后端 / 目标类型 / 时钟格（下拉是 store 绑定的，会被上一轮测试带偏） */
await cdp.eval(`document.querySelector('#tabs .tab[data-tab="flash"]').click(); await new Promise(r=>setTimeout(r,300)); return true;`);
const pre = await cdp.json(`(() => {
    const c = document.getElementById('f-chip'); const before = c.value;
    c.value = ${JSON.stringify(CHIP)}; c.dispatchEvent(new Event('change'));
    const b = document.getElementById('f-backend'); b.value = ${JSON.stringify(BACKEND)}; b.dispatchEvent(new Event('change'));
    const v = document.getElementById('f-verify'); if (v) v.checked = true;
    const r = document.getElementById('f-reset'); if (r) r.checked = true;
    const t = document.getElementById('f-target') || document.getElementById('h-target');
    if (t && [...t.options].some(o => o.value === ${JSON.stringify(TARGET)})){ t.value = ${JSON.stringify(TARGET)}; t.dispatchEvent(new Event('change')); }
    const k = document.getElementById('h-clock');
    if (k){ k.value = ''; k.dispatchEvent(new Event('change')); }        // RISC-V/JTAG 下这格必须留空
    const ra = document.getElementById('r-addr'); if (ra) ra.value = '';
    return { chipBefore: before, chip: c.value, chipText: c.options[c.selectedIndex]?.textContent || '',
             backend: b.value, target: t ? t.value : null, clock: k ? k.value : null };
  })()`);
console.log(`   芯片 ${pre.chipBefore || '(空)'} → ${pre.chip}（${pre.chipText}）· 后端 ${pre.backend} · 目标类型 ${pre.target} · 时钟格「${pre.clock ?? '—'}」`);
if (pre.chip !== CHIP) throw new Error(`芯片下拉里没有 ${CHIP}`);

/** ③ 把 ELF 喂进页面（线上来源取不到 build 产物也没关系：字节从磁盘读，走 File 传） */
const info = await cdp.json(`(async () => {
    const r = await fetch(${JSON.stringify(ELF_URL)} + '?t=' + Date.now());
    if (!r.ok) return { err: 'HTTP ' + r.status };
    await window.__tools.flash._onFile(new File([await r.arrayBuffer()], 'fw.elf'));
    return { name: window.__tools.flash.file?.name, size: window.__tools.flash.file?.size };
  })()`);
if (info.err) throw new Error(`取固件失败：${info.err}（${ELF_URL}；8899 静态服务起没起？）`);
console.log(`   已装载 ${info.name}（${info.size} B）`);

await cdp.eval(`document.getElementById('f-log').textContent=''; document.getElementById('f-result').textContent='—';
  const s = document.getElementById('f-status'); if (s) s.textContent='空闲'; return true;`);
await cdp.eval(`document.getElementById('f-flash').click()`, true);
for (let i = 0; i < 100 && cdp.prompts.length === 0; i++){
  if (await cdp.eval('return !!window.__tools.flash.busy;').catch(() => false)) break;
  await sleep(120);
}
if (cdp.prompts.length){ const dev = await cdp.pickDevice(DEV_RE); console.log(`   设备框自动选中：${dev.name}`); }

/** ④ 等结果：ARM 看 `#f-result`；RISC-V 那条路不写它，只能看日志（见文件头 ①） */
let res = '', status = '', wasBusy = false, flog = '';
const deadline = Date.now() + BOARD.waitMs;
while (Date.now() < deadline){
  const st = await cdp.json(`({ busy: !!window.__tools.flash.busy,
                               res: document.getElementById('f-result').textContent,
                               s: document.getElementById('f-status')?.textContent || '',
                               log: document.getElementById('f-log').textContent.slice(-800) })`);
  flog = st.log;
  if (st.busy) wasBusy = true;
  if (st.s !== status){ status = st.s; if (status.trim()) console.log(`   ${stamp()} ${status.trim()}`); }
  if (st.res && /✅|❌/.test(st.res)){ res = st.res.trim(); break; }
  if (wasBusy && !st.busy && /烧写 OK|校验 OK/.test(st.log)){ res = '✅ 烧写 OK + 校验 OK（RISC-V 通路）'; break; }
  await sleep(150);
}
const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`   结果：${res || '（等超时）'}（用时 ${wall}s）`);
const boot = String(flog).split('\n').filter(l => /复位后 PC=|ROM bootloader|系统存储器/.test(l));
if (boot.length) console.log('   --- 页面关于"复位后核在哪"的判断 ---\n' + boot.map(l => '   ' + l.trim()).join('\n'));
console.log('   --- 烧录日志尾部 ---\n' + String(flog).split('\n').slice(-6).map(l => '   ' + l.trim()).join('\n'));
await cdp.eval('await window.__tools.flash.disconnect?.(); return true;').catch(() => {});
clearTimeout(WD);
cdp.close();
if (!/✅/.test(res)){ console.error(`\n!! 烧录没成功：${res || '等超时'}`); process.exit(1); }
console.log('\n✅ 靶子固件已烧进板子');
process.exit(0);
