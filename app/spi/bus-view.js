/**
 * 「SPI/QSPI 桥」页（`#spi`）—— **通用**的那一页：配置、通用帧、链路自检。
 *
 * 与「SPI/QSPI 屏」页（`#panel`）共用同一个 `SpiSession`（一次连接，两页共用）：
 * 这里只管"桥本身能不能用、链路通不通"，屏相关的事（面板档、初始化表、刷图）在那一页。
 *
 * 右列是**一个带 tab 的面板**（照「调试器」页 `.docktabs`/`.dockpage` 那套）：
 *   [命令表] [脚本] [Flash 测试] [回环自检]     + 运行胶囊 / 中止
 * 下面常驻**日志**（帧流水）+ 统计条。tab 化之前是四张卡纵堆在一个滚动区、每张各自限高
 * （命令表只露约 7 行），"正在跑什么"和"命令表"没法同屏 —— 那正是"繁琐"的来源。
 *
 * 口径：
 *   · 所有发送都走 `session.sendFrames()`（分配 seq → 打包 → 发 → 等应答）；
 *   · 配置写入一律**回读对账**（状态字的 err 是"最近一次错误"，不能判断本次成功）；
 *   · 回环自检把每个长度原样发出去、原样读回来逐字节比对 —— 真机没接跳线时会 FAIL，那正是它的用处；
 *   · **`refreshButtons()` 是唯一的可用性中枢**，tab 化之后也不能改成"只更新可见 tab"：
 *     隐藏 tab 里的按钮同样得是对的，切过去要立刻能用。
 */
import { $, setStatus, appendLogLine, esc } from '../ui/dom.js';
import { EVKLITE_J3 } from '../ui/board-pinout.js';
import { yieldTask, waitMs } from '../core/pace.js';
import { store } from '../core/store.js';
import * as P from './protocol.js';
import * as D from './frames-dsl.js';
import * as FL from './flash.js';
import { fmtBytes, bytesEqual, parseHexByte, parseHexBytes } from './session.js';
import { SpiRegView } from './reg-view.js';
import { AcqView } from './acq-view.js';

/** 右列 tab 的 id（与 HTML 的 data-dock 一一对应）*/
const DOCK_IDS = ['cmd', 'reg', 'dsl', 'live', 'flash', 'loop'];

/** HTML 转义见 `ui/dom.js` 的 `esc`（DSL 的错误表要原样显示用户写的那行）*/
/** 十六进制转储（每行 16 B，带偏移）*/
function hexDump(bytes, max = 256){
  const b = bytes instanceof Uint8Array ? bytes.subarray(0, max) : new Uint8Array(0);
  const lines = [];
  for (let i = 0; i < b.length; i += 16){
    const row = [...b.subarray(i, i + 16)].map(x => x.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${i.toString(16).padStart(4, '0')}  ${row}`);
  }
  return lines.join('\n') || '（空）';
}
/**
 * 吞吐文本：B/ms → KB/s 或 MB/s。
 * 🚨 用**十进制**（MB/s 就是 1e6 B/s）：以前拿 1048576 去除却标"MB/s"，
 *    20 MHz 四线明明该是 10.00 MB/s，显示成 9.54 —— 用户一眼就看出不对。
 */
const rate = (bytes, ms) => {
  if (!ms) return '—';
  const bps = bytes / (ms / 1000);
  return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' MB/s' : (bps / 1e3).toFixed(0) + ' KB/s';
};

export class SpiBusView {
  constructor(session){
    this.session = session;
    this.tag = 'bus';
    this.loopAbort = false;
    this.loopRunning = false;  // 回环自检是否在跑（决定 tab 栏那个「中止」亮不亮）
    this.loopRows = [];        // 回环结果（切回该 tab 时要重画）
    this.dockTab = 'cmd';      // 右列当前 tab（cmd / dsl / flash / loop）
    this.unsub = null;
    this.lastRead = null;      // 最近一次 flash 读回的数据（写校验用）
    /* CS 辅助脚（pad 2）与它的有效电平：**不再在「引脚设置」里配**（用户 2026-10 要求去掉那一行），
     * 但配置块里这两个字段还在（CS 策略 = 1 时固件用得上），所以"读回来的值原样回写"，清成 0 会改坏别人的配置。 */
    this._padCsAux = 0;        // 默认"不用"，与旧下拉的首项一致
    this._csAuxLow = true;     // 默认低有效，与固件/假探针的 padActiveLow=0x06 一致
  }

  // ==================================================================== 初始化

  init(){
    const s = this.session;

    // 下拉：SCLK / CS 策略 / 辅助脚
    for (const c of P.SCLK_CHOICES) $('sp-sclk').appendChild(new Option(c.label, String(c.hz)));
    for (const c of P.CS_POLICY){
      const option = new Option(c.short, String(c.v)); option.title = c.label; $('sp-cs').appendChild(option);
    }
    for (const p of P.PADS){
      const label = p.j3 ? `${p.name} · ${p.j3.split('（')[0]}` : p.name;
      for (const id of ['sp-pad-dc', 'sp-pad-rst', 'sp-pad-bl']){
        const o = new Option(label, String(p.i));
        o.title = `${p.name} ${p.j3}`;
        o.dataset.pad = String(p.i);
        const sel = $(id);
        if (sel) sel.appendChild(o);        // ⚠️ 混版（旧 index.html + 新 js）时可能没这个元素，别让初始化挂掉
      }
    }
    /* 引脚设置的**开机默认值** = 引脚分配图里的推荐脚位（protocol.AUX_DEFAULT：DC=PA26 / RST=PA02 / BL=PA31）。
     * 用户 2026-10 要求："启动 DC/RST/BL 几个引脚的默认值（不是不用）" —— 所以在读到探针配置之前
     * 就先把推荐值显示出来，照着接线；点「读取配置」后以探针里的实际值为准（fillCfg）。 */
    for (const [id, pad] of [['sp-pad-dc', P.AUX_DEFAULT.DC], ['sp-pad-rst', P.AUX_DEFAULT.RST], ['sp-pad-bl', P.AUX_DEFAULT.BL]]){
      const sel = $(id);
      if (sel) sel.value = String(pad);
    }
    this.refreshPads();

    // Start compact; adding a row preserves existing values/results and send order.
    this.buildCmdRows(3);

    // flash 卡的下拉与语法速查
    for (const m of FL.READ_MODES) $('sp-fl-mode').appendChild(new Option(m.name, String(m.v)));
    /* 默认读模式 = READ 0x03（最保守的 1 线读、不要 dummy）—— 用户 2026-10 现场要求：
     * 之前默认 QUAD I/O 0xEB，一上来就得先解决 QE 位 / 四线接线，容易"读不出东西"就卡住。 */
    $('sp-fl-mode').value = String(FL.OP.READ);
    /* 切读模式 → dummy **自动跟着变**（每个模式的默认拍数在 READ_MODES 里，0 表示不要 dummy）。
     * 仍可手动改：改完不会被覆盖，只有再次切换模式才会重新带出默认值。 */
    $('sp-fl-mode').addEventListener('change', () => { $('sp-fl-dummy').value = String(this.flMode().dummy); });
    $('sp-fl-dummy').value = String(this.flMode().dummy);
    for (const e of FL.ERASE_MODES) $('sp-fl-erase-mode').appendChild(new Option(e.name, String(e.v)));
    for (const x of D.DSL_SAMPLES) $('sp-dsl-preset').appendChild(new Option(x.name, x.name));
    $('sp-dsl-help').textContent = D.DSL_HELP;
    $('sp-dsl-text').value = D.DSL_SAMPLES[0].text;

    // 连接（两页共用一次会话，所以这里和屏页都能连）
    $('sp-connect').addEventListener('click', () => s.connectHid(true));
    $('sp-reconnect').addEventListener('click', () => s.connectHid(false));
    $('sp-usb').addEventListener('click', () => s.connectUsb(null, { inFlight: +($('sp-inflight').value || 4) }));
    $('sp-mock').addEventListener('change', e => s.setMock(e.target.checked, { device: $('sp-mock-device').value }));
    // 假探针的"末级器件"：SPI 没有器件地址，所以是**换一个末级**（NOR / 寄存器器件 / 命令型 ADC）
    $('sp-mock-device').value = store.get('spi.mockDevice', 'flash');
    $('sp-mock-device').addEventListener('change', e => {
      store.set('spi.mockDevice', e.target.value);
      s.setMockDevice(e.target.value);
    });

    /* 「寄存器」面板与「定时采集」：两块的逻辑各自成模块（regs/reg-view、runner/acq-view），
     * 这里只负责建起来 + 把连接状态转给它们（可用性统一在 refreshButtons 之外再走各自的 setEnabled）。 */
    this.reg = new SpiRegView({ session: s });
    this.reg.init();
    this.acq = new AcqView({ session: s, tag: this.tag });
    this.acq.init();

    // 配置 / 引脚
    $('sp-get').addEventListener('click', () => this.loadCfg());
    $('sp-set').addEventListener('click', () => this.applyCfg());
    $('sp-pin-apply').addEventListener('click', () => this.applyCfg());
    $('sp-bl-on').addEventListener('click', () => this.sendGpio(P.LINE.BL, 1, '背光开'));
    $('sp-bl-off').addEventListener('click', () => this.sendGpio(P.LINE.BL, 0, '背光关'));
    $('sp-pin-rst-send').addEventListener('click', () => this.sendRstPulse());
    /* 引脚分配图：点一下弹出 J3 40 针的分配（桥的信号 / CDC 串口 / 可当辅助脚的 / 不能用的）*/
    $('sp-pinmap-btn').addEventListener('click', () => this.togglePinMap());
    $('sp-pinmap-close').addEventListener('click', () => { $('sp-pinmap').hidden = true; });

    // 使能 / 收尾
    $('sp-enable').addEventListener('click', () => this.setEnabled(true));
    $('sp-disable').addEventListener('click', () => this.setEnabled(false));
    $('sp-reset').addEventListener('click', () => this.wrap(() => s.reset({ tag: this.tag })));
    $('sp-abort').addEventListener('click', () => this.wrap(() => s.abort({ tag: this.tag })));
    $('sp-status').addEventListener('click', () => s.pollStatus(true));

    // 通用命令表
    $('sp-cmd-send').addEventListener('click', () => this.cmdSendAll());
    $('sp-cmd-clear').addEventListener('click', () => this.cmdClearResults());
    $('sp-cmd-add').addEventListener('click', () => this.buildCmdRows(1, { append:true }));
    $('sp-cmd-body').addEventListener('keydown', e => {
      // 表里敲回车 = 发送全部（比在几十个格子间找按钮顺手）
      if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); this.cmdSendAll(); }
    });

    // 通用命令（文本 / C 表）
    $('sp-dsl-load').addEventListener('click', () => this.dslLoadSample());
    $('sp-dsl-parse').addEventListener('click', () => this.dslRun(false));
    $('sp-dsl-send').addEventListener('click', () => this.dslRun(true));
    $('sp-dsl-file').addEventListener('click', () => $('sp-dsl-file-input').click());
    $('sp-dsl-file-input').addEventListener('change', e => this.dslLoadFile(e.target.files?.[0]));
    for (const [id, kind] of [['sp-dsl-out-c', 'c'], ['sp-dsl-out-json', 'json'], ['sp-dsl-out-text', 'text']])
      $(id).addEventListener('click', () => this.dslExport(kind));
    $('sp-dsl-clear').addEventListener('click', () => { $('sp-dsl-text').value = ''; $('sp-dsl-err').innerHTML = ''; $('sp-dsl-errwrap').style.display = 'none'; setStatus($('sp-dsl-sum'), '已清空', ''); });

    // SPI / NOR Flash
    $('sp-fl-readid').addEventListener('click', () => this.flReadId());
    $('sp-fl-sfdp').addEventListener('click', () => this.flReadSfdp());
    $('sp-fl-sr').addEventListener('click', () => this.flReadStatus());
    $('sp-fl-wiring').addEventListener('click', () => this.flWiring());
    $('sp-fl-read').addEventListener('click', () => this.flReadUI());
    $('sp-fl-bench').addEventListener('click', () => this.flBench());
    $('sp-fl-armed').addEventListener('change', () => this.refreshButtons());
    $('sp-fl-fill').addEventListener('click', () => this.flFillPattern());
    $('sp-fl-erase').addEventListener('click', () => this.flErase());
    $('sp-fl-write').addEventListener('click', () => this.flWrite());
    $('sp-fl-writebench').addEventListener('click', () => this.flWriteBench());

    // 回环自检
    $('sp-lb-run').addEventListener('click', () => this.loopbackTest());
    // 清空结果表（只清屏上的表，探针侧的计数器不动 —— title 里写明了）
    $('sp-lb-clear').addEventListener('click', () => { this.renderLoopRows([]); });
    // 「中止」挪到了 tab 栏（切到任何 tab 都能停回环）—— 见 _dockSelect 附近的说明
    $('sp-run-abort').addEventListener('click', () => this.abortLoop());

    $('sp-log-clear').addEventListener('click', () => { $('sp-log').innerHTML = ''; });

    this._bindDock();

    this.unsub = s.subscribe(this);
    s.log('i', '就绪。真机：先「连接探针」再「连接数据端点」；没板子就勾「用假探针」。');
    this.renderState(s.stateInfo());
    this.renderCounters(s.counters, s.lastStatus);
  }

  // ==================================================================== 右列局部 tab

  /**
   * 右列 tab（照「调试器」页那套）。**壳在页面里，这里只负责切换与持久化。**
   *
   * 为什么桥页比 I2C 页更需要那个运行胶囊：桥有**全局 busy**（`session.busy` 一处置位，
   * `refreshButtons()` 就把二十多个按钮一起灰掉），tab 化之后"为什么全都灰了"如果不写在
   * tab 栏上，就只能去翻日志。所以胶囊显示 `空闲 / 忙 / 回环 3/8`，中止按钮也放在它旁边。
   *
   * ⚠️ 中止**只对回环自检有效**：擦/写不能中途停 —— 那会把 flash 留在半擦状态，比跑完更糟。
   *    所以按钮在非回环的忙期保持灰，title 里也写明了。
   */
  _bindDock(){
    const tabs = $('sp-dock-tabs');
    const btns = tabs ? [...tabs.querySelectorAll('button[data-dock]')] : [];
    for (const b of btns) b.addEventListener('click', () => this._dockSelect(b.dataset.dock));
    const saved = store.get('spi.dock', 'cmd');
    this._dockSelect(DOCK_IDS.includes(saved) ? saved : 'cmd', { save: false });

    // 日志高度可拖（存 localStorage；刷新后还在）
    const box = $('sp-logbox');
    const h = Number(store.get('spi.logH', 0)) || 0;
    if (box && h > 0) box.style.height = Math.round(h) + 'px';
    this._bindGrip($('sp-grip-log'), {
      get: () => box?.getBoundingClientRect().height || 0,
      apply: v => { if (box) box.style.height = Math.round(v) + 'px'; },
      min: () => 72,
      max: () => Math.max(120, (document.querySelector('#tab-spi .main')?.clientHeight || 700) - 220),
      save: v => store.set('spi.logH', Math.round(v)),
    });
  }

  /** 切右列 tab（只显示一个，选择记进 localStorage）*/
  _dockSelect(name, { save = true } = {}){
    const tabs = $('sp-dock-tabs');
    if (tabs) for (const b of tabs.querySelectorAll('button[data-dock]')) b.classList.toggle('on', b.dataset.dock === name);
    const box = $('sp-box-dock');
    if (box) for (const p of box.querySelectorAll('.dockpage')) p.classList.toggle('on', p.dataset.dock === name);
    this.dockTab = name;
    if (save) store.set('spi.dock', name);
    // 刚显示出来的内容补一次刷新：整个页面被切走时浏览器会把 rAF 挂起，
    // 隐藏期间攒下的渲染可能还没落地（`display:none` 本身不影响 rAF）。
    if (name === 'loop') this.renderLoopRows(this.loopRows || []);
  }

  /** 通用分隔条拖拽（不用 setPointerCapture：合成的 CDP 事件也能驱动它 —— 抄的 #dbg）*/
  _bindGrip(el, { get, apply, min, max, save }){
    if (!el) return;
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      const startY = e.clientY;
      const startVal = get();
      if (!startVal) return;
      const move = ev => apply(Math.max(min(), Math.min(max(), startVal - (ev.clientY - startY))));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        save(get());
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /** 中止回环（没在跑回环时什么也不做，只把原因说清楚）*/
  abortLoop(){
    if (this.loopRunning){ this.loopAbort = true; return; }
    if (this.session.busy) this.session.log('w', '当前这桩操作不能中止（擦/写中途停会把 flash 留在半擦状态）', this.tag);
  }

  /**
   * 运行胶囊。`kind`：
   *   `idle` 空闲 / `busy` 有操作在跑（说不出是什么）/ `loop` 回环自检 / `done` 刚跑完
   */
  renderRunPill(kind, text){
    const el = $('sp-run-pill');
    const btn = $('sp-run-abort');
    if (!el) return;
    const cls = { idle: 'hint dockrun', busy: 'hint dockrun warn', loop: 'hint dockrun on', done: 'hint dockrun' }[kind] || 'hint dockrun';
    el.className = cls;
    el.textContent = text;
    if (btn){
      // 只有回环可中止；其余忙期灰着（title 已经写明原因）
      btn.disabled = !this.loopRunning;
      btn.title = this.loopRunning
        ? '中止正在跑的回环自检'
        : '只有回环自检可中止；擦/写不能中途停 —— 那会把 flash 留在半擦状态';
    }
  }

  /** 由 session 的 busy 事件驱动的"兜底"胶囊（回环自己有更具体的文案）*/
  syncRunPill(){
    const s = this.session;
    if (this.loopRunning) return;                       // 回环自己会更新
    if (s.busy) this.renderRunPill('busy', '▶ 忙（有操作在跑，按钮暂时灰掉）');
    else this.renderRunPill('idle', '空闲');
  }

  /** session 的事件入口 */
  onSession(type, payload){
    if (type === 'log') this.appendLog(payload);
    else if (type === 'state'){ this.renderState(payload); this.refreshButtons(); }
    else if (type === 'busy'){ this.refreshButtons(); this.syncRunPill(); }
    else if (type === 'cfg') this.fillCfg(payload);
    else if (type === 'profile') this.refreshPads();
    else if (type === 'counters') this.renderCounters(payload.counters, payload.lastStatus);
  }

  // ==================================================================== 渲染

  appendLog(e){
    appendLogLine($('sp-log'),
      (e.tag === 'panel' ? '[屏] ' : '') + e.text,
      e.kind === 'g' ? 'ok' : e.kind === 'e' ? 'err' : e.kind === 'w' ? 'warn' : 'dim');
  }

  /** 切回本页时按 ring 重建（另一页期间发生的事也在这里补上）*/
  renderLogFromRing(){
    const el = $('sp-log');
    if (!el) return;
    el.innerHTML = '';
    for (const e of this.session.ring) this.appendLog(e);
  }

  renderState(st){
    const state = $('sp-state');
    setStatus(state, st.text.startsWith('未连接 ——') && !st.kind ? '未连接' : st.text, st.kind || '');
    if (state) state.title = st.text;
    $('sp-info').textContent = st.mock ? '假探针（无需硬件）' : (st.hidLabel || '未连接');
    $('sp-usbinfo').textContent = st.dataReady ? st.transportLabel : '未连接数据端点（假探针模式不需要）';
    $('sp-mock').checked = !!st.mock;
  }

  renderCounters(c, lastStatus){
    if (!c) return;
    $('sp-c-ok').textContent = String(c.framesOk ?? 0);
    $('sp-c-err').textContent = String(c.framesErr ?? 0);
    $('sp-c-tx').textContent = fmtBytes(c.bytesTx ?? 0);
    $('sp-c-rx').textContent = fmtBytes(c.bytesRx ?? 0);
    $('sp-c-poll').textContent = String(c.txPoll ?? 0);
    $('sp-c-dma').textContent = String(c.txDma ?? 0);
    $('sp-c-in').textContent = String(c.inDrop ?? 0);
    $('sp-c-ovf').textContent = String(c.outOverrun ?? 0);
    $('sp-sclk-actual').textContent = c.actualSclkHz ? P.sclkLabel(c.actualSclkHz) : '—';
    $('sp-last-us').textContent = c.lastUs ? c.lastUs.toFixed(1) : '—';   // 上一笔事务耗时（调 SCLK 时看这个）
    if (lastStatus){
      $('sp-word').textContent = '0x' + (lastStatus.status >>> 0).toString(16).padStart(8, '0');
      $('sp-word-text').textContent = P.statusText(lastStatus.status);
    }
  }

  fillCfg(c){
    $('sp-sclk').value = String(c.sclkHz);
    if ($('sp-sclk').selectedIndex < 0) $('sp-sclk').value = '0';
    $('sp-mode').value = String(c.mode);
    if ($('sp-mode').selectedIndex < 0) $('sp-mode').value = '0';
    $('sp-cs').value = String(c.csPolicy);
    $('sp-thr').value = String(c.txDmaThreshold);
    $('sp-clear').checked = !!(c.flags & P.CFG_FLAG.CLEAR_ON_ENABLE);
    $('sp-pad-dc').value = String(c.padDc);
    $('sp-pad-rst').value = String(c.padRst);
    $('sp-pad-bl').value = String(c.padBl);
    $('sp-al-dc').checked = P.lineActiveLow(c.padActiveLow, P.LINE.DC);
    $('sp-al-rst').checked = P.lineActiveLow(c.padActiveLow, P.LINE.RST);
    $('sp-al-bl').checked = P.lineActiveLow(c.padActiveLow, P.LINE.BL);
    this._padCsAux = c.padCsAux;                                       // CS 辅助：UI 不显示，回写时原样带上
    this._csAuxLow = P.lineActiveLow(c.padActiveLow, P.LINE.CS_AUX);
    /* 🚨 探针里 DC/RST/BL **全是「不用」**（刚烧完固件 / 重枚举后的默认态）时，别让面板跟着显示"不用" ——
     * 用户 2026-10 现场就是这么被卡住的："启动就该给默认值，不是不用"。
     * 按推荐脚位（AUX_DEFAULT）预填，并在日志里说清楚"这是预填、还没写进探针"，点「应用引脚」才落地。 */
    if (!c.padDc && !c.padRst && !c.padBl){
      $('sp-pad-dc').value = String(P.AUX_DEFAULT.DC);
      $('sp-pad-rst').value = String(P.AUX_DEFAULT.RST);
      $('sp-pad-bl').value = String(P.AUX_DEFAULT.BL);
      this.session.log('w', `探针里 DC/RST/BL 都还是「不用」—— 已按推荐脚位预填：` +
        `DC=${P.PAD_NAME[P.AUX_DEFAULT.DC]} / RST=${P.PAD_NAME[P.AUX_DEFAULT.RST]} / BL=${P.PAD_NAME[P.AUX_DEFAULT.BL]}；` +
        `点「应用引脚」才会写进探针`, this.tag);
    }
    $('sp-ring').textContent = `OUT ${c.outRingKb} KB / IN ${c.inRingKb} KB / 单帧上限 ${c.maxFrameBytes} B`;
  }

  refreshButtons(){
    const s = this.session, c = s.connected, d = s.dataReady, busy = s.busy;
    $('sp-get').disabled = !c; $('sp-set').disabled = !c; $('sp-pin-apply').disabled = !c;
    $('sp-enable').disabled = !c; $('sp-disable').disabled = !c;
    $('sp-reset').disabled = !c; $('sp-abort').disabled = !c; $('sp-status').disabled = !c;
    $('sp-cmd-send').disabled = !d || busy;
    $('sp-lb-run').disabled = !d || busy;
    // 「中止」在 tab 栏上（切到任何 tab 都能停）—— 它的可用性由 renderRunPill 统一管，
    // 因为**只有回环可中止**：擦/写中途停会把 flash 留在半擦状态，按钮必须保持灰
    this.syncRunPill();
    for (const id of ['sp-bl-on', 'sp-bl-off', 'sp-pin-rst-send']) $(id).disabled = !d || busy;
    // 通用命令（文本）/ flash：没数据端点或正忙时不能发
    for (const id of ['sp-dsl-parse', 'sp-dsl-send']) $(id).disabled = !d || busy;
    // 「寄存器」面板：连上就能读（它自己还会管"有没有改动"）
    this.reg?.setEnabled(c && d);
    // 定时采集：跑起来之后「开始」保持灰、「停止」亮（胶囊在 tab 栏上，切 tab 也看得见）
    this.acq?.renderPill(this.acq.running ? 'running' : 'idle');
    for (const id of ['sp-fl-readid', 'sp-fl-sfdp', 'sp-fl-sr', 'sp-fl-read', 'sp-fl-bench']) $(id).disabled = !d || busy;
    // 擦写按钮：既要连着，也要勾了「我确认」
    const armed = $('sp-fl-armed').checked;
    for (const id of ['sp-fl-erase', 'sp-fl-write', 'sp-fl-writebench']) $(id).disabled = !d || busy || !armed;
  }

  /**
   * 引脚下拉的可用性跟固件对齐（`sb_pad_ok` / `sb_cfg_validate`）：
   * PY00/PY01 v1 不支持；PB10~PB13 现在（2026-09-30 起）是 **SPI2 的 CS/SCLK/MISO/MOSI**，
   * 永远不能当辅助脚；PA30 是 USB0_PWR 网络（被板上 Q1 常态短到地），也别用；
   * PA31（USB0_ID 网络）现在是自由脚，可以当慢速输出。
   * 灰掉只是**提前告知** —— 真发下去固件也会回 RANGE，那是最后一道闸。
   */
  refreshPads(){
    const quad = this.session.profile?.profile === P.PROFILE_KIND.QSPI;
    const notes = [];
    /* SPI2 固定脚（固件 reserved[]）：PB10/CS(4)、PB11/SCLK(1)、PB12/MISO(2)、PB13/MOSI(3) */
    const SPI2_PADS = [1, 2, 3, 4];
    for (const id of ['sp-pad-dc', 'sp-pad-rst', 'sp-pad-bl']){
      const sel = $(id);
      if (!sel) continue;
      for (const o of sel.options){
        const pad = +o.dataset.pad;
        /* 9/10 = PY00/PY01（v1 不支持）；SPI2_PADS = 桥的信号线；12 = PA30（被 Q1 短到地） */
        const bad = pad === 9 || pad === 10 || pad === 12 || SPI2_PADS.includes(pad);
        o.disabled = bad;
      }
      if (sel.selectedOptions[0]?.disabled){
        const was = sel.selectedOptions[0].textContent;
        sel.value = '0';
        this.session.log('w', `${id.replace('sp-pad-', '').toUpperCase()} 选的「${was}」固件会拒（SPI2 固定脚 / PY / PA30），已改回「不用」`, this.tag);
      }
    }
    notes.push('PB10~PB13 是 SPI2 的 CS/SCLK/MISO/MOSI（已灰）');
    notes.push('PA30 是 USB0_PWR 网络，被板上 Q1 常态短到地，拉不动（已灰）');
    notes.push('PY00/PY01 在 v1 不支持（已灰）');
    /* PA28/PA29 是 I2C 桥写死的 SDA/SCL（见 akaLinkPro 的 i2c_bridge.c）：
       **不灰掉**（I2C 没使能时它们确实能用），但要让接线的人知道这两根已经名花有主。 */
    notes.push('PA28/PA29 是 I2C 桥的固定 SDA/SCL（J3[21]/J3[19]）—— I2C 一使能，固件就拒这两根当辅助脚');
    $('sp-pad-note').textContent = 'TE 撕裂信号暂不暴露（TBD）。' + notes.join('；') + '。';
  }

  // ------------------------------------------------------------ 引脚分配图

  async togglePinMap(){
    const box = $('sp-pinmap');
    box.hidden = !box.hidden;
    if (box.hidden) return;
    /* 没读到配置就先自动读一次（连着探针 / 假探针都可以读），否则图里标不出辅助脚 */
    const s = this.session;
    if (!s.cfg && (s.connected || s.usingMock)){
      await this.wrap(() => s.loadCfg({ tag: this.tag }));
      this.refreshPads();
    }
    this.renderPinMap();
  }

  /**
   * 画 J3 40 针的引脚分配（2026-09-30 SPI2/UART2 迁移后的接法）。
   * 标记：★ 桥的信号（SPI2） ● CDC 虚拟串口（UART2） ○ 可当辅助脚 ⛔ 不可用 · 电源/地/空脚
   *       << DC/RST/CS_AUX/BL/TE = 当前配置里挂在这根 pad 上的辅助线
   *
   * ⚠️ 配置里的 padDc/padRst/... 是**协议 pad 索引**（见 protocol.js 的 PADS），
   *    不是 J3 脚号 —— 表格每行末尾那个数字才是 pad 索引（0 = 这根脚不在 pad 表里）。
   *    曾经拿 J3 脚号去比过，结果 "DC=PA02(index 5)" 被标到了 J3[5]（PB08）上。
   */
  renderPinMap(){
    const c = this.session.cfg || {};
    /**
     * [线名, 配置里的值, **默认脚位**]
     *
     * 默认脚位取自 `protocol.AUX_DEFAULT`（固定表），**不跟屏型号走** —— 用户 2026-09-30：
     * 接线在配置之前，图上必须"配置值优先、否则默认值"，不能忽有忽无、更不能指到不能用的脚。
     */
    const LINES = [
      ['DC', c.padDc, P.AUX_DEFAULT.DC], ['RST', c.padRst, P.AUX_DEFAULT.RST],
      ['CS_AUX', c.padCsAux, P.AUX_DEFAULT.CS_AUX], ['BL', c.padBl, P.AUX_DEFAULT.BL],
      ['TE', c.padTe, P.AUX_DEFAULT.TE],
    ];
    /**
     * 这根 pad 上挂了什么线：
     *   · `now` = 配置里**真的配了**的（实心显示）
     *   · `dft` = 这条线**还没配**、但按推荐脚位该在这根脚上（虚线 +「（默认）」，供接线的人看）
     * 两条规矩：**配过的线不再显示它的默认位置**（你已经在别处配了它）；
     * 一根脚上**不同时**出实心和虚线（这根脚的接线已经定下来了，别再让人犹豫）。
     */
    const sel = pad => {
      if (!pad) return { now: '', dft: '' };
      const now = LINES.filter(([, v]) => v === pad).map(([n]) => n).join('/');
      const dft = now ? '' : LINES.filter(([, v, d]) => !v && d === pad).map(([n]) => n).join('/');
      return { now, dft };
    };
    const M = { spi: '★', vcom: '●', aux: '○', no: '⛔', pwr: '·', gnd: '·', nc: '·', i2c: '◆' };
    /* [J3 脚, pad 名/标签, 角色, 备注, 协议 pad 索引（0 = 不在辅助脚表里）] */
    const T = EVKLITE_J3;
    const cell = ([pin, name, role, note, pad]) => {
      const { now, dft } = sel(pad);
      const cls = { spi: 'is-spi', vcom: 'is-vcom', aux: 'is-aux', no: 'is-no', i2c: 'is-i2c' }[role] || 'is-plain';
      /* 配置把辅助线挂在"当不了辅助脚"的脚上（SPI2 固定脚 / CDC 串口 / 保留脚 / 实测不可用）
       * ＝ 陈旧或错误的配置：标红 + ⚠，别让人以为接对了 */
      const stale = !!now && role !== 'aux';
      const why = { spi: 'SPI2 的固定信号脚', vcom: 'CDC 虚拟串口脚', no: '实测当不了辅助脚',
                    i2c: 'I2C 桥的固定脚（I2C 一使能就被它占用）' }[role] || '不可用';
      return `<td class="p-pin">${pin}</td>` +
             `<td class="p-name ${cls}"><span class="p-mark">${M[role] || '·'}</span>${name}` +
             (note ? `<span class="p-note">${note}</span>` : '') +
             (role === 'i2c' ? '<span class="p-fixed">固定</span>' : '') +
             (now ? `<span class="p-sel${stale ? ' is-bad' : ''}">&lt;&lt; ${now}${stale ? ` ⚠ 这根是${why}，接上去也不动` : ''}</span>` : '') +
             (dft ? `<span class="p-sel is-dflt">&lt;&lt; ${dft}（默认）</span>` : '') +
             '</td>';
    };
    const rows = [];
    for (let i = 0; i < 20; i++){
      rows.push('<tr>' + cell(T[i * 2]) + cell(T[i * 2 + 1]) + '</tr>');
    }
    $('sp-pinmap-body').innerHTML = rows.join('');
    $('sp-pinmap-legend').textContent =
      '★ 桥的信号（SPI2）　● CDC 虚拟串口（UART2）　○ 可当辅助脚　◆ I2C 桥固定脚　⛔ 不可用　· 电源/地/空脚　' +
      '<< 实心＝当前配置　<< 虚线（默认）＝还没配，按默认脚位先标给你接线';
    const show = (v, d) => v ? (P.PAD_NAME[v] || ('pad' + v))
                             : d ? (P.PAD_NAME[d] || ('pad' + d)) + '（默认）' : '不用';
    $('sp-pinmap-foot').textContent =
      '辅助脚：DC=' + show(c.padDc, P.AUX_DEFAULT.DC) +
      '　RST=' + show(c.padRst, P.AUX_DEFAULT.RST) +
      '　CS 辅助=' + show(c.padCsAux, P.AUX_DEFAULT.CS_AUX) +
      '　BL=' + show(c.padBl, P.AUX_DEFAULT.BL) +
      '　TE=' + show(c.padTe, P.AUX_DEFAULT.TE) +
      '　｜　接线：CS←J3[26] SCLK←J3[13] D0←J3[28] D1←J3[27] D2←J3[10] D3←J3[8]，' +
      'VCOM ← J3[5](TX,PB08) / J3[3](RX,PB09)，' +
      'I2C ← J3[19](SCL,PA29) / J3[21](SDA,PA28)（固定脚，见「USB→I2C」页）';
    $('sp-pinmap-sub').textContent =
      '（<< 实心 = 当前配置；<< 虚线（默认）= 还没配，按默认脚位标出来给你接线）';

    /**
     * 图上**没出现**的线要交代清楚（用户 2026-09-30 问过"图中缺一个DC脚"）：
     *   ① 本来就没默认脚、也没配（如 CS_AUX / TE）—— 说清它是干什么的、要不要接；
     *   ② 有默认脚，但那根脚**已经被别的线配走**了 —— 必须明说，否则照着脚注接就接错了。
     */
    const WHY = {
      CS_AUX: '第二片选，只挂一片屏时不用',
      TE: '面板撕裂信号（输入），不接也能刷图',
    };
    const miss = [];
    for (const [n, v, d] of LINES){
      if (v) continue;                                        // 配了 → 图上实心
      if (d && !LINES.some(([, v2]) => v2 === d)) continue;   // 有默认脚、且没被别的线配走 → 图上虚线
      miss.push(n + '（' + (d ? `默认脚 ${P.PAD_NAME[d] || ('pad' + d)} 已被别的线占用` : (WHY[n] || '本档位用不到')) + '）');
    }
    const missEl = $('sp-pinmap-miss');
    if (missEl) missEl.textContent = miss.length ? '图上没有出现的线：' + miss.join('；') : '';
  }

  // ==================================================================== 配置

  async wrap(fn){
    try { await fn(); } catch (e){ this.session.log('e', e?.message || String(e), this.tag); }
  }

  async loadCfg(){
    await this.wrap(() => this.session.loadCfg({ tag: this.tag }));
  }

  readCfgFromUI(){
    let activeLow = 0;
    if ($('sp-al-dc').checked) activeLow |= 1 << P.LINE.DC;
    if ($('sp-al-rst').checked) activeLow |= 1 << P.LINE.RST;
    if (this._csAuxLow) activeLow |= 1 << P.LINE.CS_AUX;      // CS 辅助：UI 不显示，沿用读回来的
    if ($('sp-al-bl').checked) activeLow |= 1 << P.LINE.BL;
    return {
      sclkHz: +$('sp-sclk').value || 0,
      mode: +$('sp-mode').value || 0,
      bits: 8,
      csPolicy: +$('sp-cs').value || 0,
      txDmaThreshold: Math.max(0, Math.min(255, +$('sp-thr').value || 0)),
      padDc: +$('sp-pad-dc').value || 0,
      padRst: +$('sp-pad-rst').value || 0,
      padCsAux: this._padCsAux | 0,
      padBl: +$('sp-pad-bl').value || 0,
      padActiveLow: activeLow,
      padTe: this.session.cfg?.padTe ?? 0,
      flags: $('sp-clear').checked ? P.CFG_FLAG.CLEAR_ON_ENABLE : 0,
      outRingKb: this.session.cfg?.outRingKb ?? 16,
      inRingKb: this.session.cfg?.inRingKb ?? 8,
    };
  }

  async applyCfg(){
    await this.wrap(() => this.session.applyConfig(this.readCfgFromUI(), this.tag));
  }

  async setEnabled(on){
    await this.wrap(() => this.session.setEnabled(on, this.tag));
  }

  // ==================================================================== 通用命令表

  /**
   * 命令表按需增加行。每行的输入框用 `data-f` 标记字段，
   * 读的时候按行遍历 —— 行的顺序就是发送顺序。
   */
  buildCmdRows(n, { append = false } = {}){
    const body = $('sp-cmd-body');
    if (!append) body.replaceChildren();
    const start = body.children.length;
    n = Math.max(0, Math.min(n, 24 - start));
    const cell = f => `<td><input data-f="${f}" class="cell"></td>`;
    body.insertAdjacentHTML('beforeend', Array.from({ length: n }, (_, i) => `<tr data-row="${start + i + 1}">
      <td class="idx">${start + i + 1}</td>
      ${cell('cmd')}${cell('lines')}${cell('addrLen')}${cell('addr')}${cell('dummy')}${cell('rx')}
      <td><input data-f="tx" class="cell txcell" placeholder="${start + i === 0 ? '如 AA BB' : ''}" title="这条命令要发出去的数据（十六进制）。留空 = 只发 cmd / 地址相位"></td>
      <td class="res" data-f="res"></td></tr>`).join(''));
    // 线数是 1/2/4 三选一，用下拉比手输靠谱
    for (const inp of body.querySelectorAll('input[data-f="lines"]')){
      const sel = document.createElement('select');
      sel.dataset.f = 'lines'; sel.className = 'cell';
      for (const v of [1, 2, 4]) sel.appendChild(new Option(String(v), String(v)));
      inp.replaceWith(sel);
    }
    $('sp-cmd-add').disabled = body.children.length >= 24;
  }

  /** 读一行 → XFER 帧；空行（所有字段都空）返回 null */
  readCmdRow(tr){
    const get = f => tr.querySelector(`[data-f="${f}"]`)?.value ?? '';
    const raw = ['cmd', 'addr', 'dummy', 'rx', 'tx'].map(get).join('').trim();
    if (!raw) return null;
    const tx = parseHexBytes(get('tx'));
    const rxLen = Math.max(0, Math.min(504, +get('rx') || 0));
    const t = {
      cmd: parseHexByte(get('cmd'), 0),
      tcfg: 0, addrLen: Math.max(0, Math.min(4, +get('addrLen') || 0)),
      dummy: Math.max(0, Math.min(4, +get('dummy') || 0)),
      addr: Number(get('addr')) >>> 0, tx, rxLen,
      lines: +get('lines') || 1,
    };
    if (tx.length > P.XFER_TX_MAX) throw new Error(`第 ${tr.dataset.row} 行：tx 有 ${tx.length} B，超过单帧上限 ${P.XFER_TX_MAX} B`);
    if (tx.length && rxLen && tx.length !== rxLen) throw new Error(`第 ${tr.dataset.row} 行：全双工要求收发等长（tx=${tx.length} rx=${rxLen}）`);
    return t;
  }

  /** 表格 → items（含跨行 CS_HOLD 与速率路径）*/
  cmdItems(){
    const rows = [...$('sp-cmd-body').querySelectorAll('tr')];
    const holdAll = $('sp-cmd-cshold').checked;
    const path = $('sp-cmd-path').value;
    const out = [];
    for (const tr of rows){
      let t;
      try { t = this.readCmdRow(tr); }
      catch (e){ this.session.log('e', '通用命令表：' + e.message, this.tag); return null; }
      if (!t) continue;
      let tcfg = P.linesToTcfg(t.lines) | P.TC.CMD_EN;   // 表里第一列就是命令字节 → 总是发 cmd 相位
      if (t.addrLen > 0) tcfg |= P.TC.ADDR_EN;
      /**
       * 每行都带 RSP：结果列要能逐行显示 OK / 错误码。读数据本来就必须带（固件规定），
       * 写帧多花一个 8 B 应答，换来"哪一行出错"能直接看见 —— 值。
       */
      let flags = P.F.RSP;
      if (path === 'poll') flags |= P.F.NO_DMA;
      else if (path === 'dma') flags |= P.F.FORCE_DMA;
      out.push({
        type: P.T.XFER, flags,
        payload: P.xferPayload({ cmd: t.cmd, tcfg, addrLen: t.addrLen, dummy: t.dummy, addr: t.addr, tx: t.tx, rxLen: t.rxLen }),
        label: `行 ${tr.dataset.row}`, tr, rxLen: t.rxLen, txLen: t.tx.length,
      });
    }
    if (holdAll && out.length){
      // 整段一个 CS 窗口：前面都保持，末条释放
      out.forEach((x, i) => { x.flags |= (i === out.length - 1) ? P.F.CS_OFF : P.F.CS_HOLD; });
    }
    return out;
  }

  cmdClearResults(){
    for (const td of $('sp-cmd-body').querySelectorAll('td.res')){ td.textContent = ''; td.className = 'res'; }
  }

  async cmdSendAll(){
    const s = this.session;
    if (s.busy) return;
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    const items = this.cmdItems();
    if (!items) return;
    if (!items.length){ s.log('w', '通用命令表是空的（每行第一列填 cmd）', this.tag); return; }
    this.cmdClearResults();
    if (!s.enabled) s.log('w', '桥还没使能 —— 帧会被判 SB_E_DISABLED', this.tag);
    s.setBusy(true); this.refreshButtons();
    const t0 = performance.now();
    try {
      const r = await s.sendFrames(items.map(({ tr, rxLen, txLen, ...it }) => it), { tag: this.tag });
      let i = 0;
      for (const it of items){
        const res = r.rsps[i++];
        const td = it.tr.querySelector('td.res');
        if (!res) { td.textContent = '无应答'; td.className = 'res bad'; continue; }
        if (res.status !== P.ST.OK){ td.textContent = `${res.status}/${P.ST_TEXT[res.status] || '?'}`; td.className = 'res bad'; continue; }
        const d = res.data?.length ? ` · ${[...res.data.subarray(0, 4)].map(x => x.toString(16).padStart(2, '0')).join(' ')}${res.data.length > 4 ? '…' : ''}` : '';
        td.textContent = `OK${d}`;
        td.className = 'res ok';
      }
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      const expected = items.filter(x => x.flags & P.F.RSP).length;
      const missing = Math.max(0, expected - r.rsps.filter(Boolean).length);
      const dt = performance.now() - t0;
      s.log(bad || missing ? 'w' : 'g', `通用命令：发了 ${items.length} 条（${expected} 条带应答）· ${r.packs} 包 · ${dt.toFixed(0)} ms` +
        (bad ? ` · ${bad} 条非 OK` : '') + (missing ? ` · ${missing} 条没等到应答` : ''), this.tag);
    } catch (e){
      s.log('e', '通用命令发送失败：' + (e?.message || e), this.tag);
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  async simpleFrame(type, payload, label){
    try { return await this.session.sendFrames([{ type, payload, flags: P.F.RSP, label }], { tag: this.tag }); }
    catch (e){ this.session.log('e', `${label} 失败：` + (e?.message || e), this.tag); return null; }
  }

  /**
   * 辅助脚写。`level` 是**逻辑**电平（1 = 有效）：极性的取反在固件里做
   * （`sb_pad_write(pad, active_low ? !lvl : lvl)`），页面只管语义。
   */
  async sendGpio(line, level, label){
    await this.simpleFrame(P.T.GPIO, P.gpioPayload(line, level), label);
  }

  /** RST 脉冲（拉低 low ms + 等 post ms，固件侧非阻塞、有序）*/
  async sendRstPulse(){
    const low = Math.max(0, +$('sp-pin-rst-low').value || 0);
    const post = Math.max(0, +$('sp-pin-rst-post').value || 0);
    await this.simpleFrame(P.T.RESET, P.resetPayload(low, post), `RST 脉冲 ${low}+${post}ms`);
  }

  // ==================================================================== 手写多帧（DSL）

  dslLoadSample(){
    const name = $('sp-dsl-preset').value;
    const s = D.DSL_SAMPLES.find(x => x.name === name);
    if (s) $('sp-dsl-text').value = s.text;
  }

  /** 读 .c/.h/.txt/.json 进文本框；JSON 若是本站导出的形状就转回可读文本 */
  async dslLoadFile(file){
    if (!file) return;
    const s = this.session;
    try {
      const text = await file.text();
      const asDsl = file.name.toLowerCase().endsWith('.json') ? D.jsonToDsl(text) : null;
      $('sp-dsl-text').value = asDsl ?? text;
      s.log('i', `已读入 ${file.name}（${fmtBytes(text.length)}）` + (asDsl ? ' · 识别为本页导出的 JSON，已转成可读文本' : ''), this.tag);
      this.dslRun(false);
    } catch (e){
      s.log('e', '读文件失败：' + (e?.message || e), this.tag);
    } finally {
      $('sp-dsl-file-input').value = '';   // 同一个文件再选一次也要能触发
    }
  }

  /** 导出当前文本框解析出来的帧（解析不过就不导，免得导出半截东西）*/
  dslExport(kind){
    const s = this.session;
    const r = this.dslParse();
    if (r.errors.length){ s.log('e', `有 ${r.errors.length} 处语法错，先改好再导出`, this.tag); return; }
    if (!r.items.length){ s.log('w', '没有可导出的帧', this.tag); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const out = kind === 'c' ? { name: `spi-frames-${stamp}.c`, text: D.itemsToC(r.items) }
      : kind === 'json' ? { name: `spi-frames-${stamp}.json`, text: D.itemsToJson(r.items) }
      : { name: `spi-frames-${stamp}.txt`, text: D.itemsToDsl(r.items) };
    try {
      const url = URL.createObjectURL(new Blob([out.text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = out.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      s.log('g', `已导出 ${out.name}（${r.items.length} 条命令）`, this.tag);
    } catch (e){ s.log('e', '导出失败：' + (e?.message || e), this.tag); }
  }

  /** 解析 textarea → {items,errors,...}；把错误/摘要渲染出来。errors 非空时**不发**。*/
  dslParse(){
    const r = D.parseFrames($('sp-dsl-text').value);
    const body = $('sp-dsl-err');
    body.innerHTML = r.errors.map(e => `<tr class="bad"><td>${e.line}</td><td>${esc(e.text)}</td><td>${esc(e.msg)}</td></tr>`).join('');
    $('sp-dsl-errwrap').style.display = r.errors.length ? '' : 'none';
    for (const w of r.warns) this.session.log('w', 'DSL：' + w, this.tag);
    return r;
  }

  async dslRun(send){
    const s = this.session;
    const r = this.dslParse();
    if (r.errors.length){
      setStatus($('sp-dsl-sum'), `${r.errors.length} 处语法错（见下表），没有发送`, 'err');
      s.log('e', `手写多帧：${r.errors.length} 处语法错，第 ${r.errors[0].line} 行起 —— ${r.errors[0].msg}`, this.tag);
      return;
    }
    if (!r.items.length){ setStatus($('sp-dsl-sum'), '没有可发的帧', 'warn'); return; }
    const packs = P.packFrames(r.items.map(i => P.frame(i.type, i.payload, { flags: i.flags }))).length;
    const sum = `${r.items.length} 条帧 · payload ${r.stats.bytes} B · ${packs} 个 USB 包`;
    if (!send){ setStatus($('sp-dsl-sum'), `解析通过：${sum}`, 'ok'); s.log('g', `手写多帧解析通过：${sum}`, this.tag); return; }
    if (s.busy) return;
    if (!s.enabled) s.log('w', '桥还没使能 —— 帧会被判 SB_E_DISABLED', this.tag);
    s.setBusy(true); this.refreshButtons();
    const t0 = performance.now();
    try {
      const res = await s.sendFrames(r.items, { tag: this.tag });
      const expected = r.items.filter(i => i.flags & P.F.RSP).length;
      const got = res.rsps.filter(Boolean).length;
      const bad = res.rsps.filter(x => x && x.status !== P.ST.OK).length;
      const timeouts = Math.max(0, expected - got);
      const dt = performance.now() - t0;
      const text = `发完 ${res.sent}/${res.packs} 包 · ${r.items.length} 条帧（${expected} 条带应答）· ${dt.toFixed(0)} ms` +
        (bad ? ` · ${bad} 条非 OK` : '') + (timeouts ? ` · ${timeouts} 条没等到应答` : '');
      s.log(bad || timeouts ? 'w' : 'g', '手写多帧：' + text, this.tag);
      setStatus($('sp-dsl-sum'), text, bad || timeouts ? 'warn' : 'ok');
    } catch (e){
      s.log('e', '手写多帧发送失败：' + (e?.message || e), this.tag);
      setStatus($('sp-dsl-sum'), '发送失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== SPI / NOR Flash

  flMode(){ return FL.READ_MODES.find(m => m.v === (+$('sp-fl-mode').value || 0)) || FL.READ_MODES[0]; }
  /**
   * 「地址」格 → 数字。**严格解析，非法直接抛**（绝不悄悄变成 0）。
   *
   * 🚨 老实现是 `Number(v) >>> 0`，配着"帧里地址固定 3 字节"这两件事会咬人（2026-10 代码审查）：
   *     · 空串 / `abc` → 0（`NaN >>> 0`）；`4096.7` → 4096；`-1` → 0xFFFFFFFF；
   *     · ≥16 MB 的地址在线上回绕到低地址。
   *    擦除 / 编程 / 测速都直接吃这个值 —— 手一抖就把 0 号扇区（通常是启动代码）擦了。
   */
  flAddr(){
    const raw = String($('sp-fl-addr').value ?? '').trim();
    if (!raw) throw new Error('Flash 地址是空的：填 0x000000 ~ 0xFFFFFF（帧里地址固定 3 字节）');
    const m = /^(?:0[xX])?([0-9a-fA-F]+)$/.exec(raw);
    if (!m) throw new Error(`Flash 地址「${raw}」不是十六进制数（例：0x000000 / 800000）`);
    const v = parseInt(m[1], 16);
    if (v > FL.ADDR_MAX){
      throw new Error(`Flash 地址 0x${v.toString(16).toUpperCase()} 超过 3 字节上限 ` +
        `0x${FL.ADDR_MAX.toString(16).toUpperCase()} —— 帧里地址只有 3 字节，再大会回绕到低地址（会擦错地方）`);
    }
    return v;
  }
  flDummy(){ return Math.max(0, Math.min(4, +$('sp-fl-dummy').value || 0)); }

  flOut(text, kind = ''){
    const el = $('sp-fl-out');
    el.className = 'log' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  async flReadId(){
    const s = this.session;
    await this.wrap(async () => {
      const r = await s.sendFrames(FL.rdidItems(), { tag: this.tag });
      const d = r.rsps[0]?.data;
      if (!d || d.length < 3) throw new Error('没读到 3 字节 ID（接线 / 使能 / CS 策略先确认）');
      const j = FL.parseJedec(d);
      s.log('g', `Flash JEDEC ID = ${j.hex} → ${j.text}`, this.tag);
      this.flOut(`ID  ${j.hex}\n${j.text}`, 'ok');
    });
  }

  /**
   * 读 SFDP：**只出原始数据**（2026-10 用户现场要求：把后面的解读去掉）。
   *
   * 依据：JESD216 规定 SFDP 是 **256 B 只读区**，一次读满就拿到了全部信息；
   * "这张表是什么、BFPT 那几个 DWORD 什么含义"让使用者按 JESD216 表 2 自己查，
   * 页面上不再做解读。（`flash.js` 里的 parseSfdp / parseBfpt 保留给离线分析与自测用。）
   *
   * dummy 那一步是**链路标定**不是解读：JESD216 规定 `0x5A` 要 **8 拍 dummy**（= dummy 档 1），
   * 所以**先按 1 试**（不管面板上填的是几），不成再依次试面板值 / 0 / 2 / 3 / 4。
   */
  async flReadSfdp(){
    const s = this.session;
    await this.wrap(async () => {
      const tried = [];
      let dummy = this.flDummy(), got = false;
      for (const d of [1, dummy, 0, 2, 3, 4]){
        if (tried.includes(d)) continue;
        tried.push(d);
        const r = await s.sendFrames(FL.sfdpHeadItems(d), { tag: this.tag, quiet: tried.length > 1 });
        const bytes = r.rsps[0]?.data;
        if (FL.hasSfdpMagic(bytes)){ got = true; dummy = d; break; }
        if (tried.length === 1) s.log('w', `SFDP 签名不是 "SFDP"（dummy=${d}）：${bytes ? hexDump(bytes) : '没读到数据'} —— 换 dummy 再试`, this.tag);
      }
      if (!got) throw new Error('dummy 0~4 都试过，SFDP 签名仍不对（接线 / 器件 / 供电先确认）');
      if (dummy !== this.flDummy()){
        $('sp-fl-dummy').value = String(dummy);
        s.log('g', `SFDP 用 dummy=${dummy} 读出签名 —— 已把面板上的 dummy 改成 ${dummy}`, this.tag);
      }
      const full = await s.sendFrames(FL.sfdpFullItems(dummy), { tag: this.tag });
      const raw = full.rsps[0]?.data;
      if (!raw?.length) throw new Error('SFDP 整片读没拿到数据（链路先确认）');
      const lines = [`SFDP 原始 ${raw.length} B（dummy=${dummy}）—— 解读按 JESD216 表 2 查：`, ''];
      lines.push(...hexDump(raw).split('\n').map(l => '  ' + l));
      this.flOut(lines.join('\n'), 'ok');
      s.log('g', `Flash SFDP：读到 ${raw.length} B 原始数据（dummy=${dummy}）`, this.tag);
    });
  }

  async flReadStatus(){
    const s = this.session;
    await this.wrap(async () => {
      const r = await s.sendFrames([...FL.rdsr1Items(), ...FL.rdsr2Items()], { tag: this.tag });
      const sr1 = r.rsps[0]?.data ? FL.parseStatus1(r.rsps[0].data) : null;
      const sr2 = r.rsps[1]?.data ? FL.parseStatus2(r.rsps[1].data) : null;
      if (!sr1) throw new Error('没读到 SR1');
      s.log('g', `Flash SR1 = ${sr1.text}` + (sr2 ? ` · SR2 = ${sr2.text}` : ''), this.tag);
      this.flOut(`SR1  ${sr1.text}\nSR2  ${sr2 ? sr2.text : '（没读到）'}`, sr1.busy ? 'warn' : 'ok');
    });
  }

  flWiring(){
    this.flOut([
      '外接 SPI NOR 接线（探针 J3 排针，2026-09-30 起桥在 SPI2）：',
      '  CS   ← J3[26]  PB10（CS 策略 0 = 固件自动拉/放）',
      '  SCLK ← J3[13]  PB11',
      '  IO0  ← J3[28]  PB13（1 线时的 MOSI）',
      '  IO1  ← J3[27]  PB12（1 线时的 MISO）',
      '  IO2  ← J3[10]  PB14（四线才接）',
      '  IO3  ← J3[8]   PB15（四线才接）',
      '  VCC / GND 按模块电压；WP# 与 HOLD# 上拉到 VCC',
      '',
      '四线读还要器件侧 QE=1（多数片子是 SR2 的 bit1）：先「读状态」看一眼。',
    ].join('\n'));
  }

  /** 读一段：按当前模式/地址/长度拆帧（大块走连续读）*/
  async flRead(len, opts = {}){
    const s = this.session;
    const mode = opts.mode ?? this.flMode();
    const addr = opts.addr ?? this.flAddr();
    const n = len ?? Math.max(1, Math.min(1 << 16, +$('sp-fl-len').value || 256));
    const items = FL.readItems(addr, n, { mode: mode.v, dummy: this.flDummy() });
    const r = await s.sendFrames(items, { tag: this.tag, quiet: !!opts.quiet, onProgress: opts.onProgress });
    const out = new Uint8Array(n);
    let off = 0, bad = 0;
    for (const x of r.rsps){
      if (!x || x.status !== P.ST.OK){ bad++; continue; }
      const take = Math.min(x.data.length, n - off);
      out.set(x.data.subarray(0, take), off); off += take;
    }
    this.lastRead = out.subarray(0, off);
    return { bytes: this.lastRead, off, bad, items: items.length };
  }

  async flReadUI(){
    const s = this.session;
    await this.wrap(async () => {
      const t0 = performance.now();
      const r = await this.flRead();
      const dt = performance.now() - t0;
      if (r.bad) throw new Error(`${r.bad} 条帧不是 OK`);
      const mode = this.flMode();
      s.log('g', `Flash 读 ${r.off} B @0x${this.flAddr().toString(16)} · ${mode.name.split(' · ')[0]} · ${dt.toFixed(1)} ms · ${rate(r.off, dt)}`, this.tag);
      this.flOut(`地址 0x${this.flAddr().toString(16)}  长度 ${r.off} B  ${dt.toFixed(1)} ms  ${rate(r.off, dt)}\n` +
        hexDump(r.bytes.subarray(0, 96)) + (r.bytes.length > 96 ? '\n…' : ''), 'ok');
    });
  }

  /**
   * 连续读测速：读 N KB，报 MB/s 与"理论值占比"。
   * 理论值 = 实际 SCLK ÷ 8 × 线数（四线时数据相位一拍 4 bit）—— 拿它当分母才知道差在哪。
   */
  async flBench(){
    const s = this.session;
    const kb = Math.max(1, Math.min(4096, +$('sp-fl-benchkb').value || 64));
    const n = kb * 1024;
    if (s.busy) return;
    s.setBusy(true); this.refreshButtons();
    const mode = this.flMode();
    const addr = this.flAddr();
    try {
      s.log('i', `读测速：${kb} KB @0x${addr.toString(16)} · ${mode.name}`, this.tag);
      const t0 = performance.now();
      const r = await this.flRead(n, { onProgress: (done, total) => {
        if (done === total || done % 64 === 0) this.flOut(`读测速 ${done}/${total} 包…`);
      } });   // dummy 由 flRead 内部取面板上的值（见 flRead）
      const dt = performance.now() - t0;
      if (r.bad) throw new Error(`${r.bad} 条帧不是 OK（读失败了，先「读 ID / SFDP」确认链路）`);
      const sclk = s.counters?.actualSclkHz || s.cfg?.sclkHz || 0;
      const theo = sclk ? sclk / 8 * (mode.lines >= 4 ? 4 : mode.lines) : 0;   // B/s
      const theo1 = sclk ? sclk / 8 : 0;                                       // 1 线时的上限（B/s）
      const eff = theo ? (r.off / (dt / 1000)) / theo * 100 : 0;
      /**
       * 🚨 只有**四线**档要提醒（IO2/IO3）：标准 SPI 接法本来就有 IO0/IO1，
       *    2 线的 DUAL OUT 0x3B **能直接用**（用户 2026-09-30 纠正过：当时我误把
       *    "1 线接法" 当成了 2 线也不能用）。
       *    四线档则要看 IO2/IO3 有没有接上 —— 接不上就是垃圾数据。
       */
      const quad = mode.lines >= 4;
      const line = `${kb} KB 用时 ${dt.toFixed(1)} ms → ${rate(r.off, dt)}` +
        (theo ? `（实际 SCLK ${P.sclkLabel(sclk)} 理论上限 ${(theo / 1e6).toFixed(2)} MB/s，实测占 ${eff.toFixed(0)}%）` : '') +
        (quad ? `　⚠ 本档是 4 线数据相位，要 IO2/IO3 都接上；只接了 1 线（MOSI/MISO）的话读回是垃圾。` +
                `2 线的 DUAL OUT 0x3B 只用 IO0/IO1，1 线接法就能用（上限 ${(theo1 / 1e6 * 2).toFixed(2)} MB/s）` : '');
      s.log(eff && eff < 45 ? 'w' : 'g', '读测速：' + line, this.tag);
      if (eff && eff < 45) s.log('w', '占理论值不到一半：检查 ①CS_HOLD 连续读有没有生效 ②每帧 492 B 有没有被拆小 ③线数/模式是否与器件匹配', this.tag);
      this.flOut(`读测速  ${mode.name}\n${line}`, eff && eff < 45 ? 'warn' : 'ok');
    } catch (e){
      s.log('e', '读测速失败：' + (e?.message || e), this.tag);
      this.flOut('读测速失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  /** 等器件 BUSY 清掉（短等待走 pace.js，页面不可见时不会被浏览器钳到 1 s）*/
  async flWaitReady(timeoutMs = 4000){
    const t0 = performance.now();
    let last = null;
    while (performance.now() - t0 < timeoutMs){
      const r = await this.session.sendFrames(FL.rdsr1Items(), { tag: this.tag, quiet: true });
      last = r.rsps[0]?.data ? FL.parseStatus1(r.rsps[0].data) : null;
      if (last && !last.busy) return { ok: true, ms: performance.now() - t0, sr: last };
      await waitMs(2);
    }
    return { ok: false, ms: performance.now() - t0, sr: last };
  }

  flFillPattern(){
    const n = Math.max(1, Math.min(4096, +$('sp-fl-len').value || 256));
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = i & 0xff;
    $('sp-fl-data').value = [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
  }

  async flErase(){
    const s = this.session;
    if (!this.flArmed()) return;
    const mode = FL.ERASE_MODES.find(m => m.v === (+$('sp-fl-erase-mode').value || 0)) || FL.ERASE_MODES[0];
    const addr = this.flAddr();
    if (mode.size === 0 && !confirm(`整片擦除会把整颗 flash 清成 0xFF，确定？`)) return;
    if (s.busy) return;
    s.setBusy(true); this.refreshButtons();
    try {
      s.log('i', `擦除：${mode.name} @0x${addr.toString(16)}`, this.tag);
      const t0 = performance.now();
      await s.sendFrames(FL.eraseItems(addr, { opcode: mode.v }), { tag: this.tag });
      const w = await this.flWaitReady(12000);
      const dt = performance.now() - t0;
      if (!w.ok) throw new Error('等 BUSY 超时（器件一直忙？）');
      s.log('g', `擦除完成：${mode.size ? FL.fmtSize(mode.size) : '整片'} @0x${addr.toString(16)} · ${dt.toFixed(0)} ms`, this.tag);
      this.flOut(`擦除完成  ${mode.name}\n地址 0x${addr.toString(16)}（扇区对齐 0x${FL.sectorOf(addr).toString(16)}）  用时 ${dt.toFixed(0)} ms`, 'ok');
    } catch (e){
      s.log('e', '擦除失败：' + (e?.message || e), this.tag);
      this.flOut('擦除失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  flArmed(){
    if (!$('sp-fl-armed').checked){
      this.session.log('w', '先勾上「我确认要擦写这颗 flash」', this.tag);
      return false;
    }
    return true;
  }

  flWriteData(){
    /* 🚨 「留空 → 用 256 B 递增图案」这个兜底**只能**在用户真的什么都没填时生效。
     *    老写法是 `parseHexBytes(...)` 之后再判 `!bytes.length`，而那时的解析器会把非法字符
     *    删光 —— 于是框里填了一堆乱码（`zzz`）也会落进这个分支，**把 256 B 图案写进 flash**
     *    （2026-10 代码审查）。解析器现在对非法字符直接抛错，这里判空只看原始文本。 */
    const raw = String($('sp-fl-data').value ?? '').trim();
    if (!raw){
      const n = 256;
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = i & 0xff;
      this.session.log('i', '写数据留空 → 用 256 B 递增图案', this.tag);
      return bytes;
    }
    const bytes = parseHexBytes(raw);          // 非法字符在这里抛错，不会静默变成空
    if (bytes.length > 4096) throw new Error('一次最多写 4 KB（收到 ' + fmtBytes(bytes.length) + '）');
    return bytes;
  }

  /**
   * 按页写 + 回读校验。页间用有序 DELAY 等 tPP（见 flash.js 的说明），
   * 写完再等一次 BUSY、然后把同一段读回来逐字节比 —— **写完必须验**，不然"成功"是假的。
   */
  async flWrite(){
    const s = this.session;
    if (!this.flArmed() || s.busy) return;
    let data;
    try { data = this.flWriteData(); }
    catch (e){ s.log('e', '写数据有问题：' + e.message, this.tag); return; }
    const addr = this.flAddr();
    const tpp = Math.max(0, Math.min(100, +$('sp-fl-tpp').value || 0));
    s.setBusy(true); this.refreshButtons();
    try {
      const pages = FL.programPages(addr, data).length;
      s.log('i', `编程 ${data.length} B @0x${addr.toString(16)}（${pages} 页，页间等 ${tpp} ms）`, this.tag);
      const t0 = performance.now();
      const r = await s.sendFrames(FL.programItems(addr, data, { pageDelayMs: tpp }), { tag: this.tag, quiet: true });
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      const noRsp = r.rsps.filter(x => !x).length;
      const w = await this.flWaitReady(8000);
      const dt = performance.now() - t0;
      if (bad || noRsp) throw new Error(`${bad} 条非 OK / ${noRsp} 条没应答`);
      const vr = await this.flRead(data.length, { quiet: true });
      const same = bytesEqual(vr.bytes, data);
      s.log(same ? 'g' : 'e', `写 + 校验：${data.length} B · ${dt.toFixed(0)} ms · ${rate(data.length, dt)} · ` +
        (same ? '回读一致 ✔' : `回读不一致（前 16 B：${hexDump(vr.bytes.subarray(0, 16))}）`), this.tag);
      if (!same) s.log('w', `不一致的常见原因：` +
        `① 读模式的线数 / dummy 与接线或器件不匹配（当前 ${this.flMode().name}、dummy ${this.flDummy()}）—— ` +
        `四线档要 IO2/IO3 都接；dual 只用 IO0/IO1 能用，但 dummy 随器件不同（同一颗兼容片实测 0x3B 要 dummy=2）；` +
        `② 页间等 tPP 太短（现在 ${tpp} ms，试着加大）；③ 没先擦除（NOR 只能 1→0）；④ 地址写到了别处`, this.tag);
      this.flOut(`写 + 校验  ${data.length} B @0x${addr.toString(16)}\n${pages} 页 · ${dt.toFixed(0)} ms · ${rate(data.length, dt)}\n回读${same ? '一致 ✔' : '不一致 ✘'}` +
        (same ? '' : `\n写：${hexDump(data.subarray(0, 24))}\n读：${hexDump(vr.bytes.subarray(0, 24))}`), same ? 'ok' : 'err');
    } catch (e){
      s.log('e', '编程失败：' + (e?.message || e), this.tag);
      this.flOut('编程失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  /** 写测速：先擦掉目标区，再按页写满并回读校验，报 MB/s（擦除时间分开算）*/
  async flWriteBench(){
    const s = this.session;
    if (!this.flArmed() || s.busy) return;
    const kb = Math.max(1, Math.min(64, +$('sp-fl-benchkb').value || 16));
    const n = kb * 1024;
    const addr = this.flAddr();
    const tpp = Math.max(0, Math.min(100, +$('sp-fl-tpp').value || 0));
    if (confirm(`写测速会把 0x${addr.toString(16)} 起的 ${kb} KB 先擦掉再写入（破坏原有数据），继续？`) === false) return;
    s.setBusy(true); this.refreshButtons();
    try {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 31 + 7) & 0xff;
      s.log('i', `写测速：先擦 0x${addr.toString(16)} 起 ${kb} KB`, this.tag);
      const tErase0 = performance.now();
      /* 🚨 擦除序列有两个坑（2026-10 代码审查，两个都会让"已经擦干净了"变成假的）：
       *   ① 老代码先单独擦一次 addr，循环里又从 addr+0 擦一遍 —— 第一条就让器件忙起来，
       *      后面几条**在 BUSY 期间全被忽略**（NOR 忙时只认 RDSR 之类的读命令），
       *      于是只有扇区 0 真被擦了，后面几个扇区还是旧数据 → 回读不一致，
       *      而日志会把它归因成「tPP 太短」，方向完全错；
       *   ② 每条 SE 之间不等 BUSY。扇区擦除要几十~几百 ms，连发等于白发。
       *   现在：按扇区走（一直到 `addr+n-1` 所在的扇区，起始地址不对齐时也不会漏最后一个），
       *   并且**每条之后都等 BUSY 清**再发下一条。 */
      const lastSec = FL.sectorOf(addr + n - 1);
      for (let a = FL.sectorOf(addr); a <= lastSec; a += FL.SECTOR_SIZE){
        await s.sendFrames(FL.eraseItems(a, { opcode: FL.OP.SE }), { tag: this.tag, quiet: true });
        const w = await this.flWaitReady(20000);
        if (!w.ok) throw new Error(`擦除扇区 0x${a.toString(16)} 等 BUSY 超时（器件一直忙？）`);
      }
      const tErase = performance.now() - tErase0;
      const t0 = performance.now();
      const r = await s.sendFrames(FL.programItems(addr, data, { pageDelayMs: tpp }), { tag: this.tag, quiet: true });
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      await this.flWaitReady(20000);
      const dt = performance.now() - t0;
      if (bad) throw new Error(`${bad} 条非 OK`);
      const vr = await this.flRead(n, { quiet: true });
      const same = bytesEqual(vr.bytes, data);
      const line = `${kb} KB 写入 ${dt.toFixed(0)} ms → ${rate(n, dt)}（擦除另用 ${tErase.toFixed(0)} ms）· 回读${same ? '一致 ✔' : '不一致 ✘'}`;
      s.log(same ? 'g' : 'e', '写测速：' + line, this.tag);
      if (!same) s.log('w', `页间等 tPP=${tpp} ms 可能太短，加大再试`, this.tag);
      this.flOut('写测速  ' + line, same ? 'ok' : 'err');
    } catch (e){
      s.log('e', '写测速失败：' + (e?.message || e), this.tag);
      this.flOut('写测速失败：' + (e?.message || e), 'err');
    } finally {
      s.setBusy(false); this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== 回环自检

  /**
   * MOSI↔MISO 跳线回环扫描（J3[28]-J3[27]，SPI2）：
   * 每个长度都跑 tx_len == rx_len 的全双工读回并逐字节比对；
   * `FORCE_DMA` 那一档用来对照（P1 固件两条路径都计入 tx_poll，见方案 §2.3 第 7 条）。
   */
  async loopbackTest(){
    const s = this.session;
    if (s.busy) return;
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    if (!s.enabled) s.log('w', '桥还没使能 —— 先点「使能」，否则帧会被判 SB_E_DISABLED', this.tag);

    const lens = String($('sp-lb-lens').value || '').split(/[,\s]+/).map(x => +x).filter(n => n > 0 && n <= P.XFER_TX_MAX);
    const lines = +$('sp-lb-lines').value || 1;
    const modes = $('sp-lb-dma').checked ? [['轮询', 0], ['强制DMA', P.F.FORCE_DMA]] : [['轮询', 0]];
    if (!lens.length){ s.log('e', '长度列表是空的', this.tag); return; }

    s.setBusy(true); this.loopAbort = false; this.loopRunning = true; this.refreshButtons();
    const t0 = performance.now();
    const rows = [];
    this.loopRows = rows;
    const total = lens.length * modes.length;
    this.renderRunPill('loop', `▶ 回环自检 0/${total}`);
    s.log('i', `回环自检开始：${lines} 线 · ${lens.length} 个长度 × ${modes.length} 种路径` +
      (s.usingMock ? '（假探针：读回 = 发出去的字节）' : '（真机需要 J3[28]↔J3[27] 跳线）'), this.tag);
    try {
      for (const len of lens){
        for (const [name, force] of modes){
          if (this.loopAbort) break;
          const tx = new Uint8Array(len);
          for (let i = 0; i < len; i++) tx[i] = (i * 7 + len) & 0xff;
          let status = -1, back = null, err = '';
          try {
            const r = await s.sendFrames([{
              type: P.T.XFER,
              payload: P.xferPayload({ tcfg: P.linesToTcfg(lines), tx, rxLen: len }),
              flags: P.F.RSP | force,
              label: `loop len=${len}`,
            }], { quiet: true, tag: this.tag });
            const res = r.rsps[0];
            if (res){ status = res.status; back = res.data; } else err = '无应答（超时）';
          } catch (e){ err = e?.message || String(e); }
          const good = status === 0 && back && back.length === len && bytesEqual(back, tx);
          rows.push({ len, mode: name, status, ok: good, err });
          s.log(good ? 'g' : 'e', `  len=${String(len).padStart(3)} ${name.padEnd(6)} ` +
            (good ? 'PASS' : `FAIL${err ? ' · ' + err : ` · status=${status}/${P.ST_TEXT[status] || '?'}`}`), this.tag);
          this.renderLoopRows(rows);
          // 胶囊跟着走：切到别的 tab 也看得到进度（tab 栏那一行不属于任何 tab）
          this.renderRunPill('loop', `▶ 回环自检 ${rows.length}/${total}` + (this.loopAbort ? ' · 正在中止…' : ''));
          await yieldTask();
        }
        if (this.loopAbort) break;
      }
    } finally {
      this.loopRunning = false;
      s.setBusy(false); this.refreshButtons();
    }
    const pass = rows.filter(r => r.ok).length;
    s.log(pass === rows.length ? 'g' : 'e',
      `回环自检${this.loopAbort ? '（已中止）' : '完成'}：${pass}/${rows.length} PASS · ${(performance.now() - t0).toFixed(0)} ms` +
      (pass === rows.length ? '' : '（检查跳线 / 使能状态 / SCLK 档位）'), this.tag);
    this.renderLoopRows(rows);
    this.renderRunPill('done', `回环 ${pass}/${rows.length} PASS` + (this.loopAbort ? '（已中止）' : ''));
    await s.pollStatus(true);
  }

  renderLoopRows(rows){
    this.loopRows = rows || [];
    $('sp-lb-body').innerHTML = this.loopRows.map(r => `<tr class="${r.ok ? 'ok' : 'bad'}"><td>${r.len}</td><td>${r.mode}</td>` +
      `<td>${r.ok ? 'PASS' : 'FAIL'}</td><td>${r.err || (r.status === 0 ? 'OK' : `${r.status}/${P.ST_TEXT[r.status] || '?'}`)}</td></tr>`).join('');
    const pass = this.loopRows.filter(r => r.ok).length;
    setStatus($('sp-lb-sum'), this.loopRows.length ? `${pass}/${this.loopRows.length} PASS` : '未跑',
      this.loopRows.length ? (pass === this.loopRows.length ? 'ok' : 'err') : '');
  }

  // ==================================================================== 生命周期

  onShow(){
    this.renderLogFromRing();
    this.refreshButtons();
    this.syncRunPill();
    this.session.pollStatus(true);
  }

  summary(){ return this.session.summary(); }
}
