# WeAct Bluepill / STM32F103CB 外晶 SWO 靶子

使用 8 MHz HSE 晶振，经 PLL ×9 得到 72 MHz HCLK；APB1 为 36 MHz、APB2 为 72 MHz、ADC 为 12 MHz。Flash 配置预取和两等待周期，SysTick 保持 1 kHz。`g_clock_hz` 与 `g_clock_error` 表示初始化结果；时钟等待有界，外晶无法启动时继续使用 HSI。

计算管线、A/B 分支、递归、CRC、WFI、SysTick/PendSV 和 ITM 阶段标记与原 HSI 测试程序一致。普通运行不会自行开启 SWO，由网页通过 SWD 配置。该目录独立保存源码和匹配 ELF，旧 HSI 示例及其 ELF 不变。

构建：`make build-swo-f103cb-hse`，或运行本目录 `build.ps1`。Arm GCC 使用 `-O1 -g3 -gdwarf-4`。根目录 `fw.elf` 可直接载入网页，源码选择 `src/`；重新构建会改变 ELF 指纹，需要重新采集匹配记录。

网页勾选自动主频，HSE 输入 **8**，识别结果应为 **HSE → PLL · 72 MHz**。填写 HSE 只是提供晶振频率以计算主频，启用晶振由本固件 `clock_init_hse()` 完成。

2026-10-09 临时烧录验收：500 kbps、1 Mbps、8 Mbps、请求 25 Mbps（目标实际 24 Mbps）均通过真实网页采集与 GNU 源码行核对。目标原始 128 KiB Flash 已完整恢复且逐字节一致。尚未把本程序永久保留在目标板上。

[实测报告](../../../docs/SWO-HSE-CLOCK.md)。
