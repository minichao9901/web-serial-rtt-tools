# HPM6800EVK 复位后结构体观察：真机验收

日期：2026-10-07。用户流程：连接探针 → 加载 ELF → `b main` → 展开 `desc`
数据观察 → 复位并停 → `c`。保留浏览器 WebUSB/JTAG 零安装架构。

## 设备和输入

- akaLinkPro，固件构建时间 `2026/10/07 08:54:29`，TAP IDCODE `0x1000563D`。
- JTAG 10 MHz。浏览器 Chrome `153.0.8010.48`，8899 无缓存静态服务，9333 测试浏览器。
- SDK 工作目录 `lwip_lwip_tcpecho_hpm6800evk_flash_sdram_xip_debug/output/demo.elf`。
- `_start=0x80003000`、`main=0x8000790c`、`desc=0x4000b600`，结构体 60 字节。
- OpenOCD xPack `0.12.0+dev-01850-geb6f2745b-dirty`，强制
  `riscv set_mem_access sysbus`，`progbuf/abstract` 均禁用。

## 根因与证据

`desc` 在外部 SDRAM。SDK 链接脚本 `flash_sdram_xip.ld` 将 SDRAM 映射到
`0x40000000`，启动代码先调用 `_init_ext_ram`，然后才复制数据、清 BSS 和进入 `main`。
ELF 反汇编确认调用位于 `_start+0x16`，返回点为 `_start+0x1a`。

在 `main` 停机时，SYSCTL GROUP0 为 `0x1d3`，DDR0 的 bit 7 置位，
DDRCTL `STAT=1`。复位停在 `_start` 后，GROUP0 为 `0x153`，DDR0 未开启。
此时强制 OpenOCD `sysbus` 读取 `0x4000b600`，同样在 2 秒后报告
`sbbusy` 等待超时，访问方法日志为 `progbuf=disabled, sysbus=failed, abstract=disabled`。

Web 的另一问题是把逻辑等待预算压到最后不足 1 ms 后仍启动 USB OUT/IN：即使探针
仍正常响应 SBCS，最后一次响应也赶不上剩余预算，进而被当作真正的传输故障隔离，
使后续 `c` 失败。新的传输入口会在预算不足一次往返时提前退出，未启动命令不隔离连接。

修正后先检查常开 SYSCTL GROUP0、DDR0 RESOURCE（模式与时钟忙状态），确认可用后
才读取 DDRCTL STAT。正常模式才允许外部 SDRAM 读写。等待初始化的观察不保留旧成员值，
不触发复位，不改写控制器，也不进入 15 秒坏地址冷却。

保护当前识别带 `_init_ext_ram` 与 `init_ddr3l_1333` 或 `init_ddr2_800` 符号的
HPM6880 SDK ELF。其他板型、裁剪掉这些符号的 ELF 和其他外部内存控制器未在本轮验证。

## 验收结果

| 场景 | 结果 |
|---|---|
| 展开 `desc`，开启运行中刷新，复位并停 | 连续 5 轮通过；停在 `_start`，显示等待初始化，无 SDRAM 请求 |
| 复位后的访问范围 | 只有安全的 SYSCTL GROUP0 和 DDR0 RESOURCE 查询；未碰未启用的 DDRCTL 或 SDRAM |
| 紧接着执行 `c` | 每轮均命中 `main`，保留 1 个硬件断点，无 JTAG 超时 |
| 初始化完成后的结构体 | 每轮观察值、逐字与批量读取的完整 60 字节一致，即时恢复 |
| 继续越过 `main` 后的实时观察 | 正常刷新，读到初始化后的描述符，连接未被隔离 |
| SBCS | 各轮均无 busy、busyerror、sberror |
| OpenOCD 对照 | 仅 sysbus 导出的 60 字节与 Web 完全一致，PC 为 `main` |
| 离线专项 | 21 组异步 SBA 回归通过；新增 DDR 就绪、读写禁止、无冷却和旧观察数据失效回归通过 |

未烧录固件、未写目标 RAM。测试按用户流程执行了显式复位、停机、继续和硬件断点操作。

## 复跑

板上固件须与 ELF 一致，先启动页面与测试浏览器，再执行：

```powershell
node tools/selftest/dbg-hw-sba-reset.mjs --rounds=5 --clock=10000
```

使用其他 ELF 时传 `--elf=完整路径`。脚本验证本用例的 TAP 与 main/desc 地址，
保存 ELF SHA256、每轮数据和日志到 `tmp/sba-reset-hardware.json`。
结束时保留打开的 Web 页面，停在 `main`，`desc` 展开且运行中刷新开启。

本次辅助原始记录位于 `tmp/sba-hardware-repro.json`、`tmp/sba-hardware-fixed.json`、
`tmp/sba-openocd-repro.log`、`tmp/sba-openocd-gate.log`、`tmp/sba-sysbus-oracle.log`
及 `tmp/sba-sysbus-oracle.bin`。这些是本机生成的验证产物，不属于源代码依赖。
