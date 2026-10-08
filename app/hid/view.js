/**
 * 「RTT → CDC 转发」面板（挂在**终端**页）。
 *
 * 干什么：akaLinkPro 探针自己就能轮询目标的 RTT 控制块、把数据塞进它的 CDC 虚拟串口，
 * 于是主机只要读一个 COM 口就能拿到 RTT —— 不用每轮三次 USB 往返（实测 2.5~3 MB/s）。
 * 开启/停止/地址这些参数走探针的**自定义 HID**（0x31 命令），协议在 app/hid/probe.js。
 *
 * 流程：连接探针(HID) → 填 RTT 地址（手填，或载入 ELF 自动解析 _SEGGER_RTT）→ 启动转发
 *      → 回到「串口助手」打开这颗探针的 CDC 口（同一个 VCOM）就能看到 RTT 数据。
 */
import { prepareProbeHandoff } from '../core/probe-users.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { $, setStatus, debounce } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { bytes as fBytes } from '../core/format.js';
import { findSymbol } from '../rtt/elf.js';
import { AkaLinkHid, startRcText, START_PENDING } from './probe.js';
import { MockAkaLinkHid } from './mock.js';
import { waitMs } from '../core/pace.js';

const CLOCK_OPTIONS = [
  { v: '', label: '不改（用探针当前档位）' },
  { v: '20000000', label: '20 MHz' },
  { v: '30000000', label: '30 MHz' },
  { v: '36000000', label: '36 MHz' },
  { v: '45000000', label: '45 MHz（出厂默认）' },
  { v: '60000000', label: '60 MHz（更快，偶发抖动）' },
];

const hex = n => '0x' + (n >>> 0).toString(16);
const kb = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 102400 ? 1 : 0) + ' KB';

export class RttCdcView {
  constructor(){
    this.dev = new AkaLinkHid();
    this.mock = null;
    this.info = null;
    this.last = null;         // 最近一次 status
    this._elfInput = null;
    this._bound = false;
  }

  init(){
    if (this._bound) return;
    this._bound = true;

    this._elfInput = document.createElement('input');
    this._elfInput.type = 'file';
    this._elfInput.accept = '.elf,.axf,.out,.bin';
    this._elfInput.hidden = true;
    document.body.appendChild(this._elfInput);

    $('h-clock').innerHTML = CLOCK_OPTIONS.map(o => `<option value="${o.v}">${o.label}</option>`).join('');
    store.bind($('h-addr'), 'hid.addr');
    store.bind($('h-size'), 'hid.size');
    store.bind($('h-chan'), 'hid.chan');
    store.bind($('h-clock'), 'hid.clock');
    /**
     * 目标类型是**探针侧的全局粘性开关**，三个入口（本页 `#h-target` / RTT Viewer `#r-target` /
     * J-Scope `#sc-target`）必须是**同一个键**。历史遗留：本页原来用 `hid.target`，另两页用
     * `rtt.target` —— 于是两页各存各的、各自往探针写，谁最后写谁生效，另一页仍显示旧值。
     * 2026-10 真机现场：本页显示 RISC-V/JTAG，探针里却是 SWD → 启动转发回 -2「SWD 初始化失败」。
     * 老键的值一次性搬过来，别丢用户已经选过的档。
     */
    if (store.get('rtt.target') === undefined && store.get('hid.target') !== undefined){
      store.set('rtt.target', store.get('hid.target'));
    }
    store.set('hid.target', undefined);          // 老键退休：本页不再写它，免得两页又分家
    store.bind($('h-target'), 'rtt.target');
    this._targetRiscv = this.isRiscv;
    // 目标类型是**全局**的（粘性）：RISC-V/JTAG 下 SWD 时钟档无意义（探针忽略 action 7 的 Hz，
    // 只有 <256 的值会被当成 DMI 的 idle 周期数），所以直接置灰并说明
    this._applyTargetUi();
    $('h-target').addEventListener('change', () => this.applyTargetType());

    $('h-connect').addEventListener('click', () => this.connect());
    $('h-reconnect').addEventListener('click', () => this.reconnect());
    $('h-elf').addEventListener('click', () => this._elfInput.click());
    this._elfInput.addEventListener('change', () => this.loadElf());
    $('h-start').addEventListener('click', () => this.start());
    $('h-auto').addEventListener('click', () => this.autostart());
    $('h-stop').addEventListener('click', () => this.stop().catch(e => toast(e.message, 'err')));
    $('h-refresh').addEventListener('click', () => this.refresh());
    $('h-clock').addEventListener('change', debounce(() => this.applyClock(), 60));

    // ?hid=mock：没插硬件也能把这张面板走一遍（自测/演示）
    if (new URLSearchParams(location.search).get('hid') === 'mock') this.useMock();

    this.dev.onDisconnect = () => this.render({ error: '探针断开了（USB 被拔？）' });
    this.render();
    // 之前授权过的探针：静默接上（没授权就安静地保持未连接）
    if (!this.mock && AkaLinkHid.supported()) this.reconnect({ silent: true });
  }

  useMock(){
    this.mock = new MockAkaLinkHid();
    this.dev = this.mock;
    this.render();
    return this.mock;
  }

  // ---------------------------------------------------------------- 连接
  async connect(){
    try {
      await this.dev.request();
      this.info = await this.dev.info();
      this.render();
      toast(`已连接：${this.dev.label}${this.info.fw ? ' · FW ' + this.info.fw : ''}`, 'ok');
    } catch (e){
      this._statusError = e?.message || String(e);
      this.render({ error: this._statusError });
      toast('连接探针失败：' + (e?.message || e), 'err');
    }
  }

  async reconnect({ silent = false } = {}){
    if (this.mock) return;
    try {
      await this.dev.reconnect();
      this.info = await this.dev.info();
      this.render();
      if (!silent) toast(`已重连：${this.dev.label}`, 'ok');
      /**
       * 🚨 顺手把**探针侧状态**也查一次（2026-10 用户现场：一打开页面就看到"已连接：akaLinkPro…"，
       *    于是搞不清转发到底在不在跑、会不会影响 RTT Viewer）。
       *    桥是**探针侧**的状态 —— 上次没停的话，重新打开页面它照样在跑，而只查型号（info）是看不出来的：
       *    面板上会显示"已连接"却不说在不在搬数据。这里查一次 status，面板那行才说实话。
       */
      try {
        const r = await this.dev.status();
        this._noteProgress(r.status);
        this._acceptStatus(r.status);
        this.render();
        if (r.status?.running){
          toast('探针侧的 RTT 桥仍在运行（上一次没停）：它会一直读目标内存占着 RTT 环。' +
            '不用了就去点「停止」；要测 RTT Viewer 也建议先停 —— 两边读的是同一个 RTT 环。', 'warn', 10000);
        }
      } catch { /* 查不到状态不影响"连上了"这件事本身 */ }
    } catch (e){
      if (!silent) toast('重连失败：' + (e?.message || e), 'err');
      else this.render();
    }
  }

  // ---------------------------------------------------------------- 参数
  /** 目标类型是 RISC-V/JTAG 吗？（探针侧粘性标志，界面下拉是唯一真相）*/
  get isRiscv(){ return $('h-target').value === 'riscv'; }

  params(){
    const num = (id, dflt) => {
      const v = $(id).value.trim();
      const n = v === '' ? dflt : (v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10));
      return Number.isFinite(n) ? n : dflt;
    };
    return {
      addr: num('h-addr', 0),
      size: num('h-size', 0),
      channel: num('h-chan', 0),
      /**
       * 🚨 RISC-V/JTAG 下**必须发 0**（2026-10 真机踩到，见 `applyTargetType` 的说明）：
       *    这个字段在 JTAG 下是 DMI 的 idle/delay 覆盖值，把 45 MHz 这种数字塞进去，
       *    探针的 RISC-V 引擎就再也读不出目标内存 —— 现象是"桥一直找不到 RTT 控制块、
       *    读错数一直涨"，而同一个探针用 `hpm6800_rtt_loss.py`（clock 传 0）1.39 MB/s 跑得好好的。
       */
      clockHz: this.isRiscv ? 0 : (Number($('h-clock').value) || 0),
    };
  }

  persist(){
    store.set('hid.addr', $('h-addr').value);
    store.set('hid.size', $('h-size').value);
    store.set('hid.chan', $('h-chan').value);
    store.set('hid.clock', $('h-clock').value);
  }

  /** SWD 时钟那条是运行时调参（action 7），改了立刻发；没连就只记着 */
  async applyClock(){
    this.persist();
    if (this.mock) return;
    if (this.isRiscv){ toast('RISC-V/JTAG 下不用 SWD 时钟档（这个字段在 JTAG 下是 DMI idle，必须留 0）', 'warn'); return; }
    const { clockHz } = this.params();
    if (!this.dev.connected || !clockHz) return;
    try {
      await runProbeOperation(this, 'hid', async () => {
        await this.dev.configure({ clockHz });
        toast(`探针 SWD 时钟已设为 ${clockHz / 1e6} MHz`, 'ok');
        await this.refresh();
      }, { reason: 'RTT 转发要调整时钟', policy: 'reject' });
    } catch (e){ toast('调时钟失败：' + (e?.message || e), 'err'); }
  }

  /**
   * 切换探针的**全局目标类型**（HID 0x31 action 10）：0 = SWD/ARM，1 = RISC-V/JTAG。
   * RTT 桥自身的逻辑（找控制块 / 搬环形缓冲 / 回写 RdOff）两边完全一样，只有底下的读/RdOff 写
   * 与初始化分派不同（SWD 走 DAPLink 的 swd_host，RISC-V 走 DMI+SBA）。**粘性**：设一次一直有效。
   *
   * 🚨 **切 RISC-V 时要把 SWD 时钟清成 0，否则桥读不到目标内存**（2026-10 真机定位）：
   *    action 7 的 clock 字段在 JTAG 下是 DMI 的 idle/delay 覆盖值，45 MHz 这种数字塞进去，
   *    探针的 RISC-V 引擎就再也不应答 —— 现象是"控制块找不到、读错数一直涨、swdReady=false"，
   *    而同一块板同一个探针，用参考脚本 `hpm6800_rtt_loss.py`（clock 传 0）能跑 1.39 MB/s、rderr=0。
   */
  async applyTargetType(){
    const scope = globalThis.__tools?.scope;
    if (this.last?.running || this._starting || scope?.running || scope?._starting){
      $('h-target').value = this._targetRiscv ? 'riscv' : 'swd';
      store.set('rtt.target', $('h-target').value);
      toast('先停止 RTT 转发和采样，再切目标类型', 'warn');
      return;
    }
    const riscv = this.isRiscv;
    this._applyTargetUi();
    /**
     * 切到 RISC-V 时别自作聪明改地址：**HPM 上"盲目大范围搜控制块"不可靠**
     * （2026-10 真机实测：窗口给 0x01200000 + 256 KB 时读错数一直涨、就是搜不到；
     *   给准地址 0x01240000 立刻找到）。所以只提示用户走「载入 ELF…」那条确定的路。
     */
    if (riscv){
      const a = String($('h-addr').value || '').trim().toLowerCase();
      if (!a || a === '0x20000000' || a === '0x24000000'){
        toast('切到 RISC-V 了：HPM 的控制块地址请点「载入 ELF…」自动填（_SEGGER_RTT），' +
              '或在 0x01240000 一带手填 —— 对着 STM32 的默认窗口搜是搜不到的', 'warn', 8000);
      }
    }
    if (!this.dev.connected){ toast(`已记为 ${riscv ? 'RISC-V/JTAG' : 'SWD/ARM'}，连上探针后再切一次`, 'warn'); return; }
    try {
      await runProbeOperation(this, 'hid', async () => {
      const response = await this.dev.setTargetType(riscv);
      if (response.rc < 0) throw new Error('探针忙：先停止 RTT 转发和采样');
      this._targetRiscv = riscv;
      // 🚨 顺手把时钟字段清成 0（粘性状态里可能还留着上一次 SWD 的 45 MHz）
      if (riscv && !this.mock){
        try { await this.dev.configure({ clockHz: 0 }); } catch { /* 清不掉也不致命，start() 里还会再发一次 0 */ }
      }
      toast(`探针目标类型已切到 ${riscv ? 'RISC-V/JTAG' : 'SWD/ARM'}（粘性，采样器也跟着走）`, 'ok');
      await this.refresh();
      }, { mock: !!this.mock, reason: 'RTT 转发要切换目标类型', policy: 'reject' });
    } catch (e){ toast('切目标类型失败：' + (e?.message || e), 'err'); }
  }

  /**
   * 目标类型那格的界面部分：RISC-V/JTAG 下 SWD 时钟档无意义，直接置灰并说明为什么。
   * 抽出来是为了让"对账"（syncTargetTypeFromStore）也能刷这一格，而不用伪造一次切换动作。
   */
  _applyTargetUi(){
    const riscv = this.isRiscv;
    $('h-clock').disabled = riscv;
    $('h-clock').title = riscv
      ? 'RISC-V/JTAG 下必须留 0：这个字段在 JTAG 下是 DMI idle/delay 覆盖值，给成大数字会让探针读不到目标内存'
      : '运行时调参（HID 0x31 action 7），改完立刻生效';
  }

  /**
   * 切到本页时对账一次"别页改过全局目标类型"。
   *
   * RTT Viewer（`#r-target`）与 J-Scope（`#sc-target`）都绑**同一个键** `rtt.target`，
   * 它们改过之后本页下拉可能还停在上一次的值 —— 而"显示与探针实际状态不一致"正是
   * 2026-10 那条 -2 故障的起点（页面上写着 RISC-V，探针里是 SWD）。
   * 这里**只刷界面，不往探针写**：写由启动前补发负责（见 _startBridgeNow），
   * 因为切换要避开引擎运行中（固件会回 -7）。
   */
  syncTargetTypeFromStore(){
    const saved = store.get('rtt.target', '');
    if (saved !== 'riscv' && saved !== 'swd') return false;
    this._targetRiscv = saved === 'riscv';
    if ($('h-target').value === saved) return false;
    $('h-target').value = saved;
    this._applyTargetUi();
    return true;
  }

  // ---------------------------------------------------------------- 启停
  /**
   * 用之前先确保 HID 探针是在线的（2026-10 用户现场）：
   * 烧录器页/别的页面用探针时会重设 USB 端口，**其他页面已有的 WebHID 句柄会失效**
   * （`dev.connected` 变 false）。用户"刚烧完固件切过来点启动"，撞到的就是一句
   * "探针未连接"，完全看不出该干什么。所以这里静默重连一次（不弹框）。
   */
  async _ensure(){
    if (this.mock || this.dev.connected) return true;
    try {
      await this.dev.reconnect();
      this.info = await this.dev.info().catch(() => this.info);
      /**
       * 🚨 **重连之后要把"目标类型"补发一遍**：目标类型是探针侧的**粘性**状态，
       *    但探针被复位/别的页面重设过之后就回到 SWD 了 —— 而界面上下拉仍然显示 RISC-V
       *    （用户的意图），于是桥按 SWD 初始化 → 报"SWD 初始化失败"，看着像接线坏了。
       *    RISC-V 下顺带把时钟字段清 0（见 applyTargetType 的说明）。
       */
      if (this.isRiscv){
        try { await this.dev.setTargetType(true); } catch {}
        try { await this.dev.configure({ clockHz: 0 }); } catch {}
      }
      this.render();
      toast('探针已自动重连' + (this.isRiscv ? '（并补发了 RISC-V/JTAG 目标类型）' : ''), 'ok');
      return this.dev.connected;
    } catch (e){
      toast('探针没连上：点「连接探针」授权一次（' + (e?.message || e) + '）', 'err', 6000);
      return false;
    }
  }

  async start(){ return await this._startBridge(false); }
  async autostart(){ return await this._startBridge(true); }

  async _startBridge(auto){
    if (this._starting || this._stopPromise) return;
    const g = this._engineGen = (this._engineGen || 0) + 1;
    this._starting = true;
    clearInterval(this._timer);
    this._activeTask = runProbeOperation(this, 'hid', () => this._startBridgeNow(auto, g), {
      mock: !!this.mock, reason: 'RTT 转发要使用探针',
    });
    try { return await this._activeTask; }
    catch (e){ this.render({ error: e.message }); return false; }
    finally { this._activeTask = null; this._starting = false; }
  }

  async _startBridgeNow(auto, g){
    try {
      if (!this.mock){
        await prepareProbeHandoff(this, 'hid', 'RTT 转发要使用探针');
        if (g !== this._engineGen) return;
      }
      if (!await this._ensure() || g !== this._engineGen) return;
      const p = this.params();
      /**
       * 🚨 **启动前每次都补发目标类型**（2026-10 真机定因，别删）。
       *
       * 目标类型是探针侧的**粘性**状态，但烧录/复位、J-Scope 页、参考脚本都会把它打回 SWD；
       * 而本页按用户的意图显示 RISC-V —— 于是桥按 SWD 去握手，回 **-2「SWD 初始化失败」**，
       * 看着像接线/供电坏了。实测（HPM6800EVK + akaLinkPro，同一块板同一支探针）：
       *   · 目标类型=SWD → startRc=-2、控制块找不到、moved=0
       *   · 补发成 RISC-V 后再启动 → startRc=0、控制块 0x4C0003C0、moved=32768、读错 0
       * 固件在引擎运行时会拒绝切换（rc=-7）—— 那不算错，状态本来就该是它，所以这里不抛。
       * 重连分支里还有一处补发（见 _ensure，2026-09 为"烧完固件切过来"加的），两处都留着。
       */
      if (!this.last?.running){
        try {
          await this.dev.setTargetType(this.isRiscv);
        } catch { /* 补发失败不阻断启动：真失败会由 start 的 rc 报出来 */ }
        if (g !== this._engineGen) return;
      }
      if (!auto && (p.clockHz || this.isRiscv) && !this.mock) await this.dev.configure({ clockHz: p.clockHz });
      if (g !== this._engineGen) return;
      const before = this.last?.startRc ?? 0;
      this._bridgeRequested = true;
      // Block new UART writes, then let already submitted writes finish before changing producer.
      await this.probeManager?.cdcMode?.drainWrites();
      if (g !== this._engineGen) return;
      const response = auto ? await this.dev.autostart() : await this.dev.start(p);
      if (g !== this._engineGen) return;
      if (response?.rc < 0 && response.rc !== START_PENDING){
        this._bridgeRequested = false;
        throw new Error(startRcText(response.rc, this.isRiscv));
      }
      this.persist();
      await this._settle(before, 3000, g);
    } catch (e){
      if (g !== this._engineGen) return;
      if (this._bridgeRequested) this.probeManager?.fail('hid', e);
      this._statusError = e?.message || String(e);
      this.render({ error: this._statusError });
      toast('启动转发失败：' + (e?.message || e), 'err');
    }
  }

  async stop({ fromManager = false } = {}){
    this.probeManager?.cancel('hid');
    if (this._stopPromise) return await this._stopPromise;
    this._engineGen = (this._engineGen || 0) + 1;
    clearInterval(this._timer);
    this._stopPromise = this._stopBridgeNow(fromManager);
    try {
      const result = await this._stopPromise;
      this.probeManager?.forget('hid');
      return result;
    }
    finally { this._stopPromise = null; }
  }

  async _stopBridgeNow(fromManager){
    try {
      if (this._activeTask) await this._activeTask.catch(() => {});
      if (this.probeManager && !this.probeManager.leases.has('hid') && !fromManager){
        // A cancelled queued START has never owned the firmware engine.
        if (!this.last?.running && !this._bridgeRequested) return;
        return await runProbeOperation(this, 'hid', () => this._sendStopNow(), {
          reason: '停止探针侧 RTT 转发', policy: 'reject',
        });
      }
      return await this._sendStopNow();
    } catch (e){ this.render({ error: e.message }); throw e; }
  }

  async _sendStopNow(){
    try {
      const r = await this.dev.stop();
      if (r?.rc < 0 && r.rc !== START_PENDING) throw new Error(startRcText(r.rc, this.isRiscv));
      this._acceptStatus(r.status);
      const deadline = Date.now() + 3000;
      while (this.last?.running || this.last?.startRc === START_PENDING){
        if (Date.now() >= deadline) throw new Error('停止 RTT 转发超时（探针还在运行）');
        await waitMs(40);
        this._acceptStatus((await this.dev.status()).status);
      }
      this._stall = 0; this._lastMoved = null;
      this._bridgeRequested = false;
      this.probeManager?.confirm('hid');
      clearInterval(this._timer);
      this.render();
      toast('已停止转发（CDC 口切回 UART）', 'ok');
      /**
       * 🚨 停止转发 ≠ 停止记录：记录挂在**串口会话**上（见 hid/stream.js 的 s.on('close')），
       *    这里停了探针桥，串口还开着、文件句柄也还开着 —— 磁盘上那个 .crswap 不会因此变成
       *    正式文件（真机现场：用户以为停了转发就完事了，结果文件一直到不了手）。
       *    这里只提醒一句，不替他停（CDC 上可能还有 UART 数据要记）。
       */
      const st = window.__tools?.stream;
      if (st?.rec?.active){
        toast(`注意：「记录到文件」还在进行（已收 ${fBytes(st.rec.bytes)}，待落盘 ${fBytes(st.rec.backlog())}）—— ` +
          '点 RTT 转发页里那个「停止记录」才会把 .crswap 改名成正式文件', 'warn', 10000);
      }
    } catch (e){
      this._statusError = e?.message || String(e);
      this.render({ error: this._statusError });
      if (this.probeManager?.leases.has('hid')) this.probeManager.fail('hid', e);
      throw e;
    }
  }

  _acceptStatus(status){
    this.last = status; this._statusAt = Date.now(); this._statusError = null;
    this._statusSource = { dev: this.dev, device: this.dev.device, generation: this._engineGen };
  }

  async refresh(){
    if (this._starting || this._stopPromise || this.dev._pending) return;
    try {
      const dev = this.dev, device = dev.device, generation = this._engineGen;
      const r = await this.dev.status();
      if (this.dev !== dev || dev.device !== device || generation !== this._engineGen) return;
      this._noteProgress(r.status);
      this._acceptStatus(r.status);
      this.render();
    } catch (e){
      this._statusError = e?.message || String(e);
      this.render({ error: this._statusError });
    }
  }

  /**
   * 桥在跑，但"已搬运字节"长时间不涨 —— 十有八九是**另一路在抢同一个 RTT 上行缓冲**
   * （RTT Viewer 的 WebUSB / 桥自己的 RTT 会话都在读同一块环，谁快谁拿走），
   * 或者目标那边根本没在写。这个提示能省掉"为什么没输出"的半天天摸。
   */
  _noteProgress(st){
    if (!st.running){ this._stall = 0; this._lastMoved = null; return; }
    if (this._lastMoved === null || st.moved > this._lastMoved){ this._lastMoved = st.moved; this._stall = 0; return; }
    this._stall = (this._stall || 0) + 1;
  }

  /** 跑起来之后每 2 秒自己查一次，界面"活着"，也能发现上面那种卡住 */
  _armAutoRefresh(){
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.mock) return;                       // 假探针不用自动查
      if (!this.dev.connected) return;
      if (!this.last?.running) return;
      this.refresh();
    }, 2000);
  }

  /**
   * 启动是**排队**的（探针在主循环里做 SWD），所以这里轮询几次等结果：
   * 起来 / 返回码变了 / 超时，三种情况都会停。
   */
  async _settle(prevRc, timeout = 3000, generation){
    const t0 = Date.now();
    for (;;){
      if (generation !== undefined && generation !== this._engineGen) return;
      const r = await this.dev.status();
      if (generation !== undefined && generation !== this._engineGen) return;
      this._noteProgress(r.status);
      this._acceptStatus(r.status);
      this.render();
      const st = r.status;
      if (st.running && st.cbAddr) break;
      if (st.startRc !== 0 && st.startRc !== START_PENDING && st.startRc !== prevRc) break;
      if (Date.now() - t0 > timeout) break;
      /* 轮询间隔走 pace.waitMs（≤128 ms 是"让路自旋"，时长真实且**不受后台定时器节流**）。
         这里等的是"探针把桥拉起来"（几百毫秒量级），用 setTimeout 的话窗口一被遮住
         每次轮询就变 ≥1 s，白等好几倍。取 120 ms 是为了留在自旋档内。 */
      await waitMs(120);
    }
    const st = this.last;
    if (!st?.running && st?.startRc && st.startRc !== START_PENDING) this._bridgeRequested = false;
    if (st?.running && st.cbAddr){
      toast(`转发已启动 · 控制块 ${hex(st.cbAddr)} · 档位 ${st.swdMhz} MHz`, 'ok', 5000);
      this._armAutoRefresh();
    }
    else if (st?.running) toast(this.isRiscv
      ? `桥跑起来了，但还没找到控制块（读错 ${st.rdErr}）—— 地址窗口（按 _SEGGER_RTT 填）/ JTAG 接线 / 目标是否被停住，逐项看`
      : `桥跑起来了，但还没找到控制块（读错 ${st.rdErr}）—— 地址窗口 / SWD 接线 / 目标供电检查一下`, 'warn', 8000);
    else if (st?.startRc === START_PENDING) toast('启动还在排队（探针还没给出结果，稍后点「刷新状态」看看）', 'warn', 6000);
    else if (st?.startRc) toast('启动失败：' + startRcText(st.startRc, this.isRiscv), 'err', 6000);
  }

  // ---------------------------------------------------------------- ELF
  async loadElf(){
    const f = this._elfInput.files?.[0];
    this._elfInput.value = '';
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const sym = findSymbol(buf, '_SEGGER_RTT');
      if (!sym){
        toast(`${f.name} 里没有 _SEGGER_RTT 符号（strip 过？）→ 只能用「自动搜控制块」`, 'warn', 6000);
        return;
      }
      $('h-addr').value = hex(sym.addr);
      // 已知确切地址就不用扫 64 KB：给个 4 KB 窗口，既不越界也留点余量（固件是 512B 重叠窗块读）
      $('h-size').value = '0x1000';
      this.persist();
      this.render();
      toast(`从 ELF 拿到 _SEGGER_RTT = ${hex(sym.addr)}（${sym.size} B）→ 搜索长度设为 0x1000`, 'ok', 6000);
    } catch (e){
      toast('读 ELF 失败：' + (e?.message || e), 'err');
    }
  }

  // ---------------------------------------------------------------- 渲染
  render({ error } = {}){
    const dev = this.dev;
    // 第一行：设备信息
    if (error && !dev.connected) setStatus($('h-info'), error, 'err');
    else if (!dev.connected) setStatus($('h-info'), '未连接（点「连接探针」在弹框里选 akaLinkPro）', '');
    else{
      const i = this.info || {};
      setStatus($('h-info'), `已连接：${dev.label}${i.fw ? ' · FW ' + i.fw : ''}${i.sn ? ' · SN ' + i.sn : ''}`, 'ok');
    }

    // 第二行：桥的状态
    const st = this.last;
    const el = $('h-state');
    if (error && dev.connected) setStatus(el, error, 'err');
    else if (!st) setStatus(el, dev.connected ? '未启动' : '—', '');
    else if (st.running && !st.cbAddr){
      /**
       * 桥跑起来了但还没找到控制块。原因按概率排，而且**RISC-V 与 SWD 的排查项不一样**：
       *   · RISC-V：时钟字段必须是 0（页面已自动处理）、窗口要给 HPM 的 SRAM、探针得在 SWD+JTAG 模式
       *   · SWD：主机侧 DAP 在抢线、窗口要给对（Cortex-M7 是 AXI SRAM）、接线/供电
       */
      const riscv = this.isRiscv;
      const why = riscv
        ? ' —— ① 探针是不是在 SWD+JTAG 输出模式（烧录器页会自动切，也可 HID SET_CONFIG=1）；'
          + '② 地址窗口给对了吗（HPM 的控制块一般在 0x01240000 一带的 SRAM，或点「载入 ELF…」自动填）；'
          + '③ 目标在跑吗 / 查 JTAG 接线与供电'
        : ' —— ① 是不是同时开着 RTT Viewer 的 WebUSB（它在抢同一根 SWD，先断开）；'
          + '② 地址窗口给对了吗（Cortex-M7 要给 AXI SRAM）；③ 目标在跑吗 / 查 SWD 接线与供电';
      setStatus(el, `运行中 · 还没找到 RTT 控制块（读错 ${st.rdErr} / RdOff 错 ${st.wrErr}`
        + ` · 档位 ${st.swdMhz} MHz${st.dapYield ? ` · 给 DAP 让路 ${st.dapYield} 次` : ''}）` + why, 'err');
    }
    else if (st.running){
      /**
       * 「已搬运」不涨有两种完全不同的原因，别一律甩给"抢缓冲"：
       *   · **CDC 端口没打开** → 数据没地方去，探针的 CDC 缓冲满了自然就停了（这是最常见的）
       *   · 打开了还被抢 → RTT Viewer / 桥的另一个会话在搬同一个上行缓冲
       */
      // CDC 转发流的打开状态在另一个视图里（app/hid/stream.js，同面板「端口」那一栏）
      const sv = (typeof window !== 'undefined' && window.__tools && window.__tools.stream) || null;
      const portOpen = !!(sv && sv.s && (sv.s.port || sv.s.reader));
      const stall = (this._stall || 0) >= 2
        ? (portOpen
            ? ' ⚠ 桥在跑但「已搬运」不涨 —— 多半是另一路在抢同一个 RTT 缓冲（RTT Viewer 的 WebUSB / 桥的 RTT 会话），或者目标根本没在写'
            : ' ⚠ 桥在跑但「已搬运」不涨 —— CDC 端口还没打开：转发出来的数据要从探针的 CDC 串口读（右侧「端口」那一栏选 COM 口并打开），'
              + '没人收它就会把探针的环形缓冲写满然后停下')
        : '';
      setStatus(el, `运行中 · 控制块 ${hex(st.cbAddr)} · 上行缓冲 ${hex(st.upAddr)} · 通道 ${st.channel}`
        + ` · 已搬运 ${kb(st.moved)}（${st.transfers} 次）· 轮询 ${st.polls}`
        + ` · 读错 ${st.rdErr} / RdOff 错 ${st.wrErr} · 档位 ${st.swdMhz} MHz`
        + (st.dapYield ? ` · 给 DAP 让路 ${st.dapYield} 次` : '')
        + (st.discard ? ' · 丢弃模式' : '') + stall, stall ? 'warn' : 'ok');
    } else if (st.startRc === START_PENDING){
      setStatus(el, '正在启动…（探针还在排队搜控制块）', '');
    } else if (st.startRc){
      setStatus(el, `未运行 · 上次启动失败：${startRcText(st.startRc, this.isRiscv)}`, 'err');
    } else {
      setStatus(el, '未运行（点「启动转发」或「自动搜控制块」）', '');
    }
    return this.summary();
  }

  /** 自检用 */
  summary(){
    const st = this.last;
    return {
      supported: AkaLinkHid.supported(),
      mock: !!this.mock,
      connected: this.dev.connected,
      label: this.dev.connected ? this.dev.label : '',
      running: !!st?.running,
      cbAddr: st ? hex(st.cbAddr) : '',
      moved: st?.moved ?? 0,
      startRc: st?.startRc ?? null,
      // 桥给 DAP 让路的次数：涨得快 = 有主机侧 DAP 在抢 SWD（比如 RTT Viewer 的 WebUSB 在轮询）
      dapYield: st?.dapYield ?? 0,
      rescans: st?.rescans ?? 0,
      rdErr: st?.rdErr ?? 0,
      swdMhz: st?.swdMhz ?? 0,
      stall: this._stall || 0,
      state: $('h-state').textContent,
      info: $('h-info').textContent,
    };
  }
}
