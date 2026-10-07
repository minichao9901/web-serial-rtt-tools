/**
 * 纯 Node 自测：调试页的**逻辑层**（不需要浏览器、不需要硬件）。
 *
 *   node tools/selftest/dbg-core.test.mjs      （等价：make test-dbg）
 *
 * 覆盖四块，都是"错了会静默给错答案"的地方：
 *   1) 位域与编码：xPSR 的拆位、CFBP 的字节顺序（PRIMASK 在最低字节）、FPB 比较器的编码
 *      —— 这几个数字查过 OpenOCD/pyOCD 的实现，钉在这里防止以后被"顺手改回去"；
 *   2) 输入解析：md/mw 的地址与字节串（连续十六进制、奇数长度、越界值都必须报错而不是猜）；
 *   3) 符号表：找函数/变量、`名字+偏移` 解析、PC 落点；
 *   4) **整条会话链**：用 app/dbg/mock.js 那个假目标跑
 *      「连接 → 读寄存器 → 写内存 → 下断点 → 继续 → 命中断点 → 再继续（跨过断点）」，
 *      —— 这是页面上的按钮真正会走的那条路径，只是把 DOM 换成了断言。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const url = p => 'file://' + join(here, '..', '..', 'app', p).replace(/\\/g, '/');
const F = await import(url('dbg/fmt.js'));
const R = await import(url('dbg/regs.js'));
const B = await import(url('dbg/bp.js'));
const SY = await import(url('dbg/symbols.js'));
const C = await import(url('dbg/cmd.js'));
const S = await import(url('dbg/session.js'));
const W = await import(url('dbg/watch.js'));
const CP = await import(url('dbg/complete.js'));
const LN = await import(url('elf/lines.js'));
const TB = await import(url('dbg/thumb.js'));

/** 路径的最后一段（自测里报"哪个文件第几行"用） */
const base = p => String(p || '').replace(/\\/g, '/').split('/').pop();

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================================================================== 1
console.log('== 1. 数字与字节串的解析（命令行的地基）==');
{
  ok(F.parseNum('0x20000000') === 0x20000000, 'parseNum 认 0x 前缀');
  ok(F.parseNum('2000h') === 0x2000, 'parseNum 认尾缀 h');
  ok(F.parseNum('0b1010') === 10, 'parseNum 认二进制');
  ok(F.parseNum('64') === 64, 'parseNum 十进制（不是十六进制！）');
  ok(F.parseNum('1_000') === 1000, 'parseNum 忽略下划线分隔');
  ok(F.parseNum('0xZZ') === null && F.parseNum('') === null && F.parseNum('abc') === null, 'parseNum 认不出就回 null（不静默当 0）');

  const a = F.parseBytes('01 02 ff');
  ok(a.length === 3 && a[0] === 1 && a[2] === 0xff, 'parseBytes 空格分隔');
  ok(F.parseBytes('0x01,0x02').length === 2, 'parseBytes 逗号 + 0x 前缀');
  ok(F.parseBytes('0102ff').length === 3, 'parseBytes 连续写法（偶数长度）');
  let threw = '';
  try { F.parseBytes('0102f'); } catch (e){ threw = e.message; }
  ok(/偶数/.test(threw), 'parseBytes 奇数长度连续写法必须报错（不能猜）', threw);
  threw = '';
  try { F.parseBytes('01 1ff'); } catch (e){ threw = e.message; }
  ok(/不是一个字节/.test(threw), 'parseBytes 超过 0xff 必须报错', threw);

  const dump = F.hexdump(Uint8Array.from([0x48, 0x69, 0x21, 0x00]), 0x20000000);
  ok(dump.length === 1 && dump[0].startsWith('0x20000000  48 69 21 00'), 'hexdump 首行地址与字节', dump[0]);
  ok(dump[0].includes('|Hi!.') && dump[0].includes('|'), 'hexdump 右侧 ASCII 列', dump[0]);
  const two = F.hexdump(new Uint8Array(20), 0x1000);
  ok(two.length === 2 && two[1].includes('0x00001010'), 'hexdump 按 16 字节分行且第二行地址正确', two[1]);
  ok(F.readLE(Uint8Array.from([0x11, 0x22, 0x33, 0x44])) === 0x44332211, 'readLE 小端');
}

// ==================================================================== 2
console.log('== 2. 寄存器位域（xPSR / CFBP）==');
{
  ok(R.regInfo('R0').sel === 0 && R.regInfo('r15').name === 'PC', '寄存器名大小写不敏感、r15=PC');
  ok(R.regInfo('SP').sel === 0x0d && R.regInfo('psp').sel === 0x12, 'SP/PSP 的 REGSEL 正确');
  ok(R.regInfo('nope') === null, '不认识的寄存器回 null');

  const x = R.decodeXpsr(0x41000000);        // Z(30) + T(24)
  ok(x.z === 1 && x.n === 0 && x.t === 1, 'xPSR：Z 在 bit30、T 在 bit24');
  ok(R.decodeXpsr(0x00000010).isr === 16, 'xPSR：IPSR 在 [8:0]（异常号）');
  const it = R.decodeXpsr((3 << 25) | (0x2a << 10));   // IT = {[26:25]=11, [15:10]=101010}
  ok(it.it === 0xea, `xPSR：IT 拆在两段（[26:25] 是高位）→ 0x${it.it.toString(16)}`);
  ok(/Z=1/.test(R.formatXpsr(0x41000000)) && /Handler #3/.test(R.formatXpsr(3)), 'formatXpsr 有人话（含 Handler）');

  const f = R.setXpsrFlags(0x01000000, { z: 1, c: 0 });
  ok(f === 0x41000000, 'setXpsrFlags 只动指定标志位（T 位等原样保留）', '0x' + f.toString(16));

  // CFBP 的字节顺序：依据 OpenOCD armv7m.c（PRIMASK 在最低字节、CONTROL 在最高字节）
  const packed = R.cfbpSet(R.cfbpSet(0, 'PRIMASK', 1), 'CONTROL', 2);
  ok(packed === 0x02000001, 'CFBP 打包：PRIMASK→byte0、CONTROL→byte3', '0x' + packed.toString(16));
  ok(R.cfbpGet(0x00010203, 'PRIMASK') === 1 && R.cfbpGet(0x00010203, 'BASEPRI') === 0x02
     && R.cfbpGet(0x00010203, 'FAULTMASK') === 1 && R.cfbpGet(0x00010203, 'CONTROL') === 0,
     'CFBP 拆包：byte0=PRIMASK / byte1=BASEPRI / byte2=FAULTMASK / byte3=CONTROL');
  ok(R.cfbpSet(packed, 'PRIMASK', 0) === 0x02000000, 'CFBP 改一个字节不会碰兄弟字节');
  ok(/非特权/.test(R.formatControl(1)) && /用 PSP/.test(R.formatControl(2)), 'CONTROL 的人话（nPRIV/SPSEL）');
}

// ==================================================================== 3
console.log('== 3. FPB 硬件断点的编码 ==');
{
  const ctrl = B.decodeFpCtrl(0x00000080);
  ok(ctrl.numCode === 8 && ctrl.rev === 1, 'FP_CTRL=0x80 → 8 个比较器、rev1（Cortex-M7 的排法）', JSON.stringify(ctrl));
  ok(B.decodeFpCtrl(0x10000080).rev === 2, 'REV 字段在 [31:28]（0x1 → rev2）');

  ok(B.canBreak(0x08000123, 1) === true && B.canBreak(0x90000000, 1) === false,
     'rev1 只能匹配 0x20000000 以下的地址（H7 的 QSPI 代码就打不了）');
  ok(B.canBreak(0x90000000, 2) === true, 'rev2 地址不限');

  const even = B.encodeComparator(0x08000100, 1);
  ok(even === 0x48000101, 'rev1 偶数地址 → (addr&~3) | BP_MATCH(0x1<<30) | ENABLE', '0x' + even.toString(16));
  const odd = B.encodeComparator(0x08000102, 1);
  ok(odd === 0x88000101, 'rev1 上半字地址 → BP_MATCH(0x2<<30)（bit1 不进地址字段）', '0x' + odd.toString(16));
  ok(B.decodeComparator(odd, 1).addr === 0x08000102, 'rev1 解码要把 bit1 从 BP_MATCH 还回来', '0x' + B.decodeComparator(odd, 1).addr.toString(16));
  ok(B.encodeComparator(0x08000102, 2) === 0x08000103, 'rev2 只按半字对齐 + ENABLE');
  ok(B.decodeComparator(even, 1).addr === 0x08000100 && B.decodeComparator(even, 1).enabled === true,
     '编码 → 解码可往返（探针回读对账靠它）');

  const plan = B.planComparators([0x08000100, 0x08000200, 0x90000000], 2, 1);
  ok(plan.slots.length === 2 && plan.slots[0] !== null && plan.slots[1] !== null, 'planComparators 按顺序填槽位');
  ok(plan.bad.length === 1 && plan.bad[0] === 0x90000000, '超出匹配范围的地址单独报出来（不静默丢）');
  const over = B.planComparators([1, 2, 3], 2, 1);
  ok(over.overflow.length === 1 && over.overflow[0] === 3, '装不下的断点进 overflow');
}

// ==================================================================== 4
console.log('== 4. 符号表（拿真 ELF 当靶子）==');
const elfPath = join(here, '..', 'fixtures', 'dwarf', 'stm32f103_rtt_speed.elf');
const elfBuf = readFileSync(elfPath);
let symtab = null;
{
  symtab = SY.SymTab.fromBuffer(new Uint8Array(elfBuf));
  ok(symtab.size > 50, `解析出 ${symtab.size} 个符号`);
  const rtt = symtab.find('_SEGGER_RTT');
  ok(rtt && rtt.addr === 0x2000000c && rtt.size === 96, '_SEGGER_RTT 的地址/大小正确', JSON.stringify(rtt));
  const f = symtab.find('SysTick_Handler');
  ok(f && f.kind === 'func' && f.addr === 0x08000040, '按名字找到函数并给出类型', JSON.stringify(f));

  const at = symtab.funcAt(0x08000044);
  ok(at && at.name === 'SysTick_Handler' && at.off === 4 && at.exact, 'PC 落点：函数名 + 偏移', JSON.stringify(at));
  ok(symtab.nameOf(0x08000044) === 'SysTick_Handler+0x4', 'nameOf 的人话格式');

  const r1 = symtab.resolve('SysTick_Handler+0x8');
  ok(r1 && r1.addr === 0x08000048, 'resolve 支持「符号+偏移」', JSON.stringify(r1));
  const r2 = symtab.resolve('0x2000000c');
  ok(r2 && r2.addr === 0x2000000c && r2.sym === null, 'resolve 支持裸十六进制');
  const r3 = symtab.resolve('&g_bytes');
  ok(r3 && r3.addr === 0x20000000, 'resolve 支持 &变量');
  ok(symtab.resolve('不存在的符号') === null, 'resolve 找不到就回 null（命令层要报错）');

  const hits = symtab.search('RTT');
  ok(hits.length >= 3 && hits.some(h => h.name === '_SEGGER_RTT'), `sym 搜索命中 ${hits.length} 条`);
  ok(/符号/.test(symtab.summary()), 'summary 有人话摘要：' + symtab.summary());
}

// ==================================================================== 5
console.log('== 5. 会话 + 假目标：真跑一遍调试动作 ==');
const session = new S.DebugSession();
const logs = [];
session.log = (t, c) => logs.push((c ? `[${c}] ` : '') + t);
let haltWait = null;                     // 轮询等目标停下（页面里由 _watchLoop 干这件事）
{
  await session.connect({ mock: true });
  ok(session.connected, '连上假目标');
  ok(session.halted === true, '连上时的状态是"已停止"');
  ok(session.caps.numCode === 8 && session.caps.rev === 1, '读到 FPB 能力：8 个比较器 rev1', JSON.stringify(session.caps));

  const regs = await session.refreshRegs();
  ok(regs.length === 23, `读回 23 个寄存器（19 内核含 MSP/PSP/XPSR + 4 个特殊）`, String(regs.length));
  const pc = regs.find(r => r.name === 'PC').value;
  ok(pc === 0x08000100, '复位向量取到了代码区入口', '0x' + pc.toString(16));
  ok(regs.find(r => r.name === 'SP').value === 0x20010000, 'SP 来自向量表');
  ok((regs.find(r => r.name === 'XPSR').value >>> 24 & 1) === 1, 'xPSR.T = 1（Thumb）');

  // 写寄存器
  await session.writeReg('R0', 0xdeadbeef);
  ok(await session.readReg('R0') === 0xdeadbeef, '读回写进去的 R0');
  await session.writeReg('PC', 0x08000200);
  ok(await session.readReg('PC') === 0x08000200, '改 PC 生效');

  // CFBP：写 PRIMASK 不应碰 CONTROL（字节顺序的端到端验证）
  await session.writeReg('CONTROL', 2);
  await session.writeReg('PRIMASK', 1);
  const cfbpRaw = await session.readReg('cfbp');
  ok(cfbpRaw === 0x02000001, 'CFBP 端到端：PRIMASK=1 落在 byte0、CONTROL=2 落在 byte3', '0x' + cfbpRaw.toString(16));
  ok(await session.readReg('PRIMASK') === 1 && await session.readReg('CONTROL') === 2, '两个特殊寄存器各读各的');
  await session.writeReg('PRIMASK', 0);

  // 内存
  await session.memWrite(0x20000000, Uint8Array.from([0x11, 0x22, 0x33, 0x44]));
  const back = await session.memRead(0x20000000, 4);
  ok(back[0] === 0x11 && back[3] === 0x44, '写内存后回读一致');
  let flashErr = '';
  try { await session.memWrite(0x08000000, Uint8Array.of(1)); } catch (e){ flashErr = e.message; }
  ok(/flash/.test(flashErr), '写 flash 会被拒绝（假目标与真板子一致：本页不做烧录）', flashErr);

  // 断点：下在 PC 前面，继续，等它命中
  await session.bpAdd(0x08000300);
  ok(session.bpList().length === 1 && session.bpList()[0].addr === 0x08000300, '断点加进去了');
  ok(session.caps.numCode === 8 || session.bpCapacity === 8, '硬件上限 = FPB 报的 8 个比较器');
  await session.cont();
  ok(session.halted === false, '「继续」之后目标在跑');
  haltWait = async (ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms){
      await sleep(30);
      await session.refresh();
      if (session.halted) return true;
    }
    return false;
  };
  ok(await haltWait(), '目标在 3 s 内停了下来（命中假目标里的 FPB 比较器）');
  ok(session.pc === 0x08000300, '停在了断点地址上', '0x' + session.pc.toString(16));

  // 再继续：应当"跨过断点"后绕一圈再命中，而不是原地卡住
  await session.cont();
  const t1 = Date.now();
  ok(await haltWait(3000), '第二次「继续」也命中（跨过断点后绕回来）');
  ok(session.pc === 0x08000300, '仍停在同一地址（说明真的跨过去又回来了）', '0x' + session.pc.toString(16));
  ok(Date.now() - t1 > 20, '跨过断点确实是"跑了一段"而不是立即返回');

  // 单步：从断点地址起步应当往前走 2 字节（step 内部会临时摘掉比较器）
  await session.step();
  ok(session.pc === 0x08000302, '在断点处单步能走开（临时摘比较器）', '0x' + session.pc.toString(16));
  ok(session.bpList().length === 1, '单步之后比较器装回去了');
  ok(session.lastStepMode === 'dhcsr', `C_STEP 能用时走主路径（mode=${session.lastStepMode}）`);

  /* ---- 兜底：这颗探针/内核**不执行 C_STEP**（2026-10-02 真机 akaLinkPro + F103ZE 实测）----
   * 症状：DHCSR 恒回 0x30007、S_HALT 从不掉、PC 一动不动；旧代码静默当成功返回
   *       → 用户看到"点了单步没反应"。现在必须自己发现并改用「断点单步」。 */
  session.probe.brokenCStep = true;
  const pcBefore = session.pc;
  const logsBefore = logs.length;
  const mode = await session.step();
  ok(mode === 'breakpoint', `C_STEP 不生效时自动改用断点单步（mode=${mode}）`);
  ok(session.pc === pcBefore + 2, `兜底单步真的让 PC 前进了 ${pcBefore.toString(16)} → ${session.pc.toString(16)}`);
  ok(session.bpList().length === 1, '兜底的临时比较器收干净了（只剩用户那一个断点）');
  ok(logs.slice(logsBefore).some(l => /C_STEP 没让目标前进|不执行 C_STEP/.test(l)), '日志里说清了"为什么改走断点单步"（不许静默降级）：' + logs.slice(logsBefore).join(' | ').slice(0, 160));
  const mode2 = await session.step();
  ok(mode2 === 'breakpoint' && session.pc === pcBefore + 4, `连续单步也稳（连续两次都前进：0x${session.pc.toString(16)}）`);
  ok(session._cStepWorks === false, '记住了"C_STEP 不可用"，第二次单步不再白等 400ms 试探');
  session.probe.brokenCStep = false;
  /**
   * "C_STEP 不可用"是**粘性**结论（一次试探 400 ms，不能每步都试），
   * 清掉它的时机是"重新连接/换目标" —— 这里手工模拟那一步。
   */
  session._cStepWorks = null;
  const mode3 = await session.step();
  ok(mode3 === 'dhcsr' && session.pc === pcBefore + 6, `重连（清掉粘性结论）后立刻回到 C_STEP 主路径（0x${session.pc.toString(16)}）`);

  // 删断点 / 清空
  ok(await session.bpDel(0x08000300) === true, '删断点');
  ok(session.bpList().length === 0, '断点表空了');

  // 复位
  await session.resetHalt();
  ok(await session.readReg('PC') === 0x08000100, '复位并停：PC 回到复位向量');
  ok(session.halted === true, '复位并停：状态是"已停止"');
  await session.resetRun();
  ok(session.halted === false, '复位并跑：状态是"运行中"');
  await session.halt();
  ok(session.halted === true, '再暂停回来');
}

// ==================================================================== 6
console.log('== 6. 命令行（跑在同一个会话上）==');
{
  session.sym = symtab;
  const run = async line => (await C.runCmd(line, session)).lines.map(l => l.t);

  const help = await run('h');
  ok(help.length > 10 && help.some(l => /md <地址>/.test(l)), 'h 打印帮助');

  let threw = '';
  try { await C.runCmd('nosuchcmd', session); } catch (e){ threw = e.message; }
  ok(/不认识的命令/.test(threw), '不认识的命令要报错（不能静默无反应）', threw);

  const r0 = await run('r r0');
  ok(r0.length === 1 && /R0/.test(r0[0]) && /0xdeadbeef/.test(r0[0]), 'r r0 打印一个寄存器', r0[0]);

  const warp = await run('r PC 0x08000200');
  ok(/←/.test(warp[0]) && await session.readReg('PC') === 0x08000200, 'r PC <值> 写进去了');
  threw = '';
  try { await C.runCmd('r r0 0xZZ', session); } catch (e){ threw = e.message; }
  ok(/认不出数值/.test(threw), 'r <reg> <坏值> 报错而不是静默', threw);

  const mw = await run('mw 0x20000020 01 02 03 04');
  ok(/回读一致/.test(mw[0]), 'mw 写内存并回读对账', mw[0]);
  const md = await run('md 0x20000020 16');
  ok(md.length >= 2 && /0x20000020  01 02 03 04/.test(md[1]), 'md 打印 hexdump', md[1]);

  const bp = await run('b SysTick_Handler');
  ok(/断点 #1/.test(bp[0]) && session.bpList()[0].addr === 0x08000040, 'b <符号> 走符号表解析', bp[0]);
  const bl = await run('bl');
  ok(bl.some(l => /#1/.test(l)) && bl.some(l => /硬件上限 8/.test(l)), 'bl 列出断点与硬件上限');
  const bd = await run('bd 1');
  ok(/删掉断点/.test(bd[0]) && session.bpList().length === 0, 'bd 1 按编号删断点');

  const p = await run('p g_bytes');
  ok(p.length === 1 && /g_bytes/.test(p[0]), 'p 打印变量（有 DWARF 就解数值）', p[0]);
  await session.memWrite(0x20000000, Uint8Array.from([0x11, 0x22, 0x33, 0x44]));
  const p2 = await run('p g_bytes');
  ok(/0x44332211|11 22 33 44/.test(p2[0]), 'p 打出来的值对得上刚写的字节', p2[0]);

  const info = await run('info');
  ok(info.some(l => /后端/.test(l)) && info.some(l => /状态/.test(l)), 'info 有后端/状态/符号');

  const syms = await run('sym RTT');
  ok(syms.some(l => /_SEGGER_RTT/.test(l)), 'sym 搜符号');

  const x = await run('x &g_bytes 8');
  ok(x.some(l => /g_bytes/.test(l)), 'x &变量 先解释符号再 dump');

  // md 的边界
  threw = '';
  try { await C.runCmd('md', session); } catch (e){ threw = e.message; }
  ok(/用法/.test(threw), 'md 缺参数时报用法', threw);
  threw = '';
  try { await C.runCmd('md 0x20000000 99999', session); } catch (e){ threw = e.message; }
  ok(/1~4096/.test(threw), 'md 长度上限有保护', threw);
}

// ==================================================================== 7
console.log('== 7. 没连接时的命令（不能崩，要给人话）==');
{
  const s2 = new S.DebugSession();
  let threw = '';
  try { await C.runCmd('c', s2); } catch (e){ threw = e.message; }
  ok(/还没连接/.test(threw), '未连接时 c 提示先连接', threw);
  const help = await C.runCmd('h', s2);
  ok(help.lines.length > 5, '未连接时 h 仍然可用');
}

// ==================================================================== 8
console.log('== 8. 行号表（DWARF .debug_line）：停下来显示源码行的地基 ==');
{
  ok(!!symtab.lines, '载入 ELF 时顺带解析出了行号表');
  ok(symtab.lines.size > 100, `行号记录 ${symtab.lines.size} 条`, String(symtab.lines?.size));
  ok(symtab.lines.units === 3, `3 个编译单元（每段一个行号程序）`, String(symtab.lines.units));
  ok(symtab.lines.versions.includes(4), 'CU 版本是 DWARF 4', JSON.stringify(symtab.lines.versions));
  ok(symtab.lines.paths.some(p => p.endsWith('/src/main.c')), '源文件表里有 src/main.c');
  ok(LN.cleanPath('E:\\a\\..\\b/c.c') === 'E:/b/c.c' && LN.cleanPath('/x/./y') === '/x/y', 'cleanPath 归一化（盘符/`..`/`.`）');
  ok(LN.isAbsPath('E:/x') && LN.isAbsPath('/usr/x') && !LN.isAbsPath('src/main.c'), 'isAbsPath 认盘符与 Unix 根');
  ok(LN.relTo('E:/proj', 'E:/proj/src/main.c') === 'src/main.c', 'relTo 算相对路径');

  const st = symtab.at(0x08000040);
  ok(st && st.line === 24 && /main\.c$/.test(st.file) && st.isStmt, 'SysTick_Handler 的首地址 → src/main.c:24', JSON.stringify(st));
  const mn = symtab.at(0x08000051);
  ok(mn && mn.line === 28, 'main+0 → src/main.c:28', JSON.stringify(mn));
  ok(symtab.locText(0x08000040) === 'main.c:24', 'locText 给"文件:行"的人话：' + symtab.locText(0x08000040));

  // 🚨 地址 0 / 非代码段的假记录必须被剔掉（编译器的"占位序列"会落在 0,2,4…）
  let minAddr = Infinity;
  for (let i = 0; i < symtab.lines.size; i++) minAddr = Math.min(minAddr, symtab.lines.starts[i]);
  ok(minAddr >= 0x08000000, `最小记录地址在代码段里（0x${minAddr.toString(16)}）—— 占位序列被剔掉了`);
  ok(symtab.at(0) === null && symtab.at(0x20000000) === null, '地址 0 / RAM 地址查不到行号（回 null 而不是乱指一行）');

  // 反查：行 → 地址 → 行，必须一一对上（点源码行下断点全靠它）
  let okN = 0, badN = 0;
  for (let i = 0; i < symtab.lines.size; i++){
    const fi = symtab.lines.files[i];
    if (fi < 0) continue;
    const p = symtab.lines.paths[fi], ln = symtab.lines.lines[i];
    const a = symtab.lines.addrOfLine(p, ln);
    const back = a == null ? null : symtab.lines.at(a);
    if (back && back.line === ln && back.file === p) okN++; else badN++;
  }
  ok(badN === 0 && okN > 100, `行→地址→行 全部自洽（${okN} 条，${badN} 条不一致）`);

  // 没有行号信息的 ELF：不能让整页挂掉
  const bare = SY.SymTab.fromBuffer(new Uint8Array(elfBuf));
  ok(bare.lines === null || bare.lines.size > 0, 'SymTab.lines 要么有表要么是 null（两种都不能崩）');

  // 🚨 DWARF 5 + 0x8xxxxxxx 地址：`addr & ~1` 在 JS 里会变成负数，忘了 `>>> 0` 就一条都查不到
  const rvSym = SY.SymTab.fromBuffer(new Uint8Array(readFileSync(join(here, '..', 'fixtures', 'dwarf', 'riscv_dwarf5.elf'))));
  ok(!!rvSym.lines && rvSym.lines.size > 0, 'DWARF 5 的行号表也能解析（riscv_dwarf5.elf）', String(rvSym.lines?.size));
  const rvAt = rvSym.at(0x80000000);
  ok(rvAt && rvAt.line === 8 && /fixture\.c$/.test(rvAt.file), '0x80000000 查得到行号（有符号位那个坑的回归测试）', JSON.stringify(rvAt));
}

// ==================================================================== 8.1
console.log('== 8.1 源码文件仓（选择目录后的匹配与读取）==');
{
  const SR = await import(url('dbg/source.js'));
  const store_ = new SR.SourceStore();
  const mkFile = (rel, text) => ({ name: rel.split('/').pop(), webkitRelativePath: 'proj/' + rel, text: async () => text, size: text.length });
  const sum = store_.indexFileList([mkFile('src/main.c', 'int main(void){\n  return 0;\n}\n'), mkFile('src/app/loop.c', 'void loop(void){}\n')]);
  ok(store_.ready && store_.count === 2, '索引 FileList（webkitdirectory 兜底路径）：' + sum);
  ok(store_.resolve('E:/proj/src/main.c')?.rel === 'src/main.c', '按后缀匹配 ELF 里的绝对路径（编译机路径 ≠ 本机路径）');
  ok(store_.resolve('/home/ci/build/src/app/loop.c')?.rel === 'src/app/loop.c', '多级后缀也能匹配');
  ok(store_.resolve('E:/other/nope.c') === null, '匹配不上就回 null（界面显示"没找到源文件"，不乱猜）');
  const txt = await store_.read('E:/proj/src/main.c');
  ok(txt.includes('int main'), '读源码文本（走缓存）');
  const again = await store_.read('E:/proj/src/main.c');
  ok(again === txt, '第二次读走缓存（同一份内容）');
  let msg = '';
  try { await store_.read('E:/proj/src/missing.c'); } catch (e){ msg = e.message; }
  ok(/找不到/.test(msg) && /选择源码目录/.test(msg), '读不到时给人话（告诉用户去选目录）', msg);
}

// ==================================================================== 9
console.log('== 9. 监视窗口（表达式解析 / 取值 / 增删）==');
{
  const v = W.resolveWatch('g_bytes', symtab);
  ok(v.addr === 0x20000000 && !v.error, 'w 变量名 → 解析到地址', JSON.stringify(v));
  const off = W.resolveWatch('g_bytes+4', symtab);
  ok(off.addr === 0x20000004 && off.kind === 'addr', 'w 符号+偏移 → 按 u32 看那个地址', JSON.stringify(off));
  const raw = W.resolveWatch('0x20000010', symtab);
  ok(raw.addr === 0x20000010 && raw.scalar === 'u32', 'w 裸地址 → 按 u32 读');
  ok(W.resolveWatch('没这个符号', symtab).error?.includes('找不到'), 'w 认不出来 → 给错误（不静默）');
  ok(W.resolveWatch('g_bytes', null).error?.includes('elf'), '没载入 ELF 时 w 说明原因');

  const bytes = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const fv = W.formatWatchValue({ scalar: 'u32', typeName: 'u32', size: 4 }, bytes);
  ok(fv.text === String(0x44332211) && fv.hex === '0x44332211', 'u32 取值：十进制 + 十六进制', JSON.stringify(fv));
  const fraw = W.formatWatchValue({ scalar: null, typeName: '4 字节', size: 4 }, bytes);
  ok(/44332211/.test(fraw.text + fraw.hex), '没有类型信息时也要给出人看得懂的十六进制', JSON.stringify(fraw));

  const list = new W.WatchList();
  const a1 = list.add('g_bytes', symtab);
  ok(!a1.dup && list.length === 1, '加一项监视');
  const a2 = list.add('g_bytes', symtab);
  ok(a2.dup && list.length === 1, '同名不重复加（返回 dup）');
  list.add('g_bytes+4', symtab);
  list.add('0x20000010', symtab);
  ok(list.length === 3, '一共 3 项');
  ok(list.remove('2').removed === 1 && list.length === 2, 'wd 按编号删');
  ok(list.remove('0x20000010').removed === 1 && list.length === 1, 'wd 按名字删');
  const json = list.toJSON();
  ok(Array.isArray(json) && json[0].expr === 'g_bytes' && json[0].value === undefined, 'toJSON 不把值存进 localStorage');
  const back = W.WatchList.fromJSON(json, symtab);
  ok(back.length === 1 && back.items[0].addr === 0x20000000, 'fromJSON 重新解析（换 ELF 后地址会跟着变）');
  ok(list.remove('all').removed === 1 && list.length === 0, 'wd all 全清');
}

// ==================================================================== 10
console.log('== 10. Tab 补全（命令名 / 符号 / 寄存器）==');
{
  ok(CP.commonPrefix(['main', 'mainloop', 'ma']) === 'ma', 'commonPrefix 取最长公共前缀');
  const all = CP.completeLine('', {});
  ok(all.total === CP.CMD_NAMES.length && all.candidates.length > 10, '空行 Tab → 列出全部命令名');
  const h = CP.completeLine('he', {});
  ok(h.total === 1 && h.value === 'help ', '唯一候选补全并补一个空格：' + JSON.stringify(h.value));

  const syms = { sym: symtab, regs: ['pc', 'primask'] };
  const b = CP.completeLine('b ma', syms);
  ok(/^b (main|mainloop)/.test(b.value) && b.total >= 1, 'b <前缀> → 补符号名：' + JSON.stringify(b.value));
  const p = CP.completeLine('p _SEG', syms);
  ok(p.value.startsWith('p _SEGGER_RTT') && p.total >= 1, 'p _SEG → 补出 _SEGGER_RTT*（有多个就补公共前缀）：' + JSON.stringify(p.value));
  const r = CP.completeLine('r pr', syms);
  ok(r.value === 'r primask' && r.kind === 'reg', 'r 后面补寄存器名：' + JSON.stringify(r.value));
  const none = CP.completeLine('md zzz', syms);
  ok(none.total === 0 && none.value === 'md zzz', '没有候选时原样不动（绝不猜一个最近的）');
  const many = CP.completeLine('b m', syms);
  ok(many.total > 1 && many.value.length >= 'b m'.length, '多个候选 → 只补公共前缀（候选交给界面列出来）');
}

// ==================================================================== 11
console.log('== 11. 新命令：w / wl / wd / sl / src + Ctrl+C 取消 ==');
{
  const s3 = new S.DebugSession();
  s3.log = () => {};
  await s3.connect({ mock: true });
  s3.sym = symtab;
  const calls = [];
  const vw = {
    addWatch(expr){ calls.push('add:' + expr); return { ok: true, index: 0, item: { expr, addr: 0x20000000 } }; },
    watchItems(){ return [{ expr: 'g_bytes', label: 'g_bytes', addr: 0x20000000, value: { text: '7' } }]; },
    delWatch(w){ calls.push('del:' + w); return { removed: 1 }; },
    showSource(f, l){ calls.push(`src:${f}:${l}`); return !/没有这个文件/.test(f); },
  };
  const run = async (l) => (await C.runCmd(l, s3, { view: vw })).lines.map(x => x.t);

  const w = await run('w g_bytes');
  ok(/监视 \+ g_bytes/.test(w[0]) && calls.includes('add:g_bytes'), 'w <变量> 加进监视窗口', w[0]);
  const wl = await run('wl');
  ok(wl.some(l => /g_bytes/.test(l) && /#1/.test(l)), 'wl 列出监视项与值', wl[0]);
  const wd = await run('wd 1');
  ok(/已删掉 1 项/.test(wd[0]) && calls.includes('del:1'), 'wd 1 删掉监视项', wd[0]);
  const wbad = await (async () => { try { await run('w'); return ''; } catch (e){ return e.message; } })();
  ok(/用法/.test(wbad), 'w 缺参数报用法', wbad);

  const sl = await run('sl');
  ok(sl.some(l => /\.c:\d+/.test(l)), 'sl 打印当前源码位置', sl[0]);
  ok(calls.some(c => c.startsWith('src:')), 'sl 顺手把源码视图跳过去');
  const srcList = await run('src');
  ok(srcList.some(l => /main\.c/.test(l)), 'src 不带参数列出源文件', srcList[1]);
  const srcJump = await run('src main.c:24');
  ok(/跳到/.test(srcJump[0]), 'src <文件:行> 跳转', srcJump[0]);
  const srcBad = await (async () => { try { await run('src 没有这个文件.c:1'); return ''; } catch (e){ return e.message; } })();
  ok(/没有这个文件/.test(srcBad), 'src 找不到文件时报错（不静默）', srcBad);

  // Ctrl+C：signal 返回 true → 抛 Cancelled，界面显示成 ^C
  let cancelled = false;
  try { await C.runCmd('md 0x20000000 16', s3, { signal: () => true }); }
  catch (e){ cancelled = !!e.cancelled; }
  ok(cancelled, 'Ctrl+C（signal=true）时命令抛 Cancelled，不再往下跑');
  let notCancelled = false;
  try { await C.runCmd('md 0x20000000 16', s3, { signal: () => false }); notCancelled = true; } catch { notCancelled = false; }
  ok(notCancelled, 'signal=false 时命令照常执行');

  // 没界面时 w/wl/wd 要给人话错误（而不是崩）
  let noView = '';
  try { await C.runCmd('w g_bytes', s3); } catch (e){ noView = e.message; }
  ok(/界面/.test(noView), '没有界面时 w 说明"需要界面支持"', noView);
}

// ==================================================================== 12
console.log('== 12. SWD 时钟：默认 10 MHz + PPB 坏读自动退回 1 MHz ==');
{
  ok(S.DEFAULT_CLOCK_KHZ === 10000, `默认时钟是 10 MHz（${S.DEFAULT_CLOCK_KHZ} kHz）`);
  const s4 = new S.DebugSession();
  s4.log = () => {};
  await s4.connect({ mock: true, clockKhz: 10000 });
  const p = s4.probe;

  // ① 好探针：10 MHz 下 DHCSR 读得干净 → 不动时钟
  p.clockHz = 10_000_000; s4.clockHz = 10_000_000;
  p.ppbGarbage = false;
  const okRes = await s4.verifyClock();
  ok(okRes.ok === true && okRes.checked === true && s4.clockHz === 10_000_000, 'PPB 读数正常 → 保持 10 MHz', JSON.stringify(okRes));

  // ② 坏探针（高时钟读 PPB 回 0）→ 自动退回 1 MHz，并把证据写进日志
  const logs = [];
  s4.log = (t) => logs.push(t);
  p.ppbGarbage = true;
  const badRes = await s4.verifyClock();
  ok(badRes.ok === false && s4.clockHz === S.PPB_SAFE_HZ, 'PPB 读回 0 → 自动退回 1 MHz', JSON.stringify(badRes));
  ok(p.clockHz === S.PPB_SAFE_HZ, '探针那边的 SWJ_Clock 也真的改了', String(p.clockHz));
  ok(logs.some(l => /已自动退回 1 MHz/.test(l)), '日志里说清"为什么退回"（不许静默降级）', logs.join(' | ').slice(0, 140));

  // ③ 已经 ≤1 MHz 就不再折腾（不白读三次）
  const skip = await s4.verifyClock();
  ok(skip.ok === true && skip.checked === false, '已经 ≤1 MHz 时跳过检查', JSON.stringify(skip));
  await s4.disconnect();
}

// ==================================================================== 13
console.log('== 13. SWD 串行化（后台轮询不许和用户动作交错）==');
{
  const s5 = new S.DebugSession();
  s5.log = () => {};
  await s5.connect({ mock: true });
  const order = [];
  const op = s5.exclusive(async () => { order.push('op:start'); await sleep(60); order.push('op:end'); });
  await sleep(10);
  const bg = await s5.tryExclusive(async () => { order.push('bg'); });
  ok(bg.skipped === true && !order.includes('bg'), '独占动作进行中 → 后台轮询跳过这一拍（不排队、不交错）', JSON.stringify(order));
  await op;
  const bg2 = await s5.tryExclusive(async () => { order.push('bg2'); return 7; });
  ok(bg2.skipped === false && bg2.value === 7 && order[order.length - 1] === 'bg2', '空闲时后台轮询正常执行', JSON.stringify(order));

  const seq = [];
  const a = s5.exclusive(async () => { seq.push('A1'); await sleep(40); seq.push('A2'); });
  const b = s5.exclusive(async () => { seq.push('B1'); await sleep(10); seq.push('B2'); });
  await Promise.all([a, b]);
  ok(seq.join(',') === 'A1,A2,B1,B2', '两个独占动作排队：A 全程跑完才轮到 B', seq.join(','));
  ok(s5._opBusy === false, '队列跑空后锁已释放', String(s5._opBusy));
  await s5.disconnect();
}

// ==================================================================== 14
console.log('== 14. 断点目标解析：文件:行 / 函数:行 / 相对行（breakSpec）==');
{
  const lines = symtab.lines;
  ok(!!lines, 'fixture ELF 有行号表（' + (lines ? lines.summary() : '无') + ')');
  const row = lines.rowsInRange(0x08000040, 0x08000080, 6).find(r => r.isStmt);
  ok(!!row, '取到一条 is_stmt 记录：' + (row ? `${base(row.file)}:${row.line}@0x${row.addr.toString(16)}` : '无'));

  const spec = symtab.breakSpec(`${base(row.file)}:${row.line}`);
  ok(spec.addr === row.addr && spec.via === 'file', 'b <文件名:行> 反查到地址（后缀匹配）', JSON.stringify(spec));
  ok(symtab.breakSpec(`${row.file}:${row.line}`).addr === row.addr, 'b <完整路径:行> 也能解析');

  const fspec = symtab.breakSpec(`SysTick_Handler:${row.line}`);
  ok(fspec.addr === row.addr && fspec.via === 'func', 'b <函数:行> 用该函数所在文件解析', JSON.stringify(fspec));
  ok(/→/.test(fspec.label), '函数形式的出处写明"函数 → 文件:行"：' + fspec.label);

  const rel = symtab.breakSpec('+2', { pc: row.addr });
  ok(rel.via === 'rel' && rel.addr > row.addr && rel.line > row.line, 'b +2 相对当前行往后', JSON.stringify(rel));
  ok(/停下来/.test(symtab.breakSpec('+2').error || ''), 'b +2 但目标在跑（没有 PC）→ 明确报错，不猜');

  ok(/解析不了/.test(symtab.breakSpec('nope.c:12').error || ''), '不存在的文件 → 报错', JSON.stringify(symtab.breakSpec('nope.c:12')));
  ok(/没有第|解析不了/.test(symtab.breakSpec('main.c:99999').error || ''), '不存在的行号 → 报错', JSON.stringify(symtab.breakSpec('main.c:99999')));
  ok(symtab.breakSpec('main').addr === symtab.find('main').addr, '普通符号名照旧走 resolve（不回归）');
  ok(symtab.breakSpec('0x08000040').via === 'addr', '十六进制地址照旧');
}

// ==================================================================== 14b
console.log('== 14b. 行号表的"序列"边界（nextStmtAddr 不许跨进隔壁函数）==');
{
  /**
   * 🚨 2026-10 真机定因的回归钉子：DWARF 只保证"同一条序列内地址递增"，
   *    不同函数的序列在**链接后**地址可以交错。早先 `nextStmtAddr()` 在全局按地址排序的
   *    数组里往前走，于是从 `main` 的循环一步跨进了 `wait_field`（目标行算成 main.c:144），
   *    真机上表现为"按了 F10 等 3 秒没反应、临时断点永远不命中"。
   *    现在每条记录都带序列号，`nextStmtAddr()` 只在同一条序列里找。
   */
  const check = (st, tag) => {
    const L = st.lines;
    if (!L) return 0;
    let rows = 0, bad = 0, cross = 0, crossBad = 0;
    for (const r of L.rowsInRange(0, 0xffffffff, 100000)){
      const next = L.nextStmtAddr(r.addr);
      if (!next) continue;
      rows++;
      const curRow = L.at(r.addr);
      if (curRow && next.idx != null && (L.seqs[next.idx] | 0) !== (curRow.seq | 0)) bad++;
      const f1 = st.funcAt?.(r.addr), f2 = st.funcAt?.(next.addr);
      if (f1 && f2 && f1.name !== f2.name){
        cross++;
        /**
         * 同一条序列里跨到隔壁函数是**可能合法**的：编译器常把几个函数排在一条序列里，
         * 而"函数末尾直接落进下一个函数"（尾调用 / 没有 `bx lr` 的收尾 / 一小段没被行号覆盖的
         * 收尾指令）本来就是顺序执行。所以只要求"基本衔接"（间隔 ≤16 字节）；
         * 真正要防的是**跳进不相干的代码**（真机上那次是一步跨进 `wait_field`）。
         */
        if (curRow && (next.addr - curRow.end) > 16) crossBad++;
      }
    }
    ok(bad === 0, `${tag}：${rows} 条记录的"下一行"都在同一条序列里`, `跨序列 ${bad} 条`);
    ok(crossBad === 0, `${tag}：跨函数的"下一行"都是直接衔接（fall-through），没有跳跃`, `异常 ${crossBad}/${cross} 条`);
    return rows;
  };
  const n1 = check(symtab, 'F103 靶子 ELF');
  ok(n1 > 20, `F103 靶子上覆盖到 ${n1} 条记录（样本够大）`);

  // 同一套检查再跑一遍仓库已提交的 H743 scope 靶子：这里验证 DWARF 序列，
  // 与目标是否开启 D-cache/MPU 无关，不依赖本地 build-noncache 的实验产物。
  try {
    const h7 = SY.SymTab.fromBuffer(new Uint8Array(readFileSync(join(here, '..', 'target-firmware', 'stm32h743_scope', 'fw.elf'))));
    const n2 = check(h7, 'H743 scope ELF');
    ok(n2 > 20, `H743 scope 靶子上覆盖到 ${n2} 条记录`);
  } catch (e){
    ok(false, 'H743 scope 靶子 ELF 能读（' + (e?.message || e) + '）');
  }
}

// ==================================================================== 15
console.log('== 15. Thumb：指令长度与 BL/BLX 目标 ==');
{
  ok(TB.thumbLen(0xbf00) === 2, 'NOP（0xBF00）是 16 位');
  ok(TB.thumbLen(0xe7fe) === 2, '`b .`（0xE7FE）是 16 位 —— 0xE000~0xE7FF 这一档最容易判错');
  ok(TB.thumbLen(0xf000) === 4 && TB.thumbLen(0xf800) === 4, '0xF000/0xF800（32 位分支前缀）是 32 位');

  const call = TB.decodeCall(0xf000, 0xf87e, 0x08000100);
  ok(call && call.target === 0x08000200 && call.kind === 'bl', 'BL 目标解码（+0xFC）', JSON.stringify(call));
  ok(TB.decodeCall(0xf000, 0xe07e, 0x08000100)?.kind === 'blx', 'H 位（bit12）=0 → BLX');
  ok(TB.decodeCall(0xbf00, 0x0000, 0x08000100) === null, '不是分支指令 → null（不瞎算）');
  const back = TB.decodeCall(...TB.encodeCall(0x08000200, 0x08000100), 0x08000200);
  ok(back && back.target === 0x08000100, '负偏移（往回跳）也算对', JSON.stringify(back));
  ok(TB.isCallReg(0x4780) === true && TB.isCallReg(0x4700) === false, 'BLX <reg> 是调用、BX 不是');

  // 编解码互为逆运算（造靶子/自测都用它，错一位就整体跑偏）
  for (const [from, to] of [[0x08000100, 0x08000200], [0x08000200, 0x08000100], [0x08000040, 0x08012340]]){
    const [h1, h2] = TB.encodeCall(from, to);
    ok(TB.decodeCall(h1, h2, from)?.target === to, `encode→decode 往返一致（0x${from.toString(16)} → 0x${to.toString(16)}）`);
  }
}

// ==================================================================== 16
console.log('== 16. 结构体/数组树（监视窗口的树）==');
{
  const u32 = { kind: 'scalar', scalar: 'u32', size: 4, name: 'uint32_t' };
  const u16 = { kind: 'scalar', scalar: 'u16', size: 2, name: 'uint16_t' };
  const f32 = { kind: 'scalar', scalar: 'f32', size: 4, name: 'float' };
  const inner = { kind: 'struct', size: 4, name: 'Inner', members: [{ name: 'x', offset: 0, type: u16 }, { name: 'y', offset: 2, type: u16 }] };
  const type = {
    kind: 'struct', size: 16, name: 'S', members: [
      { name: 'a', offset: 0, type: u32 },
      { name: 'in', offset: 4, type: inner },
      { name: 'flag', offset: 8, type: { kind: 'scalar', scalar: 'u8', size: 1, name: 'uint8_t' }, bitSize: 3, bitOffset: 64 },
      { name: 'v', offset: 12, type: { kind: 'array', size: 8, count: 2, elem: f32 } },
    ],
  };
  const bytes = new Uint8Array(16);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xdeadbeef, true);
  dv.setUint16(4, 7, true); dv.setUint16(6, 9, true);
  bytes[8] = 0b00000101;                       // 低 3 位 = 5（位域）
  dv.setFloat32(12, 1.5, true);                // 第二个元素（偏移 16）越界 → 必须如实说"读不到"

  const item = { kind: 'struct', type, label: 'g_s', size: 16 };
  const rows = W.treeRows(item, bytes);
  const by = n => rows.find(r => r.name === n);
  ok(by('a')?.text === '3735928559', 'u32 成员解出数值：' + by('a')?.text);
  ok(by('a')?.hex === '0xdeadbeef', 'u32 成员给出十六进制：' + by('a')?.hex);
  ok(by('in')?.text === '{2 个成员}', '嵌套结构体给出容器行');
  ok(by('x')?.text === '7' && by('y')?.text === '9', '嵌套成员按偏移解出（x=7, y=9）');
  ok(by('x')?.depth === 1 && by('in')?.depth === 0, '嵌套成员的缩进层级正确');
  ok(by('flag : 3')?.text?.startsWith('5'), '位域按 bitOffset/bitSize 解出：' + by('flag : 3')?.text);
  ok(by('flag : 3')?.bitfield === true, '位域行有标记（界面用黄字）');
  ok(by('v')?.text === '[2]', '数组给出 [n]');
  ok(/^1\.5/.test(by('[0]')?.text || ''), '数组元素解出 f32：' + by('[0]')?.text);
  ok(/越界|读不到/.test(by('[1]')?.text || ''), '越界的元素如实说"读不到"（绝不猜 0）：' + by('[1]')?.text);

  const small = W.treeRows(item, bytes, { maxArray: 1, maxRows: 3 });
  ok(small.length <= 4 && small.some(r => r.overflow), 'maxRows 限流并给出"只显示前 N 行"', String(small.length));
  const arr = W.treeRows({ kind: 'array', type, label: 'x', size: 16 }, bytes, { maxArray: 1 });
  ok(arr.some(r => /还有 \d+ 项/.test(r.text)), '数组超上限时给出"还有 N 项"');

  const sum = W.summarizeTree(item, bytes);
  ok(/a=3735928559/.test(sum) && sum.startsWith('{'), '折叠摘要给出成员=值：' + sum);

  ok(W.readBits(Uint8Array.from([0b10110000]), 4, 3) === 3, 'readBits 按位偏移取值');
  ok(W.readBits(Uint8Array.from([0x05]), 0, 3) === 5, 'readBits 低位取值');

  // 字符数组当字符串看（可打印才显示）
  const carr = { kind: 'array', size: 8, count: 8, elem: { kind: 'scalar', scalar: 'u8', size: 1, name: 'char' } };
  const cbytes = new TextEncoder().encode('hello\0\0\0');
  const crows = W.treeRows({ kind: 'array', type: carr, label: 's', size: 8 }, cbytes);
  ok(crows.some(r => r.name === '(字符串)' && /"hello"/.test(r.text)), 'u8 数组可打印时给出字符串行');
}

// ==================================================================== 17
console.log('== 17. 源码级单步（假目标真跑：跳过 / 进入 / 跳出 / 运行到）==');
{
  const s6 = new S.DebugSession();
  s6.log = () => {};
  await s6.connect({ mock: true });
  s6.sym = symtab;                                  // fixture 的行号表正好覆盖假目标的 0x08000100（SEGGER_RTT.c）
  await s6.refresh(); await s6.refreshRegs();
  ok(s6.pc === 0x08000100, '假目标从代码区入口开始', '0x' + s6.pc.toString(16));

  const next = symtab.lines.nextStmtAddr(0x08000100);
  ok(!!next && next.addr > 0x08000100, 'nextStmtAddr 给出下一行地址', JSON.stringify(next));

  const r1 = await s6.stepOver();
  ok(s6.pc === next.addr, `单步跳过落在下一行（0x${s6.pc.toString(16)}）`, r1);
  ok(/SEGGER_RTT\.c:\d+/.test(r1), '返回的人话带源码行：' + r1);
  ok(s6.bpList().length === 0, '临时比较器收干净了（用户断点 0 个）');
  ok(s6.lastStepMode === 'over', '记下了这一步是"跳过"（lastStepMode=' + s6.lastStepMode + '）');

  const cachedPc = s6.regList().find(r => r.name === 'PC').value;
  const nFresh = await C.runCmd('n', s6);
  ok(s6.pc !== cachedPc && nFresh.lines[1].t.includes(F.hex32(s6.pc)), '源码单步命令的 PC 回显跟随本次停止地址', nFresh.lines[1].t);

  // 目标行上原本就有用户断点 → 不能把用户的删掉
  const next2 = symtab.lines.nextStmtAddr(s6.pc);
  await s6.bpAdd(next2.addr, 'user.bp');
  const r2 = await s6.stepOver();
  ok(s6.pc === next2.addr && s6.bpList().length === 1, '临时断点落在用户断点上时不动它（剩 ' + s6.bpList().length + ' 个）', r2);
  ok(s6.bpList()[0].note === 'user.bp', '断点上的出处备注还在：' + s6.bpList()[0].note);
  await s6.bpDel(next2.addr);

  // 比较器被用户断点占满 → 人话错误，且一个用户断点都不许少
  for (let i = 0; i < s6.caps.numCode; i++) await s6.bpAdd(0x08001400 + i * 8);
  let fullErr = '';
  try { await s6.stepOver(); } catch (e){ fullErr = e.message; }
  ok(/用完|删掉一个/.test(fullErr), '比较器占满时给人话错误：' + fullErr);
  ok(s6.bpList().length === s6.caps.numCode, '报错后用户断点一个没少');
  await s6.bpClear();

  // ---- 单步进入 / 跳出：往假目标 flash 里写一条真的 BL（0x08000200 → 0x08000300），
  //      并在被调函数入口放一条 `BX LR`，这样"进入 → 跳出"能真跑一个来回 ----
  const [h1, h2] = TB.encodeCall(0x08000200, 0x08000300);
  const put16 = (addr, v) => { s6.probe.flash[addr - 0x08000000] = v & 0xff; s6.probe.flash[addr - 0x08000000 + 1] = (v >> 8) & 0xff; };
  put16(0x08000200, h1); put16(0x08000202, h2);
  put16(0x08000300, 0x4770);                     // BX LR：假目标会 PC ← LR（跟真硬件一样）
  await s6.writeReg('PC', 0x08000200);
  s6.pc = 0x08000200;
  const r3 = await s6.stepInto();
  ok(s6.pc === 0x08000300 && s6.lastStepMode === 'into', `单步进入落在被调函数入口（0x${s6.pc.toString(16)}）`, r3);
  ok((await s6.readReg('LR')) === 0x08000205, '假目标按真硬件把返回地址放进了 LR（0x08000204|1）');
  const r4 = await s6.stepOut();
  ok(s6.pc === 0x08000204 && s6.lastStepMode === 'out', `单步跳出回到调用点的下一条指令（0x${s6.pc.toString(16)}）`, r4);
  ok(s6.bpList().length === 0, '单步进入/跳出之后比较器都收干净了');

  // 把刚才planted 的 BL / BX LR 还原成 NOP（否则假目标就在 0x08000200↔0x08000300 之间死循环，
  // 那是"真硬件也会这样"的正确行为 —— 后面"运行到"的用例要一段能顺序跑的代码）
  put16(0x08000200, 0xbf00); put16(0x08000202, 0xbf00); put16(0x08000300, 0xbf00);

  // LR 是 EXC_RETURN（在异常里）→ 明确拒绝，不许瞎跳
  await s6.writeReg('LR', 0xfffffff9);
  let outErr = '';
  try { await s6.stepOut(); } catch (e){ outErr = e.message; }
  ok(/EXC_RETURN/.test(outErr), 'LR=0xFFFFFFF9（EXC_RETURN）时拒绝"跳出"并说明原因', outErr);

  // 运行到光标
  const r5 = await s6.runTo(0x08000400, { label: 'main.c:1' });
  ok(s6.pc === 0x08000400 && /已运行到/.test(r5), `运行到指定地址（0x${s6.pc.toString(16)}）`, r5);
  const r6 = await s6.runTo(0x08000400);
  ok(/已经停在这一行/.test(r6), '目标已经在那里时直接说"已停在这一行"', r6);

  // 没有行号信息 → 源码级单步必须明说做不到（不静默退化成别的东西）
  const s7 = new S.DebugSession();
  s7.log = () => {};
  await s7.connect({ mock: true });
  s7.sym = null;
  let noLine = '';
  try { await s7.stepOver(); } catch (e){ noLine = e.message; }
  ok(/行号信息/.test(noLine), '没有行号信息时 stepOver 明确报错', noLine);
  await s7.disconnect();
  await s6.disconnect();
}

// ==================================================================== 17b
console.log('== 17b. 「单步跳出」在非叶子函数里（LR 被本函数内部的调用覆盖）==');
{
  /**
   * 真机现场（H743 · 6 层嵌套）：停在 `engine_deep_l4` 里按「跳出」，
   * LR = 本函数里 `bl deep_l5` 的下一条指令（不是返回地址！）→ 旧实现原地不动，连续 5 次纹丝不动。
   * 正确做法（本用例钉的就是它）：不读栈（H7 的栈在 DTCM，探针根本读不到），
   * 改成"单步走完本函数 + 用 SP 是否弹回判断这一帧结束"。
   *
   * 假目标里造一个真的有栈帧的函数：
   *   0x08000240  PUSH {r7, lr}
   *   0x08000242  BL 0x08000260        ← 这次调用把 LR 覆盖成 0x08000246|1
   *   0x08000246  NOP
   *   0x08000248  POP  {r7, pc}        ← 真的从栈上恢复返回地址
   *   0x08000260  BX LR                ← 被调函数立刻返回
   */
  const s7b = new S.DebugSession();
  s7b.log = () => {};
  await s7b.connect({ mock: true });
  /** 假符号表：0x240..0x260 = frame_fn，0x260..0x280 = callee_fn（真的两个不同函数） */
  const fn = (a, lo, hi, name) => (a >= lo && a < hi)
    ? { name, addr: lo, size: hi - lo, off: a - lo, exact: true }
    : { name, addr: lo, size: hi - lo, off: 0, exact: false };
  s7b.sym = {
    funcAt: a => {
      a = (a >>> 0) & ~1;
      if (a >= 0x08000240 && a < 0x08000260) return fn(a, 0x08000240, 0x08000260, 'frame_fn');
      if (a >= 0x08000260 && a < 0x08000280) return fn(a, 0x08000260, 0x08000280, 'callee_fn');
      return fn(a, 0x08000050, 0x080000ac, 'caller_fn');
    },
    nameOf: a => 'fn@0x' + ((a >>> 0) & ~1).toString(16),
    locText: () => '', lines: null, funcs: [], find: () => null,
  };
  const put16 = (addr, v) => { s7b.probe.flash[addr - 0x08000000] = v & 0xff; s7b.probe.flash[addr - 0x08000000 + 1] = (v >> 8) & 0xff; };
  const [c1, c2] = TB.encodeCall(0x08000242, 0x08000260);
  put16(0x08000240, 0xb580);                 // PUSH {r7, lr}
  put16(0x08000242, c1); put16(0x08000244, c2);
  put16(0x08000246, 0xbf00);                 // NOP
  put16(0x08000248, 0xbd80);                 // POP {r7, pc}
  put16(0x08000260, 0x4770);                 // BX LR

  await s7b.writeReg('PC', 0x08000240);
  await s7b.writeReg('LR', 0x08000050);       // 真正的返回地址（调用者）
  s7b.pc = 0x08000240;
  await s7b.step();                           // PUSH：SP 减 8，返回地址入栈
  await s7b.step();                           // BL 0x08000260：LR 被覆盖，PC 进被调函数
  await s7b.step();                           // BX LR：回到 0x08000246
  const pcMid = s7b.pc >>> 0, lrMid = (await s7b.readReg('LR')) >>> 0, spMid = (await s7b.readReg('SP')) >>> 0;
  ok(pcMid === 0x08000246, '走到"刚从一个内部调用返回"的位置（PC=0x' + pcMid.toString(16) + '）');
  ok((lrMid & 0xfffffffe) === 0x08000246 && lrMid !== 0x08000050,
    '此刻 LR 已被内部调用覆盖（LR=0x' + lrMid.toString(16) + '，不是真正的返回地址 0x8000050）');
  ok(!!s7b.sym.funcAt(pcMid).exact && s7b.sym.funcAt(lrMid & ~1).addr === s7b.sym.funcAt(pcMid).addr,
    '页面能识别出"LR 落在本函数里 = 被覆盖"（这正是旧实现原地不动的原因）');

  const rOut = await s7b.stepOut();
  ok(s7b.pc === 0x08000050, `「跳出」正确回到调用者（0x${(s7b.pc >>> 0).toString(16)}，帧已弹掉：SP 0x${spMid.toString(16)} → 0x${((await s7b.readReg('SP')) >>> 0).toString(16)}）`, rOut);
  ok(/覆盖/.test(rOut), '人话里说明了"LR 被覆盖，所以是一步步走回来的"：' + rOut);
  ok(s7b.bpList().length === 0, '这条慢路径也不留临时比较器（' + s7b.bpList().length + ' 个）');

  // next 在最后一条行记录处也必须执行 epilogue；LR 仍是内部调用返回地址。
  await s7b.writeReg('PC', 0x08000240);
  await s7b.writeReg('LR', 0x08000050);
  for (let i = 0; i < 4; i++) await s7b.step();
  await s7b.refreshRegs();
  s7b.sym.lines = {
    nextStmtAddr: () => null,
    at: a => a === 0x08000248 ? { addr: a, end: a + 2, seqEnd: true, isStmt: true } : null,
  };
  const nEnd = await C.runCmd('n', s7b);
  ok(s7b.pc === 0x08000050 && /单步跳出/.test(nEnd.lines[0].t), 'n 在函数最后一行执行收尾并返回调用者', nEnd.lines[0].t);
  ok(/0x08000050/.test(nEnd.lines[1].t) && !/0x08000248/.test(nEnd.lines[1].t), 'n 的 PC 回显使用本次停止位置，不使用旧寄存器缓存', nEnd.lines[1].t);
  ok(s7b.bpList().length === 0, '函数末尾 n 不遗留临时比较器');

  let noRow = '';
  try { await s7b.stepOver(); } catch (e){ noRow = e.message; }
  ok(/没有行号记录/.test(noRow), '行号空洞仍明确报错，不擅自跳出', noRow);
  await s7b.disconnect();
}

// ==================================================================== 18
console.log('== 18. 命令行：b <文件:行> / p <结构体> / bl 显示出处 ==');
{
  const s8 = new S.DebugSession();
  s8.log = () => {};
  await s8.connect({ mock: true });
  s8.sym = symtab;
  const run = async l => (await C.runCmd(l, s8)).lines.map(x => x.t);

  const out = await run('b main.c:30');
  ok(/断点 #1/.test(out[0]) && s8.bpList().length === 1, 'b main.c:30 下断点：' + out[0]);
  ok(/main\.c:30/.test(out[0]), '输出里带出处：' + out[0]);
  const bl = await run('bl');
  ok(bl.some(l => /main\.c:30/.test(l)), 'bl 显示源码出处：' + bl[0].trim());
  const bd = await run('bd main.c:30');
  ok(/删掉断点/.test(bd[0]) && s8.bpList().length === 0, 'bd 也能按 文件:行 删：' + bd[0]);

  const p = await run('p _SEGGER_RTT');
  ok(/结构体|struct|\{/.test(p[0]) && p.some(l => /MaxNumUpBuffers/.test(l)), 'p <结构体> 打成缩进的树（含成员名）');
  ok(p.length > 3, '结构体打印是多行（' + p.length + ' 行）');

  const bad = await (async () => { try { await run('b nope.c:1'); return ''; } catch (e){ return e.message; } })();
  ok(/解析不了|没有叫/.test(bad), 'b 认不出来时报错（不静默）：' + bad);
  const help = (await run('h')).join('\n');
  ok(/n \/ next/.test(help) && /si/.test(help) && /fin/.test(help) && /rc </.test(help), 'help 里列出了新的单步/运行到命令');
  const hb = (await run('h')).join('\n');
  ok(/main\.c:192/.test(hb), 'help 里给出了 文件:行 的例子');
  await s8.disconnect();
}

// ==================================================================== 19
console.log('== 19. 位域解码：嵌套结构体里的位域必须按"所在结构体"起算 ==');
{
  /**
   * 真机压测（2026-10）抓到的缺陷回归：`treeRows` 早先直接拿 DWARF 的 `bitOffset`
   *   去索引字节缓冲，等于假定"位域所在的结构体就在根对象开头"。
   *   一旦位域**嵌套**在结构体里（`g_model.flags.bits.level`），解出来的就是根对象
   *   头 4 个字节的位 —— 实测把 `g_model.magic`（'MODE'）的位当成位域值显示了。
   * 这里用手搭的类型树 + 手算的字节钉死它（不需要 ELF、不需要硬件）。
   */
  const u32 = { kind: 'scalar', size: 4, scalar: 'u32', name: 'uint32_t' };
  const i32 = { kind: 'scalar', size: 4, scalar: 'i32', name: 'int32_t' };
  /** 一个"位域组"：32 位切成 on:1 / level:3 / mode:2 / parity:1 / rev:9 / spare:16 */
  const bitGrp = {
    kind: 'struct', size: 4, name: 'bits_t',
    members: [
      { name: 'on',     offset: 0, type: u32, bitSize: 1,  bitOffset: 0,  reason: null },
      { name: 'level',  offset: 0, type: u32, bitSize: 3,  bitOffset: 1,  reason: null },
      { name: 'mode',   offset: 0, type: u32, bitSize: 2,  bitOffset: 4,  reason: null },
      { name: 'parity', offset: 0, type: u32, bitSize: 1,  bitOffset: 6,  reason: null },
      { name: 'rev',    offset: 0, type: u32, bitSize: 9,  bitOffset: 7,  reason: null },
      { name: 'spare',  offset: 0, type: u32, bitSize: 16, bitOffset: 16, reason: null },
    ],
  };
  /** 外层：magic(4) + flags{word(4) + bits(4) + sbits(4)} —— 位域组在 +8 处 */
  const outer = {
    kind: 'struct', size: 16, name: 'outer_t',
    members: [
      { name: 'magic', offset: 0, type: u32, bitSize: null, bitOffset: null, reason: null },
      { name: 'word',  offset: 4, type: u32, bitSize: null, bitOffset: null, reason: null },
      { name: 'bits',  offset: 8, type: bitGrp, bitSize: null, bitOffset: null, reason: null },
      { name: 'sbits', offset: 12, type: { ...bitGrp, name: 'sbits_t', members: [
        { name: 'bias', offset: 0, type: i32, bitSize: 6, bitOffset: 0, reason: null },
        { name: 'tag',  offset: 0, type: u32, bitSize: 10, bitOffset: 6, reason: null },
      ] }, bitSize: null, bitOffset: null, reason: null },
    ],
  };
  const bytes = new Uint8Array(16);
  const put = (arr, o, v) => { arr[o] = v & 0xff; arr[o + 1] = (v >>> 8) & 0xff; arr[o + 2] = (v >>> 16) & 0xff; arr[o + 3] = (v >>> 24) & 0xff; };
  put(bytes, 0, 0x4D4F4445);   // magic = 'MODE'（陷阱：早先的 bug 会把它当成位域值）
  put(bytes, 4, 0x12345678);   // word
  put(bytes, 8, 0x00FF00FF);   // bits 那个存储单元
  put(bytes, 12, 0xFFFFFFC5);  // sbits：bias 低 6 位 = 0b000101 = 5；符号位 bit5=0 → +5

  const rows = W.treeRows({ type: outer, label: 'o' }, bytes);
  const at = n => rows.find(r => String(r.name).startsWith(n));
  ok(at('on : 1')?.text.startsWith('1'), 'on（bit0）在嵌套结构体里也解得对：' + at('on : 1')?.text);
  ok(at('level : 3')?.text.startsWith('7'), 'level（bit1..3 = 0b111）解得 7：' + at('level : 3')?.text);
  ok(at('mode : 2')?.text.startsWith('3'), 'mode（bit4..5 = 0b11）解得 3：' + at('mode : 2')?.text);
  ok(at('parity : 1')?.text.startsWith('1'), 'parity（bit6 = 1）解得 1：' + at('parity : 1')?.text);
  ok(at('rev : 9')?.text.startsWith('1'), 'rev（bit7..15 = 0x001）解得 1：' + at('rev : 9')?.text);
  ok(at('spare : 16')?.text.startsWith('255'), 'spare（bit16..31 = 0x00FF）解得 255：' + at('spare : 16')?.text);
  ok(at('bias : 6')?.text.startsWith('5'), 'sbits.bias（有符号位域）解得 +5：' + at('bias : 6')?.text);

  // 有符号位域：低 6 位 = 0b111011 = 59 → 作为 6 位有符号数是 -5
  put(bytes, 12, 0x0000003B);
  const rows2 = W.treeRows({ type: outer, label: 'o' }, bytes);
  ok(rows2.find(r => String(r.name).startsWith('bias'))?.text.startsWith('-5'),
    '有符号位域做符号扩展（0b111011 → -5）：' + rows2.find(r => String(r.name).startsWith('bias'))?.text);

  ok(W.signExtend(0b111011, 6) === -5 && W.signExtend(1, 1) === -1 && W.signExtend(0b0011, 3) === 3,
    'signExtend 三位/单位宽都正确');
  ok(W.readBits(new Uint8Array([0x80]), 7, 1) === 1 && W.readBits(new Uint8Array([0x01]), 1, 1) === 0,
    'readBits 位序仍是"最低位在前"（小端 MCU）');
  ok(W.decodeBitfield(new Uint8Array([0x3B, 0, 0, 0]), { inUnit: 0, size: 6, signed: true })?.value === -5,
    'decodeBitfield 直接解有符号位域');
  ok(W.decodeBitfield(bytes, { unresolved: true, size: 6 }) === null, '偏移读不出来时 decodeBitfield 返回 null（不猜）');

  /** 顶层的位域（结构体就是根本身）：`bitRow(mem, 0, …)` 那条路也要对 */
  const topBytes = new Uint8Array(4); put(topBytes, 0, 0xCAFEBABE);
  const topRows = W.treeRows({ type: { kind: 'struct', size: 4, name: 'tb', members: [
    { name: 'lo', offset: 0, type: u32, bitSize: 4, bitOffset: 0, reason: null },
    { name: 'hi', offset: 0, type: u32, bitSize: 4, bitOffset: 28, reason: null },
  ] } }, topBytes);
  ok(topRows.find(r => String(r.name).startsWith('lo'))?.text.startsWith('14'),
    '根对象自己的位域（lo = 0xE）不受影响：' + topRows.find(r => String(r.name).startsWith('lo'))?.text);
  ok(topRows.find(r => String(r.name).startsWith('hi'))?.text.startsWith('12'),
    '根对象的最高半字节（hi = 0xC）：' + topRows.find(r => String(r.name).startsWith('hi'))?.text);
}

// ==================================================================== 20
console.log('== 20. 复合路径：p/w 支持 a.b[2].c（按 DWARF 成员偏移算地址）==');
{
  const p = SY.parsePath('g_model.nodes[1].cell.scale');
  ok(Array.isArray(p) && p.length === 5 && p[0].name === 'g_model' && p[1].name === 'nodes'
     && p[2].index === 1 && p[3].name === 'cell' && p[4].name === 'scale',
    'parsePath 拆出 成员/下标 交替的段：' + JSON.stringify(p));
  ok(SY.parsePath('g_model') === null, '单段名字不算路径（走原来的精确查）');
  ok(SY.parsePath('main+4') === null && SY.parsePath('a->b') === null && SY.parsePath('a[b]') === null,
    '不认的东西一律返回 null（+偏移/箭头/非数字下标）');

  const u32 = { kind: 'scalar', size: 4, scalar: 'u32', name: 'uint32_t' };
  const cell = { kind: 'struct', size: 16, name: 'cell_t', members: [
    { name: 'ch', offset: 0, type: { kind: 'scalar', size: 1, scalar: 'u8', name: 'uint8_t' }, bitSize: null, bitOffset: null, reason: null },
    { name: 'idx', offset: 2, type: { kind: 'scalar', size: 2, scalar: 'u16', name: 'uint16_t' }, bitSize: null, bitOffset: null, reason: null },
    { name: 'flags', offset: 4, type: u32, bitSize: null, bitOffset: null, reason: null },
    { name: 'scale', offset: 8, type: { kind: 'scalar', size: 8, scalar: 'f64', name: 'double' }, bitSize: null, bitOffset: null, reason: null },
  ] };
  const nodesTy = { kind: 'array', size: 4 * 16, count: 4, elem: cell, name: '' };
  const model = { kind: 'struct', size: 80, name: 'model_t', members: [
    { name: 'nodes', offset: 16, type: nodesTy, bitSize: null, bitOffset: null, reason: null },
    { name: 'flags', offset: 0, type: { kind: 'struct', size: 4, name: 'flags_t', members: [
      { name: 'bias', offset: 0, type: { kind: 'scalar', size: 4, scalar: 'i32', name: 'int32_t' }, bitSize: 6, bitOffset: 2, reason: null },
    ] }, bitSize: null, bitOffset: null, reason: null },
  ] };

  /** 假 DWARF：只有顶层变量，成员靠 typeOf 走路径 —— 与真 DWARF 的行为一致 */
  const fakeDwarf = { varType: n => (n === 'g_model' ? { name: 'g_model', addr: 0x24000040, type: model, reason: null } : null) };
  const symForPath = new SY.SymTab({ dwarf: fakeDwarf, vars: [], all: [], funcs: [], objs: [] });

  const t1 = symForPath.typeOf('g_model');
  ok(t1?.addr === 0x24000040, '顶层变量仍走精确查：' + JSON.stringify(t1 && { a: t1.addr }));
  const t2 = symForPath.typeOf('g_model.nodes[1].scale');
  ok(t2?.type?.scalar === 'f64' && t2.addr === ((0x24000040 + 16 + 16 + 8) >>> 0),
    `路径算出地址 = 基址+16(数组)+16(第 1 项)+8(scale) = 0x${(t2?.addr ?? 0).toString(16)}，类型 ${t2?.type?.scalar}`);
  const t3 = symForPath.typeOf('g_model.nodes[3]');
  ok(t3?.type === cell && t3.addr === (0x24000040 + 16 + 3 * 16) >>> 0,
    '数组元素本身也能取到（类型 = cell_t）：0x' + (t3?.addr ?? 0).toString(16));

  const bad1 = symForPath.typeOf('g_model.nodes[9]');
  ok(/越界/.test(bad1?.reason || ''), '下标越界如实报原因（不返回一个错地址）：' + bad1?.reason);
  const bad2 = symForPath.typeOf('g_model.nosuch');
  ok(/没有成员/.test(bad2?.reason || ''), '成员不存在如实报原因：' + bad2?.reason);
  const bad3 = symForPath.typeOf('g_model.nodes[0].ch.deeper');
  ok(bad3 === null || /不是结构体|没有成员/.test(bad3.reason || ''), '标量后面再走成员要报错：' + bad3?.reason);

  const t4 = symForPath.typeOf('g_model.flags.bias');
  ok(t4?.bit && t4.bit.size === 6 && t4.bit.inUnit === 2 && t4.bit.signed === true,
    '位域成员带出 bit{inUnit,size,signed}（bitOffset 2 在存储单元内仍是 2）：' + JSON.stringify(t4?.bit));

  const w1 = W.resolveWatch('g_model.nodes[1].scale', symForPath);
  ok(w1.kind === 'var' && w1.scalar === 'f64' && w1.addr === t2.addr, '监视窗口认复合路径：' + JSON.stringify({ k: w1.kind, s: w1.scalar, a: w1.addr }));
  const w2 = W.resolveWatch('g_model.nodes[2]', symForPath);
  ok(w2.kind === 'struct' && w2.type === cell, '监视复合路径指向结构体时是可展开的树：' + w2.kind + ' / ' + w2.typeName);
  const w3 = W.resolveWatch('g_model.flags.bias', symForPath);
  ok(w3.bit && /位域/.test(w3.typeName), '监视位域成员带 bit 信息（取值时按位切）：' + w3.typeName);
  const wv = W.formatWatchValue({ ...w3, size: 4 }, new Uint8Array([0x3B, 0, 0, 0]));
  ok(wv.text.startsWith('14'), '位域监视项按位取值（bytes[0]=0b00111011 从 bit2 取 6 位 = 0b001110 = 14，而不是整个 0x3B）', wv.text);
  const w4 = W.resolveWatch('g_model.nope', symForPath);
  ok(w4.error && /没有成员/.test(w4.error), '路径走不通时如实报错、不画一棵看着正常的树：' + w4.error);
  const pb = await (async () => {
    const s9 = new S.DebugSession();
    s9.log = () => {};
    await s9.connect({ mock: true });
    s9.sym = symForPath;
    try { await C.runCmd('p g_model.nope', s9); await s9.disconnect(); return ''; }
    catch (e){ await s9.disconnect(); return e.message; }
  })();
  ok(/没有成员/.test(pb), '命令行 p 走不通的路径也如实报错：' + pb);
}

// ==================================================================== 21
console.log('== 21. 行号写错时说人话（文件只有 1~N 行）==');
{
  const lines = symtab.lines;
  const r1 = lines?.lineRange?.('main.c');
  ok(!!r1 && r1.max > r1.min, 'lineRange 给出文件的行号范围：' + JSON.stringify(r1));
  const e1 = symtab.breakSpec('main.c:99999');
  ok(/只有第 \d+~\d+ 行/.test(e1.error || ''), 'b main.c:99999 报"文件只有 1~N 行"：' + e1.error);
  const e2 = symtab.breakSpec('main.c:1');
  ok(/只有第 \d+~\d+ 行/.test(e2.error || ''), '比最小行还小的行号也给范围提示：' + e2.error);
  const e3 = symtab.breakSpec('main.c:30');
  ok(!e3.error && e3.addr === 0x08000056, '范围内的行照常解析：0x' + (e3.addr ?? 0).toString(16));
  ok(symtab.breakSpec('nosuchfile.c:3').error?.includes('行号表里没有叫'), '文件不存在时仍报"没有这个源文件"');
}

// ==================================================================== 22
console.log('== 22. nextAddrsOf：分支/返回指令的"落点"（断点单步的地基）==');
{
  /** 造一台"内存"：按地址放半字，另外给寄存器与栈 */
  const mk = (mem, regs = {}) => ({
    readHalf: async a => (mem[(a >>> 0) & ~1] ?? 0xbf00),
    readWord: async a => ((mem[(a >>> 0) & ~1] ?? 0) | ((mem[((a >>> 0) & ~1) + 2] ?? 0) << 16)) >>> 0,
    readReg: async n => (n in regs ? regs[n] : null),
  });
  const P = 0x08000100, S = 0x20010000;
  const nop = 0xbf00;

  // 顺序执行：16 位 NOP → pc+2；32 位 mov.w r0,#0 → pc+4
  let r = await TB.nextAddrsOf(P, mk({ [P]: nop }));
  ok(r.addrs.length === 1 && r.addrs[0] === P + 2 && r.certain, 'NOP → 下一条（pc+2）：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xf04f, [P + 2]: 0x0000 }));
  ok(r.addrs.length === 1 && r.addrs[0] === P + 4 && r.certain, '32 位非分支指令 → pc+4（长度判对）：' + JSON.stringify(r));

  // bx lr / bx r3 / blx r3
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x4770 }, { LR: 0x08000201 }));
  ok(r.addrs[0] === 0x08000200 && /bx lr/.test(r.why), 'bx lr → LR（抹 Thumb 位）：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x4718 }, { R3: 0x08000301 }));
  ok(r.addrs[0] === 0x08000300, 'bx r3 → R3：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x4798 }, { R3: 0x08000401 }));
  ok(r.addrs[0] === 0x08000400 && /blx r3/.test(r.why), 'blx r3 → R3（间接调用）：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x4718 }));
  ok(r.certain === false && r.addrs[0] === P + 2, '读不到寄存器时如实标"不确定"（不假装知道、更不能当成寄存器=0）：' + JSON.stringify(r));

  // pop {…, pc}：从栈上取返回地址
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xbd80, [S - 8]: 0x11111110, [S - 4]: 0x22222222 }, { SP: S - 8 }));
  ok(r.addrs[0] === 0x22222222 && /pop/.test(r.why), 'pop {r7,pc} → [sp+4]：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xbd00, [S]: 0x33333332 }, { SP: S }));
  ok(r.addrs[0] === 0x33333332, 'pop {pc} → [sp+0]：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xe8bd, [P + 2]: 0x8080, [S - 12]: 0x11111110, [S - 8]: 0x44444444 }, { SP: S - 12 }));
  ok(r.addrs[0] === 0x44444444, 'pop.w {r7,pc}（32 位）→ [sp+4]：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x9d01, [S + 4]: 0x55555554 }, { SP: S }));
  ok(r.addrs[0] === 0x55555554 && /ldr pc/.test(r.why), 'ldr pc,[sp,#4] → [sp+4]：' + JSON.stringify(r));

  // mov pc, …（0x46F7 = mov pc, lr；0x46BF = mov pc, r7）与普通 mov 的区别
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x46f7 }, { LR: 0x08000500 }));
  ok(r.addrs[0] === 0x08000500, 'mov pc, lr（编码 0x46F7）→ LR：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x46bf }, { R7: 0x08000600 }));
  ok(r.addrs[0] === 0x08000600, 'mov pc, r7（0x46BF）→ R7：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0x4608 }, { R1: 0xdeadbeef }));
  ok(r.addrs[0] === P + 2, '普通 mov r0,r1（0x4608）不改变控制流 → pc+2：' + JSON.stringify(r));

  // b / bcc / cbz
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xe004 }));
  ok(r.addrs[0] === P + 4 + 8 && /无条件/.test(r.why), 'b +8（16 位）→ 目标：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xe7fe }));
  ok(r.addrs[0] === P, 'b .（自己跳自己）→ 目标 == 自己：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xd002 }));
  ok(r.addrs.length === 2 && r.addrs.includes(P + 2) && r.addrs.includes(P + 8), 'bcc → **两个候选都返回**（跳 / 不跳，不跳是 pc+2）：' + JSON.stringify(r));
  r = await TB.nextAddrsOf(P, mk({ [P]: 0xb108 }));
  ok(r.addrs.length === 2 && r.addrs.includes(P + 2) && r.addrs.includes(P + 6), 'cbz → 两个候选（pc+2 与 pc+6）：' + JSON.stringify(r));

  // bl（调用）：落点 = 被调函数入口（指令级单步是"进入"语义）
  const [c1, c2] = TB.encodeCall(P, 0x08000300);
  r = await TB.nextAddrsOf(P, mk({ [P]: c1, [P + 2]: c2 }));
  ok(r.addrs[0] === 0x08000300 && /bl 调用/.test(r.why), 'bl → 被调函数入口：' + JSON.stringify(r));
  // 反向自证：bl 的目标不能算成 pc+4（那是老的错法）
  ok(r.addrs[0] !== P + 4, 'bl 的落点不是 pc+4（旧兜底就是这么错的）');
}

// ==================================================================== 23
console.log('== 23. ≥0x80000000 的地址：断点表比对不能踩"有符号掩码"的坑（HPM6800EVK 真机定因）==');
{
  /**
   * 现场（HPM6800EVK，代码在 0x80005xxx）：
   *   `_bpAt()` 早先写的是 `const a = (addr >>> 0) & 0xfffffffe` —— RHS 是**有符号** int32（负数），
   *   而左边是 `((b & ~1) >>> 0)`（无符号）→ 0x8000xxxx 的地址**永远匹配不上**。
   *   后果不是"小毛病"：`_withBpCleared()` 不摘触发器 → 单步原地不动；
   *   `cont()` 不跨过断点 → 一放就跑回同一个断点（"4 个断点只有 1 个会命中"）。
   *   所以这里把"高地址必须能对上"钉死。
   */
  const s = new S.DebugSession();
  s.log = () => {};
  await s.connect({ mock: true });
  s._programFpb = async () => {};                       // 只验断点表逻辑，不碰硬件
  s.caps = { numCode: 8, rev: 2, raw: 0 };             // rev2：不限制地址范围

  s.bps = [0x80005ae8, 0x80006094];
  ok(s._bpAt(0x80005ae8) !== undefined, '_bpAt 认 0x80005ae8（有符号掩码会永远匹配不上）');
  ok(s._bpAt(0x80005ae9) !== undefined, '_bpAt 忽略最低位（半字对齐）');
  ok(s._bpAt(0x80005aea) === undefined, '_bpAt 不把相邻地址算成命中');
  ok(s._bpAt(0x80006094) !== undefined, '_bpAt 认第二个高地址断点（多断点的地基）');

  let inside = null;
  await s._withBpCleared(0x80005ae8, async () => { inside = s.bps.slice(); });
  ok(inside && inside.length === 1 && inside[0] === 0x80006094,
    '_withBpCleared 在跑之前真的把那个地址摘掉了（单步/继续都要靠它）', JSON.stringify(inside));
  ok(s.bps.length === 2 && s.bps[0] === 0x80005ae8, '跑完把断点原样装回来');

  s.bps = [];
  await s.bpAdd(0x80005ae8);
  ok(s.bps.length === 1 && s.bps[0] === 0x80005ae8, 'bpAdd 存的是**无符号**地址（不然后面每次比对都要出岔子）');
  const dup = await s.bpAdd(0x80005ae8);
  ok(dup.warn && s.bps.length === 1, '同一地址重复下断点会被认出来（不占第二个比较器）');
  ok(await s.bpDel(0x80005ae8) === true && s.bps.length === 0, 'bpDel 能删掉高地址断点（有符号掩码会删不掉）');
  ok(await s.bpDel(0x80005ae8) === false, '删不存在的断点回 false（命令层据此说"没有这个断点"）');

  // RISC-V 侧同一套逻辑（触发器）：bpAdd/bpDel 与 _bpAt 共用基类实现
  const RV = await import(url('dbg/riscv.js'));
  const rv = new RV.RiscvDebugSession();
  rv.log = () => {};
  rv.caps = { numCode: 8, rev: 2, raw: 8 };
  rv._programBps = async () => {};                     // 触发器写入需要真硬件，这里只验表逻辑
  await rv.bpAdd(0x8000578c, 'engine_linear');
  await rv.bpAdd(0x80005ae8, 'engine_dispatch');
  ok(rv.bps.length === 2 && rv._bpAt(0x80005ae8) !== undefined, 'RISC-V：两个高地址触发器都能对上');
  ok(rv.bpNotes.get(0x80005ae8) === 'engine_dispatch', '断点备注按无符号地址存（bpList 才显示得出来）');
  const list = rv.bpList();
  ok(list.length === 2 && list[1].addr === 0x80005ae8 && list[1].note === 'engine_dispatch',
    'bpList 里高地址显示正常（不是负数、备注也在）', JSON.stringify(list));
  ok(await rv.bpDel(0x80005ae8) === true && rv.bps.length === 1 && rv.bps[0] === 0x8000578c,
    'RISC-V：删掉第二个断点后表里只剩第一个');
}

console.log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
