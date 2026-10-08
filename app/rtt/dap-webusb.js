/**
 * WebUSB + CMSIS-DAP v2（bulk）探针 —— 零安装的 RTT 通路。
 *
 * 只依赖标准 CMSIS-DAP，不认识 J-Link（J-Link 协议不开放，网页接不上）。
 * 命令/响应格式与 ESP32-S31 自制探针 cherrydap 的 DAP.c 逐条核对过：
 *   · 响应第一个字节 = 命令回显（DAP_ProcessCommand 里 *response++ = *request）
 *   · DAP_Transfer 每条传输在请求里固定占 5 字节（1 请求字节 + 4 字节 data），读也要占位
 *   · DAP_TransferBlock 响应 = [回显, count_lo, count_hi, ack, data...]
 *   · DAP_ResetTarget 响应 = [回显, DAP_OK, 执行标志]
 */
import { u32le, u32leBytes } from '../core/bin.js';
import { UsbLease } from '../core/usb-device.js';
/**
 * 等待原语（见 core/pace.js 的整段说明）：
 * 🚨 轮询间隔**不能用 setTimeout** —— 页面不可见时浏览器把短延时钳到 ≥1 s，
 *    一次烧录里几十处 2~5 ms 的轮询于是各花 1 秒，1.4 s 变成 47 s（真机定因）。
 *    `yieldTask` = 让一步（不受节流）；`waitMs` = 至少等 ms（短等待同样不受节流）；`sleep` = 真定时器。
 */
import { sleep, waitMs } from '../core/pace.js';

export const CMD = {
  Info: 0x00, Connect: 0x02, Disconnect: 0x03, TransferConfigure: 0x04,
  Transfer: 0x05, TransferBlock: 0x06, WriteABORT: 0x08, Delay: 0x09,
  ResetTarget: 0x0a, SWJ_Pins: 0x10, SWJ_Clock: 0x11, SWJ_Sequence: 0x12, SWD_Configure: 0x13,
};
const X_APnDP = 0x01, X_RnW = 0x02, X_ADDR = 0x0c;
const AP_CSW = 0x00, AP_TAR = 0x04, AP_DRW = 0x0c;
const DP_IDCODE = 0x00, DP_CTRL_STAT = 0x04, DP_SELECT = 0x08, DP_RDBUFF = 0x0c;
/**
 * DP CTRL/STAT 的位排法（ADIv5，**别按名字猜位号**）：
 *   · bit28 CDBGPWRUPREQ ／ bit29 CDBGPWRUPACK   ← 调试域（REQ 主机写 / ACK 目标置，只读）
 *   · bit30 CSYSPWRUPREQ ／ bit31 CSYSPWRUPACK   ← 系统域（同上）
 *   即 **28/30 是请求位、29/31 是只读应答位**。上电请求值 = `0x50000000`（见 `_powerUpDP`）。
 *
 * 🚨 这里的三段注释曾经互相矛盾（2026-10 代码审查把那批旧注释清掉了），踩过的两个坑记在这：
 *   ① 早期把 REQ/ACK 写反过（用过 0x70000000 / 0xC0000000 = 给只读位写 1、又漏了请求位）
 *      → STM32H7B0 的 DP 直接回 FAULT，页面报「SWD FAULT（…地址 0x4）」；F1 恰好容忍，
 *      所以 F103 一直"能用"，把这个 bug 掩盖了很久（见 stm32h7b0_rtt_speed/RESULTS.md）。
 *   ② 判"上电了没有"现在用的是 `st & 0x30000000`（= bit29|bit28）—— **这个掩码是错的**
 *      （拿"我们自己刚写下去的请求位"当应答）。正确掩码是 `0xA0000000`（bit31|bit29）。
 *      改它属于"会动到探针 bring-up"的改动，必须逐块板子真机验（F103 / H743 / H7B0），
 *      所以**本段只统一注释、不动掩码**：留待有板子时单独改（见 `_powerUpDP` 的说明）。
 */
const SWJ_nRESET = 1 << 7;
const ACK = { 1: 'OK', 2: 'WAIT', 4: 'FAULT', 7: 'NO ACK' };
const reqByte = (ap, rnw, addr) => (ap ? X_APnDP : 0) | (rnw ? X_RnW : 0) | (addr & X_ADDR);

/**
 * 被「挂起传输」搞脏的设备。
 *
 * 🚨 WebUSB **没有取消接口**：`withTimeout` 超时只是"我们不等了"，底层那次 bulk 传输
 *    还挂在 USB 栈里 —— 它会偷走下一条响应，攒多了还会把整个 USB 服务搞到
 *    `navigator.usb.getDevices()` / `device.open()` 都不返回（实测：连不上几次之后，
 *    连烧录器都卡在第一步 getDevices() 上，90 秒不动）。
 *    唯一的解药是 **USB 端口复位**（`device.reset()`，会清掉挂起传输），其次是重开设备。
 *    所以这里把"出现过超时"的设备记下来，下次认领前先复位。
 */
const dirty = new WeakSet();

/**
 * 探针认哪种 bulk 封包写法（`short` = 规范的长度精确包；`pad` = 补齐到整包）。
 * 记在设备对象上：同一台探针第二次 open 就不用再探测了。
 * 依据（2026-10 真机实测，HPM6800EVK + akaLinkPro 探针）：
 *   · 短包：`DAP_Info(0)`→`00 00`、`DAP_Connect(2)`→`02 00`、`SWJ_Clock`→`11 00`，全都有应答；
 *   · 补齐 512 B：**一条都不回应**（"探针没响应"超时），且会把端点搞脏（之后短包也不应，需端口复位）。
 */
const FRAMING = new WeakMap();

/** 给任意 promise 套超时（超时只是放弃等待；USB 层要靠 dirty+reset 收拾） */
export async function withTimeout(p, ms, what){
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} 超时（${ms}ms）：探针没响应`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

/** USB 端口复位（清挂起传输）；成功返回 true */
async function resetDevice(device, lease){
  if (lease){
    await lease.reset();
    dirty.delete(device);
    return true;
  }
  if (!device || !device.opened) return false;
  try {
    await withTimeout(device.reset(), 3000, 'USB 端口复位');
    dirty.delete(device);
    console.info('[dap] 已做 USB 端口复位（清掉上一次会话的挂起传输）');
    return true;
  } catch (e){
    console.warn(`[dap] USB 端口复位失败：${e.message}（可能要拔插一次探针）`);
    return false;
  }
}

export class WebUsbDapProbe {
  constructor(){
    this.name = 'CMSIS-DAP';
    this.device = null;
    this.pkt = 64;
    this.iface = 0;
    this.epIn = 0;
    this.epOut = 0;
    this.maxWords = 12;
    this._ready = false;
    this.lastError = null;
    this._posted = false;              // 是否有未冲干净的 posted（后发）写
    /**
     * **访问档位**（两条路径诉求不同，分开优化）：
     *   fast=false 严格档（默认）：小块读一律双读、每次写都回读校验。
     *     用于烧录（flashloader 靠状态位判断算法是否跑完，误判=校验失败）
     *     以及用户手动动作（下行命令、复位、定位控制块）。
     *   fast=true 快速档：RAM 小块读单读（上层结构校验不过再重读）、
     *     同一地址的重复写不每次回读（RTT 轮询每轮推进 RdOff 就是这种）。
     *     用于 RTT 后台轮询这类高频流式读。
     * ⚠️ 无论哪档，PPB 区（≥0xE0000000，DHCSR 之类状态位）小块读都双读，不许省。
     * 由 rtt/view.js 在连接后置位、手动动作前后临时切回严格档。
     */
    this.fast = false;
    this.clockHz = 1_000_000;          // 当前生效的 SWD 时钟（握手成功后 = 实际请求值）
    this.clockTried = [];              // 试过哪些档位（排障用）
    /**
     * 给上层（烧录器/波形页）看的"链路心跳"：
     *   lastOkAt   = 最近一次**成功**的 USB 往返（毫秒时间戳），用来判断"通道安静了多久"
     *   xferFails  = 传输超时次数；recoveries = 自动复位端口次数
     * 为什么要有：一连串"超时 → 复位 → 重试"能安静地耗掉几十秒，界面看着就是"卡住"。
     * 有了这几个数，界面就能把"卡在哪、是不是在自动恢复"写清楚。
     */
    this.lastOkAt = 0;
    this.xferFails = 0;
    this.recoveries = 0;
    /**
     * 总线 FAULT 的"待自愈"标记（见 `_healIfFaulted`）。
     * 🚨 一次 FAULT 会把整条 SWD 链路打死，abort()/清 sticky 都救不回来，只有 `_targetInit()` 管用。
     */
    this._faulted = false;
    this.faultHeals = 0;
    /** @type {((s:string)=>void)|null} 关键恢复动作的文字回执（页面日志用） */
    this.onLog = null;
  }

  _note(s){ try { this.onLog?.(s); } catch { /* 日志不该影响主流程 */ } }

  /**
   * SWD 时钟档位（kHz）：逐档试，第一个能读到合法 IDCODE 的就用。
   *
   * 🚨 **不是越高越快**：本机 MicroLink CMSIS-DAP + STM32F103 实测（RTT 阻塞发数据、
   *    目标侧对账一致）：1 MHz 114 KB/s、4 MHz 236、**8 MHz 330（最快）**、
   *    10 MHz 324、12 MHz 254、20/30 MHz 只有 250 左右 —— 所以 8 MHz 排在第一个。
   *    时钟太高还会读到错数据（对账对不上）或直接 NO ACK，必须逐档回退。
   *    想手工指定用界面上的「SWD 时钟」输入框（存 rtt.clockKhz；留空或 0 = 自动，即走这份候选表）。
   */
  static CLOCK_CANDIDATES = [8000, 12000, 4000, 2000, 1000, 500, 200];

  static supported(){ return typeof navigator !== 'undefined' && 'usb' in navigator; }

  static async authorized(){
    if (!WebUsbDapProbe.supported()) return [];
    try { return await navigator.usb.getDevices(); } catch { return []; }
  }

  /** 弹浏览器设备选择框；all=true 时列出所有 USB 设备（非 DAPLink 也能试） */
  static async request(all = false, opts = {}){
    if (!WebUsbDapProbe.supported()) throw new Error('这个浏览器没有 WebUSB（请用桌面版 Chrome / Edge）');
    const device = await navigator.usb.requestDevice({ filters: all ? [] : [{ vendorId: 0x0d28 }] });
    return await WebUsbDapProbe.open(device, opts);
  }

  static async open(device, opts = {}){
    const p = new WebUsbDapProbe();
    p.device = device;
    try { await p._setup(opts); return p; }
    catch (e){
      try { await p._usb?.close({ dirty: dirty.has(p.device) }); } catch (cleanup){
        p._usb?.abandon();
        e.message += `；USB 清理未完成：${cleanup.message}`;
      }
      throw e;
    }
  }

  /**
   * @param {{skipTargetInit?:boolean, skipInfo?:boolean, skipClearHalt?:boolean, clockKhz?:number}} opts
   *   skipTargetInit=true 只认领 USB，不碰目标（自测/排障用）
   *   skipInfo=true 连 DAP_Info 都不问，让命令流与"验证过的裸客户端"完全一致
   *   clockKhz>0 指定 SWD 时钟；不指定则从高到低自动选（见 CLOCK_CANDIDATES）
   */
  async _setup({ skipTargetInit = false, skipInfo = false, skipClearHalt = false, clockKhz = 0, framing = null } = {}){
    this._closing = false;
    this.skipTargetInit = skipTargetInit;
    this.skipClearHalt = skipClearHalt;
    await this._claim();
    const prod = this.device.productName || 'CMSIS-DAP';

    /**
     * 🚨 **先定封包写法再发任何命令**（见 `_ctrl` 的注释）：当前固件只认**短包**，
     *    老固件只认"补齐到整包"。这里用一条 `DAP_Info` 实测一次，定不下来就端口复位清干净再试另一种，
     *    结论记住（存到模块级 WeakMap，同一台探针后续 open 不用再试）。
     */
    this._framing = framing || FRAMING.get(this.device) || await this._detectFraming();
    if (this._framing === 'pad') console.warn('[dap] 这台探针认"补齐到整包"的写法（老固件）');
    // 先按"验证过能跑通"的裸客户端顺序把目标初始化好（tools\cmsis_dap_raw.py），
    // Info 查询放**后面**做 —— 那份脚本一个 Info 都没发，序列越接近它越稳。
    if (!skipTargetInit){
      if (clockKhz > 0){
        await this._targetInit({ clock: clockKhz * 1000 });
        this.clockHz = clockKhz * 1000;
      } else {
        await this._negotiateClock();
      }
    }
    if (skipInfo) return;
    try {
      const ps = await this.info(0xff);
      /**
       * ⚠️ 探针上报的是 `DAP_XFER_SIZE`（akaLinkPro 固件 = **1024**，`DAP_config.h`；
       *    `DAP.c:180` 注释明说"不能报端点 mps，否则主机每次只能带 ~508 B 数据"）——
       *    但**实测 >512 B 的命令不可靠**（2026-10 逐档扫描：请求 577 B 正常、
       *    721 B 起响应恒少 222 B、973 B 更乱；固件侧 `DAP_JTAG_Sequence` 与 OUT 回调都
       *    没有硬上限，所以怀疑在 USB 多包收发这一层，待单独攻）。
       *    烧录这种"必须一次成功"的路径**先按 512 B 端点包长算**，别赌没查清的多包行为。
       */
      if (ps.length >= 2){ const v = ps[0] | (ps[1] << 8); if (v > 0 && v <= 4096) this.pkt = Math.min(v, 512); }
      const pc = await this.info(0xfe);
      this.packetCount = pc[0] || 1;
      /** ARM/WebUSB 那条路的块读是按 512 B 包标定过的（F103/H7B0 基准），这里保守不变 */
      this.maxWords = Math.max(1, Math.min(120, Math.floor((Math.min(this.pkt, 512) - 8) / 4)));
      this.name = `${prod} · ${this.pkt}B/包 · SWD ${Math.round(this.clockHz / 1000)}kHz`;
    } catch {}
  }

  /** USB 层：打开设备、找 bulk 端点、认领接口、清端点、同步清队列 */
  async _claim(){
    this._usb ||= new UsbLease(this.device, 'dap');
    const d = this.device = this._usb.device;
    // 🚨 上一次会话如果有过超时，USB 栈里可能还挂着传输 —— 会偷响应、甚至让
    //    getDevices()/open() 整条卡死。先做端口复位清掉（在 open 之前做最安全）。
    if (dirty.has(d)){
      console.warn('[dap] 这个探针上次有超时（挂起传输），先复位 USB 端口再认领');
      this._note('上次会话有超时（可能还挂着传输）→ 先复位 USB 端口再认领');
      await this._usb.open();
      await resetDevice(d, this._usb);
    }
    await this._usb.open();
    let found = null;
    for (const iface of d.configuration.interfaces){
      for (const alt of iface.alternates){
        const bulk = (alt.endpoints || []).filter(e => e.type === 'bulk');
        const ownProbe = d.vendorId === 0x0d28 && d.productId === 0x0204;
        const epIn = bulk.find(e => e.direction === 'in' && (!ownProbe || e.endpointNumber === 1));
        const epOut = bulk.find(e => e.direction === 'out' && (!ownProbe || e.endpointNumber === 2));
        if (epIn && epOut){ found = { iface, alt, epIn, epOut }; break; }
      }
      if (found) break;
    }
    if (!found) throw new Error('这个 USB 设备没有 CMSIS-DAP v2 的 bulk 端点（v1/HID 探针暂不支持，J-Link 也不支持）');
    this.iface = found.iface.interfaceNumber;
    this.epIn = found.epIn.endpointNumber;
    this.epOut = found.epOut.endpointNumber;
    /** 初始值先按端点 mps（512，`DAP_Info(0xff)` 之后仍按 512 钳，见上面那条注释） */
    this.pkt = Math.min(found.epIn.packetSize || 64, 512);
    try {
      await withTimeout(this._usb.claim(this.iface, [this.epIn | 0x80, this.epOut]), 5000, 'USB 认领接口');
    } catch (e){
      /**
       * 🚨 认领失败基本只有一个原因：**接口还被上一次会话占着**（同源另一个页签、被刷掉的旧文档、
       *    本机 OpenOCD/pyOCD…）。2026-10 真机复现 + 定点实验的结论，分两种情况：
       *      · 占用方**还活着** → `device.reset()` 完全没用（实测直接回 "Unable to reset the device"），
       *        必须先靠跨页签协调让它让出探针（见 core/probe-bus.js）；
       *      · 占用方**已经死了**（文档被刷新掉、或被 reset 掉线）→ 更阴：它只是丢了 JS 引用、
       *        **没调 `close()`**，于是接口认领在浏览器里"僵"住了，直到垃圾回收才散。
       *        实验：在那个文档里补一次 `close()`（哪怕设备已 opened=false）→ 立刻就能认领；
       *        不补的话要等几十秒才自己好。
       *    所以这里是**有限次退避重试**（而不是一次就放弃），给"僵尸认领"留出散掉的时间。
       */
      let ok = false, lastMsg = e.message;
      for (let i = 1; i <= 3 && !ok; i++){
        this._note(`认领接口失败（${lastMsg}）→ 复位端口后第 ${i}/3 次重试…`);
        await resetDevice(d, this._usb);
        await sleep(300 * i);
        try { await withTimeout(this._usb.claim(this.iface, [this.epIn | 0x80, this.epOut]), 5000, 'USB 认领接口（重试）'); ok = true; }
        catch (e2){ lastMsg = e2.message; }
      }
      if (ok){
        console.warn('[dap] 认领接口失败 → 复位端口后重试成功');
        this._note('复位后重试成功，接口已认领');
      } else {
        throw new Error(`占用 USB 接口失败：${lastMsg} —— 探针接口还被上一次会话占着（刷新掉页面/脚本中途退出都会留下），` +
          '试试：① 关掉其他用到探针的标签页（RTT 转发 / J-Scope / 烧录器）；' +
          '② 另一个页签刚断开的话，等两三秒再点一次「烧录」通常就好了（浏览器释放接口要一会儿）；' +
          '③ 拔插一次探针；④ 还不行就查 OpenOCD/pyOCD 有没有在后台跑');
      }
    }

    /**
     * 🚨 认领接口后**必须清一次端点**。
     * 探针的 IN 端点里常常残留着上一次会话（OpenOCD/pyOCD/上一次网页会话）没被取走的响应包，
     * 而 `DAP_Transfer` 的陈旧失败响应（ACK=NO ACK、count=0）回显同样是 0x05，
     * 会被我的"按回显匹配"逻辑当成**当前命令的响应** → 现象是"目标明明 ACK 了，页面却报 NO ACK"。
     * libusb/pyusb 认领接口时会自己 clear_halt 冲掉这些数据，所以同一个探针用 Python 脚本一直是好的，
     * 只有 WebUSB 这条路上会踩到（本机实测：LA 上能看到目标回了 ACK=OK，页面却报 NO ACK）。
     */
    for (const [dir, ep] of [['in', this.epIn], ['out', this.epOut]]){
      if (this.skipClearHalt) break;
      try { await withTimeout(d.clearHalt(dir, ep), 2000, `clearHalt(${dir})`); }
      catch (e){ console.warn(`clearHalt(${dir}) 失败：${e.message}`); }
    }
    await this.resync();
    this._watchUsb();
    this._ready = true;
    this.maxWords = Math.max(1, Math.min(120, Math.floor((this.pkt - 8) / 4)));
    this.name = `${d.productName || 'CMSIS-DAP'} · ${this.pkt}B/包`;
  }

  /**
   * SWD 时钟自动选档：按 CLOCK_CANDIDATES 的顺序试，第一个能读到合法 IDCODE 的就用。
   * 时钟过高会 NO ACK 或**读到错数据**（吞吐也不升反降），所以每次都靠
   * `_targetInit()` 里那笔「读 DP IDCODE + 校验」来判定通不通。
   */
  async _negotiateClock(){
    this.clockTried = [];
    let last = null;
    for (const khz of WebUsbDapProbe.CLOCK_CANDIDATES){
      this.clockTried.push(khz);
      try {
        await this._targetInit({ clock: khz * 1000 });
        this.clockHz = khz * 1000;
        if (this.clockTried.length > 1) console.info(`[dap] SWD 时钟降到 ${khz} kHz 才通（试过 ${this.clockTried.join('/')}）`);
        return this.clockHz;
      } catch (e){
        last = e;
        console.warn(`[dap] ${khz} kHz 不通：${e.message}`);
        // 每档失败后把 USB 会话重开一遍：拉过/折腾过的 SWD 引擎往往要重开会话才肯恢复。
        // `targetInit: false` = 只重开会话，别拿**旧时钟**再协商一次（马上要用新档试）
        try { await this.reopen({ targetInit: false }); } catch {}
      }
    }
    throw new Error(`所有 SWD 时钟档位都连不上目标（最后：${last?.message}）——查接线 / 复位 / 供电`);
  }

  // ---------------- 原始命令 ----------------
  /**
   * 发一条 CMSIS-DAP 命令并取回它的响应。
   *
   * 🚨 这里**不能**天真地"发一条读一条、读到什么就当成什么"：
   *    探针的 IN 端点里可能残留着**上一次会话**（OpenOCD / pyOCD / J-Link）没被取走的响应包，
   *    于是整条响应流错位一格。更阴的是 DAP_Info 的响应回显就是 0x00，
   *    所以错位后前两条 Info 会"假装成功"，一直到 DAP_Connect 才炸出
   *    「响应错位：发 0x2 收 0x0」（本机 MicroLink DAPLink 实测踩到）。
   *    → 按命令回显匹配，不匹配的陈旧包丢掉重读（一次只发一条命令，不存在流水线，
   *      所以丢掉的一定是陈旧的，不会是别人的）。
   */
  /**
   * 实测这台探针认哪种封包写法，并记住结论（同一台设备后续 open 直接用）。
   * 先试**规范写法（短包）**；没响应就端口复位把挂起的传输清掉，再试"补齐到整包"。
   * 🚨 复位这一步不能省：短包没响应时那次 `transferIn` 还挂着，不清掉会把后面那条响应偷走。
   *
   * 🚨 2026-10 补的第二个坑：短包探测失败**有两种完全不同的原因**，不能混为一谈 ——
   *   · 「超时（没响应）」才是固件不认短包，该换 `pad` 写法；
   *   · 「响应回显不匹配」是 IN 端点里躺着**陈旧响应**（上一次网页会话被中途打断、
   *     OpenOCD 退出时留下的那一两条），固件本身没问题。
   *   一开始两种都当"要换写法"处理，于是偶尔会误判成 pad、然后一路超时打不开探针
   *   （本机真机踩到：页面刷新后 3 次里 1 次打不开）。现在先清队列、按短包重试一次。
   */
  async _detectFraming(){
    const tryOne = async (framing, timeout) => {
      this._framing = framing;
      await this._ctrlRaw(CMD.Info, Uint8Array.of(0), timeout);
      return framing;
    };
    try {
      const f = await tryOne('short', 900);
      FRAMING.set(this.device, f);
      return f;
    } catch (e){
      console.warn('[dap] 短包探测失败：' + e.message);
      if (/响应回显/.test(e.message)){
        console.info('[dap] 是陈旧响应包（不是固件不认短包）→ 清队列后按短包重试');
        try { await resetDevice(this.device, this._usb); } catch {}
        await sleep(200);
        await this._claim();                       // clearHalt + resync，把陈旧包吃掉
        try {
          const f = await tryOne('short', 1500);
          FRAMING.set(this.device, f);
          return f;
        } catch (e2){
          console.warn('[dap] 清完队列后短包还是不行：' + e2.message);
        }
      }
    }
    try { await resetDevice(this.device, this._usb); } catch {}
    await sleep(250);
    await this._claim();
    const f = await tryOne('pad', 2000);
    FRAMING.set(this.device, f);
    return f;
  }

  /** 一条命令的"写 + 读"，不做陈旧包重试（只给封包探测用）*/
  async _ctrlRaw(cmd, payload, timeout = 1500){
    const n = 1 + (payload ? payload.length : 0);
    const req = this._framing === 'pad' ? new Uint8Array(this.pkt) : new Uint8Array(n);
    req[0] = cmd;
    if (payload) req.set(payload, 1);
    await withTimeout(this.device.transferOut(this.epOut, req), timeout, 'USB 写');
    const r = await withTimeout(this.device.transferIn(this.epIn, this.pkt), timeout, 'USB 读');
    if (!r.data || !r.data.byteLength) throw new Error('收到空包');
    const res = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    if (res[0] !== cmd) throw new Error(`响应回显 0x${res[0].toString(16)} ≠ 命令 0x${cmd.toString(16)}`);
    return res.subarray(1);
  }

  async _ctrl(cmd, payload, { deadline = Infinity } = {}){
    if (!this._ready || (this._closing && cmd !== CMD.Disconnect)) throw new Error('探针未连接或正在断开');
    const n = 1 + (payload ? payload.length : 0);
    if (n > this.pkt) throw new Error(`CMSIS-DAP 命令太长（${n} > ${this.pkt} 字节/包）`);
    /**
     * 🚨 **封包长度必须按固件实际认的写法发**（2026-10 真机踩到，两种固件行为不同）：
     *   · `short`（默认，CMSIS-DAP 规范）：传输长度 = 实际命令长度。HPM6800EVK 上实测
     *     `DAP_Info(0)`→`00 00`、`DAP_Connect(2)`→`02 00`（JTAG 拿到口）、`SWJ_Clock`→`11 00`。
     *   · `pad`（老固件的写法）：补齐到整包（512 B）。当前固件对补齐包**完全不回应**
     *     —— 现象是"探针没响应"超时，而同一根管子用短包立刻就有应答。
     * 结论由 `_detectFraming()` 在 open 时**实测**一次定下来（见那里），不再靠注释里的传说。
     */
    const req = this._framing === 'pad' ? new Uint8Array(this.pkt) : new Uint8Array(n);
    req[0] = cmd;
    if (payload) req.set(payload, 1);
    const remaining = () => {
      const left = deadline - (globalThis.performance?.now() ?? Date.now());
      if (left <= 0) throw new Error('USB 命令时间预算已耗尽');
      return Math.min(3000, left);
    };
    const writeTimeout = remaining();
    try {
      await withTimeout(this.device.transferOut(this.epOut, req), writeTimeout, 'USB 写');
    } catch (e){
      await this._onXferTimeout('USB 写');    // 写超时：底层传输可能还挂着 → 标脏 + 立刻复位救回来
      throw e;
    }
    for (let attempt = 0; attempt < 4; attempt++){
      let r;
      const readTimeout = remaining();
      try {
        r = await withTimeout(this.device.transferIn(this.epIn, this.pkt), readTimeout, 'USB 读');
      } catch (e){
        await this._onXferTimeout('USB 读');
        throw e;
      }
      if (!r.data || !r.data.byteLength) continue;                     // 空包：跳过
      const res = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (res[0] !== cmd){
        this.stale = (this.stale || 0) + 1;
        console.warn(`[dap] 丢弃陈旧响应包（回显 0x${res[0].toString(16)} ≠ 命令 0x${cmd.toString(16)}，第 ${this.stale} 个）`);
        continue;
      }
      this.lastOkAt = Date.now();           // 链路心跳（见构造函数里的说明）
      return res.subarray(1);
    }
    this.xferFails++;
    this._note(`命令 0x${cmd.toString(16)} 连续 4 次没读到响应（探针掉线？）`);
    throw new Error(`CMSIS-DAP 连续 4 次都没读到命令 0x${cmd.toString(16)} 的响应（探针掉线？）`);
  }

  /**
   * 一次 USB 传输超时之后**立刻**把探针救回来（而不是留给下一次 open）。
   *
   * 🚨 为什么必须当场救：WebUSB 没有取消接口，超时那次 bulk 传输还挂在 USB 栈里，
   *    它会偷走后面每条命令的响应；继续发命令只会一条接一条超时，
   *    最后连 `getDevices()` 都不返回 —— 用户看到的是"页面卡死，只能拔插"。
   *    （2026-10 真机踩到：SBA 去读一个没映射的外设窗口 → 之后整条链路都在等超时。）
   *    做法：端口复位 + 重新认领接口 + 清队列。已经在复位中就跳过，避免连环调用。
   */
  async _onXferTimeout(what){
    dirty.add(this.device);
    this.xferFails++;
    if (this._recovering || this._closing) return;
    this._recovering = true;
    this.recoveries++;
    try {
      console.warn(`[dap] ${what} 超时 → 自动复位 USB 端口并清队列`);
      this._note(`${what} 超时 → 自动复位 USB 端口并清队列（第 ${this.recoveries} 次）`);
      await resetDevice(this.device, this._usb);
      if (this._closing){ this._recovering = false; return; }
      await sleep(150);
      if (this._closing){ this._recovering = false; return; }
      await this._claim();
      this._recovering = false;
    } catch (e){
      this._recovering = false;
      console.warn('[dap] 超时后自动恢复失败：' + e.message + '（可能要拔插一次探针）');
      this._note('超时后自动恢复失败：' + e.message + '（可能要拔插一次探针）');
    }
  }

  /**
   * 上一次访问撞上**总线 FAULT**（读了未映射地址/外设时钟没开…）之后的自愈。
   *
   * 🚨 2026-10 真机定标（H743 + akaLinkPro）：**一次 FAULT 会把整条 SWD 链路打死** ——
   *    之后连"读寄存器""读 flash"都一路 FAULT，`abort()`（清 sticky）和写 DP CTRL/STAT
   *    **都救不回来**，只有重新走一遍 `_targetInit()` 才恢复。
   *    而 FAULT 太容易撞上了：hexdump 里手输一个不存在的地址、内存跟随 PC 走到未映射区……
   *    用户看到的是"探针突然瞎了，只能拔插重连"，这在发布前必须自己爬起来。
   *
   * 做法：FAULT 当场只**标脏**（把错误如实抛给调用方，那一次操作确实失败了），
   *       **下一次**访问前先花一次 `_targetInit()` 把口子重新初始化，再照常干活。
   *       在锁外调用 —— `_targetInit` 内部会用公开的读写路径，锁里调用会自锁死。
   */
  async _healIfFaulted(){
    if (!this._faulted || this._recovering) return false;
    this._faulted = false;                       // 先清：自愈过程里的访问别再触发一轮
    this._recovering = true;
    try {
      await this._targetInit({ clock: this.clockHz || null });
      this.faultHeals = (this.faultHeals || 0) + 1;
      this._note(`上次访问撞上总线 FAULT → 已重新初始化调试口（第 ${this.faultHeals} 次），可以继续操作`);
      return true;
    } catch (e){
      this._note('总线 FAULT 后自愈失败：' + (e?.message || e) + '（可能要拔插一次探针）');
      return false;
    } finally {
      this._recovering = false;
    }
  }

  async info(id){
    const r = await this._ctrl(CMD.Info, Uint8Array.of(id));
    return r.subarray(1, 1 + (r[0] || 0));                 // r[0] = 长度
  }

  /**
   * 把 IN 端点里**上一场会话残留的响应**清干净。
   *
   * 为什么需要：探针的响应是"命令回显 + 载荷"，而**回显不唯一** ——
   * 残留的 `DAP_Transfer` 响应回显同样是 0x05，于是"按回显匹配"根本分不出来，
   * 会把上一次会话（OpenOCD/上一次网页会话）的失败响应当成自己这条的响应。
   * 现象诡异：初始化看着正常，一写下行命令就出怪事（地址/指针全不对）。
   *
   * 做法：连发 N 条 `DAP_Disconnect`（回显 0x03，很少见），再把 N 条响应全部读掉。
   * 每一读都有对应的一条响应，所以**不会**出现"传输被弃置"（WebUSB 没有取消接口，
   * 弃置的 transferIn 会偷走下一条响应 —— 用超时去 flush 就是踩这个坑）。
   */
  async resync(n = 8){
    const req = this._framing === 'pad' ? new Uint8Array(this.pkt) : new Uint8Array(1);
    req[0] = CMD.Disconnect;
    /**
     * 🚨 这里的超时**必须短**（2026-10 复核）：正常的探针一次往返 0.2~1 ms，
     *    1500 ms 的超时只会在"探针真的不应答"时白白拖时间 —— 8 写 + 8 读最坏能安静地耗 24 s，
     *    这段时间界面完全没动静，用户看到的就是"卡住"（而且几乎每次打开探针都会走一遍 resync）。
     *    实测短超时不影响正常路径（响应来得远早于 600 ms），只把坏情况的死等砍掉 2/3。
     */
    for (let i = 0; i < n; i++){
      try { await withTimeout(this.device.transferOut(this.epOut, req), 600, 'USB 同步写'); }
      catch { dirty.add(this.device); this._note('清队列时 USB 写超时（探针不应答）'); return 0; }
    }
    let saw = 0;
    for (let i = 0; i < n; i++){
      let r;
      try { r = await withTimeout(this.device.transferIn(this.epIn, this.pkt), 600, 'USB 同步读'); }
      catch { this._note(`清队列只吃掉 ${saw} 条陈旧响应就超时了（探针没在回包）`); break; }
      if (!r.data || !r.data.byteLength) break;
      const b = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      if (b[0] === CMD.Disconnect) saw++;
    }
    if (saw) console.info(`[dap] 同步清队列：吃掉 ${saw} 条陈旧响应`);
    if (saw) this._note(`清队列：吃掉 ${saw} 条上一次会话残留的响应包`);
    return saw;
  }

  /**
   * 清 sticky 错误。
   * 🚨 读到没映射的地址会拿到 FAULT，而 **FAULT 会在 DP 里置 STICKYERR 位**，
   *    不清掉的话后面每一次 AP 访问都会继续 FAULT —— 表现成"探针突然瞎了"。
   *    写 DP ABORT 的 STKCMPERR|STKERR|WDERR|ORUNERR(=0x1E) 就是干这个的。
   */
  async abort(){
    try { await this._ctrl(CMD.WriteABORT, Uint8Array.of(0x1e, 0x00, 0x00, 0x00)); } catch {}
  }

  async setClock(hz){
    await this._ctrl(CMD.SWJ_Clock, u32leBytes(hz));
  }

  /**
   * DAP_SWJ_Sequence：按位输出一段序列（用来做 SWD 线复位）。
   * 🚨 请求格式是 `[命令, 位计数(1 字节), 数据...]`，**位计数只有 1 个字节**，
   *    且 0 表示 256（ARM 参考实现：count = *request++; if (count == 0) count = 256;）。
   *    早期按 2 字节发 → 固件把数据整体错位一格，线复位变成垃圾序列，
   *    后果是后面所有传输一路 NO ACK（本机实测踩到，排了很久）。
   */
  async swjSequence(bitCount, bytes){
    if (!(bitCount > 0 && bitCount <= 256)) throw new Error(`SWJ 序列位计数非法：${bitCount}`);
    const p = new Uint8Array(1 + bytes.length);
    p[0] = bitCount === 256 ? 0 : bitCount;
    p.set(bytes, 1);
    await this._ctrl(CMD.SWJ_Sequence, p);
  }

  /**
   * SWD 激活序列（**一次 88 位**）：JTAG→SWD 切换(0x9E 0xE7) + 线复位(64 个 1) + 空闲(8 个 0)。
   *
   * 🚨 这一步不能省、也不能拆开发：少了它 SWJ-DP 还停在 JTAG 模式，
   *    之后所有 DAP_Transfer 一律返回 **NO ACK(0x07)**（看着像"固件不应答"，其实是主机不合规）。
   *    本机 MicroLink DAPLink + STM32F103 实测：拆成 16/64/8 三次发、或把末尾空闲写成 0xFF，
   *    都会让这个探针的 SWJ 引擎进入"传输全 NO ACK"的状态 —— 必须按下面这一种写法。
   *    出处：SEGGER/pyOCD 的标准做法，也是本工作区 tools\cmsis_dap_raw.py 验证过的那份。
   */
  /**
   * SWD 激活序列 —— **照 OpenOCD 的规范形式：136 位**
   *   `FF×7 9E E7 FF×7 00`（17 字节）
   * 出处：`src/jtag/swd.h:115-125`（`swd_seq_jtag_to_swd`），v0.11.0 / v0.12.0 / 本机 dev 三版一致；
   *     详见本仓库 docs/openocd-flow.md §1。
   *
   * 早期这里是 88 位（`9E E7 FF×8 00`，11 字节），在 STM32F103 上够用（所以一直没暴露），
   * 但在 H7B0 上 SWJ-DP 的状态机不吃这一套 —— 表现为后面 DP 写一路 FAULT
   * （页面上就是那句 'SWD FAULT（…地址 0x4/0x8）'）。线复位要"足够多的连续 1"才稳：
   * OpenOCD 给的是切换前 7 字节 + 切换后 7 字节的 0xFF。
   *
   * 保留旧写法在本文件历史里（git log 可查），万一哪颗老目标只认 88 位再回退即可。
   */
  async swdActivation(){
    const data = new Uint8Array(17);
    data.fill(0xff, 0, 7);                       // 切换前：56 个 1
    data[7] = 0x9e; data[8] = 0xe7;              // JTAG-to-SWD 切换（0xE79E 低位在前）
    data.fill(0xff, 9, 16);                      // 切换后：56 个 1（线复位）
    data[16] = 0x00;                             // 8 位空闲（SWDIO 低）
    await this.swjSequence(136, data);
  }

  /**
   * 单条/多条 DAP_Transfer。ops: {ap,rnw,addr,data}[] → 读回的值数组
   * 请求布局（CMSIS-DAP 规范）：[CMD, DAP索引, 传输条数, (请求字节 + 4字节数据) × N]
   * 🚨 这里踩过：组包时漏掉「DAP索引 + 传输条数」这两个字节，固件就会把请求字节
   *    当成条数读 → 响应 count=0 / ACK=0，看起来像"目标没应答"。
   */
  async _transfer(ops, apIndex = 0){
    const count = ops.length;
    const payload = new Uint8Array(2 + count * 5);
    payload[0] = apIndex;                            // DAP 索引 = APSEL（0=AHB-AP，1=APB-AP 调试口）
    payload[1] = count;                              // 传输条数
    let o = 2;
    for (const op of ops){
      payload[o] = reqByte(op.ap, op.rnw, op.addr);
      if (!op.rnw) payload.set(u32leBytes(op.data >>> 0), o + 1);
      o += 5;
    }
    if (1 + payload.length > this.pkt) throw new Error(`DAP_Transfer 超过一个包（${1 + payload.length} > ${this.pkt}）`);
    const res = await this._ctrl(CMD.Transfer, payload);
    const n = res[0];
    const rv = res[1];
    const ack = rv & 0x07;
    const vals = [];
    for (let i = 0; i < n && 2 + i * 4 + 4 <= res.length; i++) vals.push(u32le(res, 2 + i * 4));
    if (ack !== 1){
      // 出过错之后 TAR 已自增到不可知的位置、posted 写也不可信 → 标记作废（下次访问会重写 TAR）
      this._posted = false;
      if (ack === 4){ this._faulted = true; await this.abort(); }   // FAULT → 标脏 + 清 sticky
      const err = new Error(`SWD ${ACK[ack] || ('ACK=' + ack)}（传输 ${n}/${count} 条，地址 0x${(ops[0]?.addr || 0).toString(16)}）`);
      err.ack = ack;
      throw err;
    }
    return vals;
  }

  async _transferBlock(rnw, count, addr, words, apIndex = 0){
    const req = new Uint8Array(4 + (rnw ? 0 : count * 4));
    req[0] = apIndex; req[1] = count & 0xff; req[2] = (count >> 8) & 0xff;
    req[3] = reqByte(true, rnw, addr);
    if (!rnw) for (let i = 0; i < count; i++) req.set(u32leBytes(words[i] >>> 0), 4 + i * 4);
    const res = await this._ctrl(CMD.TransferBlock, req);
    const got = res[0] | (res[1] << 8);
    const ack = res[2] & 0x07;
    if (ack !== 1){
      this._posted = false;
      if (ack === 4){ this._faulted = true; await this.abort(); }   // 同上：FAULT 必须清 sticky
      const err = new Error(`SWD 块传输 ${ACK[ack] || ('ACK=' + ack)}（${rnw ? '读' : '写'} ${count} 字 @0x${addr.toString(16)}）`);
      err.ack = ack;
      throw err;
    }
    if (rnw){
      /**
       * 🚨 只返回**响应里真正带着的那些字**。
       *    这颗探针会把块读响应截短（120 字的请求常常只回一部分）；
       *    早期写法先 `new Uint32Array(count)` 再把没填满的槽留成 0 —— 于是"读回来一堆 0"，
       *    上层拿去算地址/指针就会算出垃圾（写错地址、踩坏控制块、RTT 突然连不上）。
       *    这里按响应实际长度算能给出几个字，并把 count 也按实际值报回去，
       *    让调用方（_readMemOnce）能正确地"接着读完剩下的"。
       */
      const avail = Math.max(0, Math.floor((res.length - 3) / 4));
      const n2 = Math.min(count, avail);
      const out = new Uint32Array(n2);
      for (let i = 0; i < n2; i++) out[i] = u32le(res, 3 + i * 4);
      return { count: Math.min(got, n2), words: out };
    }
    this._posted = true;                                   // DRW 写是 posted：改 TAR 前必须冲
    return { count: got, words: null };
  }

  // ---------------- 目标初始化 ----------------
  /**
   * 让 SWD 链路可用。顺序**逐条对齐**验证过能跑通的裸客户端（tools\cmsis_dap_raw.py）：
   *   Connect(SWD) → SWJ_Clock → **SWD_Configure** → **SWJ_Sequence(88 位激活)** → TransferConfigure
   * 少一步都不行：早期版本漏了 SWD_Configure、把激活序列拆成三次发，结果所有传输 NO ACK。
   */
  async _targetInit({ clock = null } = {}){
    const hz = Number(clock || this.clockHz || 1_000_000);
    this._posted = false;                             // 新会话：未完成的 posted 写作废
    const port = await this._ctrl(CMD.Connect, Uint8Array.of(1));      // 1 = SWD
    if (port[0] !== 1) throw new Error(`DAP_Connect 失败（返回 ${port[0]}，期望 1=SWD）`);
    await this.setClock(hz);
    await this._ctrl(CMD.SWD_Configure, Uint8Array.of(0));             // turnaround=1 / data_phase=0
    await this.swdActivation();                                       // 88 位激活序列（关键！）
    // 🚨 激活后第一个包必须是「读 IDCODE」（写会 NO ACK，见 docs/backends.md 坑②），
    //    所以清 sticky 的 ABORT 要排在 IDCODE 读取之后、第一条 AP 访问之前
    await this._ctrl(CMD.TransferConfigure, Uint8Array.of(0, 0xe8, 0x03, 0, 0));  // idle=0, retry=1000

    /**
     * 🚨 **线复位之后的第一个 SWD 包必须是「读 DP IDCODE」**（ARM SWD 协议的激活步骤）。
     *    少了这一笔，后面任何访问（哪怕是写 DP SELECT）都返回 NO ACK(0x07) ——
     *    现象极具误导性："包头完全正确、探针也回 ACK 字段，但就是 NO ACK"。
     *    本机是靠在页面上做参数扫描（tools\selftest\debug-sweep.mjs）才定位到的：
     *      激活序列 + 第一笔读 IDCODE → ack=1；
     *      激活序列 + 第一笔写 SELECT → ack=7。
     */
    const id = await this._transfer([{ ap: false, rnw: true, addr: DP_IDCODE }]);
    this.idcode = (id[0] >>> 0);
    if (!this.idcode || this.idcode === 0xffffffff){
      throw new Error(`读 DP IDCODE 失败（0x${this.idcode.toString(16)}）→ SWD 没连上：接线/复位/时钟都要看一眼`);
    }
    // 注：不要在这里插 ABORT 清 sticky —— 本探针的 DP 状态机对激活后中途 ABORT 敏感
    // （实测 SELECT 写会 FAULT）。sticky 清理靠失败路径的 reopen()/abort()。

    // DP SELECT = 0 放到上电**之后**写（pyOCD 也是这个顺序）：
    // 上电前写 SELECT 在目标/探针状态不干净时会直接 FAULT（实测「SWD FAULT（…地址 0x8）」
    // 就是这么来的，一 FAULT 整条链路就废）。
    // AP 访问前必须给 DP 上电（pyOCD 的 DebugPortSetup 就是干这个）。
    // 先走正常路径（纯上电 + 清 sticky 重试）；只有它连着失败，才动用「掉电-上电」最后手段。
    try {
      await this._powerUpDP();
    } catch (e){
      console.warn(`[dap] DP 上电失败（${e.message}），改用掉电-上电最后手段`);
      await this.powerCycle();
    }
    /**
     * 🚨 **APSEL 不能硬编码 0**。同一份代码要在不同芯片上跑：
     *    · STM32F103 —— CM3 内存挂在 **AP0**；
     *    · STM32H7B0 —— CM7 内存挂在 **AP2**（OpenOCD 自己的日志就是
     *      `Info : [stm32h7x.ap2] Examination succeed`）。
     *    硬写 0 的后果：H7B0 上写 CSW 直接 FAULT（不存在的 AP），而 F103 一路正常，
     *    于是表现成"页面在 F103 好、在 H7 坏"。这里照 OpenOCD 的做法扫一遍 APSEL：
     *    写 SELECT → 写 CSW(0x23000052) → 写 TAR=0xE000ED00 → 读 DRW，
     *    **谁能返回合理的 CPUID 就用谁**（只看 ACK 不够：H7B0 上不存在的 AP0 也会"回 ACK"，
     *    但读出来是 0x9576B58B 这种垃圾）。顺序 [0,2,1,3]：F103 第一下就中。
     */
    this.apIndex = 0;
    for (const ap of [0, 2, 1, 3]){
      /**
       * CSW 也一起扫候选值 —— 出处 docs/openocd-flow.md（:1825/:1832/:1871）：
       *   OpenOCD 的 `CSW_AHB_DEFAULT` = 0xA2000000（bit31/29/25），块读写再 |0x12 → **0xA2000012**；
       *   而 **STM32H7 上它实际下发的是 0xAA000012（bit27 也置 1）**。
       *   本文件旧值 0x23000052 是另一套 Prot 位（bit24 而非 bit31、没有 bit27）——
       *   在 F103 上凑巧能用，在 H7 上写下去直接 FAULT。这里按"常用 → H7 → 旧值"依次试。
       */
      for (const csw of [0xa2000012, 0xaa000012, 0x23000052]){
        try {
          await this._transfer([{ ap: false, rnw: false, addr: DP_SELECT, data: (ap << 24) >>> 0 }]);
          await this._transfer([{ ap: true, rnw: false, addr: AP_CSW, data: csw >>> 0 }]);
          await this._transfer([{ ap: true, rnw: false, addr: AP_TAR, data: 0xE000ED00 }]);
          const v = ((await this._transfer([{ ap: true, rnw: true, addr: AP_DRW }]))[0]) >>> 0;
          if (v && v !== 0xffffffff){ this.apIndex = ap; this.cswUsed = csw; break; }
        } catch (e){ /* 这组不行，试下一个 */ }
        try { await this._transfer([{ ap: false, rnw: false, addr: 0x00, data: 0x0000001e }]); } catch {}
      }
      if (this.cswUsed) break;
      try { await this._transfer([{ ap: false, rnw: false, addr: 0x00, data: 0x0000001e }]); } catch {}
    }
    await this._transfer([{ ap: false, rnw: false, addr: DP_SELECT, data: (this.apIndex << 24) >>> 0 }]);
    await waitMs(20);            // 真实 20 ms（不受后台节流影响，见 pace.js）
    /**
     * ⚠️ **不要在这里用 DP CTRL/STAT 的读值去判断"上电成功没有"**（这一段曾经这么做，
     *    结果整晚排查方向跑偏，记录在此）：
     *      · 本探针在刚做完一串 AP 读之后，`_readDP(CTRL/STAT)` 会**稳定地**回一个残留值
     *        （实测拿到 AP 读出来的 CPUID `0x411FC271`，连读两遍都一样），
     *        于是日志里刷"DP 电源应答位没起来"，而实际上 AP 访问一切正常；
     *      · 而且 ACK 位本来就该看 **bit31 = CSYSPWRUPACK、bit29 = CDBGPWRUPACK**
     *        （bit30/28 是 REQ 位），别按名字猜。
     *    现在的策略与 OpenOCD 一致（见 docs/openocd-flow.md 的 dap_dp_init）：
     *    **写了电源请求就不判死**，让第一笔 AP 访问去证伪 —— 上面 APSEL 扫描能读到合理 CPUID
     *    就已经证明上电成功了。
     */
    await this._readDP(DP_CTRL_STAT);        // 保留一次读当"落地屏障"，不看结果
    // CSW：32 位 + 单次自增（保留其它位）
    const csw = await this._readAP(AP_CSW);
    const want = (csw & ~0x3f) | 0x02 | 0x10;
    if (want !== csw) await this._writeAP(AP_CSW, want);
    this.csw = want;
  }

  /** DP 读是「挂起读」：读一次拿的是上一次的结果，所以读两遍 */
  async _readDP(addr){
    await this._transfer([{ ap: false, rnw: true, addr }]);
    const v = await this._transfer([{ ap: false, rnw: true, addr: DP_RDBUFF }]);
    return v[0] >>> 0;
  }
  async _readAP(addr, apIndex = 0){
    const v = await this._transfer([{ ap: true, rnw: true, addr }], apIndex);
    return v[0] >>> 0;
  }
  async _writeAP(addr, val, apIndex = 0){
    await this._transfer([{ ap: true, rnw: false, addr, data: val }], apIndex);
    this._posted = true;                              // AP 写按 posted 处理，改 TAR 前冲一次最稳
  }
  /** 写 DP 寄存器（调试口的选择/控制都在这里，如 DP_SELECT 的 APSEL 字段） */
  async _writeDP(addr, val){
    await this._transfer([{ ap: false, rnw: false, addr, data: val >>> 0 }]);
  }

  /**
   * 给调试口上电：写 DP CTRL/STAT 的 **CDBGPWRUPREQ(bit28) | CSYSPWRUPREQ(bit29)**。
   *
   * 🚨 **两个请求位都要置**（bit28 CDBGPWRUPREQ | bit30 CSYSPWRUPREQ = `0x50000000`）。
   *    历史上这里记错过位号、写出过 0x70000000 / 0xC0000000（给只读 ACK 位写 1、漏请求位）：
   *      · STM32F1（Cortex-M3）容忍错误写法，所以一直没暴露；
   *      · **STM32H7B0（Cortex-M7）不容忍**：系统电源没请求 → AP 访问直接 FAULT，
   *        表现和"SWD 连不上"一模一样（实测：H7 上电写错值 → `SWD FAULT（地址 0x4）`）。
   *    下面那两个字面量（`0x50000022` / `0x50000000`）就是正确值，别再"顺手优化"。
   *
   * 🚨 **千万别先写 0「掉电」再上电**（6bba430 加过这一步，直接把 RTT 连接搞挂）：
   *    本机 MicroLink(CherryUSB) + STM32F103 实测，掉电写之后那个上电写会稳定返回
   *    **FAULT(4)**（浏览器线级抓包与裸客户端两边都复现），而 _transfer 见 FAULT 就抛
   *    → 现象正是「RTT 总是连不上，偶尔又能连上」。更糟的是炸过一次之后 DP 停在
   *    「掉电已请求 + sticky」，下一次连接照样炸 —— 自锁（3209a87 之前没有这步，一直很稳）。
   *    网页里 sleep(50) 还会被后台节流成 ~200ms，掉电更彻底、命中率更高。
   * 这里保留一次「清 sticky 再重试」的兜底：万一真撞上 FAULT 也能自己爬起来。
   */
  async _powerUpDP(attempts = 3){
    /**
     * **照 OpenOCD 的 dap_dp_init 抄**（出处见 docs/openocd-flow.md，含 文件:行号）：
     *   ① 无条件写 `DP_CTRL_STAT = CDBGPWRUPREQ|CSYSPWRUPREQ|SSTICKYERR|SSTICKYORUN`
     *      = **0x50000022** —— 关键就是最后两位 sticky 清除位：
     *      **带着 sticky 的 DP 会拒绝写**，所以"先 ABORT 清、再写 0x50000000"那条路是死路
     *      （页面实测：写 CTRL/STAT 恒 FAULT）；OpenOCD 是**一笔写里同时请求上电 + 清 sticky**。
     *   ② 轮询 CTRL/STAT 等 PWRUPACK（应答位是 **bit31 CSYSPWRUPACK / bit29 CDBGPWRUPACK**；
     *      本机 H7B0 上这两位可能一直是 0，所以**只当参考**，不通过也继续 ——
     *      OpenOCD 能跑通就证明 AP 可用性与这两位不必绑定）。
     *      ⚠️ 下面的判定掩码 `0x30000000` 是**错的**（bit29|bit28：把请求位当应答）——
     *      正确应为 `0xA0000000`。改它要动探针 bring-up，必须逐块板子真机验，故暂留（见文件头 ②）。
     *   ③ 再写一次 `0x50000000`（撤掉 sticky 清除位，保留电源请求）——与 OpenOCD 一致。
     */
    for (let i = 0; i < attempts; i++){
      try {
        await this._writeDP(DP_CTRL_STAT, 0x50000022);
      } catch (e){
        if (e.ack !== 4) throw e;
      }
      let st = 0;
      for (let k = 0; k < 20; k++){
        try { st = ((await this._transfer([{ ap: false, rnw: true, addr: DP_CTRL_STAT }]))[0]) >>> 0; } catch { st = 0; }
        if ((st & 0x30000000) === 0x30000000) break;
        await waitMs(10);
      }
      try { await this._writeDP(DP_CTRL_STAT, 0x50000000); } catch {}
      this.lastDpStat = st;
      if ((st & 0x30000000) === 0x30000000) return true;
      try {
        await this.swdActivation();
        await this._transfer([{ ap: false, rnw: true, addr: DP_IDCODE }]);
      } catch {}
      await waitMs(20);
    }
    return true;   // 不判死：让第一笔 AP 访问去证伪（OpenOCD 也不因 ACK 缺失就放弃）
  }

  /**
   * 掉电 → 上电：**只在 recover() 里当最后手段**，用来清「上一个会话（被 kill 的 OpenOCD 等）
   * 把 DP 楔死」这种顽固状态。⚠️ 它在部分目标上会让上电写 FAULT（见 _powerUpDP），
   * 所以正常连接路径一律走 _powerUpDP()。
   */
  async powerCycle(){
    try { await this._writeDP(DP_CTRL_STAT, 0x00000000); } catch {}
    await waitMs(30);
    return await this._powerUpDP(3);
  }

  /**
   * 把 pending 的 **posted 写**冲干净。
   *
   * 做法：读一次 **DP 的 RDBUFF**。ARM 规定读它会让此前所有 posted 的 AP 事务完成，
   * 而且它是 DP 读，**不会**把数据塞进 AP 的挂起读流水线。
   *
   * 🚨 千万别用「读 AP DRW」来冲（前一版就是这么写的，栽了）：AP 的读是**挂起读**
   *    （读回的是上一次读事务的结果），读一次 DRW 会把刚写进去的数据挂到流水线上，
   *    紧接着的下一次块读就会把**头几个字读成这些旧数据**。
   *    实测现场：下行写完 "help\r" 后再读 RTT 控制块，读回来的前 8 字节正是 "help\r\0\0\0"
   *    → 控制块被判"缓冲指针无效(0xd)" → 连接直接失败（看着像"RTT 又连不上了"）。
   */
  async _flushPosted(){
    if (!this._posted) return;
    this._posted = false;
    await this._transfer([{ ap: false, rnw: true, addr: DP_RDBUFF }]);
  }

  /**
   * 把还没落地的 posted 写**逼着落地**（公开给 flashloader 用）。
   * 场景：算法要读的那块 RAM 缓冲刚由主机写进去，如果那笔写还挂在 AP 的写缓冲里，
   * 算法（目标侧直接读 RAM）就会读到**上一页的内容** → 烧进去的是旧数据 → 校验失败。
   */
  async flushWrites(){
    await this._flushPosted();
  }

  /**
   * 设置 AP 的 TAR（目标地址）—— **每次块访问前都必须写**，不做「地址没变就跳过」的缓存。
   *
   * 🚨 为什么不能省（本机 MicroLink(CherryUSB) + STM32F103 实测，裸客户端与网页两边都复现）：
   *    这条链路的 CSW 开着地址自增（AddrInc=1），**每次 DRW 访问都会让 TAR 往前走**，
   *    而且访问完不会自己回来。所以"地址没变就不用重写 TAR"是错的 ——
   *    同址连读第 2 次起读回来的就是**后面几个字**的内容，表现为 RTT 日志"错位/跳相位"：
   *    这正是 60ccc42 / 93838d7 / 6bba430 一路在追的「错位读」。
   *    对照实测（tmp/dap_tar_repeat.py）：
   *      · 每次重写 TAR → 同址连读 5 次全部是 "SEGGER RTT"（正确）
   *      · 不重写 TAR   → 第 1 次对，第 2 次起读到 CB+16 / CB+32 的内容（错）
   *    注：跨块的多字块读靠的就是这个自增，所以**同一个 TAR 内**连续 TransferBlock 是对的；
   *    要换地址时重写一次即可。
   *
   * 另外：改 TAR 之前先把上一笔 posted（后发）的 DRW 写冲干净，否则那笔写会落到新地址上
   * （烧录器「固件能写、某个寄存器写不进去」就是这么来的）。
   */
  async _setTAR(addr, apIndex = 0){
    await this._flushPosted();
    await this._transfer([{ ap: true, rnw: false, addr: AP_TAR, data: addr >>> 0 }], apIndex);
    /**
     * ⚠️ 这里**不要**再插任何"屏障读"，两种都试过、都更糟：
     *   · 读 AP CSW / AP DRW（6bba430 与后来我都试过）：AP 读是**挂起读**，
     *     会把旧值顶进读流水线 → DHCSR 轮询报「S_REGRDY 没置位」、RTT 直接连不上；
     *   · 读 DP RDBUFF：不污染 AP 流水线，但实测会让 `_targetInit` 里的
     *     「写 DP SELECT」直接 FAULT（SWD FAULT，地址 0x8）。
     * 现状策略（实测可用）：TAR 每次都重写 + posted 写用 DP RDBUFF 冲（只在写之后、改 TAR 之前），
     * 写操作靠 writeMem 的回读确认兜底。
     */
  }

  // ---------------- 内存访问（RTT 只用到这两个） ----------------
  /**
   * 读目标内存。
   *
   * 🚨 **地址必须先 `>>> 0` 归一化**：JS 的位运算（`& ~3`）是 **32 位有符号**的，
   *    地址一旦 ≥ 0x80000000（PPB 区就是，例如 DHCSR=0xE000EDF0）就会变成负数，
   *    而 `addr` 本身还是正数 → `addr - start` 差出 2^32 → `subarray` 越界 →
   *    **返回空数组**（不是报错！）。后果极隐蔽：
   *      · `isHalted()` 永远读不到 S_HALT → 看门狗以为目标在跑，不去唤醒被 halt 的目标；
   *      · flashloader 的 `regRead/regWrite` 永远读不到 S_REGRDY → 报
   *        「调试寄存器同步超时（S_REGRDY 没置位）」——就是烧录器"某个寄存器写不进去"的真身
   *        （其实写进去了，是**读回**全空）。
   *    → 本函数与 writeMem 一律先把 addr 归一化成无符号，start/end 也 `>>> 0`。
   */
  /**
   * 把一段内存访问**串行化**。
   *
   * 🚨 为什么必须有：页面里同时有两条路径在碰同一个探针 —— RTT 轮询循环（读上行缓冲 + 推进 RdOff）
   *    和用户的下行发送（读下行表项 + 写数据 + 写 WrOff）。两者都在 await 处让出，**交错执行**；
   *    而 TAR、AP 挂起读流水线、posted 写都是**探针/AP 上的共享状态**：
   *      A 写了 TAR=X → B 写 TAR=Y → A 的读落到 Y 上 → A 拿到垃圾（读出的 WrOff/size 是假的）
   *      → 命令写丢（实测：页面"发送成功"、固件一个字节都没收到）。
   *    早期之所以"偶尔好偶尔坏"，就是因为交错窗口时大时小。
   *    这里用一条 promise 链互斥，保证一次内存访问序列跑完再让下一个进来。
   *
   * 🚨 **不要给这个锁加"可重入快路径"**（曾经有：`if (this._locked) return await fn();`）。
   *    锁分不清"内部重入"和"外部并发"：A 在锁内 await USB 期间，用户点下行发送 / 复位 / 看门狗
   *    调进来的 B 会看到 `_locked === true` 而**直接执行** —— TAR、AP 挂起读流水线、posted 写
   *    照样交错，正好是上面那段注释描述的"命令写丢"。
   *    内部需要嵌套的地方（写后回读、非对齐读-改-写）直接调 `_readMemLocked` / `_writeMemLocked`，
   *    让这个锁只服务外部入口（`readMem` / `writeMem`）。
   *    回归测试：`tools/selftest/rtt.test.mjs`「并发调用必须排队」那一节用挂起的 A + 外部 B 钉住。
   */
  async _withLock(fn){
    let release;
    const prev = this._lockChain || Promise.resolve();
    this._lockChain = new Promise(r => { release = r; });
    await prev;
    this._locked = true;
    try { return await fn(); }
    finally { this._locked = false; release(); }
  }

  async readMem(addr, len, apIndex = 0){
    await this._healIfFaulted();                 // 上次撞过 FAULT → 先把口子修回来（锁外做）
    return await this._withLock(() => this._readMemLocked(addr, len, apIndex));
  }

  /** Fault diagnostics must preserve the scene: never initialize/heal the target transport. */
  async readMemDiagnostic(addr, len){
    if (this._faulted || this._recovering) throw new Error('调试口已有 FAULT／正在恢复；诊断未重新初始化目标');
    return this._withLock(() => {
      if (this._faulted || this._recovering) throw new Error('调试口已有 FAULT／正在恢复；诊断未重新初始化目标');
      return this._readMemLocked(addr, len, 0);
    });
  }

  async regReadDiagnostic(regsel){
    if (this._faulted || this._recovering) throw new Error('调试口已有 FAULT／正在恢复；诊断未重新初始化目标');
    return this._withLock(async () => {
      if (this._faulted || this._recovering) throw new Error('调试口已有 FAULT／正在恢复；诊断未重新初始化目标');
      const read = a => this._readMemLocked(a, 4, 0);
      if (!((await read(0xe000edf0))[2] & 2)) throw new Error('目标已运行；诊断未暂停内核');
      // DCRSR selects a register for reading; no DHCSR execution control or register write.
      await this._writeMemLocked(0xe000edf4, new Uint8Array([regsel & 0x1f, 0, 0, 0]), 0);
      for(let i=0;i<50;i++){
        if((await read(0xe000edf0))[2] & 1){
          const b=await read(0xe000edf8); if(b.length!==4)throw new Error('诊断寄存器短读');
          return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);
        }
        await waitMs(2);
      }
      throw new Error('诊断寄存器读取超时');
    });
  }

  /** Explicit opt-in vector catch; preserve every other DEMCR bit. */
  async setHardFaultCatch(enabled){
    if(this._faulted || this._recovering)throw new Error('调试口异常，未配置 HardFault 捕获');
    return this._withLock(async()=>{
      if(this._faulted || this._recovering)throw new Error('调试口异常，未配置 HardFault 捕获');
      const read=async()=>{const b=await this._readMemLocked(0xe000edfc,4,0);return new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);};
      const before=await read(), original=!!(before & (1<<10));
      try{
        const after=enabled ? before|(1<<10) : before&~(1<<10);
        if((after>>>0) !== before)await this._writeMemLocked(0xe000edfc,u32leBytes(after>>>0),0);
        if(!!((await read())&(1<<10))!==!!enabled)throw new Error('HardFault 捕获位写入未得到确认');
        return original;
      }catch(e){e.originalCatch=original;throw e;}
    });
  }

  /**
   * 读目标内存（按数据量分级决定"要不要防一手"）。
   *
   * 2026-09-27 调过两轮：早先不分大小一律读两遍，大流量读取成本直接翻倍
   * （8MHz 下 330 KB/s 掉到 154 KB/s）。现在的策略：
   *   · 小块（≤ 64B）且是 PPB 或非快速档 → **双读比对**（状态位读错会误判 halt/REGRDY）。
   *   · 其余（含大块）→ 单读；脏数据由上层结构校验兜（Rtt._entry 会校验 size/pbuf/wr/rd）。
   * 🚨 曾经想给大块读加"prime 读两个字顶掉流水线残渣"，**这是错的**：prime 会让 TAR 自增 8 字节，
   *    紧接着的正式读从 start+8 开始，整段错位（实测烧录校验报"0x8000000 处读到 0xb9，期望 0x0"，
   *    0xb9 正是偏移 8 处的字节）。所以 `_readMemOnce` 里**没有** prime 参数，别再把它加回来。
   * 另外地址必须先 `>>> 0` 归一化：JS 位运算（`& ~3`）是 32 位有符号的，
   * 地址 ≥ 0x80000000（PPB 区，如 DHCSR=0xE000EDF0）会变负数 → subarray 越界 → 返回空数组。
   */
  async _readMemLocked(addr, len, apIndex = 0){
    addr = addr >>> 0;
    const small = len > 0 && len <= 64;
    const ppb = addr >= 0xE0000000;          // DHCSR / DCRSR / DCRDR…（承载状态位）
    /**
     * 🚨 PPB 区小块读**任何档位都双读**：这些寄存器读的是**状态位**
     *    （S_HALT / S_REGRDY），单读一次拿到残渣就会误判：
     *      · isHalted() 假 false → flashloader 白等到超时；
     *      · isHalted() 假 true  → 算法还没跑完就往下走 → 擦/写叠在一起 → **校验失败**
     *        （用户实测「读到 0xad，期望 0x0」就是这一类）。
     * RAM 的小块读（RTT 表项）在快速档下单读 —— 上层 Rtt._entry 会做结构校验，
     * 不合理才重读；这一档省下的往返直接变成 RTT 吞吐。
     */
    if (small && (ppb || !this.fast)){
      const first = await this._readMemOnce(addr, len, apIndex);
      const second = await this._readMemOnce(addr, len, apIndex);
      if (first.length === second.length){
        let same = true;
        for (let i = 0; i < first.length; i++){ if (first[i] !== second[i]){ same = false; break; } }
        if (same) return second;
      }
      return await this._readMemOnce(addr, len, apIndex);   // 不一致：再读一遍取最新
    }
    // 大块读（>64B）：单读就够 —— 见 _readMemOnce 里"不要加 prime"的实测记录
    return await this._readMemOnce(addr, len, apIndex);
  }

  async _readMemOnce(addr, len, apIndex = 0){
    addr = addr >>> 0;
    if (len <= 0) return new Uint8Array(0);
    if (len > (1 << 20)) throw new Error(`一次要读 ${len} 字节（>1MB），地址参数大概是错了`);
    const start = (addr & ~3) >>> 0;
    const end = ((addr + len + 3) & ~3) >>> 0;
    const bytes = new Uint8Array(end - start);
    const dv = new DataView(bytes.buffer);
    let a = start;
    /**
     * 🚨 这里**不要**加"prime 读"（写完 TAR 先读几个字丢掉）。
     *    我试过：prime 读 2 个字 → TAR 自增 8 字节 → 紧接着的正式读就从 **start+8** 开始，
     *    整段数据错位 8 字节。实测现象极有辨识度：烧录校验报
     *    「0x8000000 处读到 0xb9，期望 0x0」—— 而 0xb9 正是偏移 8 处的字节。
     *    教训：这颗探针的读**没有**"挂起读"滞后（读了就是读到的地址），
     *    之前遇到的脏数据都来自 TAR 没落地/自增绕回/读写并发，那些已分别修掉了。
     */
    while (a < end){
      const words = Math.min(this.maxWords, (end - a) >> 2, this._wordsToBoundary(a));
      if (words <= 0) break;
      // 🚨 **每块都重设 TAR**：自增只在"写 TAR 时那个 1KB 块"内有效（见 _wordsToBoundary 的实测记录）
      await this._setTAR(a, apIndex);
      const { count: got, words: vals } = await this._transferBlock(true, words, AP_DRW, null, apIndex);
      /**
       * 🚨 探针**会把块读响应截短**（本机 120 字的请求常常只回一部分），
       *    早先的写法把没填到的字**静默留成 0** —— 于是"校验读到 0x0，其实 flash 是对的"。
       *    这里按响应里真实返回的条数推进，接着把剩下的读完（TAR 已自增）。
       */
      const n = Math.min(got, words, vals.length);
      for (let i = 0; i < n; i++) dv.setUint32(a - start + i * 4, vals[i] >>> 0, true);
      if (n === 0) break;
      a += n * 4;
    }
    return bytes.subarray(addr - start, addr - start + len);
  }

  /**
   * 一次块访问最多能走几个字：**不许跨 1KB 边界**。
   *
   * 🚨 ADIv5 的 TAR 自增是**有界**的，而且这个"界"比很多人以为的小得多。2026-09 用
   *    "自描述字"（每个字写成 `0xAD000000 | 它本应去的地址`，读回来就知道跑到哪了）在这块
   *    H7B0 + akaLinkPro 上实测，一次 DAP_TransferBlock 内：
   *      · 起点 0x20000200 走 64 字（不跨界）→ **逐字正确**；
   *      · 起点 0x200003F0 走 8 字（跨 0x400）→ 前 4 字对，**后 4 字跑到 0x20000000**（块首！）；
   *      · 起点 0x20000FF0 走 8 字（跨 0x1000）→ 前 4 字对，**后 4 字跑到 0x20000C00**（块首！）。
   *    → 规则唯一解：**自增只在"最后一次写 TAR 时所在的那个 1KB 块"内有效**
   *      （TAR[31:10] 钉死、TAR[9:0] 回绕到块首），这正是 ADIv5 规范的说法。
   *
   *    踩过的坑（本条是本项目最贵的一个）：以前按"4KB 回绕"处理，只在 4KB 边界重设 TAR。
   *    H7B0 的页缓冲在 0x200003F0、一页 8KB —— 数据越过 0x400 就回绕回 0x20000000，
   *    **把算法自己的代码整个覆盖掉**，于是内核跑到 pc_program_page 取到垃圾指令 →
   *    IACCVIOL → HardFault → 界面报「flashloader 执行超时」。F103 的页缓冲在 0x1000
   *    正好是 4KB 对齐、2KB 一页也在块内，所以只有 H7 中招（"只有某块板子坏"的典型来源）。
   *    更阴的是：读路径有同一个 bug，写坏之后**读回来也"一致"**，自校验反而通过 ✗。
   *
   *    现在的纪律：**每块都重写 TAR**（块已按 1KB 收窄，块内自增绝对安全）。
   *    代价是每 ≤120 字多一次 DP 写，实测对 RTT 吞吐无感。
   */
  _wordsToBoundary(a){
    const next = (a + 1024) & ~1023;          // 下一个 1KB 边界
    return Math.max(0, (next - a) >> 2);
  }

  /**
   * 写目标内存。写完**回读确认**，不一致就重写一次（最多一次）。
   *
   * 🚨 为什么值得多花这一趟：这颗探针的写偶发不落地（posted 写 + 地址自增的锅），
   *    而"写了没生效"在下游的表现千奇百怪 —— RTT 下行命令石沉大海、
   *    flashloader 参数寄存器写丢导致算法跑飞。回读一遍就能发现并补救。
   *    只影响 RAM/调试寄存器的写（都是幂等的），不会对 flash 重复编程。
   */
  async writeMem(addr, bytes, apIndex = 0){
    await this._healIfFaulted();                 // 同 readMem：上次撞过 FAULT 就先修口子
    return await this._withLock(() => this._writeMemLocked(addr, bytes, apIndex));
  }

  async _writeMemLocked(addr, bytes, apIndex = 0){
    addr = addr >>> 0;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!data.length) return;
    await this._writeMemOnce(addr, data, apIndex);
    if (this.verifyWrites === false) return;      // 排障开关（默认开）
    /**
     * 回读确认：**严格档每次都做；快速档只对"换了地址的写"做**。
     *   · 严格档（烧录 / 用户手动动作）：flashloader 每页都写同一个 RAM 缓冲，
     *     那笔 posted 写必须被这次回读逼着落地，否则算法读到上一页 → 校验失败；
     *   · 快速档（RTT 轮询每轮推进 RdOff，地址固定）：省掉这次回读换吞吐 ——
     *     写没生效的后果只是"缓冲水位上升/溢出丢弃"，界面本来就有这两个指标。
     */
    if (this.fast && addr === this._lastWriteAddr) { this._lastWriteAt = Date.now(); return; }
    this._lastWriteAddr = addr; this._lastWriteAt = Date.now();
    try {
      // 私有版本：这条路已经在锁里了，再走 public readMem() 会自锁死（锁不再可重入）
      const back = await this._readMemLocked(addr, data.length, apIndex);
      let same = back.length === data.length;
      if (same) for (let i = 0; i < data.length; i++){ if (back[i] !== data[i]){ same = false; break; } }
      if (!same){
        console.warn(`[dap] 写 0x${addr.toString(16)}（${data.length}B）回读不一致，重写一次`);
        await this._writeMemOnce(addr, data, apIndex);
      }
    } catch (e){ /* 回读失败不阻断写（可能只是读抖动） */ }
  }

  async _writeMemOnce(addr, data, apIndex = 0){
    if ((addr & 3) === 0 && (data.length & 3) === 0){
      const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
      let i = 0;
      while (i < words.length){
        const at = (addr + i * 4) >>> 0;
        const n = Math.min(this.maxWords, words.length - i, this._wordsToBoundary(at));
        if (n <= 0) break;
        await this._setTAR(at, apIndex);       // 🚨 每块重设：自增只在"写 TAR 时那个 1KB 块"内有效
        await this._transferBlock(false, n, AP_DRW, words.subarray(i, i + n), apIndex);
        i += n;
      }
      return;
    }
    // 非对齐 → 读-改-写（RTT 下行缓冲的写指针可能不是 4 的倍数）
    const start = (addr & ~3) >>> 0;
    const end = ((addr + data.length + 3) & ~3) >>> 0;
    const cur = await this._readMemLocked(start, end - start, apIndex);   // 同上：用私有版本（已在锁内）
    cur.set(data, addr - start);
    const words = new Uint32Array(cur.buffer, cur.byteOffset, cur.length >> 2);
    let i = 0;
    while (i < words.length){
      const at = (start + i * 4) >>> 0;
      const n = Math.min(this.maxWords, words.length - i, this._wordsToBoundary(at));
      if (n <= 0) break;
      await this._setTAR(at, apIndex);         // 同上：每块重设
      await this._transferBlock(false, n, AP_DRW, words.subarray(i, i + n), apIndex);
      i += n;
    }
  }

  // ---------------- 目标控制 ----------------
  /**
   * 运行/停止目标：写 Cortex-M 的 DHCSR(0xE000EDF0)，高 16 位键值 0xA05F 必填。
   *   C_DEBUGEN(bit0)=1 且 C_HALT(bit1)=0 → 运行；C_HALT=1 → 停止。
   * 🚨 为什么需要它：DAPLink 的 DAP_ResetTarget 之后目标常常**停在 halt 状态**
   *    （"复位并停住"是调试器的常规语义），于是 RTT 连得上、控制块也读得到，
   *    但固件不跑 ⇒ 一个字节都不来。本页的复位按钮 = 复位并运行，靠的就是这个。
   * 注：DHCSR 在 AP0（AHB-AP）经 PPB 总线可达，与 RAM 同一条 AP——但必须吃 _setTAR
   *    里的屏障读，否则 TAR 竞态会让写丢失/读回 0（烧录器的寄存器访问曾栽在这里）。
   */
  async _dhcsr(value){
    await this._setTAR(0xE000EDF0);
    await this._transferBlock(false, 1, AP_DRW, Uint32Array.of(value >>> 0));
  }

  /** 读一个 32 位字（内部用；地址已归一化） */
  async _readWord(addr){
    const b = await this.readMem(addr, 4);
    return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
  }

  /**
   * 运行/停止目标。
   * 写完**回读确认**（这颗探针的 AP 写偶发不落地），但确认失败**只警告不抛错**：
   * 读回来的 DHCSR 本身也可能是滞后的旧值（实测内核明明在跑、回读却说 C_HALT=1），
   * 为此中断整个烧录流程不划算 —— 真正的判据交给调用方（如 flashloader 的 isHalted 轮询）。
   */
  async run(){
    await this._clearMaskintsIfSet();        // 单步残留会让中断再也进不来（见该函数说明）
    for (let i = 0; i < 3; i++){
      await this._dhcsr(0xA05F0001);                       // C_DEBUGEN=1, C_HALT=0
      const v = await this._readWord(0xE000EDF0);
      if (((v >>> 1) & 1) === 0) return;                   // C_HALT=0：确实在跑
      await waitMs(10);                                    // 真实 10 ms（后台节流会把 sleep(10) 钳成 1 s）
    }
    console.warn('[dap] 让目标运行的回读一直显示 C_HALT=1（可能是读滞后）——继续，不中断流程');
  }

  /**
   * 起跑前清掉**单步残留**的 `C_MASKINTS`（DHCSR bit3）—— 只在真的置位时才动手。
   *
   * 🚨 为什么值得单独设一道闸（2026-10-03 F103ZE 真机定因）：
   *    `DebugSession._stepByDhcsr()` 写的是 `C_HALT|C_STEP|C_MASKINTS`，而这颗探针/内核
   *    **不执行 C_STEP**；那一位就留在 DHCSR 里，而它**只在核已经停住时可写** ——
   *    之后写"运行"的值（`0xA05F0001`，里面 MASKINTS=0）**清不掉它**。
   *    后果：核带着"中断屏蔽"一直跑 —— SysTick 不再触发（`g_ticks` 冻住）、主循环照跑
   *    （`g_loops` 照涨），于是**任何下在中断里的断点永远不可能命中**，而"目标看起来活着"。
   *    实测：坏状态 DHCSR=0x1010009 → 这里写一次 0xA05F0003 即回到 0x30003 →
   *    下一次运行 Δticks 立即恢复（4142）、中断里的断点 406 ms 命中。
   *    正常路径只多一次 DHCSR 读（~0.3 ms），不动状态。
   *
   * @returns {Promise<boolean>} 是否真的清了一次
   */
  async _clearMaskintsIfSet(){
    if (this._locked) return false;      // 锁里被调用：不再发起内存访问（readMem 会等锁 → 自锁死）
    try {
      const v = (await this._readWord(0xE000EDF0)) >>> 0;
      if (((v >>> 3) & 1) !== 1) return false;
      await this._dhcsr(0xA05F0003);                        // C_HALT=1 + MASKINTS=0：此刻核停着 → 该位可写
      this._note('清掉遗留的 C_MASKINTS（单步残留）—— 不清的话中断再也进不来，中断里的断点永远不会命中');
      return true;
    } catch { return false; }
  }
  async halt(){
    for (let i = 0; i < 3; i++){
      await this._dhcsr(0xA05F0003);                       // C_DEBUGEN=1, C_HALT=1
      const v = await this._readWord(0xE000EDF0);
      if (((v >>> 1) & 1) === 1) return;                   // C_HALT=1：确实停住了
      await waitMs(10);
    }
    console.warn('[dap] 停住目标的回读一直显示 C_HALT=0（可能是读滞后）——继续，不中断流程');
  }
  /** @returns {Promise<boolean>} 目标当前是否处于 halt（DHCSR.S_HALT = bit17） */
  async isHalted(){
    try {
      const v = await this._readWord(0xE000EDF0);
      return ((v >>> 17) & 1) === 1;
    } catch { return false; }
  }

  /** 内核寄存器读写（AP0 的 DCRSR/DCRDR，flashloader 执行器用；DCRSR 写完要等 S_REGRDY） */  async regRead(regsel){
    await this.writeMem(0xE000EDF4, new Uint8Array([regsel & 0x1f, 0, 0, 0]));
    for (let i = 0; i < 50; i++){
      const b = await this.readMem(0xE000EDF0, 4);
      if (b[2] & 0x01){                           // DHCSR.S_REGRDY = bit16
        const data = await this.readMem(0xE000EDF8, 4);
        if (data.length !== 4) throw new Error('调试寄存器数据不完整');
        return (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
      }
      await waitMs(2);
    }
    throw new Error('调试寄存器同步超时（S_REGRDY 没置位）');
  }
  async regWrite(regsel, value){
    await this.writeMem(0xE000EDF8, u32leBytes(value >>> 0));
    await this.writeMem(0xE000EDF4, u32leBytes((regsel & 0x1f) | 0x10000));
    for (let i = 0; i < 50; i++){
      const b = await this.readMem(0xE000EDF0, 4);
      if (b[2] & 0x01) return;
      await waitMs(2);
    }
    throw new Error('调试寄存器同步超时（S_REGRDY 没置位）');
  }

  /**
   * 跑 flash 算法之前把中断摁住（SysTick + 全部 NVIC IRQ）。
   *
   * 🚨 为什么必须：擦除**第一个扇区就是向量表**，向量表一旦为空，任何一个中断
   *    （固件的 SysTick 每 1ms 一次）都会让内核取到 0xFFFFFFFF → HardFault → 而 HardFault
   *    向量也空了 → **LOCKUP**。进 LOCKUP 之后 DHCSR.C_HALT 清不掉，只能复位，
   *    现象就是烧录中途报「无法让目标继续运行（DHCSR.C_HALT 清不掉）」。
   *    （pyOCD/J-Link 跑算法时同样会先把中断关掉。）
   * 只是临时摁住：烧完（或失败）都会复位目标，固件重新初始化，不受影响。
   */
  async maskInterrupts(){
    await this.writeMem(0xE000E010, u32leBytes(0));                                  // SysTick：ENABLE/TICKINT 全关
    for (let i = 0; i < 8; i++) await this.writeMem(0xE000E180 + i * 4, u32leBytes(0xFFFFFFFF));  // NVIC ICER0..7
  }

  /**
   * 软复位目标：写 AIRCR.SYSRESETREQ（0xE000ED0C = 0x05FA0004）。
   *
   * 🚨 为什么需要它：`reset()` 拉的是探针的 **nRESET 引脚**，很多接线（本机这块 F103 就是）
   *    根本没把 NRST 连到探针 —— 于是"复位"看着成功，其实目标一直在跑；
   *    更糟的是内核一旦进了 **LOCKUP**（擦除先擦掉向量表 + 中断进来就会），
   *    拉 NRST（没接线）救不回来，DHCSR.C_HALT 也清不掉，只能靠 SYSRESETREQ 或断电。
   *    写 AIRCR 走的是内核寄存器，一定能到。
   */
  async sysReset(){
    await this.writeMem(0xE000ED0C, u32leBytes(0x05FA0004));
    await waitMs(60);            // 给目标 60 ms 真的复位（sleep 在后台会被钳成 1 s）
    await this._targetInit();
    return '软件复位（AIRCR.SYSRESETREQ）';
  }

  /**
   * 复位目标。
   *
   * 🚨 顺序很要紧（本机 MicroLink DAPLink + STM32F103 实测）：
   *    **首选拉 nRESET 脉冲**（等价按一下复位键）。它不碰调试寄存器，
   *    放开后内核自己从 0 启动 —— 行为最干净。
   *    而 DAPLink 的 DAP_ResetTarget 会"复位并停住"，实测还能把目标留在
   *    半启动状态（.bss 都没清完，RTT 控制块地址上全是上一次的日志文本），
   *    之后写 DHCSR 让它跑也救不回来。所以只把它当兜底。
   *    另外 wait 参数单位是**微秒**：早期写成 1000000 = 每次调用卡 1 秒。
   */
  async reset(){
    const pins = async (value, waitUs) => {
      const p = new Uint8Array(6);
      p[0] = value; p[1] = SWJ_nRESET;
      p[2] = waitUs & 0xff; p[3] = (waitUs >> 8) & 0xff; p[4] = (waitUs >> 16) & 0xff; p[5] = (waitUs >> 24) & 0xff;
      return await this._ctrl(CMD.SWJ_Pins, p);
    };
    try {
      await pins(0x00, 20000);            // nRESET 拉低 20ms
      await pins(SWJ_nRESET, 50000);      // 放开 50ms
      await sleep(150);
      // 复位后重新建立 SWD：先老实来一遍，不行再来一遍（拉过 nRESET 之后第一次常常不认）
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++){
        try { await this._targetInit(); lastErr = null; break; }
        catch (e){ lastErr = e; await sleep(120); }
      }
      if (lastErr) throw lastErr;
      const halted = await this.isHalted();
      if (halted) await this.run();
      return 'nRESET 脉冲' + (halted ? '（目标被停住，已让它运行）' : '');
    } catch (e){
      /**
       * 🚨 nRESET 脉冲之后 SWD 可能整条哑掉（实测：拉过 nRESET 之后再怎么发激活序列都是 NO ACK）。
       *    这时候唯一的干净恢复是**把 USB 会话整个重开一遍**（释放接口再认领 + 重新初始化），
       *    也就是把探针从"上一次会话的残留状态"里拉出来。用户手动拔插也能好，但那样太傻。
       */
      console.warn('复位后 SWD 不可用，重开 USB 会话：' + e.message);
      const dev = this.device;
      try { await this.reopen(); } catch (e2){
        throw new Error(`复位后 SWD 无法恢复：${e.message} / 重开也失败：${e2.message}`);
      }
      await this._targetInit();
      await this.run();
      return 'nRESET 脉冲 + 重开探针会话（原 SWD 已哑：' + e.message + '）';
    }
  }

  /** 释放接口再认领、按**当前时钟**重跑一遍初始化 —— 比让用户拔插 USB 体面 */
  /** 重开一次 USB 会话（释放接口 → 等一下 → 重新认领）。
   *  `targetInit: false` 用于"马上就换时钟档重试"的场合：只重开会话，不按旧时钟再协商一遍。
   *  （这里原来忽略入参，调用方传了 `{negotiate:false}` 等于白传 —— 代码审查抓到的。）*/
  async reopen({ targetInit = true } = {}){
    if (this._usb) await this._usb.release(this.iface);
    else await this.device.releaseInterface(this.iface);
    this._ready = false;
    await sleep(120);
    await this._claim();
    if (targetInit) await this._targetInit({ clock: this.clockHz });
    return true;
  }

  async disconnect(){
    if (this._disconnectPromise) return await this._disconnectPromise;
    if (this._disconnected) return;
    this._disconnectPromise = this._disconnectNow();
    try { await this._disconnectPromise; this._disconnected = true; }
    finally { this._disconnectPromise = null; }
  }
  async _disconnectNow(){
    this._closing = true;
    if (this._lockChain) await this._lockChain;
    try { await this._ctrl(CMD.Disconnect); } catch {}
    if (this._usb){
      await this._usb.close({ dirty: dirty.has(this.device) });
      dirty.delete(this.device);
    } else {
      // Standalone adapters constructed without _claim retain legacy cleanup.
      try { await this.device.releaseInterface(this.iface); } catch {}
      if (dirty.has(this.device)) await resetDevice(this.device);
      await this.device.close();
    }
    this._unwatchUsb();
    this._ready = false;
  }

  /**
   * 盯着"探针掉线"（被复位/拔插/被别的页签 reset 掉）。
   *
   * 🚨 为什么必须**主动 close()** 而不是丢掉引用就算完（2026-10 定点实验）：
   *    接口的认领是挂在**这个 USBDevice 对象所代表的连接**上的。文档只是把引用丢了、
   *    没调 `close()`，浏览器就会一直认为接口被占着 —— 别的页签随后每一次 `claimInterface`
   *    都报 `Unable to claim interface`（而且它那边 `device.reset()` 也修不好），
   *    直到垃圾回收才莫名其妙地好，用户看到的就是"烧录有时候卡住/有时候又能用"。
   *    实测：在那个文档里补一次 `close()`，接口立刻就能被别人认领。
   */
  _watchUsb(){
    if (this._usbOff || !navigator?.usb?.addEventListener) return;
    const dev = this.device;
    this._usbOff = e => {
      if (e.device !== dev) return;
      // close() 返回 Promise：设备已经掉线时它会**异步 reject**（NotFoundError），
      // 光靠同步 try/catch 拦不住，会在控制台留下未捕获错误 —— 必须接住。
      try { (this._usb ? this._usb.close() : dev.close())?.catch?.(() => {}); } catch { /* 设备可能已经不在了 */ }
      this._ready = false;
      this._note('探针掉线（被复位/拔插）→ 已关闭本页签的句柄，接口认领随之释放');
    };
    try { navigator.usb.addEventListener('disconnect', this._usbOff); } catch {}
  }
  _unwatchUsb(){
    if (!this._usbOff) return;
    try { navigator.usb.removeEventListener('disconnect', this._usbOff); } catch {}
    this._usbOff = null;
  }

  /**
   * 自愈：SWD 访问报 FAULT / NO ACK 时重新初始化调试口。
   * 幂等 —— 重连 SWD、重新给 DP 上电、重设 CSW；目标被停住就让它跑。
   * ⚠️ 中途**不要**用 DAP_Disconnect/Connect 去"重连"（实测会把链路搞成一路 NO ACK），
   *    要恢复就重新走 _targetInit()，实在不行只能重新打开 USB 设备。
   *    （_targetInit 内部已经带「纯上电失败 → 掉电-上电」的最后手段，这里不必再补。）
   */
  async recover(){
    await this._targetInit();
    try { if (await this.isHalted()) await this.run(); } catch {}
    return true;
  }
}
