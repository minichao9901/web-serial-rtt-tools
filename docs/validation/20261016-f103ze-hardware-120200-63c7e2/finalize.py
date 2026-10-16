import datetime,hashlib,json,pathlib,re,shutil,subprocess
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
def read(name):return json.loads((out/name).read_text(encoding='utf-8-sig'))
restore=read('restore.json');assert restore['passed']
cdc=read('restored-cdc.json')
final=read('state-final.json');assert final['restored'] and final['lockReleased']
assert not pathlib.Path('E:/web-etm-trace-coordination/hardware.lock').exists()
debug=read('debug-stress-02.json');frames=read('frame-web-02.json');swo=read('swo-01/results.json')
assert debug['pass']==82 and debug['fail']==0 and frames['pass']==19 and frames['fail']==0 and swo['passed']
seq=read('rtt-seq-72-results.json');scope=read('scope72.json');pins=read('pe6-timed/result.json');backup=read('backup.json')
assert len(seq)==3 and all(all(r[k]==0 for k in ['missing','extra','bad','rewound','jumps']) for r in seq)
run=read('run.json');run.update(status='completed-with-findings',validationResult='partial',hardwareTest='partial',endedAt=datetime.datetime.now().astimezone().isoformat(),originalFirmwareRestored=True,restoreSha256=restore['sha256'],restoredCdcVerified=cdc['passed'],probeLockReleased=True,issues=['A01: full flow 60 MHz intermittently falls to 45 MHz','A02: PE6 level changes do not reach any Kingst channel; ETM decode blocked','A03: initial RTT sequence test reported one malformed record; raw-capture repeat clean','A04: restored firmware runs at 48 MHz with heartbeat; Windows COM34 configure returns device error 31'])
(out/'run.json').write_text(json.dumps(run,ensure_ascii=False,indent=2),encoding='utf8')
inputs=[]
for path in sorted((root/'app').rglob('*')):
    if path.is_file() and path.suffix in ('.js','.css','.html','.json'):inputs.append(path)
inputs += [root/'Makefile',root/'index.html',root/'tools/selftest/dbg-hw-stress.mjs',root/'tools/selftest/dbg-frame-gdb.py',root/'tools/selftest/dbg-frame-hw-runner.mjs',root/'tools/selftest/hw-campaign.mjs',root/'tools/selftest/probe-hid-diag.py']
manifest=[dict(path=str(p.relative_to(root)).replace('\\','/'),sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in inputs]
(out/'source-inputs.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
binaries={
'debug.elf':root/'tools/target-firmware/stm32f103_dbgstress/build/fw.elf',
'debug-build-info.json':root/'tools/target-firmware/stm32f103_dbgstress/build/build-info.json',
'fault.elf':root/'tools/target-firmware/stm32f103ze_fault/build/fw.elf',
'scope-72.elf':root/'tools/target-firmware/stm32f103_scope/build-72mhz/fw.elf',
'scope-96.elf':root/'tools/target-firmware/stm32f103_scope/build/fw.elf',
'rtt-96.elf':root/'tools/target-firmware/stm32f103_rtt_speed/build-ze/fw.elf',
'cdc-etm-48.elf':root/'bridge/etm/backend/firmware/stm32f103_cdc_trace/fw-ze.elf',
'swo-ze-24.elf':root/'docs/validation/20261016-f103ze-acceptance-112445-5b3aac/swo-ze/fw.elf'}
(out/'inputs').mkdir(exist_ok=True)
for name,path in binaries.items():shutil.copy2(path,out/'inputs'/name)
jobs=[]
for path in sorted(out.glob('job-*.json')):
    if path.name.endswith('.result.json'):continue
    item=json.loads(path.read_text(encoding='utf8'));result=path.with_suffix('.result.json')
    jobs.append(dict(id=path.stem,**item,result=json.loads(result.read_text(encoding='utf8')) if result.exists() else {'stop':True}))
(out/'jobs.json').write_text(json.dumps(jobs,ensure_ascii=False,indent=2),encoding='utf8')
subprocess.run(['git','diff','--binary','--output='+str(out/'final-worktree.patch')],cwd=root,check=True)
subprocess.run(['git','status','--short'],cwd=root,stdout=(out/'status-after.txt').open('wb'),check=True)
campaign=read('campaign-second-failure.json');cycle=campaign['cycles'][0]
scope_rows='\n'.join(f"| {r['requestedUs']} µs | {r['clockBeforeHz']/1e6:g} MHz | {r['stable']['probeHz']/1000:.3f} kHz | {r['stable']['skipped']} | {r['stable']['usb']} | {r['bad']} |" for r in scope['rows'])
commands='\n'.join(f"| {j['id']} | {j['result'].get('exitCode','清理退出')} | `{json.dumps(j.get('command',[]),ensure_ascii=False)}` |" for j in jobs)
report=f'''# F103ZE 实板验收记录

本轮结论：**部分通过，不能判为整板全通过。** GDB、网页调试、SWO、故障诊断与额定频率采样完成；默认 full 流程的 60 MHz 稳定性未通过，ETM 因 D3/CH4 信号路径缺失未能解码。

## 版本、环境与原固件

- Validation-Run-ID: {run['runId']}
- Tested-Revision: pre-commit-worktree
- Tested-Base: {run['testedBase']}
- Tested-Dirty: true
- Related-Revision: akaLinkPro={run['firmwareRevision']}（协议源码参照；没有把该 SHA 当作探针已烧录镜像指纹）
- Validation-Result: partial
- Hardware-Test: partial
- Validation-Cwd: {root}
- Validation-Script-Fullpath: {out/'owner.py'}
- Validation-Command: python -u docs/validation/{out.name}/owner.py；串行任务及环境参数完整保存在 jobs.json。
- 主机：Windows；Node 24.13.1、Python 3.13、Chrome 155；OpenOCD 0.12；ARM GDB 10.2.90.20210621。
- 实板：DPIDR 0x1BA01477，DEV_ID 0x414（完整值 0x10036414），Flash 512 KiB，Cortex-M3；探针 VID:PID=0D28:0204，串口 COM43；目标自身 USB CDC 为 COM34。
- 原 Flash 连续读两份各 524288 字节并逐字节相同，SHA256 `{backup['sha256']}`；选项字节另行备份，没有执行解锁或写选项字节。
- 原固件全部 Flash 装载段与打包的 F103ZE CDC/ETM 示例 ELF 一致，20168 字节；其余 Flash 内容也完整保存，见 original-identification.json。

## 各项真实结果

| 项目 | 结果 | 证据及边界 |
| --- | --- | --- |
| 默认 make full_flow_f103ze | **失败** | 两次正式尝试均在 RTT 转发实际降到 45 MHz 时被原 60 MHz 门槛阻止；没有降低门槛。第二次完成一轮主要功能，第二轮转发失败。 |
| 独立交替烧录 | 通过 | 5 轮狂发↔Scope，共 10 次；见 alternating.json。用于补齐 full 失败后没有执行到的烧录项，不替代 full 通过。 |
| RTT Viewer | 通过速率门槛 | 第二次功能轮 {cycle['rtt']['bytesPerSec']/1024:.1f} KiB/s，门槛 300 KiB/s；高速显示自动暂停是既有策略，收数继续。 |
| RTT 转发与记录 | 功能通过，稳定性另列 | 一轮 60 MHz 下约 {cycle['fwd']['rateMB']:.2f} MiB/s；10.2 秒落盘 30912512 字节，独立检查全部字节符合周期文本，文件/RX 比 99.72%；周期文本不能排除整周期丢失。 |
| 网页调试压力 | **82/82 通过** | 软件/硬件断点、20 步源码序列、间接调用、逐层返回、复位、位域、内存 FAULT 后真实自愈、DWT 观察点、60 次停走和槽位清理；见 debug-stress-02.json。 |
| ARM GDB | **通过** | 原生 OpenOCD/GDB 连接、硬件断点、寄存器、内存、backtrace、stepi、next、finish、detach；7 类栈帧/局部变量 oracle 与目标代码绑定并验证。 |
| 网页/GDB 严格对照 | **19 项、200 轮通过** | 递归、叶函数、重名作用域、寄存器参数迁移、调用前后；200 轮递归切帧变量一致、无栈/寄存器意外修改、无比较器泄漏、无隐藏重试或意外复位；见 frame-web-02.json。 |
| SWO | **两组通过** | ZE 容量、CPU/Trace 24 MHz、1 Mbaud；分别 5130/2547 个 PC，全部映射源码，GNU 定位逐组去重 150/136 个 PC 一致；无接收错误、溢出、解析错误、缺口；第一组 4989 个阶段/PC 对照零不符。配置和接收器恢复通过。 |
| Cortex-M3 故障诊断 | **8/8 通过** | UDF、除零、精确总线、未对齐、MSP/PSP、对齐填充、处理器序言回溯、重复捕获；现场只读性与 DEMCR 恢复通过，fault-diag 内含截图。 |
| 72 MHz 额定采样 | **数据正确性通过** | 三档各 5 秒，实际 SWD 45 MHz；波形/计数检查正确、USB 丢包和读错误为零；高采样档仍有探针跳拍，详见下表。 |
| 72 MHz 带序号 RTT | **复测三轮通过，首测异常保留** | 复测总计 {sum(r['bytes'] for r in seq)} 字节、{sum(r['records'] for r in seq)} 条完整记录；跳号、重复、坏记录均零，探针 drained 与主机字节相等，保存了三个原始 BIN。首个旧诊断脚本首轮报 1 条格式异常，不能抹掉，见 A03。 |
| ETM Trace | **未通过** | 生产工具箱 JS + 真实 USB 字节桥 + 实际 EtmTarget/Kingst，ELF 20168 字节核验通过，复位至起点和 ETM/TPIU 配置回读成功；1/10 ms 波形均 CH4 恒低，TPIU 相位无候选。没有获得本轮有效解码记录，Timeline/源码/导出未验收。 |

72 MHz 采样细节：

| 请求周期 | 实际 SWD | 探针产出率 | 探针跳拍 | USB 丢包 | 内容错误 |
| --- | --- | --- | --- | --- | --- |
{scope_rows}

2 µs 档约 1.60% 跳拍、3 µs 档约 28 ppm、20 µs/50 kHz 档零跳拍；“内容正确/USB无丢包”不表示所有高速样本均被产生。原默认 96 MHz 快档也观察到探针及 USB 丢样，原日志保留，不宣称所有档位无损。

## 遗留问题与定位

### A01：60 MHz RTT 档间歇性降档，full 无法稳定通过

页面参数和 HID CONFIG 返回均确认请求 60 MHz；独立探针状态返回能够为 60 MHz，也会在读错误后落到 45 MHz。固件当前源码有启动及错误后的降档逻辑。已证实实际降档，不足以据此判定为网页配置错误，也没有在本轮锁定底层根因。见 clock-diag.json、job-02-full.log、job-04-full.log。额定 72 MHz/45 MHz 补测通过不能替代原 96 MHz/60 MHz 基准。

### A02：PE6/CH4 信号路径没有到达采集器，阻止 ETM

两次 ETM 原始波形中 TRACECLK 约 24.0014 MHz，CH1～3 有数千/数万次跳变，CH4 为 0 次；0.10～0.90 五个取样位置均无同步候选，见 etm-wave-diagnose.json。KingstVIS 界面确认 CH0～15 全部启用，截图 kingst-channels.png。

为隔离解码器配置，暂时关闭 Trace 引脚门控，使用 PE6 弱上拉/下拉输入，芯片 IDR 的 20 次高/20 次低读回全部正确。持续 OpenOCD TCL 控制确保电平变化发生在 1.2 秒真实采集的 {pins['overlapWindow'][0]:.3f}～{pins['overlapWindow'][1]:.3f} 秒内，但 CH0～15 均未见对应跳变。见 pe6-timed/result.json 与 capture.kvdat。GPIO/RCC/DBG 设置已恢复；结果指向 PE6 至采集器的信号路径，需要现场检查具体接点、线缆与输入。仅凭这些证据不能区分哪一端接触/引脚号错误或输入硬件问题。

用户已收到检查 PE6→CH4 与共地的提示；本轮没有收到接线复查结果。接线恢复后应重新备份核验、烧匹配 48/24 MHz 固件，重跑复位/不复位/停止重采/解码与浏览导出矩阵。初始 ETM 错误波形保存在 etm-records，不能用旧记录当本轮通过。

### A03：第一次带序号 RTT 测试报告 1 条格式异常

job-21-rtt72-integrity.log 的首轮记录 1 条 bad、零跳号/重复/回退，后两轮 bad 为 0。原脚本没有保存该轮原始字节，因此不能把它断言为启动残留或实际传输损坏。随后改为保留原始输入重新跑三轮，全部 bad/missing/extra/rewound/jumps 为 0，见 rtt-seq-72-results.json 和三个 rtt-seq-72-round-*.bin。首轮异常仍作为切换/启动期后续复现项。

### A04：恢复后板载 USB CDC 需要重新枚举复测

完整 Flash 和选项字节恢复核验通过，恢复后的 SWD 只读检查显示 CPU 在运行、g_clock_err=0、g_sysclk_hz=48000000、uwTick 在 300 ms 内正常增长；没有因该检查再暂停/复位目标。见 final-health.log。Windows PnP 的 COM34 状态为 OK，但实际配置串口失败，设备错误 31；没有发送 PING/INFO/ECHO，也没有将此项写为通过。见 restored-cdc.json。一次只针对目标 USB 的运行时 reset 请求返回 Entity not found，没有生效，也未更改驱动或系统配置。

已经提示用户重新插拔目标板自身 USB 后再复测。测试前未建立目标 CDC 应答基线，因此不能证明该现象是否本轮引入；已证明固件字节一致和 CPU 正常运行。此项与探针的 COM43 数据通路验收分开记录。

## 本轮修改、工具限制与执行过程

- 唯一新增业务仓库测试修改：dbg-hw-stress.mjs 不再要求 FAULT 文案必须包含旧承诺“不用重连”，改验错误说明含故障类型与地址；紧接着的真实内存读取和 faultHeals 计数验收保留。首次为 81/82，修正后实板复验 82/82；没有为适配测试改弱生产错误提示。
- 所有硬件操作在一个 PID/ownershipToken 租约中串行；旧锁 PID 36460 已不存在，确认无实际硬件工作进程后归档，未停止他人服务。
- 独立测试浏览器仅带当前探针的既有授权和当前 COM43 实例，未改日常浏览器或全局设置。make 的 page-prep 用已预备的同等本地服务/浏览器替代，以免旧脚本改写其它测试 profile 或停止端口持有者。
- 最早 job-01 因我先发布任务、浏览器尚未就绪而失败，当时未进入认板/烧录；环境就绪后正式尝试的硬件失败另行保留。
- 默认 GDB 无 Python；gdb-py 初次缺编码库而失败。仅在本轮子进程使用[官方 Python 2.7.18 源码标准库](https://www.python.org/downloads/release/python-2718/)，下载核对官方 MD5 并保存 SHA256，没有全局安装。原生 GDB 验收仍有缺少 gdb Python 包/unwinder hook 的环境警告；实际原生 CFI、7 类检查点及 200 轮网页对照通过，不把工具预检当硬件通过。可选额外 GDB Python 模块源码下载未用于验收，已取消。
- ETM SWD 使用生产 JS 驱动经原始 USB 字节桥，实际采集/配置均为真设备；本轮未完成浏览器内 ETM WebUSB 的端到端采集与分析。
- 未操作 SPI/I2C/NOR/屏幕等没有本轮对应外接负载的专项，未做实际断电/拔插；没有据 F103ZE 结果宣称其它芯片或 H01～H04 设计修改已全部验收。

## 恢复与证据

原 Flash 全部恢复并独立回读 524288 字节，与备份逐字节相同，SHA256 `{restore['sha256']}`；选项字节逐字节未变。恢复原 DEMCR 后从原 Flash 启动，48 MHz 时钟、零时钟错误和持续心跳经 SWD 读回确认；USB CDC 应答未通过，见 A04。

本轮锁已释放，本轮 OpenOCD/USB桥/ETM服务/测试浏览器清理情况见 cleanup.json。没有重烧探针、写选项字节、提交、推送或发布。原有未提交修改保留。完整命令/环境/返回码：jobs.json；源码指纹：source-inputs.json；重要 ELF：inputs；报告与原始证据的 SHA256：SHA256SUMS.txt。证据目录是 {out}，不会覆盖前次预检报告。

## 命令与返回码

统一工作目录为 {root}，逐项环境变量和时间见 jobs.json。ETM 包装进程正常退出不代表其内部验收通过，etm-audit-exit.json / etm-host-reset-exit.json 均为失败。

| 任务 | 返回码 | 命令 |
| --- | --- | --- |
{commands}
'''
(out/'report.md').write_text(report,encoding='utf8')
hashes=[]
for p in sorted(out.rglob('*')):
    if p.is_file() and p.name!='SHA256SUMS.txt':hashes.append(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(out).as_posix())
(out/'SHA256SUMS.txt').write_text('\n'.join(hashes)+'\n',encoding='utf8')
print(json.dumps(dict(report=str(out/'report.md'),reportSha256=hashlib.sha256((out/'report.md').read_bytes()).hexdigest(),validationResult='partial',restorePassed=True,hardwareIssues=run['issues']),ensure_ascii=False))
