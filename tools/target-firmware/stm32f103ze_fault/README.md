# STM32F103ZE 异常诊断验收固件

用于调试页「异常」功能的可恢复真机验收，参考 `../stm32h743_fault/`。目标限定 STM32F103ZE：Cortex-M3、512 KiB Flash、64 KiB SRAM；使用复位后的 HSI，不操作外部引脚。F103ZE 没有 FPU/MPU，因此只验证基本异常帧。

先完整备份原始 Flash，再烧入本目录 `fw.elf`。调试器必须载入同一份 ELF，并选择本目录 `src` 作为源码目录。测试结束后恢复原始 Flash、完整读回比较，恢复 DEMCR 捕获位并让目标继续运行。已有编译 ELF 可直接使用；重编译执行：

```powershell
pwsh -NoProfile -File tools/target-firmware/stm32f103ze_fault/build.ps1
```

编译使用 Cortex-M3 / soft-float、DWARF 4、CFI / EHABI，并保留帧指针和真实调用。正常模式 `g_fault_request=0` 时 `g_heartbeat` 持续增加。暂停目标，启用「捕获 HardFault」，修改 `g_fault_request` 后继续：

| 请求值 | 故障 | 预期 |
|---:|---|---|
| 1 | UDF / MSP | UNDEFINSTR、FORCED；保存 PC=`fault_udf_pc` |
| 2 | 开启除零陷阱后执行 SDIV | DIVBYZERO、FORCED；保存 PC=`fault_div_pc` |
| 3 | 读取 SRAM 空洞 `0x20020000` | PRECISERR、BFARVALID、BFAR=`0x20020000` |
| 4 | 切换 PSP 后执行 UDF | 基本 PSP 帧；本次编译产物带 4 字节对齐补位 |
| 5 | 开启非对齐陷阱后读取 `0x20000001` | UNALIGNED、FORCED；保存 PC=`fault_unaligned_pc` |
| 7 | PSP 起始位置减少 4 字节后执行 UDF | 基本 PSP 帧；本次编译产物无对齐补位 |

模式 4 / 7 的最终故障点栈对齐还取决于编译器函数序言；脚本检查实际保存 xPSR 的 bit 9。所有可配置异常关闭，使故障升级为 HardFault。`HardFault_Handler` 刻意通过普通函数序言保存 EXC_RETURN；关闭捕获、继续并人工暂停后，可验收 CFI/EHABI 恢复异常前帧。

在本地页面和已授权浏览器运行后，执行：

```powershell
$env:APP='http://127.0.0.1:8901/index.html'
$env:CDP='http://127.0.0.1:9335'
$env:DIAG_SOURCE='tools/target-firmware/stm32f103ze_fault/src'
$env:DIAG_OUT='tmp/f103ze-diagnostics'
node tools/selftest/diagnostics-hw.mjs --board=f103ze
```

脚本只操作已烧入的夹具，执行 8 个场景，**不自动备份、烧录或恢复固件**。如果复位停点进入 ROM bootloader，则按既有 F103 调试流程恢复 VTOR、SP、PC、PRIMASK/FAULTMASK；本次测试没有触发这条备用路径。

真实结果见 [F103ZE 验收记录](../../../docs/validation/2026-10-08-f103ze-diagnostics.md)。
