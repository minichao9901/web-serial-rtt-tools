/**
 * 「J-Scope 波形」页（`#scope`）—— 把变量选择、探针配置、收流、绘图、触发、导出串起来。
 *
 * 页面骨架沿用仓库既有约定：左侧栏放"设置"，工具栏/右下统计条放"操作与指标"。
 *
 * 数据通路（两条，页面里只差一个对象）：
 *   真机：HID 0x32 配置/启停（AkaLinkHid） + WebUSB 0x83 收流（VendorEpTransport）
 *   假机：同一个 MockScopeProbe 既当 HID 又当数据源（MockTransport 注入它）
 *   → 所以"假探针能跑通"就等于整条链路（配置 → 组包 → 收流 → 解码 → 缓冲 → 画图）跑通，
 *     这也是本页能在没有硬件时自测的原因。
 *
 * 采样是**一次性窗口**（线性缓冲，满了就停）：容量 = 名义速率 × 时长 × 1.25。
 * 满了之后新样本计入 `overrun` 并显示在"丢样本"里 —— 绝不静默丢。
 */
import { releaseLocalProbeUsers, prepareProbeHandoff } from '../core/probe-users.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { waitMs } from '../core/pace.js';
import { $, setStatus, seg, esc } from '../ui/dom.js';
import { store } from '../core/store.js';
import { AkaLinkHid } from '../hid/probe.js';
import { Elf } from '../elf/elf.js';
import { listSampleable } from '../elf/dwarf.js';
import { arrayElementChannels } from './array-vars.js';
import * as P from './protocol.js';
import { SampleStore, Trigger, TRIG, TRIG_NAME, findTrigger, windowFor } from './store.js';
import { ScopeRenderer, legendRows, fmtTime, fmtVal, fmtHz } from './render.js';
import { VendorEpTransport, MockTransport } from './transport.js';
import { MockScopeProbe } from './mock.js';
import { bytes as fmtBytes, fileStamp, download } from '../core/format.js';

/** SWD 时钟档位：与 RTT Viewer 的 WebUSB 那档同款（0 = 自动）*/
const CLOCKS = [[0, '自动'], [1000, '1 MHz'], [5000, '5 MHz'], [10000, '10 MHz'], [20000, '20 MHz'],
                [30000, '30 MHz'], [40000, '40 MHz'], [45000, '45 MHz'], [50000, '50 MHz'], [60000, '60 MHz']];

const MAX_VARS = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ScopeView {
  /** @param {{mockFactory?:Function}} opts 自测可以换一个"带丢包/会卡住"的假探针 */
  constructor(opts = {}){
    this.mockFactory = opts.mockFactory || (o => new MockScopeProbe(o));
    this.elf = null;
    this.all = [];          // 所有可采样通道
    this.skipped = [];
    this.dwarf = null;
    this.arrayGroups = [];
    this.ram = null;
    this.selected = [];     // 勾选的（≤8）
    this.hid = null;        // 真：AkaLinkHid；假：MockScopeProbe
    this.transport = null;
    this.mockProbe = null;
    this.usingMock = false;
    this.store = null;
    this.renderer = null;
    this.stream = new P.PacketStream();
    this.seqT = new P.SeqTracker();
    this.timeU = new P.TimeUnwrap();
    this.trigger = new Trigger();
    this.defVars = null;
    this.raw = [];
    this.captureRaw = false;
    this.running = false;
    this.state = '空闲';
    this.packets = 0;
    this.lost = 0;
    this.decodeErr = 0;
    this.probeDropped = 0;
    this.swdMhz = 0;
    this.periodActualUs = 0;
    this._raf = 0;
    this._needDraw = true;
    this._lastPktT = null;      // 上一包的起始时刻 / 帧数（用来估包内真实间隔，见 DATA 分支）
    this._lastPktN = 0;
    this._capturing = false;    // 本轮采集还开着吗（DATA 分支据此决定入不入缓冲，见 start/stop）
    this._wdTimer = null;       // 数据面看门狗（采集中断流的兜底）
    this._lastPktAt = 0;        // 最近收到一个包的时刻
    this.backend = null;        // **生效**后端：swd | riscv（只认探针回报的 DEF flags bit6 / 状态字 0 bit1）
    this.targetRiscv = null;    // 我们**请求**的目标类型（用于发现"请求 ≠ 生效"）
    this._askedAt = 0;          // 上次"请求切换目标类型"的时刻（见 uiBackend()：请求 vs 生效谁说了算）
    this._reportedAt = 0;       // 上次"探针回报生效后端"的时刻
  }

  // ================================================================= 初始化
  init(){
    this.canvas = $('sc-canvas');
    this.renderer = new ScopeRenderer(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.elfInput = this._fileInput('.elf,.axf', f => this.loadElfFile(f));
    this.jspInput = this._fileInput('.jsp,.bin', f => this.replayFile(f));

    // 时钟下拉
    const clk = $('sc-clock');
    for (const [v, label] of CLOCKS){
      const o = document.createElement('option');
      o.value = String(v); o.textContent = label;
      clk.appendChild(o);
    }
    clk.value = '0';

    // 触发模式 / 通道
    const tm = $('sc-trig-mode');
    for (const [v, label] of Object.entries(TRIG_NAME)){
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      tm.appendChild(o);
    }
    tm.value = String(TRIG.NONE);

    $('sc-connect').addEventListener('click', () => this.connectHid(true));
    $('sc-reconnect').addEventListener('click', () => this.connectHid(false));
    $('sc-usb').addEventListener('click', () => this.connectUsb(true));
    $('sc-mock').addEventListener('change', e => this.setMock(e.target.checked));
    $('sc-elf').addEventListener('click', () => this.elfInput.click());
    $('sc-varclear').addEventListener('click', () => { this.selected = []; this.renderVars(); this.updatePlan(); });
    $('sc-search').addEventListener('input', () => this.renderVars());
    $('sc-arrayadd').addEventListener('click', () => this.addArrayElement());
    $('sc-arraypath').addEventListener('keydown', e => {
      if (e.key === 'Enter'){ e.preventDefault(); this.addArrayElement(); }
    });
    $('sc-start').addEventListener('click', () => this.start());
    $('sc-stop').addEventListener('click', () => this.stop().catch(e => this.setStatusText(e.message, 'err')));
    $('sc-target').addEventListener('change', () => this.applyTargetType());
    /**
     * 装载时就把「目标类型」对齐到**全局那个开关**（HID 0x31 action 10，与 RTT Viewer 共用、且是**粘**的）：
     * 用户在 RTT 页切过 RISC-V、或上一次会话切过，这里却还显示 SWD —— 同一个开关两页显示不一致，
     * 最容易被当成 bug（"我明明切过了"）。跟随后，`uiBackend()` 立刻按 RISC-V/JTAG 显示（时钟格名字、
     * 置灰、读计划的分档），不必等采样回报。
     */
    const savedTarget = store.get('rtt.target', '');
    if (savedTarget === 'riscv' || savedTarget === 'swd') $('sc-target').value = savedTarget;
    this.targetRiscv = $('sc-target').value === 'riscv';
    store.bind($('sc-target'), 'rtt.target');       // 这一页改 = 改同一个全局开关，落回同一个键
    $('sc-bench').addEventListener('click', () => this.bench());
    $('sc-recc').addEventListener('click', () => this.applyRecPeriod());
    for (const id of ['sc-period', 'sc-clock', 'sc-batch', 'sc-cdcoff'])
      $(id).addEventListener(id === 'sc-period' ? 'input' : 'change', () => this.updatePlan());
    $('sc-clear').addEventListener('click', () => this.clear());
    $('sc-fit').addEventListener('click', () => { this.renderer.fitAll(); this.follow = true; this._needDraw = true; });
    $('sc-zin').addEventListener('click', () => { this.renderer.zoomBy(1.6, 0.5); this._needDraw = true; });
    $('sc-zout').addEventListener('click', () => { this.renderer.zoomBy(1 / 1.6, 0.5); this._needDraw = true; });
    $('sc-zoompts').addEventListener('click', () => this.zoomToPoints());
    $('sc-shared').addEventListener('change', e => { this.renderer.mode = e.target.checked ? 'shared' : 'auto'; this._needDraw = true; });
    // 叠加 / 分道：分道 = 每通道一条泳道、各自独立量程（多通道混合单位的正解）
    this._layoutSeg = seg(document.querySelector('[data-group=sclayout]'), 'overlay', v => {
      this.renderer.layout = v;
      this.renderer._ranges = [];            // 换布局时丢掉防抖缓存，避免量程残留
      this._needDraw = true;
      this.setStatusText(v === 'lanes'
        ? `分道显示：${this.renderer.visibleCount?.() ?? '各'}通道各占一条泳道，每条自己的量程`
        : '叠加显示：所有通道画在同一片区域', '');
    });
    $('sc-mark-clear').addEventListener('click', () => {
      if (!this.renderer.cursors.a && !this.renderer.cursors.b){ this.setStatusText('还没有放游标：点一下波形放 A、Shift+点放 B', 'warn'); return; }
      this.renderer.clearMarks();
      this._needDraw = true;
      this.setStatusText('已清除测量游标 A/B', '');
    });
    $('sc-raw').addEventListener('change', e => { this.captureRaw = e.target.checked; if (!this.captureRaw) this.raw = []; });
    $('sc-csv').addEventListener('click', () => this.exportCsv());
    $('sc-save').addEventListener('click', () => this.saveRaw());
    $('sc-open').addEventListener('click', () => this.jspInput.click());
    $('sc-trig-find').addEventListener('click', () => this.findNextTrigger());
    $('sc-trig-clear').addEventListener('click', () => this.clearTrigger());
    for (const id of ['sc-trig-mode', 'sc-trig-ch', 'sc-trig-level', 'sc-trig-pre', 'sc-trig-post', 'sc-trig-single']){
      $(id).addEventListener('change', () => this.applyTrigger());
    }

    this._wireCanvas();
    this._wireKeys();
    this.renderVars();
    this.updatePlan();
    this._applyBackendUi();          // 装载就按「目标类型」（可能是上次的 RISC-V/JTAG）摆好时钟格与建议
    this.syncButtons();
    this._loop();
  }

  _fileInput(accept, onFile){
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.hidden = true;
    inp.addEventListener('change', () => { const f = inp.files?.[0]; if (f) onFile(f); inp.value = ''; });
    document.body.appendChild(inp);
    return inp;
  }

  _wireCanvas(){
    const c = this.canvas;
    let dragging = false, lastX = 0, moved = 0, grab = null, shiftClick = false;
    /** 鼠标落在哪条测量游标上（±5 px 内算抓住它）*/
    const markNear = x => {
      for (const which of ['a', 'b']){
        const m = this.renderer.markAt(which);
        if (m && Math.abs(this.renderer.xOf(m.index) - x) <= 5) return which;
      }
      return null;
    };
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left - this.renderer.padding.l) / this.renderer.plotW));
      this.renderer.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, frac);
      this.follow = false;                      // 手动缩放即退出"跟随最新"
      this._needDraw = true;
    }, { passive: false });
    c.addEventListener('mousedown', e => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      grab = e.button === 0 ? markNear(x) : null;      // 抓在游标线上 = 拖它，不是平移
      dragging = !grab; lastX = e.clientX; moved = 0; shiftClick = e.shiftKey;
      c.style.cursor = grab ? 'ew-resize' : 'grabbing';
    });
    window.addEventListener('mouseup', e => {
      if (grab){ dragging = false; grab = null; c.style.cursor = 'crosshair'; return; }
      if (!dragging) return;
      dragging = false; c.style.cursor = 'crosshair';
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (moved >= 4 || !this.store?.count) return;    // 拖动过 = 平移，不当点击
      if (x < this.renderer.padding.l || x > c.clientWidth - this.renderer.padding.r) return;
      // 单击放 A、Shift+单击放 B（量周期就靠这两条线）
      const which = shiftClick ? 'b' : 'a';
      const idx = Math.round(this.renderer.sampleAt(x));
      const at = this.renderer.setMark(which, idx);
      this._needDraw = true;
      const d = this.renderer.delta();
      this.setStatusText(d
        ? `游标 ${which.toUpperCase()} 放在样本 #${at} · Δt ${fmtTime(d.absUs)} → ${fmtHz(d.hz)}`
        : `游标 ${which.toUpperCase()} 放在样本 #${at}（再 ${which === 'a' ? 'Shift+' : ''}点一下放 ${which === 'a' ? 'B' : 'A'} 就能量间隔）`, '');
    });
    window.addEventListener('mousemove', e => {
      const r = c.getBoundingClientRect();
      if (grab){
        const x = e.clientX - r.left;
        if (x >= this.renderer.padding.l && x <= c.clientWidth - this.renderer.padding.r){
          this.renderer.setMark(grab, Math.round(this.renderer.sampleAt(x)));
          this._needDraw = true;
        }
        return;
      }
      if (dragging){
        const dx = e.clientX - lastX;
        lastX = e.clientX; moved += Math.abs(dx);
        this.renderer.panBy(-dx / this.renderer.plotW * this.renderer.span);
        this.follow = false;
        this._needDraw = true;
        return;
      }
      if (!this.store) return;
      const x = e.clientX - r.left;
      if (x < this.renderer.padding.l || x > c.clientWidth - this.renderer.padding.r){ this.renderer.cursor = null; this._needDraw = true; return; }
      const idx = Math.round(this.renderer.sampleAt(x));
      this.renderer.cursor = (idx >= 0 && idx < this.store.count) ? idx : null;
      this._needDraw = true;
    });
    c.addEventListener('dblclick', () => { this.renderer.fitAll(); this.follow = true; this._needDraw = true; });
  }

  onShow(){
    requestAnimationFrame(() => { this._needDraw = true; });
    /**
     * 每次切到本页都对一次**全局目标类型**（`rtt.target`，与 RTT Viewer 共用同一个键）：
     * 用户很可能在 RTT 页刚切过 RISC-V —— 那边一改，这边得跟着（否则"同一个开关两页显示不一样"，
     * 用户只会以为切换没生效）。真不一致就按新值刷新界面（时钟格名字/置灰/读计划）。
     */
    const saved = store.get('rtt.target', '');
    if ((saved === 'riscv' || saved === 'swd') && saved !== $('sc-target').value){
      $('sc-target').value = saved;
      this.targetRiscv = saved === 'riscv';
      this._applyBackendUi();
    }
  }

  /** 键盘：Esc 清测量游标、Home/End 跳首尾（只在探针页可见、焦点不在输入框时生效）*/
  _wireKeys(){
    window.addEventListener('keydown', e => {
      const tab = document.getElementById('tab-scope');
      if (!tab || !tab.classList.contains('active')) return;      // 切页由 tabs.js 管（.active）
      const t = e.target;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const st = this.store;
      if (e.key === 'Escape'){
        if (!this.renderer.cursors.a && !this.renderer.cursors.b && this.renderer.cursor == null) return;
        const had = !!(this.renderer.cursors.a || this.renderer.cursors.b);
        this.renderer.clearMarks();
        this.renderer.cursor = null;
        this._needDraw = true;
        if (had) this.setStatusText('已清除测量游标 A/B', '');
        return;
      }
      if (!st?.count) return;
      if (e.key === 'Home' || e.key === 'End'){
        const w = Math.min(st.count, Math.round(this.renderer.span));
        const start = e.key === 'Home' ? 0 : Math.max(0, st.count - w);
        this.follow = false;
        this.renderer.zoomTo(start, start + w);
        this._needDraw = true;
        e.preventDefault();
      }
    });
  }

  /** 「细看」：把视窗缩到"每列约 1 个采样点"，这时渲染器走**折线连点**模式 ——
   *  看慢信号（100 Hz 正弦这类）的波形形状要靠它，全览时看到的是包络带。 */
  zoomToPoints(){
    const st = this.store;
    if (!st?.count){ this.setStatusText('还没有数据', 'warn'); return; }
    const w = Math.max(64, Math.round(this.renderer.plotW));
    const end = st.count;
    this.follow = false;
    this.renderer.zoomTo(Math.max(0, end - w), end);
    this._needDraw = true;
    this.setStatusText(`细看：${Math.round(this.renderer.span)} 个样本铺满 ${w} 列（≈1 点/列）`, '');
  }

  // ================================================================= 连接
  async connectHid(request){
    if (this._hidConnectPromise) return await this._hidConnectPromise;
    if (this._releasing || this.usingMock) return;
    if (this.running || this._starting){ this.setStatusText('先停止采样，再重连探针', 'warn'); return; }
    this._hidConnectPromise = runProbeOperation(this, 'scope', () => this._connectHidNow(request), { reason: 'J-Scope 要连接探针', recovery: true });
    try { return await this._hidConnectPromise; }
    catch (e){ this.setStatusText(e.message, 'err'); return false; }
    finally { this._hidConnectPromise = null; }
  }

  async _connectHidNow(request){
    if (this.usingMock){ this.setStatusText('假探针模式下不需要连真探针', 'warn'); return; }
    try {
      if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID（桌面版 Chrome / Edge 才有）');
      /**
       * 🚨 每次都 new 一个 `AkaLinkHid`，**旧的要先 close()**：老代码不关，
       *    旧 device 的 `inputreport` 监听和 `navigator.hid` 的 disconnect 监听会一直留着
       *    （代码审查抓到的）。用户反复点「重连」就会叠一层，旧句柄的回包还会去动 `_pending`。
       */
      const old = this.hid;
      if (old && old !== this.mockProbe){ try { await old.close(); } catch {} this.hid = null; }
      const hid = new AkaLinkHid();
      // 探针被复位/拔插 → 浏览器会发 disconnect：立刻把状态写清楚，别等用户点开始采样才报一句英文错
      hid.onDisconnect = () => {
        this.setStatusText('探针断开了（被复位、拔插或掉电？）—— 点「重连」，或拔插一次探针', 'err');
        $('sc-info').textContent = '探针已断开';
        if (this.running) this.stop().catch(() => {});
      };
      /**
       * 🚨 **先试"已授权直连"，连不上再弹选择框**（2026-10 用户诉求：「手动点连接一定要能成」）。
       *    原来 `request=true` 就只走 `navigator.hid.requestDevice()` —— 每次都弹框，
       *    弹框在某些情况下会空手而归（列表里没设备 / 系统占用 / 点快了），
       *    用户看到的就是「没有选择设备」，很像"手动连接坏了"。
       *    已授权过的探针用 `getDevices()` 直连**不需要任何弹框**，一次点击就成 —— 那才是默认该走的路。
       */
      let connected = false;
      let lastErr = '';
      try { await hid.reconnect(); connected = !!hid.connected; } catch (e){ lastErr = e?.message || String(e); }
      if (!connected && request){
        try { await hid.request(); connected = !!hid.connected; } catch (e){ lastErr = e?.message || String(e); }
      }
      if (!connected){
        this.hid = null;
        this.setStatusText('连接探针失败：' + (lastErr || '浏览器里没有已授权的探针') +
          ' —— 点「连接探针」在弹出的列表里选 akaLinkPro（授权过一次以后就直连，不再弹框）', 'err');
        return;
      }
      this.hid = hid;
      let info = '';
      try { const i = await hid.info(); info = `${i.model || 'akaLinkPro'}${i.fw ? ' · FW ' + i.fw : ''}`; }
      catch {
        // 连上了但问不出型号 —— 十有八九选错了设备（触摸板/键盘也有 0xFF00 的 collection）
        info = hid.label || '未知 HID 设备';
        $('sc-info').textContent = info + '（HID 已连接，但问不出型号）';
        this.setStatusText(`连到的 HID 设备是「${info}」，但它不响应探针协议 —— ` +
          '选错设备了？请点「连接探针」并在弹框里选 akaLinkPro', 'err');
        return;
      }
      $('sc-info').textContent = info + '（HID 已连接）';
      this.setStatusText(`探针已连接：${info}`, hid.isProbe ? 'ok' : 'warn');
      if (!hid.isProbe){
        $('sc-info').textContent = info + '（HID 已连接 · ⚠ 不是 akaLinkPro 的 VID/PID）';
        this.setStatusText(`⚠ 连到的是「${info}」（VID/PID 不是 0d28:0204）—— 可能选错设备了`, 'warn');
      }
    } catch (e){
      this.setStatusText('连接探针失败：' + (e?.message || e), 'err');
    }
  }

  /**
   * 连数据端点（WebUSB 的 0x83）。
   * request=true 弹设备框；false 时先用浏览器**已授权**的设备直接连
   * （和 HID 的「重连」一个道理：授权过一次就不用再点弹框，自动化测试也走这条路）。
   */
  async connectUsb(request = true){
    if (this._usbConnectPromise) return await this._usbConnectPromise;
    if (this._releasing || this.usingMock) return;
    if (this.running || this._starting){ this.setStatusText('先停止采样，再重连数据端点', 'warn'); return; }
    this._usbConnectPromise = runProbeOperation(this, 'scope', () => this._connectUsbNow(request), { reason: 'J-Scope 要使用数据端点', recovery: true });
    try { return await this._usbConnectPromise; }
    catch (e){ this.setStatusText(e.message, 'err'); return false; }
    finally { this._usbConnectPromise = null; }
  }

  async _connectUsbNow(request = true){
    if (this.usingMock){ this.setStatusText('假探针模式下不需要数据端点', 'warn'); return; }
    try {
      await prepareProbeHandoff(this, 'scope', 'J-Scope 要使用数据端点');
      // 先关掉可能残留的旧对象（否则新的一次 claim 会被自己上一把占着而失败）
      if (this.transport){ await this.transport.close(); this.transport = null; }
      /**
       * 🚨 和「连接探针」同一条原则：**先用已授权的设备直连**（不弹框），
       *    只有浏览器里还没有授权记录时才弹选择框。用户点一次就该成。
       */
      const list = await VendorEpTransport.authorized();
      if (list.length){
        this.transport = new VendorEpTransport(list[0]);
        try { await this.transport.open(); }
        catch (e){
          if (!request) throw e;
          // 已授权设备认领失败（比如接口被别的会话占着）→ 让对方重新选一次设备，给一条出路
          console.warn('[scope] 已授权设备认领失败，改用选择框：' + (e?.message || e));
          this.transport = await VendorEpTransport.request();
        }
      } else if (request){
        this.transport = await VendorEpTransport.request();
      } else {
        throw new Error('浏览器里没有已授权的探针（点「连接数据端点…」授权一次）');
      }
      $('sc-usbinfo').textContent = this.transport.label;
      this.setStatusText('数据端点已就绪：' + this.transport.label, 'ok');
    } catch (e){
      this.transport = null;                    // 没认领成功就别留着一个"半开"的对象：start() 会误以为能用
      $('sc-usbinfo').textContent = '连接失败：' + (e?.message || e);
      this.setStatusText('连接数据端点失败：' + (e?.message || e), 'err');
    }
  }

  /**
   * **让出探针**：停采样 + 关数据端点 + 松掉 HID。
   *
   * 给「跨标签页协调」用的（见 app/core/probe-bus.js）：别的页签要烧录时会喊一嗓子，
   * 本页收到就得把探针交出去 —— 一个 USB 接口同时只能被一个连接认领，
   * 而且探针物理上只有一套调试引擎，两个页签一起用本来就是错的。
   * 让出之后本页回到"未连接"状态，用户再点「连接探针」就能重新拿回来（不会自锁）。
   */
  async releaseProbe(reason = '别的页签要占用探针'){
    this.probeManager?.cancel('scope');
    if (this._releasePromise) return await this._releasePromise;
    this._releasePromise = this._releaseProbeNow(reason);
    try { return await this._releasePromise; }
    finally { this._releasePromise = null; }
  }

  async _releaseProbeNow(reason){
    this._releasing = true;
    let failure;
    try { await this.stop(reason); } catch (e) { failure = e; }
    await Promise.allSettled([this._hidConnectPromise, this._usbConnectPromise].filter(Boolean));
    const t = this.transport;
    if (t){
      try { await t.close(); this.transport = null; }
      catch (e){ failure ||= e; this.probeManager?.fail('scope', e); }
    }
    const h = this.hid;
    if (h && h !== this.mockProbe){
      try { await h.close(); this.hid = null; }
      catch (e){ failure ||= e; this.probeManager?.fail('scope', e); }
    }
    if (this.hid === null){
      const info = $('sc-info'); if (info) info.textContent = '未连接（已让出探针：' + reason + '）';
    }
    const ui = $('sc-usbinfo'); if (ui) ui.textContent = '未连接数据端点';
    this._releasing = false;
    if (failure){ this.setStatusText(failure.message, 'err'); throw failure; }
    this.probeManager?.forget('scope');
    this.setStatusText('已让出探针（' + reason + '）—— 需要时点「连接探针 / 数据端点」重新占用', 'warn');
    this.syncButtons();
    return true;
  }

  async setMock(on){
    await this.releaseProbe('切换模拟目标');
    this.usingMock = !!on;
    this.running = false;
    this._capturing = false;
    // 换模式先把旧的链路收干净（代码审查：切来切去会漏监听器/漏定时器）
    const oldT = this.transport;
    if (oldT) { this.transport = null; oldT.stop?.().catch?.(() => {}); }
    if (on){
      // 真实 HID 句柄要让位：它的 inputreport / disconnect 监听不能一直挂着（切回真机时重连即可）
      if (this.hid && this.hid !== this.mockProbe){ const old = this.hid; this.hid = null; old.close?.().catch?.(() => {}); }
      this.mockProbe = this.mockProbe || this.mockFactory({ periodUs: this.periodUs(), startDelayPolls: 1 });
      this.hid = this.mockProbe;
      this.transport = new MockTransport({ probe: this.mockProbe });
      $('sc-info').textContent = '假探针（无需硬件）';
      $('sc-usbinfo').textContent = '假探针模式：数据由页面生成';
      this.setStatusText('已切到假探针：选变量 → 开始采样 即可看到波形', 'ok');
    } else {
      if (this.hid === this.mockProbe) this.hid = null;
      $('sc-info').textContent = '未连接';
      $('sc-usbinfo').textContent = '未连接数据端点（假探针模式不需要）';
      this.setStatusText('已切回真机模式：先连探针，再连数据端点', '');
    }
    this.syncButtons();
  }

  // ================================================================= ELF / 变量
  async loadElfFile(file){
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const elf = new Elf(buf);
      const r = listSampleable(elf);
      this.elf = { name: file.name, source: r.source, versions: r.versions, stats: r.stats, note: r.note || '' };
      this.all = r.sampleable;
      this.skipped = r.skipped;
      this.dwarf = r.dwarf || null;
      this.arrayGroups = r.arrays || [];
      this.ram = r.ram;
      const examples = $('sc-arrayexamples');
      examples.replaceChildren();
      for (const a of this.arrayGroups.slice(0, 512)){
        const option = document.createElement('option');
        option.value = `${a.name}[${a.lowerBound}]`;
        option.label = a.count != null ? `${a.name}（${a.count} 个元素）` : a.name;
        examples.appendChild(option);
      }
      $('sc-arrayinfo').textContent = this.dwarf
        ? `找到 ${this.arrayGroups.length} 组 RAM 数组；输入下标添加，结构体元素会列出可采成员。`
        : '需要带 DWARF 类型信息的 ELF 才能确定数组元素地址。';
      this.selected = this.selected.filter(v => this.all.some(a => a.name === v.name && a.addr === v.addr));
      $('sc-elfinfo').textContent =
        `${file.name} · ${r.source === 'dwarf' ? `DWARF ${r.versions.join('/')}` : '符号表（无可用调试信息）'} · ` +
        `直接列出 ${r.sampleable.length} 项 · 数组 ${this.arrayGroups.length} 组 · 未直接列出 ${r.skipped.length} 项` + (r.note ? `　⚠ ${r.note}` : '');
      this.renderVars();
      this.updatePlan();
      this.setStatusText(r.note
        ? `ELF 解析完成（${r.sampleable.length} 个通道，按符号表）—— ⚠ ${r.note}`
        : `ELF 解析完成：${r.sampleable.length} 个可采样通道`, r.note ? 'warn' : 'ok');
    } catch (e){
      $('sc-elfinfo').textContent = '解析失败：' + (e?.message || e);
      this.setStatusText('ELF 解析失败：' + (e?.message || e), 'err');
    }
  }

  addArrayElement(){
    try {
      if (this.running || this._starting) throw new Error('请先停止采样，再添加数组元素');
      if (this.usingMock) throw new Error('请关闭假探针后使用 ELF 数组元素');
      const channels = arrayElementChannels(this.dwarf, $('sc-arraypath').value, { ram: this.ram });
      for (const v of channels){
        if (!this.all.some(a => a.name === v.name && a.addr === v.addr)) this.all.push(v);
      }
      if (channels.length === 1){
        const v = channels[0];
        if (this.selected.length < MAX_VARS && !this.selected.some(s => s.name === v.name && s.addr === v.addr)) this.selected.push(v);
      }
      const path = $('sc-arraypath').value.trim();
      $('sc-search').value = path;
      this.renderVars(); this.updatePlan();
      $('sc-arrayinfo').textContent = channels.length === 1
        ? `已添加 ${channels[0].name} · ${channels[0].scalar} · 0x${channels[0].addr.toString(16)}${this.selected.some(s => s.name === channels[0].name && s.addr === channels[0].addr) ? '（已勾选）' : '；最多同时采样 8 项，请调整勾选。'}`
        : `已列出 ${channels.length} 个可采成员，请在列表中勾选需要的项。`;
      this.setStatusText($('sc-arrayinfo').textContent, 'ok');
    } catch (e){
      $('sc-arrayinfo').textContent = e?.message || String(e);
      this.setStatusText($('sc-arrayinfo').textContent, 'err');
    }
  }

  renderVars(){
    const box = $('sc-vars');
    if (!box) return;
    const q = ($('sc-search').value || '').trim().toLowerCase();
    const list = this.all.filter(v => !q || v.name.toLowerCase().includes(q));
    box.innerHTML = '';
    if (!this.all.length){
      box.innerHTML = '<div class="vsect">还没有变量：点「载入 ELF…」，或勾「用假探针」用内置的 8 个通道</div>';
    }
    for (const v of list.slice(0, 400)){
      const sel = this.selected.some(s => s.name === v.name && s.addr === v.addr);
      const row = document.createElement('label');
      row.className = 'vrow' + (sel ? ' sel' : '') + (!sel && this.selected.length >= MAX_VARS ? ' dis' : '');
      /* 🚨 变量名与类型名都来自**载入的 ELF**（外部输入）——拼进 innerHTML 前必须转义，
       *    否则一个名字里带 `<img onerror=…>` 的符号就能在这页执行脚本（2026-10 代码审查）。 */
      row.innerHTML = `<input type="checkbox" ${sel ? 'checked' : ''} ${!sel && this.selected.length >= MAX_VARS ? 'disabled' : ''}>` +
        `<span class="nm" title="${esc(v.name)}">${esc(v.name)}</span>` +
        `<span class="ty">${esc(v.scalar || v.typeName || '?')}</span>` +
        `<span class="ad">0x${v.addr.toString(16)}</span>`;
      row.querySelector('input').addEventListener('change', e => this.toggleVar(v, e.target.checked));
      box.appendChild(row);
    }
    if (list.length > 400){
      const more = document.createElement('div');
      more.className = 'vsect';
      more.textContent = `还有 ${list.length - 400} 个没显示 —— 用上面的搜索框缩小范围`;
      box.appendChild(more);
    }
    if (this.skipped.length){
      const s = document.createElement('div');
      s.className = 'vsect';
      const g = this.skipped.slice(0, 3).map(x => `${x.name}（${x.reason}）`).join('；');
      s.textContent = `未直接列出 ${this.skipped.length} 项，例如：${g}`;
      box.appendChild(s);
    }
    $('sc-count').textContent = `已选 ${this.selected.length} / ${MAX_VARS}`;
  }

  toggleVar(v, on){
    if (on){
      if (this.selected.length >= MAX_VARS){ this.setStatusText(`最多选 ${MAX_VARS} 个变量（8 个正好装进一条 HID 配置报文）`, 'warn'); this.renderVars(); return; }
      if (!this.selected.some(s => s.name === v.name && s.addr === v.addr)) this.selected.push(v);
    } else {
      this.selected = this.selected.filter(s => !(s.name === v.name && s.addr === v.addr));
    }
    this.renderVars();
    this.updatePlan();
  }

  updatePlan(){
    const vars = this.selected.length ? this.selected : this.mockVars();
    const plan = P.planReads(vars, { fastWordUs: this.fastWordUs(), swdMhz: this.planClockMhz() });
    this.plan = plan;
    const khz = Math.round(plan.estHz / 1000);
    /**
     * 计划行的主数字用 `bestUs`：单字 span 走固件的**流水快路径**时它是实测的 1.55 µs，
     * 而不是模型那按"每 span 3 次传输 + 每字 1 次 DRW"算出来的 4.47 µs。老写法把两个数并排写，
     * 用户一眼就看出自相矛盾：「模型估算 ≈6.7 µs → ≈148 kHz（偏保守：实测 ≈1.6 µs → 600 kHz 量级）」。
     */
    const useFast = plan.fastPath;
    const headlineUs = plan.bestUs;
    // 「按哪条路显示」= uiBackend()：生效后端优先，还没采样就按你刚选的目标类型 ——
    // 否则"切到 RISC-V/JTAG"这一步在读计划那行上看不出任何变化（用户 2026-09-30 现场）。
    const riscv = this.uiBackend() === P.BACKEND.RISCV;
    /**
     * 周期比"读一次"还短 ⇒ 探针必然跳拍，时间轴上会留空洞（主机看到的是洞，不是被压缩）。
     * 用户实测就是踩在这里：周期填 5 µs 想要 200 kHz，实得 112.9 kHz，
     * 于是「时长 3 s」按名义速率开出来的缓冲被填满花了 6.6 s。**这是开始采样前就该看见的**。
     */
    // 🚨 标定值只在"测的就是当前这套变量 + 时钟"时才算数（见 benchFresh）
    const fresh = this.benchFresh();
    const estUs = (fresh && this.benchUs) || this.planEstimateUs(plan);
    const advice = this.rateAdvice(plan);
    const slow = this.rateWarning(advice);
    const rateHint = $('sc-rate-advice');
    if (rateHint){
      const text = advice.valid
        ? `建议起始：${advice.recommendedUs} µs（${fmtHz(advice.recommendedHz)}）；` +
          `读取耗时上界 ≤${fmtHz(advice.readCeilingHz)}，不代表持续采样能力。` +
          (fresh ? '依据当前标定。' : '依据粗估，建议先标定。') + (slow ? ` ${slow}` : '稳定性以实采跳拍/USB计数为准。')
        : '采样周期必须是大于 0 的有限数值。';
      setStatus(rateHint, text, !advice.valid ? 'err' : slow ? 'warn' : '');
    }
    const benchTxt = this.benchUs
      ? (fresh
            ? ` · <b>已标定：读一次 ${this.benchUs.toFixed(3)} µs</b>（读取耗时上界，未包含组帧/USB/调度；建议周期 ≥ ${this.recPeriodUsFor(estUs)} µs）`
            : ` · <s>已标定 ${this.benchUs.toFixed(3)} µs</s> <b>已失效</b>（那是「${(this._benchKey || {}).vars} @${(this._benchKey || {}).clock} kHz」测的，${this.benchKeyWhy()} —— 重新点「标定真实速率」）`)
      : '';
    /**
     * RISC-V/JTAG 下计划行的写法（单字历史锚点与当前稳态扫描预算，见 P.RISCV_COST）：
     *   · 没有 SWD 那套"每 span 3 次传输"的模型，也没有 SWD 时钟档 —— 直接给**实测分档**
     *     （单字 3.17 µs / 8 通道 36.6 µs），再用同一组锚点摊一个"你这套变量大概多少"；
     *   · 顺带把"周期下限 2 µs"（SWD 流水读的下限）换成 JTAG 的说法，否则用户会照着 2 µs 填然后大面积丢拍。
     */
    const rv = P.BACKEND_COST.riscv;
    const rvEstUs = this.planEstimateUs(plan);
    const rvEstHz = rvEstUs > 0 ? 1e6 / rvEstUs : 0;
    const planTxt = riscv
      ? (plan.fastPath
          ? `单字 span：RISC-V/JTAG 历史读取耗时 ≈${rv.single} µs/样本（未包含完整推流开销）`
          : `RISC-V/JTAG 粗估 ≈${rvEstUs.toFixed(1)} µs/样本 → ≈${(rvEstHz / 1000).toFixed(1)} kHz` +
            `（读 ${plan.readBytes} B；每 span 为 N+4 次稳态 DMI 扫描，冷配置/重试另计）`) +
        '（以当前计划标定为准；建议周期取 1.5× 读取耗时，需实采验证）'
      : (useFast
          ? `单字 span 走固件流水快路径：历史读取耗时估算 ≈${headlineUs.toFixed(2)} µs/样本（未包含完整推流开销）` +
            `（保守模型算 ${plan.estUs.toFixed(1)} µs —— 稳态 N+2 次 SWD 传输及软件开销）`
          : `模型估算 ≈${plan.estUs.toFixed(1)} µs/样本 → ≈${khz} kHz` +
            (plan.spans.length === 1 && plan.frameBytes <= 4
              ? '（快路径要求整段正好 4 字节且 4 字节对齐，这个计划用不上）'
              : `（@${this.planClockMhz()} MHz 的粗估，实际读 ${plan.readBytes} B；真值以「标定读取耗时」为准）`));
    $('sc-plan').innerHTML = vars.length
      ? `读计划：${plan.spans.length} 个 span / 帧 ${plan.frameBytes} B · ` + planTxt +
        (!riscv && plan.saved > 0.15 ? `（合并省了 ${(plan.saved * 100).toFixed(0)}%）` : '') +
        benchTxt +
        '<br>时长 = 目标侧真实时间，到点自动停（缓冲只是内存上限）' +
        (slow || (riscv
          ? `（JTAG 单字历史读取耗时 ${rv.single} µs；周期比读取耗时短会跳拍）`
          : '（周期下限 2 µs；周期 < 读一次的耗时就会跳拍丢样本）'))
      : '选好变量后会显示读计划与预计上限';
    // 触发通道下拉跟着变量走
    const sel = $('sc-trig-ch');
    const want = vars.map(v => v.name);
    if (sel.options.length !== want.length || [...sel.options].some((o, i) => o.value !== String(i) || o.textContent !== want[i])){
      sel.innerHTML = '';
      want.forEach((n, i) => {
        const o = document.createElement('option');
        o.value = String(i); o.textContent = `${i}: ${n}`;
        sel.appendChild(o);
      });
    }
    return plan;
  }

  /** 假探针内置的 8 个通道（没载 ELF 时给界面用）*/
  mockVars(){
    const sc = ['f32', 'f32', 'i32', 'u16', 'i16', 'u8', 'i8', 'f64'];
    return sc.map((s, i) => ({ name: `mock${i}.${s}`, addr: 0x20000000 + i * 4, size: P.SCALARS[s].size, scalar: s }));
  }

  periodUs(){ return P.samplingRateAdvice(Number($('sc-period').value), 0).appliedUs ?? 100; }
  rateAdvice(plan = this.plan){
    const readUs = (this.benchFresh() && this.benchUs) || this.planEstimateUs(plan);
    return P.samplingRateAdvice(Number($('sc-period').value), readUs, this.uiBackend());
  }
  rateWarning(a = this.rateAdvice()){
    if (!a.valid) return '采样周期必须是大于 0 的有限数值。';
    const notes = [];
    if (a.normalized) notes.push(`填写 ${a.requestedUs} µs；按探针支持范围和时钟粒度采用 ${a.appliedUs} µs`);
    if (a.aboveRecommendation) notes.push(`${a.aboveReadCeiling ? '超过读取耗时上界' : '高于建议起始频率'}；建议 ${a.recommendedUs} µs（${fmtHz(a.recommendedHz)}）。继续将保留 ${a.appliedUs} µs 周期，来不及的拍会跳过，不会自动改为“最大速率”`);
    return notes.length ? `⚠️ ${notes.join('；')}；按真实时间轴显示，实际速率看采样统计。` : '';
  }
  seconds(){ return Math.max(0.5, Number($('sc-seconds').value) || 20); }

  // ================================================================= 采样
  async start(){
    if (this.running || this._startPromise || this._stopPromise || this._releasing) return;
    if (!this.selected.length && (!this.usingMock || !this.mockVars().length)){
      this.setStatusText('先选变量（或用假探针自带的通道）', 'warn'); return;
    }
    const g = this._captureGen = (this._captureGen || 0) + 1;
    this._starting = true;
    this._startTouched = false;
    this._captureCdcOff = !!$('sc-cdcoff')?.checked;
    this.syncButtons();
    this._startPromise = runProbeOperation(this, 'scope', () => this._startOnce(g), {
      mock: this.usingMock, reason: 'J-Scope 要开始采样',
      resources: this._captureCdcOff ? ['cdc-port'] : [],
      rejectResources: ['cdc-port'],
      conflictMessage: 'CDC 串口正在使用：请先关闭串口，或取消 JScope 的暂停 CDC 选项',
    });
    try { return await this._startPromise; }
    catch (e){ this.setStatusText(e.message, 'err'); return false; }
    finally {
      if (g === this._captureGen && !this.running){
        this._capturing = false; this._stopWatchdog();
        if (this._startTouched || this.transport?.running){
          try { await this._stopData(); } catch (e) { this.setStatusText('采样收尾失败：' + e.message, 'err'); }
        }
      }
      if (!this._cdcPausedRequested) this.probeManager?.narrow('scope');
      this._starting = false; this._startPromise = null; this.syncButtons();
    }
  }

  _captureAlive(g){ return g === this._captureGen && !this._stopPromise && !this._releasing; }

  async _stopData(){
    let failure;
    if (this._stopUnconfirmed && !this.hid) failure = new Error('探针未连接，不能确认 STOP');
    try { await this.transport?.quiesce?.(); } catch (e) { failure = e; }
    try { if (this.hid) await this.hidXfer(P.HID_CMD, P.flagsData(P.ACT.STOP)); }
    catch (e) { failure = e; }
    try { await this.transport?.stop(); } catch (e) { failure ||= e; }
    if (failure){
      this._stopUnconfirmed = true;
      const error = new Error('无法确认采样已停止：' + failure.message);
      this.probeManager?.fail('scope', error);
      throw error;
    }
    this._stopUnconfirmed = false;
    this._cdcPausedRequested = false;
    this.probeManager?.confirm('scope');
    this.probeManager?.narrow('scope');
  }

  async _startOnce(g){
    if (!P.samplingRateAdvice(Number($('sc-period').value), 0).valid){
      this.setStatusText('采样周期必须是大于 0 的有限数值；请修改后再开始', 'err');
      this.updatePlan();
      return;
    }
    const pick = (this.selected.length ? this.selected : (this.usingMock ? this.mockVars() : []));
    /**
     * 🚨 **必须按地址排序后再建缓冲**：固件把变量按**地址顺序**紧排在帧里（协议规定），
     *    DEF 里那张表也是地址顺序。而"勾选顺序"是用户随手点的 —— 两者不一致时，
     *    通道和数据会**整体错位**（实测：先勾 u_ramp(0x…20) 再勾 f_sin(0x…14)，
     *    结果 u_ramp 那一格装的是 f_sin 的 ±1，f_sin 那格装的是锯齿 0..999，
     *    图表和标签全对不上 —— 而且只在"勾选顺序 ≠ 地址顺序"时才出现，很容易漏）。
     */
    const vars = [...pick].sort((a, b) => a.addr - b.addr);
    if (!vars.length){ this.setStatusText('先选变量（或用假探针自带的通道）', 'warn'); return; }
    if (!this.usingMock && !this.probeManager){
      try { await releaseLocalProbeUsers('scope', 'J-Scope 要开始采样'); }
      catch (e) { this.setStatusText(e.message, 'err'); return; }
      if (!this._captureAlive(g)) return;
    }
    /**
     * 🚨 **没连上就自动连一次，别甩一句"探针没连上"**（2026-10 用户现场）：
     *    烧录页/RTT 页的探针会话**不会带给波形页**（每页各连各的），而且烧录会重设 USB 端口，
     *    别处已有的 WebHID/WebUSB 句柄会失效。用户刚烧完固件、切过来点「开始采样」，
     *    撞到的就是 `hidXfer` 抛的「探针没连上」—— 完全看不出该干什么。
     *    这里先用**已授权设备**静默重连（不弹框），失败了再给出可执行的提示。
     */
    if (!this.usingMock && (!this.hid || !this.transport)){
      this.setStatusText('探针还没连上，正在自动重连…', 'warn');
      if (!this.hid) await this._connectHidNow(false);
      if (!this.transport){
        try { await this._connectUsbNow(false); } catch (e){ /* 下面统一报错 */ }
      }
      if (!this._captureAlive(g)) return;
      if (!this.hid || !this.transport){
        this.setStatusText(!this.hid
          ? '探针没连上：点左边「连接探针」授权一次（烧录/别的页面用过的探针要在这里重连一下）'
          : '数据端点没连上：点「连接数据端点…」授权一次（采样数据走 EP 0x83，必须有它）', 'err');
        return;
      }
      /**
       * 🚨 重连后补发**目标类型**：探针侧是粘性状态，但探针被复位/别的页面重设过就回 SWD 了，
       *    而界面下拉还显示 RISC-V —— 不补发的话采样会按 SWD 去握，报一些看不懂的错。
       *    （start() 的 config 报文里也带 SCOPE_FLAG.RISCV，那是第二道保险。）
       */
      if (this.targetRiscv){
        try { await this.hidXfer(P.HID_CMD_RTT, P.targetTypeData(true)); } catch { /* 交给 start() 的 flags */ }
      }
      this.setStatusText('探针已自动重连，开始采样', 'ok');
    }
    if (!this.transport || !this.hid){ this.setStatusText(this.usingMock ? '假探针还没准备好' : '先连探针 + 数据端点', 'warn'); return; }
    if (this.isReal() && !this.transport?.device){ this.setStatusText('真机模式要先点「连接数据端点…」', 'warn'); return; }

    if (!this._captureAlive(g)) return;
    const periodUs = this.periodUs();
    const nominalHz = 1e6 / periodUs;
    /**
     * 缓冲容量只是**内存预算**，不再是"时长"的实现方式（见 _stopAfterUs）。
     * 1.1 的余量够用：探针的周期是下限，实得速率不会超过名义速率；
     * 真超了也还有"缓冲满就停"兜底。老代码用 1.25 还指望它凑时长，白占 25% 内存。
     */
    let capacity = Math.ceil(nominalHz * this.seconds() * 1.1) + 64;
    this._stopAfterUs = Math.round(this.seconds() * 1e6);
    this._stopReason = null;
    /**
     * 🚨 内存闸：周期可以设到 2 µs、时长可以设到几百秒，两者一乘就是几千万样本 ——
     *    8 通道 × 2 B × 1200 万 = 两百多 MB，标签页会卡死甚至崩。
     *    这里按"每样本字节数 × 通道数 × 1.35（LOD 开销）"估一下，超了就把容量砍到 256 MB 以内
     *    并**明说**砍了多少（宁可少存点，也不能让页面挂掉还不知道为什么）。
     */
    const bytesPerFrame = vars.reduce((s, v) => s + (P.SCALARS[v.scalar]?.size || 4), 0);
    this._frameBytes = bytesPerFrame;
    const LIMIT = 128 * 1024 * 1024;
    let capNote = '';
    const est = cap => cap * bytesPerFrame * 1.35 + vars.length * 8192;
    if (est(capacity) > LIMIT){
      const capped = Math.max(1024, Math.floor((LIMIT - vars.length * 8192) / (bytesPerFrame * 1.35)));
      capNote = `　⚠️ 缓冲按内存上限（128 MB）从 ${capacity} 收到 ${capped} 个样本` +
        `（${((capped / nominalHz)).toFixed(2)} s @${(nominalHz / 1000).toFixed(1)} kHz）`;
      capacity = capped;
    }
    // DATA traffic includes the packet header and unused payload tail. There is
    // no fixed 1.75 MB/s ceiling; sustained throughput is measured separately.
    const wireBps = P.PACKET / Math.floor(P.PAYLOAD / bytesPerFrame) * nominalHz;
    const wireNote = `　预计 DATA 流量 ${(wireBps / 1048576).toFixed(2)} MB/s（另有状态包）；稳定上限以实采跳拍/USB 计数为准`;
    this.plan = this.updatePlan();
    this.defVars = null;
    this._periodUs = periodUs;
    this._capacity = capacity;
    this.store = new SampleStore(vars, capacity);
    this.renderer.setStore(this.store);
    this.renderer.setTrigger(null);
    this.renderer.clearMarks();     // 新的一轮 = 新的样本编号，旧游标位置没意义
    this.renderer.cursor = null;
    this._lastPktT = null; this._lastPktN = 0;    // 包内间隔估计也要重新起头（见 DATA 分支）
    this.stream = new P.PacketStream();
    this.seqT = new P.SeqTracker();
    this.timeU = new P.TimeUnwrap();
    this._awaitDef = true;          // 起跑线：丢掉上一轮的残留包，等新一轮的 DEF
    this.stalePackets = 0;
    this.trigger = new Trigger();
    this.applyTrigger(true);
    this.packets = 0; this.lost = 0; this.decodeErr = 0; this.probeDropped = 0; this.raw = [];
    this.usbDrop = 0; this.probeYield = 0; this.readErrors = 0; this.probeMetrics = null; this.metricsError = null;
    this.rawBytes = 0;

    try {
      this.transport.configureReadAhead?.(wireBps);
      await this.transport.prepare?.();
      if (!this._captureAlive(g)) return;
      const clockKhz = Number($('sc-clock').value) || 0;
      /**
       * flags：bit0 允许 60 MHz；bit4 SWD 空闲拍压 0；bit5 采样时暂停 CDC/串口桥；
       *        **bit6 强制本次会话走 RISC-V/JTAG**（不带就跟随全局目标类型）。
       * 带上 bit6 是"双保险"：万一全局类型还是 SWD，这一条也能把它拧到 RISC-V；探针拉不起来时
       * 会自己换另一条路重试，所以我们只把**请求**发下去，显示一律用探针回报的生效值。
       */
      const flags = (clockKhz >= 60000 ? P.SCOPE_FLAG.ALLOW_60M : 0)
        | (this._captureCdcOff ? P.SCOPE_FLAG.CDC_OFF : 0)
        | ($('sc-batch')?.checked ? P.SCOPE_FLAG.FAST_BATCH : 0)
        | (this.targetRiscv ? P.SCOPE_FLAG.RISCV : 0);
      if (clockKhz > 0 && this.uiBackend() !== P.BACKEND.RISCV) await this.hidXfer(P.HID_CMD, P.clockData(clockKhz * 1000));
      /**
       * 🚨 **CONFIG 之后当场读一次 rc**（2026-10 代码审查）：固件的配置动作是**同步判定**的，
       *    应答里那个返回码就是本次配置的结果（0 = 已采纳、-6 = 被拒：变量宽度非法）。
       *    不看它的话，被拒之后固件已经**把变量表清空了**，紧接着的 START 会回 -3 →
       *    页面显示"变量表为空（先在左侧选 1~8 个变量）"，而用户明明选了变量，方向全错。
       */
      if (!this._captureAlive(g)) return;
      this._cdcPausedRequested = !!this._captureCdcOff && !this.usingMock;
      this._startTouched = true;
      this._captureFlags = flags;
      const cfgRes = await this.configureScope({ periodUs, flags, vars });
      if (!this._captureAlive(g)) return;
      if (!cfgRes || cfgRes.length < 3) throw new Error('采样配置响应不完整');
      const cfgRc = this.signed(cfgRes?.[2]);
      if (cfgRc < 0 && cfgRc !== P.START_PENDING){
        this._capturing = false;
        this.setStatusText('采样配置被拒：' + P.scopeRcText(cfgRc, this.targetRiscv), 'err');
        return;
      }

      /**
       * 🚨 **先开数据面读，再让探针开跑** —— 顺序反了会丢起跑线。
       *    真机实测的教训：早先先发 START、再轮询 STATUS 等启动码（那是 120~240 ms），
       *    这期间探针已经灌了几百个包，而设备只有 4 个包缓冲 ⇒ 最先发出的 **DEF 包
       *    早就被丢掉**，于是"等 DEF 当起跑线"的守卫永远等不到、新采集一个样本都没有。
       *    现在先 start() 读起来（顺便把上一轮的残留吃掉），再发 START。
       */
      await this.transport.start(chunk => { if (this._captureAlive(g)) this.onChunk(chunk); }, e => { if (this._captureAlive(g)) this._onDataPlaneDead(e); });
      if (!this._captureAlive(g)) return;
      if (!this.transport.running) throw new Error('数据端点未能启动');
      this._startWatchdog();          // 采集中途断流的兜底（见 _onDataPlaneDead 的说明）
      this._awaitDefSince = performance.now();
      /**
       * 「本轮采集还开着」的开关（DATA 分支据此决定要不要入缓冲）。
       * 🚨 不能用 `this.running` 当这个开关：DEF 到了之后、START 的 STATUS 轮询（120~240 ms）
       *    还没 resolve 的这段时间里 running 仍是 false —— 那批**新一轮的真实数据**会被整包丢掉
       *    （起跑段样本缺失、触发也晚布防）。丢掉上一轮残留的职责已经由 `_awaitDef` 承担。
       *    而收工后（stop 里把 _capturing 置 false）又必须真的不入缓冲 —— 见 DATA 分支。
       */
      this._capturing = true;

      let rc = P.START_PENDING;
      await this.hidXfer(P.HID_CMD, P.flagsData(P.ACT.START));
      if (!this._captureAlive(g)) return;
      for (let i = 0; i < 20 && rc === P.START_PENDING; i++){    // -100 = 排队中，轮询等结果
        await waitMs(120);
        if (!this._captureAlive(g)) return;
        const res = await this.hidXfer(P.HID_CMD, P.flagsData(P.ACT.STATUS));
        if (!this._captureAlive(g)) return;
        if (!res || res.length < 3) throw new Error('采样状态响应不完整');
        rc = this.signed(res[2]);
        this._absorbeStatusBackend(res);        // 状态字 0 bit1 = 生效后端（丢弃模式没有 DEF，就靠它）
      }
      if (rc < 0 && rc !== P.START_PENDING){
        this._capturing = false;
        this.setStatusText('探针启动失败：' + P.scopeRcText(rc, this.targetRiscv), 'err');
        return;
      }
      if (rc === P.START_PENDING) throw new Error('探针启动超时（仍在排队）');
      if (!this._captureAlive(g)) return;
      this.running = true;
      this.follow = true;
      this.state = '采样中';
      // 周期比"读一次"还短 ⇒ 必丢拍（固件侧的账），这一条要当面说清楚。
      // 用**新鲜**的标定值；过期的标定值会把一个能跑的周期说成跑不动（见 benchFresh）。
      const tooFast = this.rateWarning();
      this.setStatusText(`采样中：${vars.length} 通道 × ${(1e6 / periodUs / 1000).toFixed(2)} kHz，缓冲 ${capacity} 样本` +
        (this.trigger.mode !== TRIG.NONE ? '（触发已布防）' : '') + tooFast + wireNote + capNote,
      (tooFast || wireNote || capNote) ? 'warn' : 'ok');
    } catch (e){
      if (!this._captureAlive(g)) return;
      this.running = false;
      this.setStatusText('启动失败：' + (e?.message || e), 'err');
    }
    this.syncButtons();
    this._needDraw = true;
  }

  _packetTimeoutMs(){
    const samples = Math.max(1, Math.floor(496 / Math.max(1, this._frameBytes || 4)));
    return Math.max(2500, 3 * samples * (this._periodUs || 100) / 1000);
  }

  /** Packet cadence follows both sample period and samples per packet. */
  _startWatchdog(){
    this._stopWatchdog();
    if (this._captureFlags & P.SCOPE_FLAG.DISCARD) return;
    const generation = this._captureGen;
    this._lastPktAt = performance.now();
    /* 1 s 一跳：看门狗只做"粗粒度判死"，被后台节流成 1 s 也无所谓（不是短等待，
     * 所以这里用 setInterval 是对的 —— pace.js 管的是 ≤128 ms 那类等待）。 */
    this._wdTimer = setInterval(() => {
      if (!this._capturing || generation !== this._captureGen) return;
      const age = performance.now() - this._lastPktAt;
      void this.readScopeMetrics().catch(e => { this.metricsError = e.message; });
      if (age > this._packetTimeoutMs()){
        this._stopWatchdog();
        this._onDataPlaneDead(new Error(`超过 ${(age / 1000).toFixed(1)} s 没收到任何数据包`));
      }
    }, 1000);
  }

  _stopWatchdog(){
    if (this._wdTimer){ clearInterval(this._wdTimer); this._wdTimer = null; }
  }

  /**
   * 数据面**不可恢复**地停了（USB 读异常 / 端点反复 STALL / 看门狗超时）——统一收口。
   *
   * 🚨 以前只有"1.5 s 没等到 DEF 包"那一种兜底：采集中途断了流，worker 悄悄退出、
   *    `running` 还是 true、界面照旧显示"采样中"，一个字节都不来，用户只能干等
   *    （2026-10 代码审查）。现在停采集 + 把原因写进状态栏。
   */
  _onDataPlaneDead(e){
    this._stopWatchdog();
    if (!this._capturing && !this.running) return;
    const msg = e?.message || String(e);
    void this.stop('数据流中断：' + msg).then(() => {
      this.setStatusText(`采样中断：${msg} —— 探针掉线了？拔插一次，或改用假探针`, 'err');
    }).catch(error => this.setStatusText(`采样中断：${msg}；${error.message}`, 'err'));
  }

  async stop(reason){
    this.probeManager?.cancel('scope');
    if (this._stopPromise) return await this._stopPromise;
    this._captureGen = (this._captureGen || 0) + 1;
    this._stopPromise = this._stopOnce(reason);
    try { return await this._stopPromise; }
    catch (e) { this.setStatusText(e.message, 'err'); throw e; }
    finally { this._stopPromise = null; this.syncButtons(); }
  }

  async _stopOnce(reason){
    this._stopWatchdog();
    /**
     * A failed USB teardown is recorded by ProbeManager so another feature
     * cannot race the still-uncertain sampler.  After the user reconnects
     * HID/USB there may be no local `running` flag left, but one explicit STOP
     * is still required to confirm the handoff and clear that fault.  Treat
     * the manager failure as an active stop request instead of returning early.
     */
    const needsManagerConfirm = this.probeManager?.failures?.has('scope') === true;
    if (!this.running && !this._starting && !this.transport?.running && !this._stopUnconfirmed && !needsManagerConfirm) return;
    const hadData = this.running || this.transport?.running;
    this.running = false;
    this._capturing = false;                 // DATA 分支据此停止入缓冲（见那里的说明）
    // 先给个即时反馈：后面两个 await（排空 + HID STOP）要几十毫秒，这期间界面上不该还写着"采样中"
    this.setStatusText('正在停止…', '');
    if (this._startPromise) await this._startPromise.catch(() => {});
    if (this._stopUnconfirmed && !this.hid) throw new Error('采样停止尚未确认，请先重连探针，再点停止');
    if (hadData || this._startTouched || this.transport?.running || this._stopUnconfirmed) await this._stopData();
    await this.readScopeMetrics({fresh: true}).catch(e => { this.metricsError = e.message; });
    const st = this.store;
    const spanUs = st?.count > 1 ? st.timeAt(st.count - 1) - st.timeAt(0) : 0;
    const why = reason || this._stopReason;
    this._stopReason = null;
    this.state = why ? `已停止（${why}）` : '已停止';
    this.setStatusText(`已停止${why ? `（${why}）` : ''}：${st?.count || 0} 个样本` +
      (spanUs ? ` / ${fmtTime(spanUs)}` : '') +
      `，跳拍 ${this.probeDropped || 0} / USB 丢样本 ${this.usbDrop || 0} / 读错 ${this.readErrors || 0} / 包缺口 ${this.lost}`,
      why === '缓冲已满' || this.lost || this.probeDropped || this.usbDrop || this.readErrors ? 'warn' : 'ok');
    this.syncButtons();
    this._needDraw = true;
  }

  /**
   * 切换探针的**全局目标类型**（HID 0x31 action 10，与 RTT-over-JTAG 共用同一个开关）。
   * 采样器（0x32）的传输后端 = 这个全局值，所以波形页也得能切 —— 否则用户只能去 RTT 页切。
   * ⚠️ 粘性 + "请求 ≠ 生效"：切完只记下**请求**，显示仍等探针回报（DEF flags bit6 / 状态字 0 bit1）。
   */
  async applyTargetType(){
    if (this.probeManager && !this.usingMock && this.hid && !this.running && !this._starting && !this._stopPromise){
      try {
        return await runProbeOperation(this, 'scope', () => this._applyTargetTypeNow(), {
          reason: 'J-Scope 要切换目标类型', policy: 'reject',
        });
      } catch (e){ this.setStatusText(e.message, 'err'); return false; }
    }
    return await this._applyTargetTypeNow();
  }

  async _applyTargetTypeNow(){
    const sel = $('sc-target');
    const riscv = sel.value === 'riscv';
    if (this.running || this._starting || this._stopPromise || globalThis.__tools?.hid?.last?.running){
      sel.value = this.targetRiscv ? 'riscv' : 'swd';
      store.set('rtt.target', sel.value);
      this.setStatusText('采样或 RTT 转发正在运行：先停止，再切目标类型', 'warn');
      return;
    }
    this.targetRiscv = riscv;
    this._askedAt = (globalThis.performance?.now?.() ?? Date.now());   // 见 uiBackend()：请求与生效的先后关系
    // 🚨 **先刷界面再谈连接**：这一格的意思就是"我要走哪条路"，与探针在不在线无关。
    //    老写法把刷新放在 hidXfer 之后，于是"没连探针时切下拉 → 界面一动不动"（用户实测踩到）。
    this._applyBackendUi();
    if (!this.hid){ this.setStatusText(`已记为「${P.backendName(riscv ? P.BACKEND.RISCV : P.BACKEND.SWD)}」，但探针没连上——连上后再切一次`, 'warn'); return; }
    try {
      const response = await this.hidXfer(P.HID_CMD_RTT, P.targetTypeData(riscv));
      if (!response || response.length < 3 || this.signed(response[2]) < 0)
        throw new Error('探针拒绝切换目标类型（先停止采样和 RTT 转发）');
      this.setStatusText(`已请求切到 ${P.backendName(riscv ? P.BACKEND.RISCV : P.BACKEND.SWD)}（HID 0x31 action 10）——`
        + ' 探针侧目标类型是粘的；下次采样时看「生效后端」是否跟上了', 'ok');
    } catch (e){
      this.setStatusText('切目标类型失败：' + (e?.message || e), 'err');
    }
    this._applyBackendUi();
  }

  /** HID 0x32 状态回包 → 生效后端（状态字 0 的 bit1）。
   *  为什么两条路都要：DEF 只在正常采样时发；**丢弃模式没有 DEF 包**，那时只能看状态字。*/
  _absorbeStatusBackend(res){
    try {
      if (!res || res.length < 3 + 4) return;
      const w0 = new DataView(res.buffer, res.byteOffset + 3, 4).getUint32(0, true);
      if (res.length >= 51) {
        const status = P.parseScopeStatus(res.subarray(3));
        this.supportsMetrics = status.supportsMetrics;
        this.swdMhz = status.swdMhz || 0;
        this._reportedClockSelection = Number($('sc-clock').value) || 0;
      }
      this.setBackend((w0 & 2) ? P.BACKEND.RISCV : P.BACKEND.SWD, '状态字 0');
      this.updatePlan(); // Clock downshift can change advice without changing the backend.
    } catch { /* 回包形状不对就当没看见 */ }
  }

  /** 生效后端（SWD/ARM 或 RISC-V/JTAG）——只认探针回报的值，不拿自己下发的 flags 反推。
   *  来源两处：DEF 的 flags bit6、HID 状态字 0 的 bit1（丢弃模式没有 DEF，就靠后者）。*/
  setBackend(b, source = ''){
    if (!b) return;
    this._reportedAt = (globalThis.performance?.now?.() ?? Date.now());
    if (this.backend === b) return;
    const first = this.backend === null;
    this.backend = b;
    this._reportedAt = (globalThis.performance?.now?.() ?? Date.now());   // 生效值的时间戳（uiBackend 用它判先后）
    this._applyBackendUi();
    if (!first){
      this.setStatusText(`⚠ 后端变成了 ${P.backendName(b)}（${source || '探针回报'}）—— `
        + `目标类型是粘的，探针拉不起来时会自己换另一条路重试`, 'warn');
    }
  }

  /** 后端相关的界面联动：显示、SWD 专属控件置灰、速率/建议周期提示。
   *  `uiBackend()` = 生效后端优先、还没回报就按你选的目标类型（见那个函数的注释）。 */
  _applyBackendUi(){
    const cur = this.uiBackend();
    const riscv = cur === P.BACKEND.RISCV;
    const el = $('sc-backend');
    if (el){
      const asked = this.targetRiscv == null ? null : (this.targetRiscv ? P.BACKEND.RISCV : P.BACKEND.SWD);
      const mismatch = asked && this.backend && asked !== this.backend;
      el.textContent = this.backend
        ? `生效后端：${P.backendName(this.backend)}` + (mismatch ? `　⚠ 你选的是 ${P.backendName(asked)}，探针换了一条路` : '')
        : (asked ? `生效后端：未开始（你选的是 ${P.backendName(asked)}，采样后由探针回报）` : '生效后端：未开始（采样后由探针回报）');
      el.className = 'hint' + (mismatch ? ' err' : '');
    }
    // SWD 专属：SWD 时钟档在 JTAG 下无效（探针忽略），置灰并说明；采样时暂停串口桥那个 checkbox 仍有效
    const clk = $('sc-clock');
    if (clk){
      clk.disabled = riscv || !!(this.running || this._starting || this._stopPromise);
      clk.title = riscv
        ? 'RISC-V/JTAG 下无意义：JTAG 时序由 DMI 汇编旋钮 + delay 决定，探针会忽略这个档位'
        : '与 RTT Viewer 同款档位；固件自带失败自动降档';
    }
    const clkRow = $('sc-clock-row');
    if (clkRow) clkRow.classList.toggle('off', riscv);
    /**
     * 那一格的**名字**要跟着目标类型改（用户 2026-09-30）：同一个档位在 SWD 下是 SWD 时钟，
     * 在 RISC-V/JTAG 下是 **JTAG 时钟（TCK）** —— 名字不改的话，切到 JTAG 后用户会以为
     * "还有个 SWD 时钟在起作用"（探针其实会忽略它）。
     * 跟 `uiBackend()` 走：一选 RISC-V/JTAG 立刻改名，不等采样回报；与 RTT Viewer 页同一套口径。
     */
    const clkLbl = clkRow?.querySelector('span');
    if (clkLbl) clkLbl.textContent = riscv ? 'JTAG 时钟' : 'SWD 时钟';
    this._applyMhzUi();                     // 🚨 立刻改这一格，别等下一次统计刷新（否则会短暂显示旧的 "SWD xx MHz"）
    this.updatePlan();                      // 计划行的速率/建议周期按后端分档
  }

  /** `#sc-mhz` 这一格：RISC-V 下显示后端名（SWD 时钟在 JTAG 下无意义），否则显示 SWD 时钟档。
   *  两处都要调：`_applyBackendUi()`（后端一变就改）与周期性的统计刷新。 */
  _applyMhzUi(){
    const el = $('sc-mhz');
    if (!el) return;
    el.textContent = this.uiBackend() === P.BACKEND.RISCV
      ? 'RISC-V/JTAG'
      : (this.swdMhz ? `SWD ${this.swdMhz} MHz` : 'SWD —');
  }
  benchKeyOf(){
    const pick = this.selected.length ? this.selected : this.mockVars();
    const vars = pick.map(v => v.name).sort().join('+');
    // 后端也算"身份"的一部分：SWD 与 RISC-V 的每样本耗时差好几倍（1.53 vs 2.94 µs），
    // 换了后端还沿用旧标定值，就会给出错误的建议周期
    return { vars: vars || '（空）', hash: P.planHash(pick), elf: this.elf,
      device: this.transport?.device || this.hid?.dev || this.hid,
      actualClock: this.swdMhz || 0,
      flags: (!!$('sc-batch')?.checked ? P.SCOPE_FLAG.FAST_BATCH : 0) | (!!$('sc-cdcoff')?.checked ? P.SCOPE_FLAG.CDC_OFF : 0),
      clock: Number($('sc-clock').value) || 0, backend: this.uiBackend() || P.BACKEND.SWD };
  }

  /**
   * 标定值还算不算数？—— 🚨 必须看！用户现场：先选 f_sin+i_sq1k 标定得 8.204 µs，
   * 然后取消 i_sq1k 只留 f_sin，计划行还在报「已标定 8.204 µs（建议周期 ≥ 11 µs）」，
   * 而单字 f_sin 实测只要 1.53 µs、3 µs 档零丢 —— 一个过期数字把他挡在门外。
   */
  benchFresh(){
    const k = this.benchKeyOf();
    return !!(this.benchUs && this._benchKey &&
              this._benchKey.vars === k.vars && this._benchKey.clock === k.clock &&
              this._benchKey.hash === k.hash && this._benchKey.elf === k.elf && this._benchKey.device === k.device &&
              this._benchKey.flags === k.flags && this._benchKey.actualClock === k.actualClock &&
              (this._benchKey.backend || 'swd') === k.backend);
  }

  benchKeyWhy(){
    const k = this.benchKeyOf(), o = this._benchKey || { vars: '?', clock: 0, backend: 'swd' };
    const parts = [];
    if (o.vars !== k.vars) parts.push(`变量从「${o.vars}」变成「${k.vars}」`);
    if (o.hash !== k.hash || o.elf !== k.elf) parts.push('ELF 或变量地址/类型改变');
    if (o.device !== k.device) parts.push('探针连接改变');
    if (o.flags !== k.flags) parts.push('采样模式改变');
    if (o.actualClock !== k.actualClock) parts.push('生效时钟改变');
    if (o.clock !== k.clock) parts.push(`时钟从 ${o.clock} kHz 变成 ${k.clock} kHz`);
    if ((o.backend || 'swd') !== k.backend) parts.push(`后端从 ${P.backendName(o.backend || 'swd')} 变成 ${P.backendName(k.backend)}`);
    return parts.join('、') || '条件变了';
  }

  /**
   * **界面按哪条路显示**（时钟格名字/置灰、读计划、建议周期都用它）：
   *   · 用户刚改过目标类型、探针**还没回报新的生效值** → 按**你选的**那条路显示；
   *   · 探针回报过（DEF 的 flags bit6 / 状态字 0 的 bit1）且回报发生在这次请求之后 → 按**生效值**。
   *
   * 两条都踩过坑，所以规则必须是这样（用户 2026-09-30 现场："我切换了，没有变化"）：
   *   1. 老写法一律等生效值 —— 刚打开页面切到 RISC-V/JTAG 时屏幕上**什么都不动**（要等采样才知道），
   *      用户只会以为切换没生效；
   *   2. 一律按请求值也不行 —— 命令行/别处把探针切成 RISC-V 后打开本页（请求还是默认的 SWD），
   *      页面会用 SWD 的 1.5 µs 去建议周期，而实际在走 JTAG（3.17 µs），那是会丢样本的错误建议。
   * 「生效后端」那一行仍**只报探针的值**，请求 ≠ 生效时红字提醒（探针拉不起来会自己换一条路）。
   */
  uiBackend(){
    if (this._reportedAt && this._reportedAt >= (this._askedAt || 0)) return this.backend;
    return this.targetRiscv == null ? this.backend : (this.targetRiscv ? P.BACKEND.RISCV : P.BACKEND.SWD);
  }

  /**
   * 单字流水读路径的成本（µs）。
   *   · SWD：随时钟档走。真机两点实测 60 MHz → 1.533 µs、45 MHz → 1.758 µs，
   *     按 `a + b/f` 拟合（a = 0.86 µs 固定开销、b = 40.5 µs·MHz ≈ 一次 AP 读 + 收尾的时钟数）；
   *     没显式选档（"自动"）就用最近一次探针回报的实际 MHz，再退到 60 MHz 档。
   *   · RISC-V/JTAG：单字流水读实测 **3.17 µs**（HPM6800EVK，2026-09-30 P1-1 修完的复测值），
   *     与 SWD 时钟档无关（JTAG 时序由 DMI 汇编旋钮定），所以直接用常数 —— 拿 SWD 的 1.5 µs
   *     去建议周期会让用户看到大面积丢拍（handoff 文档第 2 条明确提过）。
   */
  fastWordUs(){
    if (this.uiBackend() === P.BACKEND.RISCV) return P.BACKEND_COST.riscv.single;
    const mhz = this.planClockMhz();
    return mhz > 0 ? +(0.858 + 40.5 / mhz).toFixed(3) : 1.55;
  }

  planClockMhz(){
    const selected = Number($('sc-clock').value) || 0;
    if (this.swdMhz && selected === this._reportedClockSelection) return this.swdMhz;
    return selected / 1000 || this.swdMhz || P.COST.refMhz;
  }
  planEstimateUs(plan){ return plan ? (this.uiBackend() === P.BACKEND.RISCV ? P.riscvPlanUs(plan) : plan.bestUs) : 0; }

  /** SWD: ceil(M0 × 1.15 + 1 µs); JTAG: ceil(M0 × 1.5), minimum 3 µs.
   * M0 measures target reads, not packet/USB/scheduler cost. This is a starting
   * point; verify skips, USB drops and read errors in the actual capture. */
  recPeriodUsFor(us){ return P.recommendedPeriodUs(us, this.uiBackend()); }

  /** 自动收尾：谁来喊停（时长到 / 缓冲满）都走这里，保证"说停了就真停"。
   *  🚨 老代码只在状态文字里写"缓冲已满：采样自动停止"，**其实根本没停** ——
   *     用户实测 3 s 的采集跑了 20 多秒，多出来的帧全记成 overrun（界面显示"缺口 1924246"）。*/
  _autoStop(reason){
    if ((!this.running && !this._capturing) || this._stopReason) return;
    this._stopReason = reason;
    this.stop().catch(() => {});
  }

  /** 探针侧标定：用当前计划空跑，回报每样本的真实耗时（M0）。
   *  🚨 必须**先**把当前 UI 上的周期/变量表/时钟发下去 —— 否则标定测的是**上一次**的配置
   *     （真机实测：单变量那次报 11.088 µs，8 通道那次报 1.522 µs，正好是对方的数）。
   *  顺带读固件回报的 **实际装载了哪个 blob** 与 `clock_delay` —— 没有这个数就分不出
   *  "时钟命令被忽略" 和 "生效了但没差别"（他们的 README 里就是被这个坑咬过）。*/
  async bench(){
    if (this.probeManager && !this.usingMock && this.hid && !this.running && !this._starting && !this._stopPromise){
      try {
        return await runProbeOperation(this, 'scope', () => this._benchNow(), {
          reason: 'J-Scope 要标定采样引擎', policy: 'reject',
        });
      } catch (e){ this.setStatusText(e.message, 'err'); return false; }
    }
    return await this._benchNow();
  }

  async _benchNow(){
    if (this.running || this._starting || this._stopPromise){ this.setStatusText('先停止采样，再做标定', 'warn'); return; }
    if (!this.hid){ this.setStatusText('先连探针', 'warn'); return; }
    try {
      this.benchUs = null; this._benchKey = null; this.recPeriodUs = null;
      const vars = (this.selected.length ? this.selected : (this.usingMock ? this.mockVars() : []));
      if (!vars.length){ this.setStatusText('先选变量再标定（标定用的是当前计划）', 'warn'); return; }
      const inputKey = this.benchKeyOf();
      const clockKhz = Number($('sc-clock').value) || 0;
      const riscv = this.uiBackend() === P.BACKEND.RISCV;      // 选中的是 JTAG 就别发 SWD 时钟档（探针会忽略）
      const flags = (clockKhz >= 60000 ? P.SCOPE_FLAG.ALLOW_60M : 0)
        | ($('sc-cdcoff')?.checked ? P.SCOPE_FLAG.CDC_OFF : 0)
        | ($('sc-batch')?.checked ? P.SCOPE_FLAG.FAST_BATCH : 0)
        | (this.targetRiscv ? P.SCOPE_FLAG.RISCV : 0);
      // JTAG 下 action 3（SWD 时钟）无效，别发
      if (clockKhz > 0 && !riscv) await this.hidXfer(P.HID_CMD, P.clockData(clockKhz * 1000));
      const configured = await this.configureScope({ periodUs: this.periodUs(), flags, vars });
      if (!configured || configured.length < 3 || this.signed(configured[2]) < 0) throw new Error('标定配置被拒');
      this.plan = this.updatePlan();
      await this.hidXfer(P.HID_CMD, P.benchData({ iters: 2000 }));
      let res;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        res = await this.hidXfer(P.HID_CMD, Uint8Array.of(P.ACT.BENCH_RESULT));
        if (!res || res.length < 23) throw new Error('标定响应不完整');
        if (new DataView(res.buffer, res.byteOffset, res.byteLength).getInt32(11, true) !== -1) break;
      }
      const dv = new DataView(res.buffer, res.byteOffset, res.byteLength);
      const ticks = dv.getUint32(3, true), iters = dv.getUint32(7, true), err = dv.getInt32(11, true);
      const blob = dv.getUint32(15, true), delay = dv.getUint32(19, true);
      if (err || !ticks || iters !== 2000) throw new Error(`标定无效：err=${err}，完成计数=${iters}`);
      const status = await this.hidXfer(P.HID_CMD, Uint8Array.of(P.ACT.STATUS));
      this._absorbeStatusBackend(status);
      const currentKey = this.benchKeyOf();
      if (['vars', 'hash', 'elf', 'device', 'flags', 'clock'].some(k => currentKey[k] !== inputKey[k]))
        throw new Error('标定期间变量、时钟或连接改变，请重新标定');
      const usPerSample = iters ? (ticks / 24) / iters : 0;
      this.benchUs = usPerSample;
      this._benchKey = this.benchKeyOf();          // 记住测的是哪套变量 + 哪个时钟（选择一变就失效）
      const actualRiscv = this._benchKey.backend === P.BACKEND.RISCV;
      this.recPeriodUs = this.recPeriodUsFor(usPerSample);
      const blobName = { 0x53c: '60M(6 指令/bit)', 0x60c: '45M(8)', 0x6e0: '36M(10)', 0x7c4: '30M(12)',
                         0xa54: '20M(18)', 0x620: 'SLOW', 0xffffffff: '还没装载' }[blob] || `0x${blob.toString(16)}`;
      this.blob = { offset: blob, name: blobName, delay };
      // 计划行里那个"保守模型"和实测差多少，当场说清楚（单字 span 实测 1.53 µs，模型算 6.74）。
      // RISC-V 下没有 blob/clock_delay 这些 SWD 专属字段，别把无意义的数摆给用户看。
      const modelUs = this.plan?.estUs || 0;
      const vsModel = (!actualRiscv && modelUs && Math.abs(modelUs - usPerSample) / usPerSample > 0.25)
        ? `（模型估 ${modelUs.toFixed(2)} µs，${modelUs > usPerSample ? '偏保守' : '偏乐观'} ${(modelUs / usPerSample).toFixed(1)}×）` : '';
      const extra = actualRiscv
        ? `（RISC-V/JTAG 路径；blob / clock_delay 是 SWD 专属，这里没有意义${err ? `，err=${err}` : ''}）`
        : `（blob ${blobName}${err ? `，err=${err}` : ''}）`;
      this.setStatusText(`标定：读一次 ${usPerSample.toFixed(3)} µs（未包含组帧/USB/调度，不代表持续采样上限）${vsModel}` +
        `${extra}，对「${this._benchKey.vars} @${P.backendName(this._benchKey.backend)}」有效；` +
        `建议起始周期 ≥ ${this.recPeriodUs} µs（≈${Math.round(1e3 / this.recPeriodUs)} kHz，需实采确认稳定性）`, 'ok');
      this.updatePlan();
      return true;
    } catch (e){
      this.benchUs = null; this._benchKey = null; this.recPeriodUs = null;
      this.setStatusText('标定失败：' + (e?.message || e), 'err');
      this.updatePlan();
      return false;
    }
  }

  /** 把周期填成标定给出的建议值（没标定过就先标一次） */
  async applyRecPeriod(){
    // 标定值过期（变量/时钟改过）就重新标一次 —— 别拿"上一次那两个变量"的数字往下走
    if (!this.recPeriodUs || !this.benchFresh()) await this.bench();
    if (!this.benchFresh()){ this.setStatusText('标定未成功，建议周期未更改；请检查连接和变量地址后重新标定', 'warn'); return; }
    const us = this.benchUs;
    const rec = this.recPeriodUsFor(us);
    if (!rec){ this.setStatusText('先点「标定真实速率」', 'warn'); return; }
    this.recPeriodUs = rec;
    $('sc-period').value = String(rec);
    this.updatePlan();
    this.setStatusText(`周期已设为 ${rec} µs（≈${Math.round(1e3 / rec)} kHz）—— 依据：` +
      (this.benchFresh() ? `标定值 ${us.toFixed(3)} µs` : `单字快路径实测 ${us.toFixed(2)} µs`) +
      (this.uiBackend() === P.BACKEND.RISCV ? ' × 1.5 余量' : ' × 1.15 + 1 µs 余量') + '；这是起始建议，需实采验证跳拍和 USB 计数', 'ok');
  }

  isReal(){ return !this.usingMock; }
  signed(v){ const x = (v ?? 0) & 0xff; return x > 127 ? x - 256 : x; }
  async hidXfer(cmd, data, timeout){
    if (!this.hid) throw new Error('探针没连上：点左边「连接探针」授权一次（或点「重连」）');
    if (this.usingMock) return await this.hid.xfer(cmd, data);
    return await this.hid.xfer(cmd, data, timeout);
  }

  async configureScope(opts){
    const data = P.configData(opts);
    if (data[0] === P.ACT.CONFIG_TICKS || (data[5] & P.SCOPE_FLAG.FAST_BATCH)){
      const res = await this.hidXfer(P.HID_CMD, Uint8Array.of(P.ACT.STATUS));
      const st = P.parseScopeStatus(res.subarray(3));
      if (data[0] === P.ACT.CONFIG_TICKS && !st.supportsTicks) throw new Error('当前探针固件不支持小数周期，请升级固件，或使用整数 µs 周期');
      if (!st.supportsBatch) data[5] &= ~P.SCOPE_FLAG.FAST_BATCH;
    }
    return await this.hidXfer(P.HID_CMD, data);
  }

  async readScopeMetrics({fresh = false} = {}){
    if (!this.supportsMetrics || !this.hid) return;
    if (this._metricsPending){
      const m = await this._metricsPending;
      return fresh ? await this.readScopeMetrics() : m;
    }
    const generation = this._captureGen;
    const pending = (async () => {
      const res = await this.hidXfer(P.HID_CMD, Uint8Array.of(P.ACT.METRICS));
      if (generation !== this._captureGen) return;
      const m = P.parseScopeMetrics(res.subarray(3));
      this.probeMetrics = m; this.probeDropped = m.skipped; this.usbDrop = m.usb;
      this.probeYield = m.yields; this.readErrors = m.errors;
      this.metricsError = null;
      return m;
    })();
    this._metricsPending = pending;
    try { return await pending; }
    finally { if (this._metricsPending === pending) this._metricsPending = null; }
  }

  /** 数据面回调：字节流 → 包 → 解码 → 缓冲（+触发 +统计）*/
  onChunk(chunk){
    this._lastPktAt = performance.now();       // 看门狗据此判"流断没断"（见 _startWatchdog）
    if (this.captureRaw){
      const copy = chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk);
      this.raw.push(copy); this.rawBytes = (this.rawBytes || 0) + copy.length;
    }
    for (const pkt of this.stream.push(chunk)){
      /**
       * 🚨 **等 DEF 当"起跑线"**：探针的 4 个包缓冲和主机侧在飞的读里，
       *    可能还留着**上一轮**没取走的包（上一轮的帧长/变量表都可能不同）。
       *    真机上就撞到了：上一轮是单变量（4 B 帧），新的一轮是 8 通道（26 B 帧），
       *    残留的 4 B 流被按 26 B 解 → 前 100 多个样本是垃圾，
       *    而且时间戳往回跳 → `TimeUnwrap` 以为绕了 32 位 → 实测速率算成 55 Hz。
       *    每次 start 探针都会**先发一个 DEF**，拿它当新一轮的起跑线最可靠。
       */
      if (this._awaitDef){
        if (pkt.kind !== P.KIND.DEF){
          this.stalePackets = (this.stalePackets || 0) + 1;
          // 兜底：1.5 s 还没等到 DEF 就别死等（万一固件版本不发 DEF），
          // 退化成"按本地变量表解码"，并在状态栏说清楚 —— 而不是一个样本都没有还不解释
          if (this._awaitDefSince && performance.now() - this._awaitDefSince > 1500){
            this._awaitDef = false;
            this.setStatusText(`没等到探针的 DEF 包（已丢 ${this.stalePackets} 个残留包），` +
              '按本地变量表解码 —— 波形若有错位请检查固件版本', 'warn');
          } else {
            continue;
          }
        } else {
          this._awaitDef = false;
        }
      }
      this.packets++;
      const st = this.seqT.note(pkt.seq);
      if (st.why === 'reorder' || st.why === 'dup') {
        this.decodeErr++;
        this._onDataPlaneDead(new Error(`采样包${st.why === 'reorder' ? '倒序' : '重复'}：seq=${pkt.seq}；停止采集，避免时间轴和样本失真`));
        return;
      }
      if (!st.ok && st.why === 'gap') this.lost += st.missing || 1;
      switch (pkt.kind){
        case P.KIND.DEF: {
          const d = P.parseDef(pkt.payload, pkt.version);
          this.defVars = d.vars;
          this.periodActualUs = d.periodUs;
          this.swdMhz = d.swdHz ? Math.round(d.swdHz / 1e6) : this.swdMhz;
          this._reportedClockSelection = Number($('sc-clock').value) || 0;
          // **生效**后端（DEF flags bit6）：你下发的 flags 只是请求，后端拉不起来时探针会换一条路重试，
          // 所以界面一律用生效值显示（见 web-handoff-riscv-scope.md）
          this.setBackend(d.riscv ? P.BACKEND.RISCV : P.BACKEND.SWD, 'def');
          this.updatePlan();
          // 探针回报的 span 数 vs 本地计划：不一致就说明两边的合并规则不一样了（改一边忘了另一边）
          if (d.spans && this.plan && d.spans !== this.plan.spans.length){
            this.planMismatch = `探针算出 ${d.spans} 个 span，本地计划是 ${this.plan.spans.length} 个`;
          } else {
            this.planMismatch = null;
          }
          /**
           * 🚨 **变量个数对不上就别解码**：说明配置没生效（或这一包是上一轮的残留）。
           *    硬解下去就是"通道与数据整体错位"的垃圾波形（实测踩过），
           *    宁可报错停在这儿 —— 数据错了比没数据更坏。
           */
          const want = this.store?.vars.length || 0;
          if (want && d.vars.length !== want){
            this.defMismatch = `探针回报 ${d.vars.length} 个变量，本地缓冲是 ${want} 个 —— 解码已暂停（配置没生效？）`;
            this.setStatusText('⚠ ' + this.defMismatch, 'err');
          } else {
            this.defMismatch = null;
          }
          break;
        }
        case P.KIND.DATA: {
          /**
           * 🚨 收工之后**不再往缓冲里塞**。stop() 是异步的（要等 transport.stop() 排空、还要发 HID STOP），
           *    这期间设备和已排队的分片还在送包 —— 实测"时长到 5.001 s"之后又灌进来 1612 个样本，
           *    还把缓冲挤满（界面显示 100% + 溢出计数），停下来那一刻的数字全不可信。
           *    注意用 `_capturing` 而不是 `running`：起跑阶段（DEF 已到、START 还没 resolve）的新数据要收，
           *    但收工之后一律不收（`_capturing` 在 start 里打开、stop 里关掉）。
           */
          if (!this._capturing) break;
          if (this.defMismatch) break;              // 变量表对不上：不解码（见 DEF 分支的说明）
          const vars = this.defVars || this.store?.vars;
          if (!vars?.length) break;
          const nv = vars.length;
          const t0 = P.packetTimeUs(pkt, this.timeU);
          /**
           * 包内每个样本的时刻：用**上一包实测出来的间隔**折算，而不是配置里的名义周期。
           * 探针的实际节奏会飘（真机实测同一次采集里 10.00 → 10.31 µs/样本），
           * 死套名义值会让包内 20 来个样本最多偏 6 µs —— 量周期时就是白送的误差。
           * 只在"上一包紧邻且没丢"时采用（丢包时那个除法的分母就不对了）。
           */
          const nominal = this.periodActualUs || this._periodUs || 100;   // 优先用探针在 DEF 里回报的**实际**周期
          let per = nominal;
          if (this._lastPktT != null && this._lastPktN && st.ok && st.why !== 'gap'){
            const est = (t0 - this._lastPktT) / this._lastPktN;
            if (est > nominal * 0.5 && est < nominal * 2) per = est;    // 离谱就退回名义值
          }
          this._lastPktT = t0; this._lastPktN = pkt.n;
          const direct = this.trigger.mode === TRIG.NONE && vars.length === 1 &&
            vars[0].size === 4 && vars[0].scalar === 'u32' &&
            this.store.pushU32Packet(pkt.payload, pkt.n, t0, per) !== false;
          if (!direct){
            const nums = P.decodeSamples(vars, pkt.payload, pkt.n, []);
            const fr = new Array(nv); // Reuse the frame; Trigger stores only scalar state.
            const fit = Math.min(pkt.n, Math.floor(nums.length / nv));
            for (let i = 0; i < fit; i++){
              for (let k = 0; k < nv; k++) fr[k] = nums[i * nv + k];
              const idx = this.store.count;
              this.store.pushFrame(fr, t0 + i * per);
              if (this.trigger.mode !== TRIG.NONE && this.trigger.feed(fr, idx)){
                this.renderer.setTrigger({ index: idx, pre: this.trigger.pre, post: this.trigger.post });
              }
            }
          }
          /**
           * 🚨「时长」= **目标侧过了多久**，不是"攒够多少个样本"。
           *    老算法把缓冲按"名义速率 × 时长 × 1.25"开好、满了才停，而探针达不到名义速率时
           *    （用户实测：周期 5 µs 想要 200 kHz，实得 112.9 kHz）就会采出 6.6 s —— 用户原话
           *    "时长3s，怎么我采出来的有6.6s?"。现在按 store 的真实时间轴到点就停。
           */
          if (this.running && this._stopAfterUs > 0 && this.store.count > 1){
            const span = this.store.timeAt(this.store.count - 1) - this.store.timeAt(0);
            if (span >= this._stopAfterUs) this._autoStop(`时长到 ${fmtTime(span)}`);
          }
          if (this.running && this.store.full) this._autoStop('缓冲已满');
          break;
        }
        case P.KIND.STAT: {
          const s = P.parseStat(pkt.payload, pkt.version);
          if (!this.probeMetrics) {
            this.probeDropped = Math.max(0, s.dropped - s.usbErr);
            this.usbDrop = s.usbErr;
            this.readErrors = s.swdErr;
          }
          this.swdMhz = s.swdMhz;
          if (s.periodUs) this.periodActualUs = s.periodUs;
          // STAT 里没有后端位，但 RISC-V 下探针不上报 SWD 时钟（swdMhz=0）—— 只在 DEF 还没到时用它兜底，
          // 避免把"还没收到 DEF"误判成后端变了
          break;
        }
        default: break;
      }
    }
    this._needDraw = true;
  }

  clear(){
    this.store?.reset();
    this.stream = new P.PacketStream();
    this.seqT = new P.SeqTracker();
    this.packets = 0; this.lost = 0; this.decodeErr = 0; this.raw = []; this.rawBytes = 0;
    this.renderer.setTrigger(null);
    // 测量游标按**样本索引**记位置，换了数据集（清空/重采/回放）就必须丢掉，否则指的已经不是那一刻
    this.renderer.clearMarks();
    this.renderer.cursor = null;
    this._lastPktT = null; this._lastPktN = 0;
    this.trigger.reset();
    this.renderer.fitAll();
    this.follow = true;
    this.setStatusText('已清空', '');
    this._needDraw = true;
  }

  // ================================================================= 触发
  trigCfg(){
    return {
      channel: Number($('sc-trig-ch').value) || 0,
      mode: Number($('sc-trig-mode').value) || 0,
      level: Number($('sc-trig-level').value) || 0,
      pre: Math.max(0, Number($('sc-trig-pre').value) || 0),
      post: Math.max(0, Number($('sc-trig-post').value) || 0),
      single: $('sc-trig-single').checked,
    };
  }

  applyTrigger(silent){
    const c = this.trigCfg();
    this.trigger.configure(c);
    if (this.store && this.trigger.mode !== TRIG.NONE){
      // 已经采到的数据立刻重新定位一次（离线重触发）
      const hit = findTrigger(this.store, c, 0);
      if (hit >= 0){
        this.trigger.fired = true; this.trigger.hitIndex = hit;
        this.renderer.setTrigger({ index: hit, pre: c.pre, post: c.post });
        $('sc-trig-state').textContent = `命中 @ 样本 ${hit}（离线重定位）`;
      } else {
        this.renderer.setTrigger(null);
        $('sc-trig-state').textContent = '布防中（等条件满足）';
      }
    } else if (this.renderer){
      this.renderer.setTrigger(null);
      $('sc-trig-state').textContent = '未命中';
    }
    if (!silent && this.isReal() && this.hid){
      // 探针侧触发是 v2（主机侧已经够用），这里只把配置发过去，失败不影响
      this.hidXfer(P.HID_CMD, P.triggerData(c)).catch(() => {});
    }
    this._needDraw = true;
  }

  findNextTrigger(){
    if (!this.store?.count){ this.setStatusText('还没有数据', 'warn'); return; }
    const c = this.trigCfg();
    if (c.mode === TRIG.NONE){ this.setStatusText('先把触发模式选上（现在是"不触发"）', 'warn'); return; }
    const from = (this.trigger.hitIndex >= 0 ? this.trigger.hitIndex + 1 : 0);
    const hit = findTrigger(this.store, c, from);
    if (hit < 0){ this.setStatusText('没有下一个命中点（可以放宽阈值再试）', 'warn'); return; }
    this.trigger.fired = true; this.trigger.hitIndex = hit;
    this.renderer.setTrigger({ index: hit, pre: c.pre, post: c.post });
    const w = windowFor(hit, c.pre, c.post, this.store.count);
    this.follow = false;                 // 🚨 必须关掉"跟随最新"，否则下一帧 fitAll() 会把窗口冲掉
    this.renderer.zoomTo(w.start, w.end);
    $('sc-trig-state').textContent = `命中 @ 样本 ${hit}（窗口 ${w.start}..${w.end}${w.short ? '，预触发不足' : ''}）`;
    this._needDraw = true;
  }

  clearTrigger(){
    this.trigger.reset();
    this.renderer.setTrigger(null);
    $('sc-trig-state').textContent = '未命中';
    this._needDraw = true;
  }

  // ================================================================= 导出 / 回放
  exportCsv(){
    const st = this.store;
    if (!st?.count){ this.setStatusText('还没有数据可导出', 'warn'); return; }
    const n = st.count;
    const head = ['t_us', ...st.vars.map(v => v.name)].join(',');
    const parts = [head + '\n'];
    let buf = '';
    for (let i = 0; i < n; i++){
      const row = [st.timeAt(i).toFixed(0)];
      for (const ch of st.channels) row.push(numToCsv(ch.value(i)));
      buf += row.join(',') + '\n';
      if (buf.length > 1 << 20){ parts.push(buf); buf = ''; }      // 1 MB 一块，别一次拼 200 MB 字符串
    }
    if (buf) parts.push(buf);
    const blob = new Blob(parts, { type: 'text/csv' });
    download(`scope-${fileStamp()}.csv`, blob, 'text/csv');
    this.setStatusText(`已导出 CSV：${n} 行 × ${st.vars.length + 1} 列`, 'ok');
  }

  saveRaw(){
    if (!this.raw.length){ this.setStatusText('没有记录原始包（先勾上「记录原始包」再采样）', 'warn'); return; }
    const blob = new Blob(this.raw, { type: 'application/octet-stream' });
    download(`scope-${fileStamp()}.jsp`, blob, 'application/octet-stream');
    this.setStatusText(`已保存原始包：${this.raw.length} 块 / ${fmtBytes(this.rawBytes || 0)}`, 'ok');
  }

  /** 回放 .jsp：把当时的字节流重新喂一遍（不连硬件也能看波形 / 调触发）*/
  async replayFile(file){
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const vars = [...(this.selected.length ? this.selected : this.mockVars())].sort((a, b) => a.addr - b.addr);
      const periodUs = this.periodUs();
      this.store = new SampleStore(vars, Math.ceil(buf.length / 16) + 1024);
      this.renderer.setStore(this.store);
      this.renderer.clearMarks();
      this.renderer.cursor = null;
      this._lastPktT = null; this._lastPktN = 0;
      this.stream = new P.PacketStream();
      this.seqT = new P.SeqTracker();
      this.timeU = new P.TimeUnwrap();
      this.packets = 0; this.lost = 0; this.defVars = null;
      const chunk = 64 * 1024;
      for (let o = 0; o < buf.length; o += chunk) this.onChunk(buf.subarray(o, o + chunk));
      this.renderer.fitAll();
      this.setStatusText(`回放完成：${this.store.count} 个样本 / ${this.packets} 个包`, 'ok');
      this._needDraw = true;
    } catch (e){
      this.setStatusText('回放失败：' + (e?.message || e), 'err');
    }
  }

  // ================================================================= 界面
  setStatusText(text, kind){
    this.state = text;
    const el = $('sc-state');
    if (el) setStatus(el, text, kind);
    if (kind === 'err'){ const e = $('sc-err'); if (e) e.textContent = text; }
  }

  syncButtons(){
    $('sc-start').disabled = !!(this.running || this._starting || this._stopPromise || this._releasing);
    $('sc-stop').disabled = !!this._stopPromise || (!this.running && !this._starting);
    const target = $('sc-target'); if (target) target.disabled = !!(this.running || this._starting || this._stopPromise);
    for (const id of ['sc-period', 'sc-clock', 'sc-batch', 'sc-cdcoff', 'sc-bench', 'sc-recc']){
      const el = $(id); if (el) el.disabled = !!(this.running || this._starting || this._stopPromise) || (id === 'sc-clock' && this.uiBackend() === P.BACKEND.RISCV);
    }
  }

  _loop(){
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      if (document.hidden && !this.running && !this._needDraw) return;   // 后台且闲着：别白烧 CPU
      if (this._needDraw || this.running){
        this._needDraw = false;
        this.drawFrame();
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  drawFrame(){
    // 跟随模式：数据在长，视图自动保持"全览"（用户一缩放/拖动就退出跟随）
    if (this.follow && this.store?.count) this.renderer.fitAll();
    const usedLod = this.renderer.draw();
    this.usedLod = usedLod;
    const st = this.store;
    const rate = st?.rate() || 0;
    $('sc-samples').textContent = String(st?.count || 0);
    $('sc-rate').textContent = rate ? `${(rate / 1000).toFixed(2)} kHz` : '0 Hz';
    $('sc-packets').textContent = String(this.packets);
    // 🚨 三种"丢"要**分开显示**：探针跳拍是探针 CPU 的账，USB 是主机排空的账，缺口是链路层。
    //    overrun（缓冲满之后还在来的帧）单独算一类 —— 它以前被混进"缺口"，
    //    用户看到过"缺口 1924246"这种吓人的数（其实是采集没停、白收了 17 s）。
    const lostProbe = this.probeDropped || 0;
    const lostUsb = this.usbDrop || 0;
    $('sc-lost').textContent = String(lostProbe);
    $('sc-lostusb').textContent = String(lostUsb);
    if ($('sc-readerr')) $('sc-readerr').textContent = String(this.readErrors || 0);
    if ($('sc-yields')) $('sc-yields').textContent = String(this.probeYield || 0);
    $('sc-gap').textContent = String(this.lost);
    if ($('sc-over')) $('sc-over').textContent = String(st?.overrun || 0);
    $('sc-buf').textContent = st ? `${Math.round(st.count / st.capacity * 100)}%` : '0%';
    $('sc-mem').textContent = st ? fmtBytes(st.bytes()) : '0 B';
    // 这一格在 RISC-V 下显示后端（SWD 时钟在 JTAG 下无意义），不再只写 "SWD —"
    this._applyMhzUi();
    const err = $('sc-err');
    if (err){
      err.textContent = this.planMismatch ? `⚠ ${this.planMismatch}` : this.metricsError ? `⚠ 计数读取失败：${this.metricsError}`
        : (this.stream.resyncs ? `重同步 ${this.stream.resyncs} 次 / 垃圾 ${this.stream.junk} B` : '');
    }
    const perCol = this.renderer.span / Math.max(2, this.renderer.plotW);
    const ct = this.renderer.cursorTime();
    const dl = this.renderer.delta();
    $('sc-window').textContent = st?.count
      // 最要紧的 Δt / 频率放**最前面**：这行右边可能被省略号截掉（见 app.css 里 #sc-window 的注释）
      ? (dl ? `Δt ${fmtTime(dl.absUs)}${dl.dtUs < 0 ? '（B 在前）' : ''} · ${fmtHz(dl.hz)}` +
              `（A ${fmtTime(dl.a.relUs)} → B ${fmtTime(dl.b.relUs)} · ${dl.samples} 样本） · `
            : (ct ? `游标 t=${ct.text}（#${ct.index}） · ` : '')) +
        `${fmtTime(st.timeAt(Math.max(0, Math.ceil(this.renderer.view.end) - 1)) - st.timeAt(Math.floor(this.renderer.view.start)))} 窗口 · ` +
        `每列 ${perCol.toFixed(1)} 样本 ${usedLod ? '(LOD)' : '(精确)'}` +
        (perCol < 1.5 ? ' · 连点折线' : ' · 包络带（点「细看」看波形形状）') +
        (this.follow ? ' · 跟随最新' : '')
      : '';
    this.renderLegend();
    // 采集中：把"已采多久 / 想要多久"和缓冲占用一起摆出来 —— 用户就是被"时长 3 s 却采出 6.6 s"坑到的。
    // 4 Hz 刷新够了（别每帧刷，也别把别处的提示语一直盖掉），跟不上周期时才标黄。
    if (this.running && st?.count > 1 && this._stopAfterUs > 0 && performance.now() - (this._lastProg || 0) > 250){
      this._lastProg = performance.now();
      const spanUs = st.timeAt(st.count - 1) - st.timeAt(0);
      const lag = this._periodUs && rate && rate < 1e6 / this._periodUs * 0.8;
      this.setStatusText(`采样中 ${fmtTime(spanUs)} / ${fmtTime(this._stopAfterUs)}` +
        `（${st.count} 样本 · 实得 ${(rate / 1000).toFixed(1)} kHz · 缓冲 ${Math.round(st.count / st.capacity * 100)}%）` +
        (lag ? `　⚠️ 探针跟不上 ${this._periodUs} µs 的周期，时间轴会有空洞（点「标定真实速率」看它到底要多久）` : ''),
        lag ? 'warn' : '');
    }
  }

  renderLegend(){
    const box = $('sc-legend');
    if (!box || !this.store) return;
    // 游标可能来自"窗口尺寸变了"之前的旧位置 —— 夹到有效范围，别显示一个不存在的样本号
    const cur = this.renderer.cursor != null ? Math.min(this.renderer.cursor, this.store.count - 1) : null;
    const rows = legendRows(this.store, cur, this.renderer.hidden);
    // 游标时刻统一显示在画布下的标签和状态行里（每行都挂一遍太吵），这里只留 tooltip 带样本号
    const ct = this.renderer.cursorTime();
    const tip = ct ? ` title="t=${ct.text}（相对采集起点）· 样本 #${ct.index}"` : '';
    box.innerHTML = rows.map(r =>
      `<span class="lrow${r.visible ? '' : ' off'}" data-k="${r.index}"${tip}>` +
      `<i class="dot" style="background:${r.color}"></i>${esc(r.name)}` +
      `<span class="lv">${fmtVal(r.value)}${ct ? ' @' + ct.text : ''}</span></span>`).join('');
    for (const el of box.querySelectorAll('.lrow')){
      el.addEventListener('click', () => {
        const k = Number(el.dataset.k);
        this.renderer.setVisible(k, !this.renderer.isVisible(k));
        this._needDraw = true;
      });
    }
  }

  // ================================================================= 自检摘要
  summary(){
    const st = this.store;
    return {
      state: this.state,
      mode: this.usingMock ? 'mock' : 'real',
      elf: this.elf,
      vars: (this.selected.length ? this.selected : []).map(v => `${v.name}:${v.scalar}@0x${v.addr.toString(16)}`),
      varCount: this.selected.length,
      plan: this.plan ? { spans: this.plan.spans.length, frameBytes: this.plan.frameBytes,
                          estUs: +this.plan.estUs.toFixed(2), estHz: this.plan.estHz } : null,
      samples: st?.count || 0,
      capacity: st?.capacity || 0,
      packets: this.packets,
      lost: this.lost + (this.probeDropped || 0) + (this.usbDrop || 0) + (st?.overrun || 0),
      lostProbe: this.probeDropped || 0,          // 探针跳拍（探针 CPU 的账）
      lostUsb: this.usbDrop || 0,                 // 无缓冲丢样本（主机排空的账）
      readErrors: this.readErrors || 0,
      dapYields: this.probeYield || 0,
      metricsError: this.metricsError || null,
      lostGap: this.lost + (st?.overrun || 0),    // seq 缺口 + 缓冲溢出
      benchUs: this.benchUs || null,
      blob: this.blob || null,
      connectErr: this.connectErr || null,
      rateHz: Math.round(st?.rate() || 0),
      trigger: { mode: this.trigger.mode, hit: this.trigger.hitIndex, hits: this.trigger.hits,
                 marker: !!this.renderer.trigger },
      view: { start: Math.round(this.renderer.view.start), end: Math.round(this.renderer.view.end) },
      lod: !!this.usedLod,
      resyncs: this.stream.resyncs,
      raw: this.raw.length,
      running: this.running,
      mockVars: this.mockVars().map(v => v.name),
    };
  }
}

function numToCsv(v){
  if (Number.isInteger(v)) return String(v);
  if (!Number.isFinite(v)) return '';
  return v.toPrecision(9).replace(/0+$/, '').replace(/\.$/, '');
}
