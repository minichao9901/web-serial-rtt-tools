/**
 * 认板子：在**真页面**上点「读 IDCODE」，把目标身份读出来并判决 —— 跑任何真机流程之前的**硬前置**。
 *
 *   node tools/selftest/read-idcode.mjs                    # 只读 + 打印身份（人工看）
 *   node tools/selftest/read-idcode.mjs --board=f103ze     # 按板子档案判决：型号对不上就退 1
 *   node tools/selftest/read-idcode.mjs --board=h743
 *   node tools/selftest/read-idcode.mjs --board=6800evk
 *   node tools/selftest/read-idcode.mjs --chip=stm32f7     # 只换芯片下拉（不判决）
 *
 * 为什么要有这一步（用户 2026-10 定的规矩）：
 *   **换板子 / 换探针之后必须先认板子再跑流程。** 流程里每一步都跟着"是哪块板"走 ——
 *   烧哪份靶子固件、RTT 控制块去哪个窗口找、判决线取哪一套、复位/唤醒怎么走；
 *   认错板的代价是一整轮十几分钟跑在错的假设上，而且失败信息看着像"工具坏了"。
 *   读一次 IDCODE 只要两秒，先花掉它。
 *
 * 判据来自页面自己那条路（`flash.readIdcode()`，也就是「读 IDCODE」按钮）：
 *   · ARM/SWD：DP IDCODE（0x1BA01477 = Cortex-M3 的 SW-DP、0x6BA02477 = M7）
 *     → CPUID（认内核）→ STM32 DBGMCU DEV_ID（**这个才认得出型号**）→ flash 容量寄存器；
 *   · RISC-V/JTAG：TAP IDCODE（HPM6800 是 0x1000563D）。
 */
import { Cdp, sleep, DEV_RE } from './cdp-lib.mjs';

const argv = process.argv.slice(2);
const argV = (k, d) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : d; };
const has = k => argv.includes('--' + k);

/**
 * 板子档案：**只放"认板子"要用的判据**（型号名 + IDCODE/DEV_ID 的特征）。
 * key 与 Makefile 的 `--board=`、dbg-hw-stress.mjs / flash-elf.mjs 的档案一一对应。
 */
const BOARDS = {
  f103ze: {
    label: 'STM32F103ZE（本机那块 · Cortex-M3）',
    chip: 'stm32f103', target: 'swd',
    idcode: /1BA01477/i,                 // Cortex-M3 的 SW-DP
    dev: /DEV_ID\s+0x414\b/i,
    flash: /flash\s*容量[^\n]*=\s*512\s*KB/i,
    note: 'Cortex-M3 · 512KB flash / 64KB RAM · 6 个 FPB 比较器',
  },
  f103cb: {
    label: 'STM32F103CB（当前板 · Cortex-M3）',
    chip: 'stm32f103', target: 'swd',
    idcode: /1BA01477/i,
    dev: /DEV_ID\s+0x410\b/i,
    flash: /flash\s*容量[^\n]*=\s*128\s*KB/i,
    note: 'Cortex-M3 · 128KB flash / 20KB RAM · 6 个 FPB 比较器',
  },
  h743: {
    label: 'STM32H743（阿波罗 H743 · Cortex-M7）',
    chip: 'stm32h7', target: 'swd',
    idcode: /6BA02477/i,                 // Cortex-M7 的 SW-DP
    dev: /DEV_ID 0x450\b|H74[0-9]|H742\/743/i,
    flash: null,
    note: 'Cortex-M7 · 8 个 FPB 比较器 · RTT 控制块要放 AXI SRAM(0x24000000)',
  },
  '6800evk': {
    label: 'HPM6800EVK（RISC-V/JTAG）',
    chip: 'hpm6800evk', target: 'riscv',
    idcode: /1000563D/i,                 // JTAG TAP IDCODE
    dev: null,
    flash: null,
    note: 'RISC-V · 走 JTAG + DMI/SBA；探针的 output_mode 必须是 SWD+JTAG',
  },
  '5301evklite': {
    label: 'HPM5301EVKLite（RISC-V/JTAG）',
    chip: 'hpm5301evklite', target: 'riscv',
    idcode: /1000563D/i,                 // HPM RISC-V TAP IDCODE；不能单独区分具体 HPM 型号
    dev: null,
    flash: null,
    note: 'RISC-V · JTAG + DMI/SBA；IDCODE 确认 TAP 通路，型号由板卡配置档指定',
  },
};
const BOARD_ID = argV('board', '');
const BOARD = BOARD_ID ? BOARDS[BOARD_ID] : null;
if (BOARD_ID && !BOARD) throw new Error(`--board 只认 ${Object.keys(BOARDS).join(' / ')}（给的是 ${BOARD_ID}）`);
const CHIP = argV('chip', BOARD?.chip || 'stm32f103');
const APP = process.env.APP || 'http://127.0.0.1:8899/index.html';
const CDP = process.env.CDP || 'http://127.0.0.1:9333';

const WD = setTimeout(() => { console.error('[WATCHDOG] 3 分钟'); process.exit(9); }, 180000);

console.log(`== 认板子（读 IDCODE）==  ${BOARD ? BOARD.label + `（--board=${BOARD_ID}）` : '（不判决，只打印）'}`);
if (BOARD) console.log(`   该板档案：芯片下拉 ${BOARD.chip} · 目标类型 ${BOARD.target} · ${BOARD.note}`);

const cdp = new Cdp(CDP);
await cdp.connect();
await cdp.send('Page.navigate', { url: APP + '?idcode=' + Date.now() + '#flash' });
for (let i = 0; i < 100; i++){ await sleep(300); if (await cdp.eval('return !!window.__tools?.flash;').catch(() => false)) break; }
if (!await cdp.eval('return !!window.__tools?.flash;')) throw new Error('页面没起来（8899 服务 + 9333 浏览器在跑吗？见 make page-prep）');
try { await cdp.send('Page.bringToFront'); } catch {}

/** 前置：后端/芯片/目标类型（下拉是 store 绑定的，会被上一轮测试带偏 → 打印改前→改后） */
const pre = await cdp.json(`(() => {
    const $ = id => document.getElementById(id);
    const before = { backend: $('f-backend').value, chip: $('f-chip').value };
    $('f-backend').value = 'webusb'; $('f-backend').dispatchEvent(new Event('change'));
    $('f-chip').value = ${JSON.stringify(CHIP)}; $('f-chip').dispatchEvent(new Event('change'));
    const t = $('f-target') || $('h-target');
    if (t && ${JSON.stringify(BOARD?.target || 'swd')} && [...t.options].some(o => o.value === ${JSON.stringify(BOARD?.target || 'swd')})){
      t.value = ${JSON.stringify(BOARD?.target || 'swd')}; t.dispatchEvent(new Event('change'));
    }
    const k = $('h-clock'); if (k){ k.value = ''; k.dispatchEvent(new Event('change')); }
    $('f-log').textContent = '';
    return { before, chip: $('f-chip').value, backend: $('f-backend').value, target: t ? t.value : null, busy: !!window.__tools.flash.busy };
  })()`);
console.log(`   芯片 ${pre.before.chip || '(空)'} → ${pre.chip} · 后端 ${pre.backend} · 目标类型 ${pre.target}`);

/** 必须派发真实 CDP 鼠标输入，而不是直接调用 readIdcode() 或 HTMLElement.click()：
 * WebUSB.requestDevice 只允许从真实用户手势打开授权框。此处和页面中的按钮点击走同一条路径。 */
const point = await cdp.json(`(() => {
  const b = document.getElementById('f-idcode');
  if (!b) throw new Error('找不到读 IDCODE 按钮');
  b.scrollIntoView({block:'center'});
  const r = b.getBoundingClientRect();
  if (!r.width || !r.height) throw new Error('读 IDCODE 按钮当前不可见');
  return {x:r.x+r.width/2,y:r.y+r.height/2};
})()`);
await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:point.x, y:point.y });
await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 });
await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 });

const t0 = Date.now();
let picked = null, actionError = '';
let finished = false;
const waitMs = Math.max(1000, Number(process.env.IDCODE_WAIT_MS) || 60000);
const deadline = t0 + waitMs;
while (Date.now() < deadline){
  if (cdp.prompts.length){
    const prompt = cdp.prompts.shift();
    const device = prompt.devices.find(d => DEV_RE.test(d.name));
    if (!device){
      actionError = `USB 授权列表没有匹配的 akaLink/DAP 探针（可见 ${prompt.devices.length} 个设备）`;
      await cdp.sendBrowser('DeviceAccess.cancelPrompt', { id:prompt.id }).catch(() => {});
      break;
    }
    await cdp.sendBrowser('DeviceAccess.selectPrompt', { id:prompt.id, deviceId:device.id });
    picked = device.name;
  }
  const log = await cdp.eval(`return document.getElementById('f-log')?.textContent || '';`).catch(() => '');
  if (/──── 读完|── 出错 ──|❌|NO ACK|FAULT/.test(log)){ finished = true; break; }
  await sleep(150);
}
if (!finished && !actionError) actionError = `等待 IDCODE 读取结束超时（${waitMs} ms）`;
const ms = Date.now() - t0;
const text = await cdp.eval(`return document.getElementById('f-log').textContent;`).catch(() => '') || '';

const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
const body = lines.filter(l => /^[①②③④⑤]|⇒ 判读|────/.test(l));
console.log(`\n---- 页面日志（读身份那段，用时 ${ms} ms）----`);
for (const l of body) console.log('   ' + l);
if (picked) console.log(`   USB 授权：${picked}`);
if (actionError) console.log(`   （认板操作中止：${actionError}）`);

const all = lines.join('\n');
const gotIdcode = /DP IDCODE|TAP IDCODE|IDCODE/i.test(all);
const idcodeOk = BOARD ? BOARD.idcode.test(all) : gotIdcode;
const devOk = BOARD?.dev ? BOARD.dev.test(all) : true;
const flashOk = BOARD?.flash ? BOARD.flash.test(all) : true;
const errish = !gotIdcode && (!!actionError || /NO ACK|FAULT|读失败|连不上|超时|── 出错 ──/.test(all));

clearTimeout(WD);
cdp.close();

console.log('\n---- 判读 ----');
if (errish && !gotIdcode){
  console.error('❌ 没读到 IDCODE（链路/目标不在状态）—— 先修链路再跑流程：');
  console.error('   · 谁占着探针：node tmp/probe-free.mjs（放掉所有页签会话）→ node tmp/usb-holders.mjs 看');
  console.error('   · 目标/探针需要复位：node tmp/hw-heal.mjs（teardown → 重连）');
  for (const l of lines.filter(l => /NO ACK|FAULT|读失败/.test(l)).slice(-4)) console.error('   · ' + l);
  process.exit(1);
}
if (!BOARD){
  console.log('（没给 --board，不判决；上面就是目标的身份）');
  process.exit(0);
}
if (idcodeOk && devOk && flashOk){
  console.log(`✅ 板上就是 ${BOARD.label}`);
  process.exit(0);
}
console.error(`❌ 板上**不是** ${BOARD.label}：IDCODE 特征 ${idcodeOk ? '匹配' : '不匹配'} · DEV_ID 特征 ${devOk ? '匹配' : '不匹配'} · Flash 容量 ${flashOk ? '匹配' : '不匹配'}`);
console.error('   换板子之后请跑对应那条流程（full_flow_f103ze / full_flow_f103cb / full_flow_h743 / full_flow_6800evk），别硬跑。');
process.exit(1);
