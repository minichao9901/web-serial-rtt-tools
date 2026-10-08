import { BUILD } from '../core/build.js';
import { DiagnosticHistory, makeReport } from './report.js';
import { scopeQuality, rttQuality } from './quality.js';
import { QualityDrawer } from './drawer.js';

/** Observe existing counters at 2 Hz; never poll hardware or touch the receive hot path. */
export function installAcquisitionDiagnostics(tools){
  const { scope, stream, hid, session } = tools;
  const scopeHistory = new DiagnosticHistory(), rttHistory = new DiagnosticHistory();
  scope.qualityHistory = scopeHistory; stream.qualityHistory = rttHistory;
  const environment = kind => ({ Web版本: BUILD, 浏览器: navigator.userAgent, 页面可见: document.visibilityState,
    探针: kind==='scope' ? scope._qualityConfig?.探针 || scope.hid?.label || '未知' : hid.dev?.label || '未知',
    探针固件: kind==='rtt' ? hid.info?.fw || '未知' : scope._qualityConfig?.探针固件 || '未知' });
  const providers = {
    scope: () => makeReport('scope', 'J-Scope 采集质量报告', scopeQuality(scope), scopeHistory, environment('scope')),
    rtt: () => makeReport('rtt', 'RTT 转发质量报告', rttQuality(stream, hid), rttHistory, environment('rtt')),
  };
  const drawer = new QualityDrawer(providers, {
    scope: { available: ()=>scope.running && scope.supportsMetrics && !!scope.hid && !scope._qualityReplay,
      read: async()=>{ try{ await scope.readScopeMetrics({fresh:true}); }
        catch(e){scope.metricsError=e.message;scopeHistory.note('metrics-error',e.message,'warn');} } },
    rtt: { available: ()=>hid.dev.connected && !hid._starting && !hid._stopPromise, read: ()=>hid.refresh() },
  }); drawer.init();
  session.on('open', ({info, opts}) => rttHistory.note('serial-open', `打开串口 ${info}，来源 ${opts.owner || '未知'}`));
  session.on('close', ({unexpected}) => rttHistory.note('serial-close', unexpected ? '串口意外断开' : '串口关闭', unexpected ? 'error' : 'info'));
  session.on('error', e => rttHistory.note('serial-error', e.message || e, 'error'));
  document.getElementById('c-statclear')?.addEventListener('click', () => rttHistory.note('counter-reset', '网页接收计数已清零；探针搬运计数未清零'));
  document.addEventListener('visibilitychange', () => {
    scopeHistory.note('visibility', `页面 ${document.visibilityState}`);
    rttHistory.note('visibility', `页面 ${document.visibilityState}`);
  });
  let scopeState, rttState;
  const tick = () => {
    const a = scope.running ? '采集中' : scope._starting ? '启动中' : scope.state;
    if (a !== scopeState){ scopeState = a; scopeHistory.note('capture-state', a || '空闲'); }
    const counts = { gap: scope.lost, decode: scope.decodeErr, resync: scope.stream?.resyncs, overrun: scope.store?.overrun };
    for (const [k,v] of Object.entries(counts)) scopeHistory.observe(k, v, {gap:'包序号缺口（包）',decode:'解析／顺序异常（次）',resync:'解析重同步（次）',overrun:'网页缓冲溢出（样本）'}[k]);
    if (scope.probeMetrics) for (const k of ['produced','skipped','usb','errors']) {
      const prev = scopeHistory.values.get(k), value = scope.probeMetrics[k];
      if (prev != null && value < prev) scope._qualityCounterRolled = true;
      if(k==='produced')scopeHistory.values.set(k,value);
      else scopeHistory.observe(k, value, {skipped:'探针跳拍（采样时刻）',usb:'USB 缓冲丢样（样本）',errors:'目标读错（次）'}[k]);
    }
    const b = `${stream.suppressed}:${stream.rx?.paused}:${stream.rx?.truncated}:${stream.rec.active}:${stream.rec.draining}:${stream.rec.overflow}:${stream.rec.error}`;
    if (b !== rttState){ rttState = b; rttHistory.note('display-record', `高速保护 ${!!stream.suppressed}，显示暂停 ${!!stream.rx?.paused}，历史裁剪 ${!!stream.rx?.truncated}，记录 ${stream.rec.active ? '开启' : stream.rec.draining ? '正在落盘' : '关闭'}，记录溢出 ${!!stream.rec.overflow}，写盘错误 ${stream.rec.error || '无'}`); }
    rttHistory.observe('record-backlog',stream.rec.backlog()>4*1024*1024 ? 1:0,'文件写入积压超过 4 MiB');
    if (hid._statusAt && Date.now() - hid._statusAt < 6000 && hid._statusSource?.dev===hid.dev && hid._statusSource?.generation===hid._engineGen && !hid._statusError){
      rttHistory.observe('read-error', hid.last?.rdErr, '目标读错（16 位计数）');
      rttHistory.observe('rdoff-error', hid.last?.wrErr, 'RdOff 写错（16 位计数）');
    }
  };
  tick(); setInterval(tick, 500);
  tools.diagnostics = { report: kind => { tick(); return providers[kind](); }, drawer };
}
