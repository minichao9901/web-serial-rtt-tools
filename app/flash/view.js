/**
 * 烧录器：把 .elf / .hex / .bin 写进目标芯片，可校验、可复位运行。
 *
 * 两种后端：
 *   · WebUSB · 零安装（主通道，与 RTT 同一个探针）：页面解析固件 → 在目标 RAM 里跑
 *     flashloader 算法（flash/algos.js + runner.js）完成擦写 → 读回校验 → 复位运行。
 *     现覆盖 F0/F1/F4/F7/H7/L0/L4；进度条是真实百分比。
 *   · 本地桥 · OpenOCD（备用）：其余系列/特殊需求用，OpenOCD 的 program 一条龙
 *     （rpc 拿不到流式进度，只显示耗时）。
 *
 * 文件两种来源（浏览器不允许页面直接读任意路径，所以并存）：
 *   · 选择文件/拖拽 —— 网页把内容传给烧录逻辑（WebUSB 与桥都可用）；
 *   · 路径输入框 —— 只有桥后端能读（桥在本机直接读文件）。
 *
 * 与 RTT Viewer 复用同一个探针：同一时刻只能有一个占用，开烧前会把在跑的 RTT 会话断开。
 */
import { prepareProbeHandoff } from '../core/probe-users.js';
import { runProbeOperation } from '../core/probe-manager.js';
import { $, setStatus } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { store } from '../core/store.js';
import { CHIPS, fillChipSelect } from '../core/chips.js';
import { BridgeClient } from '../rtt/bridge.js';
import { WebUsbDapProbe, withTimeout } from '../rtt/dap-webusb.js';
import { ALGOS, F1_DEV, checkFlashRange } from './algos.js';
import { HPM_BOARDS, hpmBoard, hpmCheckRange } from './hpm/chips.js';
import { DBGMCU_BASES, FLASH_SIZE_REGS, decodeCpuid, decodeDpIdcode, decodeStm32Dev, refineByFlash, saneFlashKb } from './devid.js';
import { closeProbeUsbDevices } from '../core/probe-bus.js';
import { DapJtagTransport, setOutputModeData, PROBE_OUTPUT_MODE } from './hpm/dap-transport.js';
import { RiscvTransport } from './hpm/riscv-dm.js';
import { HpmFlasher } from './hpm/flash.js';
import { resolveHpmTarget, assertHpmIdentity } from '../targets/hpm/porting.js';
import { selectedHpmBoard, rememberHpmBoard } from '../targets/hpm/select.js';
import { AkaLinkHid } from '../hid/probe.js';
import { FlashRunner } from './runner.js';
import { parseFirmware } from './image.js';
import { bytes as fBytes } from '../core/format.js';
import { waitMs } from '../core/pace.js';
import { pickCfgs } from '../ui/cfgpicker.js';

export class FlashView {
  constructor(){
    this.bc = null;
    this.probe = null;
    this.file = null;          // { name, size, dataB64 } —— 「选择文件/拖拽」时有效
    this.busy = false;
    this.bus = null;           // 跨页签探针协调（main.js 注入；见 core/probe-bus.js）
    this._statusText = '';     // 心跳用：当前状态文字与它的起始时刻
    this._statusKind = '';
    this._statusT0 = Date.now();
    this._hb = null;
  }

  init(){
    fillChipSelect($('f-chip'));
    store.bind($('f-backend'), 'flash.backend');
    store.bind($('f-chip'), 'flash.chip');
    store.bind($('f-bridge-url'), 'flash.bridgeUrl');
    store.bind($('f-path'), 'flash.path');
    store.bind($('f-base'), 'flash.base');
    store.bind($('f-verify'), 'flash.verify', 'checked');
    store.bind($('f-reset'), 'flash.reset', 'checked');
    $('f-chip').addEventListener('change', () => { rememberHpmBoard($('f-chip').value); this._applyChip(); });
    this._applyChip();
    // 「选择…」：列出桥所在机器的 OpenOCD cfg 让你挑（浏览器拿不到本地文件路径，列表只能由桥给）
    $('f-cfgs-pick').addEventListener('click', async () => {
      const v = await pickCfgs({
        bridgeUrl: $('f-bridge-url').value,
        current: $('f-cfgs').value,
        title: '选择 OpenOCD cfg（烧录器用）',
      });
      if (v !== null){ $('f-cfgs').value = v; store.set('flash.cfgs', v); }
    });

    // ---------- 固件文件 ----------
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = '.elf,.hex,.bin,.axf,.out';
    this._fileInput.style.display = 'none';
    this._fileInput.addEventListener('change', () => {
      const f = this._fileInput.files?.[0];
      this._fileInput.value = '';                     // 允许重复选同一个文件
      this._onFile(f);
    });
    document.body.appendChild(this._fileInput);
    $('f-pick').addEventListener('click', () => this._fileInput.click());
    $('f-path').addEventListener('input', () => { this.file = null; this._fileInfo(); });
    const drop = $('f-log');
    drop.addEventListener('dragover', e => e.preventDefault());
    drop.addEventListener('drop', e => { e.preventDefault(); this._onFile(e.dataTransfer?.files?.[0]); });
    this._fileInfo();

    $('f-flash').addEventListener('click', () => this.flash().catch(e => this._err(e)));
    /* 「读 IDCODE」：只读地认目标（不动 flash、不改运行状态）。用 `?.` —— 页面混版时可能还没这个按钮，
     * 别让 init 挂在这儿（2026-10 那次白屏的教训）。 */
    $('f-idcode')?.addEventListener('click', () => this.readIdcode().catch(e => this._err(e)));
    $('f-logclear').addEventListener('click', () => { $('f-log').textContent = ''; });
    this._status('空闲');
  }

  // ================= 文件 =================
  async _onFile(f){
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      this.file = { name: f.name, size: f.size, dataB64: this._b64(new Uint8Array(buf)) };
      $('f-path').value = '';
      store.set('flash.path', '');
      this._fileInfo();
      toast(`已读入 ${f.name}（${fBytes(f.size)}），点「烧录」写入`, 'ok', 4000);
    } catch (e){
      toast(`读文件失败：${e?.message || e}`, 'err');
    }
  }

  /** Uint8Array → base64（分块，避免 String.fromCharCode 爆栈） */
  _b64(u8){
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
    return btoa(s);
  }

  _fileInfo(){
    const p = String($('f-path').value || '').trim();
    const cur = this.file ? this.file.name : p;
    const el = $('f-file-info');
    if (this.file) el.textContent = `已选择：${this.file.name}（${fBytes(this.file.size)}）`;
    else if (p) el.textContent = `将用桥所在电脑上的路径：${p}（仅「本地桥」后端可读路径）`;
    else el.textContent = '支持 .elf / .hex / .bin：点「选择文件…」或拖进右侧日志区；填路径仅「本地桥」后端支持';
    $('f-base-row').hidden = !/\.bin$/i.test(cur);
  }

  onShow(){
    if (!this.probe && !this.busy && hpmBoard($('f-chip')?.value)) {
      $('f-chip').value = selectedHpmBoard(); store.set('flash.chip', $('f-chip').value); this._applyChip();
    }
  }

  _applyChip(){
    const custom = $('f-chip').value === 'custom';
    $('f-custom-cfgs-row').hidden = !custom;
    $('f-custom-speed-row').hidden = !custom;
  }
  // ================= 烧录 =================
  /** Managed acquisition already released conflicts; standalone views use the same adapters. */
  async _clearProbeUsers(name){
    const r = await prepareProbeHandoff(this, 'flash', `烧录器要使用探针 ${name || ''}`.trim());
    if (r){
      if (r.asked) this._log(`跨页签协调：请 ${r.asked} 个其他页签让出探针，${r.acked} 个确认（等了 ${r.ms} ms）`
        + (r.ghosts ? `；其中 ${r.ghosts} 个已经不在（关掉的页签/被浏览器冻结），以后不再等它们` : ''));
      else this._log('跨页签协调：没有其他页签在用探针');
    }
    /**
     * 🚨 本页签自己有没有"僵尸连接"也要清：上一次烧录中途失败、RTT/J-Scope 会话被 reset 掉线……
     *    这些情况下视图早就"断开"了，但那个 USBDevice 只是丢了引用、没 close()，
     *    接口认领会僵在那儿（`Unable to claim interface`，reset 也没用）——实测补一次 close() 立刻就好。
     */
    const closed = await closeProbeUsbDevices();
    if (closed) this._log(`已关掉本页签 ${closed} 个探针 USB 句柄（残留认领会挡住这次烧录）`);
    return true;
  }

  async flash(){
    if (this.busy) return;
    if (!this.file && !String($('f-path')?.value || '').trim()) return await this._flashOnce();
    return await this._withProbeOwnership(() => this._flashOnce(), '烧录器要使用探针');
  }

  /** Flash and identification share reservation, retry cleanup and button state. */
  async _withProbeOwnership(fn, reason){
    this.busy = true;
    for (const id of ['f-flash', 'f-idcode']) if ($(id)) $(id).disabled = true;
    try {
      return await runProbeOperation(this, 'flash', async () => {
        // Retry the retained close before opening another native handle.
        if (this._probeCloseFailed) await this._closeProbe();
        return await fn();
      }, { reason, recovery: true });
    } finally {
      this.busy = false;
      if (!this._probeCloseFailed && !this.probeManager?.failures.has('flash')) this.probeManager?.forget('flash');
      for (const id of ['f-flash', 'f-idcode']) if ($(id)) $(id).disabled = false;
    }
  }

  async _closeProbe(operationError = null){
    const probe = this.probe;
    if (!probe) return;
    try { await probe.disconnect(); }
    catch (e){
      this._probeCloseFailed = true;
      this.probeManager?.fail('flash', e);
      if (operationError) throw new AggregateError([operationError, e],
        `${operationError.message}；探针关闭失败：${e.message}`);
      throw e;
    }
    this.probe = null;
    this._probeCloseFailed = false;
    this.probeManager?.confirm('flash');
  }

  async _flashOnce(){
    const pathText = String($('f-path').value || '').trim();
    const usePath = !this.file && !!pathText;
    if (!this.file && !pathText){ toast('先指定固件：点「选择文件…」或填路径', 'warn'); return; }
    // 零安装模式读不了磁盘路径（浏览器安全限制）——但别直接报错挡住用户：
    // 只给了路径时**自动改用本地桥**，并明确写一行日志说明为什么换了后端。
    if (usePath && $('f-backend').value === 'webusb'){
      $('f-backend').value = 'openocd';
      this._log('只给了磁盘路径：零安装（WebUSB）在后端读不了本地文件 → 自动改用「本地桥 · OpenOCD」。' +
                '想用零安装，请点「选择文件…」把固件选进来。');
    }
    const name = this.file ? this.file.name : pathText;

    // 探针互斥：同页签的 RTT / J-Scope 会话先断开，再请别的页签让出探针
    if (!(await this._clearProbeUsers(name))) return;

    const t0 = Date.now();
    const timer = setInterval(() => {
      if ($('f-bar').hidden) this._status(`烧录中… 已耗时 ${((Date.now() - t0) / 1000) | 0}s`);
    }, 500);
    this._hbStart();
    let operationError;
    try {
      if ($('f-backend').value === 'webusb'){
        await this._flashWebusb(name);
      } else {
        await this._flashBridge(name, pathText);
      }
      this._status(`空闲（上次烧录用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    } catch (e){
      operationError = e;
      this._status('空闲');
      setStatus($('f-result'), `❌ ${e?.message || e}`, 'err');
      /**
       * 失败也要复位目标（ARM 路径的老经验：flashloader 可能已写进目标 RAM，踩掉 RTT 控制块等数据）。
       *
       * 🚨 **但 HPM / RISC-V 路径绝不能拉 nRESET**（2026-10 定因，也是"越失败越不对劲"的真凶）：
       *    akaLinkPro 的板级配置写着 `reset_config none`，注释原文：
       *    「Do NOT use the SRST pin: 20 针排线的第 15 脚是**探针自己的 RESET_N**，
       *      拉 nSRST 会把探针一起复位（observed as OpenOCD hanging and the probe dropping off USB）」
       *    我们原来不分路径都拉一次 `probe.reset()` → 烧录一失败就把探针打掉线，
       *    之后所有命令响应错位（实测 `响应回显 0x3 ≠ 命令 0x0`、`DAP_JTAG_Sequence 0xff`、USB 读超时），
       *    "再点一次"也很难成功 —— 而**紧接着用 OpenOCD 打同一块板 4.9 s 就过**（人家是干净会话）。
       *    RISC-V 侧要复位目标请走 DM 的 ndmreset —— `flasher.recoverAfterFailure()` 已经做了。
       */
      let isHpm = false;
      try { isHpm = !!hpmBoard($('f-chip').value); } catch {}
      if (isHpm){
        this._log('（HPM/RISC-V：跳过 nRESET 脉冲 —— 那根线会复位探针自己；目标已用 DM 的 ndmreset 复位）');
      } else {
        // 先试 nRESET 脉冲；不行再试 AIRCR 软复位（很多接线根本没把 NRST 连到探针）。
        try { if (this.probe) await this.probe.reset(); }
        catch { try { if (this.probe) await this.probe.sysReset(); } catch {} }
      }
      throw e;
    } finally {
      this._hbStop();
      clearInterval(timer);
      /**
       * 🚨 **烧完必须把探针还回去**（成功失败都要）。
       *    烧录器是另开一个 WebUsbDapProbe 会话的；不释放的话接口一直被占着 ——
       *    现象：烧录失败后 RTT 连不上、再点一次烧录报「占用 USB 接口失败」，
       *    用户只能刷新页面才好（实测就是这么个坑）。
       */
      await this._closeProbe(operationError);
    }
  }

  // ================= 读目标身份（IDCODE） =================

  /** 打开一个探针会话（读身份用；与烧录那条路同样的超时纪律，见 _flashWebusb 的注释）*/
  async _openProbeForRead(opts = {}){
    let auth;
    try {
      auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
    } catch (e){
      throw new Error(`${e.message} —— 浏览器 USB 服务可能被上一次中断的会话卡住了：刷新页面（或拔插一次探针）再试`);
    }
    const probe = auth.length
      ? await withTimeout(WebUsbDapProbe.open(auth[0], opts), 15000, '连接探针（WebUSB）')
      : await withTimeout(WebUsbDapProbe.request(false, opts), 60000, '等你在浏览器里选探针');
    probe.onLog = s => this._log('   [usb] ' + s);
    probe.fast = false;
    return probe;
  }

  /**
   * 「读 IDCODE」：只读地把目标身份读出来 —— **不动 flash、不改目标的运行状态**。
   *
   *   · ARM/SWD（零安装）：DP IDCODE → CPUID → STM32 DBGMCU DEV_ID/REV_ID → flash 容量寄存器
   *   · RISC-V/JTAG（HPM 那条路）：TAP IDCODE
   *
   * 🚨 每一笔读都带**短超时 + 容错**：认身份必然要碰"这块芯片上没映射"的地址
   *    （H7 没有 0xE0042000、F1 没有 0x1FFF7A22…），读不到就跳过 —— 绝不能让一笔读把整轮拖死
   *    （WebUSB 的挂起传输会把浏览器的 USB 服务搞脏，那时 getDevices() 会永远不返回）。
   *    读的**顺序按价值排**：DP IDCODE / CPUID 在最前，后面对不上也已经有结论。
   */
  async readIdcode(){
    if (this.busy){ this._err(new Error('正在忙（烧录 / 读身份）—— 等它跑完再点')); return; }
    return await this._withProbeOwnership(() => this._readIdcodeOnce(), '读取目标身份');
  }

  async _readIdcodeOnce(){
    const t0 = Date.now();
    let operationError;
    try {
      if (!(await this._clearProbeUsers('读取目标身份'))) return;
      const isRv = HPM_BOARDS.some(b => b.id === $('f-chip').value);
      this._log('');
      this._log(`──── 读目标身份（${isRv ? 'RISC-V/JTAG' : 'ARM/SWD'} · 零安装）────`);
      if (isRv) await this._idcodeRiscv();
      else await this._idcodeArm();
      this._log(`──── 读完（${Date.now() - t0} ms）────`);
    } catch (e){
      operationError = e;
      throw e;
    } finally {
      await this._closeProbe(operationError);
    }
  }

  async _idcodeArm(){
    this._status('读 IDCODE（SWD）…');
    this.probe = await this._openProbeForRead({ clockKhz: 1000 });
    const p = this.probe;
    const rd = async (addr, len, apIndex = 0) => {
      try { return await withTimeout(p.readMem(addr, len, apIndex), 1500, `读 0x${addr.toString(16)}`); }
      catch (e){ this._log(`   （0x${addr.toString(16)}${apIndex ? ` AP${apIndex}` : ''} 读失败：${e?.message || e} —— 跳过）`); return null; }
    };
    const word = b => (b && b.length >= 4) ? ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0) : null;
    const half = b => (b && b.length >= 2) ? (b[0] | (b[1] << 8)) : null;
    const hx = v => '0x' + (v >>> 0).toString(16).toUpperCase();

    // ① DP IDCODE —— open() 协商 SWD 时钟时已经读过（SWD 激活后第一笔必须是它）
    this._log('   ① DP IDCODE  ' + decodeDpIdcode(p.idcode >>> 0).text);

    // ② CPUID：认内核
    const cpuid = word(await rd(0xe000ed00, 4));
    const cp = (cpuid != null) ? decodeCpuid(cpuid) : null;
    this._log('   ② CPUID      ' + (cp ? cp.text : '读不到（0xE000ED00 是 Cortex-M 的标配地址，读不到多半不是 M 核）'));

    /**
     * ③ STM32 DBGMCU：**DEV_ID 才认得出型号**（IDCODE/CPUID 都认不出）。
     *    候选地址逐个试，**每个都把原始值打出来**（哪怕是 0 / 全 1）—— "读回来是 0"和"读不动"
     *    是两种完全不同的故障，不给原始值就没法判断（这轮就是这么找出来的）。
     *    一个地址都不认时再退到 AP1 试一遍：H7 的 D3 域调试口有时要经 APB-AP 才够得着。
     */
    let dev = null;
    const tried = [];
    const probeDev = async (apIndex) => {
      for (const base of DBGMCU_BASES){
        const w = word(await rd(base, 4, apIndex));
        if (w == null){ tried.push(`${hx(base)}${apIndex ? ' AP' + apIndex : ''}=读失败`); continue; }
        const d = decodeStm32Dev(w & 0xfff, w >>> 16);
        tried.push(`${hx(base)}${apIndex ? ' AP' + apIndex : ''}=${hx(w)}`);
        if (d.devId && d.devId !== 0xfff){
          dev = d;
          this._log(`   ③ DBGMCU     ${hx(base)}${apIndex ? `（AP${apIndex}）` : ''} = ${hx(w)} → ${d.text}`);
          return true;
        }
      }
      return false;
    };
    if (!await probeDev(0)) await probeDev(1);
    if (!dev) this._log(`   ③ DBGMCU     都不认：${tried.join(' · ')}（不是 STM32 / 该系列地址不在这三处 / PPB 访问没通）`);

    // ④ flash 容量寄存器（16 位、单位 KB）—— 同样把原始值带上；H7 那类先 AP0 再 AP1 试
    let kb = null;
    const triedKb = [];
    for (const apIndex of [0, 1]){
      for (const r of FLASH_SIZE_REGS){
        const v = half(await rd(r.addr, 2, apIndex));
        const tag = `${hx(r.addr)}${apIndex ? ' AP' + apIndex : ''}=` +
                    (v == null ? '读失败' : (saneFlashKb(v) ? `${v}KB` : `${hx(v)}（无效）`));
        triedKb.push(tag);
        if (v == null || !saneFlashKb(v)) continue;
        kb = v;
        this._log(`   ④ flash 容量 ${hx(r.addr)}${apIndex ? `（AP${apIndex}）` : ''} = ${v} KB（${r.fam} 的容量寄存器）`);
        break;
      }
      if (kb != null) break;
    }
    if (kb == null) this._log(`   ④ flash 容量 都不认：${triedKb.join(' · ')}`);

    // ⑤ 结论：DEV_ID 认家族，flash 容量再收窄一步（0x480 + 128 KB ⇒ H7B0 那种）
    const bits = [];
    if (dev?.known) bits.push(refineByFlash(dev.devId, kb) || dev.entry.name);
    if (cp?.core) bits.push(cp.core);
    if (kb) bits.push(`${kb} KB flash`);
    const dpKind = decodeDpIdcode(p.idcode >>> 0).kind;
    if (dpKind) bits.push(dpKind);
    this._log(bits.length
      ? `   ⇒ 判读：${bits.join(' · ')}`
      : '   ⇒ 只确认了「SWD 通、对端是 ARM 的 DP」，型号认不出（用上面那几个原始值去对 ST 的 RM）');
  }

  async _idcodeRiscv(){
    this._status('读 IDCODE（JTAG）…');
    // 与 HPM 烧录同一条路的前半段：HID 切 output_mode=SWD+JTAG → 让探针自己的 RISC-V 引擎放掉 TAP。
    // ⚠️ 这里**不**去停 RTT 桥（HID 0x31）—— 只是读个 IDCODE，别把用户正在跑的转发会话掐了。
    try {
      const hid = new AkaLinkHid();
      await withTimeout(hid.reconnect(), 8000, '连探针 HID');
      await withTimeout(hid.xfer(0x02 /* CMD_SET_CONFIG */, setOutputModeData(PROBE_OUTPUT_MODE.SWD_JTAG)), 3000, '切输出模式');
      this._log('   已把探针切到 SWD+JTAG（HID 0x02，每次都要发）');
      try {
        await withTimeout(hid.xfer(0x33, Uint8Array.of(0)), 2500, '让 RISC-V 引擎放掉 TAP');
        this._log('   已请求 RISC-V 引擎放掉 TAP（HID 0x33 action 0）');
      } catch { this._log('   （0x33 无响应，可能本来就空闲）'); }
      try { await hid.close(); } catch {}
    } catch (e){
      this._log('   ⚠ 切 output_mode 失败（继续试 JTAG）：' + (e?.message || e));
    }

    this.probe = await this._openProbeForRead({ skipTargetInit: true });   // 必须跳过按 SWD 协商那套
    const port = resolveHpmTarget($('f-chip').value);
    const jtag = new DapJtagTransport(this.probe, { irLength: port.debug.irLength, log: l => this._log('   ' + l) });
    const dm = new RiscvTransport(jtag, { port, log: l => this._log('   ' + l) });
    const info = await dm.init();
    const known = info.idcode === port.debug.tapIdcode;
    this._log(`   TAP IDCODE 0x${info.idcode.toString(16).toUpperCase()} → ${known ? 'HPM 全系（IR 长度 5，HPM6800/HPM5300…）' : '不在已知表里'}`);
    this._log(`   dmstatus 0x${info.dmstatus.toString(16)} · dtmcs 0x${info.dtmcs.toString(16)}`);
    this._log(known ? '   ⇒ 判读：RISC-V 调试模块（DM）应答了，JTAG 链路正常'
                    : '   ⇒ TAP 能读但不是 HPM 的 IDCODE —— 接线 / 上电 / 器件选型看一眼');
  }

  // ---------- 主通道：WebUSB 零安装 ----------
  async _flashWebusb(name){
    /**
     * 分段计时：每一步各花多久，收尾时写一行「耗时小结」。
     * 为什么值得记：用户报「烧录很慢」时，日志里只有寥寥几行，**看不出慢在哪一步** ——
     * 有一次实测的真凶（页面不可见时浏览器把短延时钳到 1 s，见 core/pace.js）
     * 就是靠"USB 往返总共只要 0.3 s、而整轮 47 s"这个对比才锁定的。
     */
    const t0 = Date.now();
    let tPrev = t0;
    const parts = [];
    const lap = k => { const now = Date.now(); parts.push(`${k} ${now - tPrev}ms`); tPrev = now; };
    const chip = $('f-chip').value;
    // RISC-V（HPM 系列）走另一条路：目标核不是 Cortex-M，烧录算法也不是 ARM 的 flashloader
    if (HPM_BOARDS.some(b => b.id === chip)) return await this._flashHpmRiscv(name);
    const algo = ALGOS[chip];
    if (!algo) throw new Error(`「${chip}」暂未内置零安装烧录算法（现覆盖 F0/F1/F4/F7/H7/L0/L4 与 HPM 系列 RISC-V）：请换「本地桥 · OpenOCD」后端`);

    // 解析固件（webusb 只吃页面里选的文件）
    const raw = Uint8Array.from(atob(this.file.dataB64), c => c.charCodeAt(0));
    const base = Number($('f-base').value) || 0;
    const regions = parseFirmware(name, raw, base);
    const total = regions.reduce((s, r) => s + r.data.length, 0);

    // 探针：复用已授权的（不弹框），没有才弹浏览器选择框。
    // 烧录强制 1MHz：flashloader 执行依赖 PPB（调试寄存器）访问，实测本探针固件
    // 在高时钟下 PPB 访问不可靠（读回 0），RTT 那种纯 RAM 访问则 8MHz 没问题。
    //
    // 🚨 每一步都必须带超时：WebUSB 的挂起传输会把浏览器的 USB 服务搞脏，
    //    那时 `navigator.usb.getDevices()` 会**永远不返回**（实测卡 90 秒以上、界面看着像死了，
    //    连 RTT 那边也一起连不上）。宁可 5 秒报错让用户刷新/拔插，也不要无声卡死。
    let auth;
    try {
      auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
    } catch (e){
      throw new Error(`${e.message} —— 浏览器 USB 服务可能被上一次中断的会话卡住了：刷新页面（或拔插一次探针）再试`);
    }
    this.probe = auth.length
      ? await withTimeout(WebUsbDapProbe.open(auth[0], { clockKhz: 1000 }), 15000, '连接探针（WebUSB）')
      : await withTimeout(WebUsbDapProbe.request(false, { clockKhz: 1000 }), 60000, '等你在浏览器里选探针');
    // USB 层的每次"自救"（复位端口、清队列、丢陈旧包）都写进页面日志 —— 卡住时才有据可查
    this.probe.onLog = s => this._log('   [usb] ' + s);
    // 烧录走**严格档**：flashloader 靠状态位判断算法是否跑完，读错=校验失败；
    // 每页写同一个 RAM 缓冲，写后必须回读把 posted 写逼落地（对照 rtt/view.js 的快速档）
    this.probe.fast = false;

    const verify = $('f-verify').checked;
    const doReset = $('f-reset').checked;
    const runner = new FlashRunner(this.probe);
    lap('探针');
    this._log(`── 零安装烧录：${this.file.name}（${fBytes(total)}）→ ${chip} ──`);
    this._bar(1);
    /**
     * 🚨 开烧之前**先复位一次目标**。
     *    烧录会先把向量表所在的扇区擦掉，此时若中断进来内核就进 **LOCKUP**；
     *    而 LOCKUP 一旦进入就出不来（DHCSR.C_HALT 清不掉，只能复位）。
     *    上一次被中断的烧录留下的 LOCKUP 会让这一次连"让目标跑起来"都做不到
     *    （报「无法让目标继续运行」）。复位是最便宜、最干净的入场券。
     */
    this._status('复位目标（清掉上一次可能留下的 LOCKUP）…');
    try { await this.probe.sysReset(); } catch (e){ this._log('软复位失败（继续试）：' + (e?.message || e)); }
    this._status('加载 flashloader 到目标 RAM…');
    await runner.load(algo);
    lap('加载算法');

    /**
     * 🚨 **擦除粒度必须问芯片，不能照抄算法表。**
     *    `algos.js` 的 `page_size` 在本工程就是"擦除粒度"（runner 按它步进 erase_sector），
     *    而 F1 那份是按**大容量**（256~512KB，2KB/页）填的。中容量（DEV_ID 0x410，例如
     *    128KB 的 F103C8/CB）的页是 **1KB** —— 按 2KB 步进擦只会擦到第 0、8、16… 页，
     *    `0x400~0x7FF` 这些页**根本没擦过**；接着往未擦除区域编程 → F1 报 PGERR →
     *    flashloader 返回码 1（界面显示"擦写失败或地址/参数不对"）。
     *    2026-09 实测现场：独立校验显示 flash 从 **0x08000400** 起全是旧数据（第一页之后全错），
     *    用 OpenOCD 按 1KB 粒度补擦那几页后，同一份固件立刻烧录成功且逐字节一致。
     *    所以这里读 DBGMCU_IDCODE(0xE0042000) 的 DEV_ID 定粒度（与 OpenOCD 的 stm32f1x 同款做法）。
     *    只对认得出的 STM32F1 生效，其它芯片一律按算法表来（不动）。
     */
    let pageSize = algo.page_size;
    this._devId = null;
    try {
      const idb = await this.probe.readMem(0xE0042000, 4);
      const devId = (idb[0] | (idb[1] << 8)) & 0xfff;
      const info = F1_DEV[devId];
      if (info){
        pageSize = info.page;
        this._devId = devId;                // 顺带把容量上限也定下来（比系列最大值准）
        if (info.page !== algo.page_size){
          this._log(`芯片 DEV_ID=0x${devId.toString(16)}（STM32F1 ${info.name}）→ 擦除粒度按 ${info.page}B/页，`
            + `不是算法表里的 ${algo.page_size}B（差这一档会让没擦到的页编程失败）`);
        }
      }
    } catch (e){ /* 读不到就按算法表来 */ }
    lap('读DEV_ID');

    // 擦：覆盖固件的那些扇区
    let erased = 0, eraseTotal = 0;
    for (const seg of regions) this._checkRange(seg, algo);
    for (const seg of regions){
      const ps = pageSize;          // 芯片实际粒度（见上面 DEV_ID 判定），不是 algo.page_size
      for (let a = algo.flash_start + Math.floor((seg.addr - algo.flash_start) / ps) * ps;
           a < seg.addr + seg.data.length; a += ps){
        eraseTotal++;
      }
    }
    for (const seg of regions){
      const ps = pageSize;          // 芯片实际粒度（见上面 DEV_ID 判定），不是 algo.page_size
      for (let a = algo.flash_start + Math.floor((seg.addr - algo.flash_start) / ps) * ps;
           a < seg.addr + seg.data.length; a += ps){
        await runner.eraseSector(a);
        erased++;
        this._bar(1 + (erased / eraseTotal) * 29);
        this._status(`擦除扇区 ${erased}/${eraseTotal}（0x${a.toString(16)}）…`);
      }
    }

    // 写：按缓冲块大小分块，数据进 RAM 缓冲 → 算法搬进 flash
    let written = 0;
    lap('擦除');
    const chunk = runner.chunkSize();
    for (const seg of regions){
      for (let off = 0; off < seg.data.length; off += chunk){
        let page = seg.data.subarray(off, Math.min(off + chunk, seg.data.length));
        /**
         * 尾部补 0xFF 到**编程粒度**的整数倍。
         * 🚨 粒度不是处处都等于 4：F1/F4 这类按字（4B）写就行，但 **H7 是按 32 字节
         *    （256 位 flash word）编程**的 —— 尾块不补齐到 32 字节，算法那一页就写不进去，
         *    现象是"校验失败、某个地址读到 0xFF/旧值"。粒度由 algos.js 的 write_granularity 给。
         */
        const gran = algo.write_granularity || 4;
        if (page.length % gran){
          const pad = new Uint8Array(((page.length + gran - 1) / gran | 0) * gran);
          pad.set(page);
          pad.fill(0xff, page.length);
          page = pad;
        }
        await runner.programPage(seg.addr + off, page);
        written += page.length;
        this._bar(30 + (written / total) * 60);
        this._status(`写入 ${fBytes(written)} / ${fBytes(total)}（0x${(seg.addr + off).toString(16)}）…`);
      }
    }

    lap('写入');

    // 校验：读回逐字节比对
    if (verify){
      this._status('校验（读回比对）…');
      this._bar(90);
      for (const seg of regions){
        /**
         * 🚨 用「连读一致才认」的稳定读，而不是单次 readMem：
         *    这颗探针的 AP 读是**挂起读**（读回上一笔事务的数据），紧跟算法写 flash 之后
         *    的第一遍读常常整段是旧值 —— 实测就出现过"读到 0x0、期望 0xe7"，而 flash 里
         *    其实写对了（用裸客户端读同一个地址是正确的）。读两次一致才认，读不可靠时不会误报。
         */
        const rb = await this._readStable(seg.addr, seg.data.length);
        for (let i = 0; i < seg.data.length; i++){
          if (rb[i] !== seg.data[i]){
            throw new Error(`校验失败：0x${(seg.addr + i).toString(16)} 处读到 0x${rb[i].toString(16)}，期望 0x${seg.data[i].toString(16)}`);
          }
        }
      }
      this._bar(99);
    }
    lap('校验');

    if (doReset){
      /**
       * 🚨 这里必须用**系统复位**（AIRCR.SYSRESETREQ），不能只拉 nRESET 引脚：
       *   · 很多接线（本机这块 F103 就是）根本没把 NRST 连到探针，拉引脚等于没复位；
       *   · 更要命的是跑 flashloader 前我们调过 maskInterrupts()，把目标的 SysTick/NVIC
       *     关掉了。不复位的话固件"能跑但不打印"—— 现象是 RTT 连得上、控制块也对，
       *     却一个字节都不来（自测里的「等待超时：ch0 数据」就是这么来的）。
       *   系统复位会把外设/SysTick 全部初始化回正常状态。
       */
      this._status('复位运行…');
      try { await this.probe.sysReset(); }
      catch (e){ this._log('软复位失败，退回 nRESET 脉冲：' + (e?.message || e)); await this.probe.reset(); }
      // 复位之后**必须让核真的跑起来**，并顺手看一眼它到底在哪儿取指
      try { await this.probe.run(); } catch { /* 让它跑失败也不影响烧录结果 */ }
      try { await this._bootCheck(regions, algo); } catch { /* 诊断失败绝不影响烧录结论 */ }
    }
    lap('复位');
    this._bar(100);
    this._log('── 完成 ──');
    /**
     * 「耗时小结」：一行看清每一步各花了多久。
     * 🚨 本页不可见时，浏览器会给定时器限速（短延时被钳到 ≥1 s）—— 烧录流程已经不靠定时器
     *    等待（见 core/pace.js），但别的后台活儿仍可能被拖慢，所以这里如实标一句。
     */
    this._log(`耗时小结：${parts.join(' · ')} · 合计 ${((Date.now() - t0) / 1000).toFixed(2)}s`
      + (this._hb?.hiddenTicks ? '（⚠ 期间本页不可见：浏览器对后台页有定时器限速，别把"慢"都算到探针头上）' : ''));
    setStatus($('f-result'),
      `✅ ${chip} · ${fBytes(total)}${verify ? ' · 校验通过' : ''}${doReset ? ' · 已复位运行' : ''}`, 'ok');
    toast('烧录成功', 'ok', 5000);
  }

  /**
   * 复位之后核**到底在哪儿取指**？——把"烧完没反应"变成一句能照做的提示。
   *
   * 🚨 为什么值得单独看一眼（2026-10 真机走查，STM32F103ZE）：
   *    那次复位后内核进的是**系统存储区的 ROM bootloader**，flash 里的固件根本不会被取指 ——
   *    但烧录这边一切正常（擦写读回校验全过），页面于是报告"✅ 已复位运行"，
   *    用户看到的是"烧成功了，板子一动不动"。
   *    现场取证：`VTOR=0`（地址 0 别名到系统存储区，里面是 `200001fc 1ffff021` 那对 ROM 向量），
   *    PC 停在 0x1ffff3xx 的 ROM 轮询循环里、PRIMASK=1 —— 连 SysTick 都进不去，
   *    所以"RTT 不来、波形不动"这类现象都会跟着出现。
   *    ⚠️ 那次的实际原因是**板子没接电源**（BOOT0 悬空被读成高电平，芯片只靠探针供电）——
   *    所以提示里必须把"先确认板子有电"放在第一条，别一上来就让人去拆跳线。
   */
  async _bootCheck(regions, algo){
    // ⚠️ 读 PC 必须**先把核停住**：DCRSR/DCRDR 只对 halt 状态的核有效，
    //    运行中读会一直等不到 S_REGRDY，最后拿到 0（本机实测：PC=0x0，等于什么也没说）。
    await this.probe.halt();
    const pc = (await this.probe.regRead(15)) >>> 0;
    await this.probe.run();                       // 读完立刻放它跑
    const inFlash = regions.some(s => pc >= (s.addr >>> 0) && pc < ((s.addr + s.data.length) >>> 0));
    const sysMem = pc >= 0x1fff0000 && pc < 0x20000000;
    this._log(`复位后 PC=0x${pc.toString(16)}` + (inFlash ? '（在刚烧进去的固件里 ✓）' : sysMem ? '（⚠ 在系统存储区）' : ''));
    if (sysMem){
      const vtor = await this.probe.readMem(0xE000ED08, 4).catch(() => null);
      const v = vtor ? (vtor[0] | (vtor[1] << 8) | (vtor[2] << 16) | (vtor[3] << 24)) >>> 0 : null;
      this._log('⚠⚠ 复位后内核跑的是系统存储区的 ROM bootloader，不是刚烧进去的固件 —— ' +
        '现象就是"提示烧录成功、板子却一动不动"（RTT 不来、波形不动都是这么来的）。');
      this._log('   启动模式落在了系统存储器（BOOT0=1 且 BOOT1=0）。两种常见情况：' +
        '① 板子没接自己的电源，BOOT0 悬空被读成高电平（本机实测就是这一条：只靠探针供电时必然这样）；' +
        '② 板上 BOOT0 跳线/电阻真的把它拉高了。' +
        (v != null ? `　现场证据：VTOR=0x${v.toString(16)}（应指向 flash 的 0x${(algo.flash_start >>> 0).toString(16)} 向量表）` : ''));
      this._log('   怎么办：先确认板子接了自己的电源，再上电/按复位试一次；' +
        '如果还进 ROM，就把 BOOT0 跳到 0（或接地）后上电。烧录本身没问题，不需要重烧。');
    }
  }

  /**
   * 稳定读：连续两次读到的内容完全一致才认（最多 5 轮）。
   * 专治这颗探针的「挂起读」——紧跟写操作之后的第一遍读拿到的是上一笔事务的数据。
   * ⚠️ 只用于**静态**数据（flash 校验）：RTT 之类的动态内存本来就会变，别用它。
   */
  async _readStable(addr, len){
    let prev = await this.probe.readMem(addr, len);
    for (let i = 0; i < 4; i++){
      const cur = await this.probe.readMem(addr, len);
      if (cur.length === prev.length){
        let same = true;
        for (let j = 0; j < cur.length; j++){ if (cur[j] !== prev[j]){ same = false; break; } }
        if (same) return cur;
      }
      prev = cur;
      await waitMs(20);          // 真实 20 ms（用 setTimeout 会被后台节流钳成 1 s，见 core/pace.js）
    }
    this._log('（提示：校验读连续 5 轮都不一致，可能是读不可靠或目标在动）');
    return prev;
  }

  _checkRange(seg, algo){
    const series = $('f-chip').value;
    const r = checkFlashRange(algo, seg, { series, devId: this._devId });
    if (!r.ok){
      const lim = r.limitBytes;
      throw new Error(`固件地址 0x${seg.addr.toString(16)}…0x${(seg.addr + seg.data.length).toString(16)} 超出 `
        + `${series} 的 flash 范围（0x${algo.flash_start.toString(16)} 起 ${fBytes(lim)}`
        + `${this._devId ? `，按芯片 DEV_ID=0x${this._devId.toString(16)} 判的` : ''}）—— 芯片选对了吗？`
        + `（要放宽就选对芯片型号，或改 algos.js 里的 SERIES_MAX_KB）`);
    }
    // 越过算法自带标称区间只是**提示**：pyOCD 那份常按系列最小成员填（F4 = 64KB），
    // 硬拦会拒掉合法固件；真超了芯片自己会在编程时报错。
    if (r.beyondNominal){
      this._log(`提示：固件末端 0x${(seg.addr + seg.data.length).toString(16)} 越过算法表标称的 `
        + `${fBytes(algo.flash_length)}（算法自带区间，常按系列最小成员填）—— 只要芯片真有这么大就能烧，`
        + `小容量型号会在编程时报错`);
    }
  }

  // ---------- 备用：本地桥（OpenOCD 或 J-Link） ----------
  /**
   * HPM 系列（RISC-V/JTAG）的零安装烧录。
   *
   * 与 ARM 那条路的差别（都是"把算法搬进 RAM 再驱动它"，但驱动方式不同）：
   *   · 探针要切到 **SWD+JTAG** output_mode（HID CMD_SET_CONFIG，RAM-only），DAP 口选 JTAG；
   *   · 目标核是 RISC-V：停核/传参/取返回码走 Debug Module（抽象命令 + dpc），不是 DHCSR/DCRSR；
   *   · 算法是 RV32 的（`tools/target-firmware/hpm_flash_algo/`，一份 blob 通吃 HPM 全系），
   *     它自己调芯片 ROM 里的 XPI NOR 驱动去擦写外部 flash。
   *
   * ⚠️ **本轮没能在真机上验证**（探针被占用）：协议层、封包、流程都有离线自测（含模拟 DTM/模拟 flash），
   *    但真实 JTAG 时序、ROM API 行为、output_mode 切换后的枚举都要等 bring-up。界面会明说这一点。
   */
  async _flashHpmRiscv(name){
    const board = hpmBoard($('f-chip').value);
    if (!board) throw new Error(`不认识的 HPM 板子：${$('f-chip').value}`);

    const raw = Uint8Array.from(atob(this.file.dataB64), c => c.charCodeAt(0));
    const base = Number($('f-base').value) || board.flashBase;
    const regions = parseFirmware(name, raw, base);
    for (const seg of regions){
      const chk = hpmCheckRange(board, seg.addr, seg.data.length);
      if (!chk.ok) throw new Error(`固件段 0x${seg.addr.toString(16)} 不合法：${chk.why}`);
    }
    const total = regions.reduce((s, r) => s + r.data.length, 0);
    this._log(`── RISC-V 零安装烧录：${name}（${fBytes(total)}）→ ${board.name} ──`);
    this._log(`   板级参数来自 SDK 的 boards/openocd/boards/${board.id}.cfg：flash 基址 0x${board.flashBase.toString(16)}、` +
      `XPI 0x${board.xpiBase.toString(16)}、option0 0x${(board.option0 ?? 0).toString(16)}` + (board.option1 != null ? `、option1 0x${board.option1.toString(16)}` : ''));
    this._bar(1);

    // ① 探针：HID 切 output_mode，再走 WebUSB 认领 interface 0 并切 JTAG
    this._status('准备探针：切 SWD+JTAG 输出模式…');
    const hid = new AkaLinkHid();
    try {
      await withTimeout(hid.reconnect(), 8000, '连探针 HID');
      /**
       * 🚨 **每次都要发这条**，不能"读回来已经是 1 就跳过" —— 2026-10 真机实测：
       *    `CMD_GET_CONFIG` 明明报 output_mode=1，但 `DAP_Info(0xF0)` 的能力字里 JTAG=0、
       *    `DAP_Connect(2)` 返回 0（DISABLED）；**重发一次 SET_CONFIG(1) 之后立刻就能拿到 JTAG 口**。
       *    原因见固件注释：output_mode=0 时 TDI/TDO 被 VCOM(UART) 占着，探针宁可拒绝 JTAG 也不抢引脚；
       *    那条"存储的模式"和"引脚实际归谁"是两码事，重发一次才把桥拆掉。
       */
      await withTimeout(hid.xfer(0x02 /* CMD_SET_CONFIG */, setOutputModeData(PROBE_OUTPUT_MODE.SWD_JTAG)), 3000, '切输出模式');
      const cfg = await hid.xfer(0x01).catch(() => null);
      this._log(`探针 output_mode = ${cfg ? cfg[3] : '?'}（1 = SWD+JTAG；已强制重设一次，JTAG 才拿得到口）`);
      /**
       * 🚨 还要让探针**自己的 RISC-V 引擎**放掉 TAP（HID 0x33 action 0）。
       *    那个引擎（RISC-V 内存读写/bench）会一直占着 JTAG，不放开的话
       *    `DAP_Connect(2)` 拿不到口 —— 他们的 README 里烧录前也是先跑这一步。
       *    没响应也不当失败：本来就空闲时这条命令可能不回。
       */
      try {
        await withTimeout(hid.riscvStop(), 2000, 'RISC-V 引擎 stop');
        this._log('已请求探针 RISC-V 引擎放掉 TAP（0x33 action 0）');
      } catch (e){
        this._log('（0x33 stop 无响应，可能本来就空闲）');
      }
      /**
       * 🚨 **再把探针侧的 RTT 桥也停掉**（HID 0x31 action 0）。
       *    2026-10 用户现场：**另一个标签页**里的「RTT 转发」会话还在跑，桥一直在轮询目标内存，
       *    烧录这边每一条 DMI 都在跟它抢探针 —— 现象就是"烧录卡住、特别慢"（同一个镜像我这边 25 s，
       *    他那边十几分钟不动）。同一个页面里的 RTT 会话我们会先断开（见上面 `rtt.disconnect()`），
       *    但**跨标签页的会话无能为力**，只能在这里把桥停了。
       *    停不掉也不当失败：没在跑时这条命令可能不回。
       */
      try {
        await withTimeout(hid.stop(), 2500, 'RTT 桥 stop');
        this._log('已请求探针停掉 RTT 桥（HID 0x31 action 0）—— 跨标签页残留的转发会话也会被它停掉');
      } catch (e){
        this._log('（RTT 桥 stop 无响应，可能本来就没在跑）');
      }
    } catch (e){
      this._log('⚠ 切 output_mode 失败（继续试 JTAG）：' + (e?.message || e));
    } finally {
      try { await hid.close(); } catch {}
    }

    this._status('连接数据端点（WebUSB）…');
    const auth = await withTimeout(WebUsbDapProbe.authorized(), 5000, '枚举已授权探针');
    // 🚨 必须 `skipTargetInit`：默认那套 open() 会按 **SWD** 协商时钟（DAP_Connect(SWD)+SWD_Configure+
    //    读 IDCODE），而 HPM 是 RISC-V/JTAG 目标 —— 实测会卡在 USB 传输超时（"探针没响应"）。
    //    这条路自己用 DAP_Connect(JTAG) 开链，见 DapJtagTransport.connectJtag()。
    const openOpts = { skipTargetInit: true };
    const probe = auth.length
      ? await withTimeout(WebUsbDapProbe.open(auth[0], openOpts), 15000, '连接探针（WebUSB）')
      : await withTimeout(WebUsbDapProbe.request(false, openOpts), 60000, '等你在浏览器里选探针');
    this.probe = probe;
    probe.fast = false;
    probe.onLog = s => this._log('   [usb] ' + s);

    const port = resolveHpmTarget(board);
    const jtag = new DapJtagTransport(probe, { irLength: port.debug.irLength, log: l => this._log('   ' + l) });
    const dm = new RiscvTransport(jtag, { port, log: l => this._log('   ' + l) });
    this._status('打开 JTAG TAP / 唤醒调试模块…');
    const info = await dm.init();
    this._log(`   IDCODE=0x${info.idcode.toString(16)}（HPM 全系 0x1000563D）· dmstatus=0x${info.dmstatus.toString(16)}`);
    if (info.idcode !== port.debug.tapIdcode){
      throw new Error(`TAP IDCODE 是 0x${info.idcode.toString(16)}，不是 HPM 的 0x${port.debug.tapIdcode.toString(16)} —— ` +
        '检查：JTAG 接线（TCK/TMS/TDI/TDO/GND）、板子上电、探针 output_mode 是否切到 SWD+JTAG');
    }
    await dm.activate(port.debug.hart);
    await dm.halt(port.debug.hart, 3000);

    /**
     * 🚨 **烧录前的 SBA 健康自检 + 自愈**（2026-10 HPM6800EVK 真机加的一步）。
     *
     * 现场：上一次会话/上一次失败的读会在系统总线上留下**永远不完成的事务**，此后 `sbcs` 的
     * `sbbusy`/`sbbusyerror` 常驻，**任何 SBA 访问都失败** —— 用户看到的就是
     * 「网页烧录总是卡死走不下去」（实测报 `SBA 写 0x0 出错`，连重试三次都过不去，
     * 只能整板断电或 ndmreset 才恢复）。这里在动手之前先探一下，脏了就地分级自愈
     * （清错误位 → DM 复位 → **ndmreset**），把"卡死"变成"自动清障后继续"。
     */
    this._status('检查探针→目标的总线访问（SBA）是否健康…');
    try {
      const h = await withTimeout(dm.sbaHealthCheck({ peekAddr: port.memory.healthPeekAddr }), 15000, 'SBA 健康检查');
      if (h.level === 'none') this._log('   SBA 健康检查：干净');
      else if (h.ok) this._log(`   ⚠ SBA 之前是脏的（before=0x${Number(h.before ?? 0).toString(16)}）→ 已自愈：${h.note}`);
      else throw new Error(`SBA 卡死且自愈无效：${h.note}（before=0x${Number(h.before ?? 0).toString(16)} after=0x${Number(h.after ?? 0).toString(16)}）—— ` +
        '拔插一次探针/给板子断电重上电再试');
      if (h.level === 'ndmreset'){
        // 系统复位把核重启了：halt 状态与 DM 都要重新建立，否则后面跑算法会莫名其妙
        await dm.init();
        await dm.activate(port.debug.hart);
        await dm.halt(port.debug.hart, 3000);
        this._log('   系统复位后已重新 halt');
      }
    } catch (e){
      if (/SBA 卡死且自愈无效/.test(e?.message || '')) throw e;
      this._log('   （SBA 健康检查本身出错，继续按老路试：' + (e?.message || e) + '）');
    }
    this._log('   目标已 halt，开始加载 flashloader');

    // ② flashloader + 参数探测
    const flasher = new HpmFlasher(dm, {
      board, log: l => this._log('   ' + l),
      onProgress: (frac, done, tot2, verifying) => {
        const pct = Math.round(frac * 100);
        this._bar(verifying ? 60 + pct * 0.4 : 5 + pct * 0.55);
        this._status((verifying ? '校验' : '烧写') + ` ${done} / ${tot2} B（${pct}%）`);
      },
    });
    this._status(`加载 flashloader 到 SRAM（0x${port.memory.workArea.addr.toString(16)}）…`);
    /**
     * ②③ 全过程包一层"失败收尾"（2026-10 用户现场）：
     * 算法跑不回来时旧代码直接抛错走人，**核被扔在跑飞状态**（板子随即 ping 不通，
     * 用户以为板子坏了）。现在失败就先 `recoverAfterFailure()`（停车 + 系统复位），
     * 再带上"再点一次通常就过"的可操作提示抛出去。
     */
    let done = 0;
    const verify = $('f-verify').checked;
    const doReset = $('f-reset').checked;
    try {
      const chipInfo = await flasher.setup();
      this._log(`   flashloader 就绪：容量 ${(chipInfo.totalBytes / 1048576).toFixed(2)} MB · 扇区 ${chipInfo.sectorBytes} B`);

      // ③ 擦 → 写 → 校验
      for (const seg of regions){
        this._status(`擦除 0x${seg.addr.toString(16)} 起 ${fBytes(seg.data.length)}…`);
        await flasher.erase(seg.addr, seg.data.length);
        this._log(`擦除 OK：0x${seg.addr.toString(16)} + ${seg.data.length} B`);
        await flasher.program(seg.addr, seg.data);
        this._log(`烧写 OK：0x${seg.addr.toString(16)} + ${seg.data.length} B`);
        if (verify){
          this._status('校验（读回 flash 逐字节比）…');
          await flasher.verify(seg.addr, seg.data);
          this._log(`校验 OK：0x${seg.addr.toString(16)} + ${seg.data.length} B`);
        }
        done += seg.data.length;
      }
      this._bar(100);
      await flasher.finish({ run: doReset });
      if (doReset) this._log('已发系统复位（ndmreset），目标从 flash 启动');
      this._status(`烧录完成：${fBytes(done)} → ${board.name}（RISC-V/JTAG）`, 'ok');
      this._log(`小结：${fBytes(done)} · 校验${verify ? '开' : '关'} · 复位${doReset ? '开' : '关'} · ` +
        `JTAG 批次 ${jtag.summary().batches} 次 / ${jtag.summary().bytes} B · ` +
        `flash ${(chipInfo.totalBytes / 1048576).toFixed(2)} MB / 扇区 ${chipInfo.sectorBytes} B`);
    } catch (e){
      try { await flasher.recoverAfterFailure(); this._log('   失败收尾：已尝试让目标停下来并系统复位（别把核扔在跑飞状态）'); } catch {}
      /**
       * 🚨 **链路卡住就重开一次 USB 会话**（2026-10 A/B 实测得出的结论）。
       *
       * 现场对照（同一支探针、同一块板、同一份 246 KB 镜像）：
       *   · 我们的路径报 `DAP_JTAG_Sequence 返回状态 0xff` / `响应回显 0x3 ≠ 命令 0x0` 之后，
       *     后续命令会一路错下去（响应流错位，WebUSB 没有取消接口，超时的传输还在偷响应）；
       *   · **紧接着用 OpenOCD 打同一块板：4.9 s、一次成功** —— 人家是"新会话"，我们是"脏会话"。
       * 所以这里在失败收尾后顺手 `reopen()`（关掉再认领接口、清端点队列），
       * 让"再点一次烧录"真的能过，而不是继续往错位流里灌命令。
       */
      const wedge = /0xff|响应回显|USB 读 超时|Unable to claim|占用 USB 接口|NO ACK|FAULT/i.test(String(e?.message || ''));
      if (wedge){
        this._log('   链路像是脏了（响应错位/超时）→ 重开一次 USB 会话，让下一次点击是干净起点');
        try { await this.probe?.reopen?.(); } catch (err){ this._log('   （重开失败：' + (err?.message || err) + '，建议拔插一次探针）'); }
      }
      throw new Error(`${e?.message || e}　—— 已尝试把目标复位回可用状态${wedge ? '，并重开了 USB 会话' : ''}；` +
        '直接再点一次「烧录」通常就过（这条 JTAG/SBA 通路偶发丢拍）；' +
        '连点两次都不过就先给板子断电重上电、并确认没有别的页签占着探针');
    }
  }

  async _flashBridge(name, pathText){
    const useJlink = $('f-backend').value === 'jlink';
    this._bar(50);   // 桥烧录拿不到流式进度，只能示意
    this._status(useJlink ? '桥烧录中…（J-Link Commander 完成后一次性返回结果）'
                          : '桥烧录中…（OpenOCD 完成后一次性返回结果）');
    this.bc = new BridgeClient($('f-bridge-url').value);
    await this.bc.connect({ version: 1 });
    const cfg = {
      target: $('f-chip').value,
      verify: $('f-verify').checked,
      reset: $('f-reset').checked,
      /**
       * J-Link 这条路由桥自己起 JLink.exe 烧（见 bridge/rtt-bridge.mjs 的 jlinkFlash）：
       * 桥会**先停掉 RTT 会话**再烧 —— J-Link 同一时刻只允许一个持有者，两个进程一起抢
       * 会直接连不上探针（跟 WebUSB 那边"谁占着调试器"是同一类问题）。
       */
      ...(useJlink ? { backend: 'jlink' } : {}),
    };
    if (cfg.target === 'custom'){
      cfg.cfgs = String($('f-cfgs').value || '').split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
      cfg.speed = Number($('f-speed').value) || 0;
      if (!cfg.cfgs.length) throw new Error('自定义目标要填 cfg 文件（逗号分隔）');
    }
    if (/\.bin$/i.test(name)) cfg.base = Number($('f-base').value) || 0;
    if (this.file){ cfg.name = this.file.name; cfg.dataB64 = this.file.dataB64; cfg.size = this.file.size; }
    else cfg.path = pathText;

    const r = await this.bc.flash(cfg);
    this._bar(100);
    this._log(`── 桥烧录完成（${r.seconds.toFixed(1)}s）──\n${r.output || ''}`);
    setStatus($('f-result'),
      `✅ ${r.target} · ${fBytes(r.bytes)} · ${r.seconds.toFixed(1)}s${r.verify ? ' · 已校验' : ''}${r.reset ? ' · 已复位运行' : ''}`, 'ok');
    toast('烧录成功', 'ok', 5000);
  }

  // ================= 界面小工具 =================
  _bar(pct){
    const bar = $('f-bar');
    bar.hidden = false;
    bar.value = Math.max(0, Math.min(100, pct));
    if (pct >= 100) setTimeout(() => { bar.hidden = true; }, 1500);
  }
  _status(s, kind){
    this._statusText = s; this._statusKind = kind; this._statusT0 = Date.now();
    setStatus($('f-status'), s, kind);
  }

  /**
   * 烧录期间的**心跳**：让"卡住"这件事自己说出来。
   *
   * 页面里每一处 USB/HID 调用都有超时（不会真死等），但"一连串超时 + 复位重试"能安静地
   * 吃掉几十秒 —— 状态行一直停在同一句话上，用户看到的就是"卡住、没反应"，事后也说不清
   * 卡在哪一步。这里每 400 ms 做三件事：
   *   ① 状态行补一句「本步已 12s，USB 静默 8s」——一眼看出是在等什么；
   *   ② **真的在重试**（这一窗口内出现过传输失败）就往日志写一行，把重试次数带上；
   *   ③ 记下最长的"USB 静默"时长，收尾时写进日志，便于事后追。
   *
   * ⚠️ 只在"静默 + 有失败"时才告警：跑 erase 这类算法时本来就没有 USB 往返（几十秒也正常），
   *    那时候不该误报成"探针没响应"。
   */
  _hbStart(){
    this._hbStop();
    const h = this._hb = { lastOk: Date.now(), quietWarned: 0, worst: 0, fails: 0, hiddenTicks: 0, tick: null };
    h.tick = setInterval(() => {
      const now = Date.now();
      if (document.hidden) h.hiddenTicks++;      // 本页不可见 = 浏览器会给定时器限速（耗时小结里如实标注）
      const probe = this.probe;
      const okAt = probe?.lastOkAt || 0;
      const quiet = now - Math.max(okAt, h.lastOk);
      if (quiet > h.worst) h.worst = quiet;
      const fails = probe?.xferFails || 0;
      const retrying = fails > h.fails || (probe?._recovering === true);
      h.fails = fails;
      const inStep = now - (this._statusT0 || now);
      if (quiet > 6000 && retrying && now - h.quietWarned > 6000){
        h.quietWarned = now;
        this._log(`⚠ USB 通道已 ${(quiet / 1000).toFixed(0)} s 没有一次成功传输 —— 探针没回应，` +
          `页面正在自动复位端口重试（已 ${probe?.recoveries || 0} 次）。别拔线，等它自己恢复；` +
          '超过一两分钟还不动就拔插一次探针再重烧。');
      }
      if (inStep > 2500 && this._statusText){
        setStatus($('f-status'), this._statusText +
          `（本步已 ${(inStep / 1000).toFixed(0)}s` + (quiet > 3000 ? `，USB 静默 ${(quiet / 1000).toFixed(0)}s` : '') + '）',
        this._statusKind || '');
      }
    }, 400);
  }
  _hbStop(){
    if (this._hb?.tick) clearInterval(this._hb.tick);
    if (this._hb && this._hb.worst > 5000){
      this._log(`（本轮最长一次 USB 静默 ${(this._hb.worst / 1000).toFixed(1)} s）`);
    }
    this._hb = null;
  }
  _log(s){
    const el = $('f-log');
    el.textContent += (el.textContent ? '\n' : '') + s;
    el.scrollTop = el.scrollHeight;
  }
  _err(e){
    this._log('── 出错 ──\n' + (e?.message || e));
    toast(String(e?.message || e), 'err', 6000);
  }
}
