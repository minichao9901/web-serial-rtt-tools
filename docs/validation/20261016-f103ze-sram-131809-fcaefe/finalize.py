import csv,datetime,hashlib,json,pathlib,statistics
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
def read(p):return json.loads((out/p).read_text(encoding='utf-8-sig'))
first=read('sram-web.json');repeat=read('repeat-20mhz/sram-web.json');final=read('usb-reenumerate.json');cdc=read('restored-cdc.json')
assert first['completed'] and repeat['completed'] and not first['errors'] and not repeat['errors']
assert read('restore.json')['passed'] and read('repeat-20mhz/restore.json')['passed'] and final['passed'] and cdc['passed']
assert not pathlib.Path('E:/web-etm-trace-coordination/hardware.lock').exists()
rows=[dict(batch=name,case=i+1,**r) for name,data in [('sweep',first),('repeat',repeat)] for i,r in enumerate(data['cases'])]
fixed=[r['result'] for r in repeat['cases'] if r['requestedKhz']==20000];auto=[r['result'] for r in rows if r['requestedKhz']==0]
assert len(fixed)==3 and all(r and r['verified'] for r in fixed) and len(auto)==4 and all(r['verified'] for r in auto)
summary=dict(cases=len(rows),verifiedCases=sum(bool(r['result']) for r in rows),failedFixedClocks=[r['requestedKhz'] for r in rows if r['error']],fixed20ReadMean=statistics.mean(r['readRate'] for r in fixed),fixed20WriteMean=statistics.mean(r['writeRate'] for r in fixed),fixed20ReadRange=[min(r['readRate'] for r in fixed),max(r['readRate'] for r in fixed)],fixed20WriteRange=[min(r['writeRate'] for r in fixed),max(r['writeRate'] for r in fixed)],autoChoicesKhz=[r['clockKhz'] for r in auto],ramRestored=True,architecturalRegistersPreservedDuringTest=True,originalProgramRestartedAtEnd=True,flashSha256=final['flashSha256'],usbPassed=cdc['passed'])
(out/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
with (out/'measurements.csv').open('w',newline='',encoding='utf-8-sig') as f:
    writer=csv.writer(f);writer.writerow(['batch','case','requested_kHz','actual_kHz','bytes','passes','read_MB_s','write_MB_s','transport','verified','error'])
    for r in rows:
        m=r['result'] or {};writer.writerow([r['batch'],r['case'],r['requestedKhz'],m.get('clockKhz'),m.get('size'),m.get('passes'),m.get('readRate'),m.get('writeRate'),m.get('transport'),m.get('verified',False),r['error']])
inputs=['app/flash/view.js','app/flash/sram-bench.js','app/flash/sram-transfer.js','app/core/chips.js','app/rtt/dap-webusb.js','app/core/probe-manager.js','index.html']
(out/'source-inputs.json').write_text(json.dumps([dict(path=p,sha256=hashlib.sha256((root/p).read_bytes()).hexdigest()) for p in inputs],indent=2),encoding='utf8')
run=read('run.json');run.update(endedAt=datetime.datetime.now().astimezone().isoformat(),experimentCompleted=True,validationResult='partial',hardwareTest='partial',verifiedCases=summary['verifiedCases'],cases=summary['cases'],ramRestored=True,originalProgramRestarted=True,flashUnchanged=True,productionSourceChanges=False)
(out/'run.json').write_text(json.dumps(run,ensure_ascii=False,indent=2),encoding='utf8')
table='\n'.join('| '+('自动' if r['requestedKhz']==0 else str(r['requestedKhz']/1000).rstrip('0').rstrip('.'))+' | '+(f"{r['result']['clockKhz']/1000:g} MHz | {r['result']['readRate']:.3f} | {r['result']['writeRate']:.3f} | 通过" if r['result'] else '— | — | — | '+('协议错误' if r['requestedKhz']==36000 else 'ACK 异常'))+' |' for r in first['cases'])
repeatTable='\n'.join(f"| {i+1} | {'自动' if r['requestedKhz']==0 else '固定20'} | {r['result']['clockKhz']/1000:g} MHz | {r['result']['readRate']:.3f} | {r['result']['writeRate']:.3f} |" for i,r in enumerate(repeat['cases']))
report=f'''# F103ZE 烧录页面 SRAM 测速实验

**实验已完成。固定 20 MHz 三次复测全部校验通过，平均读 {summary['fixed20ReadMean']:.3f} MB/s、写 {summary['fixed20WriteMean']:.3f} MB/s；较高档位存在间歇性协议错误。** 自动四次均校验通过，实际选到 20/45/45/20 MHz。最终原 RAM 已恢复校验，原程序重新启动，Flash 字节未变，USB 应答正常。

## 元数据与实际操作

- Validation-Run-ID: {out.name}
- Tested-Revision: pre-commit-worktree
- Tested-Base: {run['testedBase']}
- Tested-Dirty: true
- Validation-Result: partial（14 组中 11 组完整校验通过；显式 36/45/60 MHz 首扫各失败一组）
- Hardware-Test: partial
- Validation-Cwd: {root}
- Validation-Command: python -u docs/validation/{out.name}/runner.py
- Validation-Command: python -u docs/validation/{out.name}/runner-repeat.py
- Validation-Script-Fullpath: {out/'runner.py'}
- 实际入口：真实 Chrome 页面 `FlashView.benchmarkSram()`，WebUSB、CMSIS-DAP atomic-4；未改实现、未注入假探针、未绕过页面地址校验。
- 板卡：F103ZE，DEV_ID 0x414、Flash 容量 512 KiB、实际 SRAM 64 KiB；目标固件仍为 48 MHz 的 CDC 示例。最终 INFO 也确认 48000000Hz/clk_err=0。
- 测试地址 `0x20000000`，每组 20 KiB，每次测速 3 轮不同图案写入并独立回读校验，再 3 轮计时读取并校验。读写速率按 **1 MB=1000000 字节**，不是 MiB/s，也不是 SWD 理论线速；写后验证读取不计入写入时间。

## 首轮逐档结果

| 请求 SWD MHz | 实际通过档位 | 读 MB/s | 写 MB/s | 结果 |
| --- | --- | --- | --- | --- |
{table}

36 MHz 响应中的地址设置状态为协议错误，示例头 `02 05 01 08 06 78 00 01`；45/60 MHz 有 ACK 0 等异常。页面明确报失败，未填入虚构读写速率，也未把失败档记为成功。每组之后重新打开低速控制路径，CPU 仍保持暂停，17 个体系寄存器与原快照一致。

## 重复测量

| 组 | 请求方式 | 实际通过档位 | 读 MB/s | 写 MB/s |
| --- | --- | --- | --- | --- |
{repeatTable}

固定 20 MHz 的三次读速范围 {summary['fixed20ReadRange'][0]:.3f}～{summary['fixed20ReadRange'][1]:.3f} MB/s，写速 {summary['fixed20WriteRange'][0]:.3f}～{summary['fixed20WriteRange'][1]:.3f} MB/s。首扫固定 20 MHz 曾测到约 0.758 MB/s 的读速，不能只报最好的一次；20 KiB/3 轮的短测量包含 USB、浏览器和系统调度开销，存在波动。

自动档总共四次：20、45、45、20 MHz。两次选到 45 MHz 的结果均经过完整图案校验，其中一组读 1.840 MB/s、写 1.845 MB/s；首扫显式 45 MHz 却失败。因此不能断言“36 MHz 以上永远不可用”，也不能据偶尔通过宣称 45 MHz 稳定。本轮条件下固定 20 MHz 是较稳的已测档位；自动档的校验/降档行为有效。该结论只适用于当前目标 48 MHz、探针、接线和浏览器条件，不是芯片普遍上限。

## SRAM 容量与页面限制

`app/core/chips.js` 对 `stm32f103` 的通用 RAM 范围是 `0x20000000–0x20005000`，所以页面的 32/64 KiB 选项在这块 ZE 上也被地址保护拒绝；128 KiB 本就超出 ZE 的真实容量。两轮都实测这些选择在写入前被拒绝，没有绕过校验去写。

这是页面的密度适配限制，不表示 ZE 只有 20 KiB。整块 64 KiB SRAM 的两份稳定备份和恢复回读均完成，但没有把这当作页面 64 KiB 测速已通过。后续应读取 DEV_ID/容量后选择正确范围，不能直接把所有 F103 都放宽为 64 KiB。

## 现场保护、恢复与交付状态

页面已明确提示测试区会覆盖且不恢复。本轮外层保护先暂停 CPU，把完整 64 KiB SRAM 连读两次确认稳定，保存到磁盘；同时保存 17 个体系寄存器与原运行状态。所有 14 组执行前后 CPU 都暂停且寄存器一致。页面每组内部识别到原本暂停，因此不会在 RAM 仍为图案时继续运行 CPU。

首扫原 RAM SHA256 `{first['original']['ramSha256']}`；复测原 RAM SHA256 `{repeat['original']['ramSha256']}`。两轮分别在 CPU 暂停时把对应 RAM 全部写回并逐字节验证，寄存器未变，再继续原程序。两个快照之间原程序运行过，RAM 哈希不同是正常的；不宣称运行中的 RAM 永远保持快照值。

高频错误响应曾出现地址设置状态异常而后续块传输状态成功，因此仅凭失败响应不能证明后续命令没有到达目标；该组合命令错误路径值得继续审查。测试完成并恢复 RAM 后，最终另行以 SYSRESETREQ 重新启动原例程，配合已验证的 USB 重新枚举方法清理交付状态；未测试或追查 NRST。见 restart-original.py 与 usb-reenumerate.json/log。最终不是继续原 PC 的瞬间快照，而是原程序正常重新启动。

Flash 首扫、复测及最终整块回读完全一致，SHA256 `{final['flashSha256']}`；没有 Flash 写入或选项字节写入。最终 COM34 的 PING/PONG、INFO 48 MHz/零时钟错误、独立 ECHO 均通过，见 restored-cdc.json。CPU、RAM、Flash 恢复记录在两组 restore.json 中；控制资源和本轮浏览器已清理，见 cleanup.json。

截图中“CPU 保持暂停”是测速当时的真实状态，原程序在外层恢复/重启后运行。截图、原始结果和原始备份均保留。

## 页面与实现建议

1. 按 F103 实际密度识别 SRAM 范围，正确启用 ZE 的 32/64 KiB，并在操作前禁用超范围选项。
2. 明确区分“恢复运行位”和“恢复原程序现场”。当前页面会覆盖活跃 SRAM 后继续 CPU；建议默认备份/恢复，或限制已知空闲区并要求明确复位。外层实验保护没有修改成页面功能。
3. 审查高频失败时 ExecuteCommands 内 TAR 设置失败与后续块写入的执行关系；可先以只读完整校验评估档位，不能把首个错误状态当作后续写入已取消的证据。本轮已恢复 RAM并最终复位原程序，没有证明任何无关外设地址实际被写。
4. 低层 DAP 命令日志建议可折叠；正常视图突出实际时钟、速率、校验与失败原因。当前日志可追踪，但重复初始化信息较密。

本轮不修改生产源码，不降低校验门槛，不修改全局设置，不提交、推送或发布。完整 14 组数据：measurements.csv、两组 sram-web.json；执行命令/返回码：两组 execution.json；输入指纹：source-inputs.json；证据 SHA256：SHA256SUMS.txt。
'''
(out/'report.md').write_text(report,encoding='utf8')
hashes=[hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(out).as_posix() for p in sorted(out.rglob('*')) if p.is_file() and p.name!='SHA256SUMS.txt']
(out/'SHA256SUMS.txt').write_text('\n'.join(hashes)+'\n',encoding='utf8')
print(json.dumps(summary,ensure_ascii=False));print('reportSha256',hashlib.sha256((out/'report.md').read_bytes()).hexdigest())
