# 靶子固件统一约定

这份文件解决一个实际问题：例程很多、容量档也很多，如果只看目录名，很容易把旧的
`build/`、错误容量的 ELF 或根目录副本混在一起。唯一清单是
[`board-matrix.json`](board-matrix.json)，脚本和文档都按它取路径。

## 1. 活动板卡与唯一构建入口

| 板卡 | RTT 洪水 | RTT 序号完整性 | J-Scope | 调试压力 | 内存窗口 |
| --- | --- | --- | --- | --- | --- |
| F103CB | `stm32f103_rtt_speed/build-cb/fw.elf` | `stm32f103_rtt_seq/build-cb/fw.elf` | `stm32f103_scope/build-cb/fw.elf` | `stm32f103_dbgstress/build-cb/fw.elf` | `0x20000000-0x20005000` |
| F103ZE | `stm32f103_rtt_speed/build-ze/fw.elf` | `stm32f103_rtt_seq/build-ze/fw.elf` | `stm32f103_scope/build/fw.elf` | `stm32f103_dbgstress/build/fw.elf` | `0x20000000-0x20010000` |
| H743 | `stm32h743_rtt_speed/build/fw.elf` | — | `stm32h743_scope/build/fw.elf` | `stm32h743_dbgstress/build/fw.elf` | `0x24000000-0x24005000` |
| 6800EVK | `hpm6800evk_rtt_flood/build/flash_xip/output/demo.elf` | — | `hpm6800evk_scope/build/flash_xip/output/demo.elf` | `hpm6800evk_dbgstress/build/flash_xip/output/demo.elf` | 从 ELF 符号取 |

四块活动板卡都由以下入口构建：

```powershell
make rebuild-all-examples   # 删除旧 build/build-* 后从源码重建
make test-board-matrix      # 只检查清单、脚本和产物是否一致
```

`buildArtifact` 是测试和完整流程使用的当前构建目录产物；`publishedArtifact` 是脚本复制到
例程根目录的 `fw.elf`，供网页手工选择和新克隆直接使用。F103CB 没有共享的根目录副本，
它必须使用清单中的 `build-cb`；四个活动例程对应的 `build-cb/fw.elf` 已随仓库入库，
新克隆无需本地编译即可直接载入/烧录。F103ZE 才发布根目录 ZE 副本。这样不会用错容量档。

## 2. 例程行为契约

- **RTT 洪水**：阻塞式 `SEGGER_RTT_Write()` 连续写固定 13 字节，`g_bytes`、`g_loops`、
  `g_ms` 用于主机侧对账。ZE 使用 32 KiB 上行缓冲，CB 使用 12 KiB；这是容量差异，
  不改变协议或判决口径。
- **RTT 序号**：同样的固定长度记录带递增序号，用于检测错位、重复和丢字节；只在 F103
  上保留，因为它服务于 SWD/RTT 链路的字节级诊断。
- **J-Scope**：所有活动板卡都暴露连续变量块、散落变量、时基计数、撕裂读和混叠测试量。
  H743 把数据放 AXI SRAM，6800EVK 按其 SDK 的非缓存区域布局；主机按 ELF 符号取地址。
- **调试压力**：四块板卡都使用同一组多文件调用链、结构体/位域、断点、单步和复位语义；
  Cortex-M 与 RISC-V 的硬件断点/单步实现由各自脚本处理，例程变量契约保持同名。

## 3. 清理边界

```powershell
make clean-firmware                 # 只清生成目录
pwsh -File tools/dev/clean-firmware.ps1 -List
pwsh -File tools/dev/clean-firmware.ps1 -WhatIf
```

清理脚本只处理 `tools/target-firmware` 下名字为 `build` 或 `build-*` 的目录，保留源码、
根目录入库的 `fw.elf`、`tmp`、文档和 bundle。`make clean` 还会清临时 CSV/BIN。

## 4. 旧档案

F103C8、早期通用 `stm32f103`、H7B0 仍可手工编译或用于历史复现，但不属于四块活动板卡的
完整流程。它们在清单的 `legacy` 中列出，避免被误当成当前发布产物；除非专门做历史复现，
不要把这些目录的 ELF 喂给活动板卡流程。

## SWO 独立诊断例程

`stm32f103cb_swo` 是 F103CB 的 SWO PC 采样验证例程，发布文件 `fw.elf`，通过 `make build-swo-f103cb` 构建。它不替代活动矩阵的 RTT/JScope/调试压力固件，详见其 README 和 `docs/SWO-PC-SAMPLING.md`。
