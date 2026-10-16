/**
 * 调试器页（#dbg）**真机压力测试** —— 发布前的总验收（2026-10）
 *
 *   node tools/selftest/dbg-hw-stress.mjs                       # 默认 H743 靶子
 *   node tools/selftest/dbg-hw-stress.mjs --board=f103ze        # F103ZE 靶子（同一套断言）
 *   node tools/selftest/dbg-hw-stress.mjs --elf=/tools/.../build-dw5/fw.elf    # 换 DWARF5 靶子
 *
 * 前置（跟其它页面套件一样）：
 *   1) 靶子固件已经烧进板子 —— 见下面的 BOARDS 表（两块板的固件都在 tools/target-firmware/）
 *   2) 8899 静态服务 + 9333 调试浏览器在跑（make page-prep）
 *   3) akaLinkPro 探针插着，且**没有被别的工具占着**（OpenOCD/pyOCD 要先退掉）
 *
 * 两块板的差别只有三处（其余断言逐条相同，这就是"一块靶子两种芯片"的意思）：
 *   · **靶子固件/源码目录**：h743 = stm32h743_dbgstress，f103ze = stm32f103_dbgstress
 *     （同一套源码，只换 -mcpu 与链接脚本，见各自目录的 README）；
 *   · **BOOT0**：本机那块 F103ZE 的 **BOOT0 = 1**，复位后核先进 ROM bootloader，
 *     所以"复位并停"之后要按**唤醒配方**把 VTOR/SP/PC 搬回 flash（脚本自己会做，
 *     日志里会写明"BOOT0 唤醒"）。H743 那块板 BOOT0=0，复位即进固件，不需要。
 *   · **FPB 比较器个数**：M7 = 8、M3 = 6（脚本按 `session.caps.numCode` 直读硬件，
 *     不再写死 8 —— 早先那份 `fpb()` 固定读 8 个，在 M3 上会多读两个不存在的槽）。
 *
 * 与 `dbg-hw.mjs` / `tmp/dbg-hw-new.mjs` 的分工：那两个是"冒烟"，本文件是**压**：
 *   · 断点：文件:行 / 符号 / static 函数 / 函数+偏移 / 多断点 / ISR / 反复命中 / 越界与内联函数报错
 *   · 代码同步：每次停下都要 PC → 源码位置自洽（跨源文件、指令级步进时行号不跳）
 *   · 单步：O0 线性序列 20 步、si/si 进调用（含 **BLX Rn 间接调用**）、n 跳过调用、
 *           fin 逐层爬 5 层（含 **LR 被内部调用覆盖**的非叶子情形）
 *   · 复位重跑：复位必须停在**复位向量**上 → 断点仍然有效 → 再命中（连续 3 轮）
 *   · 监视 / 结构体树：位域与影子字逐位对账、复合路径、指针、char[]、越界报错
 *   · 泄漏：每一段之后 FPB 比较器必须"只剩用户断点占的那些"（直读 FP_COMP 核对）
 *   · 压力：连续 60 次停-走-停，看有没有比较器泄漏 / 页面未捕获错误
 *
 * 有 gdb 对照文件时（H743 由 tmp/dbg-gdb-oracle.mjs 生成）会**逐地址比对**
 * "单步序列"与"断点落点" —— 与 arm-none-eabi-gdb 的结果必须完全一致，
 * 这是"和 MDK/gdb 一个水平"这句话的硬证据。
 */
import { Cdp, sleep, DEV_RE } from './cdp-lib.mjs';
import { writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifact } from './board-matrix.mjs';
import { readJson,validateOracle } from './dbg-frame-contract.mjs';
import { Elf } from '../../app/elf/elf.js';
import { runFrameStress } from './dbg-frame-hw-runner.mjs';
import { confirmedM7BreakpointRace } from './dbg-breakpoint-proof.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : (argv.includes('--' + k) ? true : d); };

/**
 * 板子档案：芯片相关的**默认值**全在这里（命令行仍可用 --elf / --src / --oracle / --out 覆盖）。
 * `boot0: 1` = 复位后核先进 ROM bootloader，套件会在"复位并停"之后自动唤醒。
 */
const BOARDS = {
  h743: {
    label: 'STM32H743（阿波罗 H743 · Cortex-M7）',
    elf: '/' + artifact('h743', 'dbgstress'),
    src: 'tools\\target-firmware\\stm32h743_dbgstress\\src',
    oracle: 'tmp/gdb-oracle.json',
    out: 'tmp/dbg-stress-page.json',
    /** 读它必须总线 FAULT：DTCM(0x20000000+128K) 之后是空洞 */
    faultAddr: 0x20020000,
    faultText: 'DTCM 末尾之后的空洞',
    boot0: 0,
    clockKhz: 10000,
  },
  f103ze: {
    label: 'STM32F103ZE（本机那块 · Cortex-M3）',
    elf: '/' + artifact('f103ze', 'dbgstress'),
    src: 'tools\\target-firmware\\stm32f103_dbgstress\\src',
    /** 别跟 H743 那份共用：忘了删的旧 oracle 会让逐地址比对整段"假红" */
    oracle: 'tmp/gdb-oracle-f103.json',
    out: 'tmp/dbg-stress-page-f103.json',
    /** 读它必须总线 FAULT：SRAM(0x20000000+64K) 之后是空洞 */
    faultAddr: 0x20020000,
    faultText: 'SRAM 末尾之后的空洞',
    boot0: 1,
    clockKhz: 10000,
  },
  f103cb: {
    label: 'STM32F103CB（当前板 · Cortex-M3）',
    elf: '/' + artifact('f103cb', 'dbgstress'),
    src: 'tools\\target-firmware\\stm32f103_dbgstress\\src',
    oracle: 'tmp/gdb-oracle-f103cb.json',
    out: 'tmp/dbg-stress-page-f103cb.json',
    /** CB SRAM 末端为 0x20005000，越界读必须仍然得到总线 FAULT。 */
    faultAddr: 0x20005000,
    faultText: 'SRAM 末尾之后的空洞',
    boot0: 0,
    /** 杜邦线连接下先用 1 MHz 调试时钟，调试压力本身与 RTT 60 MHz 流程分开。 */
    clockKhz: 1000,
  },
};
const BOARD_ID = String(arg('board', 'h743'));
const BOARD = BOARDS[BOARD_ID];
if (!BOARD) throw new Error(`--board 只认 ${Object.keys(BOARDS).join(' / ')}（给的是 ${BOARD_ID}）`);

const APP = 'http://127.0.0.1:8899/index.html';
const ELF = String(arg('elf', BOARD.elf));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRCDIR = String(arg('src', resolve(ROOT, BOARD.src.replaceAll('\\','/'))));
const SRC_ENGINE = join(SRCDIR, 'engine.c');
/**
 * 页面侧拿源码只能走**静态服务**（8899 的根 = 仓库根），所以把磁盘路径换算成 URL 路径。
 * 为什么要这么绕：见下面"源码目录"那段的 🚨。
 */
const SRC_REL = relative(ROOT, resolve(SRCDIR));
if (SRC_REL.startsWith('..')) throw new Error('--src 必须指向仓库里的目录（页面是通过 8899 静态服务取源码的）：' + SRCDIR);
const SRC_HTTP = '/' + SRC_REL.split(sep).join('/');
const SRC_NAMES = readdirSync(resolve(SRCDIR)).filter(f => /\.(c|h)$/i.test(f)).sort();
const ORACLE = String(arg('oracle', BOARD.oracle));
const JSON_OUT = String(arg('out', BOARD.out));
const FRAME_ONLY=!!arg('frames-only',false),FRAME_ORACLE=arg('frame-oracle');
const FRAME_ROUNDS=Number(arg('frame-rounds',200));
if(!Number.isInteger(FRAME_ROUNDS)||FRAME_ROUNDS<1||FRAME_ROUNDS>2000)throw new Error('--frame-rounds 必须为1..2000');
let frameOracle=null,frameBuild=null,frameCode=[];
if(FRAME_ONLY||arg('require-frame-oracle')||FRAME_ORACLE){
 if(!FRAME_ORACLE)throw new Error('发布栈帧验收必须指定 --frame-oracle');
 const elfDisk=resolve(ROOT,ELF.replace(/^\//,'')),bytes=readFileSync(elfDisk);
 frameBuild=readJson(join(dirname(elfDisk),'build-info.json'));frameOracle=readJson(String(FRAME_ORACLE));
 validateOracle(frameOracle,frameBuild,bytes,BOARD_ID);
 const image=new Elf(new Uint8Array(bytes));frameCode=image.sections().filter(s=>(s.flags&2)&&!(s.flags&1)&&s.type===1&&s.addr>=0x08000000&&s.addr<0x09000000).map(s=>({name:s.name,addr:s.addr,bytes:[...image.data(s.name)]}));
 if(!FRAME_ONLY)throw new Error('栈帧验收会验证断开清理；请使用 --frames-only，既有综合验收另行执行');
}

/** SWD 时钟（kHz）：默认取板子档案；`--clock=5000` 可覆盖（排"是链路还是代码"时用） */
const CLOCK_KHZ = Number(arg('clock', BOARD.clockKhz || 10000));
setTimeout(() => { console.error('[WATCHDOG] 25 分钟'); process.exit(9); }, 1500000);

// 靶子源码里的两个关键行号（"调用 engine_leaf 的那一句" / "内联那一句"）—— 用来把
// "单步进入"和"内联不可下断点"钉在确定的位置上，而不是靠猜步数。
const engLines = readFileSync(SRC_ENGINE, 'utf8').split(/\r?\n/);
const CALL_LINE = engLines.findIndex(l => /engine_leaf\(a, 3u\)/.test(l)) + 1;
const CALL2_LINE = engLines.findIndex(l => /engine_leaf\(a, 5u\)/.test(l)) + 1;

const log = m => console.log(m);
let pass = 0, fail = 0;
const failures = [];
const sec = t => log('\n' + t);
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' —— ' + extra : '')); log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const hex = n => '0x' + ((n ?? 0) >>> 0).toString(16);

// ---------------------------------------------------------------- 连接
const cdp = new Cdp();
await cdp.connect();
await cdp.send('Page.navigate', { url: APP + '?t=' + Date.now() });
for (let i = 0; i < 80; i++){ await sleep(300); if (await cdp.eval('return !!window.__tools?.dbg;').catch(() => false)) break; }
await cdp.eval(`document.querySelector('#tabs .tab[data-tab="dbg"]').click(); await new Promise(r=>setTimeout(r,250)); return true;`);
log(`== 靶子：${BOARD.label}（--board=${BOARD_ID}）==`);
log(`   ELF   ${ELF}`);
log(`   源码  ${SRC_HTTP}（${SRC_NAMES.length} 个文件）${BOARD.boot0 ? ' · 该板 BOOT0=1，复位后脚本会自动唤醒' : ''}`);

/** 页面里的小工具（一次注入；`cmd()` 会丢掉回显行，`go/step` 会等到停下为止） */
await cdp.eval(`
  const d = window.__tools.dbg;
  window.__S = {
    d,
    /** 「目标被意外复位 → 自愈」的记录（收尾会打出来；不该有，有就得看是哪一步） */
    recoveries: [],
    async cmd(line){
      const el = document.getElementById('d-out');
      const n0 = el.children.length;
      const r = await d.runLine(line);
      let rows = [...el.children].slice(n0).map(c => c.textContent.trim());
      if (rows.length && rows[0].startsWith('>')) rows = rows.slice(1);      // 第一行是命令回显
      // 保留命令的结构化结果（bt/backtrace 等命令会把解析后的对象放在这里），
      // 同时继续提供旧的文字输出字段给已有断言使用。
      return { ...r, out: rows, err: r?.error || null, text: rows.join('\\n') };
    },
    snap(){
      const cur = document.querySelector('#d-src .srcrow.cur');
      return {
        pc: d.session.pc >>> 0, halted: !!d.session.halted, connected: !!d.session.connected,
        name: d.sym ? d.sym.nameOf(d.session.pc >>> 0) : '',
        pos: document.getElementById('d-src-pos').textContent,
        file: document.getElementById('d-src-file').textContent,
        bps: d.session.bpList().length, srcRows: document.querySelectorAll('#d-src .srcrow').length,
        curLine: cur ? Number(cur.dataset.line) : null,
        at: d.sym ? d.sym.at(d.session.pc >>> 0) : null,
      };
    },
    /** 继续运行，等到停下来（断点命中/手动暂停）或超时 */
    async go(ms = 4000){
      const wait = async (budget) => {
        const t0 = Date.now();
        while (Date.now() - t0 < budget){
          await new Promise(r => setTimeout(r, 25));
          await d.session.refresh();
          if (d.session.halted) break;
        }
      };
      await d.session.cont();
      await wait(ms);
      if (d.session.halted){ await d.afterStop(); return this.snap(); }
      /**
       * 🚨 超时不一定是"断点没命中"——**靶子可能已经不在跑我们的固件了**。
       *
       * 2026-10 F103 真机定因（本文件最费劲的一条）：探针偶发 AP FAULT 时，页面会走
       * _healIfFaulted() → _targetInit() → **把目标复位**。这块 F103ZE 的 BOOT0 = 1，
       * 复位后核进 ROM bootloader 且 **VTOR = 0**（向量表指向 0）—— 固件一条指令都取不到，
       * 表现就是"SysTick 不再加 g_ticks、断点永远不命中、DHCSR 却说在跑"，
       * 而且**会一直坏到有人把 VTOR/SP/PC 搬回来为止**（跨会话也一直坏，实测过）。
       *
       * 所以这里做一次"看它还活着吗 → 不活就按唤醒配方拉回来 → 重新下发断点 → 再等一次"。
       * 复位会把 FPB 比较器一起清掉（调试单元复位），所以断点表必须重发。
       * 这一步**只做一次**，而且会记进 __S.recoveries 让收尾打出来 —— 不掩盖问题。
       */
      const a = await this.alive();
      if (!a.ok){
        const w = await this.wake();
        this.recoveries.push({ ...w, alive: a, at: new Date().toISOString() });
        try { await d.session._programBps(); } catch (e){ this.recoveries.push({ bpErr: String(e.message || e) }); }
        await new Promise(r => setTimeout(r, 200));
        await d.session.cont();
        await wait(ms);
        if (d.session.halted) await d.afterStop();
      }
      return this.snap();
    },
    /** 靶子还活着吗：SysTick 在给 g_ticks 加一 / 主循环在给 g_loops 加一（都比 PC 可靠） */
    async alive(){
      const rd = async n => { const s = d.sym.find(n); if (!s) return null;
        try { return (await d.session.memRead(s.addr >>> 0, 4)).reduce((a, b, i) => a | (b << (8 * i)), 0) >>> 0; } catch { return null; } };
      const t0 = await rd('g_ticks'), l0 = await rd('g_loops');
      await new Promise(r => setTimeout(r, 250));
      const t1 = await rd('g_ticks'), l1 = await rd('g_loops');
      const moved = (x, y) => x != null && y != null && y > x;
      return { t0, t1, l0, l1, ok: moved(t0, t1) || moved(l0, l1) };
    },
    /** 唤醒配方：复位清异常态 → VTOR/SP/PC 搬回 flash（BOOT0=1 的板子只能这么拉回来） */
    async wake(){
      const u32 = b => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
      const w32 = v => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      const out = { before: {}, after: {} };
      try { out.before = { vtor: '0x' + u32(await d.session.memRead(0xE000ED08, 4)).toString(16),
                           cfsr: '0x' + u32(await d.session.memRead(0xE000ED28, 4)).toString(16),
                           hfsr: '0x' + u32(await d.session.memRead(0xE000ED2C, 4)).toString(16),
                           dhcsr: '0x' + ((await d.session.probe._readWord(0xE000EDF0)) >>> 0).toString(16) }; } catch {}
      await d.session.probe.writeMem(0xE000ED0C, w32(0x05fa0004));            // AIRCR.SYSRESETREQ
      await new Promise(r => setTimeout(r, 400));
      await d.session.halt().catch(() => {});
      await d.session.probe.writeMem(0xE000ED08, w32(0x08000000));           // VTOR → flash 向量表
      const v = await d.session.probe.readMem(0x08000000, 8);
      await d.session.writeReg('SP', u32(v));
      await d.session.writeReg('PC', u32(v.subarray(4, 8)));
      await d.session.writeReg('PRIMASK', 0).catch(() => {});
      await d.session.writeReg('FAULTMASK', 0).catch(() => {});
      await d.session.cont();
      await new Promise(r => setTimeout(r, 300));
      try { out.after = { vtor: '0x' + u32(await d.session.memRead(0xE000ED08, 4)).toString(16) }; } catch {}
      return out;
    },
    /** 单步（n / si / fin / s），等到停下 */
    async step(cmd, ms = 4000){
      const el = document.getElementById('d-out');
      const n0 = el.children.length;
      await d.runLine(cmd);
      const t0 = Date.now();
      while (Date.now() - t0 < ms && !d.session.halted){ await new Promise(r => setTimeout(r, 25)); await d.session.refresh(); }
      if (d.session.halted) await d.afterStop();
      let rows = [...el.children].slice(n0).map(c => c.textContent.trim());
      if (rows.length && rows[0].startsWith('>')) rows = rows.slice(1);
      return { ...this.snap(), out: rows, text: rows.join('\\n') };
    },
    /**
     * FPB 比较器占用：直读 FP_CTRL/FP_COMPx（泄漏检查的硬证据）。
     *
     * 🚨 两个位置都得对，否则计数整体错位（2026-10 F103 真机抓到）：
     *    · 比较器从 **FP_COMP0 = 0xE0002008** 起，4 字节一个（0xE0002004 是 FP_REMAP，
     *      它**不是**比较器 —— 老版这份写成 4 + i*4 就把 REMAP 当成了 0 号比较器，
     *      而 F103 上 REMAP 读出来是 0x326720c0 这种非零残值 → 每次计数都多 1）；
     *    · 个数按硬件报的来（session.caps.numCode：M7 = 8、M3 = 6），别写死 8：
     *      M3 只有 6 个，多读的两个槽读到的是**别的寄存器**（本机实测 0xE0002020/24
     *      有非零残值），同样会让计数虚高。
     */
    async fpb(){
      const n = d.session.caps?.numCode || 0;
      const ctrl = (await d.session.probe._readWord(0xE0002000)) >>> 0;
      const raw = n ? await d.session.memRead(0xE0002008, 4 * n) : new Uint8Array(0);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      const comps = [];
      for (let i = 0; i < n; i++) comps.push(dv.getUint32(i * 4, true) >>> 0);
      return { ctrl, n, enabled: !!(ctrl & 1), used: comps.filter(c => c !== 0).length, comps };
    },
    /**
     * 「复位并停」+ （BOOT0=1 的板子）**唤醒配方**。
     *
     * 本机那块 F103ZE 的 BOOT0 是 1：复位后核进的是**系统存储区的 ROM bootloader**，
     * 复位向量取自 ROM（PC 落在 0x1FFFxxxx），flash 里的固件一条指令都取不到 ——
     * 于是"复位并停 → 继续 → 断点命中"这条链在它身上必失败，而这不是调试链的问题。
     *
     * 唤醒配方（与 tmp/dbg-step-hw.mjs / tools/selftest/dbg-step-hw.mjs 同款）：
     *   ① 写 VTOR = 0x08000000（BOOT0=1 时复位后 VTOR=0，向量表指向 ROM，固件里的向量都用不上）；
     *   ② 从 0x08000000 取 SP / 复位向量写回内核寄存器，清 PRIMASK / FAULTMASK。
     * 之后 PC 就停在**固件的复位向量**上，等价于"复位并停"该有的样子（断点、单步都从这儿开始）。
     *
     * @returns {{pc:number, woken:boolean, romPc:number, log:string[]}}
     */
    async resetToFirmware(useWake){
      const l = [];
      const r = await this.cmd('reset halt');
      const u32 = b => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
      const w32 = v => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      let pc = d.session.pc >>> 0;
      const romPc = pc;
      let woken = false;
      if (useWake && pc >= 0x1ff00000 && pc < 0x20000000){
        const p = d.session.probe;
        await p.writeMem(0xE000ED08, w32(0x08000000));
        const w = await p.readMem(0x08000000, 8);
        await d.session.writeReg('SP', u32(w));
        await d.session.writeReg('PC', u32(w.subarray(4, 8)));
        await d.session.writeReg('PRIMASK', 0).catch(() => {});
        await d.session.writeReg('FAULTMASK', 0).catch(() => {});
        await d.session.refresh();
        await d.afterStop();
        pc = d.session.pc >>> 0;
        woken = true;
        l.push('BOOT0 唤醒：ROM ' + '0x' + romPc.toString(16) + ' → flash 复位向量 0x' + pc.toString(16));
      }
      return { pc, woken, romPc, log: l, out: r.text.slice(0, 100) };
    },
    /** 泄漏 = 硬件比较器占用有没有超出"用户断点"该占的个数 */
    async leak(){
      const f = await this.fpb();
      const bps = d.session.bpList().length;
      return { bps, used: f.used, extra: f.used - bps, ctrl: '0x' + f.ctrl.toString(16),
               comps: f.comps.map(c => '0x' + c.toString(16)) };
    },
  };
  return true;`);

/**
 * 🚨 这颗探针**偶发 AP FAULT**：`SWD FAULT（传输 0/1 条，地址 0x4）`（2026-10 F103 真机实测，
 * 2 MHz 与 10 MHz 一样会撞，跟时钟档无关）。页面对此的既定设计是：**标脏 + `abort()` 清 sticky，
 * 并在下一次访问前走 `_healIfFaulted()` → `_targetInit()` 把口子重新初始化**（dap-webusb.js:482-497）。
 * 也就是说"一次 FAULT"对页面是**可恢复**的瞬态，而套件如果一撞就整轮 throw，
 * 测的就不是被测代码、而是这根线的脾气了。
 *
 * 所以这里给 session 的传输类方法统一包一层"**撞 FAULT 就重试（最多 4 次）**"，
 * 并把次数记进 `window.__faulWrap.n`（收尾打出来 —— 悄悄重试等于把问题藏了）。
 */
await cdp.eval(`
  if (${JSON.stringify(FRAME_ONLY)}) return true;
  const S = window.__tools.dbg.session;
  if (!window.__faultWrap){
    window.__faultWrap = { n: 0, which: {} };
    const isFault = e => /FAULT|NO ACK|传输 0\\/1 条|Unable to (claim|reset)|device was disconnected/i.test(String(e?.message || e));
    const wrap = (name) => {
      const fn = S[name];
      if (typeof fn !== 'function' || fn.__wrapped) return;
      const w = async (...a) => {
        let last;
        for (let i = 0; i < 4; i++){
          try { return await fn.apply(S, a); }
          catch (e){
            last = e;
            if (!isFault(e)) throw e;
            window.__faultWrap.n++; window.__faultWrap.which[name] = (window.__faultWrap.which[name] || 0) + 1;
            /**
             * 🚨 光重试是不够的：**FAULT 会把 AHB-AP 的 sticky 错误位留在那里**，
             *    而 _dhcsr()/_setTAR() 这条路径上**没有** heal 调用（readMem/writeMem 里才有），
             *    于是"同一个 halt() 连试 4 次全都 FAULT"（2026-10 实测就是这样）。
             *    这里显式走一次页面自己的自愈入口，再重试。
             */
            try { await S.probe._healIfFaulted(); }
            catch (e2){ window.__faultWrap.healErr = String(e2?.message || e2); }
            await new Promise(r => setTimeout(r, 200));
          }
        }
        throw last;
      };
      w.__wrapped = true; S[name] = w;
    };
    for (const m of ['memRead', 'memWrite', 'halt', 'run', 'cont', 'refresh', 'refreshRegs', 'readReg',
                     'writeReg', 'step', 'bpAdd', 'bpDel', 'bpClear', '_programFpb', '_programBps', 'ensureHalted']) wrap(m);
  }
  return true;`);

/**
 * 源码目录用**真文件**喂进去 —— 但**不能**用 `DOM.setFileInputFiles`。
 *
 * 🚨 2026-10 查实（Chrome 153）：那条 CDP 命令对 `webkitdirectory` 的 input **静默无效** ——
 *    命令不报错，可 `input.files.length` 恒为 0、`change` 事件也不触发，于是 `d.src` 永远是空的。
 *    对照实验（都是同一个命令、同一个存在的文件）：
 *      · `#d-elf-file`（普通 file input）      → 读回 `files.length = 1` ✔
 *      · `#d-src-dir`（webkitdirectory input） → 读回 `files.length = 0` ✘（传目录 / 传文件列表都一样）
 *    后果就是 `make test-dbg-stress` **稳定**报「源码目录已喂进页面（真文件）：还没选源码目录」，
 *    而且这跟被测代码无关（页面侧选择目录那条路是好的，只有自动化喂不进去）。
 *
 * 现在改成：在**页面里** fetch 这些 .c/.h（它们就在静态服务的根下）、造 `File` 对象，交给
 * `_indexSrcFiles()`。页面侧的索引、ELF 绝对路径的后缀匹配、读源码全都走同一条路
 * （`indexFileList()` 对没有 `webkitRelativePath` 的 File 走 `f.name` 分支，反查照样命中）。
 * 喂源码这一步放进下面那次求值里（跟载入 ELF 一起，少一次往返）。
 */

sec('== 0. 前置：ELF + 源码目录 + 连接探针 ==');
const elfInfo = await cdp.json(`(async () => {
    const d = window.__tools.dbg;
    const r = await fetch(${JSON.stringify(ELF)} + '?t=' + Date.now());
    const st = d.loadElfBuffer(await r.arrayBuffer(), 'fw.elf');
    if (!st) return { err: document.getElementById('d-out').textContent.slice(-300) };
    // 源码：页面里取真文件（见上面 🚨 —— webkitdirectory 的 input 喂不进去）
    const files = [];
    for (const n of ${JSON.stringify(SRC_NAMES)}){
      const rr = await fetch(${JSON.stringify(SRC_HTTP)} + '/' + n + '?t=' + Date.now());
      if (!rr.ok) return { err: '源码 ' + n + ' 取不到：HTTP ' + rr.status + '（' + ${JSON.stringify(SRC_HTTP)} + '，检查 --src 是否在仓库里）' };
      files.push(new File([await rr.text()], n));
    }
    if(${JSON.stringify(FRAME_ONLY)}){
      const rr=await fetch('/tools/target-firmware/common/dbg_frames.c?t='+Date.now());
      if(!rr.ok)return {err:'共享栈帧源码读取失败'};
      files.push(new File([await rr.text()],'dbg_frames.c'));
    }
    await d._indexSrcFiles(files);
    return { summary: st.summary(), lines: st.lines ? st.lines.summary() : null, src: d.src.summary(), srcReady: d.src.ready };
  })()`);
if (elfInfo.err) throw new Error('ELF 载入失败：' + elfInfo.err);
log('   ' + elfInfo.summary);
log('   ' + elfInfo.lines);
log('   ' + elfInfo.src);
ok(/行号表/.test(elfInfo.lines || ''), 'ELF 带行号表：' + elfInfo.lines);
ok(elfInfo.srcReady, '源码目录已喂进页面（真文件）：' + elfInfo.src);
ok(CALL_LINE > 0 && CALL2_LINE > 0, `靶子源码行号定位成功（调用在第 ${CALL_LINE} / ${CALL2_LINE} 行）`);

// RTT 泵会跟调试抢 SWD；"运行中也刷新"也会插队 —— 先关掉
await cdp.eval(`const off = (id) => { const el = document.getElementById(id); if (el && el.checked){ el.checked = false; el.dispatchEvent(new Event('change')); } };
  off('d-rtt-on'); off('d-watch-live'); document.getElementById('d-rtt-stop')?.click();
  await new Promise(r => setTimeout(r, 300)); return true;`);

await cdp.eval(`const be = document.getElementById('d-backend'); be.value = 'webusb'; be.dispatchEvent(new Event('change')); return true;`);
/**
 * SWD 时钟：页面默认 10 MHz（2026-10 真机验收过 PPB/内存都对）。套件允许按板子调 ——
 * `--clock=5000` 这种，用来在"链路偶发 FAULT / 目标偶发跑飞"的板子上换更保守的档位，
 * 好把"是链路不稳还是代码有问题"分开。设不上（不在下拉里）会明确报出来。
 */
const clkSet = await cdp.json(`(() => { const sel = document.getElementById('d-clock');
    if (!sel) return { err: '页面上没有 #d-clock' };
    const has = [...sel.options].some(o => o.value === ${JSON.stringify(String(CLOCK_KHZ))});
    if (!has) return { err: '下拉里没有 ' + ${JSON.stringify(String(CLOCK_KHZ))} + ' kHz', options: [...sel.options].map(o => o.value) };
    const before = sel.value; sel.value = ${JSON.stringify(String(CLOCK_KHZ))}; sel.dispatchEvent(new Event('change'));
    return { before, now: sel.value }; })()`);
if (clkSet.err) throw new Error('设 SWD 时钟失败：' + clkSet.err + (clkSet.options ? '（可选 ' + clkSet.options.join('/') + '）' : ''));
log(`   SWD 时钟：${clkSet.before || '(默认)'} → ${clkSet.now} kHz`);
const connP = cdp.eval(`await window.__tools.dbg.connect(); return true;`, true);
await cdp.settle(DEV_RE, 'window.__tools.dbg.session.connected', 12000).catch(() => {});
await connP.catch(e => log('   连接异常：' + e.message));
await cdp.eval(`await window.__tools.dbg.session.halt(); await window.__tools.dbg.afterStop(); return true;`);

/**
 * 靶子固件**真的在跑吗** —— 这一步是"整份套件的前提"，必须自己确认，不能假设。
 *
 * 三种真机现场都会让"板子上其实没在跑我们的固件"，而后面每一节都会以看不懂的方式挂掉：
 *   ① 上一轮测试/烧录把核留在了 halt 或异常（`b .` 自旋）里；
 *   ② **BOOT0=1 的板子**（本机那块 F103ZE；或者板子只靠探针供电 → BOOT0 悬空被读成高电平）：
 *      复位后核进的是系统存储区的 ROM bootloader 且 **VTOR=0**，flash 里的固件根本不被取指 ——
 *      现象是"提示烧录成功、板子一动不动"（`app/flash/view.js` 的 `_bootCheck` 也记着这条）；
 *   ③ 探针偶发 AP FAULT → 页面 `_healIfFaulted()` → `_targetInit()` **把目标复位**（同 ② 的后果）。
 *
 * 判据不看 PC 落在哪（那只能说明"取指地址合理"），而是**看变量有没有在动**：
 * SysTick 每 100 µs 给 `g_ticks` 加一、主循环每轮给 `g_loops` 加一 —— 差一下就知道固件活着。
 */
const alive = await cdp.json(`(async () => {
    const d = window.__tools.dbg, S = window.__S;
    const dh = async () => '0x' + ((await d.session.probe._readWord(0xE000EDF0)) >>> 0).toString(16);
    const samp = async () => { const a = await S.alive();
      return { ticks: a.t1, loops: a.l1, dhcsr: await dh(), pc: '0x' + (d.session.pc >>> 0).toString(16) }; };
    const log = [];
    // 先清一次 FPB：接手别人的会话时比较器里可能留着**已使能**的残留值 = 幽灵断点
    // （页面的 connect() 里也清一次，但它的循环遇到读失败会 break，而这颗探针的 PPB 写偶发不落地）
    try { await d.session.bpClear(); } catch (e){ log.push('清 FPB 失败：' + (e?.message || e)); }
    if (!d.session.halted) await d.session.halt();
    const s0 = await samp();
    await d.session.cont();
    await new Promise(r => setTimeout(r, 350));
    const s1 = await samp();
    let woken = false;
    if (!(s1.ticks > s0.ticks || s1.loops > s0.loops)){
      log.push('靶子没在跑（' + JSON.stringify(s0) + ' → ' + JSON.stringify(s1) + '），按唤醒配方拉起');
      await S.wake();
      woken = true;
    }
    const s2 = await samp();
    await new Promise(r => setTimeout(r, 350));
    const s3 = await samp();
    await d.session.halt();
    await d.afterStop();
    return { s0, s1, s2, s3, woken, log, running: s3.ticks > s2.ticks || s3.loops > s2.loops,
             detail: 'g_ticks ' + [s0, s1, s2, s3].map(x => x.ticks).join(' → ')
                   + ' · g_loops ' + [s0, s1, s2, s3].map(x => x.loops).join(' → ')
                   + ' · DHCSR ' + [s0, s1, s2, s3].map(x => x.dhcsr).join(' → ') };
  })()`);
if (alive.log.length) log('   ' + alive.log.join('；'));
log(`   靶子存活：${alive.detail}`);
log(`   ${alive.running ? '在跑 ✓' : '不动 ✗'} · 停点 PC=${hex(alive.s3.pc)}`);
ok(alive.running, `靶子固件在跑（${alive.detail}）${alive.woken ? '［唤醒配方已用］' : ''}`);

const env = await cdp.json(`(async () => {
    const d = window.__tools.dbg, S = window.__S;
    return { cap: d.session.caps, name: d.session.name, idcode: '0x' + ((d.session.idcode ?? 0) >>> 0).toString(16),
             vec: [...await d.session.memRead(0x08000000, 8)].map(x => x.toString(16).padStart(2, '0')).join(' '),
             resetSym: d.sym.find('Reset_Handler')?.addr ?? null, leak: await S.leak(), snap: S.snap() };
  })()`);
const VEC_BYTES = env.vec.split(' ').map(x => parseInt(x, 16));
const RESET_VEC = ((VEC_BYTES[4] | (VEC_BYTES[5] << 8) | (VEC_BYTES[6] << 16) | (VEC_BYTES[7] << 24)) >>> 0) & 0xfffffffe;
log(`   探针 ${env.name} · IDCODE ${env.idcode} · FPB ${env.cap.numCode} 个 rev${env.cap.rev}`);
log(`   复位向量 = ${hex(RESET_VEC)}（Reset_Handler 符号 = ${hex(env.resetSym)}）· 起点 PC=${hex(env.snap.pc)} ${env.snap.name}`);
ok(env.snap.connected && env.snap.halted, '连上真探针并停住目标');
ok(env.cap.numCode >= 4, `FPB 比较器够用（${env.cap.numCode} 个）`);
ok(env.leak.used === 0 && env.leak.bps === 0, '干净起点：没有任何断点占着比较器', JSON.stringify(env.leak));

/** 采集到的"标准答案"，用来跟 gdb 对照 */
const oracle = { elf: ELF, linear: [], bpAddr: {}, steps: {}, struct: {}, resetVec: RESET_VEC };

if(FRAME_ONLY){
 const frameResults=await runFrameStress({cdp,oracle:frameOracle,code:frameCode,board:BOARD_ID,rounds:FRAME_ROUNDS,ok,log});
 const recov=await cdp.eval('return window.__S.recoveries || [];');
 ok(recov.length===0,'严格栈帧验收期间没有目标意外复位/恢复',JSON.stringify(recov));
 const heals=await cdp.eval('return window.__faultWrap?.n || 0;');
 ok(heals===0,'严格栈帧验收期间没有隐藏的传输重试',String(heals));
 mkdirSync(dirname(resolve(JSON_OUT)),{recursive:true});
 writeFileSync(JSON_OUT,JSON.stringify({at:new Date().toISOString(),board:BOARD_ID,elf:ELF,elfSha256:frameOracle.elfSha256,build:frameBuild,pass,fail,failures,frameResults},null,2));
 cdp.close();console.log(`栈帧验收：${pass} 通过 / ${fail} 失败；${JSON_OUT}`);process.exit(fail?1:0);
}

// ==================================================================== 1
sec('== 1. 断点：文件:行 / 符号 / static / 偏移 / 多断点 / ISR ==');
{
  const specs = await cdp.json(`(async () => {
      const d = window.__tools.dbg, out = {};
      for (const fn of ['engine_linear', 'engine_deep_chain', 'engine_rec_fib', 'engine_dispatch', 'model_update', 'deep_l5', 'is_even']){
        const f = d.sym.find(fn);
        const at = f ? d.sym.at(f.addr) : null;
        out[fn] = f ? { addr: f.addr >>> 0, file: at?.file || '', line: at?.line || 0 } : null;
      }
      return out;
    })()`);
  log('   符号表（函数 → 首行）：' + Object.entries(specs).map(([k, v]) => `${k}=${hex(v?.addr)} ${String(v?.file).split('/').pop()}:${v?.line}`).join('  '));
  ok(Object.values(specs).every(Boolean), '关键函数都在符号表里（含 static 的 deep_l5 / is_even）');

  for (const fn of ['engine_linear', 'model_update']){
    const f = specs[fn];
    const spec = `${String(f.file).split('/').pop()}:${f.line}`;
    const r = await cdp.json(`(async () => {
        const S = window.__S, d = window.__tools.dbg;
        await d.session.bpClear();
        const c = await S.cmd('b ' + ${JSON.stringify(spec)});
        const bps = d.session.bpList();
        const out = { out: c.out, addr: bps[0]?.addr ?? null };
        await d.session.bpClear();
        return out;
      })()`);
    oracle.bpAddr[spec] = r.addr;
    ok(r.addr === f.addr, `b ${spec} 落到 ${hex(r.addr)}（与 b ${fn} 的 ${hex(f.addr)} 一致）`, JSON.stringify(r.out));
  }

  const st1 = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b deep_l5');
      const a = d.session.bpList()[0]?.addr ?? null;
      await d.session.bpClear();
      await S.cmd('b engine_linear+8');
      const b = d.session.bpList()[0]?.addr ?? null;
      await d.session.bpClear();
      const inline = (await S.cmd('b engine_inline_double')).text;
      const badline = (await S.cmd('b engine.c:99999')).text;
      return { a, b, inline, badline };
    })()`);
  ok(st1.a === specs.deep_l5.addr, `b deep_l5（static 函数）能下：${hex(st1.a)}`);
  ok(st1.b === (specs.engine_linear.addr + 8), `b engine_linear+8 支持偏移：${hex(st1.b)}`);
  ok(/认不出地址|找不到/.test(st1.inline), '内联函数下不到断点时会明说：' + st1.inline);
  ok(/只有第 \d+~\d+ 行/.test(st1.badline), '行号超出文件范围时说人话：' + st1.badline);

  // 多断点：挑**每轮只被调用一次**的四个函数（engine_rec_fib 是递归的，会连中好几次，不适合当"每轮一次"用）
  const multi = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      for (const f of ['engine_linear', 'engine_deep_chain', 'engine_dispatch', 'model_update']) await S.cmd('b ' + f);
      const seen = [];
      let lastHalted = true;
      for (let i = 0; i < 24; i++){
        const s = await S.go(4000);
        lastHalted = s.halted;
        if (!s.halted) break;
        seen.push(d.sym.funcAt(s.pc)?.name || '?');
        if (new Set(seen).size >= 4) break;
      }
      const leak = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { seen, lastHalted, leak, clean };
    })()`);
  ok(new Set(multi.seen).size === 4, '4 个断点同时挂着，每一轮都轮到：' + multi.seen.join(' → '));
  ok(multi.leak.extra === 0, '4 个断点占的就是 4 个比较器（没有多占）', JSON.stringify(multi.leak));
  ok(multi.clean.used === 0 && multi.clean.bps === 0, '清空断点后比较器全部释放', JSON.stringify(multi.clean));

  // 中断里下断点（SysTick 10 kHz → 继续就立刻命中）
  const isr = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b SysTick_Handler');
      const t0 = Date.now();
      const s = await S.go(4000);
      const ms = Date.now() - t0;
      await d.session.bpClear();
      return { halted: s.halted, pc: s.pc, nm: s.name, ms };
    })()`);
  ok(isr.halted && /SysTick_Handler/.test(isr.nm), `中断里的断点命中（${hex(isr.pc)} ${isr.nm}，用时 ${isr.ms}ms）`);

  // 同一个断点连续命中 5 次
  const loop = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b is_even');
      const want = d.sym.find('is_even').addr >>> 0;
      const addrs = [];
      for (let i = 0; i < 5; i++){ const s = await S.go(4000); if (!s.halted) break; addrs.push(s.pc); }
      await d.session.bpClear();
      return { addrs, want };
    })()`);
  ok(loop.addrs.length === 5 && loop.addrs.every(a => a === loop.want),
    `同一个断点连续命中 5 次都在 ${hex(loop.want)}（is_even）`, JSON.stringify(loop.addrs.map(hex)));
}

// ==================================================================== 2
sec('== 2. 代码同步：停下时 PC → 源码位置必须自洽（跨文件）==');
{
  const sync = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const out = [];
      await d.session.bpClear();
      for (const f of ['engine_linear', 'model_bitfield_touch', 'engine_branchy']){
        await S.cmd('b ' + f);
        const s = await S.go(4000);
        const at = d.sym.at(s.pc);
        out.push({ fn: f, halted: s.halted, pc: s.pc, name: s.name, pos: s.pos, curLine: s.curLine, file: s.file,
                   wantLine: at?.line, wantFile: String(at?.file || '').split('/').pop() });
        await d.session.bpClear();
      }
      // main 的第一条指令在"复位之后"才会被走到 —— 先复位并停（停在复位向量），再继续
      const rz = await S.resetToFirmware(${JSON.stringify(!!BOARD.boot0)});
      await S.cmd('b main');
      const sm = await S.go(4000);
      const atm = d.sym.at(sm.pc);
      out.push({ fn: 'main', halted: sm.halted, pc: sm.pc, name: sm.name, pos: sm.pos, curLine: sm.curLine, file: sm.file,
                 wantLine: atm?.line, wantFile: String(atm?.file || '').split('/').pop() });
      await d.session.bpClear();
      // 指令级单步：行号必须逐步自洽
      await S.cmd('b engine_linear');
      await S.go(4000);
      const seq = [];
      for (let i = 0; i < 6; i++){
        const s = await S.step('si');
        const at = d.sym.at(s.pc);
        seq.push({ pc: s.pc, line: at?.line ?? null, file: String(at?.file || '').split('/').pop(), curLine: s.curLine });
      }
      await d.session.bpClear();
      return { out, seq };
    })()`);
  for (const r of sync.out){
    ok(r.halted && r.curLine === r.wantLine && r.wantLine > 0,
      `停到 ${r.fn}：源码视图高亮第 ${r.curLine} 行 == 行号表的第 ${r.wantLine} 行（${r.wantFile}:${r.wantLine}）`,
      JSON.stringify({ pc: hex(r.pc), pos: r.pos, file: r.file, cur: r.curLine }));
    ok(r.name.includes(r.fn), `停止位置显示函数名 ${r.fn}：${r.name}`);
  }
  ok(sync.seq.length === 6 && sync.seq.every(x => x.curLine === x.line && x.line > 0),
    '指令级单步时每一步的"源码高亮 == 行号表"：' + sync.seq.map(x => `${x.file}:${x.line}`).join(' '));
  ok(sync.seq.every((x, i) => i === 0 || x.pc > sync.seq[i - 1].pc),
    'si 的 PC 单调前进（' + sync.seq.map(x => hex(x.pc)).join(' → ') + '）');
}

// ==================================================================== 3
sec('== 3. 单步：n / si / fin（源码级，含间接调用与 5 层爬栈）==');
{
  const lin = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_linear');
      const s0 = await S.go(4000);
      const seq = [{ pc: s0.pc, line: d.sym.at(s0.pc)?.line ?? null, halted: s0.halted }];
      for (let i = 0; i < 19; i++){
        const s = await S.step('n');
        seq.push({ pc: s.pc, line: d.sym.at(s.pc)?.line ?? null, halted: s.halted });
      }
      const leak = await S.leak();
      await d.session.bpClear();
      return { seq, leak };
    })()`);
  oracle.linear = lin.seq;
  log('   单步序列：' + lin.seq.map(x => `${hex(x.pc)}(L${x.line})`).join(' → '));
  ok(lin.seq.length === 20 && lin.seq.every(x => x.halted), '拿到 20 步的落点序列（每一步都真的停住了）');
  ok(lin.seq.every((x, i) => i === 0 || x.pc !== lin.seq[i - 1].pc), '每一步 PC 都变了（不会"点了没反应"）');
  ok(lin.seq.every(x => x.line > 0), '每一步都有源码行号');
  ok(lin.leak.extra === 0, `20 次单步后**只**占着用户断点那 1 个比较器（直读 FP_COMP：${lin.leak.used} 个 / 断点 ${lin.leak.bps} 个）`, JSON.stringify(lin.leak));

  // n 跳过调用：从调用那一句按 n，必须落到"下一句"而不是被调函数里
  const over = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const leaf = d.sym.find('engine_leaf').addr >>> 0;
      await d.session.bpClear();
      await S.cmd('b ' + ${JSON.stringify('engine.c')} + ':' + ${CALL_LINE});
      const s0 = await S.go(4000);
      const line0 = d.sym.at(s0.pc)?.line ?? 0;
      const s1 = await S.step('n');
      const inLeaf = (d.sym.funcAt(s1.pc)?.name || '') === 'engine_leaf';
      await d.session.bpClear();
      return { line0, s0pc: s0.pc, pc: s1.pc, halted: s1.halted, inLeaf, line: d.sym.at(s1.pc)?.line ?? 0, leaf, text: s1.text };
    })()`);
  ok(over.line0 === CALL_LINE, `断在调用那一句（engine.c:${over.line0}）`);
  ok(over.halted && !over.inLeaf && over.pc !== over.s0pc, `n（跳过）越过调用、没进 engine_leaf：${hex(over.s0pc)} → ${hex(over.pc)}（engine.c:${over.line}）`, JSON.stringify(over));

  // si 进入调用：停在调用那一句，连续 si 直到进 engine_leaf
  const into = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const leaf = d.sym.find('engine_leaf').addr >>> 0;
      await d.session.bpClear();
      await S.cmd('b engine.c:' + ${CALL_LINE});
      await S.go(4000);
      let hit = null, tries = 0, seq = [];
      for (let i = 0; i < 8 && !hit; i++){
        const s = await S.step('si'); tries++;
        seq.push('0x' + s.pc.toString(16));
        if ((d.sym.funcAt(s.pc)?.name || '') === 'engine_leaf') hit = s.pc;
      }
      const leak = await S.leak();
      await d.session.bpClear();
      return { hit, tries, seq, leaf, leak, bpsAfter: d.session.bpList().length };
    })()`);
  oracle.steps.intoLeaf = into.hit;
  ok(into.hit === into.leaf, `si 从调用点进入 engine_leaf（第 ${into.tries} 次 si 停在 ${hex(into.hit)}，路径 ${into.seq.join(' → ')}）`, JSON.stringify(into));
  ok(into.leak.extra === 0, 'si 之后比较器也没多占（用户断点 1 个 → 硬件占 1 个）', JSON.stringify(into.leak));

  // fin 逐层爬栈：deep_l5 → deep_l4 → l3 → l2 → deep_l1 → engine_deep_chain（中间有 LR 被覆盖的非叶子层）
  const fin = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const hx = v => '0x' + ((v ?? 0) >>> 0).toString(16);
      await d.session.bpClear();
      await S.cmd('b deep_l5');
      const s0 = await S.go(4000);
      const chain = [d.sym.funcAt(s0.pc)?.name || '?'];
      const out = [];
      for (let i = 0; i < 5; i++){
        const lr = (await d.session.readReg('LR')) >>> 0;
        const sp = (await d.session.readReg('SP')) >>> 0;
        const s = await S.step('fin', 8000);
        chain.push(d.sym.funcAt(s.pc)?.name || '?');
        out.push({ lr: hx(lr), sp: hx(sp), pc: hx(s.pc), name: s.name, halted: s.halted, msg: s.text.slice(0, 120) });
      }
      const leak = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { chain, out, leak, clean };
    })()`);
  log('   fin 爬栈：' + fin.chain.join(' → '));
  const wantChain = ['deep_l5', 'engine_deep_l4', 'engine_deep_l3', 'engine_deep_l2', 'deep_l1', 'engine_deep_chain'];
  ok(JSON.stringify(fin.chain) === JSON.stringify(wantChain), '连续 5 次「跳出」逐层爬回调用者：' + fin.chain.join(' → '), JSON.stringify(fin.out));
  ok(fin.out.every(o => o.halted), '每一步都停住了（不是超时后的残留状态）');
  ok(fin.leak.extra === 0 && fin.clean.used === 0, 'fin 之后比较器收干净', JSON.stringify({ leak: fin.leak, clean: fin.clean }));

  // 函数指针（BLX Rn）也要能进去
  const ind = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_dispatch');
      const s0 = await S.go(4000);
      let hit = null, tries = 0, seq = [];
      for (let i = 0; i < 10 && !hit; i++){
        const s = await S.step('si', 5000); tries++;
        const nm = d.sym.funcAt(s.pc)?.name || '';
        seq.push(nm + '@0x' + s.pc.toString(16));
        if (/^fn_(add|xor|mul|rol)$/.test(nm)) hit = { pc: s.pc, nm };
      }
      const leak = await S.leak();
      await d.session.bpClear();
      return { started: s0.halted, hit, tries, seq, leak };
    })()`);
  ok(ind.started && !!ind.hit, `si 能跟进**函数指针**调用（第 ${ind.tries} 次停在 ${ind.hit?.nm ?? '—'}）：${ind.seq.join(' → ')}`, JSON.stringify(ind));
  ok(ind.leak.extra === 0, '间接调用单步后比较器也收干净');

  // 递归内部：n 与 fin 都能正常走
  const rec = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_rec_fib');
      await S.go(4000);
      const s1 = await S.step('n');
      const s2 = await S.step('fin', 8000);
      const leak = await S.leak();
      await d.session.bpClear();
      return { n: s1.name, fin: s2.name, halted: s2.halted, leak };
    })()`);
  ok(rec.halted && /engine_rec_fib/.test(rec.fin), `递归函数里 n/fin 都能回到递归体（n→${rec.n}，fin→${rec.fin}）`, JSON.stringify(rec));
  ok(rec.leak.extra === 0, '递归里单步后比较器也收干净');
}

// ==================================================================== 4
sec('== 4. 复位重跑：必须停在复位向量 → 断点仍然有效 → 再命中（连续 3 轮）==');
{
  const rst = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const rounds = [];
      await d.session.bpClear();
      await S.cmd('b engine_linear');
      const want = d.sym.find('engine_linear').addr >>> 0;
      for (let i = 0; i < 3; i++){
        const r = await S.resetToFirmware(${JSON.stringify(!!BOARD.boot0)});
        const s0 = S.snap();
        const fpb = await S.fpb();
        const s1 = await S.go(4000);
        rounds.push({ resetPc: s0.pc, resetName: s0.name, halted: s0.halted, bpPage: s0.bps, compUsed: fpb.used,
                      woken: r.woken, romPc: r.romPc,
                      hit: s1.halted, hitPc: s1.pc, hitName: s1.name, out: r.out });
        if (!s1.halted) break;
      }
      await d.session.bpClear();
      return { rounds, want };
    })()`);
  for (const [i, r] of rst.rounds.entries()){
    log(`   第 ${i + 1} 轮：复位后 PC=${hex(r.resetPc)} ${r.resetName}（比较器 ${r.compUsed}）`
      + (r.woken ? ` ← BOOT0 唤醒（ROM ${hex(r.romPc)}）` : '')
      + ` → 继续命中=${r.hit} ${hex(r.hitPc)} ${r.hitName}`);
  }
  ok(rst.rounds.length === 3, '复位 3 轮都跑完了');
  ok(rst.rounds.every(r => r.resetPc === RESET_VEC),
    `「复位并停」停在**复位向量**上（${hex(RESET_VEC)} = Reset_Handler）`
    + (BOARD.boot0 ? `［本机 BOOT0=1：脚本按唤醒配方把 PC 从 ROM 搬回 flash］` : '')
    + '：' + rst.rounds.map(r => hex(r.resetPc)).join(' , '));
  ok(rst.rounds.every(r => r.hit && r.hitPc === rst.want),
    '复位之后断点仍然有效、继续就能命中：' + rst.rounds.map(r => `${hex(r.hitPc)}`).join(' , '));
}

// ==================================================================== 5
sec('== 5. 内存 / 监视：结构体树、位域、复合路径 ==');
{
  const mp = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b model_update');
      await S.go(4000);
      const A = await S.cmd('p g_model');
      const B = await S.cmd('p g_model.flags');
      const C = await S.cmd('p g_model.flags.bits.level');
      const D = await S.cmd('p g_model.flags.sbits.bias');
      const E = await S.cmd('p g_model.nodes[1]');
      const F = await S.cmd('p g_model.nodes[1].cell');
      const G = await S.cmd('p g_model.nodes[1].cell.scale');
      const H = await S.cmd('p g_model.word.halves.hi');
      const I = await S.cmd('p g_model.blob');
      const J = await S.cmd('p g_model.tag');
      const K = await S.cmd('p g_model.label');
      const L = await S.cmd('p g_model.head');
      const M = await S.cmd('p g_model.nodes[9]');
      const N = await S.cmd('p g_model.nosuchmember');
      const O = await S.cmd('p g_model_plain');
      const P = await S.cmd('p g_model_const');
      const f = d.sym.typeOf('g_model.flags');
      const raw = await d.session.memRead(f.addr, 20);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      const w0 = dv.getUint32(0, true) >>> 0, w1 = dv.getUint32(16, true) >>> 0;
      const check = { w0, w1, addr: f.addr,
        bits: { on: w0 & 1, level: (w0 >>> 1) & 7, mode: (w0 >>> 4) & 3, parity: (w0 >>> 6) & 1, rev: (w0 >>> 7) & 0x1ff, spare: (w0 >>> 16) & 0xffff },
        sb: { bias: (w1 << 26) >> 26, tag: (w1 >>> 6) & 0x3ff, rest: (w1 >>> 16) & 0xffff } };
      await d.session.bpClear();
      return { A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, check };
    })()`);
  const first = a => (a.out || [])[0] || '';
  log('   p g_model            : ' + first(mp.A));
  log('   p g_model.flags      : ' + first(mp.B));
  log('   p <位域>             : ' + first(mp.C));
  log('   p <有符号位域>       : ' + first(mp.D));
  log('   p nodes[1].cell.scale: ' + first(mp.G));
  ok(/struct/.test(first(mp.A)) && mp.A.out.length > 20, `p g_model 打出结构体树（${mp.A.out.length} 行）`);
  ok(/struct/.test(first(mp.B)) && mp.B.out.some(l => /on : 1/.test(l)), 'p g_model.flags：嵌套结构体带位域行');
  ok(/位域\[bit 1 · 3 位\]/.test(first(mp.C)), 'p <位域>按位取（不是把整个 u32 打出来）：' + first(mp.C));
  ok(/有符号/.test(first(mp.D)), '有符号位域明确标出来：' + first(mp.D));
  ok(/node_s|struct/.test(first(mp.E)), 'p g_model.nodes[1]（数组元素）✓：' + first(mp.E));
  ok(/cell_t|struct/.test(first(mp.F)), 'p g_model.nodes[1].cell（数组元素里的结构体）✓：' + first(mp.F));
  ok(/f64|double/.test(first(mp.G)), 'p g_model.nodes[1].cell.scale（三层路径）✓：' + first(mp.G));
  ok(/u16|unsigned/.test(first(mp.H)), 'p g_model.word.halves.hi（联合体里的成员）✓：' + first(mp.H));
  ok(/array/.test(first(mp.I)) && mp.I.out.some(l => /^\[7\]/.test(l)), 'p g_model.blob（字节数组 8 项）' + mp.I.out.length + ' 行');
  ok(/01234567/.test(mp.J.text), 'char[8] 当字符串显示（没有 NUL 也不越界）：' + first(mp.J));
  ok(!/找不到/.test(first(mp.K)) && mp.K.out.length >= 1, 'p g_model.label（指针成员）能打：' + first(mp.K));
  ok(!/找不到/.test(first(mp.L)) && mp.L.out.length >= 1, 'p g_model.head（结构体指针）能打：' + first(mp.L));
  ok(/越界/.test(first(mp.M)), '下标越界如实报错：' + first(mp.M));
  ok(/没有成员/.test(first(mp.N)), '成员名写错如实报错：' + first(mp.N));
  ok(/struct/.test(first(mp.O)) && mp.O.out.length > 20, 'p g_model_plain（非 volatile 对照）同样能展开');
  ok(/struct/.test(first(mp.P)) && mp.P.out.length > 20, 'p g_model_const（const/flash 里的对象）同样能展开：' + first(mp.P));

  // 位域与影子字逐位对账（树里的位域行 vs 影子字的手工移位）
  const rawTree = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const t = d.sym.typeOf('g_model.flags');
      const raw = await d.session.memRead(t.addr, 20);
      const W = await import('/app/dbg/watch.js');
      return W.treeRows({ type: t.type, label: 'flags' }, raw).map(r => ({ n: r.name, t: r.text, bf: !!r.bitfield }));
    })()`);
  const got = {};
  for (const r of rawTree) if (r.bf) got[String(r.n).split(' ')[0]] = r.t;
  const cf = mp.check;
  const want = { ...cf.bits, ...cf.sb };
  const mism = [];
  for (const [k, v] of Object.entries(want)){
    const g = got[k];
    const gv = g != null ? Number(String(g).split(' ')[0]) : null;
    if (gv !== v) mism.push(`${k}: 树=${gv} 影子字=${v}`);
  }
  ok(mism.length === 0, `位域与影子字逐位对账（word=0x${cf.w0.toString(16)} / word2=0x${cf.w1.toString(16)}，${Object.keys(want).length} 个字段）`, mism.join('；'));
  oracle.struct = { w0: cf.w0, w1: cf.w1, bits: cf.bits, sb: cf.sb };

  // 监视窗口：结构体树展开 + 复合路径 + 写错时的表现
  const watch = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await S.cmd('wd all');
      await S.cmd('w g_model');
      await S.cmd('w g_model.flags.bits.level');
      await S.cmd('w g_model.nodes[2].cell.scale');
      await S.cmd('w g_model.nope');
      const items = d.watch.items.map(it => ({ e: it.expr, err: it.error || null, kind: it.kind, v: it.value?.text ?? null }));
      document.querySelector('#d-watch-list button.exp')?.click();
      await new Promise(r => setTimeout(r, 400));
      const rows = [...document.querySelectorAll('#d-watch-list .wkid')].map(e => e.textContent.trim());
      await S.cmd('wd all');
      return { items, rows: rows.slice(0, 40), rowCount: rows.length };
    })()`);
  log('   w g_model → ' + JSON.stringify(watch.items[0]));
  ok(watch.items[0] && !watch.items[0].err && watch.items[0].kind === 'struct', '监视加结构体项：' + JSON.stringify(watch.items[0]));
  ok(watch.rowCount > 20, `展开后画出成员树（${watch.rowCount} 行）`);
  ok(watch.rows.some(r => /on\s*:\s*1/.test(r)), '树里有位域行：' + (watch.rows.find(r => /on\s*:\s*1/.test(r)) || ''));
  ok(watch.items[1] && !watch.items[1].err, '监视复合路径（位域）✓：' + JSON.stringify(watch.items[1]));
  ok(watch.items[2] && !watch.items[2].err, '监视复合路径（数组元素成员）✓：' + JSON.stringify(watch.items[2]));
  ok(watch.items[3] && watch.items[3].err, '监视里写错的名字会标红并说明：' + JSON.stringify(watch.items[3]));

  // 内存面板 + 一条会 FAULT 的地址：报错要人话，链路要能自愈
  const fault = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      let msg = '';
      try { await d.session.memRead(${BOARD.faultAddr}, 16); } catch (e){ msg = String(e?.message || e); }   // ${BOARD.faultText}
      let after = null;
      try { after = [...await d.session.memRead(0x08000000, 8)].map(x => x.toString(16)).join(' '); } catch (e){ after = 'ERR ' + e.message; }
      return { msg, after, heals: d.session.probe.faultHeals || 0 };
    })()`);
  ok(/总线 FAULT/.test(fault.msg) && fault.msg.includes('0x' + BOARD.faultAddr.toString(16)), '读不到的总线地址说明故障及地址：' + fault.msg.slice(0, 80));
  ok(/^0 /.test(fault.after) && fault.heals >= 1, `FAULT 之后链路自愈、还能继续读 flash（自愈 ${fault.heals} 次）：${fault.after}`);
}

// ==================================================================== 6
sec('== 6. 调试辅助：bt / bt scan + DWT 数据观察点 ==');
{
  /**
   * 这一节专门把今天新增的两项调试能力放进真机压力套件：
   *   · bt / bt scan：停在真实调用链里，验证命令不会因为没有 EHABI 展开表而抛出未捕获异常，
   *     scan 至少能返回当前帧/候选帧；带 exidx 的 ELF 则继续由纯逻辑套件覆盖逐层展开。
   *   · wp：把 g_stage 的 CPU 写访问交给 Cortex-M3 DWT，继续运行后必须由 DWT 停下，
   *     而不是靠 FPB 断点或页面轮询“碰巧”停住；随后清理硬件槽，确认不会留给下一轮。
   */
  const bt = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b deep_l5');
      const hit = await S.go(5000);
      const plain = await S.cmd('bt 8');
      const scan = await S.cmd('bt scan 8');
      const frames = plain.backtrace?.frames || [];
      const scanFrames = scan.backtrace?.frames || [];
      const err = [plain.err, scan.err].filter(Boolean);
      const names = frames.map(f => d.sym?.funcAt?.(f.lookup ?? f.pc)?.name || f.name || '?');
      const scanNames = scanFrames.map(f => d.sym?.funcAt?.(f.lookup ?? f.pc)?.name || f.name || '?');
      await d.session.bpClear();
      return { hit, plain: { n: frames.length, names, reason: plain.backtrace?.reason || '', err },
               scan: { n: scanFrames.length, names: scanNames, reason: scan.backtrace?.reason || '', err: scan.err || null } };
    })()`);
  log('   bt：' + JSON.stringify(bt.plain));
  log('   bt scan：' + JSON.stringify(bt.scan));
  ok(bt.hit.halted && bt.plain.n >= 1 && bt.plain.names[0] === 'deep_l5',
    `bt 在真实停点返回当前帧（${bt.plain.names.join(' → ') || '—'}）`, JSON.stringify(bt));
  ok(bt.plain.err.length === 0 && !bt.scan.err && bt.scan.n >= 1,
    `bt scan 返回至少一个候选帧（${bt.scan.n} 个；${bt.scan.reason || '无附加原因'}）`, JSON.stringify(bt));

  const dwt = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('wp g_stage w 4');
      const listed = await S.cmd('wpl');
      const item = d.session.dwt.items[0] || null;
      const before = { items: d.session.dwt.items.length, capacity: d.session.dwt.capacity,
                       addr: item?.addr ?? null, mode: item?.mode ?? null, size: item?.size ?? null };
      const hit = await S.go(5000);
      const reason = await d.session.dwt.haltReason().catch(() => null);
      const pc = d.session.pc >>> 0;
      const stage = d.sym.find('g_stage');
      const afterHit = { halted: hit.halted, pc, name: hit.name, reason,
                         dwtStatus: [...document.querySelectorAll('#d-out .ok')].slice(-4).map(x => x.textContent).join(' | '),
                         stageAddr: stage?.addr ?? null };
      await S.cmd('wpd all');
      const cleared = { items: d.session.dwt.items.length, capacity: d.session.dwt.capacity };
      await d.session.bpClear();
      return { before, listed: listed.text, afterHit, cleared };
    })()`);
  log('   DWT：' + JSON.stringify(dwt));
  ok(dwt.before.items === 1 && dwt.before.addr === dwt.afterHit.stageAddr && dwt.before.mode === 'w' && dwt.before.size === 4,
    `wp g_stage 写观察点已编程（${hex(dwt.before.addr)}，${dwt.before.size} B，${dwt.before.mode}）`, JSON.stringify(dwt));
  ok(dwt.afterHit.halted && /DWT 数据访问命中/.test(String(dwt.afterHit.reason || dwt.afterHit.dwtStatus)),
    `CPU 写 g_stage 由 DWT 停住（PC=${hex(dwt.afterHit.pc)}）`, JSON.stringify(dwt));
  ok(dwt.cleared.items === 0, 'wpd all 清理后 DWT 槽位归零', JSON.stringify(dwt.cleared));
}

// ==================================================================== 7
sec('== 7. 压力：连续 60 次「停 — 走 — 停」+ 比较器泄漏 ==');
{
  const stress = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_branchy');
      const names = [], lines = [], bad = [], unexpected = [], interruptRaces = [];
      const confirm = ${confirmedM7BreakpointRace.toString()};
      const target = d.sym.find('engine_branchy')?.addr >>> 0;
      let maxExtra = 0, misses = 0;
      for (let i = 0; i < 60; i++){
        const s = await S.go(3000);
        if (!s.halted){ misses++; continue; }
        const name = d.sym.funcAt(s.pc)?.name || '?';
        names.push(name);
        lines.push(d.sym.at(s.pc)?.line ?? 0);
        if ((s.pc >>> 0) !== target){
          const hit = { i, pc: s.pc >>> 0, name, fpb: await S.fpb(),
            dwt: await d.session.dwt.haltReason().catch(e => String(e?.message || e)),
            dfsr: (await d.session.probe._readWord(0xE000ED30).catch(() => 0)) >>> 0 };
          const proof=await confirm(d,target,${JSON.stringify(BOARD_ID)});
          if(proof)interruptRaces.push({...hit,proof});
          else unexpected.push(hit);
        }
        if (i % 10 === 0){
          const lk = await S.leak();
          maxExtra = Math.max(maxExtra, lk.extra);
          if (lk.extra !== 0 || lk.bps !== 1) bad.push('第 ' + i + ' 轮：' + JSON.stringify(lk));
        }
      }
      const final = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { n: names.length, misses, names: [...new Set(names)], lines: [...new Set(lines)], bad,
        confirmed: names.length - unexpected.length, unexpected, interruptRaces, maxExtra, final, clean };
    })()`);
  log(`   60 轮：停下来的函数集合 = ${stress.names.join(',')} · 行号集合 = ${stress.lines.join(',')}`);
  ok(stress.n === 60 && stress.misses === 0, `连续 60 轮都停下来了（实际 ${stress.n}，漏 ${stress.misses}）`, JSON.stringify(stress.bad));
  ok(stress.confirmed === 60 && stress.unexpected.length === 0,
    `60 轮都由 engine_branchy 的 FPB 断点触发${stress.interruptRaces.length ? `（${stress.interruptRaces.length} 次与 SysTick 入栈重合，CPU/DFSR/FPB/异常栈 PC 已确认）` : ''}`,
    JSON.stringify(stress.unexpected.slice(0, 3)));
  ok(stress.bad.length === 0 && stress.maxExtra === 0, '过程中比较器占用始终等于"用户断点个数"（没有临时断点残留）', JSON.stringify(stress.bad));
  ok(stress.clean.used === 0, `压完清空断点，硬件比较器回到 0（峰值多占 ${stress.maxExtra}）`);
}

// ==================================================================== 8
sec('== 8. 收尾 + 与 gdb 对照 ==');
{
  const errs = await cdp.eval('return window.__tools.errors || [];');
  ok(Array.isArray(errs) && errs.length === 0, '整轮没有一个页面未捕获错误', JSON.stringify(errs).slice(0, 300));

  /**
   * 自愈记录（见 `S.go()` 里那段 🚨）。**不算失败**：它证明的是"探针偶发 FAULT →
   * 页面 `_targetInit()` 把目标复位 → BOOT0=1 的板子掉进 ROM"这条链真的会发生，
   * 而不是被测代码有问题；但必须显式打出来（悄悄重试等于把问题藏了）。
   */
  const recov = await cdp.eval('return window.__S.recoveries || [];');
  const faultW = await cdp.eval('return window.__faultWrap || { n: 0 };');
  if (faultW.n){
    log(`\n   ⚠ 本轮撞上 ${faultW.n} 次探针 FAULT，已自动重试（页面在下一次访问前会 _targetInit 修口子）：`);
    log('     ' + JSON.stringify(faultW.which || {}));
  } else {
    log('   探针 FAULT：0 次');
  }
  if (recov.length){
    log(`\n   ⚠ 本轮发生过 ${recov.length} 次「目标被意外复位 → 自动唤醒」：`);
    for (const r of recov) log('     ' + JSON.stringify(r));
    log('     （成因：探针偶发 AP FAULT → 页面 _healIfFaulted()/_targetInit() 复位目标；'
      + '本机 F103ZE 的 BOOT0=1，复位后 VTOR=0、固件取不到指，只能靠唤醒配方搬回 VTOR/SP/PC）');
  } else {
    log('   自愈记录：0 次（目标全程没被意外复位）');
  }

  if (existsSync(ORACLE)){
    const g = JSON.parse(readFileSync(ORACLE, 'utf8'));
    log('   载入 gdb 对照：' + ORACLE + '（' + (g.tool || 'arm-none-eabi-gdb') + '）');
    /**
     * 逐地址比对。两处**口径差异**要先说清楚（不是我们的 bug，也不是 gdb 的）：
     *   · 页面序列的第 0 条是"刚在 engine_linear 上停下"，gdb 那边是 20 次 `next`（没有这一条）→ 对齐时要错开一位；
     *   · 我们的 `n` 是"**地址序**的下一条语句"，gdb 的 `next` 是"**行号变化**才停" +
     *     会跳过内联函数的收尾。所以只在**同一个函数体内**逐条比；一旦步出函数
     *     （这里 `stage_run` 被内联进 main 了），两者落点可以不同 —— 那属于口径差异，如实说明。
     */
    const pageSeq = oracle.linear.slice(1).map(x => x.pc);
    const gseq = (g.linear || []).map(x => x.pc);
    const fnStart = RESET_VEC === 0 ? 0 : (await cdp.json(`(async () => { const d = window.__tools.dbg; const f = d.sym.find('engine_linear'); return { s: f.addr >>> 0, e: (f.addr + f.size) >>> 0 }; })()`));
    const inFn = a => a >= fnStart.s && a < fnStart.e;
    const diff = [];
    let n = 0;
    for (let i = 0; i < Math.min(pageSeq.length, gseq.length); i++){
      if (!inFn(pageSeq[i]) || !inFn(gseq[i])) break;         // 出了函数不再比（口径不同）
      n++;
      if (pageSeq[i] !== gseq[i]) diff.push(`第 ${i} 步：页面 ${hex(pageSeq[i])} ≠ gdb ${hex(gseq[i])}`);
    }
    log('   页面：' + pageSeq.map(hex).join(' → '));
    log('   gdb ：' + gseq.map(hex).join(' → '));
    ok(n >= 15, `函数体内可比对的单步序列长度 ${n}（页面 ${pageSeq.length} / gdb ${gseq.length}）`);
    ok(diff.length === 0, `engine_linear 内的单步落点与 gdb **逐步一致**（${n} 步，含两次函数调用）`, diff.slice(0, 4).join('；'));
    const pOut = pageSeq.find(a => !inFn(a)), gOut = gseq.find(a => !inFn(a));
    if (pOut != null && gOut != null && pOut !== gOut){
      log(`   （步出函数之后落点不同：页面 ${hex(pOut)} / gdb ${hex(gOut)} —— 调用者 stage_run 被内联进 main，`
        + '我们的"下一条语句"按地址序、gdb 按行号变化，口径不同，两者都在 main 里）');
    }
    const bd = [];
    for (const [spec, addr] of Object.entries(g.bpAddr || {})){
      if (oracle.bpAddr[spec] === undefined) continue;
      if (oracle.bpAddr[spec] !== addr) bd.push(`${spec}: 页面 ${hex(oracle.bpAddr[spec])} ≠ gdb ${hex(addr)}`);
    }
    ok(bd.length === 0, `「文件:行」断点落点与 gdb 一致（比了 ${Object.keys(oracle.bpAddr).length} 个）`, bd.join('；'));
    ok(g.resetVec == null || g.resetVec === oracle.resetVec, `复位向量一致：页面 ${hex(oracle.resetVec)} / gdb ${hex(g.resetVec)}`);
    /**
     * 位域/结构体：两次会话停在不同轮次，**原始数值当然不同**，所以不比数值 ——
     * 比的是"gdb 独立读出来的位域 == 页面那套位移假设"（在 oracle 脚本里逐字段核对过）。
     */
    ok(g.struct?.layoutOk === true, 'gdb 独立核对：位域排布与页面解码假设一致（word/spare/bias…逐字段）',
      JSON.stringify(g.struct?.diff || []));
  } else {
    log('   （没有 ' + ORACLE + '，跳过 gdb 对照 —— 先跑 node tmp/dbg-gdb-oracle.mjs）');
  }

  await cdp.eval(`await window.__tools.dbg.session.bpClear(); await window.__tools.dbg.disconnect(); return true;`);
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), elf: ELF, board: BOARD_ID, clockKhz: CLOCK_KHZ,
                                           pass, fail, failures, recoveries: recov, oracle }, null, 1));
  log('   测量结果已写入 ' + JSON_OUT);
}

log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
if (failures.length){ log('失败项：'); for (const f of failures) log('  · ' + f); }
cdp.close();
process.exit(fail ? 1 : 0);
