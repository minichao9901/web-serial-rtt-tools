/**
 * 接收缓冲区：raw 记录（供切换显示模式/保存用）+ 增量 DOM 文本节点（供显示）。
 *
 * 设计要点（都是踩过的坑）：
 *  ① 每来一段就 append 一个文本节点，别整块 textContent 重写 —— 串口日志刷得快时
 *     整块重写会让页面卡住；裁掉旧数据时删掉最老的节点即可。
 *  ② raw 记录有上限（默认 2MB / 8192 段），显示另限 4000 行 / 256KB 字符，超出裁掉旧数据，
 *     否则长时间挂机把内存吃光。
 *  ③ 切换 ASCII/HEX、开关时间戳 → repaint() 从 raw 重建（不是从显示文本反推）。
 *  ④ 暂停只停止显示；继续时回放最近 128KB，保存可导出保留的完整 raw 缓冲。
 */
import { bytesToHexView, bytesToText } from './hex.js';
import { bytes as fBytes, stamp as stampOf } from './format.js';

const countNl = s => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };

export class RxBuffer {
  constructor(el, opts = {}){
    this.el = el;
    this.maxLines = opts.maxLines ?? 4000;
    this.maxRaw = opts.maxRaw ?? 2 * 1024 * 1024;
    this.maxDisplay = opts.maxDisplay ?? 256 * 1024;
    this.maxChunks = opts.maxChunks ?? 8192;
    this.isVisible = opts.isVisible || (() => true);
    this._dirty = false;
    this.mode = opts.mode || 'ascii';      // ascii | hex
    this.timestamps = false;
    this.absolute = false;
    this.autoscroll = true;
    this.paused = false;
    this.displayOff = false;               // 高速自动关显示：字节照收（计数在外部），只停渲染/存储
    this.suppressedBytes = 0;              // 关显示期间省略渲染的字节数（恢复时提示用）
    this.truncated = false;
    // ---------- 批量渲染 ----------
    // 🚨 别在每个数据事件里直接 _append：猛灌时（MicroLink RTT→CDC 一上来就 ~MB/s）
    // 事件速率上千/秒，每次追加节点 + 自动滚动都强制一次重排，主线程被布局吃满，
    // 页面直接"无响应"（连高速门控的定时器都排不上队）。每 60ms 合成一个节点，待显示最多 64KB。
    this._pend = [];
    this._pendBytes = 0;
    setInterval(() => this.flush(), 60);
    this._raw = []; this._rawHead = 0;     // [{t, b}]，头游标裁剪，避免每包 shift 大数组
    this.rawBytes = 0;
    this.nodes = [];                       // [{node, lines}]
    this.lines = 0;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.onChange = null;                  // 外部（统计条）用的钩子
  }

  // ---------------- 设置 ----------------
  setMode(m){ if (this.mode === m) return; this.mode = m; this.repaint(); }
  setTimestamps(on, absolute = this.absolute){
    if (this.timestamps === on && this.absolute === absolute) return;
    this.timestamps = on; this.absolute = absolute; this.repaint();
  }
  setAutoscroll(on){ this.autoscroll = on; if (on) this._scroll(); }
  setPaused(on){
    if (this.paused === on) return;
    if (on) this.flush();                  // 暂停前把攒着的先显示掉
    this.paused = on;
    if (!on) this.repaint();
  }

  /**
   * 高速自动关显示：与暂停不同 —— 暂停是"数据留着回头补"，关显示是"这段时间干脆不渲染"
   * （几百 KB/s 时回头补也是一次几 MB 的重绘，照样卡死）。恢复时补一行省略说明。
   */
  setDisplayOff(on){
    if (this.displayOff === on) return;
    this.displayOff = on;
    if (on){ this._pend = []; this._pendBytes = 0; }
    if (!on){
      const skipped = this.suppressedBytes;
      this.suppressedBytes = 0;
      this._notice = skipped > 0 ? `（高速期间省略了 ${fBytes(skipped)} 的渲染；完整数据用「记录到文件」拿）\n` : '';
      this.repaint();
    }
  }

  // ---------------- 数据 ----------------
  /** @param {Uint8Array} bytes */
  push(bytes, t = new Date(), prefix = ''){
    if (!bytes || !bytes.length) return;
    if (this.displayOff){ this.suppressedBytes += bytes.length; return; }
    this._store(bytes, t);
    if (this.paused || !this.isVisible()){ this._dirty = true; return; }
    this._pend.push({ b: bytes, t, prefix });
    this._pendBytes += bytes.length;
    // 数据事件只入队；即使定时器暂时落后也不在接收回路里强制布局。
    if (this._pendBytes > 64 * 1024){ this._pend = []; this._pendBytes = 0; this._dirty = true; }
  }

  /** 把攒着的段合成一个文本节点（时间戳仍按每段自己的时间打） */
  flush(){
    if (this.paused || this.displayOff || !this.isVisible()) return;
    if (this._dirty){ this.repaint(); return; }
    if (!this._pend.length) return;
    const pend = this._pend;
    this._pend = []; this._pendBytes = 0;
    let text = '';
    for (const { b, t, prefix } of pend) text += this.format(b, t, prefix);
    if (text) this._append(text);
  }

  _store(b, t){
    if (b.length > this.maxRaw){ b = b.subarray(b.length - this.maxRaw); this.truncated = true; }
    this._raw.push({ t, b });
    this.rawBytes += b.length;
    while (this.rawBytes > this.maxRaw || this._raw.length - this._rawHead > this.maxChunks){
      this.rawBytes -= this._raw[this._rawHead].b.length;
      this._raw[this._rawHead++] = null;
      this.truncated = true;
    }
    if (this._rawHead > 4096 && this._rawHead * 2 > this._raw.length){
      this._raw = this._raw.slice(this._rawHead); this._rawHead = 0;
    }
  }

  /** 一段字节 → 显示文本 */
  format(b, t, prefix = ''){
    const ts = this.timestamps ? `[${stampOf(t, this.absolute)}] ` : '';
    let body;
    if (this.mode === 'hex') body = bytesToHexView(b);
    else body = bytesToText(b, this.decoder);       // 流式解码：跨包的多字节字符不会被拆坏
    if (prefix){
      // 回显/标记行：单独一行，不与数据混在一起
      return `${ts}${prefix}${this.mode === 'hex' ? bytesToHexView(b).trim() : body.replace(/[\r\n]+$/, '')}\n`;
    }
    if (!body) return '';
    if (ts) body = body.split('\n').map((l, i, a) => (i === a.length - 1 && l === '') ? '' : ts + l).join('\n');
    return body;
  }

  /** 把一串记录当成一个整体渲染（保存文件用；解码器状态跨记录连续） */
  render(records){
    const saved = this.decoder;
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    let s = '';
    for (const r of records || this.raw) s += this.format(r.b, r.t);
    this.decoder = saved;
    return s;
  }

  _append(text, scroll = true){
    if (!text) return;
    text = text.slice(-this.maxDisplay);
    let remaining = this.maxLines;
    for (let i = text.length - 1; i >= 0; i--){
      if (text.charCodeAt(i) === 10 && --remaining < 0){ text = text.slice(i + 1); break; }
    }
    const node = document.createTextNode(text);
    this.el.appendChild(node);
    const ln = countNl(text);
    this.nodes.push({ node, ln, chars: text.length });
    this._chars = (this._chars || 0) + text.length;
    this.lines += ln;
    while ((this.lines > this.maxLines || this._chars > this.maxDisplay) && this.nodes.length > 1){
      const f = this.nodes.shift();
      this.lines -= f.ln;
      this._chars -= f.chars;
      f.node.remove();
    }
    if (scroll && this.autoscroll) this._scroll();
  }

  _scroll(){ this.el.scrollTop = this.el.scrollHeight; }

  /** 整块重建（切模式、开关时间戳、暂停恢复、清空后回填） */
  repaint(){
    this._dirty = true;
    if (this.paused || this.displayOff || !this.isVisible()) return;
    this._pend = []; this._pendBytes = 0;   // 攒着的都在 raw 里，重建会带上，别再追加一遍
    for (const { node } of this.nodes) node.remove();
    this.nodes = []; this.lines = 0; this._chars = 0;
    this.el.textContent = '';
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    // 回放只显示最近的有界窗口，原始缓冲与保存数据仍保留 maxRaw。
    const records = this.raw;
    let start = records.length, size = 0;
    while (start > 0 && size < 128 * 1024) size += records[--start].b.length;
    let text = this.truncated ? '（较早的数据已因超出上限被丢弃）\n' : '';
    if (start > 0) text += '（仅显示最近的日志；完整缓冲可用「保存数据」导出）\n';
    const parts = [];
    for (let i = start; i < records.length; i++){
      const { t, b } = records[i];
      // 单个超大包也不能绕过显示预算。
      parts.push(this.format(b.subarray(Math.max(0, b.length - 128 * 1024)), t));
    }
    // 提示置于窗口末尾，HEX 扩张或行数裁剪时也能保留。
    if (text) parts.push('\n' + text);
    parts.push(this._notice || ''); this._notice = '';
    this._append(parts.join(''), false);
    this._dirty = false;
    if (this.autoscroll) this._scroll();
  }

  clear(){
    this._raw = []; this._rawHead = 0; this.rawBytes = 0; this.truncated = false;
    this.suppressedBytes = 0;
    this._pend = []; this._pendBytes = 0;
    for (const { node } of this.nodes) node.remove();
    this.nodes = []; this.lines = 0; this._chars = 0; this._dirty = false; this._notice = '';
    this.decoder = new TextDecoder('utf-8', { fatal: false });
    this.el.textContent = '';
  }

  /** 导出文本（保存文件用）：按当前模式 + 时间戳设置 */
  text(){
    let s = this.truncated ? '（较早的数据已因超出上限被丢弃）\n' : '';
    return s + this.render(this.raw);
  }

  get bytes(){ return this.rawBytes; }
  get raw(){ return this._raw.slice(this._rawHead); }
  get empty(){ return this._raw.length === this._rawHead; }
}
