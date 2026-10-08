/**
 * 「调试器」页（#dbg）—— 零安装的极简调试前端：暂停/继续/单步/复位、寄存器、内存、
 * 硬件断点、符号列表、监视窗口、源码行、命令行（gdb 风格的最小子集）、RTT 输出同屏。
 *
 * 分工：**这个文件只管 DOM**，所有语义都在
 *   app/dbg/session.js（会话：运行控制 / 寄存器 / 内存 / FPB 断点）
 *   app/dbg/cmd.js    （命令解析与输出，纯逻辑）
 *   app/dbg/symbols.js（ELF 符号 + 行号表）
 *   app/dbg/watch.js  （监视项解析与显示，纯逻辑）
 *   app/dbg/complete.js（Tab 补全，纯逻辑）
 *   app/dbg/source.js （源码目录授权与读取）
 * 里，它们都能在没有浏览器的情况下自测。
 *
 * 四条本仓的界面纪律：
 *   ① 短等待一律用 core/pace.js 的 waitMs（页面在后台时 setTimeout 会被钳到 ≥1 s）；
 *   ② 日志/表格的滚动用 ui/dom.js 的 appendLogLine（别每行写 scrollTop：读 scrollHeight 会强制同步布局）；
 *   ③ 新加的元素一律 `if (el)` 判空 —— 旧 index.html + 新 js（或反过来）时不能让初始化整个断掉；
 *   ④ 命令行是**主窗口**：上面的寄存器/内存/源码都能折叠，把高度让给它。
 */

import { prepareProbeHandoff } from '../core/probe-users.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { $, setFlag, appendLogLine, ensureSelectOption } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { waitMs } from '../core/pace.js';
import { DebugSession, DEFAULT_CLOCK_KHZ } from './session.js';
import { RiscvDebugSession } from './riscv.js';
import { runCmd } from './cmd.js';
import { SymTab } from './symbols.js';
/**
 * 寄存器名**不分大小写**比。
 *
 * 🚨 2026-10 真机现场（HPM6800EVK + tcpecho）：ARM 后端推的寄存器名是 `'PC'`/`'LR'`，
 *    RISC-V 后端推的是小写 `'pc'`（见 riscv.js 的寄存器表）。这里原来是 `r.name === 'PC'`
 *    精确比，于是 RISC-V 上：① 页头永远显示 `PC 0x00000000`（`|| 0` 兜底）；② **内存跟随
 *    PC 直接失效**（找不到 PC 就 return）——顺手让内存窗口一直停在上一块板子留下的
 *    `0x0800_0300` 上，反复读它 → SBA 报错 → 触发自愈（复位 DM）→ 用户紧接着按「继续」
 *    就撞上 `抽象命令失败（读寄存器 0x7b0）：cmderr=4`。一个大小写，串起两个症状。
 */
const regIs = (name, want) => String(name ?? '').toUpperCase() === want;
import { WatchList, resolveWatch, formatWatchValue, treeRows, summarizeTree, TREE_LIMITS } from './watch.js';
import { completeLine } from './complete.js';
import { SourceStore, sourceRootSuggestions } from './source.js';
import { hex32, parseBytes } from './fmt.js';
import { Rtt } from '../rtt/protocol.js';
import { parseSvdXml, decodeSvdRegister, svdSummary } from './svd.js';
import { FaultPanel } from './fault-panel.js';

const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); return el; };
const baseName = p => String(p || '').replace(/\\/g, '/').split('/').pop();

export class DbgView {
  constructor(){
    this.session = new DebugSession();
    this.bus = null;                       // ProbeBus（由 main.js 注入，用来请别的页签让出探针）
    this.sym = null;
    this._memAddrStale = false;      // 内存窗口里那个"上一块板子留下的地址"要不要停用自动读
    this.rtt = null;
    this.elfName = '';
    this.mem = new Uint8Array(0);
    this.memAddr = 0;
    this.sel = new Map();                  // 寄存器名 → 待提交的编辑（input 的临时值）
    this.hist = [];
    this.histIdx = -1;
    this.watching = false;
    this.rttTimer = null;
    this.autoRead = true;
    this.watch = new WatchList();          // 监视窗口
    this.watchBusy = false;
    this.src = new SourceStore();          // 源码文件仓（用户授权一次目录）
    this.srcCur = null;                    // {file, line, addr} 当前源码位置
    this.srcShown = null;                  // 已经画出来的视图（用于只在位置变化时滚动）
    this.cancelFlag = false;               // Ctrl+C
    this.queue = [];                       // 多行粘贴 → 排队执行
    this.runningQueue = false;
    this.dockTab = 'regs';                 // 右侧面板当前 tab（regs / mem / var / svd / rtt）
    this.svd = null;                       // 当前 SVD 模型（用户选择或内置 F103）
    this.svdName = '';
    this.svdRaw = null;
    this.faultPanel = new FaultPanel(this);
  }

  /** 把 session 的日志接到命令行（换后端时会换 session 对象，所以要能重复调用）*/
  _bindSessionLog(){
    this.session.log = (t, c) => this._out(t, c);
  }

  // ================================================================ 初始化

  init(){
    this._bindSessionLog();
    this.faultPanel.init();
    this.session.sym = null;

    // ---- 侧栏 ----
    const be = $('d-backend');
    if (be){ store.bind(be, 'dbg.backend'); be.addEventListener('change', () => this._syncBackend()); }
    const clk = $('d-clock');
    if (clk){
      store.bind(clk, 'dbg.clock');
      /**
       * 时钟默认值迁移（2026-10-02）：老版本的默认是 1 MHz，那时下拉里也只有 1000/500/200 ——
       * 所以"没存过"和"存着 1000"的都属于**旧默认**，跟着新默认走到 10 MHz；
       * 手选过 500/200 的保持不动（真需要的场景就是探针不肯跑高时钟）。
       */
      const saved = store.get('dbg.clock', '');
      if (!saved || saved === '1000'){
        clk.value = String(DEFAULT_CLOCK_KHZ);
        store.set('dbg.clock', clk.value);
        if (saved === '1000') this.clockMigrated = true;
      } else {
        ensureSelectOption(clk, saved, saved + ' kHz');    // 老值不在候选里时补一个，别静默改设置
      }
      clk.addEventListener('change', () => store.set('dbg.clock', clk.value));
    }
    on('d-connect', 'click', () => this.connect());
    on('d-disconnect', 'click', () => this.disconnect());
    on('d-elf-pick', 'click', () => $('d-elf-file')?.click());
    on('d-elf-file', 'change', e => this._loadElfFile(e.target.files?.[0]));
    on('d-svd-pick', 'click', () => $('d-svd-file')?.click());
    on('d-svd-file', 'change', e => this._loadSvdFile(e.target.files?.[0]));
    on('d-svd-default', 'click', () => this.loadBundledSvd());
    on('d-svd-periph', 'change', () => { this._renderSvdRegisters(); this._renderSvdRegister(); });
    on('d-svd-reg', 'change', () => this._renderSvdRegister());
    on('d-svd-read', 'click', () => this._act('读取 SVD 寄存器', () => this._readSvdRegister()));
    on('d-reset-halt', 'click', () => this._act('复位并停住', async () => { await this.session.resetHalt(); await this.refreshAll(); }));
    on('d-reset-run', 'click', () => this._act('复位并运行', async () => { await this.session.resetRun(); this._startWatch(); }));
    on('d-reg-refresh', 'click', () => this._act('刷新寄存器', () => this.session.refreshRegs().then(() => this.renderRegs())));
    on('d-bt', 'click', () => this.runLine('bt'));
    on('d-bt-scan', 'click', () => this.runLine('bt scan'));
    on('d-wp-add', 'click', () => this.runLine(`wp ${$('d-wp-addr').value.trim()} ${$('d-wp-mode').value} ${$('d-wp-size').value}`));
    on('d-wp-clear', 'click', () => this.runLine('wpd all'));
    on('d-bp-clear', 'click', () => this._act('清空断点', async () => { await this.session.bpClear(); this.renderBps(); this.renderSource(); }));
    on('d-rtt-locate', 'click', () => this.rttStart());
    on('d-rtt-stop', 'click', () => this.rttStop());
    on('d-rtt-clear', 'click', () => this.rttClear());
    const rttChk = $('d-rtt-on');
    if (rttChk) store.bind(rttChk, 'dbg.rttAuto', 'checked');
    const ra = $('d-rtt-addr');
    if (ra){ store.bind(ra, 'dbg.rttAddr'); ra.addEventListener('input', () => this._renderRttSym()); }

    // ---- 符号列表 ----
    on('d-sym-q', 'input', () => this.renderSyms());
    const symList = $('d-sym-list');
    if (symList){
      symList.addEventListener('click', (e) => {
        const btn = e.target.closest?.('button[data-watch]');
        if (btn){ this.addWatch(btn.dataset.watch); return; }
        const row = e.target.closest?.('.symrow');
        if (row?.dataset.name) this._fillCmd(`p ${row.dataset.name}`);
      });
    }

    // ---- 监视窗口 ----
    on('d-watch-add', 'click', () => { const i = $('d-watch-in'); if (i?.value) this.addWatch(i.value); });
    const wi = $('d-watch-in');
    if (wi) wi.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); this.addWatch(wi.value); } });
    on('d-watch-refresh', 'click', () => this.refreshWatch({ force: true }));
    on('d-watch-clear', 'click', () => this.clearWatch());
    const wl = $('d-watch-list');
    if (wl){
      wl.addEventListener('click', (e) => {
        const x = e.target.closest?.('button[data-del]');
        if (x){ this.delWatch(Number(x.dataset.del)); return; }
        const ex = e.target.closest?.('button[data-exp]');
        if (ex){
          this.watch.toggle(Number(ex.dataset.exp));
          this._saveWatch();
          this.renderWatch();
        }
      });
    }
    const live = $('d-watch-live');
    if (live) store.bind(live, 'dbg.watchLive', 'checked');

    // ---- 源码视图 ----
    on('d-src-pick', 'click', () => this.pickSourceDir());
    on('d-src-dir', 'change', e => this._indexSrcFiles(e.target.files));
    const srcBox = $('d-src');
    if (srcBox){
      srcBox.addEventListener('click', (e) => {
        const ln = e.target.closest?.('.ln');
        const row = ln?.closest?.('.srcrow');
        if (row?.dataset.line) this.toggleSourceBp(Number(row.dataset.line));
      });
      // 双击**正文**（不是行号）= 运行到这一行；行号单击仍然是"下/删断点"（两者不打架）
      srcBox.addEventListener('dblclick', (e) => {
        if (e.target.closest?.('.ln')) return;
        const row = e.target.closest?.('.srcrow');
        if (row?.dataset.line) this.runToLine(Number(row.dataset.line));
      });
    }

    // ---- 快捷键（对齐 MDK / Ozone 的手感）----
    /**
     * F10 跳过 / F11 进入 / Shift+F11 跳出。
     *
     * ⚠️ 诚实说明：**F11 在 Chrome/Edge 里是"全屏"的浏览器级快捷键，页面拦不住**。
     *    所以这里同时提供 **Ctrl+F11 / Ctrl+F10 / Ctrl+Shift+F11** 三个不会被抢的组合，
     *    再加上工具栏上那三个按钮 —— 三者等价（命令行还有 n / si / fin）。
     *    不绑 F5（继续）也是这个原因：F5 是刷新，抢不过浏览器，按下去会**丢掉整个调试会话**。
     */
    document.addEventListener('keydown', (e) => {
      if (!this._visible()) return;
      if (e.altKey || e.metaKey) return;
      const ctrl = e.ctrlKey;
      if (e.key === 'F10'){ e.preventDefault(); this.stepOver(); return; }
      if (e.key === 'F11'){
        e.preventDefault();
        if (e.shiftKey) this.stepOut(); else this.stepInto();
        return;
      }
      if (ctrl && e.shiftKey && e.key === 'F11'){ e.preventDefault(); this.stepOut(); return; }
    });

    // ---- 工作区版式（右侧 tab 面板 + 可拖分隔条）----
    this._initWorkbench();

    // ---- 主区按钮 ----
    on('d-halt', 'click', () => this._act('暂停', async () => { await this.session.halt(); this.renderRegs(); this.renderMem(); await this.afterStop(); }));
    on('d-cont', 'click', () => this._act('继续', async () => { await this.session.cont(); this._startWatch(); }));
    on('d-step', 'click', () => this._act('单步', async () => { await this.session.step(); this.renderRegs(); this.renderMem(); await this.afterStop(); }));
    // ---- 源码级单步（2026-10）：跳过 / 进入 / 跳出（对应 MDK-Ozone 的 F10 / F11 / Shift+F11）----
    on('d-step-over', 'click', () => this.stepOver());
    on('d-step-into', 'click', () => this.stepInto());
    on('d-step-out', 'click', () => this.stepOut());
    on('d-mem-read', 'click', () => this._act('读内存', () => this._readMemLocked()));
    // 🚨 writeMemEdit() **自己**已经包了 _act —— 这里再包一层会让内层看到 busy=true 直接退出，
    //    现象是"点了写入、日志只说正在忙、内存一个字节都没改"（本仓自测抓到的）
    on('d-mem-write', 'click', () => this.writeMemEdit());
    on('d-run', 'click', () => { const i = $('d-cmd'); const v = i?.value; if (i) i.value = ''; this.runLine(v); });
    const cmd = $('d-cmd');
    if (cmd){
      cmd.addEventListener('keydown', e => this._cmdKey(e));
      cmd.addEventListener('paste', e => this._cmdPaste(e));
    }
    const out = $('d-out');
    if (out){
      // 点输出区（没在选文字时）把焦点还给输入行 —— 终端的手感
      out.addEventListener('mouseup', () => {
        const sel = window.getSelection?.();
        if (sel && String(sel).length) return;
        $('d-cmd')?.focus();
      });
    }
    const ev = $('d-mem-ev');
    if (ev) ev.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); this.writeMemEdit(); } });
    // 手改了「改」那一行的地址，就别再用"点字节"记下的那个地址
    const ea = $('d-mem-ea');
    if (ea) ea.addEventListener('input', () => { this._memEditAddr = null; });
    const ma = $('d-mem-addr');
    if (ma){
      store.bind(ma, 'dbg.memAddr');
      ma.addEventListener('input', () => { this._memEditAddr = null; });      // 手改了地址就别再用"点字节"记下的那个
      ma.addEventListener('input', () => { this._memAddrStale = false; });    // 手改了地址 = 明确要看那儿，自动读重新放行
      ma.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); this.readMem(); } });
    }
    const ml = $('d-mem-len');
    if (ml) store.bind(ml, 'dbg.memLen');
    const fp = $('d-follow-pc');
    if (fp) store.bind(fp, 'dbg.followPc', 'checked');
    const mw = $('d-mem-write-on');
    if (mw){ store.bind(mw, 'dbg.memWritable', 'checked'); mw.addEventListener('change', () => this.renderMem()); }

    this._syncBackend();
    this._syncButtons(false);
    // 先把空面板的占位提示画出来（否则刚打开是一片空白，看着像坏了）
    this.renderRegs(); this.renderMem(); this.renderBps(); this.renderSyms(); this.renderWatch(); this.renderSource();
    this._restoreWatch();
    if (!DbgView.supported()) this._out('这个浏览器没有 WebUSB（桌面版 Chrome/Edge 才有）—— 可以选「模拟目标」体验界面', 'warn');
    this._out('调试器就绪。连上目标后按 h 看命令，Tab 补全、↑↓ 翻历史、Ctrl+C 中断。', 'dim');
    return this;
  }

  static supported(){ return typeof navigator !== 'undefined' && 'usb' in navigator; }

  onShow(){
    // 切回本页时对账一次状态（目标可能在别的页签里被复位/被烧录器抢走）
    // 🚨 用 tryExclusive：观察循环正在读的时候直接跳过这一拍，别和它抢 SWD
    if (this.session.connected){
      this.session.tryExclusive(() => this.refreshAll()).catch(() => {});
    }
  }

  // ================================================================ 工作区版式（右侧 tab + 可拖分隔条）

  /**
   * 右边那条面板是**局部 tab**（寄存器 / 内存 / 变量 / SVD / RTT），一次只显示一个、顶到满高 ——
   * 这是照 Ozone 的意思排的：左边源码与命令行各占一块够大的地方，细节面板做成切换。
   * 分隔条：竖的调右侧宽度、横的调命令行高度，尺寸存 localStorage，刷新不丢。
   */
  _initWorkbench(){
    // ---- tab ----
    const tabs = $('d-dock-tabs');
    if (tabs){
      const btns = [...tabs.querySelectorAll('button[data-dock]')];
      for (const b of btns) b.addEventListener('click', () => this._dockSelect(b.dataset.dock));
      const saved = store.get('dbg.dock', 'regs');
      this._dockSelect(btns.some(b => b.dataset.dock === saved) ? saved : 'regs', { save: false });
    }
    // ---- 尺寸（存的是 px；没存就用 CSS 里的默认比例）----
    const term = $('d-box-term'), dock = $('d-box-dock');
    const termH = Number(store.get('dbg.termH', 0)) || 0;
    const dockW = Number(store.get('dbg.dockW', 0)) || 0;
    if (term && termH > 0) term.style.flexBasis = Math.round(termH) + 'px';
    if (dock && dockW > 0) dock.style.flexBasis = Math.round(dockW) + 'px';
    this._bindGrip($('d-grip-term'), {
      axis: 'y',
      get: () => term?.getBoundingClientRect().height || 0,
      apply: (v) => { if (term) term.style.flexBasis = Math.round(v) + 'px'; },
      min: () => 110,
      max: () => Math.max(160, (term?.parentElement?.clientHeight || 600) * 0.82),
      save: (v) => store.set('dbg.termH', Math.round(v)),
    });
    this._bindGrip($('d-grip-dock'), {
      axis: 'x',
      get: () => dock?.getBoundingClientRect().width || 0,
      apply: (v) => { if (dock) dock.style.flexBasis = Math.round(v) + 'px'; },
      min: () => 250,
      max: () => Math.max(300, (dock?.parentElement?.clientWidth || 1200) - 320),
      save: (v) => store.set('dbg.dockW', Math.round(v)),
    });
  }

  /** 切右侧面板的 tab（名字：regs / mem / var / svd / rtt） */
  _dockSelect(name, { save = true } = {}){
    const tabs = $('d-dock-tabs');
    if (tabs) for (const b of tabs.querySelectorAll('button[data-dock]')) b.classList.toggle('on', b.dataset.dock === name);
    const box = $('d-box-dock');
    if (box) for (const p of box.querySelectorAll('.dockpage')) p.classList.toggle('on', p.dataset.dock === name);
    this.dockTab = name;
    if (save) store.set('dbg.dock', name);
    // 内存页刚露出来时按当前宽度决定一行几个字节（面板是隐藏的时候量不到宽度）
    if (name === 'mem' && this.mem.length) this.renderMem();
  }

  /** 通用分隔条拖拽（不用 setPointerCapture：合成的 CDP 事件也能驱动它） */
  _bindGrip(el, { axis, get, apply, min, max, save }){
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startPos = axis === 'x' ? e.clientX : e.clientY;
      const startVal = get();
      if (!startVal) return;
      const box = $('tab-dbg');
      box?.classList.add('gripping');
      const move = (ev) => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos;
        // 往左/往上拖 = 变大（分隔条在目标的下/右侧）
        const next = Math.max(min(), Math.min(max(), startVal - delta));
        apply(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        box?.classList.remove('gripping');
        save(get());
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /**
   * 后端换了就**换 session 对象**（ARM/Cortex-M 与 RISC-V 的硬件访问完全不同，
   * 但源码级那一层是同一套 —— `RiscvDebugSession` 继承 `DebugSession` 只换低层）。
   * 换之前先把旧连接断干净，别让两个后端抢同一支探针。
   * @returns {boolean} 是否真的换了对象
   */
  async _ensureSession(riscv, { preserveAcquisition = false } = {}){
    if (riscv === (this.session instanceof RiscvDebugSession)) return false;
    if (this.session?.connected) await this.disconnect({ preserveAcquisition });
    if (riscv === (this.session instanceof RiscvDebugSession)) return false;
    this.session = riscv ? new RiscvDebugSession() : new DebugSession();
    this._bindSessionLog();
    this.session.sym = this.sym || null;
    return true;
  }

  async _syncBackend(){
    const v = $('d-backend')?.value || 'webusb';
    const mock = v === 'mock';
    const riscv = v === 'riscv';
    await this._ensureSession(riscv);
    const clk = $('d-clock');
    if (clk){
      clk.disabled = mock;
      // RISC-V 那条路的时钟是 **JTAG TCK**（DAP_SWJ_Clock），名字要说清楚
      const lab = clk.previousElementSibling;
      if (lab && /时钟/.test(lab.textContent || '')) lab.textContent = riscv ? 'JTAG 时钟' : 'SWD 时钟';
    }
    const hint = $('d-elf-info');
    if (hint && !this.sym) hint.textContent = mock
      ? '未载入 ELF · 模拟目标'
      : (riscv
        ? '未载入 ELF · RISC-V/JTAG'
        : '未载入 ELF（符号、源码与变量）');
  }

  _syncButtons(connected, halted){
    this.faultPanel?.sync();
    if(!this.session.connected || !this.session.halted || (this._btSnapshotValid && this.session.pc!==this._btSnapshotPc)) this._invalidateBacktrace();
    const c = connected ?? this.session.connected;
    const h = halted ?? this.session.halted;
    for (const id of ['d-cont', 'd-step', 'd-halt', 'd-mem-read']){
      const el = $(id);
      if (el) el.disabled = !c;
    }
    const step = $('d-step');
    if (step) step.disabled = !c || !h;            // 运行中不能单步
    /** 源码级单步同一套规则：连接 + 已停止才能点（它们要读 PC/LR 与行号表） */
    for (const id of ['d-step-over', 'd-step-into', 'd-step-out']){
      const el = $(id);
      if (el) el.disabled = !c || !h;
    }
    const haltBtn = $('d-halt');
    if (haltBtn) haltBtn.disabled = !c || h;
    const cont = $('d-cont');
    if (cont) cont.disabled = !c || !h;
    for (const id of ['d-connect']) { const el = $(id); if (el) el.disabled = c; }
    for (const id of ['d-disconnect', 'd-reset-halt', 'd-reset-run', 'd-rtt-locate', 'd-wp-add', 'd-wp-clear', 'd-bt', 'd-bt-scan']){ const el = $(id); if (el) el.disabled = !c; }
    for(const id of ['d-bt','d-bt-scan']){ const el=$(id); if(el) el.disabled=!c||!h; }
    setFlag($('d-state'), !c ? '未连接' : (h ? '已停止' : '运行中'), !c ? null : (h ? 'warn' : 'on'));
  }

  // ================================================================ 连接

  async connect(){
    if (this._connecting || this._disconnecting) return false;
    const generation = this._connectionGen = (this._connectionGen || 0) + 1;
    this._connecting = true;
    try {
      return await runProbeOperation(this, 'dbg', () => this._connectNow(generation), {
        mock: $('d-backend')?.value === 'mock', reason: '调试器要使用探针', recovery: true,
      });
    } catch (e){ this._out('✗ 连接失败：' + e.message, 'err'); toast(e.message, 'err'); return false; }
    finally { this._connecting = false; this._connectionTask = null; }
  }

  async _connectNow(generation = this._connectionGen = (this._connectionGen || 0) + 1){
    const backend = $('d-backend')?.value || 'webusb';
    const mock = backend === 'mock';
    const riscv = backend === 'riscv';
    /**
     * 换后端 = 换一个 session 对象（ARM/Cortex-M 与 RISC-V 的硬件访问完全不同，
     * 但源码级那一层是同一套 —— `RiscvDebugSession` 继承 `DebugSession` 只换低层）。
     * 正常路径上 `_syncBackend()` 已经换过了，这里再兜一次（幂等）。
     */
    await this._ensureSession(riscv, { preserveAcquisition: true });
    if (this._disconnecting || generation !== this._connectionGen) return false;
    const clockKhz = Number($('d-clock')?.value) || DEFAULT_CLOCK_KHZ;
    this._out('', 'dim');
    this._out(`──── 连接（${mock ? '模拟目标' : riscv ? 'RISC-V/JTAG' : 'WebUSB'}${mock ? '' : ` · ${clockKhz} kHz`}）────`, 'dim');
    if (this.clockMigrated){ this._out('（SWD 时钟默认值已从 1 MHz 改为 10 MHz —— 真机实测 PPB/内存都正常；不想要就在上面改回去）', 'dim'); this.clockMigrated = false; }
    try {
      if (!mock) await prepareProbeHandoff(this, 'dbg', '调试器要使用探针');
      if (this._disconnecting || generation !== this._connectionGen) return false;
      this._connectionTask = this.session.exclusive(() => this.session.connect({
        mock, clockKhz, bus: null, stopBridge: false,
      }));
      await this._connectionTask;
      if (this._disconnecting || generation !== this._connectionGen) return false;
    } catch (e){
      this._out('✗ 连接失败：' + (e?.message || e), 'err');
      toast('连接失败：' + (e?.message || e), 'err', 7000);
      return false;
    }
    /**
     * 连接时 session 会做一次"这个时钟能不能读 PPB"的健康检查，不合格就自动退回 1 MHz ——
     * 下拉框得跟着改，否则界面显示的档位和实际用的不一致（用户会以为寄存器坏了）。
     */
    const nowKhz = Math.round((this.session.clockHz || 0) / 1000);
    if (nowKhz && nowKhz !== clockKhz){
      const clk = $('d-clock');
      if (clk){ ensureSelectOption(clk, String(nowKhz), nowKhz + ' kHz'); clk.value = String(nowKhz); store.set('dbg.clock', clk.value); }
      this._out(`（实际用的是 SWD ${nowKhz} kHz —— 上面那格已同步）`, 'warn');
    }
    await this.session.exclusive(() => this.refreshAll());
    this._syncButtons(true);
    this.renderBps();
    this._out(`目标${this.session.halted ? '处于停止状态' : '正在运行'}`, 'dim');
    if ($('d-rtt-on')?.checked) this.rttStart().catch(() => {});
    else if (!this.session.halted) this._startWatch();
    return true;
  }

  async disconnect({ preserveAcquisition = false } = {}){
    if (!preserveAcquisition) this.probeManager?.cancel('dbg');
    if (!preserveAcquisition) this._connectionGen = (this._connectionGen || 0) + 1;
    if (this._disconnectPromise) return await this._disconnectPromise;
    this._disconnecting = true;
    this.cancelFlag = true;
    this.queue = [];
    this._disconnectPromise = this._disconnectNow();
    try {
      const result = await this._disconnectPromise;
      if (!preserveAcquisition) this.probeManager?.forget('dbg');
      return result;
    } catch (e){
      this.probeManager?.fail('dbg', e);
      throw e;
    }
    finally {
      this._disconnectPromise = null; this._disconnecting = false;
    }
  }

  async _disconnectNow(){
    this._stopWatch();
    this.rttStop();
    if (this._connectionTask) await this._connectionTask.catch(() => {});
    await this.session.exclusive(async () => { await this.faultPanel?.restoreCatchLocked(); await this.session.disconnect(); });
    // 符号表**故意留着**：断开往往只是为了让别的页签用探针，重连后还得接着看变量
    this.mem = new Uint8Array(0);
    this.renderRegs(); this.renderMem(); this.renderBps();
    this._syncButtons(false);
    const info = $('d-elf-info');
    if (info && this.sym) info.textContent = `已断开（符号表还在：${this.sym.summary()}）`;
    else if (info) info.textContent = '已断开。';
  }

  /** 一次用户动作的统一包装：忙碌标记 + **独占 SWD** + 错误回显（别让异常静默消失） */
  async _act(name, fn){
    if (this._disconnecting || this._connecting) return false;
    this._followOut();
    if (this.session.busy){ this._out(`（正在忙，先等上一个动作跑完）`, 'warn'); return false; }
    this._invalidateBacktrace();
    if (/继续|暂停|复位|单步|跳过|进入|跳出|运行到|^写/.test(name)) this.faultPanel?.invalidate('目标控制或写入操作，现场转为历史记录');
    this.session.busy = true;
    try {
      // 🚨 整段动作要独占 SWD：观察循环/ RTT 泵随时可能在读，交错一次就读出垃圾（真机实测 18%）
      await this.session.exclusive(fn);
      return true;
    }
    catch (e){
      this._out(`✗ ${name}失败：${e?.message || e}`, 'err');
      toast(`${name}失败：${e?.message || e}`, 'err', 6000);
      return false;
    } finally {
      this.session.busy = false;
      this._syncButtons();
      this._followOut();
    }
  }

  // ================================================================ 刷新显示

  async refreshAll(){
    await this.session.refresh();
    if (this.session.halted) await this.session.refreshRegs();
    const diagnosis = this.session.halted ? await this.faultPanel?.afterStopLocked() : null;
    this.renderRegs();
    if (!diagnosis?.error) await this._readMemLocked({ silent: true, auto: true });
    this.renderBps();
    this._syncButtons(true);
    const cap = $('d-bp-cap');
    if (cap) cap.textContent = this.session.bpCapacity
      ? `硬件断点上限 ${this.session.bpCapacity} 个（FPB rev${this.session.caps.rev}）—— 命令 b <地址|符号> 添加，点列表里的 × 删除`
      : '这颗内核没报告可用的 FPB 比较器（读 FP_CTRL 说 0 个）';
    if (this.session.halted && !diagnosis?.error) await this.afterStop();
    else this._updatePcStrip();
    return true;
  }

  /** 目标停下来之后要刷新的东西：PC 落点、源码行、监视值（三处一起，别漏） */
  async afterStop(){
    const diagnosis = await this.faultPanel?.afterStopLocked();
    this._updatePcStrip();
    if (diagnosis?.error) return;
    await this._refreshWatchLocked();
    await this.renderSource();
  }

  /**
   * PC 条：`main.c:192 +0x4  main+0x1c`。
   *
   * 🚨 **`+0x4` 那一段是"精准位置"的关键**：一个源码行通常对应好几条指令，
   *    停在这一行的中间（不是行首）时，MDK/Ozone 靠反汇编显示"到底停在哪条指令"。
   *    我们不做反汇编视图，但至少要把"离行首还有几个字节"如实说出来 ——
   *    否则用户会以为单步落点飘了（其实是这一行有多个语句/多条指令）。
   */
  _updatePcStrip(){
    const pc = this.session.pc >>> 0;
    const a = pc & 0xfffffffe;
    const f = this.sym?.funcAt?.(a);
    const loc = this.sym?.locText?.(a) || '';
    const row = this.sym?.at?.(a);
    const inLine = row && typeof row.addr === 'number' ? (a - row.addr) >>> 0 : 0;
    const lineTag = row?.line ? `${loc}${inLine ? ` +0x${inLine.toString(16)}` : ''}` : loc;
    const pos = $('d-src-pos');
    if (pos) pos.textContent = lineTag ? `${lineTag}${f ? `  ${f.name}+0x${f.off.toString(16)}` : ''}` : (f ? `${f.name}+0x${f.off.toString(16)}` : '—');
    const leg = $('d-src-file');
    if (leg) leg.textContent = lineTag ? `${lineTag}${f ? ` · ${f.name}+0x${f.off.toString(16)}` : ''}` : (this.sym ? '（PC 不在有行号信息的代码里）' : '—');
  }

  renderRegs(){
    const box = $('d-regs');
    if (!box) return;
    const list = this.session.regList();
    if (!list.length){
      box.textContent = '';
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = this.session.connected ? '（还没有读到寄存器）' : '（未连接）';
      box.appendChild(d);
      return;
    }
    // 行数固定 = 21：复用已有节点，避免每次刷新重建 DOM（也保住用户正在编辑的输入框）
    if (box.children.length !== list.length || box.dataset.built !== '1'){
      box.textContent = '';
      box.dataset.built = '1';
      for (const r of list){
        const row = document.createElement('div');
        row.className = 'regrow';
        const nm = document.createElement('span'); nm.className = 'rn'; nm.textContent = r.name;
        const inp = document.createElement('input'); inp.className = 'rv mono'; inp.spellcheck = false;
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter'){ e.preventDefault(); this._writeRegInput(r.name, inp); }
          else if (e.key === 'Escape'){ e.preventDefault(); inp.value = this._regText(r.name); inp.blur(); }
        });
        const note = document.createElement('span'); note.className = 'note';
        row.append(nm, inp, note);
        box.appendChild(row);
      }
    }
    list.forEach((r, i) => {
      const row = box.children[i];
      if (!row) return;
      const inp = row.querySelector('input');
      const note = row.querySelector('.note');
      if (inp && document.activeElement !== inp) inp.value = hex32(r.value);
      row.classList.toggle('chg', !!r.changed);
      if (note){
        let extra = '';
        if (regIs(r.name, 'PC') || regIs(r.name, 'LR')){
          const f = this.sym?.funcAt?.(r.value & 0xfffffffe);
          const loc = this.sym?.locText?.(r.value & 0xfffffffe) || '';
          if (f) extra = `→ ${f.name}+0x${f.off.toString(16)}${f.exact ? '' : '(?)'}${loc ? '  ' + loc : ''}`;
          else if (r.value >= 0x1fff0000 && r.value < 0x20000000) extra = '⚠ ROM bootloader';
        } else if (r.name === 'XPSR') extra = this._xpsrText(r.value);
        else if (r.kind === 'cfbp' && r.name === 'CONTROL') extra = (r.value & 1) ? '非特权' : '特权';
        else if (r.kind === 'cfbp' && r.name === 'BASEPRI' && r.value) extra = `≥${r.value >> 4}`;
        note.textContent = extra;
      }
      row.title = r.note || '';
    });
    const pcRow = $('d-pc');
    if (pcRow){
      const pc = list.find(r => regIs(r.name, 'PC'))?.value || 0;
      const f = this.sym?.funcAt?.(pc & 0xfffffffe);
      pcRow.textContent = `PC ${hex32(pc)}${f ? ' ' + f.name + '+0x' + f.off.toString(16) : ''}`;
    }
  }

  _xpsrText(v){
    const n = (v >>> 31) & 1, z = (v >>> 30) & 1, c = (v >>> 29) & 1, vf = (v >>> 28) & 1, q = (v >>> 27) & 1;
    const isr = v & 0x1ff;
    return `N${n} Z${z} C${c} V${vf} Q${q} ${isr ? 'Handler#' + isr : 'Thread'}`;
  }

  _regText(name){
    const r = this.session.regList().find(x => x.name === name);
    return hex32(r?.value || 0);
  }

  async _writeRegInput(name, inp){
    const v = parseNumSafe(inp.value);
    if (v === null){ this._out(`✗ 认不出数值：「${inp.value}」`, 'err'); inp.value = this._regText(name); return; }
    await this._act(`写 ${name}`, async () => {
      await this.session.writeReg(name, v);
      await this.session.refreshRegs();
      this.renderRegs();
      this._out(`${name} ← ${hex32(v)}`, 'ok');
      if (regIs(name, 'PC')) await this._followPc();
    });
  }

  _invalidateBacktrace(){
    this.session.clearFrames?.();
    const locals=$('d-locals');if(locals)locals.textContent='暂停后回溯，再选择栈帧';
    if(!this._btSnapshotValid) return;
    this._btSnapshotValid=false;
    const box=$('d-bt-list'); if(box) box.textContent='目标状态已变化，请重新回溯';
    const status=$('d-bt-status'); if(status) status.textContent='';
  }

  presentBacktrace(result){
    const box=$('d-bt-list'); if(!box) return;
    box.textContent='';
    const locals=$('d-locals');if(locals)locals.textContent=result.scan?'候选地址没有可靠帧上下文，不能读取局部变量':result.frames[0]?.regs?'正在读取当前帧变量…':'当前架构或 ELF 没有可靠的栈帧上下文';
    this._btSnapshotPc=this.session.pc; this._btSnapshotValid=true;
    for(const [i,frame] of result.frames.entries()){
      const row=document.createElement('button'); row.className='mono';
      const loc=frame.loc;
      row.textContent=`#${i} ${frame.name||hex32(frame.pc)} [${frame.kind}]${loc?' '+loc.file+':'+loc.line:''}`;
      row.title=`PC ${hex32(frame.pc)} · SP ${hex32(frame.sp)}`;
      row.disabled=frame.kind==='candidate'&&!loc;row.dataset.frame=String(i);
      if(!result.scan)row.setAttribute('aria-pressed',String(i===0));
      row.addEventListener('click',()=>result.scan?this.showSource(loc.file,loc.line):this.runLine(`frame ${i}`));
      const wrap=document.createElement('div'); wrap.className='bprow'; wrap.append(row); box.append(wrap);
    }
    const status=$('d-bt-status'); if(status) status.textContent=result.reason;
  }

  async presentSelectedFrame(index,frame){
    const box=$('d-bt-list');
    for(const row of box?.querySelectorAll('[data-frame]')||[])row.setAttribute('aria-pressed',String(Number(row.dataset.frame)===index));
    if(frame.loc)await this.showSource(frame.loc.file,frame.loc.line);
  }

  presentLocals(result,index=0){
    const box=$('d-locals');if(!box)return;box.textContent='';
    const title=document.createElement('div');title.className='hint';title.textContent=`帧 #${index} · ${result.function||''}`;box.append(title);
    for(const row of result.rows){
      const item=document.createElement(row.children?'details':'div');item.className='mono';
      const label=document.createElement(row.children?'summary':'span');
      label.textContent=`${row.argument?'参数':'局部'} ${row.name}: ${row.type?.alias||row.type?.name||row.type?.kind||'?'} = ${row.error||row.value}`;
      item.append(label);
      for(const child of row.children||[]){const line=document.createElement('div');line.style.paddingLeft=`${(child.depth+1)*12}px`;line.textContent=`${child.name} = ${child.text}`;item.append(line);}
      box.append(item);
    }
    if(result.reason){const hint=document.createElement('div');hint.className='hint';hint.textContent=result.reason;box.append(hint);}
  }

  renderDwt(){
    const box=$('d-wp-list'); if(!box) return;
    box.textContent='';
    for(const item of this.session.dwt.items){
      const row=document.createElement('div'); row.className='bprow';
      const text=document.createElement('span'); text.className='mono';
      text.textContent=`#${item.slot+1} ${hex32(item.addr)} ${item.size} B ${item.mode}`;
      const del=document.createElement('button'); del.textContent='×'; del.title='删除数据观察点';
      del.addEventListener('click',()=>this.runLine(`wpd ${item.slot+1}`)); row.append(text,del); box.append(row);
    }
    if(!this.session.dwt.items.length) box.textContent='尚无数据观察点';
  }

  renderBps(){
    this.renderDwt();
    const box = $('d-bp-list');
    if (!box) return;
    box.textContent = '';
    const list = this.session.bpList();
    if (!list.length){
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = '还没有断点（命令 b main / b 0x08000123，或点源码行号）';
      box.appendChild(d);
      return;
    }
    list.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'bprow';
      const t = document.createElement('span');
      t.className = 'mono';
      const loc = b.addr ? this.sym?.locText?.(b.addr) : '';
      t.textContent = `#${i + 1} ${hex32(b.addr)}${b.sym ? ' ' + b.sym : ''}${loc ? '  ' + loc : ''}`;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '删掉这个断点';
      del.addEventListener('click', () => this._act('删断点', async () => { await this.session.bpDel(b.addr); this.renderBps(); this.renderSource(); }));
      row.append(t, del);
      box.appendChild(row);
    });
  }

  // ================================================================ 内存

  async readMem(opts = {}){
    if (this._disconnecting || this._connecting) return false;
    return await this.session.exclusive(() => this._disconnecting ? false : this._readMemLocked(opts));
  }

  async _readMemLocked({ silent = false, auto = false } = {}){
    if (!auto) this._memAddrStale = false;      // 明确要读（按钮/回车）就一律放行
    if (auto && this._memAddrStale){
      this.mem = new Uint8Array(0);
      this.renderMem('上限一次会话留下的地址不属于当前 ELF —— 已停用自动读取（改地址或点「读」即可）');
      return false;
    }
    const addr = parseNumSafe($('d-mem-addr')?.value) ?? 0;
    let len = parseNumSafe($('d-mem-len')?.value) ?? 128;
    if (len < 1) len = 1;
    if (len > 1024) len = 1024;
    this.memAddr = addr >>> 0;
    if (!this.session.connected){
      this.mem = new Uint8Array(0);
      this.renderMem('未连接');
      return false;
    }
    try {
      this.mem = await this.session.memRead(this.memAddr, len);
      this.renderMem();
      return true;
    } catch (e){
      this.mem = new Uint8Array(0);
      this.renderMem('读失败：' + (e?.message || e));
      if (!silent) this._out('✗ 读内存失败：' + (e?.message || e), 'err');
      return false;
    }
  }

  renderMem(errText){
    const box = $('d-mem');
    if (!box) return;
    box.textContent = '';
    if (errText || !this.mem.length){
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = errText || '（没有数据：点「读」）';
      box.appendChild(d);
      return;
    }
    const writable = !!$('d-mem-write-on')?.checked;
    /**
     * 一行几个字节按面板宽度算：右侧面板只有 ~380px 时，16 字节的 hexdump 会横向溢出
     * （地址 9 字符 + 16×19px 格子 + ASCII 列 ≈ 640px）。宽度不够就一行 8 个。
     * 量不到宽度（面板还藏着）时按 16 走 —— 切到「内存」tab 时 `_dockSelect()` 会重画一次。
     */
    const avail = box.clientWidth || 0;
    const width = avail && avail < 560 ? 8 : 16;
    for (let i = 0; i < this.mem.length; i += width){
      const row = document.createElement('div');
      row.className = 'hxrow';
      const a = document.createElement('span');
      a.className = 'hxa';
      a.textContent = hex32((this.memAddr + i) >>> 0);
      row.appendChild(a);
      for (let k = 0; k < width; k++){
        const idx = i + k;
        const cell = document.createElement('span');
        cell.className = 'by' + (writable ? ' w' : '');
        if (idx < this.mem.length){
          cell.textContent = this.mem[idx].toString(16).padStart(2, '0');
          cell.dataset.a = String((this.memAddr + idx) >>> 0);
          if (writable) cell.addEventListener('click', () => this._pickByte(cell.dataset.a, cell.textContent));
        } else cell.textContent = '  ';
        if (k === width / 2 - 1) row.appendChild(sep());
        row.appendChild(cell);
      }
      const asc = document.createElement('span');
      asc.className = 'asc';
      let t = '';
      for (let k = 0; k < width && i + k < this.mem.length; k++){
        const b = this.mem[i + k];
        t += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.';
      }
      asc.textContent = '|' + t + '|';
      row.appendChild(asc);
      box.appendChild(row);
    }
  }

  _pickByte(addr, val){
    const a = $('d-mem-ea'), v = $('d-mem-ev');
    if (a) a.value = '0x' + (Number(addr) >>> 0).toString(16).toUpperCase();
    if (v){ v.value = val.trim().toUpperCase(); v.focus(); v.select?.(); }
    this._memEditAddr = Number(addr) >>> 0;
  }

  async writeMemEdit(){
    const addr = this._memEditAddr ?? parseNumSafe($('d-mem-ea')?.value);
    if (addr === null || addr === undefined){ this._out('✗ 先给个地址（或点上面 dump 里的某个字节）', 'err'); return false; }
    let bytes;
    try { bytes = parseBytes($('d-mem-ev')?.value || ''); }
    catch (e){ this._out('✗ ' + e.message, 'err'); return false; }
    if (!bytes.length){ this._out('✗ 没给出要写的字节', 'err'); return false; }
    return await this._act('写内存', async () => {
      await this.session.memWrite(addr, bytes);
      const back = await this.session.memRead(addr, bytes.length);
      const same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
      this._out(`写 ${hex32(addr)} ← ${[...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ')}${same ? '（回读一致）' : '（⚠ 回读不一致）'}`, same ? 'ok' : 'err');
      await this._readMemLocked({ silent: true, auto: true });
    });
  }

  /** 内存窗口跟随 PC（在栈/在别处都能立刻看到现场） */
  async _followPc(){
    const fp = $('d-follow-pc');
    if (!fp?.checked) return;
    this._memAddrStale = false;                       // 跟着 PC 走的是当前 ELF 里的地址，重新放行自动读
    const pc = this.session.regList().find(r => regIs(r.name, 'PC'))?.value;
    if (pc === undefined) return;
    const base = (pc & ~0xf) >>> 0;
    const ma = $('d-mem-addr');
    if (ma) ma.value = hex32(base);
    store.set('dbg.memAddr', hex32(base));          // 跟着存的也要跟着走，否则刷新后又跳回老地址
    this._memEditAddr = null;
    await this._readMemLocked({ silent: true });
  }

  // ================================================================ 命令行

  /** 键盘：Tab 补全 / Ctrl+C 中断 / Ctrl+L 清屏 / Ctrl+A·E·U·K·W 行编辑（xshell 那套） */
  _cmdKey(e){
    const cmd = e.currentTarget;
    if (e.key === 'Enter'){ e.preventDefault(); const v = cmd.value; cmd.value = ''; this.runLine(v); return; }
    if (e.key === 'Tab'){ e.preventDefault(); this._complete(cmd); return; }
    if (e.key === 'ArrowUp'){ e.preventDefault(); this._hist(-1); return; }
    if (e.key === 'ArrowDown'){ e.preventDefault(); this._hist(1); return; }
    if (e.key === 'Escape'){ e.preventDefault(); cmd.value = ''; return; }
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const pos = cmd.selectionStart ?? cmd.value.length;
    const setPos = (v, p) => { cmd.value = v; cmd.setSelectionRange(p, p); };
    if (k === 'c'){
      if (window.getSelection && String(window.getSelection()).length) return;   // 有选中文字 = 复制，不抢
      e.preventDefault();
      this.cancelFlag = true;
      this._stopWatch();
      this.queue = [];
      cmd.value = '';
      this._out('^C', 'warn');
      return;
    }
    if (k === 'l'){ e.preventDefault(); this._clearOut(); return; }
    if (k === 'a'){ e.preventDefault(); cmd.setSelectionRange(0, 0); return; }
    if (k === 'e'){ e.preventDefault(); cmd.setSelectionRange(cmd.value.length, cmd.value.length); return; }
    if (k === 'u'){ e.preventDefault(); setPos(cmd.value.slice(pos), 0); return; }
    if (k === 'k'){ e.preventDefault(); setPos(cmd.value.slice(0, pos), pos); return; }
    if (k === 'w'){
      e.preventDefault();
      const head = cmd.value.slice(0, pos).replace(/[^\s]*\s*$/, '');
      setPos(head + cmd.value.slice(pos), head.length);
      return;
    }
  }

  /** 粘贴多行 → 排队一条条跑（终端里粘一段脚本的用法） */
  _cmdPaste(e){
    const text = e.clipboardData?.getData('text') || '';
    if (!text.includes('\n')) return;                    // 单行交给浏览器默认行为
    e.preventDefault();
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const cmd = e.currentTarget;
    this.queue.push(...lines);
    cmd.value = '';
    this._out(`（粘贴了 ${lines.length} 行，排队执行）`, 'dim');
    this._drainQueue();
  }

  async _drainQueue(){
    if (this.runningQueue) return;
    this.runningQueue = true;
    try {
      while (this.queue.length && !this.cancelFlag){
        const line = this.queue.shift();
        await this.runLine(line);
      }
      if (this.cancelFlag && this.queue.length){ this._out(`（已中断，丢弃剩余 ${this.queue.length} 行）`, 'warn'); this.queue = []; }
    } finally { this.runningQueue = false; }
  }

  _complete(cmd){
    const ctx = {
      sym: this.sym,
      regs: this.session.regList().map(r => r.name.toLowerCase()),
      bps: this.session.bps,
      wps: this.session.dwt.items,
      files: this.sym?.lines?.paths || [],
      watch: this.watch.items,
    };
    let r;
    try { r = completeLine(cmd.value, ctx); } catch { return; }
    if (!r.total) return;
    if (r.total === 1 || r.value !== cmd.value){
      cmd.value = r.value;
      cmd.setSelectionRange(cmd.value.length, cmd.value.length);
      return;                                            // 补出了唯一候选/更长的公共前缀：先别刷屏
    }
    this._out(r.candidates.join('  '), 'dim');
  }

  _fillCmd(text){
    const cmd = $('d-cmd');
    if (!cmd) return;
    cmd.value = text;
    cmd.focus();
    cmd.setSelectionRange(cmd.value.length, cmd.value.length);
  }

  _hist(dir){
    const cmd = $('d-cmd');
    if (!cmd || !this.hist.length) return;
    this.histIdx = dir < 0
      ? (this.histIdx < 0 ? this.hist.length - 1 : Math.max(0, this.histIdx - 1))
      : (this.histIdx < 0 ? -1 : Math.min(this.hist.length, this.histIdx + 1));
    cmd.value = this.histIdx < 0 || this.histIdx >= this.hist.length ? '' : this.hist[this.histIdx];
    cmd.setSelectionRange(cmd.value.length, cmd.value.length);
  }

  async runLine(text){
    const line = String(text || '').trim();
    if (!line) return { lines: [] };
    if (this._disconnecting || this._connecting) return { cancelled: true, lines: [] };
    this._followOut();
    if(!/^(frame|locals|args|info)(\s|$)/i.test(line)) this._invalidateBacktrace();
    if (/^(c|cont|continue|g|s|step|n|next|si|fin|finish|out|rc|runto|halt|stop|pause|reset|mw|ms)(\s|$)/i.test(line) || /^(r|reg|regs)\s+\S+\s+\S+/i.test(line))
      this.faultPanel?.invalidate('目标控制或写入命令，现场转为历史记录');
    this._out('> ' + line, 'cmd');
    if (line !== this.hist[this.hist.length - 1]) this.hist.push(line);
    this.histIdx = -1;
    this.cancelFlag = false;
    let res;
    try {
      // 命令也是"一整段独占 SWD"：观察循环 / RTT 泵随时可能在读，交错一次就读出垃圾
      res = await this.session.exclusive(async () => {
        if (this._disconnecting) throw Object.assign(new Error('已中断'), { cancelled: true });
        const result = await runCmd(line, this.session, { view: this, signal: () => this.cancelFlag });
        this.renderRegs(); this.renderBps(); this._syncButtons();
        const changedMem = /^(md|mw|ms|x)$/.test(line.split(/\s+/)[0].toLowerCase());
        if (changedMem) await this._readMemLocked({ silent: true });
        if (this.session.halted) await this.afterStop();
        else this._startWatch();
        return result;
      });
      if (res.clear) this._clearOut();
      for (const l of res.lines || []) this._out(l.t, l.c || '');
      return res;
    } catch (e){
      if (e?.cancelled){ this._out('（已中断）', 'warn'); return { cancelled: true, lines: [] }; }
      if(/^栈帧已失效/.test(e?.message||''))this._invalidateBacktrace();
      this._out('✗ ' + (e?.message || e), 'err');
      return { error: String(e?.message || e) };
    } finally {
      // 结果批量追加期间的 scroll 事件可能暂停跟随；命令结束后明确显示最终结果。
      this._followOut();
    }
  }

  _out(text, cls = ''){
    const el = $('d-out');
    if (!el) return;
    if (cls === 'cmd'){ appendLogLine(el, text, 'cmdecho', 800); return; }
    appendLogLine(el, text, cls || 'dim', 800);
  }
  _clearOut(){ const el = $('d-out'); if (el) el.textContent = ''; }

  /** 用户主动执行命令/点击动作时回到最新输出；翻看历史时仍可暂停后台日志跟随。 */
  _followOut(){
    const el = $('d-out');
    if (el){ el._stick = true; el.scrollTop = el.scrollHeight; }
  }

  // ================================================================ 目标在跑：轮询等它停下

  /**
   * 「继续」之后目标在跑，要等它命中/停下再刷界面。
   * 🚨 用 waitMs 而不是 setTimeout：页面不可见时短延时会被钳到 ≥1 s，
   *    150 ms 的观察间隔变成 1 s，用户看到的是"点了继续半天不更新"。
   */
  _startWatch(){
    this.faultPanel?.invalidate('目标继续运行，现场转为历史记录');
    this._invalidateBacktrace();
    if (this.watching) return;
    this.watching = true;
    this._watchLoop().catch(() => { this.watching = false; });
  }
  _stopWatch(){ this.watching = false; }

  async _watchLoop(){
    let polls = 0;
    while (this.watching && this.session.connected && !this.session.halted){
      await waitMs(150);
      if (this.cancelFlag || !this.watching || this._disconnecting) break;
      polls++;
      try {
        /**
         * 🚨 后台轮询一律走 `tryExclusive()`：用户动作/脚本正在用 SWD 时**跳过这一拍**。
         *    真机实测：不串行化时观察循环与一次 readReg 撞车，100 次里 18 次读到废值
         *    （0x0 / 0x1 / 0x999…），看起来就是"寄存器表偶发乱码、单步没反应"。
         */
        const r = await this.session.tryExclusive(() => this.session.refresh());
        if (r.skipped) continue;
        if (this.rtt && polls % 2 === 0) await this.session.tryExclusive(() => this._rttPump());
        // 「运行中也刷新」开关（默认关）：直接读 RAM，目标照跑
        if ($('d-watch-live')?.checked && polls % 2 === 0) await this.session.tryExclusive(() => this._refreshWatchLocked());
      } catch (e){
        this._out('✗ 观察目标时出错（继续试）：' + (e?.message || e), 'err');
        await waitMs(600);
      }
      if (this.session.halted){
        // 停住之后的收尾（刷寄存器 / 跟随 PC / 监视值 / 源码行）也在同一把锁里做完，
        // 否则这些 memory 读又会和别的动作交错
        await this.session.tryExclusive(async () => {
          await this.session.refreshRegs();
          this.renderRegs();
          const diagnosis = await this.faultPanel?.afterStopLocked();
          if (diagnosis?.error){ this._updatePcStrip(); return; }
          const pc = this.session.pc >>> 0;
          const f = this.sym?.funcAt?.(pc & 0xfffffffe);
          const atBp = this.session.bps.some(b => (b & 0xfffffffe) === (pc & 0xfffffffe));
          const loc = this.sym?.locText?.(pc & 0xfffffffe) || '';
          const tail = `${loc ? ' ' + loc : ''}${f ? ' (' + f.name + '+0x' + f.off.toString(16) + ')' : ''}`;
          const dwtReason=await this.session.dwt.haltReason().catch(()=>null);
          if(dwtReason) this._out('⏹ '+dwtReason,'ok');
          this._out(atBp ? `⏹ 命中断点 @ ${hex32(pc)}${tail}` : `⏹ 目标已停止 @ ${hex32(pc)}${tail}`, atBp ? 'ok' : 'warn');
          await this._followPc();
          await this.afterStop();
        });
      }
    }
    this.watching = false;
    this._syncButtons();
  }

  // ================================================================ ELF 符号

  async _loadElfFile(file){
    if (!file) return false;
    try {
      const buf = await file.arrayBuffer();
      return this.loadElfBuffer(buf, file.name);
    } catch (e){
      this._out('✗ 读文件失败：' + (e?.message || e), 'err');
      return false;
    }
  }

  /** 供自测直接喂 ArrayBuffer（页面里也能用 fetch 拿到 fixture） */
  loadElfBuffer(buf, name = '') {
    this._invalidateBacktrace();
    try {
      const st = SymTab.fromBuffer(buf);
      this.sym = st;
      this.session.sym = st;
      this.elfName = name;
      this.faultPanel?.invalidate('ELF 已变更，源码关联保留为历史记录');
      this._retireStaleMemAddr(st);
      /**
       * 把 ELF 的路径列表交给源码仓：如果已经选过目录，就**按这份列表按需索引**
       * （只对 ELF 引用到的文件做 getFileHandle，不遍历目录树 —— 选 `hpm_sdk` 那种
       *  33000+ 文件的目录也不用等）。索引完再刷一次建议行，报"能解析几个"。
       */
      Promise.resolve(this.src?.setExpectedPaths?.(st.lines?.paths || []))
        .then(s => { if (this.sym === st && this.src?.ready) this._out('源码：' + s, 'ok'); })
        .catch(() => {})
        .finally(() => this._renderSrcSuggest());
      const info = st.summary();
      const el = $('d-elf-info');
      if (el) el.textContent = `${name || 'ELF'}：${info}`;
      this._out(`已载入符号：${name || 'ELF'} —— ${info}`, st.note ? 'warn' : 'ok');
      if (st.lines) this._out(`　${st.lines.summary()}`, 'dim');
      // 监视项重新解析一遍（换了 ELF 之后地址/类型都可能变）
      for (const it of this.watch.items) Object.assign(it, resolveWatch(it.expr, st), { value: null });
      this.renderRegs(); this.renderBps(); this.renderSyms(); this.renderWatch();
      this._renderRttSym();
      this._updatePcStrip();
      this.renderSource();
      this._renderSrcSuggest();          // 载入就能说"该选哪个源码目录"（DWARF 里存的是编译路径）
      return st;
    } catch (e){
      this._out('✗ 解析 ELF 失败：' + (e?.message || e), 'err');
      toast('解析 ELF 失败：' + (e?.message || e), 'err', 6000);
      return null;
    }
  }

  /**
   * 载入新 ELF 时"退役"上一块板子留下的内存页地址。
   *
   * 🚨 2026-10 真机现场（HPM6800EVK + tcpecho，用户路径 b main → 复位并停 → c）：
   *    localStorage 里还留着上一块 ARM 板的内存页地址 `0x0800_0300`，在这颗芯片上**没映射**；
   *    自动刷新一读它 → SBA 报错 → 触发自愈（清位 → 复位 DM）→ 用户紧接着按「继续」，
   *    抽象命令（读 dcsr）就撞上 `cmderr=4`。所以：**自动刷新只碰当前 ELF 覆盖得到的地址**，
   *    手动输入的地址一律照读（用户就是想看那儿）。
   */
  _retireStaleMemAddr(st){
    const ma = $('d-mem-addr');
    if (!ma || typeof st?.covers !== 'function') return;
    const a = parseNumSafe(ma.value);
    const len = Math.max(1, Math.min(1024, parseNumSafe($('d-mem-len')?.value) ?? 128));
    if (a === null || st.covers(a, len)){ this._memAddrStale = false; return; }
    this._memAddrStale = true;
    this._out(`内存窗口里的 ${hex32(a)} 不属于当前 ELF —— 已停用它的自动读取（要看就改地址，或手动点「读」）`, 'warn');
  }

  // ================================================================ SVD 寄存器

  async _loadSvdFile(file){
    if (!file) return false;
    try {
      const text = await file.text();
      return this.loadSvdText(text, file.name || 'SVD');
    } catch (e){
      this._out('✗ 读取 SVD 失败：' + (e?.message || e), 'err');
      toast('读取 SVD 失败：' + (e?.message || e), 'err', 6000);
      return false;
    }
  }

  /** 供页面自测和「内置 F103」按钮使用；用户选择的任意 .svd 也走同一入口。 */
  async loadBundledSvd(){
    try {
      // GitHub Pages 以仓库名作为站点前缀（/web-serial-rtt-tools/），不能从域名根目录取文件。
      // 以当前 ES 模块为基准后，本地 127.0.0.1 和项目站点都会落到同一个 SVD 文件。
      const url = new URL('./svd/STM32F103xx.svd?t=' + Date.now(), import.meta.url);
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return this.loadSvdText(await r.text(), 'STM32F103xx.svd（内置）');
    } catch (e){
      this._out('✗ 载入内置 F103 SVD 失败：' + (e?.message || e), 'err');
      toast('载入内置 F103 SVD 失败：' + (e?.message || e), 'err', 6000);
      return false;
    }
  }

  loadSvdText(text, name = 'SVD'){
    try {
      const model = parseSvdXml(text);
      this.svd = model;
      this.svdName = String(name || 'SVD');
      this.svdRaw = String(text || '');
      const info = $('d-svd-info');
      if (info) info.textContent = `${this.svdName} · ${svdSummary(model)}`;
      this._out(`已载入 SVD：${this.svdName} —— ${svdSummary(model)}`, 'ok');
      this._renderSvdPeripherals();
      return model;
    } catch (e){
      this.svd = null; this.svdRaw = null;
      this._renderSvdPeripherals();
      this._out('✗ 解析 SVD 失败：' + (e?.message || e), 'err');
      toast('解析 SVD 失败：' + (e?.message || e), 'err', 6000);
      return null;
    }
  }

  _svdPeripheral(){
    const i = $('d-svd-periph');
    return this.svd?.peripherals?.[Number(i?.value)] || null;
  }

  _svdRegister(){
    const p = this._svdPeripheral(), i = $('d-svd-reg');
    return p?.registers?.[Number(i?.value)] || null;
  }

  _renderSvdPeripherals(){
    const psel = $('d-svd-periph'), rsel = $('d-svd-reg');
    if (!psel || !rsel) return;
    psel.textContent = '';
    if (!this.svd){
      psel.appendChild(new Option('—', ''));
      rsel.textContent = ''; rsel.appendChild(new Option('—', ''));
      const info = $('d-svd-info'); if (info) info.textContent = '尚未载入 SVD';
      this._renderSvdRegister();
      return;
    }
    this.svd.peripherals.forEach((p, i) => {
      const o = new Option(`${p.name} · ${hex32(p.baseAddress)}`, String(i));
      o.title = p.description || p.groupName || p.name;
      psel.appendChild(o);
    });
    psel.value = this.svd.peripherals.length ? '0' : '';
    this._renderSvdRegisters();
    this._renderSvdRegister();
  }

  _renderSvdRegisters(){
    const rsel = $('d-svd-reg');
    if (!rsel) return;
    const p = this._svdPeripheral();
    rsel.textContent = '';
    if (!p){ rsel.appendChild(new Option('—', '')); this._renderSvdRegister(); return; }
    p.registers.forEach((r, i) => {
      const o = new Option(`${r.name} · +0x${r.addressOffset.toString(16).toUpperCase()}`, String(i));
      o.title = r.description || r.name;
      rsel.appendChild(o);
    });
    rsel.value = p.registers.length ? '0' : '';
  }

  _renderSvdRegister(decoded = null){
    const p = this._svdPeripheral(), r = this._svdRegister();
    const info = $('d-svd-reg-info'), value = $('d-svd-value'), fields = $('d-svd-fields');
    if (!p || !r){
      if (info) info.textContent = '载入 SVD 后选择外设和寄存器；读取会使用当前调试会话的 SWD 内存读。';
      if (value) value.textContent = '—';
      if (fields) fields.innerHTML = '<div class="hint">（寄存器位域会显示在这里）</div>';
      return;
    }
    const addr = (p.baseAddress + r.addressOffset) >>> 0;
    if (info) info.textContent = `${p.name}.${r.name}  @  ${hex32(addr)}  · ${r.size} bit · ${r.access || 'read-write'}${r.description ? '\n' + r.description : ''}`;
    if (value) value.textContent = decoded ? `${decoded.valueHex}  （${r.size} bit）` : `复位值 ${'0x' + (r.resetValue >>> 0).toString(16).toUpperCase()}  · 点击「读取」获取目标当前值`;
    if (!fields) return;
    fields.textContent = '';
    if (!r.fields.length){
      const d = document.createElement('div'); d.className = 'hint'; d.textContent = '（该寄存器没有字段描述）'; fields.appendChild(d); return;
    }
    for (const f of r.fields){
      const row = document.createElement('div'); row.className = 'svdfield';
      const n = document.createElement('span'); n.className = 'fn'; n.textContent = f.name; n.title = f.description || f.name;
      const v = document.createElement('span'); v.className = 'fv';
      const got = decoded?.fields?.find(x => x.name === f.name);
      v.textContent = got ? `${got.valueHex}${got.enumName ? ' · ' + got.enumName : ''}` : '—';
      const b = document.createElement('span'); b.className = 'fb'; b.textContent = `[${f.lsb + f.width - 1}:${f.lsb}] ${f.access || ''}`;
      row.append(n, v, b); fields.appendChild(row);
    }
  }

  async _readSvdRegister(){
    const p = this._svdPeripheral(), r = this._svdRegister();
    if (!p || !r) throw new Error('请先载入 SVD 并选择寄存器');
    if (!this.session.connected) throw new Error('还没连接目标');
    const bytes = Math.max(1, Math.min(8, Math.ceil((r.size || 32) / 8)));
    const addr = (p.baseAddress + r.addressOffset) >>> 0;
    const rawBytes = await this.session.memRead(addr, bytes);
    let raw = 0n;
    for (let i = 0; i < rawBytes.length; i++) raw |= BigInt(rawBytes[i]) << BigInt(i * 8);
    this._renderSvdRegister(decodeSvdRegister(r, raw));
    return raw;
  }

  /** 侧栏符号列表（载入 ELF 后一眼看到全局变量） */
  renderSyms(){
    const box = $('d-sym-list');
    if (!box) return;
    if (!this.sym){
      box.textContent = '';
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = '（载入 .elf 后这里列出全局变量/函数；点名字填进命令行，点 ＋ 加监视）';
      box.appendChild(d);
      return;
    }
    const q = $('d-sym-q')?.value || '';
    let r;
    try { r = this.sym.list({ filter: q, limit: 300 }); }
    catch { r = { rows: [], total: 0, truncated: false }; }
    box.textContent = '';
    if (!r.rows.length){
      const d = document.createElement('div');
      d.className = 'hint';
      d.textContent = q ? `没有匹配「${q}」的符号` : '（这份 ELF 里没有数据符号）';
      box.appendChild(d);
      return;
    }
    const frag = document.createDocumentFragment();
    r.rows.forEach((row) => {
      const el = document.createElement('div');
      el.className = 'symrow';
      el.dataset.name = row.name;
      el.title = `${row.name} @ ${hex32(row.addr)}${row.size ? `（${row.size} 字节）` : ''}${row.typeName ? ' : ' + row.typeName : ''}\n点名字 → 填 p ${row.name}；点 ＋ → 加进监视`;
      const add = document.createElement('button');
      add.className = 'mini';
      add.textContent = '＋';
      add.dataset.watch = row.name;
      add.title = '加进监视窗口';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = row.name;
      if (row.kind === 'func') nm.style.color = 'var(--fg2)';
      const ad = document.createElement('span');
      ad.className = 'ad';
      ad.textContent = hex32(row.addr);
      const ty = document.createElement('span');
      ty.className = 'ty';
      ty.textContent = row.scalar || row.typeName || (row.kind === 'func' ? 'fn' : '');
      el.append(add, nm, ad, ty);
      frag.appendChild(el);
    });
    if (r.truncated){
      const more = document.createElement('div');
      more.className = 'symmore';
      more.textContent = `共 ${r.total} 条，只显示前 ${r.rows.length} 条 —— 输入关键字缩小范围`;
      frag.appendChild(more);
    }
    box.appendChild(frag);
  }

  // ================================================================ 监视窗口

  _restoreWatch(){
    const saved = store.get('dbg.watch', null);
    if (Array.isArray(saved) && saved.length) this.watch = WatchList.fromJSON(saved, this.sym);
    this.renderWatch();
  }
  _saveWatch(){ store.set('dbg.watch', this.watch.toJSON()); }

  /** 加一项监视（符号面板的 ＋、侧栏输入框、命令行 `w` 都走这里） */
  addWatch(expr){
    const e = String(expr || '').trim();
    if (!e) return { ok: false, error: '空的' };
    const r = this.watch.add(e, this.sym);
    if (r.dup){ this._out(`（监视里已经有「${e}」了）`, 'warn'); return { ok: true, dup: true, index: r.index }; }
    this._saveWatch();
    this.renderWatch();
    if (r.item?.error) this._out(`⚠ 监视「${e}」：${r.item.error}`, 'warn');
    else if (r.item?.kind === 'struct' || r.item?.kind === 'union' || r.item?.kind === 'array'){
      const n = r.item.type?.members?.length ?? r.item.type?.count;
      this._out(`监视 + ${e}${r.item.addr !== undefined ? ' @ ' + hex32(r.item.addr) : ''}`
        + `　（${r.item.typeName || '结构体'}${n != null ? `，${n} 项` : ''}：点 ▸ 展开成树）`, 'ok');
    }
    else this._out(`监视 + ${e}${r.item?.addr !== undefined ? ' @ ' + hex32(r.item.addr) : ''}`, 'ok');
    const wi = $('d-watch-in');
    if (wi && wi.value.trim() === e) wi.value = '';
    // 立刻读一次值给用户看；正忙（观察循环/别的动作在跑）就跳过，反正停下时会自动刷
    this.session.tryExclusive(() => this._refreshWatchLocked({ force: true })).catch(() => {});
    return { ok: true, index: r.index, item: r.item };
  }

  delWatch(what){
    const r = this.watch.remove(what);
    if (r.removed){ this._saveWatch(); this.renderWatch(); }
    return r;
  }

  /** 供命令行 `wl` 用：一溜溜的监视项（含刚读到的值） */
  watchItems(){
    return this.watch.items.map(it => ({ expr: it.expr, label: it.label, addr: it.addr, error: it.error || null, value: it.value || null, typeName: it.typeName }));
  }

  clearWatch(){
    if (!this.watch.length) return;
    this.watch.clear();
    this._saveWatch();
    this.renderWatch();
  }

  /** 把监视项的值读回来（停止时自动调；运行中看「运行中也刷新」开关） */
  async refreshWatch(opts = {}){
    if (this._disconnecting || this._connecting) return 0;
    return await this.session.exclusive(() => this._disconnecting ? 0 : this._refreshWatchLocked(opts));
  }

  async _refreshWatchLocked({ force = false } = {}){
    if (!this.watch.length) return 0;
    if (!this.session.connected){ this.renderWatch(); return 0; }
    if (this.watchBusy) return 0;
    if (!force && !this.session.halted && !$('d-watch-live')?.checked) return 0;
    this.watchBusy = true;
    let ok = 0;
    try {
      for (const it of this.watch.items){
        if (it.error) continue;
        try {
          /**
           * 结构体/数组：**一次读整块**（上限 TREE_LIMITS.maxBytes），树在本地按偏移解 ——
           * 展开时不再多读内存（每个成员一次 SWD 往返的话，一个 20 成员的 struct 就要 20 次）。
           */
          const isTree = it.kind === 'struct' || it.kind === 'union' || it.kind === 'array';
          const want = isTree ? Math.max(1, Math.min(it.size || 1, TREE_LIMITS.maxBytes)) : (it.size || 4);
          const bytes = await this.session.memRead(it.addr, want);
          if (isTree){
            it.bytes = bytes;
            const f = { text: summarizeTree(it, bytes), hex: null, cls: '', type: it.typeName };
            it.prev = it.value;
            it.value = f;
            if (f.cls !== 'err') ok++;
            continue;
          }
          it.bytes = null;
          const f = formatWatchValue(it, bytes);
          it.prev = it.value;
          it.value = f;
          if (f.cls !== 'err') ok++;
        } catch (e){
          it.prev = it.value;
          it.bytes = null; // Failed reads must not leave old struct members looking current.
          const waiting = e?.code === 'MEMORY_NOT_READY';
          it.value = { text: (waiting ? '等待初始化：' : '读失败：') + (e?.message || e), cls: waiting ? 'dim' : 'err' };
        }
      }
    } finally {
      this.watchBusy = false;
    }
    this.renderWatch();
    return ok;
  }

  renderWatch(){
    const box = $('d-watch-list');
    if (!box) return;
    box.textContent = '';
    if (!this.watch.length){
      const d = document.createElement('div');
      d.className = 'hint';
      d.innerHTML = '（还没有监视项：在符号列表点 ＋，或命令行 <code>w 变量</code>；<b>结构体/数组点 ▸ 展开成树</b>）';
      box.appendChild(d);
      return;
    }
    this.watch.items.forEach((it, i) => {
      const expandable = !it.error && (it.kind === 'struct' || it.kind === 'union' || it.kind === 'array');
      const row = document.createElement('div');
      row.className = 'wrow' + (it.error ? ' bad' : '');
      if (expandable){
        const ex = document.createElement('button');
        ex.className = 'mini exp';
        ex.textContent = it.expanded ? '▾' : '▸';
        ex.dataset.exp = String(i);
        ex.title = it.expanded ? '收起这棵树' : `展开成树（${it.typeName || '结构体'}：成员/数组元素按 DWARF 偏移解析）`;
        row.appendChild(ex);
      } else {
        const sp = document.createElement('span');
        sp.className = 'exsp';
        row.appendChild(sp);
      }
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.label || it.expr;
      nm.title = `${it.expr}${it.addr !== undefined ? ' @ ' + hex32(it.addr) : ''}${it.typeName ? ' : ' + it.typeName : ''}`;
      const vl = document.createElement('span');
      vl.className = 'vl';
      const v = it.value;
      vl.textContent = it.error ? it.error : (v ? (v.hex && !String(v.text).includes(v.hex) ? `${v.text}  ${v.hex}` : String(v.text)) : '—');
      if (v && it.prev && v.text !== it.prev.text) row.classList.add('chg');
      const ty = document.createElement('span');
      ty.className = 'ty';
      ty.textContent = it.error ? '' : (v?.type || it.typeName || '');
      const x = document.createElement('button');
      x.className = 'mini x';
      x.textContent = '×';
      // WatchList.remove shares the command-line's one-based numbering.
      x.dataset.del = String(i + 1);
      x.title = '删掉这一项';
      row.append(nm, vl, ty, x);
      box.appendChild(row);

      // 展开的树：成员 / 数组元素 / 位域（一次读回的字节里解出来的，已按偏移排好）
      if (expandable && it.expanded){
        const kids = it.bytes ? treeRows(it, it.bytes) : [];
        if (!kids.length){
          const d = document.createElement('div');
          d.className = 'hint';
          d.style.paddingLeft = '18px';
          d.textContent = '（还没读到数据：停下目标，或点「刷新值」）';
          box.appendChild(d);
        }
        for (const k of kids){
          const kr = document.createElement('div');
          kr.className = 'wkid' + (k.cls === 'dim' ? ' dim' : '') + (k.bitfield ? ' bf' : '');
          kr.style.paddingLeft = `${8 + (k.depth || 0) * 13}px`;
          const kn = document.createElement('span');
          kn.className = 'nm';
          kn.textContent = k.name;
          kn.title = `偏移 +${k.off}${k.size ? ` · ${k.size} 字节` : ''}${k.bitfield ? ' · 位域' : ''}`;
          const kv = document.createElement('span');
          kv.className = 'vl';
          kv.textContent = String(k.text ?? '') + (k.hex && !String(k.text).includes(k.hex) ? `  ${k.hex}` : '');
          const kt = document.createElement('span');
          kt.className = 'ty';
          kt.textContent = k.type || '';
          kr.append(kn, kv, kt);
          box.appendChild(kr);
        }
      }
    });
  }

  // ================================================================ 源码视图

  async pickSourceDir(){
    try {
      const sum = await this.src.pick();
      this._out('源码：' + sum, 'ok');
      this.srcShown = null;
      await this.renderSource();
      this._renderSrcSuggest();          // 选完当场报"这份 ELF 里能解析出几个"
    } catch (e){
      if (e?.name === 'AbortError') return;                      // 用户点了取消
      this._out('✗ 选择源码目录失败：' + (e?.message || e), 'err');
      toast('选择源码目录失败：' + (e?.message || e), 'err', 6000);
    }
  }

  async _indexSrcFiles(files){
    if (!files?.length) return;
    try {
      const sum = this.src.indexFileList(files);
      this._out('源码：' + sum, 'ok');
      this.srcShown = null;
      this._renderSrcSuggest();
      await this.renderSource();
    } catch (e){
      this._out('✗ 索引源码文件失败：' + (e?.message || e), 'err');
    }
  }

  /**
   * 按 ELF 的 DWARF 路径推荐"该选哪个源码目录"（`sourceRootSuggestions` 的界面那一半）。
   *
   * 用户提的：载入 ELF 的时候不就能知道该选哪个目录了吗？——能。DWARF 的 .debug_line 里存的是
   * **编译时的路径**（这份 HPM 的 ELF 188 条**全是绝对路径**：146 条在 `E:/sdk_env_v1.11.0/hpm_sdk`、
   * 18 条在工具链、24 条在 `/home/builder` —— 编译机路径，本机根本不存在）。
   * 已经选过目录时顺带报"这份 ELF 里能解析出多少"，选小了当场看得出来。
   */
  _renderSrcSuggest(){
    const paths = this.sym?.lines?.paths || [];
    const s = sourceRootSuggestions(paths);
    if (!s.total){
      this._out('源码目录建议：（这份 ELF 里没有可用的编译路径 —— 没有 .debug_line，或路径不是绝对路径）', 'dim');
      return;
    }
    const parts = [];
    if (this.src?.ready){
      // 选过目录就报"真的能解析出多少"——比"索引了多少文件"更贴近用户关心的事
      const uniq = [...new Set(paths.filter(Boolean))];
      const hit = uniq.filter(p => { try { return !!this.src.resolve(p); } catch { return false; } }).length;
      parts.push(`已选「${this.src.rootName}」能解析 ${hit}/${uniq.length}`);
    }
    parts.push(`推荐选 ${s.best.dir}（覆盖 ${s.best.files}/${s.total} 个源文件）`);
    if (s.root && s.root.dir !== s.best.dir) parts.push(`要全覆盖就选 ${s.root.dir}（${s.root.files}，目录更大）`);
    for (const o of s.others){
      parts.push(`${o.foreign ? '⚠ ' : ''}${o.dir}（${o.files}${o.foreign ? '，编译机/别的盘，本机覆盖不到' : ''}）`);
    }
    const text = parts.join(' · ');
    /**
     * 🚨 只写**控制台日志 + 标题栏那行的提示 + 按钮 tooltip**，不往"源码行"那块加元素：
     *    那里每多一行，源码就少看一行（dbg-page 的布局护栏就卡这个：一屏必须 ≥12 行源码）。
     */
    this._out('源码目录建议：' + text, 'dim');
    const pick = $('d-src-pick');
    if (pick) pick.title = `按这份 ELF 的 DWARF 路径（共 ${s.total} 条，绝对路径）推荐：\n` + parts.join('\n');
    const leg = $('d-src-file');
    if (leg && !this.src?.ready) leg.textContent = '推荐：' + s.best.dir + `（${s.best.files}/${s.total}）`;
  }

  /** 停下来时画"当前源码行"（Ozone 那种） */
  async renderSource(){
    const request = this._srcRequest = (this._srcRequest || 0) + 1;
    const sym = this.sym;
    const box = $('d-src');
    if (!box) return;
    const ph = (t) => { box.textContent = ''; const d = document.createElement('div'); d.className = 'hint'; d.textContent = t; box.appendChild(d); };
    if (!this.sym){ ph('（载入 .elf 后可用：停下来时这里显示 PC 所在的源码行，点行号下断点）'); this.srcCur = null; return; }
    if (!this.sym.lines){ ph('这份 ELF 没有行号信息（编译时没带 -g，或被 strip 过）—— 只能用 `sym` 找符号地址'); this.srcCur = null; return; }
    if (!this.session.connected){ ph('（还没连接：连上并停下来后这里显示源码行）'); this.srcCur = null; return; }
    const selected=this._btSnapshotValid?this.session._frames?.frames[this.session._selectedFrame||0]:null;
    const pc = (selected?.lookup??this.session.pc) >>> 0;
    const at = selected?.loc || this.sym.at(pc & 0xfffffffe);
    if (!at || !at.file){
      ph(`PC ${hex32(pc)} 不在有行号信息的代码里（可能在库函数/启动代码里）`);
      this.srcCur = null;
      return;
    }
    const current = this.srcCur = { ...at };
    let text = null, err = '';
    if (this.src.ready){
      try { text = await this.src.read(at.file); }
      catch (e){ err = e?.message || String(e); }
    }
    if (request !== this._srcRequest || this.sym !== sym || this.srcCur !== current) return;
    this._srcPaint(box, current, text != null ? text.split(/\r?\n/) : null, err);
  }

  _srcPaint(box, at, lines, err){
    const from = Math.max(1, at.line - 12);
    const to = lines ? Math.min(lines.length, at.line + 25) : at.line + 25;
    const key = `${at.file}:${from}:${to}:${at.line}:${this.session.bps.join(',')}`;
    const sameView = this.srcShown?.key === key;
    box.textContent = '';
    box.dataset.file = at.file;
    const bps = new Set();
    if (this.sym?.lines){
      for (const ln of range(from, to)){
        const a = this.sym.lines.addrOfLine(at.file, ln);
        if (a == null) continue;
        if (this.session.bps.some(b => (b & 0xfffffffe) === (a & 0xfffffffe))) bps.add(ln);
      }
    }
    if (!lines){
      const row = document.createElement('div');
      row.className = 'srcrow cur';
      row.dataset.line = String(at.line);
      const ln = document.createElement('span'); ln.className = 'ln'; ln.textContent = String(at.line);
      const tx = document.createElement('span'); tx.className = 'srctx';
      tx.textContent = err ? `（读不到源码：${err}）` : '（还没选源码目录：点上面的「选择源码目录…」，选到工程根目录）';
      row.append(ln, tx);
      box.appendChild(row);
      this.srcShown = { key, line: at.line };
      return;
    }
    const frag = document.createDocumentFragment();
    for (const ln of range(from, to)){
      const row = document.createElement('div');
      row.className = 'srcrow' + (ln === at.line ? ' cur' : '') + (bps.has(ln) ? ' bp' : '');
      row.dataset.line = String(ln);
      const n = document.createElement('span');
      n.className = 'ln';
      n.textContent = String(ln);
      n.title = '点一下在这行下硬件断点（要有地址信息）；再点一下删掉';
      const t = document.createElement('span');
      t.className = 'srctx';                       // 🚨 不能叫 `.tx`：那条全局规则是给"文本发送"输入框的（min-height:52px）
      t.textContent = (lines[ln - 1] ?? '').replace(/\t/g, '    ');
      row.append(n, t);
      frag.appendChild(row);
    }
    box.appendChild(frag);
    if (!sameView){
      const cur = box.querySelector('.srcrow.cur');
      if (cur?.scrollIntoView) cur.scrollIntoView({ block: 'center' });
    }
    this.srcShown = { key, line: at.line };
  }

  /** 点源码行号 → 下/删硬件断点（行号表里没有地址就明说） */
  async toggleSourceBp(line){
    if (!this.sym?.lines) return false;
    const file = this.srcCur?.file || $('d-src')?.dataset.file;
    if (!file) return false;
    const addr = this.sym.lines.addrOfLine(file, line);
    if (addr == null){ this._out(`✗ ${baseName(file)}:${line} 没有对应的代码地址（可能是空行/声明/被优化掉了）`, 'err'); return false; }
    const has = this.session.bps.some(b => (b & 0xfffffffe) === (addr & 0xfffffffe));
    return await this._act(has ? '删断点' : '下断点', async () => {
      if (has) await this.session.bpDel(addr);
      else await this.session.bpAdd(addr);
      this.renderBps();
      this.srcShown = null;
      await this.renderSource();
      this._out(`${has ? '删掉' : '下了'}断点 ${baseName(file)}:${line} @ ${hex32(addr)}`, 'ok');
    });
  }

  /** 源码行双击：运行到这一行（行号表里没地址就明说，并提示改用断点/单步） */
  async runToLine(line){
    if (!this.sym?.lines){ this._out('✗ 这份 ELF 没有行号信息，用不了「运行到这一行」', 'err'); return false; }
    const file = this.srcCur?.file || $('d-src')?.dataset.file;
    if (!file) return false;
    const addr = this.sym.lines.addrOfLine(file, line);
    if (addr == null){
      this._out(`✗ ${baseName(file)}:${line} 没有对应的代码地址（空行 / 声明 / 被优化掉了）`, 'err');
      return false;
    }
    const label = `${baseName(file)}:${line}`;
    return await this._act(`运行到 ${label}`, async () => {
      const msg = await this.session.runTo(addr, { label });
      this._out(msg, /没到达|已暂停/.test(msg) ? 'warn' : 'ok');
      await this.session.refresh();
      await this.session.refreshRegs();
      this.renderRegs();
      this.renderMem();
      await this.afterStop();
    });
  }

  // ---------------------------------------------------------------- 源码级单步

  /** 三个单步动作的统一收尾：报一句"落到哪一行" + 刷寄存器/内存/源码/监视 */
  async _stepAct(name, fn){
    return await this._act(name, async () => {
      const msg = await fn();
      if (msg) this._out(msg, /没停到|没停下|已暂停/.test(msg) ? 'warn' : 'ok');
      await this.session.refresh();
      await this.session.refreshRegs();
      this.renderRegs();
      this.renderMem();
      await this.afterStop();
    });
  }

  /** 单步跳过（F10 / Ctrl+F10 / 「跳过」按钮 / 命令 `n`） */
  async stepOver(){ return await this._stepAct('单步跳过', () => this.session.stepOver()); }
  /** 单步进入（F11 / Ctrl+F11 / 「进入」按钮 / 命令 `si`） */
  async stepInto(){ return await this._stepAct('单步进入', () => this.session.stepInto()); }
  /** 单步跳出（Shift+F11 / 「跳出」按钮 / 命令 `fin`） */
  async stepOut(){ return await this._stepAct('单步跳出', () => this.session.stepOut()); }

  /** 「调试器」页当前可见吗（快捷键只在可见时生效，免得在别的页签抢键） */
  _visible(){
    const p = document.getElementById('tab-dbg');
    return !!p && p.classList.contains('active');
  }

  /** 命令行 `src <文件:行>` 用：把源码视图跳到指定位置 */
  async showSource(file, line = 1){
    const request = this._srcRequest = (this._srcRequest || 0) + 1;
    const sym = this.sym;
    if (!this.sym?.lines) return false;
    const want = String(file).toLowerCase();
    const paths = this.sym.lines.paths;
    const hit = paths.find(p => p.toLowerCase() === want)
      || paths.find(p => p.toLowerCase().endsWith('/' + want))
      || paths.find(p => baseName(p).toLowerCase() === baseName(want));
    if (!hit) return false;
    const current = this.srcCur = { file: hit, line, addr: this.sym.lines.addrOfLine(hit, line) ?? 0 };
    const box = $('d-src');
    if (!box) return true;
    let text = null, err = '';
    if (this.src.ready){ try { text = await this.src.read(hit); } catch (e){ err = e?.message || String(e); } }
    if (request !== this._srcRequest || this.sym !== sym || this.srcCur !== current) return false;
    this.srcShown = null;
    this._srcPaint(box, current, text != null ? text.split(/\r?\n/) : null, err);
    const leg = $('d-src-file');
    if (leg) leg.textContent = `${baseName(hit)}:${line}（手动定位）`;
    return true;
  }

  // ================================================================ RTT 同屏

  /** 把 ELF 里的 `_SEGGER_RTT` 地址显示出来（地址留空就用它） */
  _renderRttSym(){
    const el = $('d-rtt-sym');
    if (!el) return;
    if (!this.sym){ el.textContent = '（载入 .elf 后这里显示 _SEGGER_RTT 的地址）'; return; }
    const s = this.sym.rttSym();
    const manual = parseNumSafe($('d-rtt-addr')?.value);
    if (s){
      el.textContent = `ELF 符号 ${s.name} = ${hex32(s.addr)}${s.size ? `（${s.size} 字节）` : ''}`
        + (manual ? `　·　地址格填了 ${hex32(manual)}（以它为准）` : '　·　地址留空就用它');
    } else {
      el.textContent = '这份 ELF 里没找到 _SEGGER_RTT 符号 —— 在「地址」里手填，或用 RTT 转发页的自动搜索';
    }
  }

  async rttStart(){
    if (!this.session.connected){ this._out('✗ 先连接目标', 'err'); return false; }
    const manual = parseNumSafe($('d-rtt-addr')?.value);
    let addr = manual;
    let from = manual ? '手填地址' : '';
    if (!addr){
      const v = this.sym?.rttSym?.() || this.sym?.find?.('_SEGGER_RTT');
      if (v?.addr){ addr = v.addr; from = `ELF 符号 ${v.name || '_SEGGER_RTT'}`; }
    }
    if (!addr){
      this._out('✗ 不知道 RTT 控制块地址：载入 .elf（用 _SEGGER_RTT 符号）或在「地址」里手填', 'err');
      return false;
    }
    return await this._act('定位 RTT', async () => {
      /**
       * 🚨 给 `Rtt` 的必须是**后端自己的**内存访问器，**不能**是 `this.session.probe`。
       *
       * ARM 后端里 probe 是 SWD/AHB-AP（直接能用）；RISC-V 后端里 probe 只是 WebUSB 的壳子，
       * 真正的内存通路是 `session.memRead/memWrite`（走 SBA）。原来传 probe，于是 RISC-V 目标上
       * 这里按 **SWD** 去读 RTT 控制块 → `SWD FAULT（传输 0/1 条，地址 0x4）`。
       *
       * 真机实测（HPM6800EVK + tcpecho，2026-10）：比"报个错"更糟的是这一下会把 DM 的 SBA
       * **打脏**——之后 `session.memRead` 不再报错、而是**静默返回全 0**（实测控制块 24 B 全 0，
       * 另一次是 `SEGGER RTT` 变成乱码），只有 `dm.init()` 才恢复。用户看到的就是
       * "定位 RTT 报错之后，调试读什么都变味了"。
       * RTT Viewer 的 RISC-V 通路（app/rtt/riscv-mem.js）本来就是这么接的，这里补齐。
       */
      const mem = {
        readMem: (a, n) => this.session.memRead(a, n),
        writeMem: (a, b) => this.session.memWrite(a, b),
        // RISC-V：通道名指针常落在 XIP flash，SBA 读那个窗口会把事务挂住（见 app/rtt/riscv-mem.js）
        skipNames: !!this.session.isRiscv,
      };
      const rtt = new Rtt(mem, { addr });
      await rtt.init(addr);
      this.rtt = rtt;
      this._out(`RTT 控制块 @ ${hex32(addr)}（${from}）：上行通道 ${rtt.maxUp} 个（第 1 个 ${rtt.up[0]?.size || 0} B）、下行 ${rtt.maxDown} 个`, 'ok');
      const info = $('d-rtt-info');
      if (info) info.textContent = `已连上 @ ${hex32(addr)}（${from}）`;
      this._renderRttSym();
      await this._rttPump();
      this._startWatch();          // 跑着的时候也持续泵
    });
  }

  rttStop(){
    this.rtt = null;
    if (this.rttTimer){ clearInterval(this.rttTimer); this.rttTimer = null; }
    const info = $('d-rtt-info');
    if (info) info.textContent = '已停止。';
  }

  rttClear(){
    const el = $('d-rtt');
    if (el) el.textContent = '';
  }

  async _rttPump(){
    if (!this.rtt) return;
    // 🚨 readUp 返回的是 {bytes, lost, level…} 而不是 Uint8Array（这个坑写错过一次）
    const res = await this.rtt.readUp(0);
    const bytes = res?.bytes;
    if (!bytes?.length) return;
    const el = $('d-rtt');
    if (!el) return;
    el.textContent += new TextDecoder().decode(bytes);
    if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-24000);
    el.scrollTop = el.scrollHeight;
  }

  // ================================================================ 自检摘要

  summary(){
    const s = this.session;
    return {
      connected: s.connected,
      backend: s.backendName,
      halted: s.halted,
      pc: s.pc >>> 0,
      clockKhz: (s.clockHz / 1000) | 0,
      regs: s.regList().length,
      bps: s.bps.map(a => hex32(a)),
      lastStepMode: s.lastStepMode || null,     // 'dhcsr' | 'breakpoint'（后者 = C_STEP 不生效，走了兜底）
      bpCap: s.bpCapacity,
      elf: this.sym ? { name: this.elfName, symbols: this.sym.size, vars: this.sym.varCount, source: this.sym.source,
        lines: this.sym.lines ? this.sym.lines.size : 0, files: this.sym.lines ? this.sym.lines.fileCount : 0,
        rtt: this.sym.rttSym()?.addr ?? null } : null,
      rtt: this.rtt ? { addr: this.rtt.addr, maxUp: this.rtt.maxUp } : null,
      watch: this.watch.items.map(it => ({ expr: it.expr, addr: it.addr ?? null, error: it.error || null, value: it.value?.text ?? null })),
      src: { ready: this.src.ready, files: this.src.count, cur: this.srcCur ? { file: this.srcCur.file, line: this.srcCur.line } : null,
        shown: $('d-src')?.querySelectorAll('.srcrow').length || 0 },
      symRows: $('d-sym-list')?.querySelectorAll('.symrow').length || 0,
      memAddr: hex32(this.memAddr),
      memLen: this.mem.length,
      watching: this.watching,
      outLines: $('d-out')?.childNodes.length || 0,
    };
  }
}

// ---------------------------------------------------------------- 小工具

function range(from, to){
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function parseNumSafe(text){
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s.slice(2), 16) >>> 0;
  if (/^[0-9a-f]+h$/i.test(s)) return Number.parseInt(s.slice(0, -1), 16) >>> 0;
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10) >>> 0;
  return null;
}

function sep(){
  const s = document.createElement('span');
  s.className = 'gap';
  s.textContent = ' ';
  return s;
}
