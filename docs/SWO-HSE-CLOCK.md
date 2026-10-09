# Bluepill 外晶时钟与两端 SWO 波特率

WeAct 官方 BluePill-Plus 资料标注系统晶振为 8 MHz。当前用户程序选择 HSI 8 MHz，RCC 识别结果反映的是实际配置；有外晶并不代表程序已启用。新增独立的 HSE 8 MHz → PLL ×9 → 72 MHz 测试靶子，旧 HSI 离线示例及 ELF 保持匹配。

## 两端配置

目标输出：`B_target = HCLK / (TPIU_ACPR + 1)`。网页根据实读 RCC 与用户提供的 HSE 频率求出 HCLK，计算整数分频。默认要求精确整除，近似模式四舍五入并拒绝超过 5% 的请求偏差。

探针接收：`B_probe = F_uart / (UART_DIV × OSR)`。默认 `F_uart = 800 MHz / 4 = 200 MHz`；当前固件 OSR 搜索 8..30 的偶数，UART_DIV 为 1..65535。

网页下拉框既用于计算目标 TPIU 分频，也作为 Web Serial 的波特率请求。打开 VCOM 时 CDC line coding 配置探针 UART，固件会取最接近的可实现值。目标近似得到的实际值、VCOM 请求值和探针实际值可能不同；记录里的目标实际值不能当作探针实际值。

例如 HCLK 72 MHz、请求 1 Mbps：目标 ACPR=71，探针也能精确接收 1 Mbps。请求 25 Mbps、允许近似：目标 ACPR=2，实际输出 24 Mbps，探针实际接收 25 Mbps。外晶改善目标频率准确度，但不能消除整数分频造成的两端偏差。

## 2026-10-09 真机复测

探针保持已安装的默认 200 MHz 固件。本次只临时替换目标，双备份原始 Flash，结束后恢复全部 131,072 字节并逐字节校验，SHA256 为 `5c54ac4301861d8827a31bbaf2d995f6fd2e2b58a845e706a4d367d352adce40`。没有保留新目标测试程序。

| 网页请求 Mbps | 目标实际 Mbps | 探针实际 Mbps | PC 间隔（周期） | PC 样本 | 唯一 PC GNU 行号一致 | 阶段一致 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.5 | 0.5 | 0.500000 | 16384 | 7,609 | 160 / 160 | 7,409 / 7,409 |
| 1 | 1 | 1.000000 | 8192 | 15,241 | 172 / 172 | 14,967 / 14,967 |
| 8 | 8 | 7.692307 | 1024 | 121,270 | 228 / 228 | 120,497 / 120,497 |
| 25 | 24 | 25.000000 | 1024 | 121,983 | 225 / 225 | 121,020 / 121,020 |

四组无 SWO 溢出、畸形包、截断、串口错误和未知 PC。这里验证收到样本的映射，不声称还原遗漏指令。8 Mbps、25 Mbps 在本板本次采集可用，不代表这些有偏差的速率普遍可靠。

首次 OpenOCD → 浏览器交接曾出现 ELF 读回不稳定，独立读回确认代码正确。修复后，执行任何 trace 写入前最多重连一次并重新识别、校验；最终四组全部通过。错误 ELF 在重试后仍被拒绝，失败不会启用 trace。23 项页面检查与 SWO 离线自测通过。

[机器报告](../samples/swo/acceptance-hse72.json)；[1 Mbps 实测记录](../samples/swo/f103cb-hse72-1m.swopc)；[固件与用法](../tools/target-firmware/stm32f103cb_swo_hse/README.md)。

## 资料

- [WeAct BluePill-Plus：8 MHz 系统晶振](https://github.com/WeActStudio/BluePill-Plus)
- [Arm TPIU-M：异步输出分频公式](https://documentation-service.arm.com/static/60ddcca00320e92fa40b5c03)
