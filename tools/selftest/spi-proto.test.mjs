/**
 * 纯 Node 自测（不需要浏览器、不需要硬件）：
 *   node tools/selftest/spi-proto.test.mjs      （等价：make test-spi）
 *
 * 覆盖「SPI/QSPI 屏」页的**协议层与假探针**：
 *   帧编解码 / 打包器（一帧不跨包、绝不填充）/ HID 0x35 的字节偏移 /
 *   应答切包与 seq 配对 / 配置块与面板档往返 / 假探针的帧执行与故障注入。
 *
 * 这里钉的都是"线上契约"：偏移写错、打包越界、填充超 8 B 之类的问题，
 * 在真机上只会表现为 frames_err 上涨或数据错位 —— 必须在离线就咬住。
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..', 'app');
const url = p => 'file://' + join(app, p).replace(/\\/g, '/');

const P = await import(url('spi/protocol.js'));
const M = await import(url('spi/mock.js'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond){ pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};
const eqArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const hexOf = a => [...a].map(x => x.toString(16).padStart(2, '0')).join(' ');

// ==================================================================== 1
console.log('== 1. 帧编解码（8 B 头 + payload）==');
{
  const f = P.frame(P.T.XFER, Uint8Array.of(1, 2, 3), { flags: P.F.RSP | P.F.NO_DMA, seq: 0x1234 });
  const dv = new DataView(f.buffer);
  ok(f.length === 8 + 3, '帧长 = 8 + payload');
  ok(dv.getUint16(0, true) === P.MAGIC, `magic 小端是 'S','B'（0x${P.MAGIC.toString(16)}）`);
  ok(f[0] === 0x53 && f[1] === 0x42, '线上字节序 = 53 42');
  ok(f[2] === P.T.XFER && f[3] === (P.F.RSP | P.F.NO_DMA) && dv.getUint16(4, true) === 0x1234 && dv.getUint16(6, true) === 3,
     'type/flags/seq/len 落位正确');
  let threw = false;
  try { P.frame(P.T.XFER, new Uint8Array(P.FRAME_MAX + 1)); } catch { threw = true; }
  ok(threw, `payload 超过 ${P.FRAME_MAX} B 直接抛错（不静默截断）`);

  const x = P.xferPayload({ cmd: 0x2c, tcfg: P.TC.CMD_EN | P.TC.ADDR_EN | P.TC.LINES_4, addrLen: 3, dummy: 2, addr: 0x002c00, tx: Uint8Array.of(0xaa, 0xbb), rxLen: 0 });
  const xd = new DataView(x.buffer);
  ok(x.length === P.XFER_HDR + 2 && x[0] === 0x2c && x[1] === (4 | 8 | 2) && x[2] === 3 && x[3] === 2, 'XFER 传输头前 4 字节');
  ok(xd.getUint16(4, true) === 2 && xd.getUint16(6, true) === 0 && xd.getUint32(8, true) === 0x2c00, 'tx_len/rx_len/addr 小端');

  const s = P.stepPayload({ cmd: 0xce, params: Uint8Array.of(0x5a, 0xa5), delayMs: 100 });
  const sd = new DataView(s.buffer);
  ok(s.length === 6 && s[0] === 0xce && s[1] === 2 && sd.getUint16(2, true) === 100 && s[4] === 0x5a, 'STEP = cmd/nparams/delay_ms/params');
  let threw2 = false;
  try { P.stepPayload({ cmd: 0, params: new Uint8Array(256) }); } catch { threw2 = true; }
  ok(threw2, 'STEP 参数 > 255 抛错（nparams 是 1 字节）');
}

// ==================================================================== 2
console.log('== 2. 打包器：一帧不跨包、绝不填充 ==');
{
  const mk = (n, seq) => P.frame(P.T.STEP, P.stepPayload({ cmd: seq & 0xff, params: new Uint8Array(n) }), { flags: 0, seq });
  const frames = [mk(1, 1), mk(4, 2), mk(0, 3), mk(1, 4), mk(2, 5), mk(1, 6)];

  // ① 紧凑的小帧：应当被攒进同一个包（这是面板初始化 192 条的提速来源）
  const dense = P.packFrames(frames);
  ok(dense.length < frames.length, `小帧被攒批：${frames.length} 帧 → ${dense.length} 包`);
  ok(P.checkPacks(dense).length === 0, '每个包都过固件纪律（无跨包帧、无 ≥8 B 残渣）', P.checkPacks(dense).join('；'));

  // ② 解出来的帧序列必须与输入**逐个一致**（type/seq/payload）
  const got = [];
  for (const p of dense) for (const fr of P.parsePack(p).frames) got.push(fr);
  ok(got.length === frames.length, `解析出的帧数一致（${got.length}/${frames.length}）`);
  let same = got.length === frames.length;
  for (let i = 0; i < got.length && same; i++){
    same = got[i].payload.length === frames[i].length - 8 && eqArr(got[i].payload, frames[i].subarray(8)) && got[i].seq === i + 1;
  }
  ok(same, '帧内容与顺序逐字节一致');

  // ③ 边界：一帧 504 payload（= 512 B 整包）必须独占一包
  const big = P.frame(P.T.XFER, new Uint8Array(P.FRAME_MAX));
  const packs2 = P.packFrames([mk(1, 7), big, mk(1, 8)]);
  ok(packs2.length === 3 && packs2[1].length === 512, `一帧占满 512 B 时独占一包（${packs2.map(p => p.length).join('/')}）`);
  ok(P.checkPacks(packs2).length === 0, '边界包同样干净');

  // ④ 单帧超过一个包 → 早炸
  let threw = false;
  try { P.packFrames([new Uint8Array(513)]); } catch { threw = true; }
  ok(threw, '单帧 > 512 B 直接抛错（固件无法解析这种帧）');

  // ⑥ 攒批（batchPacks）：一次 transferOut 带多个 512 B 包 —— 设备侧看到的东西必须**一个字节都不变**
  {
    // 刷屏的真实形状：3 条小命令帧 + 288 个 512 B 整包 + 1 个 404 B 末片
    const cmds = [mk(8, 1), mk(8, 2), mk(13, 3)];
    const full = Array.from({ length: 10 }, (_, i) => P.frame(P.T.XFER, P.xferPayload({ cmd: 0, tcfg: 2, tx: new Uint8Array(492) }), { flags: i === 9 ? 0 : P.F.CS_HOLD, seq: 0 }));
    const tail = P.frame(P.T.XFER, P.xferPayload({ cmd: 0, tcfg: 2, tx: new Uint8Array(384) }), { flags: P.F.RSP, seq: 99 });
    const packs = P.packFrames([...cmds, ...full, tail]);
    ok(packs.length === 1 + 10 + 1, `打包后 ${packs.length} 个包（3 条命令被攒成 1 包 + 10 个整包 + 末片）`);
    ok(packs[1].length === 512, `整包正好 512 B（一片一个 USB 包，不需要补填充）`);

    // 默认 = PKT：与"每包一次 transferOut"完全等价
    const b0 = P.batchPacks(packs);
    ok(b0.length === packs.length && b0.every((b, i) => b.packs === 1 && b.data === packs[i]),
       `batchBytes=512 时退化成"一包一批"（${b0.length} 批 = ${packs.length} 包，零行为变化）`);

    // 4 KB 攒批：整包按 8 个一组，短包（命令包/末片）各自收尾
    const b4 = P.batchPacks(packs, 4096);
    ok(b4[0].packs === 1 && b4[0].bytes < 512, `短包（命令 3 帧 = ${b4[0].bytes} B）自成一个尾批 —— 短包绝不能夹在中间`);
    ok(b4.slice(1, -1).every(b => b.bytes === 4096 && b.packs === 8), `中间批次都是 8 包 / 4096 B（${b4.length} 批）`);
    ok(b4[b4.length - 1].bytes === 2 * 512 + 404 && b4[b4.length - 1].packs === 3,
       `末批 = 剩下 2 个整包 + 末片（${b4[b4.length - 1].bytes} B / ${b4[b4.length - 1].packs} 包，末片 404 B 收尾）`);
    ok(b4.reduce((a, b) => a + b.packs, 0) === packs.length, '批里的包数守恒（没有丢包）');

    // 关键不变量：把批按 512 B 拆回槽，解出来的帧序列与逐包发**完全一致**
    const seqOf = arr => { const out = []; for (const x of arr) for (const fr of P.parsePack(x).frames) out.push(`${fr.type}:${fr.payload.length}`); return out.join(','); };
    const oneByOne = packs.map(p => P.parsePack(p)).flatMap(r => r.frames);
    const byBatch = [];
    for (const b of b4){
      for (let off = 0; off < b.data.length; off += 512){
        const slot = b.data.subarray(off, Math.min(off + 512, b.data.length));
        const r = P.parsePack(slot);
        if (r.err) byBatch.push('ERR:' + r.err.why);
        for (const fr of r.frames) byBatch.push(`${fr.type}:${fr.payload.length}`);
      }
    }
    ok(byBatch.join(',') === oneByOne.map(f => `${f.type}:${f.payload.length}`).join(','),
       '攒批后按 512 B 槽解出来的帧序列，与逐包发一字不差');
    ok(!byBatch.some(x => String(x).startsWith('ERR:')), '每个槽都干净（没有跨槽帧、没有 ≥8 B 残渣）');

    // 上限保护
    let threw2 = false;
    try { P.batchPacks([new Uint8Array(513)]); } catch { threw2 = true; }
    ok(threw2, '单包 > 512 B 在攒批入口也直接抛错');
    const huge = P.batchPacks(packs, 10 * 1024 * 1024);
    ok(huge.every(b => b.bytes <= P.BATCH_MAX), `一次传输被夹在 ${P.BATCH_MAX / 1024} KB 以内（最大 ${Math.max(...huge.map(b => b.bytes))} B）`);
  }

  // ⑤ 残渣语义：< 8 B 静默丢弃；≥ 8 B 的垃圾会被当成帧头 → err
  const one = P.frame(P.T.STEP, P.stepPayload({ cmd: 1, params: new Uint8Array(1) }));   // 13 B
  const residue = new Uint8Array(one.length + 4);
  residue.set(one, 0); residue.fill(0xee, one.length);
  const r1 = P.parsePack(residue);
  ok(r1.frames.length === 1 && r1.residue === 4 && !r1.err, '包尾 4 B 残渣：解析出 1 帧、残渣 4 B、无错');
  const junk = new Uint8Array(one.length + 8);
  junk.set(one, 0); junk.fill(0xee, one.length);
  const r2 = P.parsePack(junk);
  ok(r2.err && r2.err.why === 'bad_magic', '包尾 8 B 垃圾：判 bad_magic（真固件这里会 frames_err++）');
  const long = P.frame(P.T.STEP, P.stepPayload({ cmd: 1, params: new Uint8Array(24) }));  // 声明 24 B 参数
  ok(P.parsePack(long.subarray(0, 20)).err?.why === 'bad_len', '帧长超出包尾 → bad_len');
}

// ==================================================================== 3
console.log('== 3. HID 0x35：偏移与解析（照固件实现，不是 proto.h 字段序）==');
{
  ok(P.HID_OFF_CMD === 1 && P.HID_OFF_ACTION === 2 && P.HID_OFF_DATA === 3,
     'WebHID 比固件少 1 字节 Report ID：cmd@1、action@2、data@3');
  ok(eqArr(P.hidData.enable(true), Uint8Array.of(P.ACT.ENABLE, 1)), 'ENABLE 请求 = [action, on]');
  ok(P.hidData.pinCfg(P.LINE.BL, 3)[0] === P.ACT.PIN_CFG, 'PIN_CFG 请求带 action');

  // 造一个"固件那样"的 STATUS 响应：状态字 + 9 个 u32
  const res = new Uint8Array(63);
  res[1] = P.HID_CMD; res[2] = P.ACT.STATUS; res[0] = 44;
  const dv = new DataView(res.buffer);
  dv.setUint32(3, 1 | (P.ST.RANGE << 8), true);
  dv.setUint32(7, 11, true); dv.setUint32(11, 22, true); dv.setUint32(15, 33, true);
  dv.setUint32(19, 44, true); dv.setUint32(23, 0, true); dv.setUint32(27, 55, true);
  dv.setUint32(31, 66, true); dv.setUint32(35, 40000000, true); dv.setUint32(39, 77, true);
  const st = P.parseStatusPayload(res);
  ok(st.framesOk === 11 && st.bytesTx === 22 && st.bytesRx === 33 && st.txPoll === 44 && st.outOverrun === 55 && st.inDrop === 66,
     '计数器 1..7 落位正确');
  ok(st.actualSclkHz === 40000000, '第 9 个字 = 实际 SCLK（固件 res[36]）');
  ok(st.framesErr === 77, '第 10 个字 = frames_err（固件 res[40]，**不是** proto.h 的字段序）');
  ok(P.statusWord(st.status).enabled && P.statusWord(st.status).err === P.ST.RANGE, '状态字位域 + 最近错误码');

  // 配置块 / 面板档往返
  const cfg = P.encodeCfg({ sclkHz: 75000000, mode: 3, csPolicy: 3, txDmaThreshold: 0, padDc: 1, padRst: 2, padCsAux: 4, padBl: 3, padActiveLow: 0x06, padTe: 4, flags: 1 });
  ok(cfg.length === P.CFG_LEN, `配置块 ${P.CFG_LEN} B`);
  const cfg2 = P.decodeCfg(cfg);
  ok(cfg2.sclkHz === 75000000 && cfg2.mode === 3 && cfg2.csPolicy === 3 && cfg2.padActiveLow === 0x06, 'encode → decode 往返一致');
  ok(cfg[20] === 0xf8 && cfg[21] === 0x01, `max_frame_bytes 默认写成 ${P.FRAME_MAX}（小端 f8 01）`);

  const prof = P.encodeProfile({ profile: 2, defLines: 4, dcActiveHigh: true, csHoldInStep: true, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3 });
  const prof2 = P.decodeProfile(prof);
  ok(prof.length === P.PROFILE_LEN && prof2.profile === 2 && prof2.qspiColorOpcode === 0x32, `面板档 ${P.PROFILE_LEN} B 往返一致`);
  ok(P.lineActiveLow(0x06, P.LINE.RST) && P.lineActiveLow(0x06, P.LINE.CS_AUX) && !P.lineActiveLow(0x06, P.LINE.DC),
     'pad_active_low 位图：bit1 RST / bit2 CS（固件默认 0x06）');
  ok(P.SCLK_CHOICES.map(c => c.hz).join(',') === '0,10000000,20000000,40000000,60000000,75000000',
     'SCLK 档位 = 板级默认 + 10/20/40/60/75 MHz（用户拍板）');
}

// ==================================================================== 4
console.log('== 4. 应答切包（RspStream）与 seq 配对（RspMatcher）==');
{
  /** 造一个真形状的应答包（8 B 头 + 读数据）*/
  const mkRsp = (seq, status, data = new Uint8Array(0), type = P.R.RSP) => {
    const out = new Uint8Array(8 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, P.MAGIC, true); out[2] = type; out[3] = status;
    dv.setUint16(4, seq, true); dv.setUint16(6, data.length, true);
    out.set(data, 8);
    return out;
  };
  const rspA = mkRsp(7, P.ST.OK);
  const rspB = mkRsp(8, P.ST.OK, Uint8Array.of(1, 2, 3, 4));

  const s1 = new P.RspStream();
  ok(s1.push(rspA).length === 1, '一个包一次推送 → 切出 1 个');
  const s2 = new P.RspStream();
  const both = new Uint8Array(rspA.length + rspB.length); both.set(rspA); both.set(rspB, rspA.length);
  ok(s2.push(both).length === 2, '一次 transferIn 带回两个应答 → 切出 2 个');
  const s3 = new P.RspStream();
  ok(s3.push(both.subarray(0, 5)).length === 0 && s3.pending === 5, '半包先缓存（pending=5）');
  ok(s3.push(both.subarray(5)).length === 2, '补齐后一次切出 2 个');
  const s4 = new P.RspStream();
  s4.push(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
  ok(s4.errors === 1, '垃圾字节记 errors（不静默吞）');

  const m = new P.RspMatcher();
  const s1v = m.alloc(), s2v = m.alloc();
  ok(s1v === 1 && s2v === 2, 'seq 从 1 开始分配');
  const p1 = m.wait(s1v, 500, 't1');
  ok(m.inflight === 1, 'wait 后计入在飞');
  ok(m.feed(mkRsp(s2v, P.ST.OK)) === false, 'seq 对不上的应答**不**兑现（不是先来先服务）');
  ok(m.feed(mkRsp(s1v, P.ST.OK, Uint8Array.of(1, 2, 3, 4))) === true, '按 seq 兑现');
  const r = await p1;
  ok(r.status === 0 && eqArr(r.data, Uint8Array.of(1, 2, 3, 4)), '兑现回来的数据正确');
  ok(m.inflight === 0, '兑现后从在飞里移除');

  const got = [];
  const evBefore = m.events.length;
  m.feed(mkRsp(99, P.ST.IN_FULL, new Uint8Array(0), P.R.EVT), e => got.push(e));
  ok(got.length === 1 && got[0].status === P.ST.IN_FULL && m.events.length === evBefore + 1,
     'EVT 走事件通道，不去结算任何请求');

  const p3 = m.wait(m.alloc(), 60, '会超时');
  let timedOut = false;
  try { await p3; } catch { timedOut = true; }
  ok(timedOut, '没人应答 → 超时 reject（不悬挂）');
  ok(m.inflight === 0, '超时后清账');
  const p4 = m.wait(m.alloc(), 5000);
  m.abortAll('测试收尾');
  let aborted = false;
  try { await p4; } catch { aborted = true; }
  ok(aborted, 'abortAll 立刻拒掉在飞请求（收尾不留残雷）');
}

// ==================================================================== 5
console.log('== 5. 假探针：HID 0x35 语义 ==');
{
  const probe = new M.MockSpiProbe();
  const cfg = P.parseCfgPayload(await probe.xfer(P.HID_CMD, P.hidData.getCfg()));
  ok(cfg.sclkHz === 0 && cfg.txDmaThreshold === 100 && cfg.csPolicy === 0, '默认配置照固件（sclk=0 / 阈值 100 / cs_policy 0）');
  /* 2026-10 起假探针的默认辅助脚 = 「引脚分配图」的推荐值（protocol.AUX_DEFAULT），
   * 与预设 / 引脚图三处一致；且这几个 pad 都是**可写**的（旧默认 PB11/PB12 是 SPI2 固定脚，
   * 固件会拒 → 下面"合法配置写进去"那条一直过不去）。 */
  ok(cfg.padDc === 14 && cfg.padRst === 5 && cfg.padCsAux === 0 && cfg.padBl === 13 && cfg.padActiveLow === 0x06,
     `默认辅助脚 = PA26/PA02/不用/PA31（${cfg.padDc}/${cfg.padRst}/${cfg.padCsAux}/${cfg.padBl}），RST+CS 低有效`);

  const bad = P.parseWordPayload(await probe.xfer(P.HID_CMD, P.hidData.setCfg(P.encodeCfg({ sclkHz: 20000000, mode: 9, bits: 8 }))));
  ok(P.statusWord(bad).err === P.ST.RANGE, '非法 mode → 状态字带 RANGE（不静默接受）');
  ok(P.parseCfgPayload(await probe.xfer(P.HID_CMD, P.hidData.getCfg())).sclkHz === 0, '非法配置**没有**写进去（回读还是默认）');

  /* ⚠️ 辅助脚必须选**可写**的：PB10~PB13（pad 1~4）是 SPI2 的 CS/SCLK/MISO/MOSI，
   *    假探针（和固件一样）会回 RANGE 拒掉整块配置 —— 这里以前写的是 1/2/4/3、padTe 还是 4，
   *    于是"合法配置写进去了"和"使能后实际 SCLK"两条一直是红的（2026-10 定位并修）。 */
  const okCfg = P.parseWordPayload(await probe.xfer(P.HID_CMD, P.hidData.setCfg(P.encodeCfg({ sclkHz: 40000000, mode: 0, bits: 8, csPolicy: 0, txDmaThreshold: 100, padDc: 14, padRst: 5, padCsAux: 0, padBl: 13, padActiveLow: 0x06, padTe: 0, flags: 1 }))));
  void okCfg;
  const back = P.parseCfgPayload(await probe.xfer(P.HID_CMD, P.hidData.getCfg()));
  ok(back.sclkHz === 40000000 && back.txDmaThreshold === 100 && back.padActiveLow === 0x06, '合法配置真的写进去了（回读对账）');
  // 🚨 语义钉子：状态字的 err 是「最近一次错误码」，固件成功后**不清**它 ——
  //    页面判断"本次写入是否生效"必须走回读对账（view.js applyCfg），不能看 err。
  const stAfter = P.parseStatusPayload(await probe.xfer(P.HID_CMD, P.hidData.status()));
  ok(P.statusWord(stAfter.status).err === P.ST.RANGE,
     '成功写入之后，状态字里仍留着上一次的 RANGE（"err≠0 = 这次失败"是错判据）');

  const st0 = P.parseStatusPayload(await probe.xfer(P.HID_CMD, P.hidData.status()));
  ok(st0.actualSclkHz === 0, '未使能时「实际 SCLK」= 0');

  const en = P.parseWordPayload(await probe.xfer(P.HID_CMD, P.hidData.enable(true)));
  ok(P.statusWord(en).enabled, 'ENABLE 1 → 状态字 enabled 置位');
  const st1 = P.parseStatusPayload(await probe.xfer(P.HID_CMD, P.hidData.status()));
  ok(st1.actualSclkHz === 40000000, `使能后回读实际 SCLK = ${st1.actualSclkHz}（假探针按整除模型算）`);

  for (const [requested, actual] of [[10000000,10000000],[20000000,20000000],[60000000,60000000],[75000000,60000000],[100000000,60000000],[500000,500000],[480000,480000]]) {
    await probe.xfer(P.HID_CMD, P.hidData.setCfg(P.encodeCfg({ sclkHz: requested, moduleClkHz: 120000000 })));
    const got = P.parseCfgPayload(await probe.xfer(P.HID_CMD, P.hidData.getCfg()));
    const state = P.parseStatusPayload(await probe.xfer(P.HID_CMD, P.hidData.status()));
    ok(got.moduleClkHz === 240000000 && state.actualSclkHz === actual && actual <= requested,
       `固定 240 MHz，忽略旧时钟提示；请求 ${requested} Hz → ${actual} Hz`);
  }
  await probe.xfer(P.HID_CMD, P.hidData.setCfg(P.encodeCfg({ sclkHz: 479999 })));
  const low = P.parseCfgPayload(await probe.xfer(P.HID_CMD, P.hidData.getCfg()));
  ok(low.sclkHz === 480000, '不可分频的低速配置被拒绝，保留原配置');
  ok(P.decodeCfg(P.encodeCfg({})).moduleClkHz === 240000000, '网页默认编码模块时钟为 240 MHz');

  const prof = P.parseProfilePayload(await probe.xfer(P.HID_CMD, P.hidData.getProfile()));
  ok(prof.profile === 0 && prof.qspiColorOpcode === 0x32, '默认面板档 = raw，QSPI 像素 opcode 0x32');

  // 未使能时主机写 → 真固件 NAK
  const p2 = new M.MockSpiProbe();
  const r = p2.write(P.frame(P.T.PING, new Uint8Array(0), { flags: P.F.RSP, seq: 1 }));
  ok(r.accepted === false && p2.nakWrites === 1, '未使能时写包被 NAK（真固件这里不 arm OUT 端点）');
}

// ==================================================================== 6
console.log('== 6. 假探针：帧执行（回环 / 档位展开 / 非阻塞延时）==');
{
  const probe = new M.MockSpiProbe();
  await probe.xfer(P.HID_CMD, P.hidData.enable(true));

  // ① XFER 回环：发什么读回什么（等价于接好 MOSI↔MISO 跳线）
  const tx = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const pack = P.packFrames([P.frame(P.T.XFER, P.xferPayload({ tcfg: P.TC.LINES_1, tx, rxLen: tx.length }), { flags: P.F.RSP, seq: 5 })])[0];
  probe.write(pack);
  const rsp = P.parseRsp(probe.takeRsp());
  ok(rsp && rsp.seq === 5 && rsp.status === P.ST.OK && eqArr(rsp.data, tx), 'XFER 全双工回环：读回 == 发出的 4 B');

  // ② 全双工不等长 → RANGE；读数据不带 RSP → BAD_FRAME
  const bad1 = P.packFrames([P.frame(P.T.XFER, P.xferPayload({ tcfg: 0, tx: Uint8Array.of(1, 2), rxLen: 3 }), { flags: P.F.RSP, seq: 6 })])[0];
  probe.write(bad1);
  ok(P.parseRsp(probe.takeRsp()).status === P.ST.RANGE, '收发不等长 → RANGE（固件 spi_bridge.c:527）');
  const bad2 = P.packFrames([P.frame(P.T.XFER, P.xferPayload({ tcfg: 0, rxLen: 2 }), { flags: 0, seq: 7 })])[0];
  probe.write(bad2);
  const evt = P.parseRsp(probe.takeRsp());
  ok(evt && evt.type === P.R.EVT && evt.status === P.ST.BAD_FRAME, '读数据不带 RSP → 错误经 EVT 上报');

  // ③ 没接跳线：读回 0x00（失败路径必须能被看见）
  const probe2 = new M.MockSpiProbe({ loopback: false });
  await probe2.xfer(P.HID_CMD, P.hidData.enable(true));
  probe2.write(P.packFrames([P.frame(P.T.XFER, P.xferPayload({ tcfg: 0, tx: Uint8Array.of(0xa5, 0x5a), rxLen: 2 }), { flags: P.F.RSP, seq: 1 })])[0]);
  ok(eqArr(P.parseRsp(probe2.takeRsp()).data, Uint8Array.of(0, 0)), '没接跳线 → 读回 0x00（回环自检会 FAIL，符合预期）');

  // ④ 档位展开：三条 STEP 的线上字节
  //    ⚠️ 档 2 这条钉的是 `sb_step_qspi()` 的展开 = `addr = cmd << 8` → 线上 `02 | 00 F0 00`
  //       （命令在 24 bit 地址的**中间字节**，即 ST77916 数据手册 §8.8.5.1 的 `CMD : 0x00XX00`）。
  //       固件 2026-09-30 已订正到此形状（历史上错过 `cmd << 16` 与 `addr = cmd` 两版）；
  //       本机 LA 实测真机线上确为 `02 00 73 00 f0`，所以 mock 必须与之一致，
  //       否则整页自测会在"错的形状"上通过。
  const cases = [
    [{ profile: 0, defLines: 1 }, 'ce 5a a5', '档 0 raw：cmd + params'],
    [{ profile: 1 }, 'ce 5a a5', '档 1 spi_dcx：同一 CS 窗口里 DC 0→1'],
    [{ profile: 2 }, '02 00 f0 00 28', '档 2 qspi：命令字在地址中间字节（00 XX 00，与手册一致）'],
  ];
  for (const [prof, want, label] of cases){
    const p = new M.MockSpiProbe();
    await p.xfer(P.HID_CMD, P.hidData.enable(true));
    await p.xfer(P.HID_CMD, P.hidData.setProfile(P.encodeProfile({ profile: prof.profile, defLines: prof.defLines || 1, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3, dcActiveHigh: true, csHoldInStep: true })));
    const step = prof.profile === 2
      ? P.stepPayload({ cmd: 0xf0, params: Uint8Array.of(0x28) })
      : P.stepPayload({ cmd: 0xce, params: Uint8Array.of(0x5a, 0xa5) });
    p.write(P.packFrames([P.frame(P.T.STEP, step, { flags: P.F.RSP, seq: 1 })])[0]);
    const got = p.wire.length ? hexOf(p.wire[0]) : '(空)';
    ok(got === want, `${label} → ${want}`, `实际 ${got}`);
  }

  // ⑤ 非阻塞延时：DELAY 之后的 PING 要等时间到才执行
  let fake = 1000;
  const p3 = new M.MockSpiProbe({ clock: () => fake });
  await p3.xfer(P.HID_CMD, P.hidData.enable(true));
  const two = P.packFrames([
    P.frame(P.T.DELAY, P.delayPayload(5000), { flags: P.F.RSP, seq: 1 }),   // 5 ms
    P.frame(P.T.PING, new Uint8Array(0), { flags: P.F.RSP, seq: 2 }),
  ])[0];
  p3.write(two);
  ok(p3.rsps.length === 1 && P.parseRsp(p3.rsps[0]).seq === 1, 'DELAY 帧立刻应答，后面的 PING 被挡住（非阻塞：主循环没停）');
  p3.tick(fake + 1);
  ok(p3.rsps.length === 1, '时间没到 → 后面的帧还不执行');
  p3.tick(fake + 6);
  ok(p3.rsps.length === 2 && P.parseRsp(p3.rsps[1]).seq === 2, '到点后继续执行（PING 应答出现）');
  ok(p3.delays.includes(5), 'DELAY 的时长被记下来（5000 µs → 5 ms，统一毫秒口径）');

  // ⑥ 故障注入：丢应答 / IN 环满 / 强制状态码
  const p4 = new M.MockSpiProbe({ faults: { dropRsp: true } });
  await p4.xfer(P.HID_CMD, P.hidData.enable(true));
  p4.write(P.packFrames([P.frame(P.T.PING, new Uint8Array(0), { flags: P.F.RSP, seq: 1 })])[0]);
  ok(p4.rsps.length === 0, 'dropRsp：应答真的不回（页面侧会走超时分支）');
  const p5 = new M.MockSpiProbe({ faults: { inFull: true } });
  await p5.xfer(P.HID_CMD, P.hidData.enable(true));
  p5.write(P.packFrames([P.frame(P.T.PING, new Uint8Array(0), { flags: P.F.RSP, seq: 1 })])[0]);
  const r5 = P.parseRsp(p5.takeRsp());
  ok(r5.status === P.ST.IN_FULL && p5.stats.inDrop === 1, 'IN 环满 → 应答带 IN_FULL 且 in_drop++');
  const p6 = new M.MockSpiProbe();
  await p6.xfer(P.HID_CMD, P.hidData.enable(true));
  p6.faults.forceStatus = P.ST.TIMEOUT;
  p6.write(P.packFrames([P.frame(P.T.PING, new Uint8Array(0), { flags: P.F.RSP, seq: 1 })])[0]);
  ok(P.parseRsp(p6.takeRsp()).status === P.ST.TIMEOUT, 'forceStatus 能造出任意错误码（测页面的错误文案）');
}

// ==================================================================== 7
console.log('== 7. 端到端（无浏览器）：整表下发 + 统计对账 ==');
{
  const probe = new M.MockSpiProbe();
  probe.resetState();
  await probe.xfer(P.HID_CMD, P.hidData.enable(true));
  await probe.xfer(P.HID_CMD, P.hidData.setProfile(P.encodeProfile({ profile: 2, qspiWrOpcode: 0x02, qspiAddrBytes: 3 })));

  // 模拟 ST77916 那种"192 条面板步"：全部不带 RSP，只有最后一条带
  const rows = [];
  for (let i = 0; i < 192; i++) rows.push({ cmd: i & 0xff, params: Uint8Array.of(i & 0xff, (i * 3) & 0xff), delayMs: i % 16 === 0 ? 5 : 0 });
  const frames = rows.map((r, i) => P.frame(P.T.STEP, P.stepPayload(r), { flags: i === rows.length - 1 ? P.F.RSP : 0, seq: i === rows.length - 1 ? 1 : 0 }));
  const packs = P.packFrames(frames);
  ok(P.checkPacks(packs).length === 0, `192 条 STEP 打包干净（${frames.length} 帧 → ${packs.length} 包）`);
  ok(packs.length < 20, `攒批把 USB 往返压到 ${packs.length} 次（不攒批要 ${frames.length} 次）`);

  for (const p of packs) probe.write(p);
  // 表里有延时：把时间推够，让队列走完
  let t = 0;
  for (let i = 0; i < 400 && probe.queue.length; i++){ t += 6; probe.tick(t); }
  ok(probe.queue.length === 0, '所有帧都被执行完（非阻塞延时逐个到点）');
  const rsp = P.parseRsp(probe.takeRsp());
  ok(rsp && rsp.seq === 1 && rsp.status === P.ST.OK, '只有最后一条的应答回来（其余不带 RSP，不产生 IN 流量）');
  const st = P.parseStatusPayload(await probe.xfer(P.HID_CMD, P.hidData.status()));
  ok(st.framesOk === 192 && st.framesErr === 0, `frames_ok=${st.framesOk}（应为 192）· frames_err=${st.framesErr}`);
  ok(st.bytesTx === 192 * 6, `bytes_tx=${st.bytesTx}（每步 6 B：0x02 + 命令字 + 00 00 + 2 B 参数）`);
  ok(probe.csWindows >= 192, `CS 窗口数 ${probe.csWindows}（每步一次事务）`);
}

console.log(`\n${fail ? '❌' : '✅'} spi-proto.test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
