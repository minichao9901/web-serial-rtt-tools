import { esc } from '../ui/dom.js';
import { download, fileStamp } from '../core/format.js';
import { reportMarkdown, displayValue } from './report.js';

export function reportHtml(r){
  return `<div class="diag-findings">${r.findings.map(f => `<p><b>${esc(f.confidence)}</b> · ${esc(f.text)}${f.evidence ? `<small>${esc(f.evidence)}</small>` : ''}</p>`).join('')}</div>
    <dl class="diag-settings">${Object.entries(r.settings || {}).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(displayValue(v))}</dd>`).join('')}</dl>
    <table class="diag-table"><thead><tr><th>项目</th><th>数值</th><th>来源／说明</th></tr></thead><tbody>${r.metrics.map(m=>`<tr><td>${esc(m.name)}</td><td>${m.value == null ? '未知' : esc(String(m.value))} ${esc(m.unit)}</td><td>${esc(m.source)}<small>${esc(m.note)}</small></td></tr>`).join('')}</tbody></table>
    <details><summary>解释边界</summary>${r.notes.map(n=>`<p class="hint">${esc(n)}</p>`).join('')}</details>
    <details><summary>事件 · ${r.history?.events?.length || 0} 条</summary>${(r.history?.events || []).slice().reverse().map(e=>`<p class="hint">${esc(e.at)} · ${esc(e.detail)}</p>`).join('')}${r.history?.omitted ? `<p>更早 ${r.history.omitted} 条已裁剪</p>` : ''}</details>`;
}
export function exportReport(r, format){
  download(`akalink-${r.kind}-${fileStamp()}.${format === 'json' ? 'json' : 'md'}`,
    format === 'json' ? JSON.stringify(r, null, 2) : reportMarkdown(r), format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8');
}

export class QualityDrawer {
  constructor(providers, refreshers = {}){ this.providers = providers; this.refreshers=refreshers; this.current = null; }
  init(){
    this.el = document.createElement('aside'); this.el.className = 'diag-drawer'; this.el.hidden = true;
    this.el.setAttribute('aria-label', '采集质量与诊断报告');
    this.el.innerHTML = '<div class="diag-head"><b>采集质量与诊断报告</b><button class="mini" data-refresh>刷新计数</button><button class="mini" data-export="json">JSON</button><button class="mini" data-export="md">报告</button><button class="mini" data-close aria-label="关闭质量面板">×</button></div><div class="diag-body"></div>';
    document.body.append(this.el);
    for (const [kind, id] of [['scope','sc-quality'], ['rtt','c-quality']]) document.getElementById(id)?.addEventListener('click', ()=>this.open(kind));
    this.el.querySelector('[data-close]').onclick = ()=>this.close();
    this.el.querySelector('[data-refresh]').onclick = async e=>{ const b=e.currentTarget; b.disabled=true;this.refreshing=true;
      try { await this.refreshers[this.current]?.read(); } finally {this.refreshing=false; this.render();} };
    for (const b of this.el.querySelectorAll('[data-export]')) b.onclick = ()=>exportReport(this.providers[this.current](), b.dataset.export);
    document.addEventListener('keydown', e=>{ if(e.key === 'Escape' && !this.el.hidden) this.close(); });
    this.timer = setInterval(()=>{ if (!this.el.hidden){
      const tab = this.current === 'scope' ? 'tab-scope' : 'tab-rttcdc';
      if (!document.getElementById(tab)?.classList.contains('active')) this.close(); else this.render();
    } }, 1000);
  }
  open(kind){ this.current = kind; this.el.hidden = false; this.render(); this.el.querySelector('[data-close]').focus(); }
  close(){ this.el.hidden = true; document.getElementById(this.current === 'scope' ? 'sc-quality' : 'c-quality')?.focus(); }
  render(){ const body = this.el.querySelector('.diag-body'), top = body.scrollTop;
    const refresh=this.el.querySelector('[data-refresh]');
    refresh.disabled=!!this.refreshing || !this.refreshers[this.current]?.available();
    refresh.title=this.current==='scope'?'仅采集运行中刷新；停止后保留本轮快照，避免混入下一轮计数':'读取已有的 RTT 转发状态接口';
    const open=Array.from(body.querySelectorAll('details'),d=>d.open);
    body.innerHTML = reportHtml(this.providers[this.current]());
    body.querySelectorAll('details').forEach((d,i)=>{d.open=!!open[i];}); body.scrollTop = top;
  }
}
