/**
 * 「RTT 转发」页（放在 RTT Viewer 后面）：把 akaLinkPro 探针侧 RTT 桥转出来的 CDC 流当串口看。
 *
 * 为什么单独一页：这块是**纯输出**——数据从探针的 CDC 口出来，页面上没有任何发送，
 * 所以照「串口助手」的接收半边做，砍掉发送框/快捷发送/定时发送/HEX 发送/行尾这些。
 * 保留：端口选择与连接、ASCII/ANSI/HEX 显示、时间戳、暂停、清空、自动滚动、
 *      保存数据、记录到文件（高速采集不丢数）、高速自动关显示（回滞门控）。
 *
 * 串口会话与「串口助手」「终端」**共用同一个**（一个 COM 口只能被一个程序打开，
 * 三个标签是同一路数据的三种看法）—— 数据事件里自己也收一份进本页的接收区。
 * 探针那边的启停/地址在 app/hid/view.js（HID 0x31），本文件不碰 HID。
 */
import { $, seg, setStatus } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { RxBuffer } from '../core/rxview.js';
import { Counter } from '../core/stats.js';
import { FileRecorder, recordButtonState } from '../core/recorder.js';
import { SerialSession } from '../serial/session.js';
import { DemoPort, demoEnabled } from '../serial/demo.js';
import { bytes as fBytes, rate as fRate, fileStamp, download, stamp as stampOf } from '../core/format.js';
import { AnsiDisplay, BurstGuard, terminalBytes } from '../core/display-stream.js';

const portKey = p => {
  try { const i = p.getInfo?.() || {}; return `${i.usbVendorId ?? 0}-${i.usbProductId ?? 0}`; } catch { return 'x'; }
};

export class RttCdcStreamView {
  constructor(session, { prefix="c", tab="rttcdc", namespace="rttcdc", group="crxmode", owner="rtt" } = {}){
    this.tab=tab; this.namespace=namespace; this.group=group; this.owner=owner;
    this.$=id => $(id === "tab-rttcdc" ? "tab-"+tab : id.replace(/^c-/, prefix+"-"));
    this.key=key => namespace+"."+key;
    this.s = session;
    this.rx = null;
    this.rxc = new Counter();
    this.rec = new FileRecorder();
    this.ansiOn = false;
    this.term = null;
    this.fit = null;
    this._lastWasCR = false;
    this.suppressed = false;
    this.suppManual = false;
    this._bound = false;
    this.burst = new BurstGuard();
  }

  // 门控阈值与串口助手一致（>100KB/s 停渲染，回落到 <50KB/s 才自动恢复）
  static HS_OFF = 100 * 1024;
  static HS_ON = 50 * 1024;

  init(){
    if (this._bound) return;
    this._bound = true;

    this.rx = new RxBuffer(this.$('c-rx'), { maxLines: 4000, maxRaw: 2 * 1024 * 1024,
      isVisible: () => this.$('tab-rttcdc').classList.contains('active') });
    const rxm = store.get(this.key('rxmode'), 'ascii');
    this.rx.setMode(rxm === 'ansi' ? 'ascii' : rxm);      // RxBuffer 只认 ascii/hex，ansi 走 xterm
    this._seg = seg(document.querySelector(`[data-group=${this.group}]`), rxm, v => this._setRxMode(v));
    this._setRxMode(rxm);

    this._chk(this.$('c-ts'), this.key('ts'), v => this.rx.setTimestamps(v, this.$('c-tsabs').checked));
    this._chk(this.$('c-tsabs'), this.key('tsabs'), v => this.rx.setTimestamps(this.$('c-ts').checked, v));
    this._chk(this.$('c-autoscroll'), this.key('autoscroll'), v => this.rx.setAutoscroll(v));
    this._chk(this.$('c-record-ts'), this.key('recordTs'), v => { void v; });
    this._chk(this.$('c-record-auto'), this.key('recordAuto'), v => { void v; });

    store.bind(this.$('c-baud'), this.key('baud'));

    if (!SerialSession.supported()){
      setStatus(this.$('c-err'), '这个浏览器没有 Web Serial（请用桌面版 Chrome / Edge 打开）', 'err');
      this.$('c-open').disabled = true; this.$('c-pick').disabled = true;
    }

    this.$('c-pick').addEventListener('click', () => this.pickPort());
    this.$('c-scan').addEventListener('click', () => this.refreshPorts());
    this.$('c-open').addEventListener('click', () => this.connect());
    this.$('c-close').addEventListener('click', () => this.s.close());
    this.$('c-clear').addEventListener('click', () => { this.rx.clear(); this.ansiDisplay?.clear(); this.term?.clear(); this._lastWasCR = false; });
    this.$('c-save').addEventListener('click', () => this.save());
    this.$('c-record').addEventListener('click', () => this._toggleRecord());
    this.$('c-statclear').addEventListener('click', () => { this.rxc.reset(); this._stats(); });
    this.$('c-err').addEventListener('click', () => {
      if (this.suppressed){ this.suppManual = true; this._setSuppressed(false); }
    });
    this.$('c-pause').addEventListener('click', () => {
      const on = !this.rx.paused;
      this.rx.setPaused(on);
      this.$('c-pause').textContent = on ? '继续' : '暂停';
      this.$('c-pause').classList.toggle('primary', on);
      if (!on && this.ansiOn) this._ansiRedraw();
    });

    this.rec.onChange = () => this._recordBtn();
    // 记录期间"本页被切到后台"这类提醒（见 core/recorder.js 里的说明）
    this.rec.onNote = s => toast(s, 'warn', 8000);
    this._recordBtn();

    // ---------------- 会话事件（与助手/终端共用同一个会话） ----------------
    this.s.on('open', ({ opts, info }) => {
      this.$('c-open').disabled = true; this.$('c-close').disabled = false;
      this.$('c-scan').disabled = true; this.$('c-pick').disabled = true; this.$('c-port').disabled = true;
      setStatus(this.$('c-err'), '', null);
      /* 三个页面共用这一个串口会话 → **只对"自己发起的那次"弹提示 / 起自动记录**：
       * 本页专门连探针的 CDC 口，所以在串口助手里开一个普通 UART 时不该冒出
       * 「CDC 波特率不生效」这句（2026-10 代码审查）。连接状态照旧更新。 */
      const mine = opts.owner === this.owner;
      if (mine) toast(`已打开 ${info}（CDC 波特率不生效，随便填）`, 'ok');
      if (mine && this.$('c-record-auto').checked && !this.rec.active) this._autoStartRecord();
      this._stats();
    });
    this.s.on('close', ({ unexpected }) => {
      this.$('c-open').disabled = false; this.$('c-close').disabled = true;
      this.$('c-scan').disabled = false; this.$('c-pick').disabled = false; this.$('c-port').disabled = false;
      if (unexpected) toast('串口已断开（设备被拔掉或占用）', 'warn');
      this.suppManual = false;
      if (this.suppressed) this._setSuppressed(false);
      this._stopRecord();
      this._stats();
    });
    this.s.on('data', (b, t) => {
      this.rxc.add(b.length);
      this.rec.push(b, t);                 // 先落文件：接收区有 2MB 上限，记录不吃这个限制
      if (this.burst.add(b.length)) this._highspeedGate(RttCdcStreamView.HS_OFF + 1);
      this.rx.push(b, t);
      if (this.ansiOn && this.term && !this.rx.paused && !this.suppressed) this._ansiFeed(b, t);
    });
    this.s.on('error', e => setStatus(this.$('c-err'), String(e?.message || e), 'err'));

    if (SerialSession.supported()){
      navigator.serial.addEventListener('connect', () => { this.refreshPorts(); });
      navigator.serial.addEventListener('disconnect', () => { this.refreshPorts(); });
    }
    this.refreshPorts();
    setInterval(() => this._stats(), 500);
  }

  onShow(){
    this.rx?.flush(); this.ansiDisplay?.flush();
    if (this.ansiOn){ try { this.fit?.fit(); } catch {} }
    this._stats();
    /**
     * 目标类型是三个页面共用的全局粘性开关（本页 `#h-target` / RTT Viewer `#r-target` /
     * J-Scope `#sc-target`，同一个 store 键 `rtt.target`）。别页刚改过就切过来时，
     * 本页下拉得跟上 —— 显示与探针实际状态不一致正是 2026-10 那条 -2 的起点。
     * （视图是对的：hid 面板由 RttCdcView 持有，这里只借它刷一格界面，不碰探针。）
     */
    if (this.tab === 'rttcdc') globalThis.__tools?.hid?.syncTargetTypeFromStore?.();
  }

  // ---------------- 端口 ----------------
  async refreshPorts(){
    // 演示模式（?demo=serial）：和串口助手一样，用内置假设备，方便演示/自检
    if (demoEnabled()){
      this.ports = [new DemoPort()];
      const sel = this.$('c-port');
      sel.innerHTML = '';
      sel.appendChild(new Option('演示串口（假设备，点「连接」即可）', '0'));
      setStatus(this.$('c-note'), '当前是演示模式（?demo=serial）：这是页面内置的假串口，不是真硬件。', null);
      return;
    }
    this.ports = await SerialSession.listPorts();
    const sel = this.$('c-port');
    const prev = sel.value;
    sel.innerHTML = '';
    if (!this.ports.length){
      sel.appendChild(new Option('（没有已授权的串口 → 点「选择…」）', ''));
      setStatus(this.$('c-note'), '还没授权任何串口：点「选择…」在浏览器弹框里选探针的 CDC 口（第一次必须手动选一次）。', null);
      return;
    }
    this.ports.forEach((p, i) => {
      const alias = store.get('portAlias.' + portKey(p), '');
      sel.appendChild(new Option(`${alias || `串口 ${i + 1}`} · ${SerialSession.describe(p)}`, String(i)));
    });
    sel.value = (prev !== '' && this.ports[Number(prev)]) ? prev : '0';
    setStatus(this.$('c-note'), `已授权 ${this.ports.length} 个串口：${this.ports.map(p => SerialSession.describe(p)).join('，')}`, null);
  }

  async pickPort(){
    const before = new Set(this.ports || []);
    try {
      const picked = await SerialSession.requestPort();
      await this.refreshPorts();
      const idx = this.ports.findIndex(p => p === picked || !before.has(p));
      if (idx >= 0) this.$('c-port').value = String(idx);   // 授权后自动跳到新端口（否则像"选了没反应"）
      toast('端口已授权，可以点「连接」了', 'ok');
    } catch (e){
      if (e?.name !== 'NotFoundError') toast('选择端口失败：' + (e?.message || e), 'err');
    }
  }

  async connect(){
    const port = this.ports?.[Number(this.$('c-port').value)];
    if (!port){ toast('先点「选择…」授权一个串口（探针那个 CDC 口）', 'warn'); return; }
    try {
      await this.s.open(port, {
        baudRate: Number(this.$('c-baud').value) || 115200,
        dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none',
        owner: this.owner,                // 见 session.open 的说明：只对发起方弹提示/起自动记录
      });
    } catch (e){ setStatus(this.$('c-err'), String(e?.message || e), 'err'); }
  }

  // ---------------- 统计 / 门控 ----------------
  _stats(){
    const now = performance.now();
    const r = this.rxc.rate(now);
    this.$('c-rxbytes').textContent = fBytes(this.rxc.total);
    this.$('c-rxframes').textContent = this.rxc.frames;
    this.$('c-rxrate').textContent = fRate(r);
    this.$('c-buf').textContent = fBytes(this.rx?.bytes ?? 0);
    this._highspeedGate(r);
    // 记录/落盘期间按钮要一直刷：字节数、待落盘量都得看得见（见 recorder.js 的说明）
    if (this.rec.active || this.rec.draining) this._recordBtn();
    if (this.rx?.paused) this.$('c-pause').title = `暂停中，已缓存 ${fBytes(this.rx.bytes)}`;
  }

  _highspeedGate(r){
    if (!this.s.isOpen){
      if (this.suppressed) this._setSuppressed(false);
      this.suppManual = false;
      return;
    }
    if (!this.suppressed && !this.suppManual && r > RttCdcStreamView.HS_OFF) this._setSuppressed(true, r);
    else if (this.suppressed && r < RttCdcStreamView.HS_ON){ this._setSuppressed(false); this.suppManual = false; }
  }

  _setSuppressed(on, r = 0){
    if (this.suppressed === on) return;
    this.suppressed = on;
    if (on){
      this.rx.setDisplayOff(true);
      setStatus(this.$('c-err'), `高速 ${fRate(r)}：渲染已停（收数/记录不受影响）· 点此恢复显示`, 'err');
      this.$('c-err').title = '点击恢复显示。速率仍高于阈值时会再次自动关闭';
    } else {
      // 🚨 先取计数再关抑制：setDisplayOff(false) 会把 suppressedBytes 清零，
      //    先关再读恒为 0 → 这句提示永远不显示（代码审查抓到的，串口助手那边同款）
      const skipped = this.rx.suppressedBytes;
      this.rx.setDisplayOff(false);
      if (this.ansiOn && this.term && skipped > 0){
        this.term.write(`\x1b[90m（高速期间省略了 ${fBytes(skipped)} 的渲染；完整数据用「记录到文件」拿）\x1b[0m\r\n`);
      }
      setStatus(this.$('c-err'), '', null);
      this.$('c-err').title = '';
    }
  }

  // ---------------- 保存 / 记录 ----------------
  save(){
    if (this.rx.empty){ toast('接收区没有数据', 'warn'); return; }
    const name = `${this.owner}-${fileStamp()}.txt`;
    download(name, this.rx.text());
    toast(`已保存 ${name}（${fBytes(this.rx.bytes)}）`, 'ok');
  }

  async _autoStartRecord(){
    try {
      const name = await this.rec.start({ name: this.owner, timestamps: this.$('c-record-ts').checked });
      this._recordBtn();
      toast(`已自动开始记录 → ${name}`, 'ok', 5000);
    } catch (e){
      const why = e?.name === 'NotAllowedError' ? '浏览器要求弹保存框时页面正在响应用户点击' : (e?.message || e);
      toast(`自动记录没启动（${why}）。手动点「记录到文件」即可`, 'warn', 6000);
    }
  }

  async _toggleRecord(){
    if (this.rec.starting || this.rec.draining) return;
    if (this.rec.active || this.rec.needsClose){
      const info = await this.rec.stop();
      this._recordBtn();
      if (info?.error) toast('记录出错：' + (info.error.message || info.error), 'err', 6000);
      else if (info) toast(`已保存 ${info.name}：${fBytes(info.bytes)} / ${info.frames} 段 / ${info.seconds.toFixed(1)} s`, 'ok', 6000);
      return;
    }
    try {
      const name = await this.rec.start({ name: this.owner, timestamps: this.$('c-record-ts').checked });
      this._recordBtn();
      toast(`记录中 → ${name}：Chrome 先写成 ${name}.crswap，点「停止记录」才改名成正式文件（记录中别关页面/刷新）`, 'ok', 8000);
    } catch (e){
      if (e?.name !== 'AbortError') toast('开始记录失败：' + (e?.message || e), 'err', 6000);
    }
  }

  async _stopRecord(){
    if (!this.rec.active && !this.rec.needsClose && !this.rec.starting && !this.rec.draining) return;
    const info = await this.rec.stop();
    this._recordBtn();
    if (info?.error) toast('记录落盘出错：' + (info.error.message || info.error), 'err', 8000);
    else if (info) toast(`已落盘：${info.name}（${fBytes(info.bytes)}）—— .crswap 已改名成正式文件`, 'ok', 7000);
  }

  _recordBtn(){
    const b = this.$('c-record');
    if (!b) return;
    const s = recordButtonState(this.rec);
    b.disabled = this.rec.starting || this.rec.draining;
    b.textContent = s.text;
    b.title = s.title;
    b.classList.toggle('primary', s.primary);
  }

  // ---------------- ANSI（和串口助手同一套） ----------------
  _setRxMode(v){
    store.set(this.key('rxmode'), v);
    this.ansiOn = v === 'ansi';
    this.$('c-term').hidden = !this.ansiOn;
    this.$('c-rx').hidden = this.ansiOn;
    if (this.ansiOn){
      if (!this._ensureAnsiTerm()){ this._seg.set('ascii'); store.set(this.key('rxmode'), 'ascii'); return; }
      this._ansiRedraw();
      try { this.fit?.fit(); } catch {}
    } else {
      this.rx.setMode(v);
    }
  }

  _ensureAnsiTerm(){
    if (this.term) return true;
    if (!window.Terminal){ toast('xterm.js 没加载成功，ANSI 模式不可用', 'err'); return false; }
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono","JetBrains Mono",Consolas,"DejaVu Sans Mono",monospace',
      fontSize: 14, lineHeight: 1.15, cursorBlink: false, scrollback: 5000,
      convertEol: false, allowTransparency: true,
      theme: {
        background: '#010409', foreground: '#e6edf3', cursor: '#58a6ff',
        selectionBackground: '#264f78', black: '#484f58', red: '#ff7b72',
        green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#b1bac4',
      },
    });
    try { this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit); } catch {}
    this.term.open(this.$('c-term'));
    this.ansiDisplay = new AnsiDisplay(this.term, {
      visible: () => this.ansiOn && !this.rx.paused && !this.suppressed && this.$('tab-rttcdc').classList.contains('active'),
      format: (b, t) => this._ansiBytes(b, t),
      onSkip: () => { this._lastWasCR = false; },
    });
    this.fit?.fit();
    new ResizeObserver(() => { if (this.ansiOn){ try { this.fit?.fit(); } catch {} } }).observe(this.$('c-term'));
    return true;
  }

  _ansiFeed(bytes, t){
    this.ansiDisplay?.push(bytes, t);
  }

  _ansiBytes(bytes, t){
    const state = { lastWasCR: this._lastWasCR };
    const body = terminalBytes(bytes, state); this._lastWasCR = state.lastWasCR;
    if (!this.rx.timestamps) return body;
    const head = new TextEncoder().encode(`\x1b[90m[${stampOf(t, this.rx.absolute)}]\x1b[0m `);
    const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out;
  }

  _ansiRedraw(){
    if (!this.term) return;
    this.ansiDisplay?.clear();
    this.term.clear();
    this._lastWasCR = false;
    for (const r of this.rx.raw) this._ansiFeed(r.b, r.t);
  }

  // ---------------- 小工具 ----------------
  _chk(el, key, onChange){
    const apply = () => { const v = store.get(key); if (v !== undefined) el.checked = !!v; };
    apply();
    el.addEventListener('change', () => { store.set(key, el.checked); onChange?.(el.checked); });
    onChange?.(el.checked);
    return el;
  }

  /** 自检用 */
  summary(){
    return {
      open: this.s.isOpen,
      bytes: this.rxc.total,
      frames: this.rxc.frames,
      rate: Math.round(this.rxc.rate()),
      buffered: this.rx.bytes,
      paused: this.rx.paused,
      suppressed: this.suppressed,
      mode: this.ansiOn ? 'ansi' : this.rx.mode,
      recording: this.rec.active,
      recordBytes: this.rec.bytes,
      shown: this.$('c-rx').textContent.length,
    };
  }
}
