/**
 * J-Scope 波形页的**协议层**（纯函数，Node 里直接测）。
 *
 * 两个面（细节见 docs/scope-page.md §5 / §7.1）：
 *   · 控制面 = HID `0x32 SCOPE`（形状照抄 `0x31`：action + rc + 12 个状态字）
 *   · 数据面 = vendor bulk IN 端点 `0x83` 上的 **512 B 自描述包流**
 *
 * 为什么要"每包自描述"：端点是无边界字节流，一次 `transferIn(4096)` 可能拿到 8 个整包、
 * 也可能因为短包只拿到一部分。每包带 magic + seq + 时间戳，才能做到
 * **坏包只影响它自己、丢包能被数出来**（而不是把字节错位当成波形画出去）。
 */
import { SCALARS } from '../elf/dwarf.js';

export const MAGIC = 0x4a53;            // 'J','S'（小端存储 = 53 4a）
export const VERSION = 1;
export const VERSION_TICKS = 2;
export const TIME_HZ = 24000000;
export const ticksForUs = us => Math.round(us * TIME_HZ / 1e6);
export const usForTicks = ticks => ticks * 1e6 / TIME_HZ;
export const PACKET = 512;              // 一个 USB 包的字节数（HS bulk 的 wMaxPacketSize）
export const HEADER = 16;
export const PAYLOAD = PACKET - HEADER; // 496

export const KIND = { DEF: 1, DATA: 2, STAT: 3, EVT: 4 };
export const KIND_NAME = { 1: 'DEF', 2: 'DATA', 3: 'STAT', 4: 'EVT' };

/** 线上类型表：**索引就是 code 字节**（与 app/elf/dwarf.js 的 SCALARS 同源，避免两处定义打架）*/
export const TYPES = [];
for (const [name, s] of Object.entries(SCALARS)) TYPES[s.code] = { name, ...s };
export const typeInfo = code => TYPES[code] || null;
export { SCALARS };                    // 页面算帧长/画图都要用，从这里转出去省一次 import

/**
 * 采样计划 / 速率模型。
 *
 * **SWD 侧按 akaLinkPro 最新拟合重算**（2026-09-30；那边 README §scope 与 `Custom HID Protocol.md` §16）：
 *   每次 SWD 传输的实测成本 = `36.2 × 指令/bit + 184 周期`，60 MHz 档 = **401 周期 = 1.115 µs**；
 *   当前 swd_read_block 的稳态是 N+2 次传输（TAR、prime、N-1 次 DRW、RDBUFF）。
 *   60 MHz 的经验拟合为每块固定 3.35 µs + 每字节 0.279 µs；固定项含软件开销，
 *   不等于 3 次线上传输。其他时钟按传输模型缩放，软件固定项保留；冷配置另计。
 *   真机锚点（F103 @60 MHz）与这个式子的偏差：单字 4.503 vs 4.47、2 字 5.82 vs 5.58、
 *   4 字 7.96 vs 7.81、6 字 10.30 vs 10.05、8 字 12.65 vs 12.28 —— 全在 +1~4%（模型略乐观）。
 *   `fastWordUs` 是**实测值**（单字流水读快路径，见 planReads 的注释）。
 */
export const COST = { perBlockUs: 3.35, perByteUs: 0.279, refMhz: 60, fastWordUs: 1.55 };

/**
 * 单个 span 的读缓冲上限 = 固件 `SCOPE_SPAN_MAX`（8 个 f64 = 64 B）。
 * 🚨 合并时必须一起带上：漏了它，网页会把固件其实拆成两个的 span 算成一个 ——
 *    DEF 包里回报的 span 数就对不上（页面对账会报"两边合并规则不一致"）。
 */
export const SPAN_MAX_BYTES = 64;

/**
 * RISC-V/JTAG 侧的**实测**基线（akaLinkPro 2026-09-30 第二轮审查后的数字）：
 *   · `singleWordUs` = **3.17 µs** —— 单变量快路径（SBA 抱固定地址 + posted 扫描，每拍 1 次 DMI 扫描）。
 *     P1-1 修掉"每 32 拍静默毁一个样本"之后实测 3.17 µs（修之前 4.25 µs）⇒ ≈315 kHz，
 *     已经贴着一次 54 TCK 扫描（≈2.7 µs）的时序下限；
 *   · `pack8Us` = **36.6 µs** —— 8 通道连续 u32（32 B 一个 span，含收尾那 2 次查 SBCS 的扫描）⇒ ≈27.3 kHz；
 *   块读估算按当前固件 N+4 次稳态 DMI 扫描计算，含对齐与地址间隙；
 *   冷启动、目标总线等待和错误重试会增加耗时，当前计划的成功标定优先。
 */
// Block reads in the current probe use N+4 steady-state DMI scans (cold setup/retries cost more).
// The hold-path measurement is only a coarse scan budget; calibrate the actual plan before use.
export const RISCV_COST = { singleWordUs: 3.17, pack8Us: 36.6, scanUs: 3.17, scansPerSpan: 4 };

/** JTAG 下的每样本耗时估算（µs）。锚点见 RISCV_COST；`plan` 出自 planReads()。 */
export const alignedSpanBytes = span => Math.ceil(span.end / 4) * 4 - Math.floor(span.start / 4) * 4;
export const riscvPlanUs = plan => plan.fastPath ? RISCV_COST.singleWordUs :
  plan.spans.reduce((n, span) => n + alignedSpanBytes(span) / 4 + RISCV_COST.scansPerSpan, 0) * RISCV_COST.scanUs;

export function swdCostAt(mhz = COST.refMhz){
  const clock = Number.isFinite(mhz) && mhz > 0 ? mhz : COST.refMhz;
  // Measured instruction + wire cost: (184 + 36.2 * 360 / MHz) / 360 us per transfer.
  const transfer = 184 / 360 + 36.2 / clock;
  const reference = 184 / 360 + 36.2 / COST.refMhz;
  return { perBlockUs: COST.perBlockUs + 2 * (transfer - reference),
    perByteUs: COST.perByteUs * transfer / reference };
}

export const recommendedPeriodUs = (us, backend = BACKEND.SWD) =>
  Number.isFinite(us) && us > 0 ? Math.max(3, Math.ceil(backend === BACKEND.RISCV ? us * 1.5 : us * 1.15 + 1)) : null;

/** A read benchmark excludes scheduling/USB costs. It cannot promise a sustained rate. */
export function samplingRateAdvice(requestedUs, readUs, backend = BACKEND.SWD){
  const valid = Number.isFinite(requestedUs) && requestedUs > 0;
  const appliedUs = valid ? Math.min(1e6, Math.max(2, usForTicks(ticksForUs(requestedUs)))) : null;
  const recommendedUs = recommendedPeriodUs(readUs, backend);
  return { valid, requestedUs, appliedUs, recommendedUs,
    recommendedHz: recommendedUs ? 1e6 / recommendedUs : null,
    readCeilingHz: recommendedUs ? 1e6 / Math.max(2, readUs) : null,
    normalized: valid && Math.abs(requestedUs - appliedUs) > 1e-9,
    aboveReadCeiling: valid && recommendedUs != null && appliedUs < readUs,
    aboveRecommendation: valid && recommendedUs != null && appliedUs < recommendedUs };
}

// ---------------------------------------------------------------- 采样计划
/**
 * 把变量列表排成"读计划"：地址排序 → 相邻的合并进同一个 span。
 *
 * 合并的判据（唯一解）：多读 gap 个字节的代价 < 省下的那次块固定开销
 *    gap × perByteUs < perBlockUs  →  gap ≤ 12 B（@60 MHz 的模型推出来的）
 * 这就是固件里的 `SCOPE_MERGE_GAP = 12`（`scope_sampler.c`，注释写明"与网页 planReads() 同源"）——
 * 两边必须给同一个答案：DEF 包里回报的跨度数会跟这里的 `spans.length` 对账。
 * 所以"把被采样的量放进同一个结构体"能快好几倍，而散落变量只能各读各的。
 *
 * @param {Array<{name,addr,size,scalar}>} vars
 * @returns {{spans:Array, frameBytes:number, estUs:number, estHz:number, naiveUs:number}}
 */
export function planReads(vars, opts = {}){
  const maxGap = opts.maxGapBytes ?? Math.floor(COST.perBlockUs / COST.perByteUs);
  const maxSpan = opts.maxSpanBytes ?? SPAN_MAX_BYTES;
  const list = [...vars].sort((a, b) => a.addr - b.addr);
  const spans = [];
  let frameBytes = 0;
  for (const v of list){
    frameBytes += v.size;
    const last = spans[spans.length - 1];
    const start = v.addr, end = v.addr + v.size;
    // 两个条件都要：间隙够近（省一次块固定开销）**且**并完不超过固件的 span 缓冲上限
    if (last && start - last.end <= maxGap && (end - last.start) <= maxSpan){
      last.end = Math.max(last.end, end);
      last.len = last.end - last.start;
      last.vars.push(v);
    } else {
      spans.push({ start, end, len: v.size, vars: [v] });
    }
  }
  const cost = swdCostAt(opts.swdMhz);
  const readBytes = spans.reduce((n, span) => n + alignedSpanBytes(span), 0);
  const naiveBytes = list.reduce((n, v) => n + alignedSpanBytes({ start: v.addr, end: v.addr + v.size }), 0);
  const blocksFor = span => 1 + Math.floor((span.end - 1) / 1024) - Math.floor(span.start / 1024);
  const readBlocks = spans.reduce((n, span) => n + blocksFor(span), 0);
  const naiveBlocks = list.reduce((n, v) => n + blocksFor({ start: v.addr, end: v.addr + v.size }), 0);
  const estUs = readBlocks * cost.perBlockUs + readBytes * cost.perByteUs;
  const naiveUs = naiveBlocks * cost.perBlockUs + naiveBytes * cost.perByteUs;
  /**
   * 固件有条**单字流水读**快路径（`s_pipe_ok`）：只有一个 span、4 字节对齐、整段正好 4 字节、
   * 且变量在内存与帧里都连续时，每拍**只发一次 DRW 读**、拿回来的值是上一拍的结果（AHB-AP 读是 posted 的）。
   * 判据与固件 `scope_span_is_direct()` + `s_nspans == 1 && len == 4` 一一对应，改一边别忘了另一边。
   * 实测（2026-09/10，F103 + akaLinkPro @60 MHz，两轮都在 1.548~1.588 µs）：单字 f32 = **1.55 µs/样本**
   * ⇒ 629~646 kHz；而模型那条路（3 次传输 + 1 次 DRW ≈ 4.47 µs）是给"没有快路径"的配置用的 ——
   * 拿模型当"能不能跑某个周期"的依据会把人吓退：用户就被"建议周期 ≥ 11 µs"挡住过，而他实测 3 µs 零丢。
   */
  const sp0 = spans.length === 1 ? spans[0] : null;
  const fastPath = !!sp0 && (sp0.start & 3) === 0 && (sp0.end - sp0.start) === 4 &&
    sp0.vars.reduce((s, v) => s + v.size, 0) === 4;
  const fastWordUs = opts.fastWordUs ?? COST.fastWordUs;
  const bestUs = fastPath ? Math.min(fastWordUs, estUs) : estUs;
  return {
    spans, frameBytes, readBytes, readBlocks, estUs, naiveUs, fastPath, bestUs,
    estHz: estUs > 0 ? Math.round(1e6 / estUs) : 0,
    bestHz: bestUs > 0 ? Math.round(1e6 / bestUs) : 0,
    /** 合并省下来的比例（0.7 = 省了 70%）*/
    saved: naiveUs > 0 ? 1 - estUs / naiveUs : 0,
  };
}

/** 计划指纹：让固件回报的 hash 能和主机对上（防止"配置没生效却在画图"）。
 *  按地址排序后再算 —— 指纹要描述"这个计划"，而不是"用户勾选的顺序"。 */
export function planHash(vars){
  let h = 0x811c9dc5;
  for (const v of [...vars].sort((a, b) => a.addr - b.addr)){
    for (const byte of [v.addr & 0xff, (v.addr >>> 8) & 0xff, (v.addr >>> 16) & 0xff, (v.addr >>> 24) & 0xff,
                        v.size & 0xff, typeCode(v.scalar)]){
      h ^= byte; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

export const typeCode = scalar => (scalar && SCALARS[scalar] ? SCALARS[scalar].code : 0xff);

// ---------------------------------------------------------------- 包
function wr16(b, o, v){ b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function wr32(b, o, v){ b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }
const rd16 = (b, o) => b[o] | (b[o + 1] << 8);
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function header(kind, seq, tUs, n, aux, version = VERSION){
  const b = new Uint8Array(PACKET);
  wr16(b, 0, MAGIC); b[2] = version; b[3] = kind;
  wr32(b, 4, seq >>> 0); wr32(b, 8, version === VERSION_TICKS ? ticksForUs(tUs) : tUs >>> 0); wr16(b, 12, n); wr16(b, 14, aux);
  return b;
}

/** DEF：变量表（主机用它和本地计划对账）。
 *  `payload[11]` = 探针自己算出来的 **span 数** —— 主机拿它和本地 `planReads()` 对账，
 *  不一致就说明两边的合并规则不一样（比"波形看起来不对"好查得多）。 */
export function buildDef({ seq = 0, swdHz = 0, periodUs = 0, flags = 0, vars = [], spans = 0, version = VERSION } = {}){
  const b = header(KIND.DEF, seq, 0, 0, vars.length, version);
  const dv = new DataView(b.buffer);
  dv.setUint32(HEADER, swdHz >>> 0, true);
  dv.setUint32(HEADER + 4, version === VERSION_TICKS ? ticksForUs(periodUs) : periodUs >>> 0, true);
  dv.setUint16(HEADER + 8, flags & 0xffff, true);
  b[HEADER + 10] = vars.length & 0xff;
  b[HEADER + 11] = spans & 0xff;
  let o = HEADER + 12;
  for (const v of vars){
    dv.setUint32(o, v.addr >>> 0, true);
    b[o + 4] = v.size & 0xff;
    b[o + 5] = typeCode(v.scalar);
    o += 8;
  }
  return b;
}

export function parseDef(payload, version = VERSION){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out = { swdHz: dv.getUint32(0, true), periodUs: dv.getUint32(4, true),
                flags: dv.getUint16(8, true), nvars: payload[10], spans: payload[11], vars: [] };
  // **生效**后端：DEF flags bit6 = 这次真的在走 RISC-V/JTAG（不是你下发的那个）
  if (version === VERSION_TICKS) out.periodUs = usForTicks(out.periodUs);
  out.riscv = !!(out.flags & SCOPE_FLAG.RISCV);
  let o = 12;
  for (let i = 0; i < out.nvars; i++){
    out.vars.push({ addr: dv.getUint32(o, true), size: payload[o + 4], type: payload[o + 5],
                    scalar: TYPES[payload[o + 5]]?.name || null });
    o += 8;
  }
  return out;
}

/** DATA：一批样本。载荷 = n × frameBytes，变量按变量表顺序紧排。 */
export function buildData({ seq = 0, tUs = 0, n = 0, payload = new Uint8Array(0), version = VERSION } = {}){
  const b = header(KIND.DATA, seq, tUs, n, payload.length, version);
  b.set(payload.subarray(0, PAYLOAD), HEADER);
  return b;
}

/** 把"每通道一个数"打包成一批（按变量表里的 size 与类型；f32/f64 要按 IEEE-754 位写，
 *  🚨 别用 `x >>> 0` —— 那会把浮点的位型整个丢掉，解出来是 0 或 NaN）*/
export function packSamples(vars, nums, into = new Uint8Array(PAYLOAD)){
  const dv = new DataView(into.buffer, into.byteOffset, into.byteLength);
  let o = 0;
  for (let i = 0; i < vars.length; i++){
    const v = vars[i], x = nums[i];
    switch (v.size){
      case 1: into[o] = x & 0xff; break;
      case 2: wr16(into, o, x & 0xffff); break;
      case 4: if (v.scalar === 'f32') dv.setFloat32(o, x, true); else wr32(into, o, x >>> 0); break;
      case 8: dv.setFloat64(o, x, true); break;
      default: break;
    }
    o += v.size;
  }
  return o;                       // 实际写了多少字节
}

export function buildStat({ seq = 0, tUs = 0, produced = 0, dropped = 0, pkts = 0,
                            usbErr = 0, swdErr = 0, periodUs = 0, swdMhz = 0, discarding = false, version = VERSION } = {}){
  const b = header(KIND.STAT, seq, tUs, 0, 0, version);
  const dv = new DataView(b.buffer);
  dv.setUint32(HEADER, produced >>> 0, true);
  dv.setUint32(HEADER + 4, dropped >>> 0, true);
  dv.setUint32(HEADER + 8, pkts >>> 0, true);
  dv.setUint16(HEADER + 12, usbErr & 0xffff, true);
  dv.setUint16(HEADER + 14, swdErr & 0xffff, true);
  dv.setUint32(HEADER + 16, version === VERSION_TICKS ? ticksForUs(periodUs) : periodUs >>> 0, true);
  b[HEADER + 20] = swdMhz & 0xff;
  b[HEADER + 21] = discarding ? 1 : 0;
  return b;
}

export function parseStat(payload, version = VERSION){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    produced: dv.getUint32(0, true), dropped: dv.getUint32(4, true), pkts: dv.getUint32(8, true),
    usbErr: dv.getUint16(12, true), swdErr: dv.getUint16(14, true),
    periodUs: version === VERSION_TICKS ? usForTicks(dv.getUint32(16, true)) : dv.getUint32(16, true), swdMhz: payload[20], discarding: !!payload[21],
  };
}

export const EVT = { STARTED: 1, STOPPED: 2, CLOCK_STEPDOWN: 3, OVERRUN: 4, TRIGGER: 5 };
export const EVT_NAME = { 1: '已启动', 2: '已停止', 3: '时钟自动降档', 4: '探针缓冲溢出（丢样本）', 5: '触发命中' };

export function buildEvt({ seq = 0, tUs = 0, code = 0, a = 0, b = 0 } = {}){
  const pkt = header(KIND.EVT, seq, tUs, 0, code);
  const dv = new DataView(pkt.buffer);
  dv.setUint32(HEADER, a >>> 0, true);
  dv.setUint32(HEADER + 4, b >>> 0, true);
  return pkt;
}

export function parseEvt(payload){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { a: dv.getUint32(0, true), b: dv.getUint32(4, true) };
}

/**
 * 解析一个 512 B 包（不合法返回 null —— 调用方负责重同步/计数）。
 * head 只做最小校验：magic + 版本 + kind 已知。
 */
export function parsePacket(buf){
  if (!(buf instanceof Uint8Array) || buf.length < PACKET) return null;
  if (rd16(buf, 0) !== MAGIC) return null;
  if (buf[2] !== VERSION && buf[2] !== VERSION_TICKS) return null;
  const kind = buf[3];
  if (!KIND_NAME[kind]) return null;
  if (kind === KIND.DATA && HEADER + rd16(buf, 14) > PACKET) return null;   // aux = 有效载荷字节数
  return {
    kind, kindName: KIND_NAME[kind],
    version: buf[2], tRaw: rd32(buf, 8),
    seq: rd32(buf, 4), tUs: buf[2] === VERSION_TICKS ? usForTicks(rd32(buf, 8)) : rd32(buf, 8), n: rd16(buf, 12), aux: rd16(buf, 14),
    payload: buf.subarray(HEADER),
  };
}

/**
 * 字节流 → 包。设备一直发整 512 B 包，但 transferIn 可能拿到半包，
 * 所以这里缓冲尾巴；magic 对不上就按字节滑窗重同步（并数出来）。
 */
export class PacketStream {
  constructor(){ this.buf = new Uint8Array(0); this.resyncs = 0; this.junk = 0; }
  reset(){ this.buf = new Uint8Array(0); }
  /** @returns {Array} 解析出的包（{kind,...,raw}）；坏包/半包不会出现在结果里 */
  push(chunk){
    if (chunk?.length){
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf); next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const out = [];
    for (;;){
      if (this.buf.length < PACKET) break;
      let pkt = parsePacket(this.buf);
      if (!pkt){
        // 重同步：往后找一个 magic（丢掉前面的垃圾字节）
        const at = findMagic(this.buf);
        if (at < 0){ this.junk += this.buf.length - 1; this.buf = this.buf.subarray(this.buf.length - 1); break; }
        this.junk += at; this.resyncs++;
        this.buf = this.buf.subarray(at);
        if (this.buf.length < PACKET) break;
        pkt = parsePacket(this.buf);
        if (!pkt) break;
      }
      out.push({ ...pkt, raw: this.buf.subarray(0, PACKET) });
      this.buf = this.buf.subarray(PACKET);
    }
    return out;
  }
}

function findMagic(b){
  for (let i = 1; i + 1 < b.length; i++){
    if (b[i] === (MAGIC & 0xff) && b[i + 1] === (MAGIC >>> 8)) return i;
  }
  return -1;
}

/** 序号连续性：丢包/重排都要能被数出来（界面要显示，绝不静默）*/
export class SeqTracker {
  constructor(){ this.last = null; this.gaps = 0; this.missing = 0; this.reordered = 0; this.dup = 0; }
  reset(){ this.last = null; this.gaps = 0; this.missing = 0; this.reordered = 0; this.dup = 0; }
  note(seq){
    const s = seq >>> 0;
    if (this.last === null){ this.last = s; return { ok: true }; }
    const d = ((s - this.last) >>> 0);
    if (d === 1){ this.last = s; return { ok: true }; }
    if (d === 0){ this.dup++; return { ok: false, why: 'dup' }; }
    if (d < 0x80000000){
      this.gaps++; this.missing += d - 1; this.last = s;
      return { ok: false, why: 'gap', missing: d - 1 };
    }
    this.reordered++; return { ok: false, why: 'reorder' };
  }
}

/** 32 位时间戳（µs）去回绕：把 32 位计时器展开成**单调递增**的绝对时间。
 *
 *  做法：算 32 位**有符号**差值 —— 正数=正常前进、负数=计时器绕回来了（加 2^32）。
 *  这样结果天然单调：绕回那一刻差值是 +32 这种小正数，不会被误当成"往回跳 40 亿"。
 *  （反面写法是"看 delta 大不大"，那在 last 接近 0xffffffff 时会算反，本文件踩过。）*/
export class TimeUnwrap {
  constructor(){ this.base = 0; this.last = null; }
  reset(){ this.base = 0; this.last = null; }
  unwrap(tUs){
    const t = tUs >>> 0;
    if (this.last === null){ this.last = t; this.base = t; return this.base; }
    const delta = ((t - this.last) | 0);          // 有符号差值
    this.base += delta >= 0 ? delta : delta + 0x100000000;
    this.last = t;
    return this.base;
  }
}

/** 先在原始 u32 单位去回绕，再换算，v2 不能先除 24 再交给 TimeUnwrap。 */
export function packetTimeUs(pkt, unwrap){
  const raw = unwrap.unwrap(pkt.tRaw ?? pkt.tUs);
  return pkt.version === VERSION_TICKS ? usForTicks(raw) : raw;
}

// ---------------------------------------------------------------- HID 0x32（控制面）
export const HID_CMD = 0x32;
export const ACT = { STOP: 0, START: 1, STATUS: 2, CLOCK: 3, TRIGGER: 4, CONFIG: 7, BENCH: 8, BENCH_RESULT: 9, CONFIG_TICKS: 10, METRICS: 11 };
export const ACT_NAME = { 0: '停止', 1: '启动', 2: '查状态', 3: '设 SWD 时钟', 4: '触发配置', 7: '配置', 8: '标定', 9: '取标定结果', 10: '配置 tick 周期' };

/**
 * action 7 的 flags 位（固件 `api_param.c` / `Custom HID Protocol.md` 第 16 条）。
 * `RISCV` 是这一版新加的：**强制**本次会话走 RISC-V/JTAG；不带就跟随全局目标类型。
 * ⚠️ 但"你设的"和"生效的"可能不同（后端拉不起来会自动换另一条路重试一次，目标类型还是**粘的**），
 *    所以界面显示一律用**生效值**：DEF 的 `flags bit6` 或状态字 0 的 `bit1`。
 */
export const SCOPE_FLAG = { ALLOW_60M: 0x01, DISCARD: 0x02, TRIGGER: 0x04, NO_YIELD: 0x08,
                            DELAY0: 0x10, CDC_OFF: 0x20, RISCV: 0x40, FAST_BATCH: 0x80 };

/** 后端（生效值）。JTAG 下 action 3 / flags bit4 / swdHz / blob+clock_delay 都无意义。 */
export const BACKEND = { SWD: 'swd', RISCV: 'riscv' };
export const backendName = b => (b === BACKEND.RISCV ? 'RISC-V/JTAG' : b === BACKEND.SWD ? 'SWD/ARM' : '未知');

/**
 * 每样本耗时的**实测**基线（µs）——历史锚点来自 akaLinkPro 的真机记录
 * （`README.md` §scope / §RISC-V、`docs/代码审查报告.md` 第二轮回归表，2026-09-30）：
 *   · SWD @60 MHz：单字 1.548~1.588（取 1.55）、pack 8 通道 32 B 11.193~11.234（取 11.19）；
 *   · RISC-V/JTAG：单字 3.17（P1-1 修完的复测值，修之前是 4.25）、8 通道 32 B 36.6。
 * 推荐规则见 recommendedPeriodUs；经验余量仅作起点，不保证无跳拍。
 * ⚠️ 换数字时**两边一起改**：`docs/scope-page.md` 与页面文案都引用这里。
 */
export const BACKEND_COST = {
  swd:   { single: 1.55, pack8: 11.19, clock: '60 MHz' },
  riscv: { single: RISCV_COST.singleWordUs, pack8: RISCV_COST.pack8Us, clock: 'JTAG（时钟由 DMI 旋钮定）' },
};

/** 全局目标类型切换（HID **0x31** action 10，不是 0x32！）——与 RTT-over-JTAG 共用同一个开关。
 *  Byte[0x04]：0 = SWD/ARM，1 = RISC-V/JTAG。粘性：设了就一直有效，直到下次改。 */
export const HID_CMD_RTT = 0x31;
export const RTT_ACT_TARGET = 10;
export function targetTypeData(riscv){
  return Uint8Array.of(RTT_ACT_TARGET, riscv ? 1 : 0);
}

/** 单条 HID 报文的 data 上限：63 - 2（长度 + 命令） = 61 */
export const HID_DATA_MAX = 61;
export const MAX_VARS = 8;

/**
 * action 7 的 data 段：`[0]=7 [1..4]=period_us [5]=flags [6]=nvars [7..]=n×(addr4,size1,type1)`
 * 8 个变量 = 7 + 48 = 55 B ✔ 一条报文装得下（这就是为什么上限定在 8）。
 */
export function configData({ periodUs = 100, flags = 0, vars = [] } = {}){
  if (vars.length > MAX_VARS) throw new Error(`变量数 ${vars.length} > ${MAX_VARS}`);
  const n = vars.length;
  const d = new Uint8Array(7 + n * 6);
  const dv = new DataView(d.buffer);
  if (!Number.isFinite(periodUs) || periodUs < 2 || periodUs > 1e6)
    throw new Error('采样周期应在 2..1000000 µs 之间');
  const ticks = !Number.isInteger(periodUs);
  d[0] = ticks ? ACT.CONFIG_TICKS : ACT.CONFIG;
  dv.setUint32(1, ticks ? ticksForUs(periodUs) : periodUs, true);
  d[5] = flags & 0xff;
  d[6] = n & 0xff;
  let o = 7;
  for (const v of vars){
    dv.setUint32(o, v.addr >>> 0, true);
    d[o + 4] = v.size & 0xff;
    d[o + 5] = typeCode(v.scalar);
    o += 6;
  }
  if (d.length > HID_DATA_MAX) throw new Error(`配置报文 ${d.length} B 超过 ${HID_DATA_MAX}`);
  return d;
}

export function flagsData(action){ return Uint8Array.of(action & 0xff); }

/** action 3：设 SWD 时钟（Hz）。放在 CONFIG 之前发；0 = 不动（用固件当前档）。 */
export function clockData(hz){
  const d = new Uint8Array(5);
  d[0] = ACT.CLOCK;
  new DataView(d.buffer).setUint32(1, hz >>> 0, true);
  return d;
}

export function triggerData({ channel = 0, mode = 0, level = 0, pre = 0, post = 0 } = {}){
  const d = new Uint8Array(15);                 // action(1)+ch(1)+mode(1)+level(4)+pre(4)+post(4)
  const dv = new DataView(d.buffer);
  d[0] = ACT.TRIGGER; d[1] = channel & 0xff; d[2] = mode & 0xff;
  dv.setFloat32(3, level, true);
  dv.setUint32(7, pre >>> 0, true);
  dv.setUint32(11, post >>> 0, true);
  return d;
}

export function benchData({ iters = 1000 } = {}){
  const d = new Uint8Array(5);
  new DataView(d.buffer).setUint32(1, iters >>> 0, true);
  d[0] = ACT.BENCH;
  return d;
}

const s8 = v => (v & 0xff) > 127 ? (v & 0xff) - 256 : (v & 0xff);

/** 12 个状态字（48 B）→ 好用的对象（位域见文档 §7.1）*/
export function parseScopeStatus(bytes){
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = i => dv.getUint32(i * 4, true);
  const [w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11] =
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(w);
  return {
    running: !!(w0 & 1),
    supportsTicks: !!(w0 & 4),
    supportsBatch: !!(w0 & 8),
    supportsMetrics: !!(w0 & 16),
    riscv: !!(w0 & 2),               // **生效**后端：bit1 = 这次会话真的在走 RISC-V/JTAG
    nspans: (w0 >>> 8) & 0xff,       // 探针自己算出来的 span 数（与本地计划对账用）
    swdReady: !!(w0 & (1 << 16)),
    nvars: (w0 >>> 24) & 0xff,       // 探针收到的变量数（配置到底生效没有）
    swdHz: w1,
    produced: w2,
    dropped: w3,
    bytes: w4 & 0xffff,
    usbErr: w4 >>> 16,
    swdErr: w5 & 0xffff,
    dapYield: w5 >>> 16,
    lastSeq: w6,
    skipped: w7 & 0xffff,
    discardPackets: w7 >>> 16,
    planHash: w8,
    lastCmd: w9 & 0xff,
    lastResp: (w9 >>> 8) & 0xff,
    startRc: s8(w10),
    periodUs: w11 & (1 << 17) ? usForTicks(w11 & 0xffff) : w11 & 0xffff,
    discarding: !!(w11 & (1 << 16)),
    swdMhz: (w11 >>> 24) & 0xff,
  };
}

/** Full-width atomic probe snapshot, action 11. */
export function parseScopeMetrics(bytes){
  if (bytes.byteLength < 48) throw new Error('采样计数响应不完整');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = i => dv.getUint32(i * 4, true);
  if (w(0) !== 0x31535348 || w(2) !== TIME_HZ) throw new Error('采样计数响应无效');
  return { tick: w(1), hz: w(2), produced: w(3), skipped: w(4), usb: w(5),
    errors: w(6), yields: w(7), tx: w(8), bytes: w(9), periodTicks: w(10), flags: w(11) };
}

/**
 * 启动返回码 → 人话（-100 = 固件里"排队中"的哨兵，不是错误）。
 * `riscv` 同 app/hid/probe.js 的 startRcText：同一个 -2 在两条后端上不是同一件事，
 * 别把 JTAG/DMI 的故障写成"SWD 初始化失败"（2026-10 真机就是这么被带偏的）。
 */
export const START_PENDING = -100;
export function scopeRcText(rc, riscv = false){
  switch (rc){
    case 0: return '正常';
    case -100: return '启动中（探针还在排队，结果没出来）';
    case -1: return riscv ? 'JTAG 时序参数设置失败（DMI delay / idle 字段非法）' : 'SWD 时钟设置失败（换低一档试试）';
    case -2: return riscv
      ? 'JTAG/DMI 初始化失败（TAP 无应答）：查目标有没有被停住 / 另一路会话占着 TAP / 探针输出模式要 SWD+JTAG'
      : 'SWD 初始化失败（查接线 / 目标供电 / 复位）';
    /**
     * 🚨 -3 有两个来源，别只写"你没选变量"（2026-10 代码审查）：
     *    ① 真的一个变量都没选；② **上一次 CONFIG 被拒**（-6）—— 固件会顺手清空变量表，
     *    于是紧接着的 START 回 -3。用户明明选了变量时看到"变量表为空"就完全懵了。
     *    现在页面在 CONFIG 之后就当场读 rc、把 -6 的原因先报出来（见 scope/view.js）。
     */
    case -3: return '变量表为空：要么左边没选变量，要么**上一次配置被拒**（见 -6：变量宽度非法 / 地址取不到）';
    case -4: return riscv ? '该档位链路不可用（DMI 无应答）' : '该档位链路不可用';
    /* 固件里 -5 是**标定**路上的"没有空闲包缓冲"（等主机把 0x83 读走），不是"周期非法"
     * ——周期非法是在 CONFIG 阶段被拒（-6）。这里以前写反了（2026-10 代码审查）。 */
    case -5: return '探针没有空闲的包缓冲（主机没把 0x83 的数据读走）—— 标定/采集卡住时先确认读循环在跑';
    case -6: return '配置被拒：变量宽度非法（只支持 1/2/4 字节，一条 CONFIG 最多 8 个变量）。**被拒后固件会清空变量表**，紧接着的 START 会回 -3';
    default: return `未知返回码 ${rc}`;
  }
}

/**
 * 按变量表把一批样本解码成**扁平数字数组**：`out[i*nvars + k]`（i = 帧号，k = 通道号）。
 * 🚨 早期版本写成 `out[k] = x`，等于每帧都覆盖同一批槽位 —— 结果是"只留了最后一帧"，
 *    上层按 `slice(i*n, (i+1)*n)` 取第 i 帧就会拿到空数组 → 写进缓冲变成 NaN（自测抓到的）。
 */
export function decodeSamples(vars, payload, n, out = []){
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const nv = vars.length;
  const frameBytes = vars.reduce((s, v) => s + v.size, 0);
  if (frameBytes <= 0 || nv === 0) return out;
  const fit = Math.min(n, Math.floor(payload.length / frameBytes));   // 短包不许越界读
  for (let i = 0; i < fit; i++){
    const base = i * nv;
    let o = i * frameBytes;
    for (let k = 0; k < nv; k++){
      const v = vars[k];
      let x;
      switch (v.size){
        case 1: x = v.scalar === 'i8' ? dv.getInt8(o) : dv.getUint8(o); break;
        case 2: x = v.scalar === 'i16' ? dv.getInt16(o, true) : dv.getUint16(o, true); break;
        case 4: x = (v.scalar === 'f32') ? dv.getFloat32(o, true)
                 : (v.scalar === 'i32' ? dv.getInt32(o, true) : dv.getUint32(o, true)); break;
        case 8: x = dv.getFloat64(o, true); break;
        default: x = 0;
      }
      out[base + k] = x;
      o += v.size;
    }
  }
  return out;
}

/** 每个包的样本数（受 496 B 载荷限制）*/
export const samplesPerPacket = frameBytes => (frameBytes > 0 ? Math.floor(PAYLOAD / frameBytes) : 0);
