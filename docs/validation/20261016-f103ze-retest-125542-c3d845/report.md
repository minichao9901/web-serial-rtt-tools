# F103ZE 接线纠正后的复测

**ETM 已通过，板载 USB CDC 已恢复正常；整板结论仍为部分通过。** 默认 full 的 60 MHz 稳定性未通过，NRST 目标硬复位未确认，用户选择插拔电后不再追查该项。上一轮的首轮 RTT 格式异常仍留待复现。

## 版本与本轮范围

- Validation-Run-ID: 20261016-f103ze-retest-125542-c3d845
- Tested-Revision: pre-commit-worktree
- Tested-Base: fb06da2348543b75db5fbc237dd4d3b0ffe1d655
- Tested-Dirty: true
- Validation-Result: partial
- Hardware-Test: partial
- Validation-Cwd: E:\web-serial-rtt-tools
- Validation-Script-Fullpath: E:\web-serial-rtt-tools\docs\validation\20261016-f103ze-retest-125542-c3d845\owner.py
- Validation-Command: python -u docs/validation/20261016-f103ze-retest-125542-c3d845/owner.py；完整串行任务/环境/返回码在 jobs.json。
- 触发：用户确认 CH4 插错并已纠正，授权使用网页 NRST；之后选择直接插拔目标电源，NRST 后续测试停止。
- 本轮重新备份两次 512 KiB Flash，均与上一轮备份一致：`61a097c84c8ca7cae573a950618de6009083048755b5c26def16f6cc351a354d`。没有写选项字节或更新探针固件。
- 本轮未修改生产源码；与上一轮比较的 191 个受测输入指纹全部一致，见 tested-input-continuity.json。上一轮 GDB、200 轮栈帧、SWO、8 类故障诊断、额定频率采样和序号复测结果仍见[独立报告](../20261016-f103ze-hardware-120200-63c7e2/report.md)，未冒称本轮重跑。

## ETM：真实采集矩阵

F103ZE，CPU/HCLK 48 MHz，引脚 TRACECLK 24 MHz，HSE 8 MHz；Kingst 500 MSa/s，CH0～4=PE2～PE6，半周期相位 0.25，分支广播关闭。使用生产 WebUsbDapProbe / EtmTarget 与真实 USB 字节桥操作目标及 Kingst，无 Flash 写入。矩阵 11 项全部通过：

| 场景 | 恢复的指令路径数量 | 结果 |
| --- | --- | --- |
| reset-1ms | 8495 | 通过 |
| reset-2ms | 26725 | 通过 |
| reset-5ms | 81426 | 通过 |
| reset-10ms | 172601 | 通过 |
| run-to-10ms | 174819 | 通过 |
| queued-stop | 取消/等待/恢复检查 | 通过 |
| armed-stop | 取消/等待/恢复检查 | 通过 |
| reset-after-stop | 81425 | 通过 |
| one-shot-entry-without-reset | 取消/等待/恢复检查 | 通过 |
| cancel-entry-wait | 取消/等待/恢复检查 | 通过 |
| explicit-recovery-software-fault-latch | 取消/等待/恢复检查 | 通过 |

另以实际生产复位写和断点恢复连续完成三轮 10 ms，指令路径数量为 172600, 172600, 172600，每轮仅一次复位，断点恢复和运行至循环函数通过。所有成功记录 packetIssues、overflowPackets、unprocessedBytes、unknownSourceBytes 为 0。详细记录 ID/质量字段见 hardware-matrix.json、host-hardware-result.json；原始 CSV/KVDAT 与解码结果在 etm-records。

以上为本轮新记录，上一轮 CH4 恒低的错误波形仍保留。接线纠正解决了 A02，无需修改解码器。

## 浏览器内的真正端到端验收

使用本轮独立 Chrome、同源集成 iframe、实际 WebUSB 和主页面 ProbeManager，依次通过 ELF 文件载入、配套源码文件兼容选择、连接/识别、HSE 回读、真实断点、联动 1 ms 采集、分析及探针交接。源码是实际 DWARF 引用文件的内容，逐文件 SHA256 在 browser-etm-03/result.json；没有测试原生 Windows 目录选择器。

- 新记录：`capture-2bcf2a43afbb45b08321583fd9dfd1d8`；8475 条指令路径，全部对应 DWARF 源码行；无包错误、overflow、未知执行状态、未处理/未知源字节。
- 执行流、调用统计、热点、ETMv3 包、可信区段、火焰图六个视图检查通过并保存 PNG；函数轨迹、选中指令和配套源码可见。
- 记录包、CSV、源码 C 导出均成功。记录包 770453 字节，包含原始采集、ELF、源码快照与 KVDAT，ELF 与目标匹配；CSV 校验 8480 行且各行列数一致。
- 在真实主页面切到调试器并连接后，ETM probe 关闭、ETM 租约释放、调试器连接成功；随后运行目标并断开。见 handoff 字段。
- 页面未捕获异常为 0。完整结果/截图/可导入文件在 browser-etm-03。

捕获边界仍有初始同步缺口；首条恢复指令不保证等于所选断点。记录横轴为执行序号、不是耗时；不把恢复路径数当作完整程序覆盖率或所有调用祖先均已确认。

### 失败记录与复测解释

browser-etm 首次脚本没有选择配套源码，采集成功后因源码文本前置条件断言失败；补齐真实源码选择流程后重跑。browser-etm-02 完成采集、六视图和导出，但交接遇到 transportFault，下一次 full 认板也超时；此时用户在本轮中报告插拔电，未记录精确电源边沿时间，不能仅凭时间接近断言因果。保留这两个结果。

只重启本轮独立测试浏览器，使用原生 OpenOCD 读回 ID/48 MHz/递增心跳，再以相同生产源码重跑，browser-etm-03 全部通过。没有删除传输故障保护或把失败覆盖为成功。

## 仍未通过的 full 与 NRST

最终稳定供电状态下再次执行 `make -o page-prep full_flow_f103ze ARGS=--com=COM43`：认板、构建、烧录和 RTT Viewer 通过；转发请求 60 MHz、实际返回 45 MHz，按原门槛失败，见 job-09-full.log、campaign-final.json。没有降低门槛。`page-prep` 使用已预备的同等本地服务与独立浏览器替代，避免旧辅助脚本改其它 profile；不是逐字未加参数的 make 命令。

NRST 通过真实网页 FlashView.resetTarget / pulseTargetReset / SWJ_Pins 发出，探针报告能力 7、PA27 可配置、双路复位、当前开漏。清 F103 RCC_CSR 复位标志后发脉冲，PINRSTF 未置位、心跳未重新计数；加 VC_CORERESET 后也未停到复位向量。见 nrst-web.json、nrst-catch.json。因此只能确认探针输出命令，不能确认目标实际硬复位。源代码 PIN_nRESET_IN 读的是输出锁存值，不能替代目标证据。用户选择直接插拔电，A05 记为未确认/本轮停止追查；未更改探针固件或电气模式。

## 原固件恢复与 USB 应答

原 Flash 已恢复并完整回读 524288 字节，选项字节逐字节未变；CPU 运行、时钟 48 MHz、时钟错误 0，心跳递增。恢复后 COM34 再次出现 Windows 设备错误 31，错误保存在 restored-cdc-before-reenum.json；本轮开始时冷启动 PING/INFO/ECHO 已通过，见 job-02-cdc.log。

F103 的 USB_DP 采用外置上拉（[ST AN4879](https://www.st.com/content/st_com/en/technical-documents/an4879-introduction-to-usb-hardware-and-pcb-guidelines-using-stm32-mcus-stmicroelectronics_asset/chunk-001-topic-an4879-usb-on-stm32-products.html)）。现象与调试复位后主机未看到断开、缺少重新枚举相符，这是基于实验的推断，不是已经穷尽其它原因的根因结论。

本轮通过易失寄存器停用 USB、将 PA12 临时设为开漏低电平 150 ms，再以 SYSRESETREQ 重新启动原固件，让主机重新枚举。没有写 Flash；之后再次回读全部 Flash 与备份完全一致。见 usb-reenumerate.py/json/log。原有 GPIO 配置由系统复位和原程序初始化恢复。

此后 COM34 的 PING→PONG、INFO 48 MHz/clk_err=0、独立 ECHO 行全部通过，见 restored-cdc.json 和接收原始字节。A04 的现场恢复已闭环，但目标例程的热复位/USB 重新枚举初始化仍是后续改进项，临时恢复方法不等于已修复目标固件。

最终 Flash SHA256：`61a097c84c8ca7cae573a950618de6009083048755b5c26def16f6cc351a354d`。记录包 SHA256：`ea61feb56d1a166645825b98d74c4e2dbc371a48b32cf4186b8b3dcdcae3f123`。本轮硬件锁释放、独立浏览器/OpenOCD/USB 桥/ETM 服务清理完成；KingstVIS 与原有 8893/8894/8899 服务保留，见 cleanup.json。未提交、推送、发布或修改全局设置。

## 汇总与后续

| 项 | 本轮状态 |
| --- | --- |
| A02 CH4 / ETM | 接线纠正后关闭：真实矩阵、三轮 10 ms、浏览器视图/导出/交接通过 |
| A04 板载 CDC | 已恢复并应答通过；热复位后的重新枚举初始化改进仍可跟进 |
| A01 full 的 60 MHz 稳定性 | 仍未通过，实际降档；保留原判据 |
| A03 首轮序号格式异常 | 上轮 1 条异常、原始字节缺失；后续三轮原始数据通过，仍待切换/启动期复现 |
| A05 NRST 目标复位 | 未确认，用户选择插拔电，本轮停止追查 |

完整命令/时间/返回码见 jobs.json；导出校验见 export-verification.json；全部持久证据的 SHA256 见 SHA256SUMS.txt。报告保存于 E:\web-serial-rtt-tools\docs\validation\20261016-f103ze-retest-125542-c3d845\report.md。上一轮报告不覆盖。
