/** Bounded evidence, shared by fault and acquisition reports. No target I/O. */
export class DiagnosticHistory {
  constructor(limit = 128){ this.limit = limit; this.reset(); }
  reset(){ this.startedAt = new Date().toISOString(); this.events = []; this.omitted = 0; this.values = new Map(); }
  note(code, detail, level = 'info'){
    this.events.push({ at: new Date().toISOString(), code, level, detail: String(detail).slice(0, 1000) });
    if (this.events.length > this.limit){ this.events.shift(); this.omitted++; }
  }
  observe(code, value, detail, level = 'warn'){
    if (value == null) return;
    const prev = this.values.get(code);
    this.values.set(code, value);
    if (value > 0 && (prev == null || value > prev)) this.note(code, `${detail}：${value}`, level);
    else if (prev != null && value < prev) this.note('counter-reset', `${code} 计数下降／重新开始：${prev} → ${value}`);
  }
  snapshot(){ return { startedAt: this.startedAt, events: [...this.events], omitted: this.omitted }; }
}

export const finding = (confidence, text, evidence = '') => ({ confidence, text, evidence });
export const metric = (name, value, unit = '', source = '网页', note = '') => ({ name, value: value ?? null, unit, source, note });

export function makeReport(kind, title, data, history, environment = {}){
  // Copy now: the exported report cannot change while live counters advance.
  return JSON.parse(JSON.stringify({ schema: 'akalink-diagnostics/v1', kind, title,
    exportedAt: new Date().toISOString(), environment, ...data, history: history?.snapshot?.() ?? history ?? null }));
}

export const displayValue = v => v == null ? '未知／不可用' : typeof v === 'boolean' ? (v ? '是' : '否') : String(typeof v === 'object' ? JSON.stringify(v) : v);
const clean = v => displayValue(v).replace(/[|\r\n]/g, ' ');
export function reportMarkdown(r){
  const lines = [`# ${r.title}`, '', `导出时间：${r.exportedAt}`, '', `类型：${r.kind}`, '', '## 环境与配置', ''];
  for (const [k, v] of Object.entries({ ...r.environment, ...r.settings })) lines.push(`- ${clean(k)}：${clean(v)}`);
  lines.push('', '## 判断', '');
  for (const f of r.findings || []) lines.push(`- **${f.confidence}**：${clean(f.text)}${f.evidence ? `（${clean(f.evidence)}）` : ''}`);
  lines.push('', '## 计数与现场', '', '| 项目 | 数值 | 单位 | 来源／说明 |', '|---|---:|---|---|');
  for (const m of r.metrics || []) lines.push(`| ${clean(m.name)} | ${m.value == null ? '未知／不可用' : clean(m.value)} | ${clean(m.unit)} | ${clean(m.source)} ${clean(m.note)} |`);
  if (r.snapshot) lines.push('', '## 原始现场', '', '```json', JSON.stringify(r.snapshot, null, 2), '```');
  lines.push('', '## 事件（最近 128 条）', '');
  for (const e of r.history?.events || []) lines.push(`- ${e.at} [${clean(e.level)}] ${clean(e.detail)}`);
  if (r.history?.omitted) lines.push(`- 更早的 ${r.history.omitted} 条事件已从内存历史裁剪。`);
  lines.push('', '## 解释边界', '');
  for (const n of r.notes || []) lines.push(`- ${clean(n)}`);
  return lines.join('\n') + '\n';
}
