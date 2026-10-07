/**
 * 纯 Node 自测（不需要浏览器、不需要硬件）：
 *   node tools/selftest/scope-proto.test.mjs
 * 覆盖 J-Scope 波形页的**引擎层**：
 *   采样计划（读计划）/ 512 B 包编解码 / 字节流重同步 / 丢包统计 / HID 0x32 /
 *   类型化缓冲 + LOD 金字塔 / 触发（含离线重触发）/ 假探针端到端（逐点对账）。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..', 'app');
const url = p => 'file://' + join(app, p).replace(/\\/g, '/');

const P = await import(url('scope/protocol.js'));
const S = await import(url('scope/store.js'));
const M = await import(url('scope/mock.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------------ 1
console.log('== 1. 采样计划（读计划 = 速率的最大杠杆）==');
{
  // 靶子固件的真实布局：g_pack 连续 24 B + 几个散落量（0x20000000 那侧）
  const pack = [
    { name: 'g_pack.f_sin', addr: 0x20001014, size: 4, scalar: 'f32' },
    { name: 'g_pack.f_tri', addr: 0x20001018, size: 4, scalar: 'f32' },
    { name: 'g_pack.i_tick', addr: 0x2000101c, size: 4, scalar: 'i32' },
    { name: 'g_pack.u_ramp', addr: 0x20001020, size: 2, scalar: 'u16' },
    { name: 'g_pack.i_sq1k', addr: 0x20001022, size: 2, scalar: 'i16' },
    { name: 'g_pack.u_cnt', addr: 0x20001024, size: 1, scalar: 'u8' },
    { name: 'g_pack.i_saw', addr: 0x20001025, size: 1, scalar: 'i8' },
    { name: 'g_pack.u_hi', addr: 0x20001028, size: 4, scalar: 'u32' },
  ];
  const p1 = P.planReads(pack);
  ok(p1.spans.length === 1, '同一结构体的 8 个成员合并成 1 个 span', `实际 ${p1.spans.length}`);
  ok(p1.frameBytes === 22, '帧字节数 = 22（4+4+4+2+2+1+1+4）', `实际 ${p1.frameBytes}`);
  ok(p1.spans[0].len === 24, 'span 覆盖 0x20001014..0x2000102c（24 B，含 2 B 空洞）', `实际 ${p1.spans[0].len}`);

  const mixed = [...pack.slice(0, 6),
    { name: 'g_lfsr', addr: 0x20000000, size: 4, scalar: 'u32' },
    { name: 'g_far_sq100', addr: 0x2000000c, size: 2, scalar: 'i16' }];
  const p2 = P.planReads(mixed);
  ok(p2.spans.length === 2, '跨 4 KB 的两组 → 2 个 span', `实际 ${p2.spans.length}`);
  ok(p2.estUs > p1.estUs, '多一个 span 就更慢（模型上）');
  ok(p2.saved > 0.3 && p2.saved < 1, `合并省掉 ${(p2.saved * 100).toFixed(0)}% 的时间（相对逐变量读）`);
  ok(p2.naiveUs > p2.estUs, '朴素写法（每个变量一次块读）一定更慢');
  ok(P.planReads([]).estHz === 0, '空计划不炸');

  // 合并阈值：与固件 `SCOPE_MERGE_GAP = 12` 同源（网页算错 → DEF 里回报的 span 数就对不上）
  const mk = gap => P.planReads([{ name: 'a', addr: 0x20000000, size: 4, scalar: 'u32' },
                                 { name: 'b', addr: 0x20000000 + 4 + gap, size: 4, scalar: 'u32' }]).spans.length;
  ok(mk(8) === 1 && mk(30) === 2, '间隙 8 B 合并 / 30 B 不合并');
  ok(mk(12) === 1 && mk(13) === 2 && Math.floor(P.COST.perBlockUs / P.COST.perByteUs) === 12,
     `合并阈值 = 12 B（固件 SCOPE_MERGE_GAP 同值；gap 12 并、13 不并）`);
  // 单个 span 不许超过固件的读缓冲（SCOPE_SPAN_MAX = 64 B），否则"网页 1 个 span / 探针 2 个"
  const longSpan = P.planReads([{ name: 'a', addr: 0x20000000, size: 8, scalar: 'f64' },
                                { name: 'b', addr: 0x20000040, size: 8, scalar: 'f64' },
                                { name: 'c', addr: 0x20000080, size: 8, scalar: 'f64' }]);
  ok(longSpan.spans.length === 3 && longSpan.spans.every(s => s.len <= P.SPAN_MAX_BYTES),
     `超长跨度被 64 B 上限切开（${longSpan.spans.length} 个 span，各 ${longSpan.spans.map(s => s.len).join('/')} B）`);
  ok(P.planHash(pack) === P.planHash([...pack].reverse()), '计划指纹与变量顺序无关');
  ok(P.planHash(pack) !== P.planHash(mixed), '不同计划指纹不同');

  // ---- RISC-V/JTAG 目标（web-handoff-riscv-scope.md）----
  ok(P.SCOPE_FLAG.RISCV === 0x40, 'action 7 flags bit6 = 强制 RISC-V/JTAG');
  ok(P.SCOPE_FLAG.DISCARD === 0x02 && P.SCOPE_FLAG.CDC_OFF === 0x20, 'DISCARD/CDC_OFF 位与固件一致');
  const rvDef = P.parseDef(P.buildDef({ seq: 1, periodUs: 100, flags: P.SCOPE_FLAG.RISCV, vars: pack.slice(0, 2), spans: 1 }).subarray(16));
  ok(rvDef.riscv === true, 'DEF flags bit6 → **生效**后端 = RISC-V（不是你下发的那个）');
  const swdDef = P.parseDef(P.buildDef({ seq: 1, swdHz: 6e7, periodUs: 100, flags: 0, vars: pack.slice(0, 2), spans: 1 }).subarray(16));
  ok(swdDef.riscv === false, 'DEF flags bit6 = 0 → SWD/ARM');
  ok(Array.from(P.targetTypeData(true)).join(',') === '10,1' &&
     Array.from(P.targetTypeData(false)).join(',') === '10,0' &&
     P.HID_CMD_RTT === 0x31,
     '目标类型切换走 HID **0x31** action 10（不是 0x32），Byte[3]=10 / Byte[4]=0|1');
  // RISC-V 的实测分档必须比 SWD 慢得多（拿 SWD 的数去建议周期会大面积丢拍）
  ok(P.BACKEND_COST.riscv.single > P.BACKEND_COST.swd.single * 1.5 &&
     P.BACKEND_COST.riscv.pack8 > P.BACKEND_COST.swd.pack8 * 2,
     `后端分档：SWD ${P.BACKEND_COST.swd.single}/${P.BACKEND_COST.swd.pack8} µs vs ` +
     `RISC-V ${P.BACKEND_COST.riscv.single}/${P.BACKEND_COST.riscv.pack8} µs`);
  ok(P.backendName('riscv') === 'RISC-V/JTAG' && P.backendName('swd') === 'SWD/ARM', '后端显示名');

  // 单字流水读快路径：模型（每 span 3 次传输 + 每字 1 次 DRW = 4.47 µs）与实测（1.55 µs）差 3 倍 ——
  // 计划行必须用后者，否则一个能跑的周期会被说成跑不动（用户被"建议周期 ≥ 11 µs"挡在 3 µs 门外，
  // 而他实测零丢）。模型自己也要跟 akaLinkPro 的真机锚点对齐（见下一条）。
  const one4 = P.planReads([{ name: 'f_sin', addr: 0x20001014, size: 4, scalar: 'f32' }]);
  ok(one4.fastPath === true && one4.estUs > 4 && one4.estUs < 5 && one4.bestUs < 2,
     `单字 f32 走快路径：模型 ${one4.estUs.toFixed(2)} µs / 取用 ${one4.bestUs.toFixed(2)} µs（≈${Math.round(one4.bestHz / 1000)} kHz）`);
  // 模型 vs akaLinkPro 真机（F103 @60 MHz）：单字 4.503、2 字 5.82、4 字 7.96、6 字 10.30、8 字 12.65 µs
  const near5 = (got, want, tol = 0.05) => Math.abs(got - want) / want <= tol;
  const spanUs = words => P.planReads(Array.from({ length: words }, (_, i) =>
    ({ name: `w${i}`, addr: 0x20000000 + i * 4, size: 4, scalar: 'u32' }))).estUs;
  ok(near5(spanUs(1), 4.503) && near5(spanUs(2), 5.82) && near5(spanUs(4), 7.96) &&
     near5(spanUs(6), 10.30) && near5(spanUs(8), 12.65),
     `模型贴住真机锚点：1/2/4/6/8 字 = ${[1, 2, 4, 6, 8].map(w => spanUs(w).toFixed(2)).join(' / ')} µs` +
     '（实测 4.50 / 5.82 / 7.96 / 10.30 / 12.65）');
  const one4b = P.planReads([{ name: 'f_sin', addr: 0x20001014, size: 4, scalar: 'f32' }], { fastWordUs: 1.758 });
  ok(one4b.bestUs === 1.758, '快路径成本可覆盖（不同 SWD 时钟档）');
  ok(P.planReads([{ name: 'u_ramp', addr: 0x20001020, size: 2, scalar: 'u16' }]).fastPath === false,
     '单个 u16（半字）不走快路径 —— 固件要求整段正好 4 字节直读');
  ok(P.planReads([{ name: 'a', addr: 0x20000002, size: 4, scalar: 'u32' }]).fastPath === false,
     '地址没 4 字节对齐也不走快路径');
  ok(P.planReads([{ name: 'a', addr: 0x20000000, size: 4, scalar: 'u32' },
                  { name: 'b', addr: 0x20000004, size: 4, scalar: 'u32' }]).fastPath === false,
     '两个单字（合并成 8 B span）不走快路径 —— 固件守卫是"只有一个 4 字节 span"');
  ok(P.planReads([{ name: 'a', addr: 0x20000000, size: 2, scalar: 'u16' },
                  { name: 'b', addr: 0x20000002, size: 2, scalar: 'i16' }]).fastPath === true,
     '两个连续 u16（合成一个 4 B 字）仍可以走快路径');
}

// ------------------------------------------------------------------ 2
console.log('== 2. 512 B 包编解码（四种包）==');
{
  const vars = [{ addr: 0x20001014, size: 4, scalar: 'f32' }, { addr: 0x2000101c, size: 4, scalar: 'i32' },
                { addr: 0x20001024, size: 1, scalar: 'u8' }, { addr: 0x20001038, size: 8, scalar: 'f64' }];
  const def = P.buildDef({ seq: 7, swdHz: 45000000, periodUs: 100, flags: 1, vars, spans: 3 });
  ok(def.length === 512, 'DEF 包 = 512 B');
  const pk = P.parsePacket(def);
  ok(pk && pk.kind === P.KIND.DEF && pk.seq === 7, 'HEAD 解析：kind/seq');
  const d = P.parseDef(pk.payload);
  ok(d.swdHz === 45000000 && d.periodUs === 100 && d.flags === 1 && d.nvars === 4, 'DEF 字段逐个正确');
  ok(d.spans === 3, 'DEF 里回报的 span 数（主机拿它和本地计划对账）');
  ok(d.vars[3].addr === 0x20001038 && d.vars[3].size === 8 && d.vars[3].scalar === 'f64', 'DEF 变量表（含类型码 → 名字）');

  // 8 种类型各来一发：打包 → 解码 必须**逐位相等**
  const all = Object.entries(P.SCALARS_BY_NAME || {}).length ? null : null; void all;
  const cases = [
    ['u8', 200], ['i8', -100], ['u16', 60000], ['i16', -30000],
    ['u32', 0xf0000001], ['i32', -123456], ['f32', 1.5], ['f64', -2.25],
  ];
  const vv = cases.map(([scalar]) => ({ addr: 0, size: P.TYPES.find(t => t.name === scalar).size, scalar }));
  const nums = cases.map(([, v]) => v);
  const payload = new Uint8Array(vv.reduce((s, v) => s + v.size, 0));
  const wrote = P.packSamples(vv, nums, payload);
  ok(wrote === payload.length, `打包写出 ${payload.length} B`);
  const back = P.decodeSamples(vv, payload, 1, []);
  ok(cases.every(([scalar, v], i) => near(back[i], v, 1e-6)), '8 种类型打包→解码逐位相等',
     JSON.stringify(back));

  // 短包不许越界（真机上 transferIn 可能给半包）
  const short = payload.subarray(0, 5);                     // 连一帧都不够（帧 26 B）
  const r2 = P.decodeSamples(vv, short, 1, []);
  ok(r2.length === 0, '半包（不足一帧）解不出东西，也不抛异常');
  const oneFrame = payload.subarray(0, payload.length + 4); // 一帧 + 4 字节余量
  const r3 = P.decodeSamples(vv, oneFrame, 1, []);
  ok(r3.length === vv.length, `一帧的载荷解出 ${vv.length} 个值（余量被忽略）`);
  const multi = new Uint8Array(payload.length * 2);
  multi.set(payload, 0); multi.set(payload, payload.length);
  const r4 = P.decodeSamples(vv, multi, 2, []);
  ok(r4.length === vv.length * 2, '两帧解出 16 个值（扁平数组：out[i*nv+k]）');
  ok(near(r4[vv.length], r4[0]) && near(r4[vv.length + 7], r4[7]), '第 2 帧的值与第 1 帧相同（同一份载荷）');

  const data = P.buildData({ seq: 9, tUs: 123456, n: 3, payload });
  const dp = P.parsePacket(data);
  ok(dp.kind === P.KIND.DATA && dp.tUs === 123456 && dp.n === 3 && dp.aux === payload.length,
     'DATA 包的 t_us / n / aux（载荷字节数）');

  const st = P.parseStat(P.parsePacket(P.buildStat({ produced: 1000, dropped: 3, pkts: 66, usbErr: 1,
                                                     swdErr: 2, periodUs: 100, swdMhz: 45, discarding: true })).payload);
  ok(st.produced === 1000 && st.dropped === 3 && st.pcw === undefined && st.swdMhz === 45 && st.discarding === true,
     'STAT 包字段（含 dropped / SWD 档位 / 丢弃模式）');
  ok(P.parseEvt(P.parsePacket(P.buildEvt({ code: P.EVT.OVERRUN, a: 5, b: 6 })).payload).a === 5, 'EVT 包字段');

  // 坏包：magic 错 / 版本错 / kind 未知 → null（不抛）
  const bad = new Uint8Array(512); bad.set(def.subarray(0, 512)); bad[0] = 0;
  ok(P.parsePacket(bad) === null, 'magic 错 → null');
  const bad2 = Uint8Array.from(def); bad2[2] = 9;
  ok(P.parsePacket(bad2) === null, '版本不匹配 → null');
  const bad3 = Uint8Array.from(def); bad3[3] = 9;
  ok(P.parsePacket(bad3) === null, '未知 kind → null');
  ok(P.samplesPerPacket(22) === 22 && P.samplesPerPacket(32) === 15 && P.samplesPerPacket(0) === 0,
     '每包样本数 = floor(496/frameBytes)（32 B 时 15 个）');
}

// ------------------------------------------------------------------ 3
console.log('== 3. 字节流 → 包（分片、垃圾、重同步）==');
{
  const vars = [{ addr: 0x1000, size: 4, scalar: 'u32' }];
  const packets = [];
  for (let i = 0; i < 5; i++) packets.push(P.buildData({ seq: i, tUs: i * 100, n: 1, payload: Uint8Array.of(i, 0, 0, 0) }));
  const stream = new Uint8Array(packets.length * 512);
  packets.forEach((p, i) => stream.set(p, i * 512));

  // 一次全给
  const st1 = new P.PacketStream();
  ok(st1.push(stream).length === 5, '整块喂 → 5 个包');
  // 切成 100 B 的碎片喂（模拟 transferIn 短包）
  const st2 = new P.PacketStream();
  let got = 0;
  for (let o = 0; o < stream.length; o += 100) got += st2.push(stream.subarray(o, o + 100)).length;
  ok(got === 5, '切成 100 B 碎片喂 → 还是 5 个包', `实际 ${got}`);
  ok(st2.buf.length === 0, '碎片喂完缓冲区正好清空');
  // 前面塞垃圾 + 中间插垃圾
  const noisy = new Uint8Array(7 + stream.length + 3);
  noisy.set(stream, 7);
  const st3 = new P.PacketStream();
  const r3 = st3.push(noisy);
  ok(r3.length === 5 && st3.resyncs === 1, '开头 7 B 垃圾 → 重同步 1 次并找回 5 个包',
     `包 ${r3.length} / 重同步 ${st3.resyncs}`);
  ok(r3[0].seq === 0, '重同步后第一个包还是 seq 0');
  // 半个包留着，下一轮补齐
  const st4 = new P.PacketStream();
  ok(st4.push(stream.subarray(0, 300)).length === 0, '半包不产出');
  ok(st4.push(stream.subarray(300, 512)).length === 1, '补齐后立刻产出 1 个包');
  void vars;
}

// ------------------------------------------------------------------ 4
console.log('== 4. 丢包 / 时间戳回绕 ==');
{
  const t = new P.SeqTracker();
  ok(t.note(1).ok && t.note(2).ok && t.note(3).ok, '连续序号不报警');
  ok(t.note(6).why === 'gap' && t.missing === 2, '跳号 → gap 且缺 2 个');
  ok(t.note(6).why === 'dup', '重复序号 → dup');
  ok(t.note(5).why === 'reorder', '回退序号 → reorder（不算丢）');
  ok(t.gaps === 1 && t.dup === 1 && t.reordered === 1, '三类计数各自独立');

  const u = new P.TimeUnwrap();
  ok(u.unwrap(100) === 100 && u.unwrap(200) === 200, '正常前进');
  // 回绕：计时器从 0xfffffff0 绕到 0x10（真实数据里就是每 71 分钟发生一次）
  const u2 = new P.TimeUnwrap();
  const before = u2.unwrap(0xfffffff0);
  const after = u2.unwrap(0x00000010);
  ok(after > before && after - before === 0x20, '32 位回绕后被展开成单调递增',
     `${before} → ${after}`);
  ok(u2.unwrap(0x00000020) - before === 0x30, '绕回后继续单调前进');
}

// ------------------------------------------------------------------ 5
console.log('== 5. HID 0x32 控制面 ==');
{
  const vars = Array.from({ length: 8 }, (_, i) => ({
    addr: 0x20001014 + i * 4, size: 4,
    scalar: ['f32', 'f32', 'i32', 'u16', 'i16', 'u8', 'i8', 'u32'][i],
  }));
  const d = P.configData({ periodUs: 50, flags: 2, vars });
  ok(d.length === 7 + 8 * 6 && d.length <= P.HID_DATA_MAX, `一条报文装下 8 个变量（${d.length} ≤ 61 B）`);
  ok(d[0] === P.ACT.CONFIG && new DataView(d.buffer).getUint32(1, true) === 50, 'action=7 / period_us 在 [1..4]');
  ok(d[6] === 8, 'nvars 在 [6]');
  ok(d[7 + 6] === 0x18 && d[7 + 6 + 4] === 4 && d[7 + 6 + 5] === P.typeCode('f32'),
     '第 2 个变量的 addr/size/type 编码正确');
  let threw = '';
  try { P.configData({ vars: [...vars, vars[0]] }); } catch (e){ threw = e.message; }
  ok(/最多|超过|> 8/.test(threw), '9 个变量 → 明确报错（前端就该拦住）', threw);

  const st = P.parseScopeStatus(new Uint8Array(48).fill(0).map((_, i) => i));
  ok(typeof st.running === 'boolean' && typeof st.dropped === 'number', '状态字解析出对象');
  const cd = P.clockData(45000000);
  ok(cd.length === 5 && cd[0] === P.ACT.CLOCK && new DataView(cd.buffer).getUint32(1, true) === 45000000,
     'action 3 设 SWD 时钟报文（Hz 小端）');
  const st2 = P.parseScopeStatus((() => {
    const w = new Uint32Array(12);
    w[0] = 1 | (2 << 8) | (1 << 16) | (7 << 24);      // running / nspans / swdReady / nvars
    const b = new Uint8Array(48); new DataView(b.buffer).setUint32(0, w[0], true);
    return b;
  })());
  ok(st2.nspans === 2 && st2.nvars === 7, 'w0 的位域：nspans 与 nvars（与固件 scope_sampler_status 一致）');
  ok(st2.riscv === false, 'w0 bit1 = 0 → SWD/ARM 后端');
  const st3 = P.parseScopeStatus((() => {
    const b = new Uint8Array(48);
    new DataView(b.buffer).setUint32(0, 1 | 2, true);  // running + bit1 = RISC-V
    return b;
  })());
  ok(st3.riscv === true && st3.running === true,
     'w0 bit1 = 1 → 生效后端是 RISC-V/JTAG（web-handoff-riscv-scope.md 第 1 条）');
  ok(P.scopeRcText(-100).includes('启动中'), '-100 = "启动中"而不是错误');
  ok(P.scopeRcText(-3).includes('变量表'), '-3 的文案指向"变量表为空"');
  ok(P.scopeRcText(0) === '正常', 'rc=0 正常');
  // 同一个 -2，SWD 与 RISC-V/JTAG 不是同一件事（2026-10 真机被"SWD 初始化失败"带偏过）
  ok(P.scopeRcText(-2, false).includes('SWD 初始化失败') && P.scopeRcText(-2, true).includes('JTAG/DMI'),
     '-2 的文案按后端分家');
  ok(P.START_PENDING === -100, '哨兵值 = -100（与固件一致）');
  ok(P.triggerData({ channel: 2, mode: S.TRIG.RISING, level: 1.5, pre: 100, post: 200 }).length === 15,
     '触发配置报文 15 B（action+ch+mode+level+pre+post）');
}

// ------------------------------------------------------------------ 6
console.log('== 6. 类型化缓冲 + LOD 金字塔 ==');
{
  const vars = [{ name: 'f', addr: 0, size: 4, scalar: 'f32' }, { name: 'i', addr: 4, size: 4, scalar: 'i32' }];
  const st = new S.SampleStore(vars, 4096);
  ok(st.channel(0).data instanceof Float32Array, 'f32 → Float32Array');
  ok(st.channel(1).data instanceof Int32Array, 'i32 → Int32Array（不是 Float32：>2^24 的整数才不会被四舍五入）');
  const big = 0x1000000 + 12345;                       // > 2^24，Float32 存不下
  st.pushFrame([1.5, big], 0);
  ok(st.channel(1).at(0) === big, '大整数 0x1000000+12345 精确保存', `实际 ${st.channel(1).at(0)}`);
  ok(st.channel(0).at(0) === 1.5, '浮点精确保存');

  // 尖峰信号：确保 LOD 不漏峰
  const N = 4096;
  const st2 = new S.SampleStore([{ name: 'x', addr: 0, size: 4, scalar: 'f32' }], N);
  for (let i = 0; i < N; i++) st2.pushFrame([Math.sin(i / 50) + (i === 1234 ? 100 : 0)], i * 100);
  const cols = 64;
  const mn = new Float64Array(cols), mx = new Float64Array(cols);
  const usedLod = st2.channel(0).columns(0, N, cols, mn, mx);
  ok(usedLod === true, `每列 ${N / cols} 个样本 → 走 LOD（快路径）`);
  let lo = Infinity, hi = -Infinity;
  for (let c = 0; c < cols; c++){ lo = Math.min(lo, mn[c]); hi = Math.max(hi, mx[c]); }
  ok(hi > 99 && hi < 100.5, `包络抓到了 +100 的尖峰（max=${hi.toFixed(2)}；sin 相位使实际值 ≈99.6）`);
  ok(lo <= -0.9, `包络抓到了谷底（min=${lo.toFixed(2)}）`);
  // 与逐样本精确值对比：LOD 的包络必须是"超集"（只会稍胖，绝不漏）
  let superset = true, exactHit = 0;
  for (let c = 0; c < cols; c++){
    const a = Math.floor(c * N / cols), b = Math.floor((c + 1) * N / cols);
    const [emn, emx] = st2.channel(0).exact(a, b);
    if (mn[c] > emn + 1e-9 || mx[c] < emx - 1e-9) superset = false;
    if (Math.abs(mn[c] - emn) < 1e-9 && Math.abs(mx[c] - emx) < 1e-9) exactHit++;
  }
  ok(superset, 'LOD 包络是精确包络的超集（不会漏掉任何极值）');
  ok(exactHit > 0, `其中 ${exactHit}/${cols} 列与精确值完全一致`);

  // 放大到每列 < 16 个样本时应当自动切成精确扫描
  const mn2 = new Float64Array(8), mx2 = new Float64Array(8);
  const lod2 = st2.channel(0).columns(0, 64, 8, mn2, mx2);
  ok(lod2 === false, '每列 8 个样本 → 逐样本精确扫描（放大后取值必须精确）');
  const [e0, e1] = st2.channel(0).exact(0, 8);
  ok(near(mn2[0], e0) && near(mx2[0], e1), '精确模式下第 0 列与 exact() 完全一致');

  // 满 / 溢出计数 / 时间轴
  const st3 = new S.SampleStore([{ name: 'x', addr: 0, size: 2, scalar: 'u16' }], 10);
  for (let i = 0; i < 10; i++) st3.pushFrame([i], i * 100);
  ok(st3.full === true && st3.count === 10, '存满 10 个 → full');
  st3.pushFrame([99], 1000); st3.pushFrame([99], 1100);
  ok(st3.overrun === 2 && st3.count === 10, '满了之后再来的帧计入 overrun（不静默丢）');
  ok(near(st3.rate(), 1e6 / 100, 1), `实测速率 ≈ 10 kHz（实际 ${st3.rate().toFixed(1)} Hz）`);
  ok(near(st3.timeAt(5), 500, 1), `timeAt(5) ≈ 500 µs（实际 ${st3.timeAt(5).toFixed(1)}）`);
  ok(st3.bytes() > 10 * 2, `显存占用统计含 LOD（${st3.bytes()} B）`);

  // 段内插值必须用**相邻锚点**的实测间隔，不能用全局平均：
  // 真机采到过 40 ms 的长卡顿，若拿"首尾÷样本数"的平均速率插值，段内局部读数会整体偏。
  const st4 = new S.SampleStore([{ name: 'x', addr: 0, size: 2, scalar: 'u16' }], 256);
  for (let i = 0; i < 128; i++){
    // 前 64 个样本 10 µs 一个，后 64 个 100 µs 一个（模拟采样期间被拖慢）
    st4.pushFrame([i], i < 64 ? i * 10 : 640 + (i - 64) * 100);
  }
  const globalUs = i => i * 1e6 / st4.rate();          // 老算法（全局平均速率）会给出的读数
  ok(near(st4.timeAt(32), 320, 1),
     `第一段内按本段实测间隔插值：timeAt(32)=${st4.timeAt(32).toFixed(1)} µs（全局平均会算成 ${globalUs(32).toFixed(1)}）`);
  ok(near(st4.timeAt(96), 640 + 32 * 100, 1), `第二段内同样按本段间隔：timeAt(96)=${st4.timeAt(96).toFixed(1)} µs`);
  const dLocal = st4.timeAt(96) - st4.timeAt(32);
  ok(Math.abs(dLocal - (3200 + 320)) < 2,
     `跨段 Δt 用各自段的真实间隔（${dLocal.toFixed(1)} µs，全局平均会算成 ${(globalUs(96) - globalUs(32)).toFixed(1)}）`);

  // scale/offset（显示变换）
  const ch = new S.Channel({ name: 'v', scalar: 'i16', capacity: 4, scale: 0.001, offset: -1 });
  ch.push(0, 1500);
  ok(near(ch.value(0), 0.5), '显示变换 v*scale+offset');
}

// ------------------------------------------------------------------ 7
console.log('== 7. 触发（实时 + 离线重触发）==');
{
  const T = S.TRIG;
  ok(S.trigHit(T.ABOVE, 0, 2, 1) && !S.trigHit(T.ABOVE, 0, 0.5, 1), '"大于"阈值');
  ok(S.trigHit(T.BELOW, 0, -1, 0) && !S.trigHit(T.BELOW, 0, 1, 0), '"小于"阈值');
  ok(S.trigHit(T.RISING, 0.9, 1.1, 1) && !S.trigHit(T.RISING, 1.1, 1.2, 1), '上升沿要跨过阈值');
  ok(S.trigHit(T.FALLING, 1.1, 0.9, 1) && !S.trigHit(T.FALLING, 0.9, 0.8, 1), '下降沿要跨过阈值');
  ok(S.trigHit(T.CHANGE, 5, 6, 0) && !S.trigHit(T.CHANGE, 5, 5, 0), '"变化"判定');
  ok(!S.trigHit(T.RISING, null, 5, 1), '第一个样本不能算沿（没有前一个值）');

  // 方波：第 10 个样本开始为高
  const vars = [{ name: 'sq', addr: 0, size: 2, scalar: 'i16' }];
  const st = new S.SampleStore(vars, 100);
  for (let i = 0; i < 100; i++) st.pushFrame([((i % 20) < 10) ? 0 : 1000], i * 100);
  const hit = S.findTrigger(st, { channel: 0, mode: T.RISING, level: 500 });
  ok(hit === 10, '离线重触发找到第一个上升沿（样本 10）', `实际 ${hit}`);
  const hit2 = S.findTrigger(st, { channel: 0, mode: T.RISING, level: 500 }, hit + 1);
  ok(hit2 === 30, '从上一个命中点继续找 → 下一个上升沿在 30', `实际 ${hit2}`);
  ok(S.findTrigger(st, { channel: 0, mode: T.NONE }) === -1, '不触发模式返回 -1');
  ok(S.findTrigger(st, { channel: 0, mode: T.ABOVE, level: 1e9 }) === -1, '条件永不满足返回 -1');

  const w = S.windowFor(10, 5, 3, 100);
  ok(w.start === 5 && w.end === 14, '预/后触发窗口 [5,14)');
  const w2 = S.windowFor(2, 50, 10, 100);
  ok(w2.start === 0 && w2.end === 13 && w2.short === true, '预触发不够时截断到 0 并标记 short');

  const tr = new S.Trigger();
  tr.configure({ mode: T.RISING, channel: 0, level: 500, pre: 5, post: 5, single: true });
  let hits = 0;
  for (let i = 0; i < 100; i++) if (tr.feed([((i % 20) < 10) ? 0 : 1000], i)) hits++;
  ok(hits === 1 && tr.hitIndex === 10, '单次模式：命中一次后不再报', `命中 ${hits} 次`);
  const tr2 = new S.Trigger();
  tr2.configure({ mode: T.RISING, channel: 0, level: 500, single: false });
  let hits2 = 0;
  for (let i = 0; i < 100; i++) if (tr2.feed([((i % 20) < 10) ? 0 : 1000], i)) hits2++;
  ok(hits2 === 5, '连续模式：每次都报（100 个样本里 5 个上升沿）', `实际 ${hits2}`);
}

// ------------------------------------------------------------------ 8
console.log('== 8. 假探针端到端：配置 → 采样 → 包 → 解码 → 缓冲（逐点对账）==');
{
  const vars = [
    { name: 'a.f32', addr: 0x20000000, size: 4, scalar: 'f32' },
    { name: 'b.i32', addr: 0x20000004, size: 4, scalar: 'i32' },
    { name: 'c.u16', addr: 0x20000008, size: 2, scalar: 'u16' },
    { name: 'd.i16', addr: 0x2000000a, size: 2, scalar: 'i16' },
    { name: 'e.u8', addr: 0x2000000c, size: 1, scalar: 'u8' },
    { name: 'f.i8', addr: 0x2000000d, size: 1, scalar: 'i8' },
    { name: 'g.u32', addr: 0x20000010, size: 4, scalar: 'u32' },
    { name: 'h.f64', addr: 0x20000018, size: 8, scalar: 'f64' },
  ];
  const probe = new M.MockScopeProbe({ periodUs: 100, startDelayPolls: 1, swdMhz: 45 });
  const cfg = P.configData({ periodUs: 100, vars });
  const r0 = await probe.xfer(P.HID_CMD, cfg);
  ok(r0[2] === 0 && r0[1] === P.HID_CMD, 'CONFIG 回包 rc=0');
  ok(probe.periodUs === 100 && probe.vars.length === 8, '假探针收到了周期与 8 个变量');

  const rStart = await probe.xfer(P.HID_CMD, P.flagsData(P.ACT.START));
  ok(rStart[2] === (-100 & 0xff), '首次启动回 -100（排队中）—— 与真固件同一个哨兵值');
  const st1 = P.parseScopeStatus(new Uint8Array(rStart.buffer, rStart.byteOffset + 3, 48));
  ok(P.scopeRcText(st1.startRc).includes('启动中'), '状态字里的 startRc 也是 -100');
  await probe.xfer(P.HID_CMD, P.flagsData(P.ACT.STATUS));
  const rStart2 = await probe.xfer(P.HID_CMD, P.flagsData(P.ACT.STATUS));
  ok(rStart2[2] === 0, '排队结束后返回 0');

  // 推 1 秒（periodUs=100 → 10000 个样本），走完整的"字节流 → 包 → 解码 → 缓冲"
  const stream = new P.PacketStream();
  const def = { vars: null };
  let tUs = 0;
  const store = new S.SampleStore(vars, 10000);
  let packets = 0, stats = 0;
  const consume = chunks => {
    const bytes = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of chunks){ bytes.set(c, o); o += c.length; }
    for (const pkt of stream.push(bytes)){
      packets++;
      if (pkt.kind === P.KIND.DEF) def.vars = P.parseDef(pkt.payload).vars;
      else if (pkt.kind === P.KIND.DATA){
        const nums = P.decodeSamples(def.vars, pkt.payload, pkt.n, []);
        for (let i = 0; i < pkt.n; i++){
          const fr = nums.slice(i * def.vars.length, (i + 1) * def.vars.length);
          store.pushFrame(fr, pkt.tUs + i * 100);
        }
      } else if (pkt.kind === P.KIND.STAT) stats++;
    }
  };
  consume(probe.poll(0));                          // 第一次 poll 只是对齐时间基（产出 0 个）
  for (let step = 0; step < 100; step++){
    tUs += 10_000;                                 // 每步 10 ms
    consume(probe.poll(tUs));
  }
  consume(probe.flush());                          // 收尾：把不满一包的尾巴发出来
  ok(!!def.vars && def.vars.length === 8, '从 DEF 包里恢复了变量表（含类型）');
  ok(packets === 1 + Math.ceil(10000 / P.samplesPerPacket(26)) + stats && stats > 0,
     `包数对得上：1 DEF + ${Math.ceil(10000 / 19)} DATA + ${stats} STAT = ${packets}`);
  ok(store.count === 10000, `缓冲里正好 10000 个样本（实际 ${store.count}）`);
  ok(probe.delivered === 10000 && probe.produced === 10000, '产出 10000 = 送达 10000（flush 后被丢的尾巴也补上了）');

  // ★ 逐点对账：缓冲里的值必须与假探针的"应有波形"完全相等
  let mismatch = 0, firstBad = null;
  for (let k = 0; k < vars.length; k++){
    const ch = store.channel(k);
    for (let i = 0; i < store.count; i++){
      const want = probe.valueAt(k, i);
      const got = ch.at(i);
      const same = (vars[k].scalar === 'f32') ? Math.abs(got - want) < 1e-6 : got === want;
      if (!same){ mismatch++; if (!firstBad) firstBad = `${vars[k].name}[${i}] got=${got} want=${want}`; }
    }
  }
  ok(mismatch === 0, '8 通道 × 10000 样本**逐点相等**（含 f64/u32/i32 精度）', firstBad || '');
  ok(near(store.rate(), 10000, 1), `实测速率 ≈ 10 kHz（${store.rate().toFixed(1)} Hz）`);
  ok(near(store.timeAt(5000), 500000, 200), `timeAt(5000) ≈ 0.5 s（${(store.timeAt(5000) / 1000).toFixed(1)} ms）`);
  ok(store.channel(0).min >= -1.001 && store.channel(0).max <= 1.001, 'f32 正弦幅度在 ±1 内');

  // 丢样本必须被数出来
  const probe2 = new M.MockScopeProbe({ periodUs: 100, dropEvery: 1000, startDelayPolls: 0 });
  probe2.configure({ periodUs: 100, vars });
  probe2.start();
  let t2 = 0, fed2 = 0;
  const st2 = new P.PacketStream();
  for (let step = 0; step < 50; step++){
    t2 += 10_000;
    for (const pkt of st2.push(new Uint8Array(probe2.poll(t2).flatMap(c => [...c])))) if (pkt.kind === P.KIND.DATA) fed2 += pkt.n;
  }
  for (const pkt of st2.push(new Uint8Array(probe2.flush().flatMap(c => [...c])))) if (pkt.kind === P.KIND.DATA) fed2 += pkt.n;
  ok(probe2.dropped > 0, `dropEvery=1000 时假探针确实丢了 ${probe2.dropped} 个样本`);
  ok(probe2.delivered + probe2.dropped === probe2.produced, '产出 = 送达 + 丢弃（账对得上）');
  ok(fed2 === probe2.delivered, `解出来的样本数 = 送达数（${fed2}）`);

  // "跑着但不发数据"（探针卡住）
  const probe3 = new M.MockScopeProbe({ periodUs: 100, stallAfter: 50, startDelayPolls: 0 });
  probe3.configure({ periodUs: 100, vars });
  probe3.start();
  let n3 = 0, t3 = 0;
  const spp3 = P.samplesPerPacket(26);
  for (let step = 0; step < 50; step++){
    t3 += 10_000;
    for (const c of probe3.poll(t3)) if (c[3] === P.KIND.DATA) n3++;
  }
  ok(probe3.produced === 50 && probe3.running && n3 === Math.floor(50 / spp3),
     `stallAfter 复现"探针在跑但停在 50 个样本"（发出 ${n3} 个满包 = floor(50/${spp3})）`);

  // 启动失败要有 rc（测错误文案）
  const probe4 = new M.MockScopeProbe({ failStart: -2 });
  probe4.configure({ periodUs: 100, vars });
  probe4.start();
  ok(probe4.running === false && P.scopeRcText(-2).includes('SWD 初始化失败'), '启动失败 rc=-2 → 文案指向接线/供电');
}

console.log('== 7. tick 周期与 v1/v2 时间轴兼容 ==');
{
  const vars = [{ name: 'x', addr: 0x20001044, size: 4, scalar: 'u32' }];
  for (const us of [2.25, 2.5, 2.75]){
    const cfg = P.configData({ periodUs: us, vars });
    ok(cfg[0] === P.ACT.CONFIG_TICKS && new DataView(cfg.buffer).getUint32(1, true) === us*24,
       `${us} µs 配置为 ${us*24} tick，使用新动作`);
    const probe = new M.MockScopeProbe();
    const res = await probe.xfer(P.HID_CMD, cfg);
    const status = P.parseScopeStatus(res.subarray(3));
    ok(status.supportsTicks && status.supportsBatch && status.periodUs === us, '假探针配置回报真实小数周期');
    probe.start(); probe.poll(0);
    const packets = [...probe.poll(1000), ...probe.flush()].map(P.parsePacket);
    const def = packets.find(p => p.kind === P.KIND.DEF);
    ok(def.version === 2 && P.parseDef(def.payload, def.version).periodUs === us, 'v2 DEF 周期单位转换');
    const time = new P.TimeUnwrap();
    const data = packets.filter(p => p.kind === P.KIND.DATA);
    ok(data.every(p => p.version === 2) && P.packetTimeUs(data[1], time) - P.packetTimeUs(data[0], new P.TimeUnwrap()) === 124*us,
       '满包边界时间间隔 = 124 × 小数周期');
  }
  ok(P.configData({ periodUs: 3, vars })[0] === P.ACT.CONFIG, '整数周期继续使用 action 7');
  const time = new P.TimeUnwrap();
  const before = P.parsePacket(P.buildData({ tUs: P.usForTicks(0xfffffff0), version: 2 }));
  const after = P.parsePacket(P.buildData({ tUs: P.usForTicks(60), version: 2 }));
  const t0 = P.packetTimeUs(before, time), t1 = P.packetTimeUs(after, time);
  ok(near(t1-t0, 76/24), 'v2 u32 tick 回绕约 179 秒处连续，先 unwrap 后换算');
  const st = P.parsePacket(P.buildStat({ periodUs: 2.5, version: 2 }));
  ok(P.parseStat(st.payload, st.version).periodUs === 2.5, 'v2 STAT 不把 60 tick 当 60 µs');
  const malformed = P.buildData({ n: 1 });
  new DataView(malformed.buffer).setUint16(14, 512, true);
  ok(P.parsePacket(malformed) === null, 'DATA aux 校验使用完整 u16，拒绝超长载荷');
}

console.log(`\n${fail ? '❌' : '✅'} scope-proto.test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
