/**
 * 真机基准的**小结表格**（跑完打在屏幕上，也能单独对着一份结果 JSON 重打）。
 *
 *   node tools/selftest/campaign-summary.mjs                      # 默认读 tmp/hpm-campaign-result.json
 *   node tools/selftest/campaign-summary.mjs tmp/campaign-result.json
 *
 * 为什么单独一个文件：基准脚本（F103 的 hw-campaign / HPM 的 hw-campaign-hpm）每次跑完都要打这张表，
 * 事后想再看一眼结果又不该重跑一遍硬件 —— 一份"结果 JSON → 表格"的实现供两边共用。
 *
 * ⚠️ 中文是**双宽**字符：对齐要按显示宽度算，不能用 `String.length`（否则列会歪）。
 */
import fs from 'node:fs';

/** 显示宽度（CJK / 全角算 2 列）*/
export function width(s){
  let n = 0;
  for (const c of String(s)){
    const cp = c.codePointAt(0);
    n += (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6))) ? 2 : 1;
  }
  return n;
}
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s);

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const S = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '—');

/**
 * @param {object} r 基准脚本写的 report（{board, app, cycles[], alt[], spec, errors[]}）
 * @returns {string} 可直接 console.log 的多行文本
 */
export function summaryTable(r){
  const cy = r.cycles || [];
  const col = (f) => cy.map(f);
  /** 一行：项目 | 各轮（带单位） | 均值/统计 | spec | 判定 */
  const rows = [];
  const push = (name, per, stat, spec, verdict) => rows.push([name, per, stat, spec, verdict]);
  /** 格式化每轮的值：f = 取值函数，u = 单位，d = 小数位 */
  const series = (f, u = '', d = 1) => {
    const values = col(f), v = values.filter(x => Number.isFinite(x));
    const txt = values.map(x => Number.isFinite(x) ? x.toFixed(d) + (u ? ' ' + u : '') : '—');
    return { txt: txt.length === 1 ? [txt[0], '—'] : txt, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN,
      complete: values.length > 0 && v.length === values.length, v, d, u };
  };
  const two = s => s.txt;
  const verdict = (s, ok) => s.complete ? (ok ? 'PASS' : 'FAIL') : '未测';
  const lowPair = c => {
    const a = c.j50k1 ?? c.s1_50k, b = c.j50k3 ?? c.s3_50k;
    return [a, b].every(x => x && x.samples > 0 && ['lostProbe', 'lostUsb', 'samples'].every(k => Number.isFinite(x[k]))) ? [a, b] : null;
  };

  const flood = series(c => (c.flashFlood ?? c.flashSpam)?.ms / 1000, 's', 1);
  const scope = series(c => c.flashScope?.ms / 1000, 's', 1);
  /**
   * 两份基准的字段名不同（HPM 那份叫 viewer/flood，F103 那份叫 rtt/spam，J-Scope 结果在 s1_fast/s3_fast）——
   * 这里都按"哪个有取哪个"来取，一张表实现给两边共用。
   */
  const viewer = series(c => c.viewer?.kbps ?? (c.rtt?.bytesPerSec != null ? c.rtt.bytesPerSec / 1024 : NaN), 'KB/s', 1);
  const fwd = series(c => c.fwd?.rateMB, 'MB/s', 3);
  const probeFwd = series(c => c.fwd?.probeRateMB, 'MB/s', 3);
  const recRatio = series(c => c.fwd?.record?.ratio != null ? c.fwd.record.ratio * 100
    : (c.fwd?.record?.rxBytes ? c.fwd.record.fileBytes / c.fwd.record.rxBytes * 100 : NaN), '%', 1);
  const recMB = series(c => c.fwd?.record?.fileBytes / 1048576, 'MB', 2);
  const j1 = series(c => (c.j1 ?? c.s1_fast)?.rateHz / 1000, 'kHz', 1);
  const j3 = series(c => (c.j3 ?? c.s3_fast)?.rateHz / 1000, 'kHz', 1);
  const j50 = series(c => {
    const pair = lowPair(c);
    return pair ? pair.reduce((sum, x) => sum + x.lostProbe + x.lostUsb, 0) : NaN;
  }, '个', 0);
  /**
   * 50 kHz 档的**探针跳拍率（ppm）**与 USB 丢样本。
   *
   * 🚨 口径变更（2026-10，与 hw-campaign.mjs 的 judge 保持一致）：这一行原来是"总数必须 = 0"，
   *    但真机复测（`tmp/scope-50k-repeat.mjs` 连跑 4 遍）显示：1 变量 @20µs 每遍 150040 样本、
   *    50.00 kHz、缺口 0、USB 0，**探针跳拍稳定 2~4 个（≈20 ppm）**——是采样环的固有抖动，
   *    不是回归。"恰好 0"会把整条流程交给 3 个样本。现在：探针跳拍 ≤ 100 ppm 且 **USB 丢样本 = 0**。
   */
  const j50probePpm = series(c => {
    const pair = lowPair(c);
    return pair ? pair.reduce((sum, x) => sum + x.lostProbe, 0) / pair.reduce((sum, x) => sum + x.samples, 0) * 1e6 : NaN;
  }, 'ppm', 1);
  const j50usb = series(c => {
    const pair = lowPair(c);
    return pair ? pair.reduce((sum, x) => sum + x.lostUsb, 0) : NaN;
  }, '个', 0);
  const j50samp = j50probePpm.v.length ? (cy.reduce((acc, c) => {
    const a = c.j50k1 ?? c.s1_50k, b = c.j50k3 ?? c.s3_50k;
    return acc + (a?.samples ?? 0) + (b?.samples ?? 0);
  }, 0)) : 0;
  const corrupt = series(c => c.viewer?.corrupt ?? c.rtt?.corrupt, '次', 0);
  const overflow = series(c => c.viewer?.lost ?? c.rtt?.lost, 'B', 0);
  const sp = r.spec || {};

  push(`${r.floodLabel || '烧录 flood 固件'}`, two(flood), `均 ${S(flood.avg, 2)} s`, sp.flashFloodS != null ? `≤ ${S(sp.flashFloodS)} s` : '—',
    sp.flashFloodS == null ? '—' : verdict(flood, Math.max(...flood.v) <= sp.flashFloodS));
  push('烧录 scope 固件', two(scope), `均 ${S(scope.avg, 2)} s`, sp.flashScopeS != null ? `≤ ${S(sp.flashScopeS)} s` : '—',
    sp.flashScopeS == null ? '—' : verdict(scope, Math.max(...scope.v) <= sp.flashScopeS));
  push(`RTT Viewer${r.viewerLabel || ''}`, two(viewer), `均 ${S(viewer.avg, 1)} KB/s`, sp.viewerKBps != null ? `> ${S(sp.viewerKBps)} KB/s` : '—',
    sp.viewerKBps == null ? '—' : verdict(viewer, Math.min(...viewer.v) >= sp.viewerKBps));
  push('　└ 错位读（溢出丢字节）', two(corrupt), `共 ${corrupt.v.reduce((a, b) => a + b, 0)} 次（丢 ${overflow.v.reduce((a, b) => a + b, 0)} B）`, '= 0',
    verdict(corrupt, corrupt.v.every(x => x === 0)));
  push('RTT 转发（页面 RX 计数）', two(fwd), `均 ${S(fwd.avg, 3)} MB/s`, sp.fwdMBps != null ? `> ${S(sp.fwdMBps, 3)} MB/s` : '—',
    sp.fwdMBps == null ? '—' : verdict(fwd, Math.min(...fwd.v) >= sp.fwdMBps));
  push('　└ 探针侧自报搬运', two(probeFwd), `均 ${S(probeFwd.avg, 3)} MB/s`, '（参考）', '—');
  push('转发 10 s 存盘（一致性）', two(recRatio), `均 ${S(recRatio.avg, 2)} %`, sp.recordBytesRatio != null ? `≥ ${S(sp.recordBytesRatio * 100, 1)} %` : '—',
    verdict(recRatio, recRatio.v.every(x => x >= (sp.recordBytesRatio ?? 0) * 100)));
  push('　└ 文件大小 / 积压', two(recMB),
    `积压 ${cy.map(c => { const b = c.fwd?.record?.backlogKB ?? (c.fwd?.record?.backlog != null ? c.fwd.record.backlog / 1024 : NaN); return Number.isFinite(b) ? Math.round(b) : '—'; }).join('/')} KB`,
    '（参考）', '—');
  push('J-Scope 1 变量 @2µs', two(j1), `均 ${S(j1.avg, 1)} kHz`, sp.j1kHz != null ? `≥ ${S(sp.j1kHz)} kHz` : '—',
    sp.j1kHz == null ? '—' : verdict(j1, Math.min(...j1.v) >= sp.j1kHz));
  push('J-Scope 3 变量 @2µs', two(j3), `均 ${S(j3.avg, 1)} kHz`, sp.j3kHz != null ? `≥ ${S(sp.j3kHz)} kHz` : '—',
    sp.j3kHz == null ? '—' : verdict(j3, Math.min(...j3.v) >= sp.j3kHz));
  push('低速率档丢样本（探针跳拍 ≤ 100 ppm · USB = 0）', two(j50probePpm),
    `探针跳拍 ${j50.v.reduce((a, b) => a + b, 0)} / ${j50samp} 样本 · USB ${j50usb.v.reduce((a, b) => a + b, 0)} 个`,
    '≤ 100 ppm', verdict(j50probePpm, j50usb.complete && j50probePpm.v.every(x => x <= 100) && j50usb.v.every(x => x === 0)));

  const alt = r.alt || [];
  const altFlood = alt.map(a => (a.floodMs ?? a.spamMs) / 1000);
  const altScope = alt.map(a => a.scopeMs / 1000);
  const altTxt = alt.length
    ? `flood ${altFlood.map(x => S(x)).join('/')} s · scope ${altScope.map(x => S(x)).join('/')} s`
    : '（本次未跑交替）';

  const W = [26, 13, 24, 16, 6];
  const head = ['项目', '第 1 轮', '第 2 轮', '均值 / 统计', 'spec', '判定'];
  const lines = [];
  const bar = '+'.padEnd(W[0] + 2, '-') + '+'.padEnd(W[1] + 2, '-') + '+'.padEnd(W[1] + 2, '-')
    + '+'.padEnd(W[2] + 2, '-') + '+'.padEnd(W[3] + 2, '-') + '+'.padEnd(W[4] + 2, '-') + '+';
  const row = (a, b, c, d, e2, f) => '| ' + pad(a, W[0]) + ' | ' + pad(b, W[1]) + ' | ' + pad(c, W[1]) + ' | '
    + pad(d, W[2]) + ' | ' + pad(e2, W[3]) + ' | ' + pad(f, W[4]) + ' |';

  lines.push('');
  lines.push(`================ ${r.boardLabel || r.board || r.chip || '真机'} 基准小结 ================`);
  lines.push(`spec 口径：速率类 = 首跑实测均值 × 80% · 耗时类 = 实测最坏值 + 15% · 正确性类钉死`);
  lines.push(bar);
  lines.push(row(head[0], head[1], head[2], head[3], head[4], head[5]));
  lines.push(bar);
  for (const x of rows) lines.push(row(x[0], x[1][0] ?? '—', x[1][1] ?? '—', x[2], x[3], x[4]));
  lines.push(bar);
  lines.push(`交替烧录（${alt.length} 遍）：${altTxt}`);
  const judged = rows.filter(x => x[4] === 'PASS' || x[4] === 'FAIL');
  const pass = judged.filter(x => x[4] === 'PASS').length;
  const fail = judged.filter(x => x[4] === 'FAIL').length;
  lines.push(`本表判决：${pass} 通过 / ${fail} 失败（表内 ${judged.length} 项，脚本内逐次判决更细）`
    + (r.errors?.length ? ` · 错误 ${r.errors.length} 条` : ''));
  if (r.startedAt) lines.push(`跑的时间：${new Date(r.startedAt).toLocaleString('zh-CN')}`);
  lines.push('');
  return lines.join('\n');
}

export function printSummary(r){ console.log(summaryTable(r)); }

if (process.argv[1] && /campaign-summary\.mjs$/.test(process.argv[1])){
  const p = process.argv[2] || 'tmp/hpm-campaign-result.json';
  if (!fs.existsSync(p)){ console.error(`找不到结果文件：${p}`); process.exit(1); }
  printSummary(JSON.parse(fs.readFileSync(p, 'utf8')));
}
