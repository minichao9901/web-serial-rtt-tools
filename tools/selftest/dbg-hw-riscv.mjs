/**
 * 调试器页 **RISC-V / JTAG 真机压力测试**（HPM 系列 + akaLinkPro，2026-10）
 *
 *   node tools/selftest/dbg-hw-riscv.mjs
 *   node tools/selftest/dbg-hw-riscv.mjs --oracle=tmp/rv-gdb-oracle.json     # 与 riscv gdb 逐地址比对
 *
 * 前置：
 *   1) 靶子固件已烧进板子（对应板卡的 dbgstress/fw.elf）：
 *      node tmp/rv-flash-and-smoke.mjs
 *   2) 8899 静态服务 + 9333 调试浏览器在跑（make page-prep）
 *   3) 探针没被别的东西占着（OpenOCD/pyOCD 要先退）
 *
 * 与 ARM 版（dbg-hw-stress.mjs）的**五处不同**（都是架构决定的，不是偷懒）：
 *   · 断点是核里的**触发器**（tselect/tdata1/tdata2，8 个），不是 FPB 比较器；
 *   · 单步是 `dcsr.step` 硬件单步（ARM 那颗探针不执行 C_STEP，要走"断点单步"兜底）；
 *   · 寄存器读要求**先停住核**（抽象命令），运行中读会 cmderr=4；
 *   · 复位是 ndmreset（会从 boot ROM 重新起，不像 H743 能靠 VC_CORERESET 钉在复位向量上）；
 *   · 靶子里没有中断（HPM 的 MCHTMR 走 SDK 的中断分发，留给下一轮），所以没有"ISR 里下断点"这一节。
 */
import { Cdp, sleep, DEV_RE } from './cdp-lib.mjs';
import { writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { artifact, getBoard, getExample, repoRoot } from './board-matrix.mjs';
import { Elf } from '../../app/elf/elf.js';
import { readJson, validateOracle } from './dbg-frame-contract.mjs';
import { runFrameStress } from './dbg-frame-hw-runner.mjs';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=').slice(1).join('=') : (argv.includes('--' + k) ? true : d); };

const APP = 'http://127.0.0.1:8899/index.html';
const BOARD_ID = String(arg('board', '6800evk'));
const BOARD = getBoard(BOARD_ID);
if (BOARD.target !== 'riscv') throw new Error(`RISC-V 测试要求 RISC-V 板卡，${BOARD_ID} 的 target=${BOARD.target}`);
const ELF = String(arg('elf', '/' + artifact(BOARD_ID, 'dbgstress')));
const SRCDIR = String(arg('src', resolve(repoRoot, getExample(BOARD_ID, 'dbgstress').project, 'src')));
const ORACLE = String(arg('oracle', BOARD_ID === '6800evk' ? 'tmp/rv-gdb-oracle.json' : `tmp/rv-gdb-oracle-${BOARD_ID}.json`));
const JSON_OUT = String(arg('out', BOARD_ID === '6800evk' ? 'tmp/rv-stress-page.json' : `tmp/rv-stress-page-${BOARD_ID}.json`));
const FRAME_ONLY=!!arg('frames-only',false),FRAME_ORACLE=arg('frame-oracle');
const FRAME_ROUNDS=Number(arg('frame-rounds',200));
if(!Number.isInteger(FRAME_ROUNDS)||FRAME_ROUNDS<1||FRAME_ROUNDS>2000)throw new Error('--frame-rounds 必须为1..2000');
/**
 * 页面侧拿源码只能走**静态服务**（8899 的根 = 仓库根），所以把磁盘路径换算成 URL 路径。
 * 为什么要这么绕：见下面"源码目录"那段的 🚨。
 */
const ROOT = repoRoot;
const SRC_REL = relative(ROOT, resolve(SRCDIR));
if (SRC_REL.startsWith('..')) throw new Error('--src 必须指向仓库里的目录（页面是通过 8899 静态服务取源码的）：' + SRCDIR);
const SRC_HTTP = '/' + SRC_REL.split(sep).join('/');
const SRC_NAMES = readdirSync(resolve(SRCDIR)).filter(f => /\.(c|h)$/i.test(f)).sort();
let frameOracle=null,frameBuild=null,frameCode=[];
if(FRAME_ONLY){
  if(!FRAME_ORACLE)throw new Error('栈帧验收必须指定 --frame-oracle');
  const elfDisk=resolve(ROOT,ELF.replace(/^\//,'')),bytes=readFileSync(elfDisk),buildPath=String(arg('build',join(dirname(elfDisk),'build-info.json')));
  frameBuild=readJson(buildPath);frameOracle=readJson(String(FRAME_ORACLE));validateOracle(frameOracle,frameBuild,bytes,BOARD_ID);
  const image=new Elf(new Uint8Array(bytes));
  frameCode=image.sections().filter(s=>(s.flags&2)&&!(s.flags&1)&&s.type===1&&s.addr>=0x80000000&&s.addr<0x81000000)
    .map(s=>({name:s.name,addr:s.addr,bytes:[...image.data(s.name)]}));
}
setTimeout(() => { console.error('[WATCHDOG] 25 分钟'); process.exit(9); }, 1500000);

const engLines = readFileSync(SRCDIR + '\\engine.c', 'utf8').split(/\r?\n/);
const CALL_LINE = engLines.findIndex(l => /engine_leaf\(a, 3u\)/.test(l)) + 1;

const log = m => console.log(m);
let pass = 0, fail = 0;
const failures = [];
const sec = t => log('\n' + t);
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; log('  PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' —— ' + extra : '')); log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const hex = n => '0x' + ((n ?? 0) >>> 0).toString(16);

const cdp = new Cdp();
await cdp.connect();
await cdp.send('Page.navigate', { url: APP + '?t=' + Date.now() });
for (let i = 0; i < 80; i++){ await sleep(300); if (await cdp.eval('return !!window.__tools?.dbg;').catch(() => false)) break; }
await cdp.eval(`document.querySelector('#tabs .tab[data-tab="dbg"]').click(); await new Promise(r=>setTimeout(r,250)); return true;`);

// 页面里的小工具（与 ARM 套件同一套形状）
await cdp.eval(`
  const d = window.__tools.dbg;
  window.__S = {
    d,
    async cmd(line){
      const el = document.getElementById('d-out');
      const n0 = el.children.length;
      const r = await d.runLine(line);
      let rows = [...el.children].slice(n0).map(c => c.textContent.trim());
      if (rows.length && rows[0].startsWith('>')) rows = rows.slice(1);
      return { out: rows, err: r?.error || null, text: rows.join('\\n') };
    },
    snap(){
      const cur = document.querySelector('#d-src .srcrow.cur');
      return { pc: d.session.pc >>> 0, halted: !!d.session.halted, connected: !!d.session.connected,
               name: d.sym ? d.sym.nameOf(d.session.pc >>> 0) : '',
               pos: document.getElementById('d-src-pos').textContent,
               bps: d.session.bpList().length,
               curLine: cur ? Number(cur.dataset.line) : null,
               at: d.sym ? d.sym.at(d.session.pc >>> 0) : null };
    },
    async go(ms = 4000){
      await d.session.cont();
      const t0 = Date.now();
      while (Date.now() - t0 < ms){ await new Promise(r => setTimeout(r, 25)); await d.session.refresh(); if (d.session.halted) break; }
      if (d.session.halted) await d.afterStop();
      return this.snap();
    },
    async step(cmd, ms = 5000){
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
    /** 触发器占用：读 8 个槽位的 tdata1（非 0 = 被占） */
    async trig(){
      const s = d.session, dm = s.dm, out = [];
      const wasHalted = s.halted;
      if (!wasHalted){ await dm.halt(0, 2000); await dm.waitHalted(2000); }
      for (let i = 0; i < 8; i++){ await dm.writeReg(0x7a0, i); out.push((await dm.readReg(0x7a1)) >>> 0); }
      await dm.writeReg(0x7a0, 0x80000000).catch(() => {});
      if (!wasHalted){ await dm.resume(null, 0); }
      return { used: out.filter(v => v !== 0 && v !== 0x21800000).length, raw: out.map(v => '0x' + v.toString(16)) };
    },
    async leak(){
      const t = await this.trig();
      const bps = d.session.bpList().length;
      return { bps, used: t.used, extra: t.used - bps, raw: t.raw };
    },
  };
  return true;`);

/**
 * 源码目录用**真文件**喂进去 —— 但**不能**用 `DOM.setFileInputFiles`。
 *
 * 🚨 2026-10 查实（Chrome 153）：那条 CDP 命令对 `webkitdirectory` 的 input **静默无效** ——
 *    命令不报错，可 `input.files.length` 恒为 0、`change` 也不触发，`d.src` 永远是空的。
 *    对照实验：同一个命令喂普通 file input（`#d-elf-file`）读回 1 个文件 ✔，
 *    喂 `#d-src-dir` 读回 0 个 ✘（传目录、传文件列表都一样）。ARM 版套件同样中招。
 *
 * 现在改成：页面里 fetch 这些 .c/.h（就在静态服务根下）→ 造 `File` → `_indexSrcFiles()`，
 * 与用户手选目录走的是同一条索引/反查路径。喂源码并进下面那次求值（跟载 ELF 一起）。
 */
sec(`== 0. 前置：${BOARD.label} ELF + 源码目录 + RISC-V 后端 + 连接 ==`);
const elfInfo = await cdp.json(`(async () => {
    const d = window.__tools.dbg;
    const r = await fetch(${JSON.stringify(ELF)} + '?t=' + Date.now());
    const st = d.loadElfBuffer(await r.arrayBuffer(), 'fw.elf');
    // 源码：页面里取真文件（见上面 🚨 —— webkitdirectory 的 input 喂不进去）
    const files = [];
    for (const n of ${JSON.stringify(SRC_NAMES)}){
      const rr = await fetch(${JSON.stringify(SRC_HTTP)} + '/' + n + '?t=' + Date.now());
      if (!rr.ok) return { err: '源码 ' + n + ' 取不到：HTTP ' + rr.status + '（' + ${JSON.stringify(SRC_HTTP)} + '，检查 --src 是否在仓库里）' };
      files.push(new File([await rr.text()], n));
    }
    if(${JSON.stringify(FRAME_ONLY)}){
      const rr=await fetch('/tools/target-firmware/common/dbg_frames.c?t='+Date.now());
      if(!rr.ok)return {err:'共享栈帧源码读取失败：HTTP '+rr.status};
      files.push(new File([await rr.text()],'dbg_frames.c'));
    }
    await d._indexSrcFiles(files);
    const be = document.getElementById('d-backend');
    be.value = 'riscv'; be.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 250));
    return { summary: st ? st.summary() : '(载入失败)', lines: st?.lines ? st.lines.summary() : null,
             srcReady: d.src.ready, src: d.src.summary(), session: d.session?.constructor?.name };
  })()`);
log('   ' + elfInfo.summary);
log('   ' + elfInfo.lines);
log('   ' + elfInfo.src);
ok(/行号表/.test(elfInfo.lines || ''), 'ELF 带行号表：' + elfInfo.lines);
ok(elfInfo.srcReady, '源码目录已喂进页面：' + elfInfo.src);
ok(elfInfo.session === 'RiscvDebugSession', '后端切到 RISC-V 后 session 换成了 RiscvDebugSession');
ok(CALL_LINE > 0, `靶子源码行号定位成功（调用在第 ${CALL_LINE} 行）`);

await cdp.eval(`const off = (id) => { const el = document.getElementById(id); if (el && el.checked){ el.checked = false; el.dispatchEvent(new Event('change')); } };
  off('d-rtt-on'); off('d-watch-live'); document.getElementById('d-rtt-stop')?.click(); return true;`);
const connP = cdp.eval(`await window.__tools.dbg.connect(); return document.getElementById('d-state').textContent;`, true);
await cdp.settle(DEV_RE, 'window.__tools.dbg.session.connected', 25000).catch(() => {});
log('   连接：' + await connP.catch(e => '异常：' + e.message));
await cdp.eval(`await window.__tools.dbg.session.halt(); await window.__tools.dbg.afterStop(); return true;`);
const env = await cdp.json(`(async () => {
    const d = window.__tools.dbg, S = window.__S;
    return { caps: d.session.caps, idcode: '0x' + ((d.session.idcode ?? 0) >>> 0).toString(16),
             halted: !!d.session.halted, pc: d.session.pc >>> 0, pos: document.getElementById('d-src-pos').textContent,
             leak: await S.leak() };
  })()`);
log(`   IDCODE ${env.idcode} · 触发器 ${env.caps.numCode} 个 · PC=${hex(env.pc)} ${env.pos}`);
ok(env.caps.numCode >= 4, `硬件断点（触发器）可用：${env.caps.numCode} 个`);
ok(env.halted, '能停住目标');
ok(env.leak.used === 0 && env.leak.bps === 0, '干净起点：没有触发器被占', JSON.stringify(env.leak));
ok(/\.c:\d+|\+\d/.test(env.pos || ''), 'PC 能映射到源码位置：' + env.pos);

if(FRAME_ONLY){
  sec('== RISC-V CFI / DWARF 局部变量：GDB oracle 对照与严格压力 ==');
  const frameResults=await runFrameStress({cdp,oracle:frameOracle,code:frameCode,board:BOARD_ID,rounds:FRAME_ROUNDS,ok,log,disconnectOnFinish:false});
  const finalLeak=await cdp.json(`(async()=>{const d=window.__tools.dbg;if(!d.session.connected)await d.connect();await d.session.bpClear();return await window.__S.leak();})()`);
  ok(finalLeak.used===0&&finalLeak.bps===0&&finalLeak.extra===0,'栈帧检查点全部清理后触发器为空',JSON.stringify(finalLeak));
  const recov=await cdp.eval('return window.__S.recoveries || [];');
  ok(recov.length===0,'严格栈帧验收期间没有目标意外复位/自动恢复',JSON.stringify(recov));
  mkdirSync(dirname(resolve(JSON_OUT)),{recursive:true});
  writeFileSync(JSON_OUT,JSON.stringify({at:new Date().toISOString(),board:BOARD_ID,elf:ELF,elfSha256:frameOracle.elfSha256,build:frameBuild,pass,fail,failures,frameResults},null,2));
  await cdp.eval(`if(window.__tools.dbg.session.connected)await window.__tools.dbg.disconnect();return true;`).catch(()=>{});
  log(`\n== RISC-V 栈帧汇总：${pass} 通过 / ${fail} 失败 ==`);
  cdp.close();process.exit(fail?1:0);
}

const oracle = { elf: ELF, arch: 'riscv', linear: [], bpAddr: {}, struct: {}, steps: {} };

sec('== 1. 断点：文件:行 / 符号 / static / 多断点 / 命中 ==');
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
  log('   符号表：' + Object.entries(specs).map(([k, v]) => `${k}=${hex(v?.addr)} ${String(v?.file).split('/').pop()}:${v?.line}`).join('  '));
  ok(Object.values(specs).every(Boolean), '关键函数都在符号表里（含 static 的 deep_l5 / is_even）');

  for (const fn of ['engine_linear', 'model_update']){
    const f = specs[fn];
    const spec = `${String(f.file).split('/').pop()}:${f.line}`;
    const r = await cdp.json(`(async () => {
        const S = window.__S, d = window.__tools.dbg;
        await d.session.bpClear();
        const c = await S.cmd('b ' + ${JSON.stringify(spec)});
        const bps = d.session.bpList();
        const out = { out: c.out, text: c.text, addr: bps[0]?.addr ?? null };
        await d.session.bpClear();
        return out;
      })()`);
    oracle.bpAddr[spec] = r.addr;
    ok(r.addr === f.addr, `b ${spec} 落到 ${hex(r.addr)}（与 b ${fn} 一致）`, r.text);
  }

  const multi = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg, hx = v => '0x' + ((v ?? 0) >>> 0).toString(16);
      await d.session.bpClear();
      for (const f of ['engine_linear', 'engine_deep_chain', 'engine_dispatch', 'model_update']) await S.cmd('b ' + f);
      const seen = [], pcs = [];
      for (let i = 0; i < 24; i++){
        const s = await S.go(4000);
        if (!s.halted) break;
        seen.push(d.sym.funcAt(s.pc)?.name || '?');
        pcs.push(hx(s.pc));
        if (new Set(seen).size >= 4) break;
      }
      const leak = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { seen, pcs, leak, clean };
    })()`);
  ok(new Set(multi.seen).size === 4, '4 个断点同时挂着，每一轮都轮到：' + multi.seen.join(' → '), JSON.stringify(multi.pcs));
  ok(multi.leak.extra === 0, '4 个断点占的就是 4 个触发器（没有多占）', JSON.stringify(multi.leak));
  ok(multi.clean.used === 0, '清空断点后触发器全部释放', JSON.stringify(multi.clean));

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

sec('== 2. 代码同步：停下时 PC → 源码位置 ==');
{
  const sync = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const out = [];
      await d.session.bpClear();
      for (const f of ['engine_linear', 'model_bitfield_touch', 'engine_branchy']){
        await S.cmd('b ' + f);
        const s = await S.go(4000);
        const at = d.sym.at(s.pc);
        out.push({ fn: f, halted: s.halted, pc: s.pc, name: s.name, pos: s.pos, curLine: s.curLine,
                   wantLine: at?.line, wantFile: String(at?.file || '').split('/').pop() });
        await d.session.bpClear();
      }
      return out;
    })()`);
  for (const r of sync){
    ok(r.halted && r.curLine === r.wantLine && r.wantLine > 0,
      `停到 ${r.fn}：源码高亮第 ${r.curLine} 行 == 行号表第 ${r.wantLine} 行（${r.wantFile}:${r.wantLine}）`,
      JSON.stringify({ pc: hex(r.pc), pos: r.pos }));
    ok(r.name.includes(r.fn), `停止位置显示函数名 ${r.fn}：${r.name}`);
  }
}

sec('== 3. 单步：n / si / fin（RISC-V 解码 + dcsr.step）==');
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
  ok(lin.seq.length === 20 && lin.seq.every(x => x.halted), '拿到 20 步的落点序列（每一步都停住了）');
  ok(lin.seq.every((x, i) => i === 0 || x.pc !== lin.seq[i - 1].pc), '每一步 PC 都变了（不会"点了没反应"）');
  ok(lin.seq.every(x => x.line > 0), '每一步都有源码行号');

  const into = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const leaf = d.sym.find('engine_leaf').addr >>> 0;
      await d.session.bpClear();
      await S.cmd('b engine.c:' + ${CALL_LINE});
      const s0 = await S.go(4000);
      const line0 = d.sym.at(s0.pc)?.line ?? 0;
      let hit = null, tries = 0, seq = [];
      for (let i = 0; i < 8 && !hit; i++){
        const s = await S.step('si'); tries++;
        seq.push('0x' + s.pc.toString(16));
        if ((d.sym.funcAt(s.pc)?.name || '') === 'engine_leaf') hit = s.pc;
      }
      await d.session.bpClear();
      return { line0, hit, tries, seq, leaf };
    })()`);
  oracle.steps.intoLeaf = into.hit;
  ok(into.line0 === CALL_LINE, `断在调用那一句（engine.c:${into.line0}）`);
  ok(into.hit === into.leaf, `si 从调用点进入 engine_leaf（第 ${into.tries} 次 si 停在 ${hex(into.hit)}）`, JSON.stringify(into));

  const fin = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b deep_l5');
      const s0 = await S.go(4000);
      const chain = [d.sym.funcAt(s0.pc)?.name || '?'];
      const out = [];
      for (let i = 0; i < 5; i++){
        const s = await S.step('fin', 15000);
        chain.push(d.sym.funcAt(s.pc)?.name || '?');
        out.push({ pc: '0x' + s.pc.toString(16), name: s.name, halted: s.halted, msg: s.text.slice(0, 110) });
      }
      const leak = await S.leak();
      await d.session.bpClear();
      const clean = await S.leak();
      return { chain, out, leak, clean };
    })()`);
  log('   fin 爬栈：' + fin.chain.join(' → '));
  const wantChain = ['deep_l5', 'engine_deep_l4', 'engine_deep_l3', 'engine_deep_l2', 'deep_l1', 'engine_deep_chain'];
  ok(JSON.stringify(fin.chain) === JSON.stringify(wantChain), '连续 5 次「跳出」逐层爬回调用者：' + fin.chain.join(' → '), JSON.stringify(fin.out));
  ok(fin.out.every(o => o.halted), '每一步都停住了');
  ok(fin.leak.extra === 0 && fin.clean.used === 0, 'fin 之后触发器收干净');
}

sec('== 4. 复位重跑 ==');
{
  const rst = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      const rounds = [];
      await d.session.bpClear();
      await S.cmd('b engine_linear');
      const want = d.sym.find('engine_linear').addr >>> 0;
      for (let i = 0; i < 2; i++){
        const r = await S.cmd('reset halt');
        const s0 = S.snap();
        const s1 = await S.go(6000);
        rounds.push({ resetPc: s0.pc, halted: s0.halted, bpPage: s0.bps, hit: s1.halted, hitPc: s1.pc,
                      name: s1.name, msg: r.text.slice(0, 90) });
      }
      await d.session.bpClear();
      return { rounds, want };
    })()`);
  for (const [i, r] of rst.rounds.entries()){
    log(`   第 ${i + 1} 轮：复位后 PC=${hex(r.resetPc)} 停住=${r.halted} → 继续命中=${r.hit} ${hex(r.hitPc)} ${r.name}`);
  }
  ok(rst.rounds.length === 2 && rst.rounds.every(r => r.halted), '复位后目标处于停止状态');
  ok(rst.rounds.every(r => r.hit && r.hitPc === rst.want),
    '复位之后断点仍然有效、继续就能命中：' + rst.rounds.map(r => hex(r.hitPc)).join(' , '));
}

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
      const E = await S.cmd('p g_model.nodes[1].cell.scale');
      const F = await S.cmd('p g_model.word.halves.hi');
      const G = await S.cmd('p g_model.blob');
      const H = await S.cmd('p g_model.tag');
      const I = await S.cmd('p g_model.label');
      const J = await S.cmd('p g_model.nodes[9]');
      const K = await S.cmd('p g_model.nosuchmember');
      const L = await S.cmd('p g_model_plain');
      const M = await S.cmd('p g_model_const');
      const f = d.sym.typeOf('g_model.flags');
      const raw = await d.session.memRead(f.addr, 20);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      const w0 = dv.getUint32(0, true) >>> 0, w1 = dv.getUint32(16, true) >>> 0;
      const check = { w0, w1, addr: f.addr,
        bits: { on: w0 & 1, level: (w0 >>> 1) & 7, mode: (w0 >>> 4) & 3, parity: (w0 >>> 6) & 1, rev: (w0 >>> 7) & 0x1ff, spare: (w0 >>> 16) & 0xffff },
        sb: { bias: (w1 << 26) >> 26, tag: (w1 >>> 6) & 0x3ff, rest: (w1 >>> 16) & 0xffff } };
      await d.session.bpClear();
      return { A, B, C, D, E, F, G, H, I, J, K, L, M, check };
    })()`);
  const first = a => (a.out || [])[0] || '';
  log('   p g_model              : ' + first(mp.A));
  log('   p g_model.flags        : ' + first(mp.B));
  log('   p <位域>               : ' + first(mp.C));
  log('   p nodes[1].cell.scale  : ' + first(mp.E));
  log('   p g_model_plain        : ' + first(mp.L));
  log('   p g_model_const        : ' + first(mp.M) + `（${mp.M.out.length} 行）`);
  ok(/struct/.test(first(mp.A)) && mp.A.out.length > 20, `p g_model 打出结构体树（${mp.A.out.length} 行）`);
  ok(/struct/.test(first(mp.B)) && mp.B.out.some(l => /on : 1/.test(l)), 'p g_model.flags：嵌套结构体带位域行');
  ok(/位域\[bit/.test(first(mp.C)), 'p <位域>按位取：' + first(mp.C));
  ok(/有符号/.test(first(mp.D)), '有符号位域明确标出来：' + first(mp.D));
  ok(/f64|double/.test(first(mp.E)), '三层复合路径 ✓：' + first(mp.E));
  ok(/u16|short/.test(first(mp.F)), '联合体成员 ✓：' + first(mp.F));
  ok(mp.H.out.some(l => /01234567/.test(l)), 'char[8] 当字符串显示（没有 NUL 也不越界）');
  ok(!/找不到/.test(first(mp.I)), '指针成员能打：' + first(mp.I));
  ok(/越界/.test(first(mp.J)), '下标越界如实报错：' + first(mp.J));
  ok(/没有成员/.test(first(mp.K)), '成员名写错如实报错：' + first(mp.K));
  ok(/struct/.test(first(mp.L)) && mp.L.out.length > 20, 'p g_model_plain 能展开');
  /**
   * 🚨 判据用 `some()` 而不是"第一行"：flash 里的 const 走的是 **ELF 只读段兜底**，
   *    而兜底时页面会先插一行说明（"读的是 ELF 里那份，不是从目标实时读回来的"）——
   *    那行在最前面是**对的**（用户必须先看到它），所以断言不能只看第一行。
   */
  ok(mp.M.out.some(l => /struct/.test(l)) && mp.M.out.length > 20,
    `p g_model_const（flash 里的 const）能展开（${mp.M.out.length} 行，读的是 ELF 里的只读内容）`);

  const rawTree = await cdp.json(`(async () => {
      const d = window.__tools.dbg;
      const t = d.sym.typeOf('g_model.flags');
      const raw = await d.session.memRead(t.addr, 20);
      const W = await import('/app/dbg/watch.js');
      return W.treeRows({ type: t.type, label: 'flags' }, raw).map(r => ({ n: r.name, t: r.text, bf: !!r.bitfield }));
    })()`);
  const got = {};
  for (const r of rawTree) if (r.bf) got[String(r.n).split(' ')[0]] = r.t;
  const want = { ...mp.check.bits, ...mp.check.sb };
  const mism = [];
  for (const [k, v] of Object.entries(want)){
    const g = got[k];
    const gv = g != null ? Number(String(g).split(' ')[0]) : null;
    if (gv !== v) mism.push(`${k}: 树=${gv} 影子字=${v}`);
  }
  ok(mism.length === 0, `位域与影子字逐位对账（word=0x${mp.check.w0.toString(16)} / word2=0x${mp.check.w1.toString(16)}）`, mism.join('；'));

  const watch = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await S.cmd('wd all');
      await S.cmd('w g_model');
      await S.cmd('w g_model.flags.bits.level');
      await S.cmd('w g_model.nodes[2].cell.scale');
      const items = d.watch.items.map(it => ({ e: it.expr, err: it.error || null, kind: it.kind, v: it.value?.text ?? null }));
      document.querySelector('#d-watch-list button.exp')?.click();
      await new Promise(r => setTimeout(r, 400));
      const rows = [...document.querySelectorAll('#d-watch-list .wkid')].map(e => e.textContent.trim());
      await S.cmd('wd all');
      return { items, rowCount: rows.length };
    })()`);
  ok(watch.items[0] && !watch.items[0].err && watch.items[0].kind === 'struct', '监视加结构体项：' + JSON.stringify(watch.items[0]));
  ok(watch.rowCount > 20, `展开后画出成员树（${watch.rowCount} 行）`);
  ok(watch.items[1] && !watch.items[1].err, '监视复合路径（位域）✓：' + JSON.stringify(watch.items[1]));
  ok(watch.items[2] && !watch.items[2].err, '监视复合路径（数组元素成员）✓：' + JSON.stringify(watch.items[2]));
}

sec('== 6. 压力：连续 40 次「停 — 走 — 停」+ 触发器泄漏 ==');
{
  const stress = await cdp.json(`(async () => {
      const S = window.__S, d = window.__tools.dbg;
      await d.session.bpClear();
      await S.cmd('b engine_branchy');
      const names = [], bad = [];
      let maxExtra = 0, misses = 0;
      for (let i = 0; i < 40; i++){
        const s = await S.go(3000);
        if (!s.halted){ misses++; continue; }
        names.push(d.sym.funcAt(s.pc)?.name || '?');
        if (i % 10 === 0){
          const lk = await S.leak();
          maxExtra = Math.max(maxExtra, lk.extra);
          if (lk.extra !== 0 || lk.bps !== 1) bad.push('第 ' + i + ' 轮：' + JSON.stringify(lk));
        }
      }
      const clean = await S.leak();
      await d.session.bpClear();
      const final = await S.leak();
      return { n: names.length, misses, names: [...new Set(names)], bad, maxExtra, clean, final };
    })()`);
  log(`   40 轮：停下来的函数集合 = ${stress.names.join(',')}`);
  ok(stress.n === 40 && stress.misses === 0, `连续 40 轮都停下来了（实际 ${stress.n}，漏 ${stress.misses}）`, JSON.stringify(stress.bad));
  ok(stress.names.length === 1 && stress.names[0] === 'engine_branchy', '40 轮都停在同一个断点上');
  ok(stress.bad.length === 0 && stress.maxExtra === 0, '过程中触发器占用始终等于用户断点数', JSON.stringify(stress.bad));
  ok(stress.final.used === 0, '压完清空断点，触发器回到 0');
}

sec('== 7. 收尾 + 与 riscv gdb 对照 ==');
{
  const errs = await cdp.eval('return window.__tools.errors || [];');
  ok(Array.isArray(errs) && errs.length === 0, '整轮没有一个页面未捕获错误', JSON.stringify(errs).slice(0, 300));

  if (existsSync(ORACLE)){
    const g = JSON.parse(readFileSync(ORACLE, 'utf8'));
    log('   载入 gdb 对照：' + ORACLE + '（' + (g.tool || 'riscv32 gdb') + '）');
    /**
     * 🚨 **比的是"指令级单步"（我们 s ↔ gdb stepi），不是"源码级 n"**：
     *    gdb 的 `next` 在这块板上会卡在第 29 行那个调用上（跳过调用要在返回地址插临时断点，
     *    而代码在 flash 里、软件断点写不进去）—— 所以 gdb 侧的基线就是 `stepi`。
     *    两边从**同一个地址**（gdb 的 hbreak 落点 = 函数序言后的第一条语句，也就是我们 `n` 一步之后的落点）
     *    各走 ${19} 条指令，逐地址一致才算"单步语义与 gdb 相同"。
     */
    const STEPN = (g.linear || []).length;
    const ourStepi = await cdp.json(`(async () => {
        const S = window.__S, d = window.__tools.dbg;
        await d.session.bpClear();
        await S.cmd('b engine_linear');
        await S.go(4000);
        const first = await S.step('n');          // 走到 gdb hbreak 的落点（序言之后）
        const start = first.pc >>> 0;
        const out = [];
        for (let i = 0; i < ${STEPN}; i++){ const s = await S.step('s'); out.push(s.pc >>> 0); }
        await d.session.bpClear();
        return { start, out };
      })()`);
    const gseq = (g.linear || []).map(x => x.pc);
    log('   页面（指令级）：' + ourStepi.out.map(hex).join(' → '));
    log('   gdb （stepi） ：' + gseq.map(hex).join(' → '));
    const diff = [];
    let n = 0;
    for (let i = 0; i < Math.min(ourStepi.out.length, gseq.length); i++){
      n++;
      if (ourStepi.out[i] !== gseq[i]) diff.push(`第 ${i + 1} 步：页面 ${hex(ourStepi.out[i])} ≠ gdb ${hex(gseq[i])}`);
    }
    ok(n >= 15, `能与 gdb 比对的指令级单步序列长度 ${n}`);
    ok(diff.length === 0, `指令级单步落点与 gdb **逐地址一致**（${n} 步，同一颗核逐条指令）`, diff.slice(0, 4).join('；'));

    const bd = [];
    for (const [spec, addr] of Object.entries(g.bpAddr || {})){
      if (oracle.bpAddr[spec] === undefined) continue;
      if (oracle.bpAddr[spec] !== addr) bd.push(`${spec}: 页面 ${hex(oracle.bpAddr[spec])} ≠ gdb ${hex(addr)}`);
    }
    ok(bd.length === 0, `「文件:行」断点落点与 gdb 的行号表一致（比了 ${Object.keys(oracle.bpAddr).length} 个）`, bd.join('；'));
    ok(g.struct?.layoutOk === true, 'gdb 独立核对：位域排布与页面解码假设一致', JSON.stringify(g.struct?.diff || []));
    if (g.trap && g.trap.count != null) log(`   gdb 侧读到的靶子现场：g_trap_count=${g.trap.count} cause=${hex(g.trap.cause)} epc=${hex(g.trap.epc)}`);
    log('   （口径说明：gdb 的 `break 文件:行` 会**跳过函数序言**落到第一条语句上，'
      + '页面按用户点的那一行/DWARF 行号表的记录地址 —— 所以上面比的是行号表地址，不是 gdb 的 break 落点）');
  } else {
    log('   （没有 ' + ORACLE + '，跳过 gdb 对照 —— 先跑 node tmp/rv-gdb-oracle.mjs）');
  }

  if (BOARD_ID === '5301evklite'){
    sec('== 8. RISC-V 异常：注入非法指令并与 trap CSR 核对 ==');
    const trap = await cdp.json(`(async()=>{
      const d=window.__tools.dbg, S=window.__S;
      const trigger=d.sym.find('g_fault_trigger'), stall=d.sym.find('g_exception_stall'), inject=d.sym.find('inject_illegal_instruction');
      if(!trigger||!stall||!inject)throw Error('异常测试固件缺少注入/停留符号');
      await d.session.bpClear(); await S.cmd('b g_exception_stall');
      const bp=d.session.bpList()[0];
      const bytes=new Uint8Array(4); new DataView(bytes.buffer).setUint32(0,1,true);
      await d.session.memWrite(trigger.addr,bytes);
      const stopped=await S.go(5000);
      const read32=async name=>{const f=d.sym.find(name);if(!f)throw Error('缺少现场符号 '+name);const b=await d.session.memRead(f.addr,4);return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);};
      const words={count:await read32('g_trap_count'),cause:await read32('g_trap_cause'),
                   epc:await read32('g_trap_epc'),mtval:await read32('g_trap_mtval')};
      const illegal=d.sym.find('g_illegal_instruction_pc');
      if(!illegal)throw Error('异常测试固件缺少非法指令定位符号');
      d._dockSelect('fault');
      d.faultPanel.snapshot=null;
      document.getElementById('d-fault-read')?.click();
      const t0=Date.now();
      while(!d.faultPanel?.snapshot && Date.now()-t0<5000)await new Promise(r=>setTimeout(r,50));
      const snapshot=d.faultPanel?.snapshot;
      return {pc:stopped.pc>>>0,halted:stopped.halted,bp:bp?.addr>>>0,stall:stall.addr>>>0,illegal:illegal.addr>>>0,inject:inject.addr>>>0,
              words,raw:snapshot?.raw||null,error:snapshot?.error||null,findings:snapshot?.findings||[]};
    })()`);
    log('   固件备份：' + JSON.stringify(trap.words) + '；异常面板 CSR：' + JSON.stringify(trap.raw));
    ok(trap.halted && trap.pc === trap.bp && trap.bp === trap.stall, '目标在异常现场保存完成后由硬件断点停住');
    ok(trap.words.count === 1 && trap.words.cause === 2 && trap.words.epc === trap.illegal,
      '固件 trap 处理器记录到非法指令异常（mcause=2）', JSON.stringify(trap.words));
    ok(trap.raw?.mcause === 2 && trap.raw?.mepc === trap.words.epc,
      '异常面板读取的 mcause/mepc 与固件备份一致', JSON.stringify(trap.raw));
    ok(!trap.error && trap.findings.some(f=>/非法指令/.test(f.text||f.message||'')), '异常面板成功解码非法指令原因', trap.error||'');
  }

  await cdp.eval(`await window.__tools.dbg.session.bpClear(); await window.__tools.dbg.disconnect(); return true;`);
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), board: BOARD_ID, elf: ELF, pass, fail, failures, oracle }, null, 1));
  log('   测量结果已写入 ' + JSON_OUT);
}

log(`\n== 汇总：${pass} 通过 / ${fail} 失败 ==`);
if (failures.length){ log('失败项：'); for (const f of failures) log('  · ' + f); }
cdp.close();
process.exit(fail ? 1 : 0);
