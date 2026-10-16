/**
 * SPI/QSPI 桥页的「寄存器」面板（`#spi` 右列新 tab）——**读一段寄存器 → 逐位改 → 写回**。
 *
 * 与 `#i2c` 的寄存器面板**同一套交互**（同一份 `app/ui/reg-grid.js`、同样的黄框/位开关板/
 * 只写改动/整块写回/丢弃改动），差别只在"怎么把寄存器号发到线上"：
 * SPI 没有统一约定，所以这里多了**一堆档位字段**（读/写 opcode、地址并入 opcode 还是独立字节、
 * dummy、每寄存器字节数、多字节读是否自增）—— 内置档位把这些默认值填好，改一个字段就能试。
 * 帧构造与档位表在 `app/spi/regs.js`（纯逻辑，Node 自测直接打）。
 *
 * ⚠️ 两个 SPI 特有的"错一个字节就全错"的点，面板上给了显式字段，别省：
 *   · **dummy**：ADXL345 / BMP280 这类读之前要 1 个 dummy 字节，MPU-9250 / LSM6DS3 不要；
 *     给错了数据整体错位（假器件的寄存器模型会如实复现这个症状）。
 *   · **自增**：多数寄存器型器件连读会自动递增；不自增的器件连读会"原地踏步"（读回全一样）。
 */
import { $ } from '../ui/dom.js';
import { store } from '../core/store.js';
import { RegGrid } from '../ui/reg-grid.js';
import * as P from './protocol.js';
import * as G from './regs.js';

const h2 = v => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
/** 日志里那一行"读回来的头几个字节" */
const hexFirst = a => Array.from(a || []).slice(0, 12).map(h2).join(' ') + ((a?.length || 0) > 12 ? ' …' : '');

export class SpiRegView {
  /** @param {{session:object, log?:(kind:string,text:string)=>void}} opts */
  constructor({ session, log = null } = {}){
    this.session = session;
    this.log = log || ((k, t) => this.session.log(k, t, 'bus'));
    this.profile = G.profileById('bmp280');
    this.start = 0;
    this.count = G.REG_LEN_DFT;
    this.busy = false;
    this.connected = false;
    this.readKey = null;
    this.grid = new RegGrid({
      prefix: 'sp-reg', cols: G.REG_COLS,
      onEdit: () => this._renderSummary(),
      labels: {
        addr: off => this._addrLabel(off),
        title: (off, b, c) => `偏移 +${off}（${this._addrLabel(off)}）` +
          ` · 器件现值 0x${b != null ? h2(b) : '--'}` +
          (b != null && b !== c ? ` → 改成 0x${h2(c)}` : '') + '　点开改 bit',
        popTitle: off => `${this._addrLabel(off)}（缓冲第 ${off} 字节）`,
      },
    });
  }

  get base(){ return this.grid.base; }
  set base(v){ this.grid.base = v instanceof Uint8Array ? v : new Uint8Array(v || 0); }
  get cur(){ return this.grid.cur; }
  set cur(v){ this.grid.cur = v instanceof Uint8Array ? v : new Uint8Array(v || 0); }
  get length(){ return this.grid.length; }

  /** 缓冲里第 off 字节属于哪个寄存器（`dataBytes>1` 时每 2/4 字节一个寄存器）*/
  _regOf(off){ return this.start + Math.floor(off / Math.max(1, this.profile.dataBytes | 0)); }
  _addrLabel(off){
    const p = this.profile;
    return p.kind === G.KIND.CMD ? `#${this._regOf(off)}` : G.regLabel(p, this._regOf(off));
  }

  init(){
    // 档位表
    const sel = $('sp-reg-profile');
    for (const p of G.PROFILES){
      const o = new Option(p.name, p.id);
      // 档位下拉的 title 里把"把握程度 + 约定 + 手册出处"都给出来（改之前先看它对不对得上手册）
      o.title = [p.verified ? `把握：${p.verified}` : '', p.note, p.ref ? `出处：${p.ref}` : '']
        .filter(Boolean).join('\n');
      sel.appendChild(o);
    }
    sel.value = store.get('spi.regProfile', 'bmp280');
    // 恢复上次填的字段（调试时来回切页/刷新不该丢）
    const S = (id, key, def) => { $(id).value = String(store.get(key, def)); };
    S('sp-reg-rdop', 'spi.regRdOp', '0x80');
    S('sp-reg-wrop', 'spi.regWrOp', '0x00');
    S('sp-reg-start', 'spi.regStart', '0x00');
    S('sp-reg-count', 'spi.regCount', String(G.REG_LEN_DFT));
    S('sp-reg-addrmode', 'spi.regAddrMode', 'orOp');
    S('sp-reg-addrbytes', 'spi.regAddrBytes', '1');
    S('sp-reg-addrbits', 'spi.regAddrBits', '7');
    S('sp-reg-dummy', 'spi.regDummy', '1');
    S('sp-reg-databytes', 'spi.regDataBytes', '1');
    $('sp-reg-autoinc').checked = store.get('spi.regAutoInc', true) !== false;
    this._applyProfile(G.profileById(sel.value), { keepStart: false });
    for (const id of ['sp-reg-rdop', 'sp-reg-wrop', 'sp-reg-start', 'sp-reg-count', 'sp-reg-addrmode',
      'sp-reg-addrbytes', 'sp-reg-addrbits', 'sp-reg-dummy', 'sp-reg-databytes', 'sp-reg-autoinc']){
      $(id).addEventListener('change', () => { this._readFields(); this._saveParams(); this._renderSummary(); });
    }
    sel.addEventListener('change', () => {
      this._applyProfile(G.profileById(sel.value), { keepStart: true });
      this._saveParams();
      this._renderSummary();
    });
    const guard = fn => () => fn().catch(e => this.log('e', '寄存器面板：' + (e?.message || e)));
    $('sp-reg-read').addEventListener('click', guard(() => this.read()));
    $('sp-reg-write').addEventListener('click', guard(() => this.write({ only: true })));
    $('sp-reg-write-all').addEventListener('click', guard(() => this.write({ only: false })));
    $('sp-reg-discard').addEventListener('click', () => { this.grid.discard(); this._renderSummary(); });
    this.grid.init();
    this._render();
    this._renderSummary();
  }

  /** 档位 → 字段（`keepStart` = 切档位时保留用户填的起始/个数）*/
  _applyProfile(p, { keepStart = true } = {}){
    this.profile = p;
    $('sp-reg-rdop').value = p.readOp == null ? '' : '0x' + p.readOp.toString(16).toUpperCase().padStart(2, '0');
    $('sp-reg-wrop').value = p.writeOp == null ? '' : '0x' + p.writeOp.toString(16).toUpperCase().padStart(2, '0');
    $('sp-reg-addrmode').value = p.addrMode || 'none';
    $('sp-reg-addrbytes').value = String(p.addrBytes ?? 1);
    $('sp-reg-addrbits').value = String(p.addrBits ?? 7);
    $('sp-reg-dummy').value = String(p.dummy ?? 0);
    $('sp-reg-databytes').value = String(p.dataBytes ?? 1);
    $('sp-reg-autoinc').checked = p.autoInc !== false;
    if (!keepStart && p.startHint != null) $('sp-reg-start').value = '0x' + p.startHint.toString(16).toUpperCase();
    this._readFields();
  }

  /** 字段 → 内存里的档位对象（用户在字段上改过就以字段为准）*/
  _readFields(){
    const num = (id, def, hex = true) => {
      const t = String($(id).value ?? '').trim();
      if (!t) return def;
      const r = /^(?:0[xX])?([0-9a-fA-F]+)$/.exec(t);
      if (!r) return def;
      return hex ? parseInt(r[1], 16) : parseInt(r[1], 10);
    };
    const mode = $('sp-reg-addrmode').value;
    this.profile = {
      ...this.profile,
      readOp: num('sp-reg-rdop', 0x80), writeOp: num('sp-reg-wrop', 0x00),
      addrMode: ['orOp', 'bytes', 'none'].includes(mode) ? mode : 'orOp',
      addrBytes: Math.max(0, Math.min(4, num('sp-reg-addrbytes', 1, false))),
      addrBits: Math.max(0, Math.min(8, num('sp-reg-addrbits', 7, false))),
      dummy: Math.max(0, Math.min(4, num('sp-reg-dummy', 0, false))),
      dataBytes: Math.max(1, Math.min(4, num('sp-reg-databytes', 1, false))),
      autoInc: $('sp-reg-autoinc').checked,
    };
    this.start = num('sp-reg-start', 0);
    this.count = Math.max(1, Math.min(G.REG_LEN_MAX, num('sp-reg-count', G.REG_LEN_DFT, false)));
    return this.profile;
  }

  _saveParams(){
    store.set('spi.regProfile', $('sp-reg-profile').value);
    store.set('spi.regRdOp', $('sp-reg-rdop').value.trim());
    store.set('spi.regWrOp', $('sp-reg-wrop').value.trim());
    store.set('spi.regAddrMode', $('sp-reg-addrmode').value);
    store.set('spi.regAddrBytes', $('sp-reg-addrbytes').value.trim());
    store.set('spi.regAddrBits', $('sp-reg-addrbits').value.trim());
    store.set('spi.regDummy', $('sp-reg-dummy').value.trim());
    store.set('spi.regDataBytes', $('sp-reg-databytes').value.trim());
    store.set('spi.regAutoInc', $('sp-reg-autoinc').checked);
    store.set('spi.regStart', $('sp-reg-start').value.trim());
    store.set('spi.regCount', $('sp-reg-count').value.trim());
  }

  setEnabled(on){
    this.connected = !!on;
    this._syncButtons();
  }

  _syncButtons(){
    const on = this.connected && !this.busy;
    for (const id of ['sp-reg-read', 'sp-reg-write', 'sp-reg-write-all', 'sp-reg-discard']){
      const b = $(id);
      if (b) b.disabled = !on;
    }
    const w = $('sp-reg-write');
    if (w) w.disabled = !on || !this.grid.changedOffsets().length;
  }

  static keyOf(p, start, count){
    return `${p.kind}|${p.readOp}|${p.writeOp}|${p.addrMode}|${p.addrBytes}|${p.addrBits}|${p.dummy}|${p.dataBytes}|${p.autoInc}|${start}|${count}`;
  }

  /** 读一段寄存器 */
  async read(){
    if (this.session.busy || this.busy){ this.log('w', 'SPI 任务尚未结束'); return; }
    const p = this._readFields();
    this._saveParams();
    const frames = G.readPlan(p, this.start, this.count).frames;
    if (!frames.length){ this.log('w', '寄存器面板：没有要读的帧'); return; }
    this.busy = true; this.session.setBusy?.(true); this._syncButtons();
    try {
      const items = G.itemsOf(frames);
      const r = await this.session.sendFrames(items, { tag: 'bus', timeoutMs: 2500 });
      const { data, bad } = G.joinReads(frames, r.rsps);
      if (bad){ this.log('e', `寄存器读：${bad} 帧没有有效应答（接线 / 片选 / dummy / 档位先核一遍）`); }
      if (!data.length){
        this._renderSummary();
        return;
      }
      this.readKey = SpiRegView.keyOf(p, this.start, this.count);
      this.grid.setData({ base: data, cur: data.slice() });
      this._render();
      this.log('ok', `寄存器读 ${p.name} · 起 ${G.regLabel(p, this.start)} × ${this.count}` +
        ` → ${data.length} B · ${frames.length} 帧 · ${hexFirst(data)}`);
    } finally {
      this.busy = false; this.session.setBusy?.(false); this._syncButtons();
      this._renderSummary();
      this.grid.reattach();
    }
  }

  /** 写回：`only` = 只写改动字节 */
  async write({ only = true } = {}){
    if (this.session.busy || this.busy){ this.log('w', 'SPI 任务尚未结束'); return; }
    if (!this.grid.length){ this.log('w', '寄存器面板：还没读过，先「读取」再写（不然不知道器件现状）'); return; }
    const p = this._readFields();
    if (this.readKey && SpiRegView.keyOf(p, this.start, this.count) !== this.readKey){
      this.log('e', '寄存器面板：档位 / 起始 / 个数在「读取」之后被改过 —— 现在写回会把旧配置读回来的数据按新配置写下去。请先重新「读取」');
      return;
    }
    const offs = only ? this.grid.changedOffsets() : null;
    if (only && !offs.length){ this.log('w', '寄存器面板：没有改动，不用写'); return; }
    const plan = G.writePlan(p, this.start, this.grid.cur, { offsets: offs });
    if (!plan.frames.length){ this.log('w', '寄存器面板：没有要写的帧'); return; }
    this.busy = true; this.session.setBusy?.(true); this._syncButtons();
    try {
      const r = await this.session.sendFrames(G.itemsOf(plan.frames), { tag: 'bus', timeoutMs: 2500 });
      const failed = (r.rsps || []).filter(x => !x || x.error || x.status !== P.ST.OK).length;
      if (failed){
        this.log('e', `寄存器写：${plan.frames.length} 帧里有 ${failed} 帧没成功 —— 器件现值未更新（表里保留你的改动）`);
        return;
      }
      this.grid.base = this.grid.cur.slice();
      this._render();
      this.log('ok', `寄存器写 ${p.name} · 起 ${G.regLabel(p, this.start)} × ` +
        `${offs ? offs.length : this.grid.cur.length} B（${offs ? '只写改动' : '整块'}） → ${plan.frames.length} 帧`);
    } finally {
      this.busy = false; this.session.setBusy?.(false); this._syncButtons();
      this._renderSummary();
      this.grid.reattach();
    }
  }

  _render(){ this.grid.render(); this._syncButtons(); }

  _renderSummary(){
    const sum = $('sp-reg-sum');
    if (!sum) return;
    const p = this.profile;
    const 把握 = p.verified && p.verified !== '手册已核' ? `（${p.verified}）` : '';
    let head = `${p.name}${把握} · 起 ${p.kind === G.KIND.CMD ? '#' : ''}${G.regLabel(p, this.start)} × ${this.count} 寄存器`;
    head += `（${p.kind === G.KIND.CMD ? `命令型 · 每帧回 ${p.rx ?? 1} B`
      : `${p.dataBytes} B/寄存器 · ${p.addrMode === 'orOp' ? `opcode 或地址(低 ${p.addrBits} 位)` : p.addrMode === 'bytes' ? `${p.addrBytes} B 地址` : '无地址'}` +
        `${p.dummy ? ` · dummy ${p.dummy} B` : ''}${p.autoInc ? '' : ' · 读不自增（一寄存器一帧）'}` +
        `${p.kind !== G.KIND.CMD && p.autoIncWrite === false ? ' · 写不自增（一寄存器一帧）' : ''}` +
        `${Number.isInteger(p.multiReadBit) ? ` · 多字节读置 bit${p.multiReadBit}` : ''}`}）`;
    if (!this.grid.length) sum.textContent = `还没读 —— ${head}`;
    else {
      const d = this.grid.changedOffsets().length;
      const plan = G.readPlan(p, this.start, this.count);
      sum.textContent = `${head} · 读回 ${this.grid.length} B（${plan.frames.length} 帧${plan.batch ? ' · 一条命令连读' : ''}）` +
        (d ? ` · 改了 ${d} 个字节（可「只写改动」）` : ' · 没有改动');
    }
    this._syncButtons();
  }
}
