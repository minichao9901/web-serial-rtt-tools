/**
 * SPI 桥的**共享会话** —— 两个页面（`#spi` 桥页、`#panel` 屏页）用同一个探针连接。
 *
 * 为什么要这一层：拆页之后"连接探针 / 连接数据端点 / 用假探针"只该做一次。
 * 和「串口助手 / 终端」共用同一个串口会话是同一个道理：**一份硬件状态，多个视图**。
 * 这一层**不碰 DOM**（除了给轮询判断 `document.hidden`）：配置与状态通过 `subscribe()` 广播，
 * 各视图自己去渲染自己的表单 —— 否则两边会互相覆盖输入框。
 *
 * 两条通路（页面里只差一个对象）：
 *   真机：HID `0x35` 配置/状态（AkaLinkHid） + WebUSB EP11 双向收发帧（WebUsbSpiTransport）
 *   假机：同一个 `MockSpiProbe` 既当 HID 又当帧执行器（`MockSpiTransport` 注入它）
 *
 * 收发口径：
 *   · 每次发送都走 `sendFrames()`（分配 seq → 打包 → 发 → 等应答），**不散着调 transport**；
 *   · 帧与应答都进日志 ring，两个页面各自渲染（切页不丢记录）；
 *   · 桥没使能时固件不 arm OUT 端点，主机写会被 NAK —— 发送会抛错，页面必须如实显示。
 */
import { AkaLinkHid } from '../hid/probe.js';
import * as P from './protocol.js';
import { WebUsbSpiTransport, MockSpiTransport } from './transport.js';
import { MockSpiProbe } from './mock.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { BUS, runSessionPeriodic, stopSessionPeriodic } from '../core/bus-periodic.js';

const POLL_MS = 1000;          // 状态/计数器轮询间隔（观察量，1 s 够）
const RING_MAX = 400;          // 日志 ring（切页时全量重放用）
/** 未连接时的提示：**把"去哪儿授权"写清楚** —— 用户第一次打开会找不到入口
 *  （按钮叫"连接"，而浏览器弹的那个框才叫"授权"，词对不上就容易卡住）。 */
const NOT_CONNECTED_HINT = '未连接 —— 点「连接探针」连接 HID，再点「连接数据端点…」连接 WebUSB';

export class SpiSession {
  constructor(){
    this.hid = null;                 // 真：AkaLinkHid；假：MockSpiProbe
    this.transport = null;           // 真：WebUsbSpiTransport；假：MockSpiTransport
    this.usingMock = false;
    this.mockProbe = null;
    this.stream = new P.RspStream();
    this.matcher = new P.RspMatcher();
    this.busy = false;
    this.pollTimer = null;
    this.events = [];                // EVT（异步错误事件）
    this.cfg = null;
    this.profile = null;
    this.lastStatus = null;
    this.counters = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0, actualSclkHz: 0 };
    this.stateText = NOT_CONNECTED_HINT;
    this.stateKind = '';
    this.ring = [];
    this.subs = new Set();
  }

  // ==================================================================== 订阅 / 广播

  /** 视图实现 `onSession(type, payload)`；返回退订函数 */
  subscribe(view){
    this.subs.add(view);
    return () => this.subs.delete(view);
  }

  _emit(type, payload){
    for (const v of this.subs){
      try { v.onSession?.(type, payload); } catch (e){ console.warn('[spi] 视图回调出错', e); }
    }
  }

  /** 记一条日志：进 ring + 广播（两个页面各自渲染） */
  log(kind, text, tag = 'bus'){
    const e = { kind, text, tag, t: Date.now() };
    this.ring.push(e);
    if (this.ring.length > RING_MAX) this.ring.shift();
    this._emit('log', e);
  }

  _setState(text, kind = ''){
    this.stateText = text; this.stateKind = kind;
    this._emit('state', this.stateInfo());
  }

  stateInfo(){
    return {
      connected: this.connected, dataReady: this.dataReady, mock: this.usingMock,
      hidLabel: this.hid?.label || '', transportLabel: this.transport?.label || '',
      text: this.stateText, kind: this.stateKind, busy: this.busy,
    };
  }

  get connected(){ return !!(this.hid && (this.usingMock || this.hid.connected)); }
  get dataReady(){ return !!this.transport; }
  /**
   * 桥当前是否使能。
   * ⚠️ 别写 `lastStatus.enabled` —— `parseStatusPayload()` 返回的是**协议原样**的字段
   *    （status 是那个 u32 状态字本身），`enabled` 是状态字的 bit0，得解出来。
   *    踩过：`session.lastStatus?.enabled` 恒为 undefined，于是"桥还没使能"的提醒从没触发过。
   */
  get enabled(){ return this.lastStatus ? P.statusWord(this.lastStatus.status).enabled : false; }

  // ==================================================================== 连接

  /** 默认复用唯一已授权的探针；true 强制选择，false 只使用已授权设备。 */
  async connectHid(interactive = null){
    if (this._hidConnectPromise) return await this._hidConnectPromise;
    if (this._teardownPromise) return false;
    // 已连接时不重复选择 HID；更换设备要先关闭共享会话。
    if (this.connected) return true;
    this._hidConnectPromise = runProbeOperation(this, 'spi', () => this._connectHidNow(interactive), { reason: 'SPI/QSPI 要连接探针', recovery: true });
    try { return await this._hidConnectPromise; }
    catch (e){ this.log('e', e.message); return false; }
    finally { this._hidConnectPromise = null; }
  }

  async _connectHidNow(interactive){
    try {
      if (this.usingMock){ await this._teardownNow(); this.usingMock = false; this.mockProbe = null; }
      this.hid = this.hid || new AkaLinkHid();
      await this.hid.connect(interactive);
      this.log('g', `HID 已连接：${this.hid.label || 'akaLinkPro'}`);
      this.ensurePoll();
      await this.loadCfg({ quiet: true });
      await this.loadProfile({ quiet: true });
      await this.pollStatus();
      this._setState('HID 已连接');
    } catch (e){
      this.log('e', '连接 HID 失败：' + (e?.message || e));
      this._setState('HID 连接失败', 'err');
    }
    this._emit('state', this.stateInfo());
    return this.connected;
  }

  /**
   * 连数据端点。`interactive`：
   *   · `null`（默认，按钮走这条）—— **先试已授权的设备**，没有再弹选择框。已授权过就不该再骚扰用户，
   *     自动化脚本也能免去应答弹框；
   *   · `true` —— 强制弹框（首次授权）；
   *   · `false` —— 只用已授权设备（不弹框，没有就报错）。
   */
  async connectUsb(interactive = null, opts = {}){
    if (this._usbConnectPromise) return await this._usbConnectPromise;
    if (this._teardownPromise) return false;
    if (this.transport) return true;
    this._usbConnectPromise = runProbeOperation(this, 'spi', () => this._connectUsbNow(interactive, opts), { reason: 'SPI/QSPI 要使用数据端点', recovery: true });
    try { return await this._usbConnectPromise; }
    catch (e){ this.log('e', e.message); return false; }
    finally { this._usbConnectPromise = null; }
  }

  async _connectUsbNow(interactive = null, opts = {}){
    try {
      let t;
      const transportOpts = { inFlight: opts.inFlight ?? 4, drainReads: count => this._drainReads(count) };
      const devs = await WebUsbSpiTransport.authorized();
      const useAuthorized = interactive === false || (interactive == null && devs.length > 0);
      if (useAuthorized){
        if (!devs.length) throw new Error('没有已授权的探针（先点一次「连接数据端点」授权一次）');
        t = new WebUsbSpiTransport(devs[0], transportOpts);
        await t.open();
      } else {
        t = await WebUsbSpiTransport.request(transportOpts);
      }
      this.transport = t;
      this.stream.reset();
      await t.start(bytes => this._onBytes(bytes), e => this._onDataPlaneDead(e));
      this.log('g', `数据端点已连接：${t.label}`);
      this._setState('数据端点已连接');
      return true;
    } catch (e){
      this.log('e', '连接数据端点失败：' + (e?.message || e));
      this._setState('数据端点连接失败', 'err');
      return false;
    } finally {
      this._emit('state', this.stateInfo());
    }
  }

  /** 假探针：HID 与 bulk **必须**指向同一个实例（两个实例会造出"配置发给 A、数据从 B 出来"的假象）*/
  async setMock(on, opts = {}){
    await this.teardown();
    if (on){
      const probe = new MockSpiProbe(opts.device ? { device: opts.device } : {});
      this.mockProbe = probe;
      this.hid = probe;
      this.transport = new MockSpiTransport({ probe });
      this.usingMock = true;
      this.stream.reset();
      await this.transport.start(bytes => this._onBytes(bytes));
      this.log('g', `已切到假探针（无需硬件）：HID 与数据面共用同一个实例 · 末级器件 ${probe.deviceInfo().name}`);
      this._setState('假探针');
      await this.loadCfg({ quiet: true });
      await this.loadProfile({ quiet: true });
      await this.pollStatus();
      this.ensurePoll();               // teardown 清了定时器，这里要重新武装（真机路径在 connectHid 里做）
    } else {
      this.usingMock = false;
      this.mockProbe = null;
      this.log('i', '已关掉假探针');
      this._setState(NOT_CONNECTED_HINT);
    }
    this._emit('state', this.stateInfo());
    return this.usingMock;
  }

  /**
   * 换假探针的**末级器件**：`'flash'`（默认，回环 + 一颗 W25Q128）/ `'regs'`（寄存器器件）/
   * `'adc'`（命令型 ADC）。SPI 没有器件地址，所以这三者是"换一个末级"，不是"多挂几个"。
   * 真机上这个动作没意义（会如实拒绝）。
   */
  setMockDevice(kind){
    if (!this.usingMock || !this.mockProbe){
      this.log('w', '「假器件」只在假探针模式下有意义 —— 真机上末级器件就是你接的那颗');
      return null;
    }
    const k = this.mockProbe.setDeviceKind(kind);
    const info = this.mockProbe.deviceInfo();
    this.log('i', `假器件 → ${info.name}`);
    this._emit('state', this.stateInfo());
    return k;
  }

  async teardown(){
    this.probeManager?.cancel('spi');
    if (this._teardownPromise) return await this._teardownPromise;
    this._teardownPromise = (async () => {
      await Promise.allSettled([this._hidConnectPromise, this._usbConnectPromise].filter(Boolean));
      await this._teardownNow();
      this.probeManager?.forget('spi');
    })();
    try { return await this._teardownPromise; }
    finally { this._teardownPromise = null; }
  }

  /** 页面“关闭探针”：结束共享会话；传输中先由对应操作的停止按钮收尾。 */
  async disconnect(){
    if (this.busy) return false;
    this.setBusy(true);
    try {
      await this.teardown();
      this.log('g', '探针连接已关闭');
      return true;
    } catch (e){
      const message = '关闭探针失败：' + (e?.message || e);
      this.log('e', message);
      this._setState(message, 'err');
      return false;
    } finally { this.setBusy(false); }
  }

  async _teardownNow(){
    await this.stopPeriodic();
    if (this.pollTimer){ clearInterval(this.pollTimer); this.pollTimer = null; }   // 会话没了就别空转（重连时 ensurePoll 会再拉起）
    try { this.matcher.abortAll('会话结束'); } catch { /* 忽略 */ }
    try {
      // Finish native writes/reads before disabling the bridge (disabled OUT is NAKed).
      await this.transport?.stop();
      if (!this.usingMock && (this.hid || this.transport)) await this._disableBridge();
    } catch (e){ this.probeManager?.fail('spi', e); throw e; }
    if (this.transport){
      try { await this.transport.close(); this.transport = null; }
      catch (e){ this.probeManager?.fail('spi', e); throw e; }
    }
    if (this.hid && !this.usingMock){
      try { await this.hid.close(); }
      catch (e){ this.probeManager?.fail('spi', e); throw e; }
    }
    this.hid = null;
    this.usingMock = false;
    this.mockProbe = null;
    this.stream?.reset();
    this.lastStatus = null;
    this._setState(NOT_CONNECTED_HINT);
  }

  async _drainReads(count){
    return await this._withHid(async hid => {
      const res = await hid.xfer(P.HID_CMD, P.hidData.drain(count));
      if (!P.supportsDrain(res)) throw new Error('固件不支持 EP11 DRAIN，请更新探针固件');
    });
  }

  async _disableBridge(){
    await this.stopPeriodic();
    return await this._withHid(async hid => {
      const res = await hid.xfer(P.HID_CMD, P.hidData.enable(false));
      if (res?.length < 7 || res[0] < 8 || res[1] !== P.HID_CMD || res[2] !== P.ACT.ENABLE ||
          P.statusWord(P.parseWordPayload(res)).enabled)
        throw new Error('SPI 失能未确认，保留引脚占用');
    });
  }

  async _withHid(fn){
    const temporary = !this.connected;
    const hid = temporary ? new AkaLinkHid() : this.hid;
    try {
      if (temporary) await hid.reconnect();
      return await fn(hid);
    } finally { if (temporary) await hid.close(); }
  }

  /** 长任务（回环自检 / 刷图）期间置忙：轮询暂停、两页的按钮一起禁用 */
  setBusy(on){
    this.busy = !!on;
    this._emit('busy', this.busy);
  }
  runPeriodic(groups, opts){ return runSessionPeriodic(this, BUS.SPI, groups, opts); }
  stopPeriodic(){ return stopSessionPeriodic(this); }

  // ==================================================================== HID 控制面

  /** 统一入口：发一条 0x35，等响应。`opts.tag` 决定这条日志算谁的（'bus' / 'panel'） */
  async hidAction(action, data, label, opts = {}){
    if (this._teardownPromise) throw new Error('SPI 会话正在断开');
    if (!this.connected) throw new Error('探针没连上（HID）');
    const t0 = performance.now();
    const res = await this.hid.xfer(P.HID_CMD, data);
    if (opts.quiet !== true) this.log('d', `HID ${label} · ${(performance.now() - t0).toFixed(1)} ms`, opts.tag || 'bus');
    return res;
  }

  async loadCfg(opts = {}){
    const res = await this.hidAction(P.ACT.GET_CFG, P.hidData.getCfg(), 'GET_CFG', opts);
    this.cfg = P.parseCfgPayload(res);
    this._emit('cfg', this.cfg);
    if (!opts.quiet) this.log('g', `配置：SCLK=${P.sclkLabel(this.cfg.sclkHz)} mode=${this.cfg.mode} CS策略=${this.cfg.csPolicy} 阈值=${this.cfg.txDmaThreshold}`, opts.tag || 'bus');
    return this.cfg;
  }

  /**
   * 写配置（引脚 + 配置块），然后**回读对账**。
   *
   * 🚨 不能用响应里的状态字 `err` 判断"本次是否成功"：它是**最近一次错误码**，
   *    固件成功时不清它（spi_bridge.c 只在出错时写 s_last_err）。回读还能顺带发现
   *    固件把字段夹取走了（例如开 quad 后退掉 PA30/PA31 的辅助脚）。
   */
  async applyConfig(want, tag = 'bus'){
    const pads = [[P.LINE.DC, want.padDc], [P.LINE.RST, want.padRst],
                  [P.LINE.CS_AUX, want.padCsAux], [P.LINE.BL, want.padBl]];
    for (const [line, pad] of pads){
      await this.hidAction(P.ACT.PIN_CFG, P.hidData.pinCfg(line, pad), `PIN_CFG ${P.LINE_NAME[line]}=${P.PAD_NAME[pad]}`, { quiet: true, tag });
    }
    await this.hidAction(P.ACT.SET_CFG, P.hidData.setCfg(P.encodeCfg(want)), 'SET_CFG', { tag });
    const back = await this.loadCfg({ quiet: true, tag });
    const diffs = [];
    for (const k of ['sclkHz', 'mode', 'bits', 'csPolicy', 'txDmaThreshold', 'padDc', 'padRst', 'padCsAux', 'padBl', 'padActiveLow', 'flags']){
      if ((back[k] ?? 0) !== (want[k] ?? 0)) diffs.push(`${k}: ${want[k]} → ${back[k]}`);
    }
    if (diffs.length) this.log('w', '写入后被固件改掉了：' + diffs.join('、') + '（越界、或开 quad 与辅助脚冲突会被拒/夹取）', tag);
    else this.log('g', '配置已生效（回读对账一致）', tag);
    await this.pollStatus();
    return { cfg: back, diffs };
  }

  async loadProfile(opts = {}){
    const res = await this.hidAction(P.ACT.GET_PROFILE, P.hidData.getProfile(), 'GET_PROFILE', opts);
    this.profile = P.parseProfilePayload(res);
    this._emit('profile', this.profile);
    if (!opts.quiet) this.log('g', `面板档：${P.PROFILE_NAME[this.profile.profile]}`, opts.tag || 'bus');
    return this.profile;
  }

  async applyProfile(prof, tag = 'bus'){
    await this.hidAction(P.ACT.SET_PROFILE, P.hidData.setProfile(P.encodeProfile(prof)), 'SET_PROFILE', { tag });
    const back = await this.loadProfile({ quiet: true, tag });
    const diffs = [];
    for (const k of ['profile', 'defLines', 'dcActiveHigh', 'csHoldInStep', 'qspiWrOpcode', 'qspiColorOpcode', 'qspiAddrBytes']){
      const a = typeof prof[k] === 'boolean' ? (prof[k] ? 1 : 0) : (prof[k] ?? 0);
      const b = typeof back[k] === 'boolean' ? (back[k] ? 1 : 0) : (back[k] ?? 0);
      if (a !== b) diffs.push(`${k}: ${a} → ${b}`);
    }
    if (diffs.length) this.log('w', '档位写入后被固件改了：' + diffs.join('、'), tag);
    else this.log('g', `档位已生效：${P.PROFILE_NAME[back.profile]}（线数 ${back.defLines}）`, tag);
    return { profile: back, diffs };
  }

  async setEnabled(on, tag = 'bus'){
    const res = await this.hidAction(P.ACT.ENABLE, P.hidData.enable(on), `ENABLE ${on ? 1 : 0}`, { tag });
    const st = P.statusWord(P.parseWordPayload(res));
    if (on && !st.enabled){ this.log('e', 'ENABLE 没生效（状态字里 enabled 仍是 0）', tag); await this.pollStatus(); return false; }
    this.log('g', on ? '桥已使能（引脚已复用）' : '桥已失能（引脚恢复默认）', tag);
    await this.pollStatus();
    return true;
  }

  async reset(opts = {}){
    await this.hidAction(P.ACT.RESET, P.hidData.reset(), 'RESET（清环+清计数器）', opts);
  }

  async abort(opts = {}){
    await this.hidAction(P.ACT.ABORT, P.hidData.abort(), 'ABORT（丢未处理帧与 IN 队列）', opts);
  }

  async pollStatus(force = false){
    if (!this.connected) return null;
    if (this.busy && !force) return null;
    try {
      const res = await this.hidAction(P.ACT.STATUS, P.hidData.status(), 'STATUS', { quiet: true });
      const st = P.parseStatusPayload(res);
      this.lastStatus = st;
      this.counters = st;
      this._emit('counters', { counters: st, lastStatus: st });
      return st;
    } catch (e){
      if (force) this.log('e', 'STATUS 失败：' + (e?.message || e));
      return null;
    }
  }

  ensurePoll(){
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;   // 不可见就不轮询（回来时 onShow 补一次）
      this.pollStatus();
    }, POLL_MS);
  }

  // ==================================================================== 数据面

  /**
   * 数据面**不可恢复**地停了（USB 读异常 / 端点反复 STALL）。
   *
   * 🚨 以前这种情况下 worker 是悄悄 break 的：几条都退出后数据面停死，而 `running` 还是 true、
   *    界面照旧显示"数据端点已连接"，一个应答都收不到 —— 上层只能看到一串"应答超时"
   *    （2026-10 代码审查）。现在把原因直接写进日志与状态。
   */
  _onDataPlaneDead(e){
    const msg = e?.message || String(e);
    this.log('e', `数据面中断：${msg} —— 点「连接数据端点」重连，或拔插一次探针`);
    this._setState('数据面中断', 'err');
  }

  _onBytes(bytes){
    const pkts = this.stream.push(bytes);
    /* 流错位时切包器把整个缓冲丢了 —— 同一块里**排在后面的正常应答也一起没了**，
     * 表现是"接下来一串请求各自等 1 s 超时"。这条日志专门把因果对上
     * （2026-10 代码审查：以前只报超时，根因看不出来）。 */
    const dz = this.stream.takeDesync();
    if (dz){
      this.log('e', `数据流错位：${dz.why} —— 丢弃了 ${dz.dropped} B 缓冲。` +
        `同一批里后面的应答也会跟着丢，所以接下来可能出现一串"应答超时"：那是结果不是原因（bulk 本身可靠，出现即说明两边对包的理解错位了）`);
    }
    for (const pkt of pkts){
      const r = P.parseRsp(pkt);
      if (!r){ this.log('e', '收到一个解析不了的应答包（magic/长度不对）'); continue; }
      if (r.type === P.R.EVT){
        this.log('w', `EVT 异步事件：${r.status}/${P.ST_TEXT[r.status] || '?'} · seq=${r.seq}`);
        this.events.push(r);
        if (this.events.length > 64) this.events.shift();   // 与 RspMatcher.events 同款上限：长会话别让它一直涨
        continue;
      }
      if (!this.matcher.feed(pkt)) this.log('w', `收到无人认领的应答 seq=${r.seq}（超时后迟到？）`);
    }
  }

  /**
   * 发一批帧：分配 seq → 打包（一帧不跨包）→ **按 `batchBytes` 攒批** submit → 带回所有带 RSP 帧的应答。
   * @param {Array<{type:number,payload:Uint8Array,flags?:number,label?:string}>} items
   * @param {{quiet?:boolean,tag?:string,timeoutMs?:number,onProgress?:Function,shouldStop?:Function,batchBytes?:number}} opts
   *        `batchBytes` = 一次 transferOut 带多少字节（默认 PKT = 每包一次调用，与老行为等价；
   *        刷屏/动画那条路传 16 KB 量级，见 `protocol.batchPacks`：设备看到的包序列不变，主机少喊几次）。
   * @returns {Promise<{sent:number, failed:number, rsps:Array<{status:number,data:Uint8Array}|null>, packs:number, batches?:number}>}
   */
  async sendFrames(items, opts = {}){
    if (!this.dataReady) throw new Error('数据端点没连上（先「连接数据端点」或勾「用假探针」）');
    const timeoutMs = opts.timeoutMs ?? 1500;
    const tag = opts.tag || 'bus';
    const frames = [], waits = [], seqs = [];
    for (const it of items){
      const needSeq = !!(it.flags & P.F.RSP);
      const seq = needSeq ? this.matcher.alloc() : 0;
      seqs.push(seq);
      frames.push(P.frame(it.type, it.payload, { flags: it.flags | 0, seq }));
      /**
       * 🚨 每个在飞请求**当场**挂上 onRejected：发送中途失败时下面的循环可能到不了它，
       *    没挂的话它会在超时后变成 **unhandled rejection**（页面自检里表现为"整场跑完有未捕获错误"）。
       */
      waits.push(needSeq
        ? this.matcher.wait(seq, timeoutMs, it.label || '').then(r => r, e => ({ error: e }))
        : null);
      if (!opts.quiet) this.log('d', '→ ' + P.describeFrame(it.type, it.payload, it.flags | 0, seq), tag);
    }
    const packs = P.packFrames(frames);
    let sent = 0, batches = null;
    try {
      const r = await this.transport.sendPacks(packs, {
        onProgress: opts.onProgress, shouldStop: opts.shouldStop, stopOnError: true,
        batchBytes: opts.batchBytes,
      });
      sent = r.sent;
      batches = r.batches ?? null;
      /**
       * 🚨 被 `shouldStop` 中止时，**后面那些没发出去的帧不会有应答** —— 不在这里取消的话，
       *    下面 `await waits[i]` 会一路挂到 `timeoutMs`（实测 8 s）。表现出来就是
       *    "点了「停止」/「中止」好几秒没反应"（动画里尤其明显：一帧 292 个帧、RSP 在末片）。
       *    cancel 之后那些 wait 会立刻以 `{error}` 兑现，口径与"半路失败"完全一致。
       */
      if (opts.shouldStop?.()){
        for (const s of seqs) if (s) this.matcher.cancel(s, '已中止（后续帧没发出去）');
      }
    } catch (e){
      // 发送半路失败：把本批还没兑现的在飞请求取消掉（别让它们挂到超时）
      for (const s of seqs) if (s) this.matcher.cancel(s, e?.message || String(e));
      this.log('e', '发送失败：' + (e?.message || e), tag);
    }
    const rsps = [];
    for (let i = 0; i < waits.length; i++){
      if (!waits[i]){ rsps.push(null); continue; }
      const res = await waits[i];
      if (res.error){ rsps.push(null); if (!opts.quiet) this.log('e', `← #${seqs[i]} ${res.error.message}`, tag); }
      else {
        rsps.push(res);
        if (!opts.quiet) this.log(res.status === P.ST.OK ? 'g' : 'e',
          `← #${seqs[i]} ${res.status}/${P.ST_TEXT[res.status] || '?'}` +
          (res.data?.length ? ` · ${res.data.length} B: ${hex(res.data, 12)}` : ''), tag);
      }
    }
    return { sent, failed: packs.length - sent, rsps, packs: packs.length, batches };
  }

  /** 自检摘要（给 main.js 的 summary()） */
  summary(){
    return {
      connected: this.connected, dataReady: this.dataReady, mock: this.usingMock,
      iface: this.transport?.iface ?? null,
      packets: this.transport?.writes ?? 0,          // = 主机侧 transferOut 调用次数（攒批后按"批"计）
      writeBytes: this.transport?.writeBytes ?? 0,
      framesOk: this.counters.framesOk, framesErr: this.counters.framesErr,
      bytesTx: this.counters.bytesTx, bytesRx: this.counters.bytesRx,
      actualSclkHz: this.counters.actualSclkHz,
      cfg: this.cfg ? { sclkHz: this.cfg.sclkHz, mode: this.cfg.mode, csPolicy: this.cfg.csPolicy,
                        padDc: this.cfg.padDc, padRst: this.cfg.padRst, padBl: this.cfg.padBl } : null,
      profile: this.profile ? { profile: this.profile.profile, defLines: this.profile.defLines } : null,
      busy: this.busy,
    };
  }
}

// ---------------------------------------------------------------- 小工具（视图也 import）

const hex = (b, n = 16) => [...b.subarray(0, n)].map(x => x.toString(16).padStart(2, '0')).join(' ');
export const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
export const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** "0x2C" / "2c" → 44；空/非法 → fallback */
export function parseHexByte(s, fallback = 0){
  const t = String(s ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(t)) return fallback;
  return parseInt(t, 16) & 0xff;
}

/**
 * "12 34 ab" / "1234ab" / "0x12,0x34" / 换行分隔 → Uint8Array。
 *
 * **非法字符直接报错，不静默吞。** 注释一直这么写，代码以前却是把它们删掉（2026-10 代码审查）：
 *   · 全非法的输入（`zzz`）会被清成空串 → flash 卡的「写数据」把空串当成"用户没填"，
 *     于是拿 256 B 递增图案**写进 flash**；
 *   · 落在成对位置上的非法字符还会被静默拼成别的字节（`12 3g4` → `12 34`），
 *     既不报错也不等于用户输入。
 *
 * 分词规则与 `core/hex.js` 的 `parseHex` 一致：**分隔符（空格/逗号/0x…）= 字节边界**，
 * 只有完全没分隔符的连续串才两位一组拆。
 */
export function parseHexBytes(s){
  const src = String(s ?? '');
  const t = src.replace(/0[xX]/g, ' ').replace(/[\s,;:_\-|]+/g, ' ').trim();
  if (!t) return new Uint8Array(0);                 // 真的什么都没填 → 空（怎么处理由调用方定）
  const out = [];
  for (const tok of t.split(' ')){
    if (!/^[0-9a-fA-F]+$/.test(tok)){
      const bad = [...tok].find(c => !/[0-9a-fA-F]/.test(c)) || tok;
      const shown = src.trim();
      throw new Error(`十六进制里有非法字符「${bad}」—— 只认 0-9 / a-f，分隔符用空格或逗号：` +
        `${shown.slice(0, 32)}${shown.length > 32 ? '…' : ''}`);
    }
    if (tok.length <= 2){ out.push(parseInt(tok, 16)); continue; }   // 有分隔符 → 这一段就是一个字节
    if (tok.length % 2) throw new Error(`「${tok}」位数是奇数 —— 每个字节要两位（连写时要成对）`);
    for (let i = 0; i < tok.length; i += 2) out.push(parseInt(tok.substr(i, 2), 16));
  }
  return Uint8Array.from(out);
}
