import { finding as f, metric as m } from './report.js';

export function scopeQuality(s, now = Date.now()){
  const st = s.store, probe = s.probeMetrics;
  const historical = !s.running && !s._starting;
  const fresh = !s._qualityReplay && !!s._metricsAt && (historical || now - s._metricsAt < 5000);
  const full = fresh && !!probe && !s.metricsError;
  const legacy = !s._qualityReplay && !!s._statAt && !!s._qualityStat && (historical || now - s._statAt < 5000);
  const counter = name => full ? probe[name] : legacy ? ({usb:s._qualityStat.usbErr,errors:s._qualityStat.swdErr,yields:s._qualityStat.dapYield}[name] ?? null) : null;
  const skipped = counter('skipped', s.probeDropped), usb = counter('usb', s.usbDrop), errors = counter('errors', s.readErrors);
  const findings = [];
  if (!full) findings.push(f('证据不足', legacy ? 'STAT 提供部分计数，16 位字段可能回卷，不能计算精确跳拍率。'+(s.supportsMetrics && s.running?'可点击「刷新计数」取得完整快照。':'本次缺少完整快照，保留部分计数。') : '探针计数尚未取得、已过期或读取失败，不能据此判断采集正常。', s.metricsError || '未取得有效的完整计数'));
  if (skipped > 0) findings.push(f('已确认', '探针未赶上部分计划采样时刻。', `${skipped} 个跳过的采样时刻`));
  if (usb > 0) findings.push(f('已确认', '探针 USB 包缓冲不足或提交失败，部分样本未送出。', full?`${usb} 个样本`:`STAT 字段值 ${usb}（16 位，可能回卷）`), f('可能原因', '主机排空速度或 USB 调度跟不上；需结合序号缺口和网页状态继续定位。'));
  if (errors > 0) findings.push(f('已确认', '目标读取或流水线收尾失败。', full?`${errors} 次`:`STAT 字段值 ${errors}（16 位，可能回卷）`));
  if (s.lost > 0) findings.push(f('已确认', '接收包序号存在缺口；缺失包可能包含定义、状态或样本。', `${s.lost} 个包，不能直接换算为样本数`));
  if (st?.overrun > 0) findings.push(f('已确认', '网页采集缓冲已满，后续样本未存入波形。', `${st.overrun} 个样本`));
  if (s.decodeErr > 0 || s.stream?.resyncs > 0) findings.push(f('已确认', '接收解析或包顺序出现异常。', `解析／顺序 ${s.decodeErr || 0}，重同步 ${s.stream?.resyncs || 0}`));
  if (full && !skipped && !usb && !errors && !s.lost && !st?.overrun && !s.decodeErr && !s.stream?.resyncs && st?.count > 1)
    findings.push(f('已确认', '本次可观测计数未发现跳拍、缓冲丢样、读错或包缺口；不代表已验证目标值正确。'));
  if (!st?.count) findings.push(f('证据不足', '尚无样本，不能计算实测速率或判断波形质量。'));
  // USB drops can overlap produced (failed packet flush), and read errors can occur during pipeline flush.
  // Only calculate this rate when neither counter is nonzero; otherwise the denominator is not observable.
  const attempts = full && usb === 0 && errors === 0 ? probe.produced + probe.skipped : 0;
  return { settings: { 状态: s.state, 数据: s._qualityReplay ? '文件回放' : s.usingMock ? '模拟采集' : '真实采集', 时段: historical ? '最近一次采集（历史）' : '当前采集',
      ...(s._qualityConfig || {}), 生效后端: s.backend || '未知', 实际周期_us: s.periodActualUs || null,
      生效SWD时钟_MHz: s.backend==='swd' ? s.swdMhz || null : null,
      探针快照时间: s._metricsAt ? new Date(s._metricsAt).toISOString() : null, 计数格式: full ? '32 位原子快照' : legacy ? '部分 STAT（USB／读错为 16 位）' : '不可用' },
    metrics: [m('网页保留样本', st?.count ?? 0, '样本'), m('实测平均采样率', st?.count > 1 ? st.rate() : null, 'Hz', '探针时间戳', '不是 USB 到达速率；段内时间由锚点插值'),
      m('探针采得样本', full ? probe.produced : null, '样本', '探针'), m('探针跳拍', skipped, '采样时刻', '探针'),
      m('跳拍率', attempts > 0 && !s._qualityCounterRolled ? +(100 * probe.skipped / attempts).toFixed(4) : null, '%', '探针', '仅无 USB 丢样、无读错时：skipped / (produced + skipped)；回卷后无效'),
      m('USB 包缓冲丢样', usb, '样本', '探针'), m('目标读取失败', errors, '次', '探针'),
      m('给调试让路', counter('yields', s.probeYield), '次', '探针', '让路不等于丢样'), m('包序号缺口', s.lost ?? 0, '包'),
      m('网页缓冲溢出', st?.overrun ?? 0, '样本'), m('解析／顺序异常', s.decodeErr ?? 0, '次'), m('包解析重同步', s.stream?.resyncs ?? 0, '次')],
    findings, notes: ['这些计数分属不同阶段，不能相加作为总丢样数，也不能由零值推导零误码率。',
      '值恒定可能来自程序状态、地址／ELF 不匹配或缓存等；本面板不凭平直波形判定缓存问题。',
      '记录统计受触发、采集窗口与计数器回卷影响；32 位计数回卷时跳拍率不适用。USB 到达抖动不等于目标采样抖动。'] };
}

export function rttQuality(v, bridge, now = Date.now()){
  const st = bridge?.last, source=bridge?._statusSource;
  const fresh = !!st && source?.dev===bridge?.dev && source?.device===bridge?.dev?.device && source?.generation===bridge?._engineGen &&
    bridge?.dev?.connected && bridge?._statusAt && now - bridge._statusAt < 6000 && !bridge._statusError;
  const findings = [f('证据不足', 'RTT／CDC 是无序号、无校验的字节流，无法从收取字节数计算误码率或证明完整性。')];
  if (!fresh) findings.push(f('证据不足', '探针转发状态不可用或已过期，读错计数不能按零处理。', bridge?._statusError || '请在转发控制区刷新状态'));
  if (v.s.opts?.owner && v.s.opts.owner !== 'rtt') findings.push(f('证据不足', '当前串口由其它功能打开，不能保证这些字节来自 RTT 转发。', v.s.opts.owner));
  if (fresh && (st.rdErr || st.wrErr)) findings.push(f('已确认', '探针出现目标读取或 RdOff 写入失败。', `读 ${st.rdErr} / 写 ${st.wrErr} 次（16 位计数）`));
  if (fresh && bridge._stall >= 3) findings.push(f('可能原因', 'RTT 暂无新数据：目标暂停、未产生日志或其它读取者均可能造成搬运量不增长。', '不能仅凭此判定资源冲突'));
  if (v.suppressed) findings.push(f('已确认', '高速显示保护已生效，接收与文件记录继续，显示历史被省略。'));
  if (v.rx?.paused) findings.push(f('已确认', '文本显示已暂停，接收继续。'));
  if (v.rx?.truncated) findings.push(f('已确认', '网页显示历史达到上限，旧字节已裁剪；这不是传输丢包。'));
  if (v.rec.overflow || v.rec.error) findings.push(f('已确认', '文件记录发生溢出或写入失败，文件可能不完整。', v.rec.error?.message || String(v.rec.error || '记录缓冲溢出')));
  if (v.rec.backlog() > 4 * 1024 * 1024) findings.push(f('已确认', '文件写入积压超过 4 MiB，存储速度跟不上当前输入。'));
  return { settings: { 数据: bridge?.mock ? '模拟探针状态' : '真实通路', 串口: v.s.info || '未连接', 串口来源: v.s.opts?.owner || '未知',
      串口连接: v.s.isOpen, 转发运行: fresh ? st.running : null, 请求目标类型: bridge?.isRiscv ? 'RISC-V/JTAG' : 'ARM/SWD',
      生效SWD时钟_MHz: fresh ? st.swdMhz || null : null,
      控制块: fresh ? '0x' + st.cbAddr.toString(16) : null, 状态时间: bridge?._statusAt ? new Date(bridge._statusAt).toISOString() : null,
      文件: v.rec.name || '未记录', 记录时间戳: v.$('c-record-ts')?.checked ?? null },
    metrics: [m('网页接收', v.rxc.total, '字节', '串口累计（计数清零后）'), m('接收速率', v.rxc.rate(), 'B/s', '主机最近 1 秒'),
      m('探针搬运', fresh ? st.moved : null, '字节', '探针（每次启动清零，32 位回卷）'), m('目标读取失败', fresh ? st.rdErr : null, '次', '探针（16 位回卷）'),
      m('RdOff 写入失败', fresh ? st.wrErr : null, '次', '探针（16 位回卷）'), m('调试让路', fresh ? st.dapYield : null, '次', '探针（16 位回卷）'),
      m('保留显示历史', v.rx?.rawBytes ?? 0, '字节'), m('省略渲染', v.rx?.suppressedBytes ?? 0, '字节', '当前高速保护区间'),
      m('文件写入', v.rec.written ?? 0, '字节', '当前／最近记录（含格式化时间戳）'), m('待落盘', v.rec.backlog(), '字节')], findings,
    notes: ['网页接收与探针搬运计数起点不同，不能直接相减计算丢字节。串口接收段也不是 RTT 消息或 USB 包。',
      '高速保护会省略文本历史；完整数据需提前开启文件记录。记录积压表示尚未写入，不一定已经丢失。',
      '文件有时间戳时其字节数包含附加文本，不能与原始接收字节直接比较。'] };
}
