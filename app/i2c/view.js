/**
 * 「USB→I2C」页（`#i2c`）—— 只管 DOM。协议/会话/执行器都在各自的模块里。
 *
 * 右列是一个**带 tab 的面板**（照「调试器」页 `#tab-dbg` 的 `.docktabs` / `.dockpage` 那套）：
 *   [扫描总线] [命令表] [脚本] [实时值]        + 运行胶囊 / 停止
 * 下面常驻**日志**（可拖高）与统计条。
 * 为什么是 tab：原来五张卡片纵向堆在一个滚动区里、每张被迫限高（命令表只能看见 7 行、
 * 脚本框一屏就满），而且"正在跑的结果"和"实时值"永远没法同屏。tab 化之后每块吃满高度；
 * 日志与运行状态**仍然常驻** —— 那是 tab 化之后唯一的过程视图，不能一起藏起来。
 *
 * 🚨 三条本项目的硬纪律（别改回去）：
 *   1. **DOM 只写在冷路径上**：表格结果列与实时值面板都用 rAF 合并（一帧最多刷一次），
 *      日志用 `appendLogLine`（滚动也是 rAF 合并的）。理由见 2026-10-01 的性能定标 ——
 *      在热路径里同步写可见元素一次就 ~5 ms，读 `scrollHeight` 一次 ~17 ms。
 *   2. **短等待用 pace.js**：页面里的轮询间隔走 `waitMs`，见 session.js。
 *   3. **隐藏 tab 里的画布量不到尺寸**：切到「实时值」时必须重画一次（`display:none` 时
 *      canvas 的 clientWidth 是 0，曲线会画成空白）；同理切回「命令表」要补一次结果 flush
 *      （浏览器会把隐藏页面的 rAF 降频甚至挂起）。
 */
import { $, appendLogLine, setStatus } from '../ui/dom.js';
import { PinMap } from '../ui/pin-map.js';
import { drawSpark } from '../ui/spark.js';
import { store } from '../core/store.js';
import { I2cSession } from './session.js';
import { RegView } from './reg-view.js';
import { ScriptRunner, buildTasks } from './runner.js';
import { PRESETS, presetById, DEFAULT_PRESET } from './presets.js';
import {
  parseScript, toCTable, toText, toJson, fromJson, describeItem, SYNTAX_HELP, KIND,
} from './dsl.js';
import { AS_HELP } from './expr.js';
import { RD_MAX, RD_TOTAL_MAX, hex2, hexBytes, addr7, guessDevice, errText, ticksToUs, addr7 as a7 } from './protocol.js';

const MAX_ROWS = 24;
const DOCKS = ['scan', 'cmd', 'reg', 'dsl', 'live'];
const OP_NAME = { rd: '读', wr: '写', ping: '探测', delay: '延时' };
/** 每种操作哪些格子可编辑（其余灰掉）—— 一格一格灰比塞四个下拉更省地方，也更不容易填错 */
const OP_CELLS = {
  rd:    { dev: 1, addr: 1, data: 0, rd: 1, as: 1, period: 1 },
  wr:    { dev: 1, addr: 1, data: 1, rd: 0, as: 0, period: 1 },
  ping:  { dev: 1, addr: 0, data: 0, rd: 0, as: 0, period: 1 },
  delay: { dev: 0, addr: 0, data: 1, rd: 0, as: 0, period: 1 },
};
const CELL_HINT = {
  rd:    { addr: '子地址（留空 = 不带子地址的纯读；`-` 同）', data: '', rd: `读几个字节（≤${RD_TOTAL_MAX}；超过 ${RD_MAX} 自动分片，想连续读加 ptr）`, as: 'as 解码', period: '周期，如 100ms / 100ms×50' },
  wr:    { addr: '子地址（留空 = 不带子地址）', data: '要写的十六进制字节，如 11 22 33（≤51 B，写不自动分片；留空 = 只把地址指针推过去）', rd: '', as: '', period: '周期，如 500ms×20' },
  ping:  { addr: '', data: '', rd: '', as: '', period: '' },
  delay: { addr: '', data: '时长，如 10ms / 500us', rd: '', as: '', period: '' },
};

const blankRow = (op = 'rd', dev = '0x50') => ({ op, dev, addr: '', data: '', rd: '', as: '', period: '' });

/** 读长格的内容 → `{ n, chunk }`（吃 `256`、`256 ptr`、`256ptr` 三种写法）*/
export function parseRdCell(v){
  const s = String(v ?? '').trim();
  const m = /^([0-9]+)\s*(ptr|chain)?$/i.exec(s);
  if (!m) return null;
  return { n: parseInt(m[1], 10), chunk: m[2] ? 'ptr' : 'reset' };
}

// ============================================================================
// 表格 ⇄ 脚本（纯函数，Node 自测直接打）
// ============================================================================

/** 周期格 → `every …` 片段；裸数字按 **ms**（表格是给人快速填的，不像脚本那样按 µs）*/
export function periodText(p){
  let s = String(p ?? '').trim();
  if (!s || s === '0' || /^once$/i.test(s)) return '';
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(us|µs|ms|s)?\s*(?:[x×*]\s*([0-9]+))?$/i.exec(s);
  if (!m) return `every ${s}`;                        // 形状不对就原样交给 DSL 报错，别在这儿吞掉
  const unit = m[2] || 'ms';                          // 表格里裸数字 = ms
  return `every ${m[1]}${unit}${m[3] ? ' ' + m[3] : ''}`;
}

const trimOr = (v, d = '') => (String(v ?? '').trim() || d);

/** 一行表格 → 一条 DSL 命令（`null` = 这一行跳过）*/
export function rowToLine(r){
  const op = r.op || 'rd';
  const dev = trimOr(r.dev);
  if (op !== 'delay' && !dev) return null;            // 器件格空 = 跳过该行
  const tail = [];
  if (trimOr(r.as)) tail.push('as ' + trimOr(r.as));
  const per = periodText(r.period);
  if (per) tail.push(per);
  const suffix = tail.length ? ' ' + tail.join(' ') : '';
  if (op === 'delay') return `delay ${trimOr(r.data, '10ms')}${suffix}`;
  if (op === 'ping') return `ping ${dev}${suffix}`;
  const addr = trimOr(r.addr, '-');
  if (op === 'wr') return `wr ${dev} ${addr}${trimOr(r.data) ? ' ' + trimOr(r.data) : ''}${suffix}`;
  // 读长格里可以带 ptr（`256 ptr` / `256ptr`）= 长读走"地址指针自增"连续读
  const cell = parseRdCell(r.rd);
  const n = cell ? cell.n : trimOr(r.rd, '1');
  const extra = cell?.chunk === 'ptr' ? ' ptr' : '';
  return `rd ${dev} ${addr} ${n}${suffix}${extra}`;
}

/** 整张表 → 脚本（这样才能保证表格与脚本区**走同一套解析与校验**，不会两处口径不一致）*/
export function tableToScript(rows){
  const L = ['# 由「通用命令（多行命令编辑区）」生成 —— 与表格逐行对应'];
  for (const r of rows){
    const line = rowToLine(r);
    if (line != null) L.push(line);
  }
  return L.join('\n') + '\n';
}

/** 解析出来的命令项 → 表格行（脚本区的「载入到命令表」）*/
export function rowsFromItems(items){
  const rows = [];
  for (const it of items){
    if (it.kind === KIND.SCAN) continue;              // 扫描不在表格里（有专门的按钮）
    const pts = it.period ? `${it.period}ms${it.count ? '×' + it.count : ''}` : '';
    if (it.kind === KIND.DELAY){
      rows.push({ op: 'delay', dev: '—', addr: '', data: `${it.ms}ms`, rd: '', as: '', period: pts });
      continue;
    }
    const addrTxt = it.addr.length ? it.addr.map(hex2).join(' ') : '';
    if (!it.addr.length && !it.wr.length && !it.rd){
      rows.push({ op: 'ping', dev: hex2(it.dev), addr: '', data: '', rd: '', as: it.asText || '', period: pts });
    } else if (it.wr.length || (it.addr.length && !it.rd)){
      rows.push({ op: 'wr', dev: hex2(it.dev), addr: addrTxt, data: it.wr.map(hex2).join(' '), rd: '', as: '', period: pts });
    } else {
      rows.push({
        op: 'rd', dev: hex2(it.dev), addr: addrTxt, data: '',
        rd: String(it.rd) + (it.rd > RD_MAX && it.chunk === 'ptr' ? ' ptr' : ''),
        as: it.asText || '', period: pts,
      });
    }
  }
  return rows.slice(0, MAX_ROWS);
}

// ============================================================================

export class I2cView {
  constructor(){
    this.session = new I2cSession();
    this.runner = new ScriptRunner(this.session, { onEvent: e => this._onRunEvent(e) });
    this.reg = new RegView({ session: this.session });   // 「寄存器」tab（读一段 → 改位 → 写回）
    this.rows = [blankRow('rd'), blankRow('rd'), blankRow('rd')];
    this.rowEls = [];
    this.results = new Map();          // 行号 → {text, cls}
    /** 实时值：name → {name, last, min, max, n, t0, buf:[]}（buf 是曲线用的环形采样）*/
    this.live = new Map();
    this.scanAddrs = [];
    this.bus = null;                   // ProbeBus（main.js 注入）
    this.dockTab = 'scan';             // 右列当前 tab（scan / cmd / dsl / live）
    this._liveDirty = false;
    this._tableDirty = false;
    this._t0 = performance.now();
  }

  // ==================================================================== 初始化

  init(){
    const s = this.session;
    this.pinMap=new PinMap({buttonId:'i2-pinmap-btn',feature:'i2c',state:()=>({connected:s.connected,connectionKey:s.hid?.device||s.hid,mock:s.usingMock,lost:s.lost})});
    this.pinMap.init();
    s.subscribe(this);
    this.reg.init();
    this._bindConn();
    this._bindDock();
    this._bindCfg();
    this._bindStatus();
    this._bindScan();
    this._bindTable();
    this._bindScript();
    this._bindLive();

    // 预设下拉
    const sel = $('i2-preset');
    for (const p of PRESETS){
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name; o.title = p.note;
      sel.appendChild(o);
    }
    sel.value = DEFAULT_PRESET.id;
    $('i2-dsl-text').value = DEFAULT_PRESET.text;
    $('i2-dsl-help').textContent = SYNTAX_HELP + '\n\n' + AS_HELP;
    this._renderTable();
    this._renderScan();
    this._renderLive();
    this._setState('未连接 —— 点「连接探针（授权）」授权 HID');
    // 🚨 初始也要过一遍按钮置灰：`_syncButtons` 挂在 'state' 事件上，而 `init()` 里这句
    //    是直接 `_setState` 的（不走事件）—— 不补这一下，页面刚打开时"扫描/发送"全是可点的，
    //    点了才发现没连探针（实测自测里就红在这条）。
    this._syncButtons({ connected: false, enabled: false });
    this._runPill('idle');
    this._dslSummary('未解析', '');
  }

  // ==================================================================== 局部 tab（右列）

  _bindDock(){
    const tabs = $('i2-dock-tabs');
    const btns = tabs ? [...tabs.querySelectorAll('button[data-dock]')] : [];
    for (const b of btns) b.addEventListener('click', () => this._dockSelect(b.dataset.dock));
    const saved = store.get('i2c.dock', 'scan');
    this._dockSelect(DOCKS.includes(saved) ? saved : 'scan', { save: false });

    // 运行胶囊 + 共享的「停止」（切到哪个 tab 都看得见、都能停）
    $('i2-run-stop').addEventListener('click', () => this._stopRun());

    // 日志高度可拖（存 localStorage；刷新后还在）
    const box = $('i2-logbox');
    const h = Number(store.get('i2c.logH', 0)) || 0;
    if (box && h > 0) box.style.height = Math.round(h) + 'px';
    this._bindGrip($('i2-grip-log'), {
      get: () => box?.getBoundingClientRect().height || 0,
      apply: v => { if (box) box.style.height = Math.round(v) + 'px'; },
      min: () => 72,
      max: () => Math.max(120, (document.querySelector('#tab-i2c .main')?.clientHeight || 700) - 220),
      save: v => store.set('i2c.logH', Math.round(v)),
    });
  }

  /** 切右列的 tab（照 #dbg 的 `_dockSelect`：只显示一个，选择记进 localStorage）*/
  _dockSelect(name, { save = true } = {}){
    const tabs = $('i2-dock-tabs');
    if (tabs) for (const b of tabs.querySelectorAll('button[data-dock]')) b.classList.toggle('on', b.dataset.dock === name);
    const box = $('i2-box-dock');
    if (box) for (const p of box.querySelectorAll('.dockpage')) p.classList.toggle('on', p.dataset.dock === name);
    this.dockTab = name;
    if (save) store.set('i2c.dock', name);
    // 刚显示出来的内容补一次刷新：隐藏的那段时间里如果**整个页面**也被切走了，
    // 浏览器会把 rAF 挂起 → 结果列/曲线可能停在旧值上（`display:none` 本身不影响 rAF，
    // 但"切页签回来"这种情况会）。补一次最省心。
    if (name === 'live'){ this._liveDirty = false; this._renderLive(); }
    if (name === 'cmd' && this._tableDirty){ this._tableDirty = false; this._flushTable(); }
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

  /**
   * tab 栏右边的**运行胶囊**：不管当前在哪个 tab，都看得见"定时任务还在跑 / 多少拍 / 失败几笔"。
   * 这是 tab 化之后唯一能跨 tab 传达运行状态的地方 —— 少了它，切到「脚本」改一行就忘了
   * 命令表还在 while(1)。
   */
  _runPill(kind, extra = ''){
    const el = $('i2-run-pill');
    const stop = $('i2-run-stop');
    if (!el) return;
    const st = this.runner.stats;
    if (kind === 'run'){
      const ticks = st?.ticks || 0;
      const errs = st?.errors || 0;
      el.className = 'hint dockrun ' + (errs ? 'err' : 'on');
      el.textContent = `▶ 运行中 · ${ticks} 拍 · 采样 ${st?.samples || 0} · 失败 ${errs}` + (extra ? ' · ' + extra : '');
      if (stop) stop.disabled = false;
    } else if (kind === 'stopping'){
      el.className = 'hint dockrun warn';
      el.textContent = '⏹ 正在停止…（等在飞的那一笔收尾）';
      if (stop) stop.disabled = true;
    } else if (kind === 'done'){
      el.className = 'hint dockrun';
      el.textContent = `已结束 · ${st?.ticks || 0} 拍 · 采样 ${st?.samples || 0} · 失败 ${st?.errors || 0}`;
      if (stop) stop.disabled = true;
    } else {
      el.className = 'hint dockrun';
      el.textContent = '未运行';
      if (stop) stop.disabled = true;
    }
  }

  onShow(){
    // 切回来时把日志全量重放（ring 里存着，切页不丢）
    const box = $('i2-log');
    box.innerHTML = '';
    for (const e of this.session.ring.slice(-200)) appendLogLine(box, e.text, e.kind, 500);
    // 页面整块被藏过一阵，隐藏期间的 rAF 可能没跑 → 补一次
    if (this._tableDirty){ this._tableDirty = false; this._flushTable(); }
    this._renderLive();
  }

  onSession(type, payload){
    if (type === 'log'){
      appendLogLine($('i2-log'), payload.text, payload.kind, 500);
    } else if (type === 'state'){
      this._setState(payload.text, payload.kind);
      this._syncButtons(payload);
    } else if (type === 'cfg'){
      this._showCfg(payload);
    } else if (type === 'status' || type === 'counters'){
      this._showStatus();
    }
  }

  _setState(text, kind){
    const state = $('i2-state');
    setStatus(state, text.startsWith('未连接 ——') && !kind ? '未连接' : text, kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : this.session.connected ? 'ok' : '');
    if (state) state.title = text;
    this.pinMap?.refresh();
  }
  _syncButtons(st){
    const on = st.connected;
    const pending = this._connecting || this._disconnecting || st.busy;
    $('i2-connect').disabled = (on && !st.lost) || pending;
    $('i2-choose').disabled = on || pending;
    $('i2-disconnect').disabled = !this.session.hid || pending;
    // ⚠️ 「只看解析」不在列表里：解析是纯本地的，没接探针也该能用（写了半段先核语法很常见）
    for (const id of ['i2-cfg-get', 'i2-cfg-set', 'i2-enable', 'i2-disable', 'i2-reset', 'i2-scan',
      'i2-pintest', 'i2-dbg', 'i2-cmd-send', 'i2-cmd-run', 'i2-dsl-send', 'i2-dsl-run']){
      const b = $(id);
      if (b) b.disabled = !on;
    }
    $('i2-info').textContent = on
      ? `${st.hidLabel || 'akaLinkPro'}${st.mock ? '（假探针）' : ''} · ${st.enabled ? '桥已使能' : '桥未使能'}`
      : '未连接';
    // 「寄存器」面板的按钮也跟着连接状态走（它自己还要管"有没有改动"）
    this.reg?.setEnabled(on);
  }

  // ==================================================================== 连接

  _bindConn(){
    $('i2-connect').addEventListener('click', async () => {
      return this._connect(null, $('i2-mock').checked);
    });
    $('i2-disconnect').addEventListener('click', async () => {
      if (this.session.busy) return;
      this._disconnecting = true; this._syncButtons(this.session.stateInfo());
      try { await this.session.disconnect(); }
      catch (e){ this.session.log('e', '关闭探针失败：' + e.message); this.session._setState('关闭探针失败：' + e.message, 'err'); }
      finally { this._disconnecting = false; this._syncButtons(this.session.stateInfo()); }
    });
    $('i2-choose').addEventListener('click', () => {
      $('i2-mock').checked = false;
      return this._connect(true, false);
    });
    $('i2-mock').addEventListener('change', async e => {
      this.session.log('dim', e.target.checked ? '已切到假探针模式 —— 点「连接探针」生效' : '已取消假探针模式 —— 点「连接探针」连真探针');
    });
  }

  async _connect(interactive, mock){
    this._connecting = true; this._syncButtons(this.session.stateInfo());
    try {
      if (interactive == null && !mock && this.session.lost){
        const connected = await this.session.reacquire();
        if (connected) this.session._setState(this.session.enabled ? '已连接（桥已使能）' : '已连接（桥未使能）');
        return connected;
      }
      return await this.session.connect(interactive, { mock, enable: true });
    } catch (e){ this.session.log('e', '连接失败：' + e.message); this.session._setState('连接失败：' + e.message, 'err'); return false; }
    finally { this._connecting = false; this._syncButtons(this.session.stateInfo()); }
  }

  // ==================================================================== 配置

  _bindCfg(){
    $('i2-cfg-get').addEventListener('click', () => this.session.loadCfg().catch(e => this.session.log('e', e.message)));
    $('i2-cfg-set').addEventListener('click', async () => {
      const cfg = this._formCfg();
      await this.session.applyCfg(cfg);
    });
  }

  _formCfg(){
    return {
      sclHz: parseInt($('i2-scl').value, 10) || 100000,
      pullup: $('i2-pullup').checked ? 1 : 0,
      retries: Math.max(0, Math.min(8, parseInt($('i2-retries').value, 10) || 0)),
    };
  }
  _showCfg(cfg){
    if (!cfg) return;
    $('i2-scl').value = String([100000, 400000, 1000000].includes(cfg.sclHz) ? cfg.sclHz
      : cfg.sclHz <= 100000 ? 100000 : cfg.sclHz <= 400000 ? 400000 : 1000000);
    $('i2-pullup').checked = !!cfg.pullup;
    $('i2-retries').value = String(cfg.retries ?? 0);
    // 桥没使能时固件回 actual_scl_hz = 0（真机实测）—— 别显示成"0 kHz"，那是"还没生效"的意思
    $('i2-scl-actual').textContent = !cfg.actualSclHz
      ? '实际生效：—（桥还没使能，先点上面「使能」）'
      : `实际生效：${(cfg.actualSclHz / 1000).toFixed(0)} kHz` +
        (cfg.actualSclHz !== cfg.sclHz ? `（请求的是 ${cfg.sclHz}，固件按档位取不超过它的最高档）` : '');
  }

  // ==================================================================== 状态

  _bindStatus(){
    $('i2-enable').addEventListener('click', () => this.session.setEnabled(true).catch(e => this.session.log('e', e.message)));
    $('i2-disable').addEventListener('click', () => this.session.setEnabled(false).catch(e => this.session.log('e', e.message)));
    $('i2-reset').addEventListener('click', () => this.session.busReset().catch(e => this.session.log('e', e.message)));
    $('i2-pintest').addEventListener('click', () => this.session.pinTest().catch(e => this.session.log('e', e.message)));
    $('i2-dbg').addEventListener('click', () => this.session.dbg().catch(e => this.session.log('e', e.message)));
  }

  _showStatus(){
    const st = this.session.status, c = this.session.counters;
    if (st){
      $('i2-word').textContent = '0x' + st.raw.toString(16).padStart(8, '0');
      $('i2-word-text').textContent = [
        st.enabled ? 'EN' : '未使能',
        st.pending ? 'PENDING(还在做)' : '',
        st.busOk ? '总线空闲' : '总线忙',
        `SDA=${st.sda ? 1 : 0}`, `SCL=${st.scl ? 1 : 0}`,
        st.lastErr ? `上次错误=${errText(st.lastErr)}` : '',
      ].filter(Boolean).join(' · ');
    }
    if (c){
      $('i2-c-ok').textContent = String(c.framesOk);
      $('i2-c-err').textContent = String(c.framesErr);
      $('i2-c-tx').textContent = c.bytesTx + ' B';
      $('i2-c-rx').textContent = c.bytesRx + ' B';
      $('i2-c-na').textContent = String(c.nackAddr);
      $('i2-c-nd').textContent = String(c.nackData);
      $('i2-c-to').textContent = String(c.timeouts);
      $('i2-c-rec').textContent = String(c.busRecover);
      $('i2-last-us').textContent = c.lastTicks ? ticksToUs(c.lastTicks).toFixed(0) : '—';
    }
  }

  // ==================================================================== 扫描

  _bindScan(){
    $('i2-scan').addEventListener('click', async () => {
      const btn = $('i2-scan');
      btn.disabled = true; btn.textContent = '扫描中…';
      try {
        const { addrs, ms } = await this.session.scan();
        this.scanAddrs = addrs;
        this._renderScan(ms);
      } catch (e){
        $('i2-scan-sum').textContent = '扫描失败：' + e.message;
      } finally {
        btn.disabled = false; btn.textContent = '扫描总线 0x08..0x77';
      }
    });
    $('i2-dev').addEventListener('change', () => { this._syncScanPick(); this.reg.setDevice($('i2-dev').value); });
  }

  _renderScan(ms){
    const body = $('i2-scan-body');
    body.innerHTML = '';
    const addrs = this.scanAddrs || [];
    const map = $('i2-address-map');
    map.replaceChildren();
    for (let a = 0; a < 128; a++){
      const button = document.createElement('button'), ack = addrs.includes(a), reserved = a < 8 || a > 0x77;
      button.type = 'button'; button.textContent = a.toString(16).toUpperCase().padStart(2, '0');
      button.dataset.address = addr7(a); button.className = ack ? 'ack' : reserved ? 'reserved' : '';
      button.disabled = !ack;
      button.title = `${addr7(a)} · ${reserved ? '保留地址，未扫描' : this.scanAddrs ? ack ? 'ACK，点击选用' : '无应答' : '未扫描'}`;
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => {
        $('i2-dev').value = addr7(a); this._syncScanPick(); this.reg.setDevice(addr7(a));
      });
      map.append(button);
    }
    $('i2-scan-sum').textContent = addrs.length
      ? `找到 ${addrs.length} 个器件${ms != null ? `（${ms.toFixed(0)} ms）` : ''}：` + addrs.map(a => addr7(a)).join(' ')
      : (ms != null ? '总线上一片安静 —— 没有任何地址应答。先跑「接线自检(PINTEST)」，再查供电 / 上拉 / 地址' : '还没扫过');
    for (const a of addrs){
      const tr = document.createElement('tr');
      const guess = guessDevice(a);
      tr.innerHTML = `<td><b>${addr7(a)}</b></td><td>${guess || '<span class="hint">（未知，可对照器件手册）</span>'}</td>`;
      const td = document.createElement('td');
      const b1 = document.createElement('button');
      b1.className = 'mini'; b1.textContent = '选用';
      b1.addEventListener('click', () => {
        $('i2-dev').value = addr7(a);
        this._syncScanPick();
        this.reg.setDevice(addr7(a));      // 「寄存器」面板也切到这个器件（省得两头填）
      });
      const b2 = document.createElement('button');
      b2.className = 'mini'; b2.textContent = '读 1 字节';
      b2.title = '往命令表插一行：读这个器件 0x00 起 1 字节';
      b2.addEventListener('click', () => { $('i2-dev').value = addr7(a); this._addRow(blankRow('rd', addr7(a))); });
      td.append(b1, b2);
      tr.appendChild(td);
      body.appendChild(tr);
    }
    this._syncScanPick();
  }
  _syncScanPick(){
    const v = $('i2-dev').value;
    for (const button of $('i2-address-map').children){
      button.classList.toggle('selected', !button.disabled && button.dataset.address.toLowerCase() === v.toLowerCase());
    }
    for (const tr of $('i2-scan-body').children){
      const hit = tr.firstChild.textContent === v;
      tr.classList.toggle('on', hit);
    }
  }

  // ==================================================================== 命令表

  _bindTable(){
    $('i2-cmd-add').addEventListener('click', () => this._addRow(blankRow('rd', $('i2-dev').value || '0x50')));
    $('i2-cmd-del').addEventListener('click', () => {
      if (this.rows.length <= 1) return;
      this.rows.pop(); this._renderTable();
    });
    $('i2-cmd-clearall').addEventListener('click', () => {
      this.rows = [blankRow('rd'), blankRow('rd'), blankRow('rd')];
      this.results.clear(); this._renderTable();
    });
    $('i2-cmd-clear').addEventListener('click', () => { this.results.clear(); this._renderTable(); });
    $('i2-cmd-send').addEventListener('click', () => this._runTable(false));
    $('i2-cmd-run').addEventListener('click', () => this._runTable(true));
  }

  _addRow(row){
    if (this.rows.length >= MAX_ROWS){
      this.session.log('warn', `命令表最多 ${MAX_ROWS} 行 —— 更长的序列请用「脚本」tab`);
      return;
    }
    // 新行的器件地址跟上一行走（顺着往下填一串寄存器时最省事），没有上一行才用扫描选中那个
    if (!row){
      const last = this.rows[this.rows.length - 1];
      row = blankRow('rd', trimOr(last?.dev) || trimOr($('i2-dev').value) || '0x50');
    }
    this.rows.push(row);
    this._renderTable();
  }

  /** 重建整张表（行数变化时才调用；改格子内容不会走这里）*/
  _renderTable(){
    const body = $('i2-cmd-body');
    body.innerHTML = '';
    this.rowEls = [];
    this.rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      const tdIdx = document.createElement('td');
      tdIdx.className = 'idx'; tdIdx.textContent = String(i + 1);
      tr.appendChild(tdIdx);

      const mk = (key, tag = 'input') => {
        let el;
        if (tag === 'select'){
          el = document.createElement('select');
          for (const [v, name] of Object.entries(OP_NAME)){
            const o = document.createElement('option');
            o.value = v; o.textContent = name;
            el.appendChild(o);
          }
        } else {
          el = document.createElement('input');
          el.className = 'cell';
        }
        el.dataset.k = key;
        el.addEventListener('change', () => { this._readRow(i); if (key === 'op') this._renderTable(); });
        el.addEventListener('input', () => this._readRow(i));
        if (key !== 'op') el.addEventListener('blur', () => { this._readRow(i); this._paintRow(i); });
        return el;
      };
      const cells = {
        op: mk('op', 'select'),
        dev: mk('dev'), addr: mk('addr'), data: mk('data'), rd: mk('rd'),
        as: mk('as'), period: mk('period'),
      };
      // 🚨 每个格子必须包一层 <td>：直接往 <tr> 上挂 <input>/<select> 的话，
      //    浏览器会把它们当"匿名单元格"处理，整行会**竖着堆起来**（实测踩过）。
      const td = child => { const c = document.createElement('td'); c.appendChild(child); return c; };
      tr.appendChild(td(cells.op));
      for (const k of ['dev', 'addr', 'data', 'rd', 'as', 'period']) tr.appendChild(td(cells[k]));
      const tdRes = document.createElement('td');
      tdRes.className = 'res'; tdRes.dataset.res = String(i);
      tr.appendChild(tdRes);

      this.rowEls.push({ tr, cells, tdRes });
      body.appendChild(tr);
      this._fillRow(i);
      this._paintRow(i);
    });
  }

  /** rows[i] → 表格格子的值 */
  _fillRow(i){
    const r = this.rows[i], e = this.rowEls[i];
    if (!r || !e) return;
    e.cells.op.value = r.op;
    for (const k of ['dev', 'addr', 'data', 'rd', 'as', 'period']) e.cells[k].value = r[k] ?? '';
    this._applyEnable(i);
  }
  /** 表格格子的值 → rows[i]（输入时实时收集，免得忘了 blur）*/
  _readRow(i){
    const r = this.rows[i], e = this.rowEls[i];
    if (!r || !e) return;
    for (const k of ['dev', 'addr', 'data', 'rd', 'as', 'period']) r[k] = e.cells[k].value;
    r.op = e.cells.op.value;
    this._applyEnable(i);
  }
  _applyEnable(i){
    const r = this.rows[i], e = this.rowEls[i];
    if (!r || !e) return;
    const mask = OP_CELLS[r.op] || OP_CELLS.rd;
    const hint = CELL_HINT[r.op] || {};
    for (const k of ['dev', 'addr', 'data', 'rd', 'as', 'period']){
      const on = !!mask[k];
      e.cells[k].disabled = !on;
      e.cells[k].placeholder = on ? (hint[k] || '') : '';
      e.cells[k].title = on ? (hint[k] || '') : `${OP_NAME[r.op]}操作不用这一格`;
    }
  }

  /** 行 → 脚本（一行），顺便把解析错误画在这一行的结果格里 */
  _rowScript(i){
    const r = this.rows[i];
    const line = rowToLine(r);
    if (line == null) return { skip: true };
    const res = parseScript(line);
    if (res.errors.length) return { error: res.errors[0].msg };
    return { item: res.items[0], warn: res.warns[0]?.msg };
  }

  _paintRow(i){
    const e = this.rowEls[i];
    if (!e) return;
    const td = e.tdRes;
    const r = this._rowScript(i);
    if (r.skip){
      td.className = 'res dim'; td.textContent = '（器件格空 —— 跳过）';
      return;
    }
    if (r.error){
      td.className = 'res bad'; td.textContent = '✗ ' + r.error;
      td.title = r.error;
      return;
    }
    const saved = this.results.get(i);
    if (saved){
      td.className = 'res ' + (saved.cls || '');
      td.textContent = saved.text;
      td.title = saved.title || saved.text;
      return;
    }
    td.className = 'res dim';
    td.textContent = r.warn ? '⚠ ' + r.warn : (r.item.period ? `待跑 · ${describeItem(r.item)}` : describeItem(r.item));
  }

  /** 表格里所有行 → 命令项（带行号，好把结果画回对应行）*/
  _tableItems(){
    const items = [], errs = [];
    this.rows.forEach((r, i) => {
      const res = this._rowScript(i);
      if (res.skip) return;
      if (res.error){ errs.push({ row: i + 1, msg: res.error }); return; }
      res.item.line = i + 1;
      items.push(res.item);
    });
    return { items, errs };
  }

  async _runTable(timedAlso){
    if (!this.session.connected){ this.session.log('e', '先连接探针'); return; }
    const { items, errs } = this._tableItems();
    if (errs.length){
      this.session.log('e', `命令表有 ${errs.length} 行填错了：` + errs.map(e => `第 ${e.row} 行 ${e.msg}`).join('；'));
      return;
    }
    const use = timedAlso ? items : items.filter(x => !x.period);
    if (!use.length){
      this.session.log('warn', timedAlso ? '命令表里没有可跑的行' : '命令表里全是带周期的行 —— 用「开始定时」跑它们');
      return;
    }
    this.results.clear();
    for (let i = 0; i < this.rows.length; i++) this._paintRow(i);
    await this._run(use, timedAlso ? '命令表（一次性 + 定时）' : '命令表（一次性）');
  }

  // ==================================================================== 脚本区

  _bindScript(){
    const ta = $('i2-dsl-text');
    $('i2-dsl-load').addEventListener('click', () => {
      const p = presetById($('i2-preset').value);
      if (!p) return;
      ta.value = p.text;
      this._dslSummary('已载入示例：' + p.name, 'ok');
      this._parseDsl({ quiet: true });
    });
    $('i2-dsl-file').addEventListener('click', () => $('i2-dsl-file-input').click());
    $('i2-dsl-file-input').addEventListener('change', async e => {
      const f = e.target.files?.[0];
      if (!f) return;
      const text = await f.text();
      const json = fromJson(text);
      ta.value = json ? toText(json) : text;
      this._dslSummary(json ? `已读入 JSON（${json.length} 条）` : `已读入文件 ${f.name}（${f.size} B）`, 'ok');
      e.target.value = '';
      this._parseDsl({ quiet: true });
    });
    $('i2-dsl-parse').addEventListener('click', () => this._parseDsl({ quiet: false }));
    $('i2-dsl-send').addEventListener('click', () => this._runScript(false));
    $('i2-dsl-run').addEventListener('click', () => this._runScript(true));
    $('i2-dsl-to-table').addEventListener('click', () => {
      const { items, errors } = parseScript(ta.value);
      if (errors.length){ this._showDslErrors(errors); this._dslSummary(`有 ${errors.length} 处语法错，先改掉`, 'err'); return; }
      const rows = rowsFromItems(items);
      if (!rows.length){ this._dslSummary('这段里没有能放进命令表的行（只有 scan / 循环标记？）', 'warn'); return; }
      this.rows = rows.slice(0, MAX_ROWS);
      this.results.clear();
      this._renderTable();
      this._dslSummary(`已载入 ${this.rows.length} 行进命令表${items.length > rows.length ? `（原有 ${items.length} 条，命令表上限 ${MAX_ROWS} 行）` : ''}`, 'ok');
    });
    $('i2-dsl-out-c').addEventListener('click', () => this._export('c'));
    $('i2-dsl-out-json').addEventListener('click', () => this._export('json'));
    $('i2-dsl-out-text').addEventListener('click', () => this._export('text'));
    $('i2-dsl-fromtable').addEventListener('click', () => {
      ta.value = tableToScript(this.rows);
      this._dslSummary('已把命令表（' + this.rows.length + ' 行）写成脚本', 'ok');
      this._parseDsl({ quiet: true });
    });
    $('i2-dsl-clear').addEventListener('click', () => { ta.value = ''; this._dslSummary('已清空', ''); this._showDslErrors([]); });
    $('i2-log-clear').addEventListener('click', () => { $('i2-log').innerHTML = ''; });
  }

  _parseDsl({ quiet = false } = {}){
    const text = $('i2-dsl-text').value;
    const res = parseScript(text);
    this._showDslErrors(res.errors);
    if (res.warns.length){
      for (const w of res.warns) this.session.log('warn', `脚本第 ${w.line} 行：${w.msg}（${w.text}）`);
    }
    const st = res.stats;
    const { tasks } = buildTasks(res.items);
    const summary = res.errors.length
      ? `✗ ${res.errors.length} 处语法错（见下面那张表）`
      : `${st.total} 条命令 · 一次性 ${st.oneShots} · 定时 ${st.timed}（${tasks.length} 个循环任务` +
        `${tasks.length ? '：' + tasks.map(t => `${t.items.length} 条@${t.period}ms${t.count ? `×${t.count}` : ''}`).join('、') : ''}）`;
    if (!quiet || res.errors.length) this._dslSummary(summary, res.errors.length ? 'err' : 'ok');
    return res;
  }

  _dslSummary(text, cls){
    const el = $('i2-dsl-sum');
    el.textContent = text;
    el.className = 'hint ' + (cls || '');
  }
  _showDslErrors(errors){
    const wrap = $('i2-dsl-errwrap'), body = $('i2-dsl-err');
    body.innerHTML = '';
    if (!errors?.length){ wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    for (const e of errors){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${e.line}</td><td><code>${escapeHtml(e.text || '')}</code></td><td>${escapeHtml(e.msg)}</td>`;
      body.appendChild(tr);
    }
  }

  _export(kind){
    const { items, errors } = parseScript($('i2-dsl-text').value);
    if (!items.length){
      this._dslSummary(errors.length ? '有语法错，先改掉' : '没有可导出的命令', errors.length ? 'err' : 'warn');
      return;
    }
    const text = kind === 'c' ? toCTable(items) : kind === 'json' ? toJson(items) : toText(items);
    // 直接下载一份（比"复制到剪贴板"稳妥：剪贴板权限在无头/CDP 下不一定给）
    const name = kind === 'c' ? 'i2c-table.c' : kind === 'json' ? 'i2c-script.json' : 'i2c-script.txt';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this._dslSummary(`已导出 ${name}（${items.length} 条）`, 'ok');
  }

  async _runScript(timedAlso){
    if (!this.session.connected){ this.session.log('e', '先连接探针'); return; }
    const res = this._parseDsl({ quiet: false });
    if (res.errors.length){ this.session.log('e', '脚本有语法错，先改掉再跑'); return; }
    const use = timedAlso ? res.items : res.items.filter(x => !x.period);
    if (!use.length){
      this.session.log('warn', timedAlso ? '脚本里没有可跑的命令' : '脚本里全是带周期的命令 —— 用「开始定时」跑它们');
      return;
    }
    if (!timedAlso && res.items.some(x => x.period)){
      this.session.log('dim', `「解析并发送」只跑一次性部分（${use.length} 条）；带周期的 ${res.items.length - use.length} 条请用「开始定时」`);
    }
    await this._run(use, timedAlso ? '脚本（一次性 + 定时）' : '脚本（一次性）');
  }

  // ==================================================================== 执行

  async _run(items, label){
    const btnRun = [$('i2-cmd-run'), $('i2-dsl-run'), $('i2-cmd-send'), $('i2-dsl-send')];
    this.live.clear();
    this._renderLive();
    this._runPill('run');
    try {
      this.session.log('g', `▶ 开始：${label} —— ${items.length} 条命令` +
        (items.some(x => x.period) ? '（带周期的会一直跑，记得点「停止」）' : ''));
      const r = await this.runner.run(items, { label });
      const s = r?.stats || {};
      this._runPill(r?.why === 'stopping' || r?.why === 'stopped' ? 'stopping' : 'done');
      this.session.log(r?.why === 'done' ? 'g' : 'warn',
        `■ 结束（${r?.why}）：一次性 ${s.once || 0} 条 · 循环 ${s.ticks || 0} 拍 · 采样 ${s.samples || 0} 个值 · 失败 ${s.errors || 0} 笔 · 用时 ${((r?.ms || 0) / 1000).toFixed(1)} s`);
      this._runPill('done');
    } catch (e){
      this.session.log('e', '执行出错：' + (e?.message || e));
      this._runPill('idle');
    } finally {
      for (const b of btnRun) b.disabled = false;
    }
  }
  _stopRun(){
    if (this.runner.stop()) this.session.log('warn', '⏹ 正在停止…（等在飞的那一笔收尾）');
    else this.session.log('dim', '当前没有在跑的任务');
  }

  /** 执行器事件 → 表格结果列 / 实时值 / 运行胶囊 / 日志 */
  _onRunEvent(e){
    switch (e.type){
      case 'start':
        if (e.tasks) this.session.log('dim', `定时任务 ${e.tasks} 个 —— 它们会各自按周期一直跑，直到点 tab 栏右边的「停止」`);
        this._runPill('run');
        break;
      case 'item': {
        const row = e.item.line != null ? e.item.line - 1 : -1;
        if (e.phase === 'begin'){
          this._setResult(row, '… 正在跑', 'dim');
          return;
        }
        if (e.phase === 'error'){
          this._setResult(row, '✗ ' + e.error, 'bad');
          return;
        }
        const ok = e.err === 0;
        if (e.item.kind === KIND.DELAY){
          this._setResult(row, `延时 ${e.ms} ms`, 'dim');
          return;
        }
        if (e.item.kind === KIND.SCAN){
          this._setResult(row, `扫到 ${e.addrs?.length ?? 0} 个器件（${(e.ms || 0).toFixed(0)} ms）`, 'ok');
          return;
        }
        const parts = [];
        if (ok){
          // 🚨 **解码值排在前面**：列宽有限，省略号会吃掉尾巴。传感器读数的重点就是
          //    ax/az/v 这些数（原始十六进制日志里有全文、hover 也有 title），所以先给值。
          const valTxt = e.values?.length ? e.values.map(v => `${v.name}=${v.text}`).join(' ') : '';
          const chunkTxt = e.chunks > 1 ? `（共 ${e.data?.length ?? 0} B · 分 ${e.chunks} 笔）` : '';
          const hexTxt = abbreviateHex(e.hex, e.chunks > 1 ? 12 : 0);
          parts.push([valTxt, hexTxt, chunkTxt].filter(Boolean).join('  '));
          parts.push(e.timeMs == null ? `${(e.ms || 0).toFixed(1)} ms` : 'probe 定时');
        } else parts.push('✗ ' + errText(e.err) + (e.failNote ? `（${e.failNote}）` : ''));
        this._setResult(row, parts.join(' · '), ok ? 'ok' : 'bad');
        if (ok && e.values?.length) for (const v of e.values) this._pushLive(v, e.timeMs);
        break;
      }
      case 'tick': {
        const row = e.task?.items?.[0]?.line != null ? e.task.items[0].line - 1 : -1;
        const per = e.task?.period || 0;
        const late = e.actualMs > per * 1.25;
        this._setTick(row, `第 ${e.n} 拍 · 实测 ${e.actualMs.toFixed(0)} ms` +
          (e.task?.count ? `/ ${e.task.count}` : '') + (late ? ` ⚠ 比设定 ${per}ms 慢` : ''), late ? 'warn' : 'dim');
        this._runPill('run');
        break;
      }
      case 'stopping':
        this._runPill('stopping');
        break;
      case 'end':
        for (const el of this.rowEls) el.tr.classList.remove('running');
        this._runPill('done');
        break;
      default: break;
    }
  }

  _setResult(row, text, cls){
    if (row >= 0) this.results.set(row, { text, cls, title: text });
    this._tableDirty = true;
    this._flushSoon();
  }
  /** 定时行的结果 + 拍数：拼在事务结果后面（不覆盖它）*/
  _setTick(row, text, cls){
    if (row >= 0){
      const prev = this.results.get(row) || { text: '', cls };
      this.results.set(row, { text: prev.text, tick: text, cls: prev.cls || cls, title: `${prev.text}\n${text}` });
    }
    this._tableDirty = true;
    this._flushSoon();
  }

  /** rAF 合并刷新（🚨 别在每条命令完成时同步刷 DOM —— 见文件头纪律）*/
  _flushSoon(){
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this._tableDirty){ this._tableDirty = false; this._flushTable(); }
      if (this._liveDirty){ this._liveDirty = false; this._renderLive(); }
    });
  }
  _flushTable(){
    for (let i = 0; i < this.rowEls.length; i++){
      const el = this.rowEls[i], td = el.tdRes;
      const r = this.results.get(i);
      if (!r) continue;
      td.className = 'res ' + (r.cls || '');
      td.textContent = r.text + (r.tick ? '   ⟳ ' + r.tick : '');
      td.title = r.title || r.text;
    }
  }

  // ==================================================================== 实时值

  _bindLive(){
    $('i2-live-reset').addEventListener('click', () => { this.live.clear(); this._renderLive(); });
    $('i2-live-spark').addEventListener('change', () => this._renderLive());
  }

  _pushLive(v, timeMs){
    if (!Number.isFinite(v.value)) return;
    const clock = timeMs == null ? 'host' : 'probe';
    let e = this.live.get(v.name);
    if (e?.clock !== clock) e = null;
    const now = timeMs == null ? performance.now() : e ? e.tLast + ((timeMs - e.rawTime) >>> 0) : timeMs;
    if (!e){ e = { name: v.name, clock, last: v.value, min: Infinity, max: -Infinity, n: 0, t0: now, tLast: now, buf: [] }; this.live.set(v.name, e); }
    e.rawTime = timeMs;
    e.last = v.value;
    if (v.value < e.min) e.min = v.value;
    if (v.value > e.max) e.max = v.value;
    e.n++;
    e.tLast = now;
    e.buf.push(v.value);
    if (e.buf.length > 120) e.buf.shift();
    this._liveDirty = true;
    this._flushSoon();
  }

  /**
   * 实测频率：按**首末两次采样之间**算，不是"到现在为止"。
   * 🚨 用 `performance.now() - t0` 当区间的话，跑停之后这个数会一直往下掉
   *    （实测跑完 5 秒还显示 15.5 Hz，而那一段本来是 20 Hz）—— 那是渲染时刻在变，
   *    不是采样变慢了。同理摘要里报"最快的那个"，不要拿第一个变量去代表全部。
   */
  _rateOf(e){
    if (!e || e.n < 2) return 0;
    const span = (e.tLast - e.t0) / 1000;
    return span > 0 ? (e.n - 1) / span : 0;
  }

  _renderLive(){
    const body = $('i2-live-body');
    const list = [...this.live.values()];
    const rates = list.map(e => this._rateOf(e));
    $('i2-live-sum').textContent = list.length
      ? `${list.length} 个变量 · 共 ${list.reduce((a, b) => a + b.n, 0)} 次采样 · 最快 ${Math.max(...rates).toFixed(1)} Hz`
      : '还没有数据 —— 跑一段带 `as` 解码的定时读（示例里的 MPU6050 / ADS1115）就有了';
    body.innerHTML = '';
    const spark = $('i2-live-spark').checked;
    for (const e of list){
      const tr = document.createElement('tr');
      const f = v => (Number.isFinite(v) ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : '—');
      const hz = this._rateOf(e);
      tr.innerHTML = `<td><b>${escapeHtml(e.name)}</b></td><td>${f(e.last)}</td><td>${f(e.min)}</td>` +
        `<td>${f(e.max)}</td><td>${e.n}</td><td>${hz > 0 ? hz.toFixed(1) + ' Hz' : '—'}</td>`;
      const td = document.createElement('td');
      if (spark){
        const cv = document.createElement('canvas');
        cv.width = 284; cv.height = 20; cv.className = 'spark';
        drawSpark(cv, e.buf);
        td.appendChild(cv);
      }
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  summary(){
    const t = this._tableItems();
    return {
      connected: this.session.connected, mock: this.session.usingMock, enabled: this.session.enabled,
      rows: this.rows.length, rowErrors: t.errs.length,
      preset: $('i2-preset').value,
      dock: this.dockTab,
      running: this.runner.running,
      liveVars: [...this.live.keys()],
      scan: this.scanAddrs.map(a => '0x' + a.toString(16)),
      session: this.session.summary(),
    };
  }
}

// ---------------------------------------------------------------- 小工具

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 长读的十六进制太长，只留前 `keep` 个字节 + `…+N B`（keep=0 表示原样）*/
function abbreviateHex(hex, keep){
  if (!keep || !hex) return hex || '（无数据）';
  const parts = String(hex).split(' ');
  if (parts.length <= keep) return hex;
  return parts.slice(0, keep).join(' ') + ` …+${parts.length - keep}B`;
}

/** 迷你曲线：抽到 `app/ui/spark.js`（与 `#spi` 的实时值共用一份，别在这儿再写一遍）*/
