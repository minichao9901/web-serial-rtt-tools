# WeAct Bluepill / STM32F103CB 外晶 SWO 靶子

使用 8 MHz HSE 晶振，经 PLL ×9 得到 72 MHz HCLK；APB1 为 36 MHz、APB2 为 72 MHz、ADC 为 12 MHz。Flash 配置预取和两等待周期，SysTick 保持 1 kHz。`g_clock_hz` 与 `g_clock_error` 表示初始化结果；时钟等待有界，外晶无法启动时继续使用 HSI。

计算管线、A/B 分支、递归、CRC、WFI、SysTick/PendSV 和 ITM 阶段标记与原 HSI 测试程序一致。普通运行不会自行开启 SWO，由网页通过 SWD 配置。该目录独立保存源码和匹配 ELF，旧 HSI 示例及其 ELF 不变。

构建：`make build-swo-f103cb-hse`，或运行本目录 `build.ps1`。Arm GCC 使用 `-O1 -g3 -gdwarf-4`。根目录 `fw.elf` 可直接载入网页，源码选择 `src/`；重新构建会改变 ELF 指纹，需要重新采集匹配记录。

另提供 **24 MHz CPU / Trace 主频**版本 `fw-24mhz.elf`，外部晶振仍为板上的 **8 MHz HSE**，PLL ×3；HCLK、APB1、APB2 均为 24 MHz，ADC 为 12 MHz，Flash 零等待且开启预取，SysTick 仍为 1 kHz。构建运行 `./build.ps1 -CoreMHz 24`（或 `make build-swo-f103cb-hse-24`），中间文件在 `build/24mhz/`，只更新 `fw-24mhz.elf`，不会覆盖原 72 MHz 的 `fw.elf`。两个 ELF 都使用本目录 `src/`。烧录哪个 ELF，分析时就载入对应 ELF；网页 HSE 均填写 **8**。此版本不是更换为 24 MHz 晶振。

24 MHz 版本使用 64 周期、不带时间戳时，理论产生 375,000 PC/s，纯 PC 包需 18.75 Mbaud；目标 SWO 可设 24 Mbaud（Trace ÷1），当前 20% 带宽余量估算需 23.4375 Mbaud。带时间戳建议增大间隔至至少 128 周期。普通运行依旧由网页通过 SWD 开启 SWO。

24 MHz 时钟实现独立保存在 `src/clock-24mhz.c`，72 MHz 仍使用原 `src/clock.c`，共享计算管线与启动程序。2026-10-10 已完成 24 MHz 交叉编译、时钟寄存器常量与 ELF 源码映射检查；原 `fw.elf` SHA256 仍为 `09c7a40471f110ba1c4f828a2fb974cdb7e5fc33c54d26ce50ffcc34236cb140`，原有源码行号未变。此次未烧录实测。

网页勾选自动主频，HSE 输入 **8**，识别结果应为 **HSE → PLL · 72 MHz**。填写 HSE 只是提供晶振频率以计算主频，启用晶振由本固件 `clock_init_hse()` 完成。

2026-10-09 临时烧录验收：500 kbps、1 Mbps、8 Mbps、请求 25 Mbps（目标实际 24 Mbps）均通过真实网页采集与 GNU 源码行核对。目标原始 128 KiB Flash 已完整恢复且逐字节一致。尚未把本程序永久保留在目标板上。

[实测报告](../../../docs/SWO-HSE-CLOCK.md)。
