# SWO 双端时钟匹配与 240 MHz / 30 Mbaud 验收

2026-10-09，STM32F103CB WeAct Bluepill（HSE 8 MHz），SWO PB3 接 akaLinkPro HPM5301 的 PB07/VCOM RX。当前保留探针 **UART 240 MHz** 默认固件和目标协作测试程序；目标复位及正常停止记录后为 **HSE → PLL 72 MHz**。

## CPU、PLL 和串口的分频层

探针默认采用现有 PLL0CLK0=720 MHz。CPU 独立二分频得到 360 MHz，UART 独立三分频得到 240 MHz，SPI2 启用后也采用 720/3=240 MHz。修改 UART 的 SYSCTL 分频、OSR 或 UART divisor，不会修改 CPU 频率。修改 PLL0 的 MFI/MFN 会改变共享根时钟，CPU 和其他使用者可能一起受影响。

本实现不调整 PLL0。自动模式先枚举现有时钟源；必须精细调频时只使用 PLL1。固件检查 CPU 和其他消费者，迁移可以保持相同频率的节点，无法迁移的活动节点拒绝执行。XIP 可临时降频到稳定 PLL0，结束恢复原配置；PLL1 模式因此可能影响 Flash 访问时序。运行中的 SPI/I²C 功能与 SWO 时钟会话互斥。

PLL1 标称公式为 `24 MHz × (MFI + MFN/MFD)`。默认 MFD=240,000,000，寄存器分辨率 0.1 Hz，SDK 整数 Hz API 分辨率 1 Hz；固件先验证参考源、MFD、扩频和输出分频。计算分辨率不等于晶振实际精度。参考 [SDK PLL 驱动](https://github.com/hpmicro/hpm_sdk/blob/v1.11.0/drivers/src/hpm_pllctlv2_drv.c) 与 [HPM5301 时钟驱动](https://github.com/hpmicro/hpm_sdk/blob/v1.11.0/soc/HPM5300/HPM5301/hpm_clock_drv.c)。

## 三个公式必须分别计算

- 目标 SWO 线速：`B_target = HCLK / (TPIU_ACPR + 1)`，整数分频 1–8192。
- 探针 UART 接收线速：`B_probe = F_uart / (OSR × UART_DIV)`；模块还有独立时钟源和 SYSCTL 分频。
- PC 采样率：`Samples/s = HCLK / N`，N 是采样周期数，不能直接当作波特率。

8N1 每个字节需要 10 个线位。纯 PC 包按 5 字节估算，有时间戳按 9 字节估算，自动方案另留 20% 余量。同步、睡眠、ITM 和异常改变实际负载，估算不能替代实测。

72 MHz /64 = **1,125,000 samples/s**，纯 PC 最低需 **56.25 Mbaud**。/128 为 562,500 samples/s，纯 PC 最低需 28.125 Mbaud，含余量需 35.156 Mbaud。72 MHz 的整数 SWO 分频在 ≤30 Mbaud 时最高只能输出 24 Mbaud，因此不能直接在 72 MHz 下可靠使用这两档。

| 目标主频 | PC 间隔 | 模式 | SWO 发/收 | UART 时钟 / OSR / DIV |
|---|---|---|---|---|
| 72 MHz | 512 | 时间戳 + ITM | 18 Mbaud | 180 MHz / 10 / 1 |
| 32 MHz | 256 | 时间戳 + ITM | 16 Mbaud | 160 MHz / 10 / 1 |
| 24 MHz | 128 | 时间戳 + ITM | 24 Mbaud | 240 MHz / 10 / 1 |
| 24 MHz | 64 | 纯 PC | 24 Mbaud | 240 MHz / 10 / 1 |
| 60 MHz | 256 | 时间戳 + ITM | 30 Mbaud | 240 MHz / 8 / 1 |
| 60 MHz | 128 | 纯 PC | 30 Mbaud | 240 MHz / 8 / 1 |

自动匹配优先使用已有根时钟，再比较双方误差和满足余量的线速。页面显示实际输出、实际接收、UART 输入/OSR/divisor 和误差；准备阶段重新读取根时钟，由固件独立规划与回读。双方误差超过 0.5% 拒绝启用 trace。

## 页面使用

1. 载入匹配目标的 ELF 与源文件，授权 SWD、串口和“探针时钟配置”。后者经同一探针的 WebHID 完成，核对序列号。
2. 识别目标，填写 HSE 8 MHz，选择采样周期、时间戳和 ITM。自动匹配会配置两端；手动模式显示双方实际速率。
3. 普通应用保持原主频。试 64 档可用 [协作调频程序](../tools/target-firmware/stm32f103cb_swo_clock/README.md)，载入该程序的 `fw.elf`，选择目标 24 MHz，关闭时间戳/ITM。试 30 Mbaud 可选目标 60 MHz、128 档纯 PC，或 256 档带时间戳。
4. 开始时校验 ELF、保存 trace 配置、准备接收端，再配置 TPIU/DWT。串口自动请求实际目标线速，探针租约固定计算出的硬件分频；浏览器请求值不能代替读回值。
5. 停止恢复 trace、探针时钟及原目标主频。原始 `.swopc` 含双端配置、ELF 指纹和接收错误计数，可离线载入。完整 `.c` / `.txt` 导出重新解码原始数据，不受页面事件上限影响。

目标调频只接受已校验 ELF 的协作接口、RAM 魔数和应答序号，由程序在安全阶段边界修改 PLL、Flash 等待、APB/ADC 和 SysTick。无此接口的普通程序拒绝调频。浏览器异常退出后探针 5 秒无心跳恢复原时钟；目标协作程序可能保持最后频率，复位恢复 72 MHz。

## 实测与恢复验证

最新探针镜像 SHA256：`660d9c60f6490eec28c4647be51d8c1f98b7b1fca67ad700aedf47b2b47247bc`。目标 ELF：`4fb488be3554e9c9713cb40a01ee7dfb94e1f6b689b188db9d0a026000d0d677`。

| 配置 | 时长 | 原始字节 | PC 样本 | 全部不同 PC 的 GNU 定位核对 |
|---|---:|---:|---:|---:|
| 60 MHz /128，30 Mbaud，纯 PC | 6 s | 12,916,276 | 2,424,768 | 285 |
| 24 MHz /64，24 Mbaud，纯 PC | 0.3 s | 553,493 | 105,557 | 233 |

均无畸形包、SWO overflow、未知 PC、末尾截断、浏览器错误或已检测 UART 接收错误。6 秒记录跨越 5 秒租约超时，验证心跳维持。所有不同 PC 均与 GNU addr2line 的函数和源码行定位独立核对；长记录额外流式解码检查完整数据的全部 PC。睡眠会产生 sleep 包，实际 PC 数少于名义上界。

额外 30 Mbaud /256、带时间戳和 ITM 的 3 秒试验收到 609,785 PC、5,368,439 字节，阶段核对无冲突；另一次 24 Mbaud /64 纯 PC、6 秒试验收到 1,946,838 PC。额外结果是在最终 PLL 关闭状态等待修正前的固件运行，收发配置相同；最新固件以上表为准。

独立租约测试通过固定 30/24 Mbaud、已有时钟 18 Mbaud、PLL1=920 MHz 的精确 23 Mbaud。验证 150 次心跳、错误 token 拒绝、超过 30 Mbaud 拒绝，以及无心跳 5.3 秒恢复全部 36 个时钟节点和 PLL 参数。SPI2 启用、模块 240 MHz 时 CPU/SPI 时钟保持不变；未测外部 SPI 数据吞吐。RTT、JScope、SPI 协议/生命周期回归通过，本轮没有重测三者硬件吞吐。

UART 240 MHz 是用户选择的超规格模式（此前核查的 HPM5300 DS Rev0.11 UART 额定输入为 100 MHz）。SPI 能运行在 240 MHz 不证明 UART 额定许可；本报告只确认这台探针、接线和有限窗口。UART LSR 计数是观察到的标志次数，可能少于实际受影响字节数。

PC 采样显示执行位置、热点和采样序列，不能重建每条分支或指令；纯 PC 没有 trace 时间戳，时间只可估计。导出保留间断/溢出证据。

机器报告：[验收记录](../samples/swo/clock240-acceptance.json)，短原始样本：[24 MHz /64](../samples/swo/f103cb-clock240-64.swopc)。复跑：`node --test tools/selftest/swo*.test.mjs`。真机脚本 `tools/selftest/swo-clock-hw.mjs` 必须设置 `SWO_CLOCK_FLASH=1`，会备份并保留协作程序。
