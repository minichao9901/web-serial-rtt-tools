# STM32H7B0 HSE SWO 采样例程

这是 `stm32f103cb_swo_hse` 的 H7B0 对应例程，用于通过 SWO 采集程序 PC 流、查看函数执行轨迹，并验证源码/ELF 映射。它提供持续运行的计算负载、分支路径、递归、SysTick/PendSV 和可选 ITM 阶段标记。

## 目标板配置

- 芯片：STM32H7B0（本例按 H7B0VBT6 开发板配置）
- 外部晶振：25 MHz HSE
- 目标时钟：HSE ÷ 5 × 112 ÷ 2 = **CPU/HCLK 280 MHz**；APB1/2/3/4 为 140 MHz
- 供电：沿用板上的 LDO 配置。固件仅读取供电选择寄存器，不改写 `PWR_CR3`
- SWO 引脚：**PB3 / JTDO / TRACESWO**。把探针的 SWO 输入接 PB3，并确保共地；PB3 不要同时复用作 SPI1_SCK、SPI3_SCK 或其他外设

时钟初始化使用 H7B0（RM0455）寄存器布局。每一步等待都有超时；如果 HSE、PLL 或时钟切换失败，会退回复位默认的 HSI 64 MHz。`g_clock_hz`、`g_clock_source`、`g_clock_error` 可在 ELF 符号中查看实际结果。

## 主机与固件的分工

固件负责启动 HSE/PLL、运行演示负载，并在 SysTick 中更新计数。固件**不会**配置 ITM、TPIU、DWT 或 SWO 引脚；SWO 页面连接 SWD 后负责读取时钟、设置 trace 时钟/波特率与 PC 采样，再运行到断点起点采集。这样目标程序的时钟由固件掌控，trace 采集配置由上位机掌控。

H7B0 的 SWO 输入时钟由 RCC 的 TRACEPORTCK 选择，与 HCLK 分频路径相关但不应直接假定总是等于 CPU 时钟。页面会根据 RCC 配置识别它；若使用手动配置，请选择 **STM32H7B0 / H7A3 / H7B3**，HSE 填 **25 MHz**，并以页面识别出的 SWO 输入频率为准。

## 构建和载入

```powershell
pwsh -File build.ps1
# 或在仓库根目录运行：make build-swo-h7b0-hse
```

生成的 `fw.elf` 位于本目录根部，包含 `-g3 -gdwarf-4` 调试信息，可直接在 SWO 页面载入；源码目录选本例 `src/`。构建需要 `arm-none-eabi-gcc`。`build/` 中间文件可删除后重建。

## 采集步骤

1. 用网页烧录本目录的 `fw.elf`，或使用已有烧录流程；确认板子复位后能运行。
2. 在 SWO 页面连接探针，目标选择 H7B0，HSE 填 25 MHz，载入同一份 `fw.elf`。
3. 添加 `execute_phase` 或 `pipeline_scan` 断点作为采集起点，使用页面的“复位并停在起点”/采集流程。这两个入口都位于时钟初始化之后，复位后也会再次到达；`main` 函数入口位于时钟初始化之前，不适合作为本例的 SWO 采集起点。
4. 配置 SWO 采样后启动。首次先降低 PC 采样频率或缩短采集时长，再逐步增加负载。
5. 结果中应能看到 `main`、`execute_phase`、`pipeline_scan`、`pipeline_sort`、`route_a`/`route_b`、`pipeline_recursive`、`pipeline_verify` 等函数；阶段标记仅在上位机启用 ITM stimulus port 1 时输出。

执行路径是 DWT 周期采样重建的统计轨迹，不是 ETM 的逐指令全量 trace。若采样率过高或 SWO UART 带宽不足，页面会显示相应的丢包/错误诊断；不可据此宣称每一条指令都被记录。

## 说明

主负载、分支/递归例程、ITM 阶段标记格式和 F103 HSE 例程保持一致，便于比较两个内核的采样效果。H7B0 的启动代码启用 FPU、设置 VTOR，并将 `.data/.bss` 放在 AXI SRAM；栈放在 DTCM。这里的内存布局沿用 H7B0 已验证的启动/链接配置。

2026-10-12，用户已烧录本 ELF，随后通过 CMSIS-DAP 完成实板只读核验：板上执行段抽查与 ELF 一致，`g_clock_hz=280000000`、`g_clock_source=0`、`g_clock_error=0`，SysTick 计数持续增长；读取的 RCC 配置按 25 MHz HSE 换算为 CPU 280 MHz、PLL1_R / SWO 输入 280 MHz。核验期间 CPU 保持运行，未复位或暂停。

SWO 网页在自动识别或选择 H7B0 时会使用本例板卡的 25 MHz HSE 预设，并标注“预设”；用户手工输入的外部频率可覆盖它。外部晶振频率本身无法由 RCC 直接测出。**尚未在本轮完成实际 SWO 采集与波形验收**；SWO 引脚速率由网页的波特率配置决定，280 MHz 指的是编码器内部输入时钟。
