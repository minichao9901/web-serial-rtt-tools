/**
 * 终端（Xshell 式用法）：xterm.js 渲染 ANSI，跟串口助手共用同一个串口会话。
 *
 * 三个关键点（串口终端最容易踩的）：
 *  ① 本地回显：绝大多数 MCU 固件不回显你敲的字符，所以要有「本地回显」选项；
 *  ② 换行：很多固件只发 \n 不发 \r，直接塞给 xterm 会变成阶梯状 → 默认自动补 \r
 *     （按字节处理，不能用字符串，否则多字节 UTF-8 会被拆坏）；
 *  ③ 键值映射：回车/退格在嵌入式里两种习惯都有（\r vs \r\n、0x7F vs 0x08）。
 */
import { $, setStatus } from '../ui/dom.js';
import { store } from '../core/store.js';
import { toast } from '../ui/toast.js';
import { fileStamp, download } from '../core/format.js';
import { AnsiDisplay, terminalBytes } from '../core/display-stream.js';

const EOL_BYTES = { cr: '\r', crlf: '\r\n', lf: '\n' };
const enc = new TextEncoder();

export class TerminalView {
  constructor(session){
    this.s = session;
    this.term = null;
    this.fit = null;
    this.lastWasCR = false;
    this.nlMode = 'auto';
  }

  init(){
    if (!window.Terminal){
      setStatus($('t-status'), 'xterm.js 没加载成功（app/vendor/xterm/xterm.js 缺失？）', 'err');
      return;
    }
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono","JetBrains Mono",Consolas,"DejaVu Sans Mono",monospace',
      fontSize: Number(store.get('term.font', 14)) || 14,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      allowTransparency: true,
      theme: {
        background: '#010409', foreground: '#e6edf3', cursor: '#58a6ff',
        selectionBackground: '#264f78', black: '#484f58', red: '#ff7b72',
        green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#b1bac4',
      },
    });
    try {
      this.fit = new FitAddon.FitAddon();
      this.term.loadAddon(this.fit);
    } catch (e){ console.warn('FitAddon 不可用', e); }
    this.term.open($('t-term'));
    this.display = new AnsiDisplay(this.term, {
      visible: () => $('tab-terminal').classList.contains('active'),
      format: b => this.nlMode === 'raw' ? b : terminalBytes(b, this),
      onSkip: () => { this.lastWasCR = false; },
    });
    this.fit?.fit();

    // ---------- 设置 ----------
    store.bind($('t-echo'), 'term.echo');
    store.bind($('t-enter'), 'term.enter');
    store.bind($('t-bs'), 'term.bs');
    store.bind($('t-nl'), 'term.nl');
    this.nlMode = store.get('term.nl', 'auto');
    $('t-nl').addEventListener('change', () => { this.nlMode = $('t-nl').value; });
    store.bind($('t-font'), 'term.font');
    $('t-font').addEventListener('input', () => {
      const n = Math.min(32, Math.max(8, Number($('t-font').value) || 14));
      this.term.options.fontSize = n;
      this.fit?.fit();
    });

    // ---------- 按钮 ----------
    $('t-clear').addEventListener('click', () => { this.display.clear(); this.lastWasCR = false; this.term.clear(); });
    $('t-save').addEventListener('click', () => this.save());
    $('t-paste').addEventListener('click', () => this.pasteSend());

    // ---------- 键盘 / 粘贴 ----------
    this.term.attachCustomKeyEventHandler(ev => this._key(ev));
    this.term.onData(d => this._input(d));

    // ---------- 会话 ----------
    this.s.on('open', ({ opts, info }) => {
      this.writeText(`\x1b[36m── 已连接 ${info} @ ${opts.baudRate} ──\x1b[0m\r\n`);
      setStatus($('t-status'), `已连接 · ${info} @ ${opts.baudRate} · ${opts.dataBits}${opts.parity === 'none' ? 'N' : opts.parity === 'even' ? 'E' : 'O'}${opts.stopBits}`);
    });
    this.s.on('close', ({ unexpected }) => {
      this.writeText(`\x1b[33m── ${unexpected ? '连接中断' : '已断开'} ──\x1b[0m\r\n`);
      setStatus($('t-status'), '未连接');
    });
    this.s.on('data', b => this._feed(b));
    this.s.on('error', e => setStatus($('t-status'), '错误：' + (e?.message || e), 'err'));

    setStatus($('t-status'), '未连接 · 串口参数在「串口助手」里设置');
    this.writeText('\x1b[90m终端已就绪：先在「串口助手」里连接串口，这里就能像 Xshell 一样敲命令。\r\n'
      + '如果敲了字看不到回显，把左边的「回显」改成“本地回显”（很多固件不回显你输入的字符）。\x1b[0m\r\n\r\n');

    const ro = new ResizeObserver(() => this.onShow());
    ro.observe($('t-term'));
  }

  /** 切到本标签时调用：此时容器才有真实尺寸 */
  onShow(){
    if (!this.term) return;
    if (!$('tab-terminal').classList.contains('active')) return;
    try { this.fit?.fit(); } catch {}
    this.display?.flush();
  }

  // ---------------- 收 ----------------
  _feed(bytes){
    if (!this.term) return;
    this.display.push(bytes);
  }

  writeText(s){ this.term?.write(s); }

  // ---------------- 发 ----------------
  _input(d){
    if (!d) return;
    const bs = store.get('term.bs', 'del');
    const enter = store.get('term.enter', 'cr');
    const echo = store.get('term.echo', 'off');

    if (d === '\r'){
      const payload = EOL_BYTES[enter] || '\r';
      this._send(enc.encode(payload));
      if (echo !== 'off') this.writeText('\r\n');
      return;
    }
    if (d === '\x7f'){
      const payload = bs === 'bs' ? '\x08' : '\x7f';
      this._send(enc.encode(payload));
      if (echo !== 'off') this.writeText('\b \b');
      return;
    }
    this._send(enc.encode(d));
    if (echo !== 'off') this._feed(enc.encode(d));
  }

  _send(bytes){
    if (!this.s.isOpen){ toast('串口未打开（先在「串口助手」里连接）', 'warn', 2200); return; }
    this.s.write(bytes).catch(() => {});
  }

  // ---------------- 快捷键 ----------------
  _key(ev){
    if (ev.type !== 'keydown') return true;
    const k = ev.key.toLowerCase();
    if (ev.ctrlKey && ev.shiftKey && k === 'c'){
      const sel = this.term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).then(() => toast('已复制', 'ok', 1200)).catch(() => {});
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && k === 'v'){ this.pasteSend(); return false; }
    if (ev.ctrlKey && ev.shiftKey && k === 'l'){ $('t-clear').click(); return false; }
    return true;                                   // 其余（含 Ctrl+C）一律透传给设备
  }

  async pasteSend(){
    try {
      const text = await navigator.clipboard.readText();
      if (!text){ toast('剪贴板是空的', 'warn'); return; }
      this._send(enc.encode(text));
      if (store.get('term.echo', 'off') !== 'off') this._feed(enc.encode(text));
    } catch (e){
      toast('读剪贴板失败：' + e.message + '（需要页面处于焦点，且允许剪贴板权限）', 'err');
    }
  }

  // ---------------- 保存 ----------------
  save(){
    if (!this.term) return;
    const buf = this.term.buffer.active;
    let out = '';
    for (let i = 0; i < buf.length; i++){
      const line = buf.getLine(i);
      out += (line ? line.translateToString(true) : '') + '\n';
    }
    out = out.replace(/\n+$/, '\n');
    if (!out.trim()){ toast('终端里没有内容', 'warn'); return; }
    const name = `terminal-${fileStamp()}.txt`;
    download(name, out);
    toast(`已保存 ${name}`, 'ok');
  }
}
