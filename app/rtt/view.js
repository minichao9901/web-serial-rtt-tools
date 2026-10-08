/**
 * RTT Viewer 界面。
 * 后端四种：WebUSB-CMSIS-DAP（零安装）/ 本地桥+OpenOCD / 本地桥+J-Link(ch0) / 内置模拟目标。
 * 显示三种：终端(ANSI，xterm) / 文本 / HEX —— 三种共用同一份 raw 记录，切换时重放，不丢历史。
 */
import { prepareProbeHandoff } from '../core/probe-users.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { $, seg, setStatus, mhzLabel, ensureSelectOption } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { RxBuffer } from '../core/rxview.js';
import { FileRecorder, recordButtonState } from '../core/recorder.js';
import { Rtt } from './protocol.js';
import { WebUsbDapProbe, withTimeout } from './dap-webusb.js';
import { openRiscvMem } from './riscv-mem.js';
import { HPM_BOARDS, hpmBoard } from '../targets/hpm/porting.js';
import { selectedHpmBoard, rememberHpmBoard } from '../targets/hpm/select.js';
import { MockProbe } from './mock.js';
import { BridgeClient } from './bridge.js';
import { findSymbol } from './elf.js';
import { parseRanges } from '../core/bin.js';
import { parseHex, textToBytes } from '../core/hex.js';
import { pickCfgs } from '../ui/cfgpicker.js';
import { closeProbeUsbDevices } from '../core/probe-bus.js';
import { sleep } from '../core/pace.js';
import { rate as fRate, bytes as fBytes, fileStamp, download, stamp as stampOf } from '../core/format.js';

const EOL = { cr: '\r', crlf: '\r\n', lf: '\n', none: '' };
const MAX_RAW = 2 * 1024 * 1024;

/**
 * 各目标系列的默认 RAM 扫描范围（RTT 控制块一般在 RAM 起始附近，范围取各系列常见最小值，
 * 宁小勿大：扫到未映射地址轻则读到 0、重则 FAULT）。选目标时自动填入，可手改。
 */
const OCD_RAM = {
  stm32c0: '0x20000000-0x20003000',   // 12K
  stm32f0:  '0x20000000-0x20002000',  // 8K 起
  stm32f1:  '0x20000000-0x20005000',  // F103C8 20K
  stm32f103:'0x20000000-0x20005000',
  stm32f2:  '0x20000000-0x20020000',  // 128K
  stm32f3:  '0x20000000-0x2000a000',  // 40K 起
  stm32f4:  '0x20000000-0x20020000',  // 128K
  stm32f7:  '0x20000000-0x20020000',
  stm32g0:  '0x20000000-0x20008000',  // 32K
  stm32g4:  '0x20000000-0x20008000',
  stm32h7:  '0x20000000-0x20020000',  // DTCM 128K
  stm32h7b0:'0x20000000-0x20020000',  // H7B0（桥预设名就是这个）：DTCM 128K，RTT 缓冲放这儿
  stm32h7a3:'0x20000000-0x20020000',  // H7A3/B3 同族，DTCM 也是 128K
  stm32h7b3:'0x20000000-0x20020000',
  stm32h5:  '0x20000000-0x20020000',  // H503 128K
  stm32l0:  '0x20000000-0x20005000',  // 20K
  stm32l1:  '0x20000000-0x20004000',  // 16K
  stm32l4:  '0x20000000-0x2000c000',  // 48K
  stm32l5:  '0x20000000-0x20010000',  // 64K
  stm32u5:  '0x20000000-0x20020000',
  stm32wb:  '0x20000000-0x20040000',  // WB55 256K
  stm32wl:  '0x20000000-0x20010000',  // WLE5 64K
};

const rvRange = id => hpmBoard(id)?.memory.rttRange || '0x01240000-0x01250000';

/**
 * 「芯片」下拉（`#r-chip`）—— **一个下拉、两个组**（用户 2026-09-30：原来按目标类型换着显示的
 * 两个下拉合并成一个）。组的归属**只认 HTML 里的 `<optgroup data-arch="arm|riscv">`**：
 * 以后加芯片只改 index.html，这里不用维护第二份名单。
 *
 * 两条口径（用户强调过"ARM 也能走 JTAG"）：
 *   · **ARM 组**：WebUSB 通路固定 SWD；桥（OpenOCD/J-Link）走哪条传输由**你自己的 cfg** 决定 ——
 *     所以这里不写"ARM = SWD"这种话，只保证桥送出去的 target 名取的是 ARM 组那颗；
 *   · **RISC-V 组**：**只能 JTAG**，选中它就把「目标类型」切到 RISC-V/JTAG
 *     （否则会出现"选了 HPM 却还在走 SWD"这种错配）。
 */
const chipSel = () => document.getElementById('r-chip');
const chipArchOf = id => {
  const o = [...(chipSel()?.options || [])].find(x => x.value === id);
  return o?.parentElement?.dataset?.arch || 'arm';
};
/** 当前 ARM 组那颗（桥的 OpenOCD target 用它；选的是 RISC-V 时回退到上次选过的 ARM 那颗）*/
const armChipId = () => {
  const v = chipSel()?.value || '';
  return chipArchOf(v) === 'arm' ? v : (store.get('rtt.ocdTarget', '') || 'stm32f103');
};
/** 当前 RISC-V 组那颗（RAM 窗口用它；选的是 ARM 时回退到上次选过的 RISC-V 那颗）*/
const rvChipId = () => {
  const v = chipSel()?.value || '';
  return chipArchOf(v) === 'riscv' ? v : (store.get('rtt.rvChip', '') || selectedHpmBoard());
};

export class RttView {
  constructor(){
    this.probe = null;
    this.bridge = null;
    this.rtt = null;
    this.stream = false;
    this.mode = 'term';
    this.paused = false;
    this.running = false;
    this._sessionGen = 0;
    this.timer = null;
    this.interval = 5;
    this.records = [];
    this.recBytes = 0;
    this.truncated = false;
    this.term = null;
    this.fit = null;
    this.hist = [];
    this.histIdx = -1;
    this.rec = new FileRecorder();      // 高速采集落文件（见 core/recorder.js）
    this._lastWasCR = false;            // 终端模式补 \r 用的跨包状态（\r\n 不能补成 \r\r\n）
    this.suppressed = false;            // 高速自动关显示（见 _highspeedGate）
    this.suppManual = false;            // 用户手动恢复过显示：暂不再自动关，速率回落后重新武装
    this.suppBytes = 0;                 // 关显示期间省略渲染的字节数
    this.stats = { bytes: 0, polls: 0, lost: 0, corrupt: 0, lastBytes: 0, lastPolls: 0, rate: 0, hz: 0 };
  }

  init(){
    const group = document.querySelector('#r-chip optgroup[data-arch="riscv"]');
    if (group) group.replaceChildren(...HPM_BOARDS.map(b => new Option(b.name, b.id)),
      new Option('其它 RISC-V（自己填 RAM 范围）', 'riscv-other'));

    this.tx = new RxBuffer($('r-rx'), { mode: 'ascii', maxLines: 4000, maxRaw: MAX_RAW });

    // ---------- 设置 ----------
    store.bind($('r-backend'), 'rtt.backend');
    store.bind($('r-bridge-url'), 'rtt.bridgeUrl');
    store.bind($('r-range'), 'rtt.range');
    store.bind($('r-addr'), 'rtt.addr');
    store.bind($('r-poll'), 'rtt.poll');
    store.bind($('r-eol'), 'rtt.eol');
    // 芯片（合并后的 `#r-chip`）不再用 store.bind：两块选项各有自己的键，
    // 由下面 applyTarget() / change 处理器显式读写（rtt.ocdTarget = ARM 组那颗、rtt.rvChip = RISC-V 组那颗）
    store.bind($('r-ocd-cfgs'), 'rtt.ocdCfgs');
    store.bind($('r-ocd-speed'), 'rtt.ocdSpeed');
    // 老版本这里是自由输入框，localStorage 里可能存着候选之外的值（4000/8000…）：补个选项，别悄悄改掉它
    ensureSelectOption($('r-ocd-speed'), store.get('rtt.ocdSpeed', ''), mhzLabel(store.get('rtt.ocdSpeed', '')));
    /**
     * J-Link 这条路的两个参数（以前只有 localStorage、页面上没有入口，用户没法改）：
     *   · rtt.jlinkDevice —— 传给 J-Link 的器件名
     *   · rtt.jlinkSpeed  —— SWD 时钟 kHz（50000 = 50MHz）
     * 注意**页面传的值会覆盖桥的 bridge.config.json**（桥那边是 jlink.device / jlink.speed），
     * 所以两边的默认值必须一致 —— 都是 STM32F103C8 / 50000，改一处记得改另一处。
     */
    store.bind($('r-jlink-device'), 'rtt.jlinkDevice');
    store.bind($('r-jlink-speed'), 'rtt.jlinkSpeed');
    ensureSelectOption($('r-jlink-speed'), store.get('rtt.jlinkSpeed', ''), mhzLabel(store.get('rtt.jlinkSpeed', '')));
    /**
     * 「高速只读」：数据源从桥自启的 GDBServer telnet（全双工，实测上限 ~565 KB/s）
     * 换成 JLinkRTTLogger 落文件 + 桥 tail（~1463 KB/s）。默认**关**——勾上就没有下行了。
     */
    store.bind($('r-jlink-fast'), 'rtt.jlinkFast', 'checked');
    this._applyOcdTarget(false);      // 只同步自定义行的显隐；RAM 范围是用户存过的值，别在加载时覆盖
    // 「选择…」：列出桥所在机器的 OpenOCD cfg 让你挑（浏览器拿不到本地文件路径，列表只能由桥给）
    $('r-ocd-cfgs-pick').addEventListener('click', async () => {
      const v = await pickCfgs({
        bridgeUrl: $('r-bridge-url').value,
        current: $('r-ocd-cfgs').value,
        title: '选择 OpenOCD cfg（RTT 后端用）',
      });
      if (v !== null){ $('r-ocd-cfgs').value = v; store.set('rtt.ocdCfgs', v); }
    });
    this._chk($('r-ts'), 'rtt.ts', v => { this.ts = v; this.tx.setTimestamps(v, false); });
    this._chk($('r-autoscroll'), 'rtt.autoscroll', v => { this.tx.setAutoscroll(v); });
    this._chk($('r-hexsend'), 'rtt.hexsend', () => {});

    const mode = store.get('rtt.mode', 'term');
    this.mode = mode;
    this.modeSeg = seg(document.querySelector('[data-group=rttmode]'), mode, v => { store.set('rtt.mode', v); this._setMode(v); });
    this.interval = Math.max(1, Number($('r-poll').value) || 5);
    $('r-poll').addEventListener('input', () => { this.interval = Math.max(1, Number($('r-poll').value) || 5); });

    // ---------- 后端选择 ----------
    const applyBackend = () => {
      const b = $('r-backend').value;
      $('r-webusb-box').hidden = b !== 'webusb';
      $('r-bridge-box').hidden = !(b === 'bridge-openocd' || b === 'bridge-jlink');
      // J-Link 的 device/speed 只在「本地桥 · J-Link」下才有意义，别的后端别摆出来晃眼
      $('r-jlink-box').hidden = b !== 'bridge-jlink';
      $('r-mock-box').hidden = b !== 'mock';
    };
    applyBackend();
    $('r-backend').addEventListener('change', () => { applyBackend(); if (this.probe || this.bridge) this.disconnect(); });

    /**
     * 目标类型：**SWD/ARM** 还是 **RISC-V/JTAG**（零安装通路的两套底层，见 app/rtt/riscv-mem.js）。
     * 只影响 WebUSB 后端；桥后端（OpenOCD/J-Link）自己知道目标是什么。
     * RISC-V 下把界面里那几个"只有 Cortex-M 才有"的东西收起来/关掉，别让用户以为坏了：
     *   · 「复位目标」按钮（DHCSR/AIRCR 那套 RISC-V 上没有）→ 禁用；
     *   · RAM 扫描范围（RISC-V 板子的 RTT 控制块一般在 AXI SRAM，不在 0x20000000）→ 给常见默认值；
     *   · SWD 时钟那格的**含义变成 JTAG TCK**（DAP_SWJ_Clock），标签改掉。
     */
    const chip = chipSel();                 // 合并后的芯片下拉（ARM 组 + RISC-V 组，见文件头的辅助函数）
    const applyTarget = () => {
      const rv = $('r-target').value === 'riscv';
      const clkLbl = $('r-usb-clock')?.closest('label')?.querySelector('span');
      if (clkLbl) clkLbl.textContent = rv ? 'JTAG TCK' : 'SWD 时钟';
      $('r-usb-clock').title = rv
        ? 'RISC-V/JTAG 下它是 JTAG TCK 频率（DAP_SWJ_Clock），留「自动」即可；'
          + '注意它与 HID 0x31 action 7 那个 clockHz 字段不是一回事（后者是 DMI idle，必须 0）'
        : 'SWD 时钟：自动 = 从高到低试到通为止';
      $('r-reset').disabled = rv;
      $('r-reset').title = rv
        ? 'RISC-V 下没有 Cortex-M 的 DHCSR/AIRCR 复位语义（探针的 RISC-V 引擎只管 halt/resume）—— 要复位就按板子上的复位键'
        : '复位目标（AIRCR.SYSRESETREQ；探针没接 NRST 时靠软复位）';
      /**
       * 芯片下拉跟着目标类型走：切到 RISC-V/JTAG 就选中 RISC-V 组里上次那颗，切回 SWD 就选 ARM 组那颗。
       * 合并成一个下拉 ≠ 把两边的语义搅在一起：**桥送出去的 OpenOCD target 名永远取 ARM 组那颗**
       * （`armChipId()`），RISC-V 的 id 不会被当成 OpenOCD 预设名发出去。
       * ⚠️ 这里**无条件赋值**：下拉的默认值是"第一个选项"（stm32f103），不是用户存过的那颗 ——
       *    加个"已经在对的组里就不动"的判断，加载时就会显示成 stm32f103（而不是存的 custom）。
       *    从下拉那头切过来时也不会被覆盖：处理器先写 store 再切目标类型，这里读到的就是刚选的那颗。
       */
      if (chip) chip.value = rv ? (store.get('rtt.rvChip', '') || selectedHpmBoard())
                                : (store.get('rtt.ocdTarget', '') || 'stm32f103');
      $('r-range').value = rv ? (rvRange(rvChipId()))
                              : (OCD_RAM[armChipId()] || $('r-range').value);
      this._applyOcdTarget(false);
    };
    applyTarget();
    this._applyTargetUi = applyTarget;       // onShow 里要对账"别页切过目标类型"（同一个全局开关）
    store.bind($('r-target'), 'rtt.target');
    const onTargetChanged = () => { applyTarget(); if (this.probe || this.bridge) this.disconnect(); };
    $('r-target').addEventListener('change', onTargetChanged);
    /**
     * 合并后的芯片下拉：换芯片 = ① 记到**那一组自己的键**（两块各自记住上次选的）
     * ② RAM 窗口跟着换 ③ 跨组时把目标类型也切过去。
     * RISC-V 只能 JTAG ⇒ 选 RISC-V 那颗就切 RISC-V/JTAG；选 ARM 那颗切回 SWD
     * （桥侧对 ARM 用 JTAG 是**你自己的 cfg** 的事，这个下拉不管传输）。
     */
    chip?.addEventListener('change', () => {
      const id = chip.value, arch = chipArchOf(id);
      store.set(arch === 'riscv' ? 'rtt.rvChip' : 'rtt.ocdTarget', id);
      if (arch === 'riscv') rememberHpmBoard(id);
      const wantRv = arch === 'riscv';
      if (wantRv !== ($('r-target').value === 'riscv')){
        $('r-target').value = wantRv ? 'riscv' : 'swd';
        onTargetChanged();
      } else {
        $('r-range').value = wantRv ? (rvRange(id)) : (OCD_RAM[id] || $('r-range').value);
        this._applyOcdTarget(true);
      }
    });

    // ---------- 连接按钮 ----------
    $('r-usb-connect').addEventListener('click', () => this.connectProbe());
    $('r-usb-pick').addEventListener('click', () => { this._forcePick = true; this.connectProbe(); });
    $('r-usb-disconnect').addEventListener('click', () => this.disconnect());
    $('r-bridge-connect').addEventListener('click', () => this.connectProbe());
    $('r-bridge-disconnect').addEventListener('click', () => this.disconnect());
    $('r-find').addEventListener('click', () => this._startRtt().catch(e => this._err(e)));
    $('r-restart').addEventListener('click', () => this._startRtt().catch(e => this._err(e)));
    $('r-reset').addEventListener('click', () => this.resetTarget());
    $('r-elf').addEventListener('click', () => this._elfInput.click());
    $('r-pause').addEventListener('click', () => this._togglePause());
    $('r-clear').addEventListener('click', () => this._clear());
    $('r-save').addEventListener('click', () => this.save());
    store.bind($('r-usb-clock'), 'rtt.clockKhz');
    // 老版本这里是 select（0/1000/500/200/2000/4000/8000/12000/20000）：存过 8000/12000 的要能显示出来
    ensureSelectOption($('r-usb-clock'), store.get('rtt.clockKhz', ''), mhzLabel(store.get('rtt.clockKhz', '')));
    store.bind($('r-record-ts'), 'rtt.recordTs', 'checked');
    store.bind($('r-record-auto'), 'rtt.recordAuto', 'checked');
    $('r-record').addEventListener('click', () => this._toggleRecord());
    $('r-err').addEventListener('click', () => {
      // 高速关显示时状态栏就是恢复入口（文字会提示"点此恢复显示"）
      if (this.suppressed){ this.suppManual = true; this._setSuppressed(false); }
    });
    this.rec.onChange = () => this._recordBtn();
    // 记录期间"本页被切到后台"这类提醒（见 core/recorder.js 里的说明）
    this.rec.onNote = s => toast(s, 'warn', 8000);
    this._recordBtn();
    $('r-send').addEventListener('click', () => this._sendInput());

    this._elfInput = document.createElement('input');
    this._elfInput.type = 'file';
    this._elfInput.accept = '.elf,.axf,.out,.bin';
    this._elfInput.style.display = 'none';
    this._elfInput.addEventListener('change', () => this._loadElf());
    document.body.appendChild(this._elfInput);

    // ---------- 下行输入 ----------
    $('r-tx').addEventListener('keydown', e => {
      if (e.key === 'Enter'){ e.preventDefault(); this._sendInput(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown'){
        if (!this.hist.length) return;
        e.preventDefault();
        this.histIdx = e.key === 'ArrowUp'
          ? (this.histIdx < 0 ? this.hist.length - 1 : Math.max(0, this.histIdx - 1))
          : (this.histIdx < 0 ? -1 : Math.min(this.hist.length - 1, this.histIdx + 1));
        $('r-tx').value = this.histIdx < 0 ? '' : this.hist[this.histIdx];
      }
    });

    setInterval(() => this._stats(), 500);
    // 页面切到后台时浏览器会限速定时器（RTT 轮询会明显变慢）—— 如实告诉用户，别让人以为工具卡了
    document.addEventListener('visibilitychange', () => {
      if (!this.running) return;
      if (document.hidden){
        this._wasRunning = true;
        setStatus($('r-err'), '页面在后台：浏览器会限速定时器，RTT 轮询会变慢（数据不丢，切回来会补上）', null);
      } else if (this._wasRunning){
        this._wasRunning = false;
        setStatus($('r-err'), '', null);
      }
    });
    if (!WebUsbDapProbe.supported()) setStatus($('r-err'), '这个浏览器没有 WebUSB（Chrome/Edge 桌面版才有）', 'err');

    // URL 参数：?backend=mock&auto=1 直接连上（做演示链接/自测用）
    const q = new URLSearchParams(location.search);
    const b = q.get('backend');
    if (b && [...$('r-backend').options].some(o => o.value === b)){
      $('r-backend').value = b;
      $('r-backend').dispatchEvent(new Event('change'));
    }
    if (q.get('addr')) $('r-addr').value = q.get('addr');
    this._setMode(mode);                       // 起手就要应用显示模式（否则默认的终端模式没容器，数据看不见）
    // 只有当 URL **明确指定了后端**时才自动连接（否则会拿 localStorage 里上次的后端乱连）
    if (b && q.get('auto') === '1') setTimeout(() => this.connectProbe().catch(() => {}), 150);
  }

  _chk(el, key, apply){
    store.bind(el, key, 'checked');
    el.addEventListener('change', () => apply(el.checked));
    apply(el.checked);
  }

  /** 芯片下拉变化：显示/隐藏自定义 cfg 输入；选系列时把 RAM 范围填成常见值 */
  _applyOcdTarget(applyRange){
    const t = armChipId();                  // 合并后的下拉里 ARM 组那颗（「自定义 cfg…」也在这组）
    const custom = t === 'custom';
    // 「非缓存区」那段提醒只对 RISC-V 有意义（ARM 的 RTT 缓冲放普通 RAM 就行），别让它一直占地方
    const note = $('r-chip-note');
    if (note) note.hidden = chipArchOf(chipSel()?.value || '') !== 'riscv';
    $('r-ocd-custom-cfgs-row').hidden = !custom;
    $('r-ocd-cfgs-hint').hidden = !custom;
    $('r-ocd-custom-speed-row').hidden = !custom;
    if (applyRange && $('r-target').value !== 'riscv' && OCD_RAM[t]) $('r-range').value = OCD_RAM[t];
  }

  // ================= 连接 =================
  async connectProbe(){
    if (this._connectPromise || this._disconnectPromise || this.probe || this.bridge) return;
    const g = this._sessionGen = (this._sessionGen || 0) + 1;
    const backend = $('r-backend')?.value || 'webusb';
    this._probeMock = backend === 'mock';
    this._connectPromise = runProbeOperation(this, 'rtt', () => this._connectProbe(g, backend), {
      mock: this._probeMock, reason: 'RTT Viewer 要使用探针', recovery: true,
    });
    try { return await this._connectPromise; }
    catch (e){ this._err(e); return false; }
    finally {
      if (g !== this._sessionGen && (this.probe || this.bridge)) await this.disconnect();
      this._connectPromise = null;
    }
  }

  async _connectProbe(g, b = $('r-backend').value){
    try {
      if (b !== 'mock'){
        await prepareProbeHandoff(this, 'rtt', 'RTT Viewer 要使用探针');
        if (g !== this._sessionGen) return;
      }
      if (b === 'webusb'){
        const clockKhz = Number(store.get('rtt.clockKhz', 0)) || 0;
        if ($('r-target').value === 'riscv'){
          /**
           * RISC-V/JTAG 走另一套底层：HID 切 SWD+JTAG → WebUSB 的 DAP_JTAG_Sequence → DMI → SBA
           * （见 app/rtt/riscv-mem.js）。它自己会把探针侧那个占着 TAP 的 RISC-V 引擎/RTT 桥停掉，
           * 所以这里不用再管 `authorized()` 那套 ARM 的时钟协商（那套按 SWD 走，RISC-V 上必 NO ACK）。
           */
          const target = rvChipId();
          const openOnce = () => openRiscvMem({ target, clockKhz, all: $('r-usb-all').checked, log: s => console.log('[riscv]', s) });
          try {
            this.probe = await openOnce();
          } catch (e1){
            setStatus($('r-err'), `RISC-V 第一次连接失败（${e1.message}）—— 等 1.2 s 重试一次…`, 'warn');
            await sleep(1200);
            try { await closeProbeUsbDevices(); } catch { /* 关不掉就继续试 */ }
            this.probe = await openOnce();
          }
          const inf = this.probe.info();
          toast(`RISC-V 已就绪：${this.probe.name} · IDCODE 0x${Number(inf.idcode || 0).toString(16)}`, 'ok');
          this.stream = false;
          if (g !== this._sessionGen) return;
      this._uiConnected(true);
          if ($('r-record-auto').checked && !this.rec.active) this._autoStartRecord();
          await this._startRtt(g);
          return;
        }
        // 已经授权过的探针**不用再弹选择框**（用户体验也好得多）；想换设备点「换设备…」
        // 🚨 全部加超时：USB 服务被挂起传输搞脏时，getDevices()/open() 会永远不返回，
        //    界面看着像"点了一下就没反应"（实测卡过 90 秒）。宁可 5 秒报错并给出自救提示。
        let auth;
        try {
          auth = this._forcePick ? [] : await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
        } catch (e){
          throw new Error(`${e.message} —— 浏览器 USB 服务可能被上一次中断的会话卡住了：刷新页面（或拔插一次探针）再试`);
        }
        this._forcePick = false;
        if (auth.length){
          /**
           * 🚨 **刚被别的会话用过的探针，第一次常常连不上**（2026-10 真机复现多次）：
           *    烧录器/上一个页签刚断开时，浏览器释放 USB 接口要一会儿，紧接着 open() 会拿到
           *    脏响应（`SWD ACK=0 / ACK=5`、`响应回显 0x3 ≠ 命令 0x0`）或 `Unable to claim interface`。
           *    界面上的提示一直是"再点一次就好了" —— 那就**自己再点一次**：等 1.2 s、
           *    把本页签残留的探针句柄 close 掉（僵尸认领会挡住重新认领），再开一次。
           *    只重试一次：真坏了（没插/被别的程序占着）第二次照样会报错，不会无限转。
           */
          const openOnce = () => withTimeout(WebUsbDapProbe.open(auth[0], { clockKhz }), 20000, '连接探针');
          try {
            this.probe = await openOnce();
          } catch (e1){
            setStatus($('r-err'), `第一次连接失败（${e1.message}）—— 等 1.2 s 重试一次…`, 'warn');
            await sleep(1200);
            try { await closeProbeUsbDevices(); } catch { /* 关不掉就继续试 */ }
            this.probe = await openOnce();          // 还失败就把错抛给上层（带着第二次的原因）
          }
          toast('使用已授权探针：' + this.probe.name, 'ok');
        } else {
          this.probe = await withTimeout(WebUsbDapProbe.request($('r-usb-all').checked, { clockKhz }), 60000, '等你在浏览器里选探针');
          toast('探针已连接：' + this.probe.name, 'ok');
        }
        this.stream = false;
      } else if (b === 'mock'){
        this.probe = new MockProbe();
        await this.probe.connect();
        this.stream = false;
        toast('模拟目标已启动（内存里有个假 RTT 控制块）', 'ok');
      } else {
        // 芯片下拉里选的是 RISC-V 那颗时，别把它的 id 当 OpenOCD 预设名发给桥（桥那边没有这个预设）
        if (chipArchOf(chipSel()?.value || '') === 'riscv'){
          throw new Error('这一颗是 RISC-V：桥（OpenOCD / J-Link）那条路要你自己给目标 cfg —— '
            + '改选 ARM 组的「自定义 cfg…」并填 cfg 列表；RISC-V 推荐走「调试后端 → WebUSB」那条零安装的路');
        }
        const bc = new BridgeClient($('r-bridge-url').value);
        await bc.connect({ version: 1 });
        const backend = b === 'bridge-openocd' ? 'openocd' : 'jlink';
        // OpenOCD：目标优先用「预设名」（桥端查 bridge.config.json），自定义则直接给 cfg 列表；
        // 预设时**不传 speed**（桥用配置里的预设速度——之前总是传 4000 会把配置值覆盖掉）。
        // J-Link 仍走自己的参数。
        const cfg = {
          openocd: store.get('rtt.ocdPath', ''),
          target: armChipId(),
        };
        if (cfg.target === 'custom'){
          cfg.cfgs = String($('r-ocd-cfgs').value || '').split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
          cfg.speed = Number($('r-ocd-speed').value) || 0;
          if (!cfg.cfgs.length) throw new Error('自定义目标要填 cfg 文件（逗号分隔，相对 OpenOCD scripts 目录或绝对路径）');
        }
        if (backend === 'jlink'){
          cfg.jlink = store.get('rtt.jlinkPath', '');
          // device/speed 现在页面上有输入框了（#r-jlink-device / #r-jlink-speed）：
          // 留空就退回默认（与 bridge/bridge.config.json 的 jlink 段保持一致）
          cfg.device = String(store.get('rtt.jlinkDevice', 'STM32F103C8') || 'STM32F103C8').trim();
          cfg.speed = Number(store.get('rtt.jlinkSpeed', 50000)) || 50000;
          // 勾了「高速只读」就让桥用 JLinkRTTLogger 当数据源（桥端见 JLinkBackend.start 的 loggerExe）
          if ($('r-jlink-fast').checked) cfg.mode = 'logger';
        }
        const r = await bc.open(backend, cfg);
        this.bridge = bc;
        if (backend === 'jlink'){
          this.stream = true;
          this.probe = null;
          bc.onStream = d => this._ingest(d, new Date());
          bc.onClose = () => this._fail(new Error('桥断开'));
          toast('J-Link 流模式已连接（RTT ch0 全双工）', 'ok');
        } else {
          this.stream = false;
          this.probe = bc;
          toast('桥 + OpenOCD 已连接', 'ok');
        }
        if (r?.info?.note) setStatus($('r-err'), r.info.note);
      }
      this._uiConnected(true);
      if ($('r-record-auto').checked && !this.rec.active) this._autoStartRecord();
      if (this.stream) this._stats(); else await this._startRtt(g);
    } catch (e){
      /**
       * 🚨 收尾时**要把错误留在状态栏上**（2026-10 真机走查踩到）：
       *    `disconnect()` 最后一句是 `setStatus($('r-err'), '已断开')`，它会把 `_err(e)` 刚写上去的
       *    真正原因**覆盖掉** —— 用户看到的是"已断开"，而实际原因是"没找到 RTT 控制块 / 读失败"，
       *    等于把唯一的线索擦掉了（本机就因此白查了一轮：以为是探针没连上）。
       *    这里在断开之后再补一句，把原因留在界面上。
       */
      const why = e?.message || String(e);
      this._err(e);
      await this.disconnect();
      setStatus($('r-err'), '连接失败：' + why);
    }
  }

  async disconnect(){
    this.probeManager?.cancel('rtt');
    this._sessionGen = (this._sessionGen || 0) + 1;
    this.running = false;
    clearTimeout(this.timer); clearTimeout(this._idleTimer); clearTimeout(this._resetTimer);
    if (this._disconnectPromise) return await this._disconnectPromise;
    this._disconnectPromise = this._disconnectNow();
    try {
      const result = await this._disconnectPromise;
      this.probeManager?.forget('rtt');
      return result;
    } catch (e){
      this.probeManager?.fail('rtt', e);
      throw e;
    } finally { this._disconnectPromise = null; }
  }

  async _disconnectNow(){
    this.running = false;
    clearTimeout(this.timer);
    if (this.rec.active || this.rec.needsClose || this.rec.starting || this.rec.draining){
      const info = await this.rec.stop();
      this._recordBtn();
      if (info?.error) toast('记录落盘出错：' + (info.error.message || info.error), 'err', 8000);
      else if (info) toast(`记录已停止并保存：${info.name}（${fBytes(info.bytes)}）`, 'ok', 6000);
    }
    let failure = null;
    if (this.probe?.disconnect){
      try { await this.probe.disconnect(); this.probe = null; }
      catch (e){ failure = e; }
    }
    if (this.bridge?.close){
      try { this.bridge.close(); this.bridge = null; }
      catch (e){ failure ||= e; }
    }
    if (failure) throw failure;
    this.rtt = null; this.stream = false;
    this.suppManual = false;
    if (this.suppressed) this._setSuppressed(false);
    this._uiConnected(false);
    setStatus($('r-err'), '已断开');
  }

  _uiConnected(on){
    $('r-usb-connect').disabled = on; $('r-usb-pick').disabled = on; $('r-usb-disconnect').disabled = !on;
    $('r-bridge-connect').disabled = on; $('r-bridge-disconnect').disabled = !on;
    $('r-backend').disabled = on;
    if (!on){ $('r-cb').textContent = '—'; $('r-up').textContent = '0'; $('r-down').textContent = '0'; }
  }

  async _startRtt(g){
    if (!this.probe) return;
    if (g === undefined) g = this._sessionGen = (this._sessionGen || 0) + 1;
    const probe = this.probe;
    const active = () => g === this._sessionGen && this.probe === probe;
    this.running = false;
    clearTimeout(this.timer);
    const addrText = String($('r-addr').value || '').trim();
    const addr = addrText ? Number(addrText) : 0;
    const ranges = parseRanges($('r-range').value);
    setStatus($('r-err'), '正在查找 RTT 控制块…');
    // 定位是"一次性的关键动作" → 严格档（扫描要跨很多地址，读到残渣就会锁错控制块）
    const found = await this._strict(() => Rtt.locate(probe, {
      addr, ranges,
      onProgress: (p, a) => setStatus($('r-err'), `扫描控制块 ${(p * 100) | 0}%  @0x${a.toString(16)}`),
    }));
    if (!active()) return;
    if (!found) throw new Error('没找到 SEGGER RTT 控制块：固件里编进 RTT 了吗？RAM 范围填对了吗？（也可以载入 .elf 用符号定位）');
    const rtt = new Rtt(probe, { addr: found });
    await rtt.init(found);
    if (!active()) return;
    const inff = rtt.info();
    $('r-cb').textContent = '0x' + found.toString(16);
    $('r-up').textContent = inff.maxUp;
    $('r-down').textContent = inff.maxDown;
    const nm = await rtt.name('up', 0);
    if (!active()) return;
    this.rtt = rtt;
    $('r-chlabel').textContent = `下行 ch0${nm ? ' · ' + nm : ''}`;
    const sz = inff.up[0]?.size || 0;
    setStatus($('r-err'), `控制块 0x${found.toString(16)}，上行缓冲 ${sz} B${inff.maxUp > 1 ? `（固件声明 ${inff.maxUp} 个上行通道，本页读 ch0）` : ''}`, 'ok');
    this._startPoll(g);
    this._armIdleWatchdog();
  }

  /**
   * 看门狗：控制块找到了、却一个字节都不来 —— 十有八九是**目标被停住了**
   * （上一次调试会话 halt 了它，或探针 connect 时默认 halt）。
   * 这时主动让它跑起来，并在状态条上说清楚，别让用户以为工具坏了。
   */
  _armIdleWatchdog(){
    const g = this._sessionGen, probe = this.probe;
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(async () => {
      if (g !== this._sessionGen || !this.running || this.stats.bytes > 0) return;
      if (typeof this.probe?.run !== 'function') return;
      try {
        // ⚠️ 只在**确实停住**时才写 DHCSR 让它跑。
        //    早期版本无条件写 run()，结果把一个正在运行的固件"弄停"了：
        //    现象是"连上后读到几 KB 就不再来数据"（时间点正好在看门狗触发处）。
        const halted = await probe.isHalted?.();
        if (g !== this._sessionGen || probe !== this.probe) return;
        if (halted) await probe.run();
        else { setStatus($('r-err'), '两秒内没收到数据，但目标在运行中（检查固件有没有在写 RTT）', null); return; }
        setStatus($('r-err'), '目标原本处于 halt 状态（固件不跑就没数据），已自动继续运行', 'ok');
      } catch (e){ /* 不支持就算了 */ }
    }, 2000);
  }

  _startPoll(g){
    if (g === undefined) g = this._sessionGen = (this._sessionGen || 0) + 1;
    const rtt = this.rtt, probe = this.probe;
    const active = () => this.running && g === this._sessionGen && this.rtt === rtt && this.probe === probe;
    clearTimeout(this.timer);
    this.running = true;
    /**
     * 后台轮询切**快速档**（RAM 单读 + 热点写不回读）——吞吐优先；
     * 用户手动动作（下行/复位/定位）在 _strict() 里临时切回严格档。
     * 桥后端没有这个开关（它是 RPC，不涉及 AP 读写细节）。
     */
    if (this.probe && typeof this.probe.fast === 'boolean') this.probe.fast = true;
    this.stats.polls = 0; this.stats.bytes = 0; this.stats.lost = 0;
    this.fullPolls = 0; this.highPolls = 0; this.peak = 0; this._faults = 0;
    this._pollT0 = Date.now(); this._zeroHinted = false; this._zeroHintSet = false;   // 见 _stats 里的"零速率"诊断
    /**
     * 轮询间隔下限：走桥（OpenOCD Tcl RPC）时不能按 WebUSB 那种节奏猛刷 ——
     * 一轮 readUp 是 3 条 RPC，190 Hz 就是 ~570 条/秒，OpenOCD 的 Tcl 口扛不住，
     * 会冒出"read_memory 只回来 0 个字"这种瞬时失败（本机实测）。
     * 反正 OpenOCD 的读数只有 ~17 KB/s，快轮询没有意义。
     */
    const minGap = this.bridge ? 30 : 0;
    const loop = async () => {
      if (!active()) return;
      const t0 = performance.now();
      try {
        const { bytes, lost, high, level, corrupt } = await rtt.readUp(0);
        if (!active()) return;
        if (bytes.length) this._ingest(bytes, new Date());
        if (lost) this.stats.lost += lost;
        if (high) this.highPolls++;
        if (level > this.peak) this.peak = level;
        if (corrupt){
          this.stats.corrupt++;
          this._corruptRun = (this._corruptRun || 0) + 1;
          // 别刷屏：10 秒提醒一次。错位读常见原因：SWD 时钟过高、接线/共地不良
          //（拔插过 LA/杜邦线后特别常见）、或 USB 响应流错位
          if (!this._corruptAt || Date.now() - this._corruptAt > 10000){
            this._corruptAt = Date.now();
            if (!this.suppressed) setStatus($('r-err'),
              '检测到错位读（读回了控制块内容，已丢弃并重读）—— 查 SWD 时钟、接线与共地', 'err');
          }
          // 🚨 连续错位读说明不是偶发：多半是 USB 响应流错位（所有 Transfer 响应回显都是 0x05，
          //    错位后回显照样匹配，读回来的全是别的命令的答案）或 SWD 链路半死。
          //    升级自愈：recover() 重激活 SWD；不行就 reopen() 重开 USB 会话（resync 只在这条路上跑）。
          if (this._corruptRun === 15 || (this._corruptRun > 15 && this._corruptRun % 60 === 0)){
            if (!this.suppressed) setStatus($('r-err'), `连续 ${this._corruptRun} 轮错位读，正在自愈（SWD 重激活 → 必要时重开 USB 会话）…`, 'err');
            try { await probe?.recover?.();
            if (!active()) return; } catch {}
            let ok = false;
            try {
              const hdr = await probe.readMem(rtt.addr, 16);
              ok = String.fromCharCode(...hdr.subarray(0, 10)) === 'SEGGER RTT';
            } catch {}
            if (!ok){
              try { await probe.reopen?.(); } catch {}
            }
          }
          if (this._corruptRun > 150){
            this._fail(new Error('连续错位读且自愈无效 —— SWD 链路不稳定：查接线/共地，或把 SWD 时钟调低'));
            return;
          }
        } else {
          this._corruptRun = 0;
        }
      } catch (e){
        /**
         * 🚨 手动断开时，在飞的 readUp 稍后会抛"探针未连接" —— 不在这儿让路的话，
         *    `_fail()` 会把状态栏从"已断开"覆盖成"读取失败"（看起来像出了故障，其实是我们自己停的）。
         */
        if (!active()) return;
        const msg = String(e?.message || e);
        // SWD 访问出错 / 控制块内容不可信 → 先自愈（重新初始化调试口），别立刻放弃
        if (/FAULT|NO ACK|不可信|不合理|没在运行/.test(msg)){
          this._faults = (this._faults || 0) + 1;
          if (this._faults === 3 || this._faults % 15 === 0){
            setStatus($('r-err'), `SWD 访问出错，正在自愈（第 ${this._faults} 次）：${msg}`, 'err');
            try {
              await probe?.recover?.();
            if (!active()) return;
              const hdr = await probe.readMem(rtt.addr, 16);
              const id = String.fromCharCode(...hdr.subarray(0, 10));
              if (id === 'SEGGER RTT'){ this._faults = 0; setStatus($('r-err'), '', null); }
              else setStatus($('r-err'), '目标似乎没在运行（RTT 控制块不见了）：点「复位目标」，或确认固件在跑', 'err');
            } catch { /* 继续重试 */ }
          }
          if (this._faults > 80){ this._fail(new Error('连续 SWD 访问失败，已放弃：' + msg)); return; }
        } else { this._fail(e); return; }
      }
      if (!active()) return;
      this.stats.polls++;
      const cost = performance.now() - t0;
      this.timer = setTimeout(() => { if (active()) this._pollTask = loop(); }, Math.max(minGap, this.interval - cost, 0));
    };
    this._pollTask = loop();
  }

  _fail(e){
    this.running = false;
    clearTimeout(this.timer);
    setStatus($('r-err'), '读取失败：' + (e?.message || e), 'err');
  }

  _err(e){
    setStatus($('r-err'), String(e?.message || e), 'err');
    toast(String(e?.message || e), 'err', 6000);
  }

  // ================= 数据 =================
  _ingest(bytes, t){
    if (!bytes?.length) return;
    this.stats.bytes += bytes.length;
    this.rec.push(bytes, t);            // 落文件在"显示之前"：暂停/丢历史都不影响它
    if (this.suppressed){
      if (this.records.length === 0 && this.mode === 'term'){
        const hint = $('r-empty');
        if (hint) hint.hidden = true;
      }
      this.suppBytes += bytes.length;
      return;
    }
    this.records.push({ t, b: bytes });
    if (this.records.length === 1) this._updateEmptyHint();
    this.recBytes += bytes.length;
    while (this.recBytes > MAX_RAW && this.records.length > 1){
      this.recBytes -= this.records.shift().b.length;
      this.truncated = true;
    }
    if (this.paused) return;
    if (this.mode === 'term') this._termWrite(bytes, t);
    else this.tx.push(bytes, t);
  }

  _termWrite(bytes, t){
    if (!this.term) return;
    if (this.ts) this.term.write(`\x1b[90m[${stampOf(t)}]\x1b[0m `);
    // 很多固件只发 \n 不发 \r，直接塞给 xterm 会变成阶梯状 → 按字节自动补 \r
    //（和终端标签页 terminal.js 同一套规则；不能按字符串处理，多字节 UTF-8 会被拆坏）
    const out = [];
    for (let i = 0; i < bytes.length; i++){
      const b = bytes[i];
      if (b === 0x0a && !this._lastWasCR) out.push(0x0d);
      out.push(b);
      this._lastWasCR = (b === 0x0d);
    }
    this.term.write(Uint8Array.from(out));
  }

  _ensureTerm(){
    if (this.term || !window.Terminal) return;
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono","JetBrains Mono",Consolas,monospace',
      fontSize: Number(store.get('rtt.font', 13)) || 13,
      lineHeight: 1.15, cursorBlink: true, scrollback: 3000,
      theme: { background: '#0a0f15', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#264f78' },
    });
    try { this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit); } catch {}
    this._termStale = !$('tab-rtt').classList.contains('active');   // 在隐藏状态下创建的话，第一次显示时要重放
    this.term.open($('r-term'));
    this.fit?.fit();
    // 允许直接在终端里敲（等价于下行 ch0），像 JLinkRTTViewer 的 Terminal 模式
    this.term.onData(d => {
      const eol = $('r-eol').value;
      if (d === '\r') this._sendBytes(textToBytes(EOL[eol] ?? '\r'));
      else this._sendBytes(textToBytes(d));
    });
    const ro = new ResizeObserver(() => { if (this.mode === 'term') { try { this.fit?.fit(); } catch {} } });
    ro.observe($('r-term'));
  }

  /** 切到本标签时调用（隐藏状态下建的终端在这里补尺寸/重放） */
  onShow(){
    if (!this.probe && !this.bridge && $('r-target').value === 'riscv' && hpmBoard(chipSel()?.value)) {
      const previous = hpmBoard(chipSel().value);
      const id = selectedHpmBoard();
      if ($('r-range').value === previous.memory.rttRange) $('r-range').value = rvRange(id);
      chipSel().value = id; // Preserve custom range and explicit ELF address.
    }
    /**
     * 目标类型是**全局且粘**的（HID 0x31 action 10），波形页也能切、而且写的是同一个键
     * （`rtt.target`）。用户很可能在那边刚切过 RISC-V —— 切回来时这一格得跟上，
     * 否则"同一个开关，两页显示不一样"，看起来就像没生效。真不一致就按新值重摆界面。
     */
    const savedTarget = store.get('rtt.target', '');
    if ((savedTarget === 'riscv' || savedTarget === 'swd') && savedTarget !== $('r-target').value && this._applyTargetUi){
      $('r-target').value = savedTarget;
      this._applyTargetUi();
    }
    if (this.mode !== 'term' || !this.term) return;
    try { this.fit?.fit(); } catch {}
    if (this._termStale){ this._redrawAll(); this._termStale = false; }
  }

  _setMode(m){
    this.mode = m;
    $('r-term').hidden = m !== 'term';
    $('r-rx').hidden = m === 'term';
    this._updateEmptyHint();
    if (m === 'term'){ this._ensureTerm(); this._redrawAll(); try { this.fit?.fit(); } catch {} }
    else { this.tx.setMode(m === 'hex' ? 'hex' : 'ascii'); this._redrawAll(); }
  }

  _updateEmptyHint(){
    const hint = $('r-empty');
    if (hint) hint.hidden = this.mode !== 'term' || this.records.length > 0;
  }

  _redrawAll(){
    if (this.mode === 'term'){
      if (!this.term) return;
      this.term.clear();
      for (const r of this.records) this._termWrite(r.b, r.t);
    } else {
      this.tx.clear();
      for (const r of this.records) this.tx.push(r.b, r.t);
    }
  }

  _togglePause(){
    this.paused = !this.paused;
    $('r-pause').textContent = this.paused ? '继续' : '暂停';
    $('r-pause').classList.toggle('primary', this.paused);
    if (!this.paused) this._redrawAll();
  }

  _clear(){
    this.records = []; this.recBytes = 0; this.truncated = false;
    this.tx.clear();
    this.term?.clear();
    this._updateEmptyHint();
  }

  // ================= 下行 =================
  _sendInput(){
    const raw = $('r-tx').value;
    if (!raw.trim()) return;
    const bytes = this._build(raw);
    if (!bytes) return;
    if (this.hist[this.hist.length - 1] !== raw) this.hist.push(raw);
    if (this.hist.length > 100) this.hist.shift();
    this.histIdx = -1;
    $('r-tx').value = '';
    this._sendBytes(bytes);
  }

  _build(text){
    let b;
    if ($('r-hexsend').checked){
      const r = parseHex(text);
      if (r.error){ setStatus($('r-err'), r.error, 'err'); return null; }
      b = r.bytes;
    } else {
      b = textToBytes(text);
    }
    const tail = EOL[$('r-eol').value] ?? '';
    if (tail) b = new Uint8Array([...b, ...textToBytes(tail)]);
    return b;
  }

  /**
   * 临时切到**严格档**跑一段（探针 fast=false）：小块读双读、写必回读。
   * 用于用户手动动作（下行发送、复位、定位控制块）——这些一秒钟也就几次，
   * 稳妥优先；后台轮询则用快速档换吞吐（见 _startPoll 里对 probe.fast 的设置）。
   */
  async _strict(fn){
    const p = this.probe;
    if (!p || typeof p.fast !== 'boolean') return await fn();
    const prev = p.fast;
    p.fast = false;
    try { return await fn(); } finally { p.fast = prev; }
  }

  async _sendBytes(bytes){
    try {
      if (this.stream){
        if (!this.bridge) throw new Error('桥未连接');
        await this.bridge.streamWrite(bytes);
      } else {
        if (!this.rtt) throw new Error('RTT 还没就绪（先扫描控制块）');
        // 下行命令是"用户按下就要成功"的动作 → 严格档（写指针必须落地）
        const n = await this._strict(() => this.rtt.writeDown(0, bytes));
        if (n < bytes.length) toast(`下行缓冲只写进 ${n}/${bytes.length} 字节（固件没在取？）`, 'warn');
      }
      setStatus($('r-err'), '', null);
    } catch (e){ this._err(e); }
  }

  async resetTarget(){
    if (!this.probe){ toast('先连接一个后端', 'warn'); return; }
    if (typeof this.probe.reset !== 'function'){
      toast('当前目标（RISC-V）没有软复位通路：探针的 RISC-V 引擎只管 halt/resume，要复位请按板子上的复位键', 'warn', 7000);
      return;
    }
    const probe = this.probe;
    const generation = this._sessionGen = (this._sessionGen || 0) + 1;
    this.running = false;
    clearTimeout(this.timer); clearTimeout(this._idleTimer); clearTimeout(this._resetTimer);
    try {
      if (this._pollTask) await this._pollTask.catch(() => {});
      if (generation !== this._sessionGen || probe !== this.probe) return;
      const how = await this._strict(() => probe.reset());   // 复位是关键动作 → 严格档
      if (generation !== this._sessionGen || probe !== this.probe) return;
      toast(`已复位目标（${how}），2 秒后重新读取控制块…`, 'ok');
      const g = generation;
      clearTimeout(this._resetTimer);
      this._resetTimer = setTimeout(() => {
        if (g === this._sessionGen && probe === this.probe) this._startRtt().catch(e => this._err(e));
      }, 2000);
    } catch (e){ this._err(e); }
  }

  // ================= ELF =================
  async _loadElf(){
    const f = this._elfInput.files?.[0];
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const sym = findSymbol(buf, '_SEGGER_RTT');
      if (!sym){ toast(`${f.name} 里没有 _SEGGER_RTT 符号（strip 过了？）→ 改用扫描`, 'warn', 6000); return; }
      $('r-addr').value = '0x' + sym.addr.toString(16);
      store.set('rtt.addr', $('r-addr').value);
      toast(`从 ELF 拿到 _SEGGER_RTT = 0x${sym.addr.toString(16)}（${sym.size} B）`, 'ok', 6000);
    } catch (e){ this._err(e); }
  }

  // ================= 统计 / 保存 =================
  _stats(){
    const s = this.stats;
    s.rate = Math.max(0, s.bytes - s.lastBytes) * 2;
    s.hz = Math.max(0, s.polls - s.lastPolls) * 2;
    s.lastBytes = s.bytes; s.lastPolls = s.polls;
    $('r-rate').textContent = fRate(s.rate);
    $('r-hz').textContent = Math.round(s.hz);
    $('r-lost').textContent = s.lost;
    $('r-corrupt').textContent = s.corrupt || 0;
    this._highspeedGate(s.rate);
    const peak = Math.round((this.peak || 0) * 100);
    $('r-full').textContent = `${this.highPolls || 0} 次 / 峰值 ${peak}%`;
    $('r-full').parentElement.title =
      '缓冲水位：RTT 不重传，水位打到 3/4 以上说明目标写速 ≥ 主机读速，可能已有覆盖/丢弃。\n' +
      '（主机读速受调试器限制：OpenOCD RPC 实测约 17 KB/s，WebUSB 会快得多）';
    if (peak >= 75) $('r-full').classList.add('err');
    if (this.paused) $('r-pause').title = '暂停中（数据仍在收，继续后补上）';
    // 记录/落盘期间按钮要一直刷：字节数与"待落盘"量都得看得见（见 recorder.js 的说明）
    if (this.rec.active || this.rec.draining) this._recordBtn();
    /**
     * **零速率诊断**（2026-10 用户现场：报"我测 RTT Viewer，没有速率" —— 界面上只有 0 B/s，
     * 看不出该去查哪儿）。控制块找到了、轮询也在跑，却连着 4 秒一个字节都没有时，把可能的原因写出来；
     * 后来读到数据就自动把这句话收掉（只清自己写的那条，不覆盖别的错误）。
     */
    if (this.running && this.rtt && s.bytes === 0 && !this._zeroHinted && Date.now() - (this._pollT0 || 0) > 4000){
      this._zeroHinted = true;
      const errEl = $('r-err');
      if (errEl && !errEl.textContent){
        setStatus(errEl, '控制块在、轮询也在跑，但 4 秒没读到任何字节：' +
          '① 目标固件没在写 RTT（或没在跑）；② 同一个 RTT 环被别的读者拿走了 —— 本页「RTT 转发」的探针桥在跑就先停它；' +
          '③ 地址是手填的话清空它重扫一次', 'warn');
        this._zeroHintSet = true;
      }
    } else if (this._zeroHintSet && s.bytes > 0){
      this._zeroHintSet = false;
      setStatus($('r-err'), '', null);
    }
    if (!this.stream && !this.rtt && this.probe) $('r-cb').textContent = '查找中…';
  }

  // ================= 高速自动关显示 =================
  /**
   * WebUSB 实测 330KB/s 时渲染必然掉队 —— 先崩的总是显示，字节本身不丢
   * （统计/落文件是全量，MicroLink 固件侧的 g_bytes 对账可以对出来）。
   * 速率 > 100KB/s 自动停渲染，降到 50KB/s 以下才恢复（回滞）；
   * 点状态栏提示可手动恢复（之后不再自动关，直到速率回落后重新武装）。
   */
  static HS_OFF = 100 * 1024;   // 超过 100KB/s 停渲染
  static HS_ON  = 50 * 1024;    // 降到 50KB/s 以下才自动恢复（回滞）

  _highspeedGate(r){
    if (!this.probe && !this.bridge){
      if (this.suppressed) this._setSuppressed(false);
      this.suppManual = false;
      return;
    }
    if (!this.suppressed && !this.suppManual && r > RttView.HS_OFF) this._setSuppressed(true, r);
    else if (this.suppressed && r < RttView.HS_ON){ this._setSuppressed(false); this.suppManual = false; }
  }

  _setSuppressed(on, r = 0){
    if (this.suppressed === on) return;
    this.suppressed = on;
    if (on){
      setStatus($('r-err'), `高速 ${fRate(r)}：渲染已停（收数/记录不受影响）· 点此恢复显示`, 'err');
      $('r-err').title = '点击恢复显示。若速率仍高于阈值会再次自动关闭';
      /**
       * 🚨 **必须在这块区域里也留一行**，不能只改状态栏。
       *    实测踩到：J-Link 高速只读（~1.4MB/s）一接上，用户盯着的终端就"凭空冻住"了 ——
       *    状态栏那句小字没人注意，于是得出"页面一个字节都没收到"的结论（其实 10 秒收了 15MB）。
       *    这里跟下面"恢复显示"时的提示对称：开始停渲染时说明一次，之后一个字都不再写。
       */
      const note = `\r\n[高速 ${fRate(r)}：已停止渲染以省 CPU —— 数据仍在收（统计、计数、记录到文件都照常）· 点状态栏可恢复显示]\r\n`;
      if (this.mode === 'term' && this.term) this._termWrite(new TextEncoder().encode(note), new Date());
      else this.tx.push(new TextEncoder().encode(note), new Date());
    } else {
      setStatus($('r-err'), '', null);
      $('r-err').title = '';
      if (this.suppBytes > 0){
        const note = `（高速期间省略了 ${fBytes(this.suppBytes)} 的渲染；完整数据用「记录到文件」拿）`;
        this.suppBytes = 0;
        if (this.mode === 'term' && this.term) this._termWrite(new TextEncoder().encode(note + '\r\n'), new Date());
        else this.tx.push(new TextEncoder().encode('\r\n' + note + '\r\n'), new Date());
      }
    }
  }

  async _autoStartRecord(){
    try {
      const name = await this.rec.start({ name: 'rtt', timestamps: $('r-record-ts').checked });
      this._recordBtn();
      toast(`已自动开始记录 → ${name}`, 'ok', 5000);
    } catch (e){
      const why = e?.name === 'NotAllowedError' ? '浏览器要求弹保存框时页面正在响应用户点击' : (e?.message || e);
      toast(`自动记录没启动（${why}）。手动点「记录到文件」即可`, 'warn', 6000);
    }
  }

  // ================= 记录到文件 =================
  /**
   * 高速采集时接收区（raw 上限 2MB）存不下 —— 实测 WebUSB 330 KB/s 只要 6 秒就撑爆，
   * 之后「保存数据」只能保存剩下那段。落文件把字节直接写盘，采集多久都不丢。
   */
  async _toggleRecord(){
    if (this.rec.starting || this.rec.draining) return;
    if (this.rec.active || this.rec.needsClose){
      const info = await this.rec.stop();
      this._recordBtn();
      if (info?.error) toast('记录落盘出错：' + (info.error.message || info.error), 'err', 8000);
      else if (info) toast(`已落盘 ${info.name}：${fBytes(info.bytes)} / ${info.frames} 段 / ${info.seconds.toFixed(1)} s —— .crswap 已改名成正式文件`, 'ok', 7000);
      return;
    }
    try {
      const name = await this.rec.start({ name: 'rtt', timestamps: $('r-record-ts').checked });
      this._recordBtn();
      toast(`记录中 → ${name}：Chrome 先写成 ${name}.crswap，点「停止记录」才改名成正式文件（记录中别关页面/刷新）`, 'ok', 8000);
    } catch (e){
      if (e?.name !== 'AbortError') toast('开始记录失败：' + (e?.message || e), 'err', 6000);
    }
  }

  _recordBtn(){
    const b = $('r-record');
    if (!b) return;
    const s = recordButtonState(this.rec);
    b.disabled = this.rec.starting || this.rec.draining;
    b.textContent = s.text;
    b.title = s.title.replace('收到的字节', '读到的 RTT 上行字节');
    b.classList.toggle('primary', s.primary);
  }

  save(){
    let out = '';
    if (this.mode === 'term' && this.term){
      const buf = this.term.buffer.active;
      for (let i = 0; i < buf.length; i++){
        const line = buf.getLine(i);
        out += (line ? line.translateToString(true) : '') + '\n';
      }
    } else {
      out = (this.truncated ? '（较早的数据已因超出上限被丢弃）\n' : '') + this.tx.render(this.records);
    }
    if (!out.trim()){ toast('还没有数据', 'warn'); return; }
    const name = `rtt-${fileStamp()}.txt`;
    download(name, out);
    toast(`已保存 ${name}`, 'ok');
  }
}
