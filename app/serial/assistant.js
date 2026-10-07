/**
 * 串口助手（SSCOM 核心功能的网页版）。
 * 功能：端口/参数、ASCII-HEX 收发、时间戳、定时发送、快捷发送(Alt+1~5)、
 *      收发统计、保存接收数据、DTR/RTS、显示发送回显。
 */
import { $, seg, setStatus } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { RxBuffer } from '../core/rxview.js';
import { Counter } from '../core/stats.js';
import { FileRecorder, recordButtonState } from '../core/recorder.js';
import { SerialSession } from './session.js';
import { parseHex, textToBytes, EOL_LABEL } from '../core/hex.js';
import { bytes as fBytes, rate as fRate, fileStamp, download, stamp as stampOf } from '../core/format.js';
import { DemoPort, demoEnabled } from './demo.js';
import { AnsiDisplay, BurstGuard, terminalBytes } from '../core/display-stream.js';

const EOL_BYTES = { none: '', crlf: '\r\n', cr: '\r', lf: '\n' };
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export class Assistant {
  constructor(session){
    this.s = session;
    this.ports = [];
    this.rx = null;
    this.rxc = new Counter();
    this.txc = new Counter();
    this.timer = null;
    this.echo = false;
    this.rec = new FileRecorder();      // 高速采集落文件（见 core/recorder.js）
    this.ansiOn = false;                // ANSI 彩色模式（xterm 渲染，见 _setRxMode）
    this.term = null;
    this.fit = null;
    this._lastWasCR = false;            // 补 \r 用的跨包状态（同 terminal.js）
    this.suppressed = false;            // 高速自动关显示（见 _highspeedGate）
    this.suppManual = false;            // 用户手动恢复过显示：暂不再自动关，速率回落后重新武装
    this.burst = new BurstGuard();
  }

  init(){
    this.rx = new RxBuffer($('s-rx'), { maxLines: 4000, maxRaw: 2 * 1024 * 1024,
      isVisible: () => $('tab-serial').classList.contains('active') });
    this.demo = demoEnabled();

    if (!SerialSession.supported() && !this.demo){
      setStatus($('s-note'), '这个浏览器没有 Web Serial（请用桌面版 Chrome / Edge 打开）。', 'err');
      $('s-open').disabled = true; $('s-pick').disabled = true;
    }

    // ---------- 接收区显示设置 ----------
    const rxm = store.get('serial.rxmode', 'ascii');
    this.rx.setMode(rxm === 'ansi' ? 'ascii' : rxm);   // RxBuffer 只认 ascii/hex；ansi 走 xterm
    this._rxSeg = seg(document.querySelector('[data-group=rxmode]'), rxm, v => this._setRxMode(v));
    this._setRxMode(rxm);

    this._chk($('s-ts'), 'serial.ts', v => this.rx.setTimestamps(v, $('s-tsabs').checked));
    this._chk($('s-tsabs'), 'serial.tsabs', v => this.rx.setTimestamps($('s-ts').checked, v));
    this._chk($('s-autoscroll'), 'serial.autoscroll', v => this.rx.setAutoscroll(v));
    this._chk($('s-echo'), 'serial.echo', v => { this.echo = v; });

    // ---------- 串口参数 ----------
    for (const [el, key] of [[$('s-baud'), 'serial.baud'], [$('s-databits'), 'serial.databits'],
                             [$('s-stopbits'), 'serial.stopbits'], [$('s-parity'), 'serial.parity'],
                             [$('s-flow'), 'serial.flow']]) store.bind(el, key);
    this._chk($('s-dtr'), 'serial.dtr', v => this.s.setSignals({ dtr: v }).catch(() => {}));
    this._chk($('s-rts'), 'serial.rts', v => this.s.setSignals({ rts: v }).catch(() => {}));

    // ---------- 发送设置 ----------
    const txm = store.get('serial.txmode', 'ascii');
    this.txSeg = seg(document.querySelector('[data-group=txmode]'), txm, v => store.set('serial.txmode', v));
    store.bind($('s-eol'), 'serial.eol');
    this._chk($('s-timer'), 'serial.timer', () => this._armTimer());
    store.bind($('s-timer-ms'), 'serial.timerms');
    $('s-timer-ms').addEventListener('input', () => this._armTimer());

    // ---------- 按钮 ----------
    $('s-pick').addEventListener('click', () => this.pickPort());
    $('s-scan').addEventListener('click', () => this.refreshPorts());
    $('s-port').addEventListener('dblclick', () => this.renamePort());
    $('s-open').addEventListener('click', () => this.connect());
    $('s-close').addEventListener('click', () => this.s.close());
    $('s-send').addEventListener('click', () => this.send());
    $('s-clear').addEventListener('click', () => { this.rx.clear(); this.ansiDisplay?.clear(); this.term?.clear(); this._lastWasCR = false; });
    $('s-save').addEventListener('click', () => this.save());
    store.bind($('s-record-ts'), 'serial.recordTs', 'checked');
    store.bind($('s-record-auto'), 'serial.recordAuto', 'checked');
    $('s-record').addEventListener('click', () => this._toggleRecord());
    $('s-err').addEventListener('click', () => {
      // 高速关显示时状态栏就是恢复入口（文字会提示"点此恢复显示"）
      if (this.suppressed){ this.suppManual = true; this._setSuppressed(false); }
    });
    this.rec.onChange = () => this._recordBtn();
    // 记录期间"本页被切到后台"这类提醒（见 core/recorder.js 里的说明）
    this.rec.onNote = s => toast(s, 'warn', 8000);
    this._recordBtn();
    $('s-statclear').addEventListener('click', () => { this.rxc.reset(); this.txc.reset(); this._stats(); });
    $('s-pause').addEventListener('click', () => {
      const on = !this.rx.paused;
      this.rx.setPaused(on);
      $('s-pause').textContent = on ? '继续' : '暂停';
      $('s-pause').classList.toggle('primary', on);
      if (!on && this.ansiOn) this._ansiRedraw();
    });

    // ---------- 快捷发送 ----------
    this._buildQuick();

    // ---------- 会话事件 ----------
    this.s.on('open', ({ opts, info }) => {
      $('s-open').disabled = true; $('s-close').disabled = false;
      $('s-scan').disabled = true; $('s-pick').disabled = true; $('s-port').disabled = true;
      setStatus($('s-err'), '', null);
      /* 三个页面共用这一个串口会话 → **只对"自己发起的那次"弹提示 / 起自动记录**。
       * 否则（2026-10 代码审查）：在串口助手里开一个普通 UART，也会弹出 RTT 转发页那句
       * 「CDC 波特率不生效」；两页都勾了"连接自动记录"时同一路数据会被写成两个文件。
       * 连接状态本身照旧更新（按钮/状态灯是所有页面都该看到的）。 */
      const mine = opts.owner === 'assistant';
      if (mine) toast(`已打开串口 ${info} @ ${opts.baudRate} 8${opts.parity === 'none' ? 'N' : opts.parity === 'even' ? 'E' : 'O'}${opts.stopBits}`, 'ok');
      if (mine && $('s-record-auto').checked && !this.rec.active) this._autoStartRecord();
      this._armTimer();
      this._stats();
    });
    this.s.on('close', ({ unexpected }) => {
      $('s-open').disabled = false; $('s-close').disabled = true;
      $('s-scan').disabled = false; $('s-pick').disabled = false; $('s-port').disabled = false;
      this._armTimer();
      if (unexpected) toast('串口已断开（设备被拔掉或占用）', 'warn');
      this.suppManual = false;
      if (this.suppressed) this._setSuppressed(false);
      this._stopRecord();
      this._stats();
    });
    this.s.on('data', (b, t) => {
      this.rxc.add(b.length);
      this.rec.push(b, t);             // 落文件在"显示之前"：接收区 2MB 上限丢掉的历史不影响它
      if (this.burst.add(b.length)) this._highspeedGate(Assistant.HS_OFF + 1);
      this.rx.push(b, t);
      if (this.ansiOn && this.term && !this.rx.paused && !this.suppressed) this._ansiFeed(b, t);
    });
    this.s.on('tx', b => { this.txc.add(b.length); if (this.echo) this.rx.push(b, new Date(), '→ '); });
    this.s.on('error', e => setStatus($('s-err'), String(e?.message || e), 'err'));

    // ---------- 键盘 ----------
    $('s-tx').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); this.send(); }
    });
    window.addEventListener('keydown', e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!$('tab-serial').classList.contains('active')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 5 && this.quick?.[n - 1]){
        e.preventDefault();
        const body = this.quick[n - 1].body.value;
        if (!body.trim()){ toast(`快捷 ${n} 是空的`, 'warn'); return; }
        this.send(body);
      }
    });

    // ---------- 热插拔 ----------
    if (SerialSession.supported()){
      navigator.serial.addEventListener('connect', () => { this.refreshPorts(); toast('检测到新串口设备', 'ok'); });
      navigator.serial.addEventListener('disconnect', () => { this.refreshPorts(); });
    }

    this.refreshPorts();
    setInterval(() => this._stats(), 500);

    // 演示模式可以带 ?demo=serial&autoconnect=1 直接连上（给 Pages 首屏演示/截图用）
    try {
      if (this.demo && new URLSearchParams(location.search).get('autoconnect') === '1'){
        setTimeout(() => this.connect(), 200);
      }
    } catch {}
  }

  // ================= 内部工具 =================
  _chk(el, key, apply){
    store.bind(el, key, 'checked');
    el.addEventListener('change', () => apply(el.checked));
    apply(el.checked);
  }

  _portKey(p){
    // 浏览器不暴露 COM 号，只能用 VID:PID + 同型号序号做标识
    const d = SerialSession.describe(p);
    const same = this.ports.slice(0, this.ports.indexOf(p) + 1).filter(x => SerialSession.describe(x) === d).length;
    return `${d}#${same}`;
  }

  async refreshPorts(){
    if (this.demo){
      this.ports = [new DemoPort()];
      const sel = $('s-port');
      sel.innerHTML = '';
      sel.appendChild(new Option('演示串口（假设备，点「连接」即可）', '0'));
      setStatus($('s-note'), '当前是演示模式（?demo=serial）：这是页面内置的假串口，用来演示/自检，不是真硬件。', null);
      return;
    }
    this.ports = await SerialSession.listPorts();
    const sel = $('s-port');
    const prev = sel.value;
    sel.innerHTML = '';
    if (!this.ports.length){
      sel.appendChild(new Option('（没有已授权的串口 → 点「选择…」）', ''));
    } else {
      const lastDesc = store.get('serial.lastDesc', '');
      this.ports.forEach((p, i) => {
        const key = this._portKey(p);
        const alias = store.get('portAlias.' + key, '');
        const desc = SerialSession.describe(p);
        sel.appendChild(new Option(`${alias || `串口 ${i + 1}`} · ${desc}${desc === lastDesc ? ' ★' : ''}`, String(i)));
      });
      sel.value = (prev !== '' && this.ports[Number(prev)]) ? prev : '0';
    }
    // 端口名提示
    const descs = this.ports.map(p => SerialSession.describe(p)).join('，');
    setStatus($('s-note'), this.ports.length
      ? `已授权 ${this.ports.length} 个串口：${descs}（双击下拉框可起别名）。`
      : '还没有授权任何串口：点「选择…」在浏览器弹框里选一次。', null);
  }

  async pickPort(){
    const before = new Set(this.ports);
    try {
      const picked = await SerialSession.requestPort();
      await this.refreshPorts();
      // 授权后自动选中新出现的那个端口 —— 之前停留在旧选择上，看起来像"选了没反应"。
      // 重新挑同一个设备也要跳过去（对象身份匹配）；集合差别找不到时保持原样。
      const idx = this.ports.findIndex(p => p === picked || !before.has(p));
      if (idx >= 0){
        store.set('serial.lastDesc', SerialSession.describe(this.ports[idx]));
        await this.refreshPorts();               // 重建一次让 ★ 跟着新设备
        $('s-port').value = String(idx);
      }
      toast('端口已授权，可以点「连接」了', 'ok');
    } catch (e){
      if (e?.name !== 'NotFoundError') toast('选择端口失败：' + e.message, 'err');
    }
  }

  renamePort(){
    const idx = Number($('s-port').value);
    const p = this.ports[idx];
    if (!p) return;
    const key = this._portKey(p);
    const cur = store.get('portAlias.' + key, '');
    const v = prompt(`给这个串口起个名字（${SerialSession.describe(p)}）：`, cur);
    if (v === null) return;
    store.set('portAlias.' + key, v.trim());
    this.refreshPorts();
  }

  async connect(){
    const idx = Number($('s-port').value);
    const port = this.ports[idx];
    if (!port){ toast('先点「选择…」授权一个串口', 'warn'); return; }
    try {
      await this.s.open(port, {
        baudRate: Number($('s-baud').value) || 115200,
        dataBits: Number($('s-databits').value) || 8,
        stopBits: Number($('s-stopbits').value) || 1,
        parity: $('s-parity').value,
        flowControl: $('s-flow').value,
        dtr: $('s-dtr').checked,
        rts: $('s-rts').checked,
        owner: 'assistant',          // 见 session.open 的说明：只对发起方弹提示/起自动记录
      });
      store.set('serial.lastDesc', SerialSession.describe(port));
      this.refreshPorts();
    } catch (e){
      setStatus($('s-err'), '打开失败：' + e.message, 'err');
      toast('打开失败：' + e.message + '（端口被别的程序占着？）', 'err', 6000);
    }
  }

  /** 组包：文本/HEX + 行尾 */
  _build(rawText){
    const t = rawText ?? $('s-tx').value;
    if (!t.trim()) return { error: '发送内容为空' };
    let b;
    if (this.txSeg.value === 'hex'){
      const r = parseHex(t);
      if (r.error) return { error: r.error };
      b = r.bytes;
    } else {
      b = textToBytes(t);
    }
    const tail = EOL_BYTES[$('s-eol').value] || '';
    if (tail) b = concat(b, textToBytes(tail));
    if (!b.length) return { error: '发送内容为空' };
    return { bytes: b };
  }

  async send(rawText, opts = {}){
    const fromTimer = opts.fromTimer === true;
    if (!this.s.isOpen){ if (!fromTimer) toast('串口未打开', 'warn'); return false; }
    const { bytes, error } = this._build(rawText);
    if (error){ setStatus($('s-err'), error, 'err'); if (!fromTimer) toast(error, 'warn'); return false; }
    setStatus($('s-err'), '', null);
    try { await this.s.write(bytes); return true; }
    catch (e){ setStatus($('s-err'), '发送失败：' + e.message, 'err'); return false; }
  }

  sendText(t, opts = {}){ return this.send(t, opts); }

  _armTimer(){
    clearInterval(this.timer);
    this.timer = null;
    if (!$('s-timer').checked || !this.s.isOpen) return;
    const ms = Math.max(20, Number($('s-timer-ms').value) || 1000);
    this.timer = setInterval(() => this.send(undefined, { fromTimer: true }), ms);
  }

  _buildQuick(){
    const box = $('s-quick');
    box.innerHTML = '';
    this.quick = [];
    for (let i = 1; i <= 5; i++){
      const row = document.createElement('div');
      row.className = 'qrow';
      row.innerHTML = `<span class="qidx">${i}</span><input class="qlabel" placeholder="名称"><input class="qbody" placeholder="内容"><button title="发送（Alt+${i}）">发</button>`;
      const lab = row.querySelector('.qlabel');
      const body = row.querySelector('.qbody');
      const btn = row.querySelector('button');
      store.bind(lab, `quick.${i}.label`);
      store.bind(body, `quick.${i}.body`);
      btn.addEventListener('click', () => {
        if (!body.value.trim()){ toast(`快捷 ${i} 是空的`, 'warn'); return; }
        this.send(body.value);
      });
      box.appendChild(row);
      row.hidden = !lab.value.trim() && !body.value.trim();
      this.quick.push({ lab, body, row });
    }
    const add = $('s-quick-add');
    const sync = () => { add.disabled = this.quick.every(q => !q.row.hidden); };
    add.addEventListener('click', () => {
      const next = this.quick.find(q => q.row.hidden);
      if (next){ next.row.hidden = false; next.body.focus(); }
      sync();
    });
    sync();
  }

  _stats(){
    const now = performance.now();
    $('s-rxbytes').textContent = fBytes(this.rxc.total);
    $('s-rxframes').textContent = this.rxc.frames;
    $('s-rxrate').textContent = fRate(this.rxc.rate(now));
    $('s-txbytes').textContent = fBytes(this.txc.total);
    $('s-txframes').textContent = this.txc.frames;
    $('s-txrate').textContent = fRate(this.txc.rate(now));
    this._highspeedGate(this.rxc.rate(now));
    if (this.rx?.paused) $('s-pause').title = `暂停中，已缓存 ${fBytes(this.rx.bytes)}`;
    // 记录/落盘期间按钮要一直刷：字节数与"待落盘"量都得看得见（见 recorder.js 的说明）
    if (this.rec.active || this.rec.draining) this._recordBtn();
  }

  // ================= 高速自动关显示 =================
  /**
   * 几百 KB/s（高波特率 / MicroLink 的 RTT→CDC 转发）时界面渲染必然掉队 —— 先崩的总是
   * 显示，字节本身不丢（统计/落文件是全量）。所以：速率 > 100KB/s 自动停渲染，
   * 降到 50KB/s 以下才自动恢复（回滞，防临界速率反复开关）；点状态栏提示可手动恢复
   * （之后不再自动关，直到速率回落后重新武装）。
   * 配合 RxBuffer 的批量渲染（60ms 攒一批）：没有它，每个数据事件都同步操作一次 DOM
   * （追加节点 + 滚动强制重排），猛灌时主线程被布局吃满、连这个门控都排不上队。
   */
  static HS_OFF = 100 * 1024;   // 超过 100KB/s 停渲染
  static HS_ON  = 50 * 1024;    // 降到 50KB/s 以下才自动恢复（回滞）

  _highspeedGate(r){
    if (!this.s.isOpen){
      if (this.suppressed) this._setSuppressed(false);
      this.suppManual = false;
      return;
    }
    if (!this.suppressed && !this.suppManual && r > Assistant.HS_OFF) this._setSuppressed(true, r);
    else if (this.suppressed && r < Assistant.HS_ON){ this._setSuppressed(false); this.suppManual = false; }
  }

  _setSuppressed(on, r = 0){
    if (this.suppressed === on) return;
    this.suppressed = on;
    if (on){
      this.rx.setDisplayOff(true);
      setStatus($('s-err'), `高速 ${fRate(r)}：渲染已停（收数/记录不受影响）· 点此恢复显示`, 'err');
      $('s-err').title = '点击恢复显示。若速率仍高于阈值会再次自动关闭';
    } else {
      /**
       * 🚨 **先取计数再关抑制**：`setDisplayOff(false)` 内部会把 `suppressedBytes` 清零，
       *    老代码是先关再读 → 恒为 0 → 这句"省略了多少"的提示**永远不显示**。
       *    （`app/rtt/view.js` 里那份用自己的 suppBytes 记账，是对的；这里对齐它。）
       */
      const skipped = this.rx.suppressedBytes;
      this.rx.setDisplayOff(false);
      if (this.ansiOn && this.term && skipped > 0){
        this.term.write(`\x1b[90m（高速期间省略了 ${fBytes(skipped)} 的渲染；完整数据用「记录到文件」拿）\x1b[0m\r\n`);
      }
      setStatus($('s-err'), '', null);
      $('s-err').title = '';
    }
  }

  async _autoStartRecord(){
    try {
      const name = await this.rec.start({ name: 'serial', timestamps: $('s-record-ts').checked });
      this._recordBtn();
      toast(`已自动开始记录 → ${name}（Chrome 先写成 .crswap，点「停止记录」才改名）`, 'ok', 6000);
    } catch (e){
      const why = e?.name === 'NotAllowedError' ? '浏览器要求弹保存框时页面正在响应用户点击' : (e?.message || e);
      toast(`自动记录没启动（${why}）。手动点「记录到文件」即可`, 'warn', 6000);
    }
  }

  // ================= 记录到文件 =================
  /**
   * 高速采集（高波特率 + 设备猛发）时接收区吃不下：raw 上限 2MB，而且每段还要建 DOM 节点。
   * 落文件把收到的字节直接写盘 —— 界面卡不卡、有没有被浏览器限速都不影响已写下去的字节。
   */
  async _toggleRecord(){
    if (this.rec.starting || this.rec.draining) return;
    if (this.rec.active || this.rec.needsClose){
      const info = await this.rec.stop();
      this._recordBtn();
      if (info?.error) toast('记录出错：' + (info.error.message || info.error), 'err', 6000);
      else if (info) toast(`已落盘 ${info.name}：${fBytes(info.bytes)} / ${info.frames} 段 / ${info.seconds.toFixed(1)} s —— .crswap 已改名成正式文件`, 'ok', 7000);
      return;
    }
    try {
      const name = await this.rec.start({ name: 'serial', timestamps: $('s-record-ts').checked });
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
    const b = $('s-record');
    if (!b) return;
    const s = recordButtonState(this.rec);
    b.disabled = this.rec.starting || this.rec.draining;
    b.textContent = s.text;
    b.title = s.title + '　界面卡就先「暂停」——只停显示，不停记录。';
    b.classList.toggle('primary', s.primary);
  }

  // ================= ANSI 彩色模式 =================
  /**
   * 「ASCII | ANSI | HEX」里的 ANSI：把收到的字节按 ANSI 转义码渲染（像 MobaXterm），
   * 复用本地 vendor 的 xterm.js —— 和「终端」「RTT」两个标签页同一套渲染、同一套换行规则。
   * raw 记录仍进 RxBuffer：切回 ASCII/HEX、保存数据、暂停恢复都从 raw 重建，不丢数据。
   */
  _setRxMode(v){
    store.set('serial.rxmode', v);
    this.ansiOn = v === 'ansi';
    $('s-term').hidden = !this.ansiOn;
    $('s-rx').hidden = this.ansiOn;
    if (this.ansiOn){
      if (!this._ensureAnsiTerm()){ this._rxSeg.set('ascii'); store.set('serial.rxmode', 'ascii'); return; }   // xterm 没加载出来就退回 ASCII
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
      fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
      convertEol: false, allowTransparency: true,
      theme: {
        background: '#010409', foreground: '#e6edf3', cursor: '#58a6ff',
        selectionBackground: '#264f78', black: '#484f58', red: '#ff7b72',
        green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#b1bac4',
      },
    });
    try { this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit); } catch {}
    this.term.open($('s-term'));
    this.ansiDisplay = new AnsiDisplay(this.term, {
      visible: () => this.ansiOn && !this.rx.paused && !this.suppressed && $('tab-serial').classList.contains('active'),
      format: (b, t) => this._ansiBytes(b, t),
      onSkip: () => { this._lastWasCR = false; },
    });
    this.fit?.fit();
    const ro = new ResizeObserver(() => { if (this.ansiOn){ try { this.fit?.fit(); } catch {} } });
    ro.observe($('s-term'));
    return true;
  }

  _ansiFeed(bytes, t){
    this.ansiDisplay?.push(bytes, t);
  }

  _ansiBytes(bytes, t){
    // 很多固件只发 \n 不发 \r，直接塞给 xterm 会变成阶梯状 → 按字节自动补 \r（同 terminal.js）
    const state = { lastWasCR: this._lastWasCR };
    const body = terminalBytes(bytes, state); this._lastWasCR = state.lastWasCR;
    if (!this.rx.timestamps) return body;
    return concat(enc.encode(`\x1b[90m[${stampOf(t, this.rx.absolute)}]\x1b[0m `), body);
  }

  _ansiRedraw(){
    if (!this.term) return;
    this.ansiDisplay?.clear();
    this.term.clear();
    this._lastWasCR = false;
    for (const r of this.rx.raw) this._ansiFeed(r.b, r.t);
  }

  onShow(){ this.rx?.flush(); if (this.ansiOn){ this.fit?.fit(); this.ansiDisplay?.flush(); } }

  save(){
    if (this.rx.empty){ toast('接收区没有数据', 'warn'); return; }
    const name = `serial-${fileStamp()}.txt`;
    download(name, this.rx.text());
    toast(`已保存 ${name}（${fBytes(this.rx.bytes)}）`, 'ok');
  }
}

export { EOL_LABEL };
