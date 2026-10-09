# SWO 双端时钟匹配与计算器

当前页面支持 F103、F407/F405、H743 型号组和 H7B0 型号组。目标 CPU / PLL 由目标程序负责；录制只设置 DWT、ITM、SWO、必要的调试门控和 PB3 路由。停止恢复原 Trace 和探针接收配置。本轮固定主频实物验收见 [型号适配与计算器](validation/2026-10-09-swo-ports-calculator.md)。

## CPU、Trace 和板级晶振

识别 CPUID 可以判断 Cortex-M3/M4/M7，但不能推断芯片时钟树或外部晶振。页面按 CPUID + STM32 DEV_ID 选择适配，再读取 RCC。DEV_ID 可能由多个型号共用，不能唯一识别完整料号。使用外部时钟时，频率需按板子提供；显示值是根据寄存器推算，不是测量。

| 常见型号 | CPU 来源 | SWO 输入来源 |
|---|---|---|
| F103 | SYSCLK 经 AHB 分频后的 HCLK | HCLK，与 CPU 相同 |
| F407/F405 | SYSCLK 经 AHB 分频后的 HCLK | HCLK，与 CPU 相同 |
| H743/H742/H750/H753 | PLL 模式为 PLL1_P 经 D1CPRE | PLL 模式为 PLL1_R；其他模式为 HSI / CSI / HSE |
| H7B0/H7A3/H7B3 | PLL 模式为 PLL1_P 经 CDCPRE | PLL 模式为 PLL1_R；其他模式为 HSI / CSI / HSE |

H7 的 SWO 串行输出时钟由 RCC 系统时钟选择控制，但 PLL 模式取 R 输出；核心取 P 输出。Trace 组件的总线 / ATB 时钟也不是 SWO 编码时钟。PLL1_R 未启用时提示由目标程序开启，页面不修改目标 PLL。计算器选择 H7 后默认独立输入 Trace 频率，也可从当前识别结果带入。

## 三个公式分别计算

- PC 采样率：`PC/s = CPU Hz / N`；N 为 DWT 合法采样间隔。
- 目标 SWO 线速：`B_target = Trace Hz / (ACPR 或 CODR + 1)`；整数分频 1–8192。
- 探针接收线速：`B_probe = PLL 输出 Hz / SYSCTL分频 / OSR / UART_DIV`。

8N1 每字节占 10 线位。纯 PC 包按 5 B，带时间戳按约 9 B/PC 估算；异常按 3 B/进入或退出事件；ITM 按载荷的 2 倍估算，可填写其他字节/s。默认余量 20%，所需线速为  `预计字节/s ×10 /0.8`。这是平均预算，突发和实际时间戳开销仍需实测。

72 MHz /64 = **1,125,000 PC/s**，纯 PC 最低需 **56.25 Mbaud**。/128 为 562,500 PC/s，纯 PC 最低 28.125 Mbaud，含余量需 35.156 Mbaud。72 MHz Trace 在 ≤30 Mbaud 时整数分频最高只能产生 24 Mbaud，不能直接可靠使用这两档。可增大间隔，或由目标程序使用合法的较低主频；计算器给出带宽允许的频率上界，目标合法 PLL 档位仍需由目标工程确认。

## 探针时钟与自动匹配

探针默认 PLL0CLK0=720 MHz，CPU 独立二分频得到 360 MHz，UART 独立三分频得到 240 MHz；SPI2 启用后也使用 720/3=240 MHz。修改 UART 的分频不会改变 CPU；修改共享 PLL0 的 MFI/MFN 则可能改变其他使用者。本实现不调整 PLL0。

页面统一使用自动规划：先枚举已有根时钟和分频，必要时申请调整 PLL1。页面会显示本次实际选择，若使用 PLL0 则明确说明 PLL1 未用于接收。预览可能使用默认根频率，准备录制时重新读取根时钟，固件独立规划、校验消费者并回读实际配置。不能安全迁移共享消费者时拒绝 PLL1 调整；SPI/I²C 与 SWO 时钟会话互斥。

PLL1 公式为 `24 MHz × (MFI + MFN/MFD)`。默认 MFD=240,000,000 时寄存器分辨率 0.1 Hz；SDK 整数 Hz API 分辨率 1 Hz。计算分辨率不等于晶振实际精度。参考 [SDK PLL 驱动](https://github.com/hpmicro/hpm_sdk/blob/v1.11.0/drivers/src/hpm_pllctlv2_drv.c) 与 [HPM5301 时钟驱动](https://github.com/hpmicro/hpm_sdk/blob/v1.11.0/soc/HPM5300/HPM5301/hpm_clock_drv.c)。

## 页面操作

1. 在“分析”载入匹配 ELF 和源码；在“录制”选择 VCOM、识别目标并授权探针时钟。
2. 按实际板子填写外部时钟。F103 初始按 Bluepill 8 MHz，自动识别其他型号时清除这个预设。自动推算得到 CPU 和 Trace；无法推算时可手动提供实际值，但不会因此为未知芯片启用 STM32 配置。
3. 选择 PC 间隔、时间戳和事件预算。自动匹配填入 SWO 计算值；关闭自动匹配可输入 1–30000000 的整数。目标无法整除时可以允许近似，页面显示请求与实际值；探针始终匹配目标实际输出，而不是未实现的请求值。双方实际误差超过 0.5% 拒绝启用 Trace。
4. 计算器允许模拟目标频率及事件开销，采用设置只复制采样和预算。目标频率改变后重新识别，录制期间应保持稳定。
5. 记录结束恢复原 Trace 与接收配置，保存 .swopc。完整 .c / .txt 导出包含全部解码落点和缺口，.c 便于高亮阅读，不用于编译。

F103CB 已物理验证；F407、H743、H7B0 的适配目前通过寄存器模拟与恢复测试，待对应板子验收。

以下保留旧版协作测试程序的 240 MHz /30 Mbaud 历史结果。当前录制页面已移除目标调频入口，这些结果不能当作当前页面自动改变目标频率的承诺。

## 历史协作调频实测（旧版页面）

当时探针镜像 SHA256：`660d9c60f6490eec28c4647be51d8c1f98b7b1fca67ad700aedf47b2b47247bc`。目标 ELF：`4fb488be3554e9c9713cb40a01ee7dfb94e1f6b689b188db9d0a026000d0d677`。

| 配置 | 时长 | 原始字节 | PC 样本 | 全部不同 PC 的 GNU 定位核对 |
|---|---:|---:|---:|---:|
| 60 MHz /128，30 Mbaud，纯 PC | 6 s | 12,916,276 | 2,424,768 | 285 |
| 24 MHz /64，24 Mbaud，纯 PC | 0.3 s | 553,493 | 105,557 | 233 |

均无畸形包、SWO overflow、未知 PC、末尾截断、浏览器错误或已检测 UART 接收错误。6 秒记录跨越 5 秒租约超时，验证心跳维持。所有不同 PC 均与 GNU addr2line 的函数和源码行定位独立核对；长记录额外流式解码检查完整数据的全部 PC。睡眠会产生 sleep 包，实际 PC 数少于名义上界。

额外 30 Mbaud /256、带时间戳和 ITM 的 3 秒试验收到 609,785 PC、5,368,439 字节，阶段核对无冲突；另一次 24 Mbaud /64 纯 PC、6 秒试验收到 1,946,838 PC。额外结果是在最终 PLL 关闭状态等待修正前的固件运行，收发配置相同；该历史固件以上表为准。

独立租约测试通过固定 30/24 Mbaud、已有时钟 18 Mbaud、PLL1=920 MHz 的精确 23 Mbaud。验证 150 次心跳、错误 token 拒绝、超过 30 Mbaud 拒绝，以及无心跳 5.3 秒恢复全部 36 个时钟节点和 PLL 参数。SPI2 启用、模块 240 MHz 时 CPU/SPI 时钟保持不变；未测外部 SPI 数据吞吐。RTT、JScope、SPI 协议/生命周期回归通过，本轮没有重测三者硬件吞吐。

UART 240 MHz 是用户选择的超规格模式（此前核查的 HPM5300 DS Rev0.11 UART 额定输入为 100 MHz）。SPI 能运行在 240 MHz 不证明 UART 额定许可；本报告只确认这台探针、接线和有限窗口。UART LSR 计数是观察到的标志次数，可能少于实际受影响字节数。

PC 采样显示执行位置、热点和采样序列，不能重建每条分支或指令；纯 PC 没有 trace 时间戳，时间只可估计。导出保留间断/溢出证据。

机器报告：[验收记录](../samples/swo/clock240-acceptance.json)，短原始样本：[24 MHz /64](../samples/swo/f103cb-clock240-64.swopc)。复跑：`node --test tools/selftest/swo*.test.mjs`。旧真机脚本 `tools/selftest/swo-clock-hw.mjs` 已停用，任何 Flash 操作前会拒绝执行。当前固定时钟验收用 `make test-swo-current-hw`。
