# 靶子固件（tools/target-firmware）

给本仓库各页面当**被测目标**的测试固件。四块活动板卡和每个例程的唯一构建路径见
[`board-matrix.json`](board-matrix.json) 与 [`CONTRACT.md`](CONTRACT.md)。每个目录**根上的 `fw.elf` 都是编好的产物（入库）**，
用户不必装工具链：网页里直接载入就行 —— 页面要从 ELF 的符号（`_SEGGER_RTT`）和 DWARF
（变量地址/类型）里取地址，**所以光有 .bin/.hex 是不够的**。

日常重建用 `make rebuild-all-examples`；它先删除所有被忽略的 `build/`、`build-*` 目录，
再按清单重建 F103CB、F103ZE、H743 和 6800EVK 的 RTT、scope、调试压力例程。完整流程只
使用清单里的 `buildArtifact`，容量不同的 F103 不会互相覆盖。

| 目录 | 板子 | 干什么 | 入库产物 |
|---|---|---|---|
| `stm32f103_rtt_speed/` | STM32F103ZE（96 MHz） | **RTT 洪水**：死循环灌 `hello world`，量交付率上限 | `fw.elf`（ZE 档 + RTT 上行 32 KB） |
| `stm32f103_scope/` | STM32F103ZE | **J-Scope 靶子**：契约波形 + 撕裂/混叠自检 + 4 KB 地址空洞（两个 span） | `fw.elf`（ZE 档） |
| `stm32h743_rtt_speed/` | STM32H743（阿波罗） | RTT 洪水（RTT 缓冲放 **AXI SRAM**） | `fw.elf`（**flash 版；不提供纯 RAM 版**） |
| `stm32h743_scope/` | STM32H743 | J-Scope 靶子（同一套契约；变量放 AXI SRAM；`-DDCACHE_ON=1` 复现 D-cache 干扰） | `fw.elf` |
| `stm32h7b0_rtt_speed/` | STM32H7B0VBT6 KIT | RTT 洪水（**只有 HAL/SDK 版**；早先的寄存器版 / `-SlowClock` 已删） | `fw.elf` |
| `stm32h7b0_scope/` | STM32H7B0 | J-Scope 靶子（同一套契约，H7B0 布局） | `fw.elf` |
| `hpm6800evk_rtt_flood/` | HPM6800EVK（RISC-V） | RTT 洪水 | `fw.elf` |
| `hpm6800evk_scope/` | HPM6800EVK | J-Scope 靶子（非缓存 AXI SRAM，另带一块 cached 对照） | `fw.elf` |
| `stm32f103/` | STM32F103 | 最早期的通用小固件（UART + RTT；调试器页的行号测试也用它） | —（现场编译） |
| `hpm_flash_algo/` | — | **不是靶子**：烧录算法 blob | — |

**两类靶子的区别**（选哪个看你要测什么）：

- **RTT 洪水（rtt_speed / rtt_flood）**：回答"这条链路最快能搬多少"——`stm32f103_rtt_speed`、
  `stm32h743_rtt_speed`、`stm32h7b0_rtt_speed`、`hpm6800evk_rtt_flood`。
- **J-Scope 靶子（scope）**：回答"采得准不准"——每个被采样的量都有**精确已知的数学波形**，
  主机按读到的 `g_tick` 就能反算其余通道应当是多少，所以采样率、丢样本、撕裂读、混叠
  **全部可以客观判定**，不用靠肉眼。四个板子用的是**同一套变量契约**（`g_pack` 24 B 连续 +
  散落量 + `g_hole[4096]` 制造 4 KB 空洞），换板子不用换对账脚本。

异常诊断专用夹具：[STM32H743](stm32h743_fault/README.md) 与 [STM32F103ZE](stm32f103ze_fault/README.md)。这两份按调试页故障验收使用，需先完整备份、结束后恢复原始固件；不属于 RTT / Scope 活动例程构建清单。

## 两条约定（改这些目录前先看）

1. **`<目录>/fw.elf` 是"发货的那份"**：build 脚本编完会把它复制到目录根，而 `build*/` 全被
   `.gitignore` 忽略。**改了源码就重跑 build.ps1** —— 入库的 ELF 一旦和源码漂开，页面上按
   ELF 取到的地址就是错的（最难查的一类 bug）。
2. **两个仓库里同一份固件要保持一致**：探针仓库 `akaLinkPro/script_test/` 下有同名目录
   （那份是给探针开发者/用户用的）。历史上漂过两次：`flash.ps1` 的 OpenOCD 查找路径、
   `hpm6800evk_scope/src/main.c`（本仓库这份多了契约波形）。改的时候两边一起改。

## 怎么用（零安装）

1. 网页「RTT Viewer」→ 后端选探针 → 「载入 ELF…」选对应目录的 `fw.elf`（页面自动取
   `_SEGGER_RTT` 地址，不用手填）；或「烧录器」页按芯片型号烧 `fw.elf`。
2. 「J-Scope 波形页」→ 同样载入 scope 靶子的 `fw.elf` → 勾 8 个变量（建议先勾 `g_pack` 那一组，
   它在一个 span 里，走快路径）→ 采样率定到 30 kHz 以上。
3. 要**客观验收**（而不是看波形）：`stm32f103_scope/check.py` 是现成的对账脚本（halt → dump RAM
   → 按契约逐项核对 + 反测时基）；H7 两份 scope 有各自的 `check.py`。

各目录的编译/烧录/验收细节看它们自己的 `README.md`。
