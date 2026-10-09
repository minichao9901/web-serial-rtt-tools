# STM32F103CB 协作调频 SWO 测试程序

WeAct Bluepill，HSE=8 MHz。复位默认 72 MHz，主循环依次执行 CRC、排序、条件分支、编码、递归、校验和睡眠；`never_path` 不应出现在 PC 记录中。阶段标记保留在 RAM，并可通过 ITM port 1 输出。

网页载入本目录 `fw.elf` 与 `src` 源文件，选择“目标主频”。程序在安全阶段边界接受 RAM 请求，调整 PLL、Flash 等待、APB 分频、ADC 分频与 SysTick，完成后更新序号与实际主频。60 MHz 使用 HSE/2 ×15。网页停止后恢复原频率；网页断开时探针接收时钟由本地 5 秒超时恢复，目标测试程序可保持最后频率，复位恢复 72 MHz。

RAM 接口仅用于这个测试程序：`g_clock_magic=0x5357434b`、`g_clock_request_hz`、`g_clock_hz`、`g_clock_error`、`g_clock_seq`。允许 16–72 MHz 的 4 MHz 倍数。普通固件没有这些接口时，网页会拒绝调频。

构建：`pwsh -NoProfile -File tools/target-firmware/stm32f103cb_swo_clock/build.ps1`。

真机验收：显式设置 `SWO_CLOCK_FLASH=1` 后运行 `node tools/selftest/swo-clock-hw.mjs`。该测试备份目标 Flash，烧录并保留本测试程序，不恢复先前的目标应用。
