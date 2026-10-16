/**
 * SPI 桥页的**定时采集视图**：脚本区的「开始定时 / 停止」+ 运行胶囊 + 「实时值」tab。
 *
 * 逻辑在 `app/spi/runner.js`（SpiRunner，可离线自测），这里只做 DOM：
 *   · `#sp-dsl-run` / `#sp-dsl-stop` —— 解析脚本区那一段并起停采集
 *   · `#sp-acq-pill` —— 跨 tab 的状态胶囊（`运行中 · 12 拍 · 丢 0 · 2 变量`）
 *   · `#sp-live-*` —— 变量表 + 迷你曲线（与 `#i2c` 的实时值同一套画法，`app/ui/spark.js`）
 *
 * 为什么 SPI 也需要它：SPI 接口的 ADC / 传感器就是"按固定周期读一次、把字节换算成物理量"。
 * 命令表能读，但要手点；脚本区能跑一次；**定时采集**才是它们真正的用法（跟 I2C 侧一致）。
 */
import { $, appendLogLine } from '../ui/dom.js';
import { store } from '../core/store.js';
import { drawSpark } from '../ui/spark.js';
import { parseFrames, describeParsed } from './frames-dsl.js';
import { SpiRunner } from './runner.js';
import { fmtValue } from '../core/expr.js';

export class AcqView {
  /** @param {{session:object, tag?:string}} opts */
  constructor({ session, tag = 'bus' } = {}){
    this.session = session;
    this.tag = tag;
    this.live = new Map();          // name → {name,last,min,max,n,t0,tLast,buf[]}
    this.dirty = false;
    this.runner = new SpiRunner(session, { onEvent: e => this._onEvent(e) });
  }

  init(){
    $('sp-dsl-run').addEventListener('click', () => this.start());
    $('sp-dsl-stop').addEventListener('click', () => this.stop('用户停止').catch(e => {
      appendLogLine($('sp-log'), `停止未确认：${e.message}；可重试停止`, 'err', 400);
      this.renderPill();
    }));
    $('sp-live-reset').addEventListener('click', () => { this.live.clear(); this.renderLive(); });
    $('sp-live-spark').addEventListener('change', () => this.renderLive());
    this.renderLive();
    this.renderPill('idle');
  }

  get running(){ return this.runner.running; }

  /** 解析脚本区那一段（错误就写进错误表，不发）→ 起定时 */
  async start(){
    const text = $('sp-dsl-text').value;
    const parsed = parseFrames(text);
    this._showErrors(parsed);
    if (parsed.errors.length){
      appendLogLine($('sp-log'), `定时采集：脚本有 ${parsed.errors.length} 处语法错，先修好再跑`, 'e', 400);
      return false;
    }
    if (!parsed.items.length){
      appendLogLine($('sp-log'), '定时采集：脚本里没有可发的帧', 'w', 400);
      return false;
    }
    const ok = await this.runner.start(parsed);
    if (ok) this.renderPill('running');
    return ok;
  }

  async stop(reason){
    if (this._stopping) return;
    this._stopping = true;
    this.runner.stop(reason);
    this.renderPill('idle');
    try { await this.session.stopPeriodic?.(); }
    finally { this._stopping = false; this.renderPill('idle'); }
  }

  _showErrors(parsed){
    const wrap = $('sp-dsl-errwrap'), body = $('sp-dsl-err');
    if (!parsed.errors.length){ wrap.style.display = 'none'; body.innerHTML = ''; return; }
    wrap.style.display = '';
    body.innerHTML = parsed.errors.map(e =>
      `<tr><td>${e.line}</td><td class="mono">${escapeHtml(e.text)}</td><td>${escapeHtml(e.msg)}</td></tr>`).join('');
  }

  _onEvent(e){
    switch (e.type){
      case 'start':
        appendLogLine($('sp-log'), `定时采集开始：${e.oneShots} 条一次性 · ${e.groups} 组定时` +
          (e.vars?.length ? ` · 变量 ${e.vars.join(' ')}` : '（没有 as 解码 → 实时值会空着）'), 'i', 400);
        this.renderPill('running');
        break;
      case 'once':
        if (e.sent || e.failed) appendLogLine($('sp-log'), `一次性部分发完：${e.sent} 帧${e.failed ? ` · ${e.failed} 帧失败` : ''}`, e.failed ? 'w' : 'dim', 400);
        break;
      case 'tick': this.renderPill('running'); break;
      case 'late':
        appendLogLine($('sp-log'), `采集迟了 ${e.late} ms（周期比一次发送还短）—— 只晚不丢，采样点不会少`, 'w', 400);
        this.renderPill('running');
        break;
      case 'values': for (const v of e.values) this._push(v, e.timeMs); break;
      case 'warn': appendLogLine($('sp-log'), '解码提示：' + e.msg, 'w', 400); break;
      case 'error': appendLogLine($('sp-log'), '采集错误：' + e.msg, 'e', 400); break;
      case 'groupDone': appendLogLine($('sp-log'), `定时组 #${e.group} 跑完 ${e.n} 轮`, 'i', 400); break;
      case 'stop':
        appendLogLine($('sp-log'), `定时采集停止（${e.reason}）` + (e.stat ? ` · 共 ${e.stat.ticks} 拍 · 迟/跳过 ${e.stat.late} · 错 ${e.stat.errors}` : ''), 'i', 400);
        this.renderPill('idle');
        break;
      default: break;
    }
  }

  /**
   * 运行胶囊：跨 tab 传达"还在跑"。
   * 🚨 文案**只认 `runner.running`**（单一事实源）：停止那一刻可能还有一拍在飞（它完成时会
   *    再发一个 `tick`），照着事件里的 kind 去写就会把胶囊刷回"采集 · N 拍"—— 实测踩过。
   */
  renderPill(kind, extra = ''){
    const pill = $('sp-acq-pill');
    if (!pill) return;
    const st = this.runner.stat;
    const running = this.runner.running;
    const failed = !!this.session._periodic?.client.stopError;
    if (failed){
      pill.textContent = '停止未确认 · 请重试停止'; pill.classList.remove('on');
    } else if (running){
      pill.textContent = `采集 · ${st.ticks} 拍` +
        (st.late ? ` · 迟 ${st.late}` : '') + (st.errors ? ` · 错 ${st.errors}` : '') +
        (this.live.size ? ` · ${this.live.size} 变量` : '');
      pill.classList.add('on');
    } else {
      pill.textContent = extra || (st.ticks ? `已结束 · ${st.ticks} 拍` : '未运行');
      pill.classList.remove('on');
    }
    const run = $('sp-dsl-run'), stop = $('sp-dsl-stop');
    if (run) run.disabled = running || this.session.busy || !this.session.dataReady;
    if (stop){ stop.disabled = this._stopping || (!running && !failed); stop.textContent = this._stopping ? '正在停止…' : failed ? '重试停止' : '停止'; }
  }

  _push(v, timeMs){
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
    // 实时值面板可能正被藏着（用户在别的 tab）—— 用 rAF 合并重绘，别在热路径里写 DOM
    if (!this.dirty){
      this.dirty = true;
      requestAnimationFrame(() => { this.dirty = false; this.renderLive(); this.renderPill('running'); });
    }
  }

  /** 实测频率：按**首末两次采样之间**算（与 I2C 页同一口径）*/
  _rateOf(e){
    if (!e || e.n < 2) return 0;
    const span = (e.tLast - e.t0) / 1000;
    return span > 0 ? (e.n - 1) / span : 0;
  }

  renderLive(){
    const body = $('sp-live-body');
    if (!body) return;
    const list = [...this.live.values()];
    const rates = list.map(e => this._rateOf(e));
    $('sp-live-sum').textContent = list.length
      ? `${list.length} 个变量 · 共 ${list.reduce((a, b) => a + b.n, 0)} 次采样 · 最快 ${Math.max(...rates).toFixed(1)} Hz`
      : '还没有数据 —— 在脚本区写一段带 `as` 解码的 loop（见下面示例）再点「开始定时」';
    body.innerHTML = '';
    const spark = $('sp-live-spark').checked;
    for (const e of list){
      const tr = document.createElement('tr');
      const f = v => (Number.isFinite(v) ? fmtValue(v) : '—');
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
}

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
