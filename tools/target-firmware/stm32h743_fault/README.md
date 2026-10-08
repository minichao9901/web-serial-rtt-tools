# STM32H743 异常诊断验收固件

仅用于可恢复的板上验收。测试前备份原始 Flash，结束后恢复并读回校验。本例不操作外部引脚；复位后使用 HSI，D-cache 保持关闭，数据和栈都放在可调试读取的 AXI SRAM。

`fw.elf` 是已编译、带 DWARF 4 / CFI / EHABI 的产物。在 Web 烧录器中选择 STM32H7，载入并烧录；调试器必须载入同一份 ELF。编译用 `pwsh -File build.ps1`。

正常状态下 `g_fault_request=0`，`g_heartbeat` 持续增加。先暂停、设置异常页的「捕获 HardFault」，修改 `g_fault_request`，再继续运行。

| 请求值 | 故障 | 预期证据 |
|---:|---|---|
| 1 | UDF 未定义指令 / MSP | UNDEFINSTR、FORCED；保存 PC=`fault_udf_pc` |
| 2 | 开启除零陷阱后执行 SDIV | DIVBYZERO、FORCED；保存 PC=`fault_div_pc` |
| 3 | 读取未映射外部存储器 `0x60000000` | PRECISERR、BFARVALID、BFAR=`0x60000000` |
| 4 | 使用 PSP 后执行 UDF | 基本 PSP 异常帧 |
| 5 | 使用 PSP / FPU 后执行 UDF | 浮点扩展 PSP 异常帧；核心帧位于 SP 起点 |
| 6 | MPU 禁止读取 AXI 地址 `0x2407c000` | DACCVIOL、MMARVALID、MMFAR=`0x2407c000` |

所有可配置异常关闭，使上述故障升级为 HardFault。异常入口后会调用 `fault_handler_body` 并停止推进；关闭捕获再人工暂停，可以验收处理函数序言后保存 EXC_RETURN 的展开。叶函数、`fault_mid`、`fault_outer` 和 `main` 保留真实调用，源码标签给出精确故障指令地址。

Web 仓库的 `tools/selftest/diagnostics-hw.mjs` 执行 8 个场景，逐项校验故障位、保存 PC、MSP/PSP、浮点帧、调用链、只读一致性、捕获位恢复和链路恢复次数。该脚本只操作已经烧入的夹具，不负责备份、烧录或恢复。
