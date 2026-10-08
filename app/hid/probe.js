/**
 * akaLinkPro 自定义 HID 配置通道（WebHID）—— 纯协议，不碰 DOM。
 *
 * 协议出处（探针固件仓库，以源码为准）：
 *   E:\Share\github\akaLinkPro\firmware\application_5301\Custom HID Protocol.md
 *   E:\Share\github\akaLinkPro\firmware\application_5301\src\api\api_param.c
 *
 * 报文固定 64 字节，byte[0] = Report ID（1 = 主机→设备，2 = 设备→主机）。
 * WebHID 把 Report ID 单独传（sendReport(id, payload) / inputreport 事件），所以这里操作的是
 * **63 字节 payload**：
 *     payload[0] = Data Length（Command 1 字节 + 有效数据；固件其实不校验，照文档填）
 *     payload[1] = Command
 *     payload[2..] = 数据
 * 0x31（探针侧 RTT 桥）响应：payload[2] = 返回码，payload[3..] = 12 个 32 位小端状态字。
 */

export const USAGE_PAGE = 0xFF00;   // 厂商自定义页
export const VID = 0x0d28;          // akaLinkPro：CMSIS-DAP + CDC + HID + WebUSB + DFU 复合设备
export const PID = 0x0204;
export const PAYLOAD = 63;          // 64 - 1（Report ID）

export const CMD = {
  GET_CONFIG: 0x01, SET_CONFIG: 0x02, GET_VOLTAGE: 0x03, SAVE_CONFIG: 0x04,
  MODEL: 0x10, SN: 0x11, HW_VER: 0x12, FW_VER: 0x13, BL_VER: 0x14,
  HW_DATE: 0x15, FW_DATE: 0x16, BL_DATE: 0x17,
  RTT: 0x31,
  RISCV: 0x33,
  RESET: 0xfe, DFU: 0xff,
};

/**
 * 0x33（探针侧 RISC-V 引擎）的动作码，照固件 `riscv_svc.h`。
 * 烧录前**必须发一次 STOP**：那个引擎会一直占着 JTAG TAP，
 * 不放开的话我们这边的 `DAP_Connect(2)` 拿不到口（他们的 README 里也写了这一步）。
 */
export const RISCV_ACT = {
  STOP: 0, OPEN: 1, RBENCH: 2, WBENCH: 3, SBENCH: 4, RCHECK: 5, STATUS: 6, CONFIG: 7, DMIPROBE: 8,
};

/** 0x31 的动作码（api_param.c 的 RTT_ACT_*，与文档一致） */
export const RTT_ACT = {
  STOP: 0, START: 1, STATUS: 2, AUTOSTART: 3, RAW_DAP: 4, PEEK: 5,
  RAW_RESULT: 6, CONFIG: 7, BENCH: 8, BENCH_RESULT: 9, TARGET: 10,
};

/** action 10：切全局目标类型。Byte[0]=10（action）、Byte[1]=0 SWD/ARM | 1 RISC-V/JTAG。
 *  ⚠️ 这是**0x31** 的动作，不是 0x32 —— J-Scope 那边要发它得用 HID_CMD_RTT（见 scope/protocol.js）。*/
export function targetTypeData(riscv){ return Uint8Array.of(RTT_ACT.TARGET, riscv ? 1 : 0); }

// ============================================================================
// 组包 / 解析（导出成纯函数，Node 自测直接测）
// ============================================================================

/** 组一条请求 → 63 字节 payload */
export function buildRequest(cmd, data = new Uint8Array(0), lenOverride){
  const p = new Uint8Array(PAYLOAD);
  p[0] = (lenOverride ?? (1 + data.length)) & 0xff;
  p[1] = cmd & 0xff;
  p.set(data.subarray(0, PAYLOAD - 2), 2);
  return p;
}

/** 0x31 的 data 段：action + 目标地址(4) + 搜索长度(4) + 通道 —— 对应 req_hid[3..12] */
export function rttData(action, addr = 0, size = 0, channel = 0){
  const d = new Uint8Array(10);
  const dv = new DataView(d.buffer);
  d[0] = action & 0xff;
  dv.setUint32(1, addr >>> 0, true);
  dv.setUint32(5, size >>> 0, true);
  d[9] = channel & 0xff;
  return d;
}

/**
 * action=7 运行时调参的 data 段（按固件的 req_hid 布局，**同样以 action 字节开头**）：
 *   [0]=action  [1..4]=SWD 时钟 Hz  [5..6]=块读字节  [7]=标志(bit0=丢弃)  [8]=delay 覆盖
 */
export function rttConfigData({ clockHz = 0, chunkBytes = 0, discard = false, delayOverride = 0xff } = {}){
  const d = new Uint8Array(9);
  const dv = new DataView(d.buffer);
  d[0] = RTT_ACT.CONFIG;
  dv.setUint32(1, clockHz >>> 0, true);
  dv.setUint16(5, chunkBytes & 0xffff, true);
  d[7] = discard ? 1 : 0;
  d[8] = delayOverride & 0xff;
  return d;
}

const s8 = v => (v & 0xff) > 127 ? (v & 0xff) - 256 : (v & 0xff);

/**
 * 12 个状态字（48 字节）→ 好用的对象。字序与位域见协议文档「状态字」表。
 */
export function parseStatus(bytes){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = i => dv.getUint32(i * 4, true);
  const [w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11] =
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(w);
  return {
    running: !!(w0 & 1),
    channel: (w0 >>> 8) & 0xff,
    swdReady: !!(w0 & (1 << 16)),
    clockDelay: (w0 >>> 24) & 0xff,
    cbAddr: w1,                 // 找到的控制块地址（"SEGGER RTT" 签名处）
    upAddr: w2,                 // 上行缓冲描述符地址
    moved: w3,                  // 已搬运字节（每次启动清零）
    polls: w4 & 0xffff,
    transfers: w4 >>> 16,
    rdErr: w5 & 0xffff,         // 目标内存读错误
    wrErr: w5 >>> 16,           // RdOff 写错误
    lastChunk: w6 & 0xffff,
    emptyRing: w6 >>> 16,
    dapYield: w7 & 0xffff,      // 给 DAP 让路次数
    rescans: w7 >>> 16,
    lastCmdId: w8 & 0xff,
    lastResp: w9,
    startRc: s8(w10),           // 最近一次启动的返回码
    chunkBytes: w11 & 0xffff,
    discard: !!(w11 & (1 << 16)),
    swdMhz: (w11 >>> 24) & 0xff,
  };
}

/**
 * 启动返回码 → 人话（固件：-1 SWJ_Clock 失败 / -2 初始化失败 / -3 没找到控制块 / -4 该档链路不可用）。
 *
 * 🚨 `riscv` 这个入参不是装饰：同一个 `-2`，SWD 与 RISC-V/JTAG 下**不是同一件事** ——
 *    SWD 走 `swd_init_debug()`（JTAG2SWD + DP 上电），RISC-V 走 `riscv_jtag_open()`
 *    （开 TAP + 载 IR=DMI + 唤醒 DM）。老文案一律写「SWD 初始化失败（查接线 / 目标供电 / 复位）」，
 *    于是 2026-10 真机上一条 JTAG 故障被当成接线问题查了半天 —— 实际根因是探针的粘性目标类型
 *    被别处打回 SWD（见 app/hid/view.js 的启动前补发）。
 */
export function startRcText(rc, riscv = false){
  switch (rc){
    case 0: return '正常';
    case -100: return '启动中（探针还在排队，结果没出来）';   // 固件里 s_start_rc 的初值 = -100
    case -1: return riscv
      ? 'JTAG 时序参数设置失败（DMI delay / idle 字段非法）'
      : 'SWD 时钟设置失败（换低一档试试）';
    case -2: return riscv
      ? 'JTAG/DMI 初始化失败（TAP 无应答）：查目标有没有被停住 / 另一路会话占着 TAP / 探针输出模式要 SWD+JTAG'
      : 'SWD 初始化失败（查接线 / 目标供电 / 复位）';
    case -3: return riscv
      ? '没找到 RTT 控制块：RISC-V 请点「载入 ELF…」按 _SEGGER_RTT 定位（HPM 上盲目大范围搜搜不到）'
      : '没找到 RTT 控制块（地址区间不对？Cortex-M7 要给 AXI SRAM）';
    case -4: return riscv ? '该档位链路不可用（DMI 无应答）' : '该档位链路不可用';
    case -15: return 'CDC 正由“SPI转发”使用，请先停止转发';
    default: return `未知返回码 ${rc}`;
  }
}

/** -100 = 固件里"还没启动过/结果待定"的哨兵值，不是错误 */
export const START_PENDING = -100;

/** payload[2..] 里以 \0 结尾的 ASCII */
export function ascii(bytes){
  let s = '';
  for (const b of bytes){ if (!b) break; s += String.fromCharCode(b); }
  return s.replace(/\0+$/, '').trim();
}

// ============================================================================
// WebHID 客户端
// ============================================================================

// A physical HID command channel has one request/reply queue, shared by every feature.
// Different devices have independent queues; bulk/CDC streams do not use this registry.
const hidChannels = new WeakMap();
function channelFor(device){
  let channel = hidChannels.get(device);
  if (!channel){
    channel = { clients: new Set(), chain: Promise.resolve(), fault: null };
    // One physical input event must be delivered only once, even if resolving it
    // lets a queued client issue the next command before another listener runs.
    channel.input = e => {
      const client = [...channel.clients].find(c => c._pending) || channel.clients.values().next().value;
      client?._handleInput(e);
    };
    hidChannels.set(device, channel);
  }
  return channel;
}
function onChannel(channel, fn){
  const p = channel.chain.then(fn);
  channel.chain = p.catch(() => {});
  return p;
}

export class AkaLinkHid {
  constructor(){
    this.device = null;
    this._pending = null;
    this._reqSeq = 0;                    // 请求身份序号（超时回调按它匹配，不按 cmd —— 见 _settle）
    this._generation = 0;
    this._requests = new Set();
    this._closePromise = null;
    this._disconnectedDevice = null;
    this.onDisconnect = null;
    this._onDisc = this._handleDisconnect.bind(this);
  }

  static supported(){ return typeof navigator !== 'undefined' && !!navigator.hid; }
  get connected(){ return !!(this.device && this.device.opened); }
  get label(){
    const d = this.device;
    if (!d) return '';
    return [d.productName || 'akaLinkPro', d.serialNumber ? '· ' + d.serialNumber : ''].join(' ').trim();
  }

  /** 这个句柄是不是探针（按 VID/PID 判；厂商改名字也不影响）*/
  get isProbe(){
    const d = this.device;
    return !!d && d.vendorId === VID && d.productId === PID;
  }

  /**
   * 从**已授权**的设备里挑出探针。
   *
   * 🚨 这里踩过一个大坑：光按 `usagePage === 0xFF00` 找会**挑错设备** ——
   *    本机触摸板（Synaptics，VID 0x06cb）的 collections 里也有 vendor-defined 0xFF00，
   *    而它排在列表前面，于是 `reconnect()` 打开的是触摸板，`sendReport()` 抛
   *    **"Failed to write the report"** —— 看着像"探针被复位/句柄作废"，其实压根没连探针。
   *    所以：**先按 VID/PID 精确匹配**，只有实在找不到时才退回"按 usage page"（并让上层提示可能选错）。
   */
  static pick(devs){
    if (!devs?.length) return null;
    const exact = devs.find(d => d.vendorId === VID && d.productId === PID &&
                                 d.collections?.some(c => c.usagePage === USAGE_PAGE));
    if (exact) return exact;
    const byVid = devs.find(d => d.vendorId === VID && d.productId === PID);
    if (byVid) return byVid;
    return devs.find(x => x.collections?.some(c => c.usagePage === USAGE_PAGE)) || null;
  }

  /** 弹设备选择框。过滤条件带上 VID/PID —— 否则选择框里会混进触摸板这类同样有 0xFF00 的设备 */
  async request(){
    if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID（Chrome / Edge 桌面版才有）');
    const devs = await navigator.hid.requestDevice({
      filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE }],
    });
    if (!devs.length) throw new Error('没有选择设备');
    await this.open(devs[0]);
    return this.device;
  }

  /** 用之前授权过的探针直接连（浏览器记住过就不用再点弹框） */
  async reconnect(){
    if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID（Chrome / Edge 桌面版才有）');
    const devs = await navigator.hid.getDevices();
    const d = AkaLinkHid.pick(devs);
    if (!d){
      const names = devs.map(x => x.productName || '(无名)').join('、');
      throw new Error(`没有已授权的探针（已授权的 HID 设备：${names || '无'}）—— 点一次「连接探针」授权`);
    }
    await this.open(d);
    return d;
  }

  async open(device){
    if (this._closePromise) await this._closePromise;
    if (this.device && this.device !== device) await this.close();
    const channel = channelFor(device);
    await onChannel(channel, async () => {
      if (!device.opened) await device.open();
      this.device = device;
      this._disconnectedDevice = null;
      channel.clients.add(this);
      device.addEventListener('inputreport', channel.input);
      navigator.hid.addEventListener('disconnect', this._onDisc);
    });
  }

  async close(){
    if (this._closePromise) return await this._closePromise;
    this._closePromise = this._closeNow();
    try { return await this._closePromise; }
    finally { this._closePromise = null; }
  }

  async _closeNow(){
    const d = this.device;
    this._generation++;
    for (const controller of this._requests) controller.abort();
    const pending = this._pending;
    if (pending && !pending.replyReceived) channelFor(d).fault = pending;
    this._settle(pending);
    this._pending = null;
    pending?.reject(new Error('HID 会话已关闭'));
    if (!d) return;
    const channel = channelFor(d);
    await onChannel(channel, async () => {
      // Closing one view must not close the handle used by another view's command queue.
      // Keep the last client and its handle registered if native close fails, so
      // resource owners can report the failure and retry the same handle.
      try { if (channel.clients.size === 1 && channel.clients.has(this) && d.opened) await d.close(); }
      catch (e){ if (this._disconnectedDevice !== d) throw e; }
      channel.clients.delete(this);
      if (!channel.clients.size){ try { d.removeEventListener('inputreport', channel.input); } catch {} }
      try { navigator.hid.removeEventListener('disconnect', this._onDisc); } catch {}
      this.device = null;
    });
  }

  _handleInput(e){
    const res = new Uint8Array(e.data.buffer, e.data.byteOffset || 0, e.data.byteLength);
    const channel = channelFor(this.device);
    // The protocol has no wire request ID. With an unanswered request, send nothing
    // else until its reply is consumed (or physical unplug ends that channel).
    const orphan = channel.fault;
    if (orphan){
      if (res[1] === orphan.cmd){
        orphan.replyReceived = true;
        if (orphan.writeSettled) channel.fault = null;
      }
      return;
    }
    const p = this._pending;
    if (!p) return;                       // 没人等就算了（比如上一次超时后才回来的包）
    // 迟到的旧响应：**丢掉继续等**（不要拿它去满足新请求 —— 真机上踩过：
    // info() 并发发了 3 条，结果后面那条 AUTOSTART 收到了型号回包，状态字全是垃圾）
    if (res[1] !== p.cmd) return;
    p.replyReceived = true;
    this._pending = null;
    this._settle(p);                      // 清掉这条请求的超时定时器，再放行
    p.resolve(res);
  }

  /** 收尾一条在飞请求：**必须**清掉它的超时定时器。
   *  🚨 不清的后果不是"误报超时"那么轻：早先请求的残雷在 timeout 后触发时，
   *     reject 落在早已 settle 的旧 promise 上（无效），但它会把 `this._pending = null`
   *     一起打掉 —— **当前在飞的那条请求就永久挂起了**（既不 resolve 也不 reject，
   *     迟到的真回包也因 `_pending` 为空被丢弃）。表现是"点按钮没反应、也不报错"，只能刷新页面。
   *     高频同命令轮询（RTT 转发每 2 s 的 status()、J-Scope 启动时每 120 ms 的轮询）撞上就是它。*/
  _settle(p){
    if (p && p.timer != null){ clearTimeout(p.timer); p.timer = null; }
  }

  _handleDisconnect(e){
    if (e.device !== this.device) return;
    this._disconnectedDevice = e.device;
    // close() synchronously rejects the pending response and invalidates queued requests.
    this.close().catch(() => {});
    channelFor(e.device).fault = null; // Unplug also ends any outstanding firmware response.
    this.onDisconnect?.();
  }

  /**
   * 重新拿一次设备对象并打开。
   *
   * 为什么要这个：探针**被复位/拔插**之后会重新枚举，浏览器手里那个 `HIDDevice` 就作废了 ——
   * 之后 `sendReport()` 会抛 `Failed to write the report`（本机实测：探针自己重启过一次，
   * 用户点「开始采样」就报这个，而且完全不知道发生了什么）。
   * 重新枚举后 `getDevices()` 会给到**新的**对象，所以这里不是"重开旧的"，是重新取。
   */
  async _reacquire(){
    if (!AkaLinkHid.supported()) throw new Error('这个浏览器没有 WebHID');
    const devs = await navigator.hid.getDevices();
    const d = AkaLinkHid.pick(devs);
    if (!d) throw new Error('浏览器里已经没有已授权的探针了（点「连接探针」重新授权一次）');
    await this.open(d);
    return d;
  }

  /** 同一物理 HID 通道串行请求/响应。失效句柄交给显式重连恢复，避免请求在释放后重新认领。 */
  async xfer(cmd, data, timeout = 3000){
    if (this._closePromise) throw new Error('HID 会话正在关闭');
    if (!this.connected) throw new Error('探针没连上');
    const device = this.device, generation = this._generation;
    const controller = new AbortController();
    this._requests.add(controller);
    try {
      return await onChannel(channelFor(device), async () => {
        const execute = async () => {
          if (this.device !== device || generation !== this._generation || !this.connected)
            throw new Error('HID 会话已关闭或替换');
          if (channelFor(device).fault)
            throw new Error('HID 通道未同步：请等待迟到响应，或拔插探针后重连');
          return await this._xferNow(cmd, data, timeout, generation);
        };
        // Passive status handles in another tab also use the same command channel.
        // WebHID exposes no stable per-device ID: absent a serial, coordinate this VID/PID conservatively.
        const locks = globalThis.navigator?.locks;
        if (locks?.request){
          const key = `web-serial-rtt-tools/hid:${device.vendorId}:${device.productId}:${device.serialNumber || ''}`;
          return await locks.request(key, { signal: controller.signal }, execute);
        }
        return await execute();
      });
    } catch (e){
      if (controller.signal.aborted && e.name === 'AbortError') throw new Error('HID 会话已关闭');
      throw e;
    } finally { this._requests.delete(controller); }
  }

  async _xferNow(cmd, data, timeout, generation){
    if (this._pending) throw new Error('上一条请求还没回来');
    const pkt = buildRequest(cmd, data);
    const device = this.device, channel = channelFor(device);
    const once = async () => {
      let req = null;
      const wait = new Promise((resolve, reject) => {
        // 超时回调**按请求身份**（自增序号）匹配，不按 cmd：同一命令高频轮询时，
        // 按 cmd 匹配会让旧请求的残雷打掉新请求（见 _settle 的说明）
        req = { cmd, resolve, reject, seq: ++this._reqSeq, timer: null, replyReceived: false, writeSettled: false };
        this._pending = req;
        req.timer = setTimeout(() => {
          if (this._pending === req){
            this._pending = null; req.timer = null; channel.fault = req;
            reject(new Error(`探针 ${timeout}ms 没响应，HID 通道未同步：请等待迟到响应，或拔插探针后重连`));
          }
        }, timeout);
      });
      wait.catch(() => {}); // sendReport can fail before the response promise is awaited.
      const write = Promise.resolve().then(() => {
        if (generation !== this._generation) throw new Error('HID 会话已关闭');
        return device.sendReport(1, pkt);
      });
      const settled = () => {
        req.writeSettled = true;
        if (channel.fault === req && req.replyReceived) channel.fault = null;
      };
      write.then(settled, settled);
      try {
        await Promise.race([write, wait]);
      } catch (e){
        if (!req.replyReceived) channel.fault = req;
        this._settle(req);                  // 写失败：别把定时器留着
        if (this._pending === req) this._pending = null;
        req.reject(e);
        throw e;
      }
      return await wait;
    };
    try {
      let res;
      try {
        res = await once();
      } catch (e){
        const msg = String(e?.message || e);
        if (generation !== this._generation || !this.device) throw e;
        if (!/write the report|disconnect|not.*connected|NetworkError/i.test(msg)) throw e;
        this._pending = null;
        this.reconnects = (this.reconnects || 0) + 1;
        // Opening through the same command queue here would deadlock. Retire this request;
        // explicit reconnect performs recovery before later requests use the new handle.
        throw new Error('HID 句柄失效，请点「重连」：' + msg);
      }
      return res;                                // res[1] 已保证 === cmd（见 _handleInput）
    } catch (e){
      this._pending = null;
      throw new Error('HID 发送失败：' + (e?.message || e) +
        '（探针很可能刚被复位/拔插过 —— 点「重连」；还不行就拔插一次探针）');
    }
  }

  // ---------------- 便捷方法 ----------------

  /** 字符串类命令（型号 / 序列号 / 版本 / 日期） */
  async text(cmd){
    const res = await this.xfer(cmd, undefined, 2000);
    return ascii(res.subarray(2));
  }

  /** 型号 / 固件版本 / 序列号 —— 必须**一条一条**发（探针一次只回一条） */
  async info(){
    const model = await this.text(CMD.MODEL);
    const fw = await this.text(CMD.FW_VER);
    const sn = await this.text(CMD.SN);
    return { model, fw, sn };
  }

  /** 0x31：发一个动作，回 { rc, status } */
  async rtt(action, data, timeout = 3000){
    const res = await this.xfer(CMD.RTT, data || rttData(action), timeout);
    return {
      rc: s8(res[2]),
      status: parseStatus(res.subarray(3, 3 + 48)),
      raw: res,
    };
  }

  start({ addr = 0, size = 0, channel = 0 } = {}){ return this.rtt(RTT_ACT.START, rttData(RTT_ACT.START, addr, size, channel)); }
  autostart(){ return this.rtt(RTT_ACT.AUTOSTART, rttData(RTT_ACT.AUTOSTART)); }
  stop(){ return this.rtt(RTT_ACT.STOP, rttData(RTT_ACT.STOP)); }
  status(){ return this.rtt(RTT_ACT.STATUS, rttData(RTT_ACT.STATUS)); }
  configure(o){ return this.rtt(RTT_ACT.CONFIG, rttConfigData(o)); }

  /** 切**全局目标类型**（HID 0x31 action 10）：false = SWD/ARM，true = RISC-V/JTAG。
   *  粘性：设一次一直有效，J-Scope 采样器的传输后端也跟着它走。 */
  setTargetType(riscv){ return this.rtt(RTT_ACT.TARGET, targetTypeData(!!riscv)); }

  /**
   * 让探针自己的 RISC-V 引擎**放掉 JTAG TAP**（HID 0x33 action 0）。
   * 🚨 烧录前必发：那个引擎（做 RISC-V 内存读写/bench 用的）会一直占着 TAP，
   *    不放开的话 WebUSB 这边 `DAP_Connect(2)` 拿不到口。发了没响应也无所谓（本来就空闲）。
   */
  riscvStop(){
    return this.xfer(CMD.RISCV, Uint8Array.of(RISCV_ACT.STOP));
  }
}
