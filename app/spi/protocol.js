/**
 * USB → SPI/QSPI 桥协议 —— **JS 侧唯一真源**（纯函数，不碰 DOM，Node 自测直接打）。
 *
 * 契约出处（以**实现**为准；proto.h 有两处注释与实现不符，见 docs/spi-bridge-page.md §2.1）：
 *   E:\Share\github\akaLinkPro\firmware\application_5301\src\spi_bridge\spi_bridge_proto.h
 *   E:\Share\github\akaLinkPro\firmware\application_5301\src\spi_bridge\spi_bridge.c
 * 硬件方案：E:\Share\github\akaLinkPro\docs\usb-spi-bridge-plan.md §4
 * 页面方案：docs/spi-bridge-page.md
 *
 * 三层：
 *   1) HID CMD 0x35 —— 控制面（配置/面板档/状态/使能/复位/中止），64 B 报文
 *   2) bulk OUT 0x0B —— **有序帧流**：一切与线序有关的动作（传输/CS/DC/延时…）
 *   3) bulk IN  0x8B —— 应答流：读数据 + 每个 RSP 帧的应答（按 seq 配对）
 *
 * 🚨 两条会"静默出错"的纪律（固件 sb_process_packets 的实际语义）：
 *   · **一帧不跨 USB 包**（包 = 一次 OUT 回调，≤ 512 B）：帧跨包 → 固件在包内放不下 → frames_err。
 *   · 包尾剩余 **< 8 B** 才是"残渣"（静默丢弃）；**≥ 8 B 且 magic 不对 → frames_err++**。
 *     → 所以打包器**绝不填充**，只用"短包"（长度 = 帧总长）收尾。见 packFrames()。
 */

// ============================================================================
// 端点与帧尺寸
// ============================================================================

export const EP_SPI_IN = 0x8b;   // EP11 IN  —— 应答流（描述符里的地址）
export const EP_SPI_OUT = 0x0b;  // EP11 OUT —— 帧流
export const EP_NUM = 11;        // 🚨 WebUSB 的 endpointNumber **不含方向位**：0x8B→11/'in'、0x0B→11/'out'
export const PKT = 512;          // HS bulk 最大包 = OUT/IN 环槽大小
export const FRAME_MAX = PKT - 8;              // 一帧最多占多少字节（504）
export const XFER_HDR = 12;                    // XFER 的传输头
export const XFER_TX_MAX = FRAME_MAX - XFER_HDR; // 单帧能带的发送数据上限（492）

export const MAGIC = 0x4253;                 // 线上字节序 'S','B'
export const RSP_HDR = 8;                    // 应答包也是 8 B 头

// ============================================================================
// 帧（bulk OUT）
// ============================================================================

export const T = {
  XFER: 0x01, CS: 0x02, GPIO: 0x03, DELAY: 0x04, PING: 0x05,
  CFG: 0x06, STEP: 0x07, RESET: 0x08, AUX_IN: 0x09,
};
export const T_NAME = {
  0x01: 'XFER', 0x02: 'CS', 0x03: 'GPIO', 0x04: 'DELAY', 0x05: 'PING',
  0x06: 'CFG', 0x07: 'STEP', 0x08: 'RESET', 0x09: 'AUX_IN',
};

/** 帧 flags */
export const F = {
  RSP: 1 << 0,        // 要求回一个应答包
  CS_HOLD: 1 << 1,    // 本帧后保持 CS 有效
  CS_OFF: 1 << 2,     // 本帧后释放 CS
  CS_AUX: 1 << 3,     // 本次用辅助 CS 线
  NO_DMA: 1 << 4,     // 强制轮询
  FORCE_DMA: 1 << 5,  // 强制 DMA
};
export const F_BITS = [
  ['RSP', F.RSP], ['CS_HOLD', F.CS_HOLD], ['CS_OFF', F.CS_OFF],
  ['CS_AUX', F.CS_AUX], ['NO_DMA', F.NO_DMA], ['FORCE_DMA', F.FORCE_DMA],
];

/** XFER 的 tcfg 位域 */
export const TC = {
  LINES_1: 0x00, LINES_2: 0x01, LINES_4: 0x02, LINES_MASK: 0x03,
  CMD_EN: 1 << 2, ADDR_EN: 1 << 3, ADDR_QUAD: 1 << 4,
  DC_EN: 1 << 5, DC_LEVEL: 1 << 6, TOKEN_EN: 1 << 7,
};
export const linesToTcfg = n => (n === 4 ? TC.LINES_4 : n === 2 ? TC.LINES_2 : TC.LINES_1);
export const tcfgToLines = c => ((c & TC.LINES_MASK) === TC.LINES_4 ? 4 : (c & TC.LINES_MASK) === TC.LINES_2 ? 2 : 1);

/** 辅助脚线号（SB_T_GPIO / SB_LINE_*）*/
export const LINE = { DC: 0, RST: 1, CS_AUX: 2, BL: 3, TE: 4 };
export const LINE_NAME = { 0: 'DC', 1: 'RST', 2: 'CS(辅助)', 3: 'BL', 4: 'TE(输入)' };

/** CFG 帧的子命令 */
export const CFG_SUB = { TX_DMA_THRESHOLD: 0 };

// ============================================================================
// 应答（bulk IN）
// ============================================================================

export const R = { RSP: 0x81, EVT: 0x82 };

export const ST = {
  OK: 0, DISABLED: 1, BAD_MAGIC: 2, BAD_FRAME: 3, RANGE: 4,
  TIMEOUT: 5, IN_FULL: 6, DMA: 7, BUSY: 8, GPIO: 9,
};
export const ST_TEXT = {
  0: 'OK', 1: '桥未使能', 2: '帧头魔数错', 3: '帧格式/长度非法', 4: '参数越界',
  5: 'SPI 超时', 6: 'IN 环满（应答被丢）', 7: 'DMA 错误', 8: '设备忙', 9: '辅助脚未配置',
};
/** AUX_IN 应答的位图 */
export const AUXIN_TE = 1 << 0;

// ============================================================================
// HID 控制面（CMD 0x35）
// ============================================================================

/**
 * 🚨 偏移映射（WebHID 与固件差 1 字节，别搞混）：
 *   固件的 req_hid/res_hid **含 Report ID**（req_hid[0]=ID、[1]=len、[2]=cmd、[3]=action）；
 *   WebHID 的 sendReport(id, payload) / inputreport.data **不含 Report ID**，
 *   所以 payload[0]=len、payload[1]=cmd、payload[2]=action、payload[3..]=数据。
 *   （AkaLinkHid 的 _handleInput 用 `res[1] === cmd` 判归属，正好印证这一层。）
 */
export const HID_CMD = 0x35;
export const HID_OFF_CMD = 1;     // payload[1] = 命令号
export const HID_OFF_ACTION = 2;  // payload[2] = action
export const HID_OFF_DATA = 3;    // payload[3..] = 数据（= 固件的 res_hid[4..]）

export const ACT = {
  STATUS: 0, ENABLE: 1, RESET: 2, SET_CFG: 3, GET_CFG: 4,
  PIN_CFG: 5, ABORT: 6, SET_PROFILE: 7, GET_PROFILE: 8, DRAIN: 9,
  // 10/11/12 = DBG / PINTEST / WIGGLE：固件侧的**研发调板**诊断，本页不做 UI（用户 2026-09-29 明确）。
  // 记在这里只是别让以后的人以为号段空着。
};
export const ACT_NAME = {
  0: 'STATUS', 1: 'ENABLE', 2: 'RESET', 3: 'SET_CFG', 4: 'GET_CFG',
  5: 'PIN_CFG', 6: 'ABORT', 7: 'SET_PROFILE', 8: 'GET_PROFILE', 9: 'DRAIN',
};

/** 状态字（res 数据区第 1 个字）*/
export const ST_BIT = {
  ENABLED: 1 << 0, ACTIVE: 1 << 1, CS: 1 << 2, IN_FLOW: 1 << 3, OUT_FULL: 1 << 4,
};
export const ST_BIT_NAME = [
  ['已使能', ST_BIT.ENABLED], ['忙', ST_BIT.ACTIVE], ['CS 有效', ST_BIT.CS],
  ['IN 流控', ST_BIT.IN_FLOW], ['OUT 近满', ST_BIT.OUT_FULL],
];
export const statusWord = w => ({
  raw: w >>> 0,
  enabled: !!(w & ST_BIT.ENABLED), active: !!(w & ST_BIT.ACTIVE), cs: !!(w & ST_BIT.CS),
  inFlow: !!(w & ST_BIT.IN_FLOW), outFull: !!(w & ST_BIT.OUT_FULL),
  err: (w >>> 8) & 0xff,
});
export const statusText = w => {
  const s = statusWord(w);
  const on = ST_BIT_NAME.filter(([, b]) => w & b).map(([n]) => n);
  return (on.join('|') || '-') + (s.err ? ` · 最近错误 ${s.err}/${ST_TEXT[s.err] || '?'}` : '');
};

export const CFG_LEN = 32;
export const PROFILE_LEN = 16;

/** CS 策略：**按 spi_bridge.c 的实现**（proto.h 的注释是反的，别照抄）。
 *  默认那条的固定脚 2026-09-30 起是 **PB10**（SPI2 的 CS0），不再是 PA26。 */
export const CS_POLICY = [
  { v: 0, short:'0 · PB10 自动（默认）', label: '0 · PB10 作 GPIO CS（默认，软件拉/放）' },
  { v: 1, short:'1 · 辅助脚自动', label: '1 · 辅助脚作 GPIO CS（多器件）' },
  { v: 2, short:'2 · PB10 手动', label: '2 · 手动（PB10 作 GPIO，由 CS 帧控制）' },
  { v: 3, short:'3 · 硬件 CS0', label: '3 · 硬件 CS0（每次事务自动，时序由 TIMING 定）' },
];

export const PROFILE_KIND = { RAW: 0, SPI_DCX: 1, QSPI: 2 };
export const PROFILE_NAME = { 0: 'raw（普通 SPI 器件）', 1: 'spi_dcx（SPI + DC/RS，如 AXS15352）', 2: 'qspi（QSPI 屏，如 ST77916）' };
/** 侧栏下拉用的短名（长名字在 300px 宽的侧栏里会被裁掉半截）*/
export const PROFILE_SHORT = { 0: 'raw（普通 SPI）', 1: 'spi_dcx（SPI + DC）', 2: 'qspi（QSPI 屏）' };

/** pad 索引表（协议内固定；0 = 不用）。`note` 里写明固件的拒绝规则（PY00/PY01 在 v1 不支持）*/
export const PADS = [
  { i: 0, name: '（不用）', j3: '' },
  { i: 1, name: 'PB11', j3: 'J3[13]（SPI2_SCLK，别选）' },
  { i: 2, name: 'PB12', j3: 'J3[27]（SPI2_MISO，别选）' },
  { i: 3, name: 'PB13', j3: 'J3[28]（SPI2_MOSI，别选）' },
  { i: 4, name: 'PB10', j3: 'J3[26]（SPI2_CS，别选）' },
  { i: 5, name: 'PA02', j3: 'J3[7]' },
  { i: 6, name: 'PA09', j3: 'J3[32]（TinyUF2 按键）' },
  { i: 7, name: 'PA00', j3: 'J3[36]（UART0 TX / log）' },
  { i: 8, name: 'PA01', j3: 'J3[38]（UART0 RX / log）' },
  { i: 9, name: 'PY00', j3: 'J3[29]（v1 不支持）' },
  { i: 10, name: 'PY01', j3: 'J3[31]（v1 不支持）' },
  { i: 11, name: 'PA10', j3: 'J3[33]（固件 LED 任务每 50 ms 写它，实测驱动不出持续电平，别选）' },
  { i: 12, name: 'PA30', j3: 'J3[37]（USB0_PWR：被板上 Q1 短到地，拉不动，别用）' },
  { i: 13, name: 'PA31', j3: 'J3[11]（USB0_ID 网络；实测可当慢速输出，BL 推荐）' },
  /* 2026-09-30 释放：J3 上原 SPI1 显示接口那四根。桥搬到 SPI2 后固件里零引用
   * （SWD=PA06/PA07、nRESET=PA08、CDC=PB08/PB09、log=PA00/PA01），实测固件已接受
   * 索引 14~17（烧录后逐个回读通过）。⚠️ 若固件切到 akaLinkPro 板级构建，
   * PA26/PA27/PA28 会被 nRESET/SWCLK/SWDIO 占走，届时要重新限制。 */
  { i: 14, name: 'PA26', j3: 'J3[24]（原 SPI1 显示 CS；2026-09-30 起可用）' },
  { i: 15, name: 'PA27', j3: 'J3[23]（原 SPI1 SCLK；2026-09-30 起可用）' },
  { i: 16, name: 'PA28', j3: 'J3[21]（原 SPI1 MISO；2026-09-30 起可用）' },
  { i: 17, name: 'PA29', j3: 'J3[19]（原 SPI1 MOSI；2026-09-30 起可用）' },
];
export const PAD_NAME = Object.fromEntries(PADS.map(p => [p.i, p.name]));

/**
 * 辅助线的**默认脚位** —— 没配置时引脚图就按这张表标，也就是"照着接线"的推荐位置。
 *
 * 用户 2026-09-30 定的规矩（原话：*把用到的所有脚都显示在上面，采用默认脚位；
 * 我手动变了配置你就跟着改，没改就用默认的*）：
 *   ① 图上脚位 = **配置值优先，没配就用这里的默认值**，**与屏型号无关**；
 *      （曾经让默认值跟着屏型号预设走，结果 ST 档 DC=0 整根线消失、切到 AXS 档
 *        BL 指到实测不能用的 PA10 —— 用户的原话是"经常脚位不对，或漏掉"。）
 *   ② 只放**实测能用**的脚，不放"理论上能用"的；
 *   ③ 默认值彼此不冲突，也不撞 SPI2 固定脚（PB10~PB13）。
 *
 * 取值依据：
 *   · RST = PA02（J3[7]）  ：LA 实测复位置低脉冲干净（10 ms）
 *   · BL  = PA31（J3[11]） ：LA 实测电平干净（327~347 ms 档位）
 *   · DC  = PA26（J3[24]） ：2026-09-30 从 SPI1 显示口释放出来的脚，固件已接受索引 14
 *     （⚠️ 只验到"固件接受 + 回读一致"，**没在 LA 上看过波形**；QSPI 档本来也不用 DC）
 *   · CS_AUX / TE 默认不用：CS_AUX 只在挂第二片时才有意义；TE 是输入，不接也能刷图
 */
export const AUX_DEFAULT = { DC: 14, RST: 5, CS_AUX: 0, BL: 13, TE: 0 };

/** 有效电平位图 bit0 DC / bit1 RST / bit2 CS / bit3 BL */
export const AL_BITS = [['DC', 0], ['RST', 1], ['CS', 2], ['BL', 3]];
/** 取某条线的有效电平（1 = 低有效）—— 对应固件 sb_line_active_low() */
export const lineActiveLow = (bitmap, line) => !!(((bitmap | 0) >> line) & 1);

/** SCLK 档位（用户 2026-09-29 拍板：5301EVKLite 上限 75 MHz；0 = 板级默认 20 MHz）*/
export const SCLK_CHOICES = [
  { hz: 0, label: '板级默认（20 MHz）' },
  { hz: 10000000, label: '10 MHz' },
  { hz: 20000000, label: '20 MHz' },
  { hz: 40000000, label: '40 MHz' },
  { hz: 60000000, label: '60 MHz' },
  { hz: 75000000, label: '75 MHz（板子上限）' },
];
export const sclkLabel = hz => {
  const n = Number(hz) || 0;
  if (!n) return '板级默认（20 MHz）';
  return n >= 1e6 ? (n / 1e6) + ' MHz' : (n / 1e3) + ' kHz';
};

// ============================================================================
// 帧构造
// ============================================================================

const u16 = (dv, off, v) => dv.setUint16(off, v & 0xffff, true);
const u32 = (dv, off, v) => dv.setUint32(off, v >>> 0, true);

/** 组一帧（8 B 头 + payload）。超过 FRAME_MAX 直接抛错（宁可早炸，不要线上出鬼）*/
export function frame(type, payload = new Uint8Array(0), opts = {}){
  const flags = opts.flags | 0, seq = (opts.seq | 0) & 0xffff;
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (body.length > FRAME_MAX) throw new Error(`payload ${body.length} B 超过单帧上限 ${FRAME_MAX} B`);
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  u16(dv, 0, MAGIC); out[2] = type & 0xff; out[3] = flags & 0xff;
  u16(dv, 4, seq); u16(dv, 6, body.length);
  out.set(body, 8);
  return out;
}

/** XFER 的 12 B 传输头 + 发送数据 */
export function xferPayload(o = {}){
  const tx = o.tx instanceof Uint8Array ? o.tx : new Uint8Array(o.tx || 0);
  const out = new Uint8Array(XFER_HDR + tx.length);
  const dv = new DataView(out.buffer);
  out[0] = (o.cmd | 0) & 0xff;
  out[1] = (o.tcfg | 0) & 0xff;
  out[2] = (o.addrLen | 0) & 0xff;
  out[3] = (o.dummy | 0) & 0xff;
  u16(dv, 4, tx.length); u16(dv, 6, o.rxLen | 0); u32(dv, 8, o.addr | 0);
  out.set(tx, XFER_HDR);
  return out;
}

/** STEP：u8 cmd, u8 nparams, u16 delay_ms, params[]（面板初始化步，按当前面板档展开）*/
export function stepPayload(o = {}){
  const p = o.params instanceof Uint8Array ? o.params : new Uint8Array(o.params || 0);
  if (p.length > 255) throw new Error('STEP 的参数最多 255 字节（协议里 nparams 是 1 字节）');
  const out = new Uint8Array(4 + p.length);
  const dv = new DataView(out.buffer);
  out[0] = (o.cmd | 0) & 0xff; out[1] = p.length;
  u16(dv, 2, o.delayMs | 0);
  out.set(p, 4);
  return out;
}

export function csPayload(assert){ return Uint8Array.of(assert ? 1 : 0); }
export function gpioPayload(line, level){ return Uint8Array.of(line & 0xff, level ? 1 : 0); }
export function delayPayload(us){ const b = new Uint8Array(4); u32(new DataView(b.buffer), 0, us); return b; }
export function resetPayload(lowMs, postMs){ const b = new Uint8Array(4); const dv = new DataView(b.buffer); u16(dv, 0, lowMs); u16(dv, 2, postMs); return b; }
export function cfgThresholdPayload(hz){ const b = new Uint8Array(3); const dv = new DataView(b.buffer); b[0] = CFG_SUB.TX_DMA_THRESHOLD; u16(dv, 1, hz); return b; }

// ============================================================================
// 打包器 —— 一帧不跨包、绝不填充
// ============================================================================

/**
 * 把一串帧切成"包"（每个 ≤ maxPacket）。
 *
 * 为什么必须自己切：固件按**一次 OUT 回调 = 一个包**解析，包内可含多帧，但**一帧不能跨包**；
 * 且包尾剩余 ≥ 8 B 时会去读 magic → 不是 0x4253 就 `frames_err++`。
 * 所以这里的规则是：贪心累加，放不下就开新包；**不做任何填充**（包长 = 里面帧的总长，
 * 长度不足 512 时 USB 侧自然是"短包"，固件解析到包尾正好干净收尾）。
 *
 * 收益：面板初始化那种"几百条小帧"从几百次 USB 往返压到十几次。
 * 图片帧（492 B 数据 + 8 B 头 = 500 B）本来就是一帧一包，没有攒批空间 —— 那边靠多条在飞提速。
 */
export function packFrames(frames, maxPacket = PKT){
  const packs = [];
  let cur = [], curLen = 0;
  const flush = () => {
    if (!curLen) return;
    const out = new Uint8Array(curLen);
    let off = 0;
    for (const f of cur){ out.set(f, off); off += f.length; }
    packs.push(out);
    cur = []; curLen = 0;
  };
  for (const f of frames){
    const b = f instanceof Uint8Array ? f : new Uint8Array(f);
    if (b.length > maxPacket) throw new Error(`单帧 ${b.length} B 超过一个包 ${maxPacket} B —— 固件无法解析`);
    if (curLen + b.length > maxPacket) flush();
    cur.push(b); curLen += b.length;
  }
  flush();
  return packs;
}

/** 一次 bulk 传输（URB）能带多少字节的上限保护 —— 不是 USB 的限制（USB 层面多大都行），
 *  只是别让一次调用带上几 MB，出问题时连"发到哪儿了"都说不清。 */
export const BATCH_MAX = 60 * 1024;

/** 页面里"多少字节攒一次 transferOut"的档位（真机实测 8 KB 起就到底了，见 panel 页的旋钮说明）*/
export const BATCH_CHOICES = [PKT, 4096, 8192, 16384, 32768];

/**
 * 把"包"合并成"一次 transferOut 提交的批"（攒批）。
 *
 * 为什么这样是对的（2026-10 定案，用户点破 + 真机数据复核）：
 *   · 固件**每次 arm 一个 512 B 槽**，收满就回调、解析这一槽里的帧（`spi_bridge.c` 的
 *     `s_out_buf[slot][512]` + `usbd_ep_start_read(..., SB_PKT_SIZE)`）；
 *   · 但 **USB 层面一次 bulk 传输可以带任意多个 512 B 包**：内核自动切包，设备没准备好就 NAK
 *     —— 这就是背压，不需要主机"一次只交一个包"。
 *   · 所以"每片一个 transferOut"是主机侧自找的开销：真机实测每次调用 ~150 µs，
 *     一帧 290 个包 ≈ 44 ms；而 60 MHz 单线 SPI 刷一帧只要 18.9 ms ⇒ 帧率被主机侧调用次数锁死。
 *   · 攒批之后设备看到的**包序列完全一样**（同样的 512 B 槽、同样的帧），只是主机少喊几次。
 *
 * 唯一的硬约束：**短包只能落在一批的末尾**。
 *   · 设备 arm 的是固定 512 B 缓冲，"收到短包"= 这次端点传输到此为止；
 *   · 短包夹在中间 → 它后面的包会被当成新的一次传输（白等一次 arm），对齐也乱。
 *   · 刷屏的实际形状：像素片正好 512 B（整包），只有帧头那几条命令帧（16/16/21 B）
 *     和末片（404 B）是短包 —— 让它们各自收尾即可，**不需要补任何填充字节**。
 *
 * @param {Uint8Array[]} packs 每个 ≤ PKT
 * @param {number} [batchBytes=PKT] 一批的上限；= PKT 时与"每包一次 transferOut"完全等价（零行为变化）
 * @returns {Array<{data:Uint8Array, packs:number, bytes:number}>}
 */
export function batchPacks(packs, batchBytes = PKT){
  const limit = Math.max(PKT, Math.min((batchBytes | 0) || PKT, BATCH_MAX));
  const out = [];
  let cur = [], curLen = 0;
  const flush = () => {
    if (!curLen) return;
    if (cur.length === 1) out.push({ data: cur[0], packs: 1, bytes: curLen });
    else {
      const buf = new Uint8Array(curLen);
      let off = 0;
      for (const p of cur){ buf.set(p, off); off += p.length; }
      out.push({ data: buf, packs: cur.length, bytes: curLen });
    }
    cur = []; curLen = 0;
  };
  for (const p of packs){
    const b = p instanceof Uint8Array ? p : new Uint8Array(p);
    if (b.length > PKT) throw new Error(`单包 ${b.length} B 超过 ${PKT} B（固件按 512 B 槽解析）`);
    if (!b.length) continue;
    if (curLen && curLen + b.length > limit) flush();
    cur.push(b); curLen += b.length;
    if (b.length < PKT) flush();            // 短包 = 这一批的尾巴
  }
  flush();
  return out;
}

/**
 * 按**固件同样的规则**解析一个包（自测/日志/假探针共用）：
 * 返回 { frames:[{type,flags,seq,len,payload,off}], residue, err }。
 * `residue` = 包尾 < 8 B 的残渣（固件静默丢弃）；`err` = 第一处硬错误（固件据此 frames_err++ 并丢弃整包剩余）。
 */
export function parsePack(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const frames = [];
  let off = 0, residue = 0, err = null;
  while (off < b.length){
    if (b.length - off < 8){ residue = b.length - off; break; }   // 尾部残渣：固件静默丢弃
    if (dv.getUint16(off, true) !== MAGIC){ err = { off, why: 'bad_magic' }; break; }
    const len = dv.getUint16(off + 6, true);
    if (len + 8 > b.length - off){ err = { off, why: 'bad_len', len }; break; }
    frames.push({
      off, type: b[off + 2], flags: b[off + 3], seq: dv.getUint16(off + 4, true), len,
      payload: b.subarray(off + 8, off + 8 + len),
    });
    off += 8 + len;
  }
  return { frames, residue, err };
}

/** 复核一个"包序列"是否满足固件纪律（自测用；返回问题列表，空数组 = 干净）*/
export function checkPacks(packs, maxPacket = PKT){
  const bad = [];
  packs.forEach((p, i) => {
    if (p.length > maxPacket) bad.push(`包 ${i} 长 ${p.length} > ${maxPacket}`);
    if (p.length === 0) bad.push(`包 ${i} 是空的`);
    const r = parsePack(p);
    if (r.err) bad.push(`包 ${i} 解析错误 ${r.err.why} @${r.err.off}`);
    if (r.residue >= 8) bad.push(`包 ${i} 残渣 ${r.residue} B（≥8 会被当成帧头）`);
  });
  return bad;
}

// ============================================================================
// 应答解析与配对
// ============================================================================

/** 解析一个应答包 → {type,status,seq,len,data} | null */
export function parseRsp(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < RSP_HDR) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(0, true) !== MAGIC) return null;
  const len = dv.getUint16(6, true);
  return {
    type: b[2], status: b[3], seq: dv.getUint16(4, true), len,
    data: b.subarray(RSP_HDR, Math.min(RSP_HDR + len, b.length)),
  };
}

/**
 * IN 侧的**流切包器**：一次 `transferIn(4096)` 可能带回多个应答包（固件一个包一次写），
 * 包与包之间没有额外分隔 —— 只能按 8 B 头自描述地切。字节不完整时缓存，等下一块。
 * （bulk 是可靠传输，不会丢字节；真丢字节时 magic 校验会把它暴露出来，别静默吞掉。）
 */
export class RspStream {
  constructor(){
    this.buf = new Uint8Array(0);
    this.errors = 0;
    /** 流错位（magic/长度不对）时**丢掉整个缓冲**的次数与原因 —— 见 push() 里的 🚨 */
    this.desyncPending = null;
  }
  get pending(){ return this.buf.length; }
  reset(){ this.buf = new Uint8Array(0); }
  /**
   * 取走"刚才发生了一次流错位"这件事（取完清零）。调用方拿它写一条能对上号的日志。
   * @returns {{why:string, dropped:number}|null}
   */
  takeDesync(){ const d = this.desyncPending; this.desyncPending = null; return d; }
  /** @returns {Uint8Array[]} 切出来的完整应答包 */
  push(bytes){
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const merged = new Uint8Array(this.buf.length + b.length);
    merged.set(this.buf, 0); merged.set(b, this.buf.length);
    const out = [];
    let off = 0;
    while (merged.length - off >= RSP_HDR){
      const dv = new DataView(merged.buffer, merged.byteOffset + off, merged.byteLength - off);
      /**
       * 🚨 坏 magic / 坏长度时只能**丢掉整个缓冲**（分不清边界，继续切只会切出垃圾）。
       *    代价是：**同一块里排在后面的正常应答也一起丢了**，于是那些请求各自等满超时。
       *    所以这里除了计数，还要把"错位"这件事记下来给上层写日志 ——
       *    否则用户看到的是一串"应答超时"，根因（流错位）完全看不出来（2026-10 代码审查）。
       */
      const mg = dv.getUint16(0, true);
      if (mg !== MAGIC){
        this.errors++;
        this.desyncPending = { why: `magic 读到 0x${mg.toString(16).padStart(4, '0')}（应为 0x${MAGIC.toString(16).padStart(4, '0')}）`,
                               dropped: merged.length - off };
        off = merged.length; break;
      }
      const total = RSP_HDR + dv.getUint16(6, true);
      if (total > PKT){
        this.errors++;
        this.desyncPending = { why: `包长字段 ${total} 超过一个包的上限 ${PKT}`, dropped: merged.length - off };
        off = merged.length; break;
      }
      if (merged.length - off < total) break;               // 半包：等下一块
      out.push(merged.subarray(off, off + total));
      off += total;
    }
    this.buf = merged.subarray(off);
    return out;
  }
}

/**
 * seq ⇄ 请求 的配对表。
 * 主机自己分配 seq（每帧一个，循环 1..0xFFFF），带 RSP 的帧才登记；
 * 应答到达时按 seq 兑现 —— **不能按"先来先服务"**：EVT 与迟到的应答会串位。
 */
export class RspMatcher {
  constructor(){ this.pending = new Map(); this.next = 1; this.events = []; }
  alloc(){ const s = this.next; this.next = (this.next + 1) & 0xffff || 1; return s; }
  /** @returns {Promise<{status,data,type}>} */
  wait(seq, timeoutMs = 1000, label = ''){
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`应答超时（${timeoutMs} ms）${label ? ' · ' + label : ''} · seq=${seq}`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer, label });
    });
  }
  /** 收一个应答包；返回 true = 有人认领（EVT 走 onEvent 或 events）*/
  feed(bytes, onEvent){
    const r = parseRsp(bytes);
    if (!r) return false;
    if (r.type === R.EVT || !this.pending.has(r.seq)){
      this.events.push(r);
      if (this.events.length > 64) this.events.shift();
      onEvent?.(r);
      return r.type === R.EVT;                     // EVT 也算"被消化"，但不解任何请求
    }
    const p = this.pending.get(r.seq);
    this.pending.delete(r.seq);
    clearTimeout(p.timer);
    p.resolve({ status: r.status, data: r.data, type: r.type });
    return true;
  }
  /** 收尾：把所有在飞请求拒掉（别让它们挂到超时）*/
  abortAll(why = '会话结束'){
    for (const [, p] of this.pending){ clearTimeout(p.timer); p.reject(new Error(why)); }
    this.pending.clear();
  }
  /** 取消**某一个**在飞请求（发送半路失败时用：别让它挂到超时，也别变成 unhandled rejection）*/
  cancel(seq, why = '已取消'){
    const p = this.pending.get(seq);
    if (!p) return false;
    this.pending.delete(seq);
    clearTimeout(p.timer);
    p.reject(new Error(why));
    return true;
  }
  get inflight(){ return this.pending.size; }
}

// ============================================================================
// 配置块 / 面板档（HID 0x35 的载荷）
// ============================================================================

export function encodeCfg(o = {}){
  const b = new Uint8Array(CFG_LEN);
  const dv = new DataView(b.buffer);
  u32(dv, 0, o.sclkHz | 0);
  b[4] = (o.mode ?? 0) & 0xff;   // ⚠️ 这里**不夹取**：非法值原样下发，让固件用 RANGE 明确拒绝（静默改值最难查）
  b[5] = (o.bits ?? 8) & 0xff;
  b[6] = o.csPolicy & 0xff;
  b[7] = o.txDmaThreshold ?? 100;
  b[8] = o.padDc & 0xff; b[9] = o.padRst & 0xff; b[10] = o.padCsAux & 0xff; b[11] = o.padBl & 0xff;
  b[12] = o.padActiveLow & 0xff;
  b[13] = o.padTe & 0xff;
  b[14] = o.flags & 0xff;
  u16(dv, 16, o.outRingKb ?? 0); u16(dv, 18, o.inRingKb ?? 0); u16(dv, 20, o.maxFrameBytes ?? FRAME_MAX);
  u32(dv, 24, o.moduleClkHz ?? 240000000); // SPI2 模块固定 240 MHz；旧提示值由固件归一化。
  return b;
}

export function decodeCfg(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    sclkHz: dv.getUint32(0, true), mode: b[4], bits: b[5], csPolicy: b[6], txDmaThreshold: b[7],
    padDc: b[8], padRst: b[9], padCsAux: b[10], padBl: b[11], padActiveLow: b[12], padTe: b[13],
    flags: b[14], reserved0: b[15],
    outRingKb: dv.getUint16(16, true), inRingKb: dv.getUint16(18, true), maxFrameBytes: dv.getUint16(20, true),
    moduleClkHz: dv.getUint32(24, true),
    raw: b,
  };
}

export const CFG_FLAG = { CLEAR_ON_ENABLE: 1 << 0 };

export function encodeProfile(o = {}){
  const b = new Uint8Array(PROFILE_LEN);
  b[0] = o.profile & 0xff; b[1] = o.defLines ?? 1;
  b[2] = o.dcActiveHigh ? 1 : 0; b[3] = o.csHoldInStep ? 1 : 0;
  b[4] = o.qspiWrOpcode ?? 0x02; b[5] = o.qspiColorOpcode ?? 0x32; b[6] = o.qspiAddrBytes ?? 3;
  b[7] = o.flags & 0xff;
  return b;
}

export function decodeProfile(bytes){
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    profile: b[0], defLines: b[1], dcActiveHigh: !!b[2], csHoldInStep: !!b[3],
    qspiWrOpcode: b[4], qspiColorOpcode: b[5], qspiAddrBytes: b[6], flags: b[7], raw: b,
  };
}

// ============================================================================
// HID 0x35 的请求/响应（纯函数；WebHID 那一层在 app/hid/probe.js）
// ============================================================================

/** `0x35` 的 data 段（= 固件 req_hid[4..]，在 WebHID payload 里从 HID_OFF_DATA 开始）*/
export const hidData = {
  status: () => Uint8Array.of(ACT.STATUS),
  enable: on => Uint8Array.of(ACT.ENABLE, on ? 1 : 0),
  reset: () => Uint8Array.of(ACT.RESET),
  abort: () => Uint8Array.of(ACT.ABORT),
  drain: count => Uint8Array.of(ACT.DRAIN, Math.max(0, Math.min(16, count))),
  setCfg: cfg => concat(Uint8Array.of(ACT.SET_CFG), cfg),
  getCfg: () => Uint8Array.of(ACT.GET_CFG),
  pinCfg: (line, pad) => Uint8Array.of(ACT.PIN_CFG, line & 0xff, pad & 0xff, 0),
  setProfile: prof => concat(Uint8Array.of(ACT.SET_PROFILE), prof),
  getProfile: () => Uint8Array.of(ACT.GET_PROFILE),
};

function concat(a, b){ const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
export { concat };

/**
 * 解析 `0x35` 的响应 payload（= `AkaLinkHid.xfer()` 的返回值，63 B）。
 * 🚨 计数器顺序**按固件实现**（spi_bridge.c:2125-2138），不是 proto.h 的 sb_stats_t 字段序：
 *   状态字 · frames_ok · bytes_tx · bytes_rx · tx_poll · tx_dma · out_ovf · in_drop · **实际 SCLK** ·
 *   **frames_err** · **last_ticks**（上一笔事务耗时，MCHTMR tick @24 MHz = 41.67 ns）
 */
export function parseStatusPayload(res){
  const dv = new DataView(res.buffer, res.byteOffset, res.byteLength);
  const w = i => dv.getUint32(HID_OFF_DATA + i * 4, true);
  if (res[HID_OFF_CMD] !== HID_CMD) throw new Error(`不是 0x35 的响应（cmd=0x${(res[HID_OFF_CMD] || 0).toString(16)}）`);
  const lastTicks = res.byteLength >= HID_OFF_DATA + 44 ? w(10) : 0;
  return {
    action: res[HID_OFF_ACTION],
    status: w(0),
    framesOk: w(1), bytesTx: w(2), bytesRx: w(3), txPoll: w(4), txDma: w(5),
    outOverrun: w(6), inDrop: w(7), actualSclkHz: w(8), framesErr: w(9),
    lastTicks, lastUs: lastTicks / 24,      // MCHTMR 24 MHz → 微秒
  };
}

/** 解析状态字单独的那一类响应（ENABLE/RESET/SET_CFG/PIN_CFG/ABORT/SET_PROFILE 都是 `[4..7]`）*/
export function parseWordPayload(res){
  const dv = new DataView(res.buffer, res.byteOffset, res.byteLength);
  return dv.getUint32(HID_OFF_DATA, true);
}

/** Old firmware may return a padded error packet; require the explicit DRN1 capability. */
export function supportsDrain(res){
  return res?.byteLength >= 11 && res[0] >= 12 && res[HID_OFF_CMD] === HID_CMD &&
    res[HID_OFF_ACTION] === ACT.DRAIN &&
    new DataView(res.buffer, res.byteOffset, res.byteLength).getUint32(7, true) === 0x314e5244;
}

export function parseCfgPayload(res){ return decodeCfg(res.subarray(HID_OFF_DATA, HID_OFF_DATA + CFG_LEN)); }
export function parseProfilePayload(res){ return decodeProfile(res.subarray(HID_OFF_DATA, HID_OFF_DATA + PROFILE_LEN)); }

// ============================================================================
// 日志用摘要
// ============================================================================

export function describeFrame(type, payload, flags = 0, seq = 0){
  const fl = F_BITS.filter(([, b]) => flags & b).map(([n]) => n).join('|') || '-';
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const hx = (b, n = 8) => [...b.subarray(0, n)].map(x => x.toString(16).padStart(2, '0')).join(' ');
  let body = `${p.length} B`;
  switch (type){
    case T.XFER: {
      if (p.length >= XFER_HDR){
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const txLen = dv.getUint16(4, true), rxLen = dv.getUint16(6, true), addr = dv.getUint32(8, true);
        body = `cmd=0x${p[0].toString(16).padStart(2, '0')} ${tcfgToLines(p[1])}线` +
               `${p[1] & TC.CMD_EN ? ' cmd_en' : ''}${p[1] & TC.ADDR_EN ? ` addr_len=${p[2]}` : ''}` +
               `${p[3] ? ` dummy=${p[3]}` : ''}${p[1] & TC.DC_EN ? ` DC=${p[1] & TC.DC_LEVEL ? 1 : 0}` : ''}` +
               ` tx=${txLen} rx=${rxLen}${p[2] ? ` addr=0x${addr.toString(16)}` : ''}`;
        if (txLen) body += ` · ${hx(p.subarray(XFER_HDR), 8)}${txLen > 8 ? ' …' : ''}`;
      }
      break;
    }
    case T.STEP: if (p.length >= 4){
      const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      body = `cmd=0x${p[0].toString(16).padStart(2, '0')} n=${p[1]} delay=${dv.getUint16(2, true)}ms` +
             (p[1] ? ` · ${hx(p.subarray(4), 8)}` : '');
      break; }
    case T.GPIO: body = p.length >= 2 ? `${LINE_NAME[p[0]] || p[0]} = ${p[1] ? 1 : 0}` : body; break;
    case T.CS: body = p[0] ? '拉低（占用）' : '释放'; break;
    case T.DELAY: body = p.length >= 4 ? `${new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true)} µs` : body; break;
    case T.RESET: body = p.length >= 4 ? `拉低 ${new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(0, true)} ms + 等 ${new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(2, true)} ms` : body; break;
    case T.PING: body = '保活'; break;
    case T.AUX_IN: body = '读辅助输入'; break;
    default: break;
  }
  return `${T_NAME[type] || ('0x' + type.toString(16))}${seq ? ` #${seq}` : ''} [${fl}] ${body}`;
}
