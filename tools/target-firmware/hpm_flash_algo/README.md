# HPM 系列 flashloader（RV32 烧录算法）

网页端 `烧录器` 页的 **HPM RISC-V WebUSB 烧录**用它：把这段算法经调试链路写进目标 SRAM，
再依次调用它的入口（`flash_init` → `flash_erase` → `flash_program` → 校验 → 复位运行）。

## 出处与许可

- `openocd_flash_algo.c` / `func_table.S` / `linker.ld`：**原样**取自 HPMicro HPM SDK
  `samples/openocd_algo/src/`（BSD-3-Clause，Copyright (c) 2021 HPMicro）。本仓库 Apache-2.0，
  BSD-3 兼容；文件头的版权声明保留。
- `memset.c`：本仓库自己写的极小替身（见文件内注释）。

## SDK 所列系列为什么共用一份算法

算法的主体擦写流程调用芯片 ROM 的 XPI NOR 驱动
（`ROM_API_TABLE_ROOT->xpi_nor_driver_if`）。SDK 所列系列的 ROM 表位于 `0x2001FF00`，
官方 OpenOCD `hpm_xpi` 驱动实际加载同一个 `flash_algo[]`，通过
`flash_base`、`xpi_base`、`option0/1` 传入板级差异。
实际共用算法数组和参数化 ABI 是复用依据，不能只由表地址相同推导二进制兼容。
板级参数和钩子集中在 `app/targets/hpm/porting.js`，来自 SDK 的 `flash bank` 配置。

## 入口表（`func_table.S`，位于 blob 偏移 0，本次构建每项 6 B：4 字节 `jal` + 2 字节 `c.ebreak`；运行时解析，不硬编码步长）

| # | 偏移 | 函数 | 签名（RV32 调用约定，a0..a4 入参 / a0 返回） |
| - | ---- | ---- | ------------------------------------------- |
| 0 | 0x00 | `flash_init` | `(flash_base, header, opt0, opt1, xpi_base) -> status` |
| 1 | 0x06 | `flash_erase` | `(flash_base, address, size) -> status` |
| 2 | 0x0c | `flash_program` | `(flash_base, address, buf, size) -> status` |
| 3 | 0x12 | `flash_read` | `(flash_base, buf, address, size) -> status` |
| 4 | 0x18 | `flash_get_info` | `(flash_base, info*) -> status`（info = {total_sz, sector_sz}，各 4 B） |
| 5 | 0x1e | `flash_erase_chip` | `(flash_base) -> status` |
| 6 | 0x24 | `flash_deinit` | `() -> void` |

- `header`：`xpi_nor_config_option_t` 的头字 = `words(4bit) | tag(0xfcf90) << 12`，
  即 1 个 option 字时 `0xFCF90001`、2 个时 `0xFCF90002`、不带 option 时 `0xFCF90000`。
- 每次调用以 `ebreak` 结束 → 调试器看到 halt，返回码在 `a0`。
- `status`：0 = 成功；其它值直接来自 ROM API（见 SDK `hpm_common.h` 的 `hpm_stat_t`）。

## 构建

```powershell
pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
```

需要 HPM SDK 与本机 RISC-V 工具链，路径用环境变量覆盖（默认值见脚本头部）：
`$env:HPM_SDK_BASE` / `$env:RV_TOOLCHAIN`。脚本会：
1. 用 `-nostdlib` + `memset.c` 编译（**必须**：链 newlib 会把 1.4 KB 撑到 16.8 KB）；
2. 校验入口表（7 项、每项 +4 处是 2 字节 `c.ebreak`，表项步长 6 字节、`jal` 目标落在 blob 内）；
3. 生成 `app/flash/hpm/algo.js`（blob 的 base64 + 描述符），网页直接用，不需要运行时构建。

实测尺寸：**1360 B text + 28 B data = 0x56C（1388 B）**，加载地址 `0x00000000`
（与 SDK 的 `-work-area-phys 0x00000000 -work-area-size 0x20000` 一致）。


## 跨型号与工作区移植

HPM 板级配置集中在 `app/targets/hpm/porting.js`；换型号/板卡修改参数与钩子，无需按型号生成算法。
构建脚本从 ELF `.got` 提取内部数据指针重定位元数据。零地址 blob 保持不变；非零工作区由加载器修正 GOT。
每次构建还独立链接 `0x4000` 地址版本，使用 `check-relocation.mjs` 对照所有字节。
详细说明见 `docs/hpm-porting.md`。
