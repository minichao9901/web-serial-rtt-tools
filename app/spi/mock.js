/**
 * 假探针 —— 没有硬件也能把整条链路跑通（`#scope` 页的 MockScopeProbe 同一思路）。
 *
 *   · HID 侧：实现 `0x35` 的 9 个 action，**响应布局逐字节照固件**（spi_bridge.c:1460-1637），
 *     页面能用它验证组包/解析；`actual_sclk` 用一个简化的分频模型算（跟真板会差一点，
 *     它是给页面显示用的，不是标定值）。
 *   · bulk 侧：按固件的**同样规则**收包解析（`parsePack`）+ 执行帧，并记录"线上字节"，
 *     所以"档位展开对不对""打包器有没有把帧切成跨包"都能离线断言。
 *   · 末级器件：`opts.flash`（缺省就挂一颗 W25Q128 的模型，见 flash.js 的 FlashDevice）——
 *     **纯读/纯写**的 XFER 交给它答（RDID/SFDP/读/擦/写都能离线跑通），
 *     **全双工（tx 与 rx 都非 0）**仍走回环模型（回环自检就靠这个形状）。
 *
 * 它同时演 HID 与 bulk 两个角色 —— 页面里**必须**把两边指向同一个实例（`#scope` 页踩过：
 * 两个实例会造出"配置发给了 A、数据从 B 出来"的假象）。
 *
 * 故障注入（自测错误路径）：`loopback=false`（没接回环跳线，读回 0x00）、`dropRsp`、
 * `forceStatus`、`inFull`、`nakWhenDisabled`。
 */
import {
  ACT, AUXIN_TE, CFG_LEN, CFG_FLAG, F, FRAME_MAX, HID_CMD, LINE, MAGIC, PKT, PROFILE_LEN,
  R, ST, T, TC, XFER_HDR, lineActiveLow, parsePack,
} from './protocol.js';
import { FlashDevice } from './flash.js';

/** 逻辑引脚默认电平（RST/CS 低有效 → 空闲为高）*/
const PIN_IDLE = { dc: 0, rst: 1, csAux: 1, bl: 0, te: 0 };

/**
 * 假探针的**面板 GRAM 模型** —— 读回功能（`app/spi/panel-read.js`）的自测靠它。
 *
 * 语义照 MIPI DCS：
 *   · `2Ah/2Bh` 开窗（档 2 是 `02h + 24bit 地址(命令<<16) + 参数`）；
 *   · `2Ch` 开始写：之后的数据相位按窗口逐像素填（行到尾自动换到下一行窗口行）；
 *   · `2Eh` 开始读：读指针回到窗口起点；`3Eh` 续读（指针不动，接着往下）；
 *   · **没写过的像素返回确定性图案**（渐变 + 中心方块），这样"读回来应该是什么"永远可断言。
 *
 * ⚠️ 它只负责"数据长什么样"，不模拟面板的时序/电源 —— 那部分由 mock 的帧执行器负责。
 */
export class PanelGram {
  constructor(w = 240, h = 296, opts = {}){
    this.w = Math.max(1, w | 0); this.h = Math.max(1, h | 0);
    this.buf = new Uint8Array(this.w * this.h * 2);
    this._pattern();
    // 窗口（含端点，DCS 语义）
    this.x0 = 0; this.y0 = 0; this.x1 = this.w - 1; this.y1 = this.h - 1;
    this.cursor = 0;          // 在当前窗口里的**像素序号**（不是字节）
    this.mode = 'idle';       // idle | write | read
    this.writes = 0; this.reads = 0;
    this.onAir = !!opts.blank;   // blank=true：初始化成全 0（测"没写过"的分支）
  }

  /** 确定性图案：横向 R 渐变、纵向 G 渐变、B 取 (x^y) 低位；中心 40×40 白块 */
  _pattern(){
    const { w, h, buf } = this;
    for (let y = 0; y < h; y++){
      for (let x = 0; x < w; x++){
        const r = Math.round(x * 31 / Math.max(1, w - 1));
        const g = Math.round(y * 63 / Math.max(1, h - 1));
        const b = (x ^ y) & 31;
        let v = (r << 11) | (g << 5) | b;
        if (Math.abs(x - w / 2) < 20 && Math.abs(y - h / 2) < 20) v = 0xffff;
        const i = (y * w + x) * 2;
        buf[i] = (v >> 8) & 0xff; buf[i + 1] = v & 0xff;
      }
    }
  }

  get winW(){ return Math.max(1, this.x1 - this.x0 + 1); }
  get winH(){ return Math.max(1, this.y1 - this.y0 + 1); }

  setWindow(x0, y0, x1, y1){
    this.x0 = Math.max(0, Math.min(this.w - 1, x0 | 0));
    this.x1 = Math.max(this.x0, Math.min(this.w - 1, x1 | 0));
    this.y0 = Math.max(0, Math.min(this.h - 1, y0 | 0));
    this.y1 = Math.max(this.y0, Math.min(this.h - 1, y1 | 0));
    this.cursor = 0;
    this.mode = 'idle';
  }

  /** 窗口内第 i 个像素在整帧缓冲里的字节偏移（行到尾自动换到下一行窗口行）*/
  _offset(i){
    const px = i % this.winW, py = Math.floor(i / this.winW);
    const x = this.x0 + px, y = this.y0 + py;
    if (y > this.y1) return -1;                       // 越出窗口底：真面板会绕回窗口首行
    return (y * this.w + x) * 2;
  }

  beginWrite(){ this.cursor = 0; this.mode = 'write'; }
  beginRead(){ this.cursor = 0; this.mode = 'read'; }

  /** 写一段像素字节（数据相位）。返回写进去的字节数 */
  write(bytes){
    if (this.mode !== 'write') this.beginWrite();
    let n = 0;
    for (let k = 0; k + 1 < bytes.length; k += 2){
      let off = this._offset(this.cursor);
      if (off < 0){ this.cursor = 0; off = this._offset(0); }   // 绕回窗口首行（与 DCS 一致）
      this.buf[off] = bytes[k]; this.buf[off + 1] = bytes[k + 1];
      this.cursor++; n += 2;
    }
    this.writes += n;
    return n;
  }

  /** 读一段像素字节（数据相位）。返回 Uint8Array（长度 = min(n, 剩余窗口像素×2)）*/
  read(n){
    if (this.mode !== 'read') this.beginRead();
    const out = new Uint8Array(n);
    for (let k = 0; k + 1 < n; k += 2){
      let off = this._offset(this.cursor);
      if (off < 0){ this.cursor = 0; off = this._offset(0); }
      out[k] = this.buf[off]; out[k + 1] = this.buf[off + 1];
      this.cursor++; this.reads += 2;
    }
    return out;
  }

  /** 整窗口读一遍（自测对账用）*/
  snapshot(){
    const out = new Uint8Array(this.winW * this.winH * 2);
    const save = this.cursor, mode = this.mode;
    this.beginRead();
    for (let i = 0; i < out.length; i += 2){ const b = this.read(2); out[i] = b[0]; out[i + 1] = b[1]; }
    this.cursor = save; this.mode = mode;
    return out;
  }
}


/** IN 环的槽数（= 固件 in_ring_kb / 512；8 KB / 512 = 16）。满的时候固件暂停消费帧。 */
export const IN_RING_SLOTS = 16;

/**
 * 假探针对**读寄存器**的回包（数据相位的字节，不含 dummy）。
 * 真值当然以真屏为准；这里给的是"确定性的、像真的"一组，让离线自测能对账：
 *   · `04h` RDDID  → 3 字节（ID1..3，ST7796S/ST7789 常见的 00 93 96 那一族）
 *   · `09h` RDDST  → 4 字节显示状态（这里报"正常显示中"）
 *   · `0Ah..0Fh`、`DAh..DCh` → 各 1 字节
 *   · `D3h` RDID4 → 4 字节
 */
export const MOCK_DCS_REGS = {
  0x04: [0x00, 0x93, 0x96],
  0x09: [0x00, 0x00, 0x61, 0x00],
  0x0a: [0x9c], 0x0b: [0x00], 0x0c: [0x55], 0x0d: [0x00], 0x0e: [0x00], 0x0f: [0x00],
  0xda: [0x00], 0xdb: [0x93], 0xdc: [0x96], 0xd3: [0x00, 0x93, 0x96, 0x00],
};

/** 与固件相同：固定 240 MHz 模块时钟，SDK 接受的偶数整除分频，不超过请求。 */
export function mockPickSclk(wantHz){
  const want = Math.min(wantHz || 20000000,100000000),module=240000000;
  let n=Math.max(2,Math.ceil(module/want));if(n&1)n++;
  for (;n<=510;n+=2){
    if(module%n===0)return module/n;
  }
  return 0;
}

/**
 * 假 **SPI 寄存器器件**（默认 BMP280 风格：读 `0x80|reg` + 1 字节 dummy、写 `reg&0x7F`）。
 *
 * 为什么要有它：「寄存器」面板与定时采集那条路在离线时也要能跑通（跟 I2C 页的四个假器件同理）。
 * 它按**档位**建模，所以同一份代码也能装成 MPU-9250 风格（无 dummy）、MCP23S17 风格（地址是独立字节）：
 *   · `addrMode: 'orOp'`  —— 寄存器号在 opcode 低位（掩码 = `(1<<addrBits)-1`）
 *   · `addrMode: 'bytes'` —— opcode 固定，寄存器号在 XFER 的地址字段（页面上是"地址字节"）
 *
 * 两个"照真机来"的行为（这正是面板要能改 dummy/自增的原因）：
 *   ① **dummy 不符 → 数据整体错位**：器件在主机的 dummy 相位之后才开始吐数据；
 *      主机少给 1 字节 dummy，读回来的就是"前一字节"；
 *   ② **`autoInc:false` 的器件连读会原地踏步**（每字节都是同一个寄存器的值），
 *      面板上就看到"读 8 B 全是同一个数" —— 真机上就是这个症状。
 */
export class SpiRegDevice {
  constructor(opts = {}){
    this.name = opts.name || 'BMP280 风格（读 0x80|reg、无 dummy、写不自增）';
    this.addrMode = opts.addrMode === 'bytes' ? 'bytes' : 'orOp';
    this.readOp = (opts.readOp ?? 0x80) & 0xff;
    this.writeOp = (opts.writeOp ?? 0x00) & 0xff;
    this.addrBits = Math.max(0, Math.min(8, opts.addrBits ?? 7));
    this.dummy = Math.max(0, opts.dummy ?? 0);
    this.autoInc = opts.autoInc !== false;
    /** 写是否自增（**与读分开**）：BMP280 读自增、写不自增 —— 见 regs.js 的 writePlan 注释 */
    this.autoIncWrite = opts.autoIncWrite !== false;
    this.size = opts.size ?? 256;
    this.regs = new Uint8Array(this.size);
    /** 读之前刷新"活数据"（传感器那种会动的值）：`(reg, len, now) => void` */
    this.onRead = null;
    this.onWrite = null;
  }
  get mask(){ return (1 << this.addrBits) - 1; }
  isRead(op){
    if (this.addrMode === 'bytes') return (op & 0xff) === this.readOp;
    return (op & ~this.mask & 0xff) === (this.readOp & ~this.mask & 0xff);
  }
  isWrite(op){
    if (this.addrMode === 'bytes') return (op & 0xff) === this.writeOp;
    return (op & ~this.mask & 0xff) === (this.writeOp & ~this.mask & 0xff);
  }
  regOf(op, addr, addrEn){
    if (this.addrMode === 'bytes') return (addrEn ? addr : 0) & 0xff;
    return op & this.mask;
  }
  exec({ cmd, cmdEn, addr, addrEn, dummy, tx, rxLen, now }){
    const op = cmd & 0xff;
    if (rxLen > 0 && cmdEn && this.isRead(op)){
      const reg = this.regOf(op, addr, addrEn);
      this.onRead?.(reg, rxLen, now);
      const out = new Uint8Array(rxLen);
      const shift = this.dummy - (dummy | 0);         // >0：主机少给了 dummy → 读到的整体前移
      for (let i = 0; i < rxLen; i++){
        const j = i + shift;
        if (j < 0){ out[i] = 0x00; continue; }
        out[i] = this.regs[(this.autoInc ? reg + j : reg) % this.size];
      }
      return { rx: out, why: shift ? `dummy 不符：器件要 ${this.dummy} B，主机给了 ${dummy | 0} → 数据错位 ${shift} 字节` : '' };
    }
    if (rxLen === 0 && tx.length && this.isWrite(op)){
      const reg = this.regOf(op, addr, addrEn);
      this.onWrite?.(reg, tx, now);
      /**
       * 🚨 **写不自增的器件（BMP280 就是）**：一帧里的多个字节会全落到同一个寄存器上
       *    （最后一个生效）—— 真机症状是"我明明写了 3 个字节，怎么只有最后一个像生效了"。
       *    面板的 `writePlan` 会按 `autoIncWrite` 自动"一寄存器一帧"，这里如实复现器件行为。
       */
      if (!this.autoIncWrite && tx.length > 1){
        const warn = `写不自增：这一帧的 ${tx.length} 个字节都写进了寄存器 ${reg}（只有最后一个生效）`;
        for (let i = 0; i < tx.length; i++) this.regs[reg % this.size] = tx[i];
        return { why: warn };
      }
      for (let i = 0; i < tx.length; i++){
        const r = this.autoIncWrite ? (reg + i) : reg;
        this.regs[r % this.size] = tx[i];
      }
      return {};
    }
    return { why: `不认识的操作码 0x${op.toString(16).padStart(2, '0')}（本器件：读 0x${this.readOp.toString(16)}|reg / 写 0x${this.writeOp.toString(16)}|reg）` };
  }
}

/**
 * 假 **命令型 SPI ADC**（默认 MCP3008 风格：`tx = [0x01, 0x80|(ch<<4), 0x00]`，回 3 B）。
 * 采样值是"活的"（每通道一条会动的正弦），所以定时采集那条路在离线时也能看出波形。
 */
export class SpiCmdAdc {
  constructor(opts = {}){
    this.name = opts.name || 'MCP3008 风格（10 位 8 通道 ADC）';
    /** 命令型 SPI 器件**天生全双工**：发命令的同时就在读结果（tx 与 rx 等长） */
    this.fullDuplex = true;
    this.bits = opts.bits ?? 10;
    this.channels = opts.channels ?? 8;
    this.periodMs = opts.periodMs ?? 2000;
    this.lastCh = 0;
    this.samples = 0;
  }
  /** 第 ch 通道的"当前值"（0..满量程）—— 正弦 + 通道相位差 */
  value(ch, now = 0){
    const phase = ((now % this.periodMs) / this.periodMs) * Math.PI * 2;
    const v = 0.5 + 0.45 * Math.sin(phase + ch * 0.7);
    return Math.round(Math.max(0, Math.min(1, v)) * ((1 << this.bits) - 1));
  }
  exec({ tx, rxLen, now }){
    const b0 = tx[0] ?? 0, b1 = tx[1] ?? 0;
    if (!(b0 & 0x01)) return { why: '命令缺起始位（tx[0] 的 bit0 必须是 1）' };
    if (!(b1 & 0x80)) return { why: '只实现了单端模式（tx[1] 的 bit7 = SGL/DIFF 必须是 1）' };
    const ch = (b1 >> 4) & 0x07;
    this.lastCh = ch;
    this.samples++;
    const v = this.value(ch, now);
    // 线上形状：1 字节前导（null/0）+ 高位字节（低 bits-8 位有效）+ 低位字节
    const hi = this.bits > 8 ? (v >> 8) & ((1 << (this.bits - 8)) - 1) : (v & 0xff);
    const lo = this.bits > 8 ? v & 0xff : 0x00;
    const out = new Uint8Array(rxLen);
    const bytes = [0x00, hi, lo];
    for (let i = 0; i < rxLen; i++) out[i] = bytes[i] ?? 0x00;
    return { rx: out };
  }
}

export class MockSpiProbe {
  constructor(opts = {}){
    this.opts = opts;
    this.now = opts.clock || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

    /** 配置块：默认值照固件 spi_bridge.c:1365-1382；**辅助脚用「引脚分配图」的推荐值**
     *  （protocol.AUX_DEFAULT：DC=PA26 / RST=PA02 / BL=PA31），这样假探针、预设、引脚图三处一致，
     *  用户 2026-10 要求"跟大家都一样"。 */
    this.cfg = {
      sclkHz: 0, mode: 0, bits: 8, csPolicy: 0, txDmaThreshold: 100,
      padDc: 14 /*PA26*/, padRst: 5 /*PA02*/, padCsAux: 0, padBl: 13 /*PA31*/, padTe: 0,
      padActiveLow: 0x06 /*RST+CS 低有效*/, padLowRaw: 0x06, flags: CFG_FLAG.CLEAR_ON_ENABLE,
      reserved0: 0, outRingKb: 16, inRingKb: 8, maxFrameBytes: FRAME_MAX,moduleClkHz:240000000,
    };
    this.profile = { profile: 0, defLines: 1, dcActiveHigh: 1, csHoldInStep: 1, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3, flags: 0 };

    this.enabled = false;
    this.actualSclk = 0;
    this.stats = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0 };
    this.lastErr = ST.OK;

    this.pins = { ...PIN_IDLE };
    this.cs = false;
    this.csWindows = 0;         // 统计"CS 窗口"（每帧一次，用来验 CS 策略）
    this.queue = [];            // 待执行帧（被 DELAY 挡住时留在这里）
    this.blockUntil = 0;        // 非阻塞延时的"下一个允许时刻"
    this.rsps = [];             // 待主机取走的应答包
    this.wire = [];             // 线上字节（XFER 的 tx、STEP 的展开结果）—— 自测对账用
    this.wireLog = [];          // 每个动作的可读记录
    this.hidCalls = [];         // HID 调用流水
    this.delays = [];           // 收到的 DELAY/RESET/STEP.delay
    this.nakWrites = 0;         // 未使能时主机的写（真固件会 NAK）

    /** 末级器件：缺省挂一颗 NOR（RDID/SFDP/读/擦/写都能离线跑通）。`flash:false` 可关掉 */
    this.flash = opts.flash === false ? null
      : opts.flash instanceof FlashDevice ? opts.flash
      : new FlashDevice({ ...(opts.flash && typeof opts.flash === 'object' ? opts.flash : {}), clock: this.now });
    /* 另外两种"末级器件"（寄存器器件 / 命令型 ADC）：SPI 没有地址，所以同一时刻只挂一个，
       由 `device` 选（页面上的「假器件」下拉 = session.setMockDevice()）。 */
    this.regdev = opts.regdev instanceof SpiRegDevice ? opts.regdev
      : opts.regdev === false ? null : new SpiRegDevice(opts.regdev && typeof opts.regdev === 'object' ? opts.regdev : {});
    this.adc = opts.adc instanceof SpiCmdAdc ? opts.adc
      : opts.adc === false ? null : new SpiCmdAdc(opts.adc && typeof opts.adc === 'object' ? opts.adc : {});
    /** 'flash'（默认）| 'regs' | 'adc' —— 见 activeDevice() */
    this.deviceKind = opts.device || 'flash';
    this.flashNotes = [];       // 器件侧拒绝/说明（模型给的，不是协议错）—— 三种器件共用这一个流水

    /**
     * 面板 GRAM 模型（读回功能用）。默认 240×296（AXS15352）；换屏时页面调 `setPanelGeometry()`。
     * `gram:false` 可关掉（那时读回走回环/全 0 —— 用来测"读不到东西"的分支）。
     */
    this.gram = opts.gram === false ? null : new PanelGram(
      opts.gram?.w ?? opts.gramW ?? 240, opts.gram?.h ?? opts.gramH ?? 296, opts.gram || {});
    this.gramOn = !!this.gram;

    /** 故障注入 */
    this.faults = {
      loopback: opts.loopback !== false,   // 默认接好了 MOSI↔MISO 跳线
      dropRsp: false,                      // 应答直接不回（模拟丢包）
      forceStatus: null,                   // 下一帧强制返回这个状态码（一次性）
      inFull: false,                       // IN 环满：应答被丢 + in_drop++
      disabledAlways: false,               // 假装"使能不上"（ENABLE 无效）
    };
    if (opts.faults) Object.assign(this.faults, opts.faults);
  }

  // ======================================================================== HID 侧

  /** 与 `AkaLinkHid.xfer(cmd, data)` 同形：返回 63 B 的 payload（[1]=cmd、[2]=action、[3..]=数据）*/
  async xfer(cmd, data, timeoutMs = 3000){
    void timeoutMs;
    const d = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    const action = d[0] | 0;
    this.hidCalls.push({ cmd, action, data: Uint8Array.from(d) });
    const res = new Uint8Array(63);
    res[1] = cmd & 0xff;
    res[2] = action & 0xff;
    if (cmd !== HID_CMD) return res;

    switch (action){
      case ACT.STATUS: {
        res[0] = 44;
        const dv = new DataView(res.buffer);
        dv.setUint32(3, this.statusWord(), true);
        dv.setUint32(7, this.stats.framesOk, true);
        dv.setUint32(11, this.stats.bytesTx, true);
        dv.setUint32(15, this.stats.bytesRx, true);
        dv.setUint32(19, this.stats.txPoll, true);
        dv.setUint32(23, this.stats.txDma, true);
        dv.setUint32(27, this.stats.outOverrun, true);
        dv.setUint32(31, this.stats.inDrop, true);
        dv.setUint32(35, this.actualSclk, true);
        dv.setUint32(39, this.stats.framesErr, true);
        break;
      }
      case ACT.ENABLE: {
        const on = !!d[1] && !this.faults.disabledAlways;
        this.enabled = on;
        if (on && (this.cfg.flags & CFG_FLAG.CLEAR_ON_ENABLE)) this._clear();
        this.actualSclk = on ? mockPickSclk(this.cfg.sclkHz) : 0;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.RESET:
        this._clear();
        this.stats = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0 };
        this.lastErr = ST.OK;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      case ACT.ABORT:
        this.queue = []; this.rsps = []; this.blockUntil = 0;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      case ACT.SET_CFG: {
        const blob = d.subarray(1, 1 + CFG_LEN);
        const c = this._decodeCfg(blob);
        const bad = this._validateCfg(c);
        if (bad){
          this.lastErr = ST.RANGE;
          res[0] = 8;
          new DataView(res.buffer).setUint32(3, this.statusWord() | (ST.RANGE << 8), true);
          break;
        }
        Object.assign(this.cfg, c, { maxFrameBytes: FRAME_MAX, moduleClkHz:240000000 });
        if (this.enabled) this.actualSclk = mockPickSclk(this.cfg.sclkHz);
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.GET_CFG: {
        const b = this._encodeCfg();
        res[0] = 4 + CFG_LEN;
        res.set(b, 3);
        break;
      }
      case ACT.PIN_CFG: {
        const line = d[1] | 0, pad = d[2] | 0;
        if (pad < 0 || pad > 17 || (!this._padOk(pad))){
          this.lastErr = ST.RANGE;
          res[0] = 8;
          new DataView(res.buffer).setUint32(3, this.statusWord() | (ST.RANGE << 8), true);
          break;
        }
        const key = { [LINE.DC]: 'padDc', [LINE.RST]: 'padRst', [LINE.CS_AUX]: 'padCsAux', [LINE.BL]: 'padBl', [LINE.TE]: 'padTe' }[line];
        if (key) this.cfg[key] = pad;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.SET_PROFILE: {
        const p = d.subarray(1, 1 + PROFILE_LEN);
        const prof = { profile: p[0] > 2 ? 0 : p[0], defLines: [1, 2, 4].includes(p[1]) ? p[1] : 1, dcActiveHigh: !!p[2], csHoldInStep: !!p[3], qspiWrOpcode: p[4], qspiColorOpcode: p[5], qspiAddrBytes: p[6], flags: p[7] };
        this.profile = prof;
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
      }
      case ACT.GET_PROFILE: {
        const p = this.profile;
        res[0] = 4 + PROFILE_LEN;
        res.set([p.profile, p.defLines, p.dcActiveHigh ? 1 : 0, p.csHoldInStep ? 1 : 0,
                 p.qspiWrOpcode, p.qspiColorOpcode, p.qspiAddrBytes, p.flags, 0, 0, 0, 0, 0, 0, 0, 0], 3);
        break;
      }
      default:
        res[0] = 8;
        new DataView(res.buffer).setUint32(3, this.statusWord(), true);
        break;
    }
    return res;
  }

  statusWord(){
    let w = 0;
    if (this.enabled) w |= 1;
    if (this.queue.length) w |= 2;
    if (this.cs) w |= 4;
    if (this.rsps.length >= IN_RING_SLOTS || this.faults.inFull) w |= 8;   // IN 流控
    if (this.queue.length >= 30) w |= 16;
    w |= (this.lastErr & 0xff) << 8;
    return w >>> 0;
  }

  _clear(){ this.queue = []; this.rsps = []; this.blockUntil = 0; this.cs = false; }

  _padOk(pad){
    /* 与固件 sb_pad_ok()/sb_cfg_validate() 对齐（2026-09-30 SPI2 迁移后）：
     *   · PB10~PB13（1~4）= SPI2 的 SCLK/MISO/MOSI/CS，固定脚不能当辅助脚；
     *   · PA30（12）= USB0_PWR 网络，被板上 Q1 常态短到地，别用；
     *   · PA31（13）现在是自由脚（当年 quad 下占用它的规则已删）。
     * 9/10 = PY00/PY01 不在 pad 表里（s_pad_table 为 0），由调用方按"表里没有"处理。
     *
     * 🚨 上界是 **17**（PA26~PA29，2026-09-30 从 SPI1 显示口释放、固件实测接受索引 14~17），
     *    不是 13 —— 旧上界把 PA26 也拒了，于是"用推荐脚位 DC=PA26"的配置**永远写不进去**
     *    （2026-10 定位：SPI 自测里那两条长期失败就是这个）。 */
    if (pad === 1 || pad === 2 || pad === 3 || pad === 4) return false;
    if (pad === 12) return false;
    return true;
  }

  _validateCfg(c){
    if(!mockPickSclk(c.sclkHz))return 'sclk';
    if (c.mode > 3) return 'mode';
    if (c.bits !== 8) return 'bits';
    if (c.csPolicy > 3) return 'csPolicy';
    for (const p of [c.padDc, c.padRst, c.padCsAux, c.padBl, c.padTe]) if (p > 17 || !this._padOk(p)) return 'pad';
    return null;
  }

  _encodeCfg(){
    const b = new Uint8Array(CFG_LEN);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, this.cfg.sclkHz >>> 0, true);
    b[4] = this.cfg.mode; b[5] = this.cfg.bits; b[6] = this.cfg.csPolicy; b[7] = this.cfg.txDmaThreshold;
    b[8] = this.cfg.padDc; b[9] = this.cfg.padRst; b[10] = this.cfg.padCsAux; b[11] = this.cfg.padBl;
    b[12] = this.cfg.padActiveLow; b[13] = this.cfg.padTe; b[14] = this.cfg.flags;
    dv.setUint16(16, this.cfg.outRingKb, true); dv.setUint16(18, this.cfg.inRingKb, true);
    dv.setUint16(20, FRAME_MAX, true);
    dv.setUint32(24, this.cfg.moduleClkHz, true);
    return b;
  }

  _decodeCfg(b){
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      sclkHz: dv.getUint32(0, true), mode: b[4], bits: b[5], csPolicy: b[6], txDmaThreshold: b[7],
      padDc: b[8], padRst: b[9], padCsAux: b[10], padBl: b[11], padActiveLow: b[12], padTe: b[13],
      padLowRaw: b[12], flags: b[14], reserved0: b[15],
      outRingKb: dv.getUint16(16, true), inRingKb: dv.getUint16(18, true),
    };
  }

  // ======================================================================== bulk 侧

  /**
   * 主机送来一次传输（= 真设备端点被 arm 之后的若干次 OUT 回调）。
   *
   * 🚨 **一次 USB 传输可以带多个 512 B 包**（主机攒批提交，见 `protocol.batchPacks`）：
   *    真固件每次只 arm 一个 512 B 槽（`usbd_ep_start_read(..., SB_PKT_SIZE)`），收满/收到短包就回调一次、
   *    解析这一槽里的帧。所以这里也照同一个口径**按 512 B 拆槽**，一槽一次 `write` 语义 ——
   *    攒批不该改变设备看到的东西，只该让主机少喊几次。
   * 未使能时真固件不 arm 端点 → 会 NAK。
   */
  write(pack){
    const b = pack instanceof Uint8Array ? pack : new Uint8Array(pack);
    if (!this.enabled){ this.nakWrites++; return { accepted: false }; }
    if (b.length > PKT){
      let frames = 0, firstErr = null, residue = 0;
      for (let off = 0; off < b.length; off += PKT){
        const slot = b.subarray(off, Math.min(off + PKT, b.length));
        const r = this._writeSlot(slot);
        frames += r.frames || 0;
        residue += r.residue || 0;
        if (r.err && !firstErr) firstErr = r.err;
      }
      return { accepted: true, frames, residue, err: firstErr, slots: Math.ceil(b.length / PKT) };
    }
    return this._writeSlot(b);
  }

  /** 一个 512 B 槽（= 真固件的一次 OUT 回调）*/
  _writeSlot(b){
    const r = parsePack(b);
    if (r.err){
      this.stats.framesErr++;
      this.lastErr = r.err.why === 'bad_magic' ? ST.BAD_MAGIC : ST.BAD_FRAME;
      this.wireLog.push(`包被丢：${r.err.why}@${r.err.off}`);
      return { accepted: true, frames: 0, err: r.err };
    }
    for (const f of r.frames) this.queue.push(f);
    this._drain();
    return { accepted: true, frames: r.frames.length, residue: r.residue };
  }

  /** 时间推进（transport 定期调用）：把被非阻塞延时挡住的帧继续执行 */
  tick(nowMs){
    const now = nowMs ?? this.now();
    if (this.queue.length && now >= this.blockUntil) this._drain(now);
  }

  /** 主机取走一个应答包（= IN 端点读）*/
  takeRsp(){ return this.rsps.shift() || null; }

  _drain(now = this.now()){
    while (this.queue.length){
      if (now < this.blockUntil) return;              // 非阻塞延时：到点再继续
      const f = this.queue[0];
      /**
       * IN 环满 = **不消费这一帧**，等主机取走数据（照固件 `sb_in_alloc()==NULL` 的分支，
       * spi_bridge.c:1562-1568：`return; /* IN 环满：不消费这一帧，等主机取走数据 *\/`）。
       * 固件**从不丢应答** —— 早先这里模拟成"挤掉最老的"，会让一包 25 条带 RSP 的读帧
       * 在假探针上假失败（真机上只会暂停一下，等主机把 IN 读走）。
       */
      if ((f.flags & F.RSP) && this.rsps.length >= IN_RING_SLOTS) return;
      this.queue.shift();
      const st = this._exec(f, now);
      // 自动 CS 模式下"每帧一个 CS 窗口"，带 CS_HOLD 的帧结束后**不释放**（管道化刷像素就靠这个）
      if (st === ST.OK && (f.type === T.XFER || f.type === T.STEP)) this._csAfterFrame(f.flags);
      if (st === ST.OK) this.stats.framesOk++;
      else { this.stats.framesErr++; this.lastErr = st; }
      if (f.flags & F.RSP){
        if (this.faults.dropRsp) { /* 丢包：什么都不回 */ }
        else if (this.faults.inFull){ this.stats.inDrop++; this._rsp(ST.IN_FULL, f.seq, new Uint8Array(0)); }
        else this._rsp(st, f.seq, this._lastRx || new Uint8Array(0));
      } else if (st !== ST.OK){
        this._rsp(st, f.seq, new Uint8Array(0), R.EVT);
      }
      this._lastRx = null;
    }
  }

  /** 自动 CS 模式的窗口语义：本帧开始时若 CS 未占用就开一个新窗口；不带 CS_HOLD 就释放 */
  _csAfterFrame(flags){
    if (!this.cs){ this.cs = true; this.csWindows++; }
    if (!(flags & F.CS_HOLD)) this.cs = false;
  }

  _rsp(status, seq, data, type = R.RSP){
    const forced = this.faults.forceStatus;
    if (forced != null){ status = forced; this.faults.forceStatus = null; }
    const d = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    const out = new Uint8Array(8 + d.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, MAGIC, true); out[2] = type; out[3] = status;
    dv.setUint16(4, seq, true); dv.setUint16(6, d.length, true);
    out.set(d, 8);
    this.rsps.push(out);
    if (this.rsps.length > 16){ this.rsps.shift(); this.stats.inDrop++; }
  }

  /** 执行一帧；返回 sb_status_t。读到的数据放 this._lastRx（应答时取走）*/
  _exec(f, now){
    const p = f.payload;
    switch (f.type){
      case T.PING:
        return ST.OK;

      case T.DELAY: {
        const us = p.length >= 4 ? new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true) : 0;
        this.delays.push(us / 1000);            // ⚠️ 统一记**毫秒**（DELAY 帧给的是微秒）
        this.blockUntil = Math.max(this.blockUntil, now + us / 1000);
        return ST.OK;
      }

      case T.CFG: {
        if (p[0] === 0) this.cfg.txDmaThreshold = p[1] | ((p[2] || 0) << 8);
        return ST.OK;
      }

      case T.CS: {
        const assert = !!p[0];
        if (assert && !this.cs){ this.cs = true; this.csWindows++; }
        if (!assert){ this.cs = false; this.flash?.releaseCs(); }
        return ST.OK;
      }

      case T.GPIO: {
        const line = p[0] | 0, lvl = p[1] ? 1 : 0;
        const key = { [LINE.DC]: 'dc', [LINE.RST]: 'rst', [LINE.CS_AUX]: 'csAux', [LINE.BL]: 'bl' }[line];
        if (!key) return ST.GPIO;
        const activeLow = lineActiveLow(this.cfg.padActiveLow, line);
        this.pins[key] = activeLow ? (lvl ? 0 : 1) : lvl;   // 记录**物理**电平
        this.wireLog.push(`GPIO ${key}=${lvl}`);
        return ST.OK;
      }

      case T.RESET: {
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const low = dv.getUint16(0, true), post = dv.getUint16(2, true);
        this.pins.rst = 0; this.pins.rst = 1;
        this.delays.push(low + post);           // 毫秒（与 DELAY 帧同一个口径）
        this.blockUntil = Math.max(this.blockUntil, now + (low + post));
        this.wireLog.push(`RESET low=${low}ms post=${post}ms`);
        return ST.OK;
      }

      case T.AUX_IN:
        this._lastRx = Uint8Array.of(this.pins.te ? AUXIN_TE : 0);
        return ST.OK;

      case T.STEP:
        return this._execStep(p, now);

      case T.XFER:
        return this._execXfer(f, p);

      default:
        return ST.BAD_FRAME;
    }
  }

  /** 档位展开：0 raw / 1 spi_dcx / 2 qspi（照固件 spi_bridge.c:744-801 的语义）*/
  _execStep(p, now){
    if (p.length < 4) return ST.BAD_FRAME;
    const cmd = p[0], n = p[1];
    const delayMs = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(2, true);
    if (4 + n > p.length) return ST.BAD_FRAME;
    const params = p.subarray(4, 4 + n);
    const prof = this.profile;
    const bytes = [];
    if (prof.profile === 2){
      /**
       * 档 2 = QSPI：`sb_step_qspi()` 把命令字放在 24 bit 地址的 **bits[23:16]**（`addr = cmd << 8`），
       * 线上 = `02 | 00 <cmd> 00 | params` —— 与 ST77916 数据手册 §8.8.5.1 的 `CMD : 0x00XX00` 一致，
       * 也与像素侧同一个编码（RAMWR 写 `0x002C00`、像素 opcode `0x32`）。
       *
       * 🚨 固件历史上错过两版，这里曾长期照**第二版**建模（`x.addr = cmd` → 线上 `02 | 00 00 XX`）：
       *    第一版 `cmd << 16`（发出 `02 F0 00 00`）、第二版 `addr = cmd`（发出 `02 00 00 F0`）。
       *    2026-09-30 固件已按 `cmd << 8` 订正（见其 `spi_bridge.c:1242-1256` 的订正说明），
       *    本机 LA 实测真机线上确为 `02 00 73 00 f0` ⇒ mock 就该是这个形状。
       */
      bytes.push(prof.qspiWrOpcode, 0x00, cmd, 0x00, ...params);      // opcode + 00 <cmd> 00 + params
    } else if (prof.profile === 1){
      bytes.push(cmd, ...params);                                     // 命令(DC=0) → 翻 DC → 参数(DC=1)
    } else {
      bytes.push(cmd, ...params);                                     // raw：cmd + params 同线数
    }
    this.wire.push(Uint8Array.from(bytes));
    this._gramCmd(cmd, params);                                       // 面板模型：窗口 / 读命令
    this.wireLog.push(`STEP cmd=0x${cmd.toString(16).padStart(2, '0')} n=${n}` +
      (prof.profile === 1 ? '（DC 0→1，同一 CS 窗口）' : prof.profile === 2 ? '（0x02 + 24bit 地址）' : ''));
    this.stats.bytesTx += bytes.length;
    this.stats.txPoll++;
    if (delayMs > 0){ this.delays.push(delayMs); this.blockUntil = Math.max(this.blockUntil, now + delayMs); }
    return ST.OK;
  }

  /**
   * 面板命令的**语义**侧（GRAM 模型）：窗口 / 写起点 / 读起点 / 续读。
   * 档 1 与档 2 在这里统一 —— 档 2 的命令藏在 `STEP` 展开的地址里（`02h + 命令<<16`）。
   */
  _gramCmd(cmd, params){
    const g = this.gram;
    if (!g) return;
    const u16 = (i) => ((params[i] || 0) << 8) | (params[i + 1] || 0);
    switch (cmd & 0xff){
      case 0x2a: g.setWindow(u16(0), g.y0, u16(2), g.y1); break;      // CASET
      case 0x2b: g.setWindow(g.x0, u16(0), g.x1, u16(2)); break;      // RASET
      case 0x2c: g.beginWrite(); break;                               // RAMWR
      case 0x2e: g.beginRead(); break;                                // RAMRD
      case 0x3e: g.mode = 'read'; break;                              // RAMRDC（续读：指针不动）
      default: break;
    }
    if (MOCK_DCS_REGS[cmd & 0xff]) this._pendingReg = cmd & 0xff;     // 读寄存器：记下命令，数据相位回它
  }

  /** 换屏（页面/自测在切几何时调）：重建 GRAM 并回到全屏窗口 */
  setPanelGeometry(w, h){
    this.gram = new PanelGram(w, h);
    this.gramOn = true;
    return this.gram;
  }

  /**
   * 当前挂在末级的"器件"。
   * SPI 与 I2C 不同：**总线上没有地址**，所以同一时刻只能挂一个末级器件 ——
   * 页面上的「假器件」下拉（回环+NOR / 寄存器器件 / 命令型 ADC）就是切这里。
   */
  activeDevice(){
    if (this.deviceKind === 'regs') return this.regdev;
    if (this.deviceKind === 'adc') return this.adc;
    return this.flash;
  }

  /** 切换末级器件（'flash' | 'regs' | 'adc'）；切完清掉器件侧说明，免得旧告警误导 */
  setDeviceKind(kind){
    const k = ['flash', 'regs', 'adc'].includes(kind) ? kind : 'flash';
    this.deviceKind = k;
    this.flashNotes.length = 0;
    this.wireLog.push(`假器件切到 ${k}（${this.activeDevice()?.name || '无'}）`);
    return k;
  }

  /** 页面/自测用：三种假器件各自的一句话说明 */
  deviceInfo(){
    return {
      kind: this.deviceKind,
      name: this.activeDevice()?.name || '（没有末级器件：读回走回环）',
      has: { flash: !!this.flash, regs: !!this.regdev, adc: !!this.adc },
    };
  }


  _execXfer(f, p){
    if (p.length < XFER_HDR) return ST.BAD_FRAME;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const tcfg = p[1], txLen = dv.getUint16(4, true), rxLen = dv.getUint16(6, true);
    const cmdEn = !!(tcfg & TC.CMD_EN), addrEn = !!(tcfg & TC.ADDR_EN) && p[2] > 0;
    if (txLen + XFER_HDR > p.length) return ST.BAD_FRAME;
    if (rxLen > FRAME_MAX) return ST.RANGE;
    if (rxLen && !(f.flags & F.RSP)) return ST.BAD_FRAME;           // 读数据必须带 RSP
    if (txLen && rxLen && txLen !== rxLen) return ST.RANGE;         // 全双工要求等长
    if (!cmdEn && !addrEn && !txLen && !rxLen) return ST.BAD_FRAME;

    const tx = p.subarray(XFER_HDR, XFER_HDR + txLen);
    if (txLen){ this.wire.push(Uint8Array.from(tx)); this.stats.bytesTx += txLen; this.stats.txPoll++; }
    if (tcfg & TC.DC_EN) this.pins.dc = (tcfg & TC.DC_LEVEL) ? 1 : 0;

    /**
     * 面板 GRAM 模型优先接这两类（读回功能的数据面）：
     *   · **写像素**：档 1 = DC=1 的数据相位（`2Ch` 之后）；档 2 = `32h + 24bit 地址(2Ch<<16)`；
     *   · **读像素**：档 1 = DC=1 且 `rx_len>0`；档 2 = 带地址的读（地址落在命令空间 `2Eh<<16`）。
     * 认不出来就往下走器件/回环 —— SPI NOR（flash）那条路不受影响。
     */
    const dcData = !!(tcfg & TC.DC_EN) && !!(tcfg & TC.DC_LEVEL);
    const addr = dv.getUint32(8, true);
    /**
     * 面板地址判据（照 **ST77916 数据手册 §8.8.5.1**）：24 bit 地址 = `00 XX 00`，
     * **命令字在中间字节**；写用 `2Ch`（RAMWR）、读用 `2Eh`（RAMRD），开窗是 `2Ah/2Bh`。
     * ⚠️ 别按 `cmd << 16` 认地址 —— 那是老错误编码（详见 `image.js` 的 windowItems/pixelItems 注释）。
     */
    const panelCmd = (addr >>> 8) & 0xff;
    const addrShape = ((addr & 0xff) === 0) && (((addr >>> 16) & 0xff) === 0) && panelCmd !== 0;
    const isPanelAddr = addrShape && (panelCmd === 0x2c || panelCmd === 0x2e);
    /**
     * 命令相位（不带读）：档 1 的单字节命令（`2Ah/2Ch/2Eh/3Eh`，DC=0 + `tx=[cmd]`）、
     * 档 2 的 `CMD_EN`（`p[0]` 就是命令字）。**只通知面板模型、不吞掉这一帧** ——
     * SPI NOR 的写/擦也是同样的形状（`02h/20h + 地址 + 数据`），不能在这里 return。
     */
    if (this.gram){
      /**
       * 命令相位的**语义**（只通知模型，不吞帧）：
       *   · 档 1：DC=0 的单字节命令（`2Ah/2Ch/2Eh/3Eh` 配 `tx=[cmd]`）；
       *   · 档 2：命令字藏在地址里（`00 XX 00`）—— 开窗 `2Ah/2Bh` 带 4 字节坐标、`2Eh` 无数据；
       *     **像素片（`2Ch` + 数据）不在这里重置写指针**：QSPI 屏是"一条 RAMWR 命令之后连续写"，
       *     每片都重发同一个地址（`0x002C00`）不该把地址计数器打回窗口原点。
       */
      let cmdByte = null, params = new Uint8Array(0);
      if (cmdEn && this.profile.profile === 2 && addrShape){
        if (panelCmd !== 0x2c || txLen === 0){ cmdByte = panelCmd; params = tx; }
      } else if (cmdEn){
        cmdByte = p[0];
      } else if ((tcfg & TC.DC_EN) && !dcData && txLen >= 1){
        cmdByte = tx[0]; params = tx.subarray(1);
      }
      if (cmdByte != null) this._gramCmd(cmdByte, params);
    }
    /**
     * 面板 GRAM 的数据面（读回功能）：
     *   · **有 DC 的数据相位**（`DC_EN|DC_LEVEL`）= 面板的像素读写 —— SPI NOR 从不用 DC，所以这条判据不吃到它；
     *   · 档 2（QSPI）没有 DC：靠地址区分（`00 2C 00` 写 / `00 2E 00` 读）；
     *   · 档 2 的**续传**（一条命令 + 整帧连续流，CS 保持）：后续片不带 cmd/addr，
     *     靠 GRAM 自己的模式（还在 write/read）接手 —— 与真面板"地址计数器自己走"同一个模型。
     */
    const qspiContinue = this.profile.profile === 2 && !cmdEn && !addrEn;
    const gramWrite = txLen && (dcData || (this.profile.profile === 2 && isPanelAddr && panelCmd === 0x2c) ||
                                (qspiContinue && this.gram?.mode === 'write'));
    const gramRead = rxLen && (dcData || (this.profile.profile === 2 && isPanelAddr) ||
                               (qspiContinue && this.gram?.mode === 'read'));
    if (this.gram && !(txLen && rxLen)){
      if (gramWrite){
        this.gram.write(tx);
        this.wireLog.push(`GRAM 写 ${txLen} B（窗口 ${this.gram.winW}×${this.gram.winH}）`);
        return ST.OK;
      }
      if (gramRead){
        /**
         * 读寄存器优先：命令字节认得出（`MOCK_DCS_REGS`）就回那张表 —— 与 GRAM 读同一个形状，
         * 真屏上也是"命令 → 数据相位"两步。认不出才当 GRAM 像素读。
         * ⚠️ 档 2 的命令字在**地址的中间字节**里（`00 XX 00`），`p[0]` 只是读 opcode（0Bh）——
         *    早先这里按 `p[0]` 查表，结果 `0Bh` 撞上 RDDMADCTL，把 GRAM 读当成了寄存器读。
         */
        const regCmd = this.profile.profile === 2
          ? (addrShape && MOCK_DCS_REGS[panelCmd] ? panelCmd : null)
          : (cmdEn && MOCK_DCS_REGS[p[0]] ? p[0] : null);
        const reg = this._pendingReg ?? regCmd;
        if (reg != null && MOCK_DCS_REGS[reg]){
          const table = MOCK_DCS_REGS[reg];
          const rx = new Uint8Array(rxLen);
          for (let i = 0; i < rxLen; i++) rx[i] = table[i] ?? 0;
          this._pendingReg = null;
          this._lastRx = rx; this.stats.bytesRx += rx.length;
          this.wireLog.push(`寄存器 0x${reg.toString(16).padStart(2, '0')} 读 ${rxLen} B → ${[...rx].map(v => v.toString(16).padStart(2, '0')).join(' ')}`);
          return ST.OK;
        }
        const rx = this.gram.read(rxLen);
        this._lastRx = rx; this.stats.bytesRx += rx.length;
        this.wireLog.push(`GRAM 读 ${rxLen} B（窗口 ${this.gram.winW}×${this.gram.winH} · 第 ${this.gram.cursor} 像素）`);
        return ST.OK;
      }
    }

    // 器件模型：交给当前末级器件；**全双工**帧只有"本来就全双工的器件"（命令型 ADC）才认，
    // 其余情况仍走回环 —— 回环自检（MOSI↔MISO 跳线）就靠那个形状。
    const duplex = txLen > 0 && rxLen > 0;
    const dev = this.activeDevice();
    const devWants = !!dev && (dev.fullDuplex
      ? (rxLen > 0 && txLen === rxLen)                 // 命令型 ADC：边发命令边读结果
      : (!duplex && (cmdEn || addrEn || rxLen)));      // NOR / 寄存器器件：纯读或纯写
    if (devWants){
      const r = dev.exec({
        cmd: p[0], cmdEn, addr: dv.getUint32(8, true), addrEn,
        dummy: p[3], lines: (tcfg & TC.LINES_MASK) === TC.LINES_4 ? 4 : (tcfg & TC.LINES_MASK) === TC.LINES_2 ? 2 : 1,
        tx, rxLen, csHold: !!(f.flags & F.CS_HOLD), now: this.now(),
      }) || {};
      if (r.rx){ this._lastRx = r.rx; this.stats.bytesRx += r.rx.length; }
      if (r.why){ this.flashNotes.push(r.why); this.wireLog.push(`器件：${r.why}`); }
      this.wireLog.push(`XFER cmd=0x${p[0].toString(16).padStart(2, '0')} tx=${txLen} rx=${rxLen}` +
        `${cmdEn ? '' : '（续读）'}${(f.flags & F.CS_HOLD) ? ' CS_HOLD' : ''} → 器件（${this.deviceKind}）`);
      return ST.OK;
    }

    if (rxLen){
      this.stats.bytesRx += rxLen;
      // 回环模型：接好跳线时读回 = 刚发出去的；没接就是 0x00/0xFF
      const rx = new Uint8Array(rxLen);
      if (this.faults.loopback) rx.set(tx.subarray(0, Math.min(txLen, rxLen)));
      else rx.fill(0x00);
      this._lastRx = rx;
    }
    this.wireLog.push(`XFER cmd=0x${p[0].toString(16).padStart(2, '0')} tx=${txLen} rx=${rxLen}` +
      ((f.flags & F.CS_HOLD) ? ' CS_HOLD' : ''));
    return ST.OK;
  }

  // ======================================================================== 自测辅助

  /** 复位到干净状态（不动配置）*/
  resetState(){ this._clear(); this.stats = { framesOk: 0, framesErr: 0, bytesTx: 0, bytesRx: 0, txPoll: 0, txDma: 0, outOverrun: 0, inDrop: 0 }; this.wire = []; this.wireLog = []; this.hidCalls = []; this.delays = []; }

  /** 线上字节（所有 STEP/ XFER 的 tx 按顺序拼起来）—— 档位展开的对账口径 */
  wireHex(){ return this.wire.map(w => [...w].map(b => b.toString(16).padStart(2, '0')).join(' ')).join(' | '); }
}
