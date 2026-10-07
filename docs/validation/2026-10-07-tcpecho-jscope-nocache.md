# HPM6800EVK tcpecho：JScope 非缓存采样变量

2026-10-07，按用户要求修改 SDK 的 tcpecho 例程。源工程位于 `E:/sdk_env_v1.11.0/hpm_sdk/samples/lwip/lwip_tcpecho`，构建目录为 `E:/sdk_env_v1.11.0/work/lwip_lwip_tcpecho_hpm6800evk_flash_sdram_xip_debug`。

## 修改范围

tcpecho 的 CMake 增加 `CONFIG_LWIP_JSCOPE_NOCACHE=1`。共用的 `common.h` 定义受该开关控制的 BSS/INIT 属性；未启用的其他例程保持原布局。共用 `common.c` 中的 `gnetif`、`desc`、`last_status` 和 baremetal `sys_arch.c` 中的 `sys_tick` 使用该属性。tcpecho 自身的 `main_loop_cnt`、`trace_log_write_count`、`trace_log_missing_count` 也放入非缓存区。

使用 SDK 的 `.noncacheable.bss` 和 `.noncacheable.init`，分别保留启动清零和初值复制。没有把要求清零的对象放进旧的、启动不清零的 `.noncacheable` 输入段。现有 DMA 描述符属性、收发缓冲、RTT 环大小以及 TCP echo 行为保持原实现。

`flash_sdram_xip.ld` 将非缓存区定义在 `0x4c000000..0x4e000000`；`boards/hpm6800evk/board.c` 的 `board_init_pmp()` 按同一组链接符号配置 PMA 为 `MEM_TYPE_MEM_NON_CACHE_BUF`。Cache 保持启用，所迁移对象在板级初始化后走非缓存访问。仅添加 `volatile` 不会实现这一效果。

## 编译及 ELF 核对

SDK 自带 Ninja 完成 105 个构建步骤，退出码 0；链接后的非缓存区占用 8,389,928 字节，低于 32 MB。新的固件和符号文件：

- `output/demo.bin`
- `output/demo.elf`
- `output/demo.map`

| 对象 | 新地址 | 大小 | 初始化方式 |
|---|---|---:|---|
| last_status | 0x4c000000 | 3 | 复制初值 |
| sys_tick | 0x4c0003e0 | 4 | 清零 |
| desc | 0x4c0003e8 | 60 | 清零 |
| gnetif | 0x4c000428 | 48 | 清零 |
| main_loop_cnt | 0x4c000458 | 4 | 清零 |
| trace_log_write_count | 0x4c000460 | 4 | 清零 |
| trace_log_missing_count | 0x4c000468 | 4 | 清零 |

用网页本身的 `Elf` / `listSampleable()` 解析新 ELF，得到 DWARF 5、60 个自动采样项、2417 个跳过项。断言通过：上述七个对象全部落在非缓存区；六个零初始化对象位于启动清零范围；`last_status` 的初值与修改前 ELF 完全一致；每个对象均有自动采样项，而且采样项的地址和大小落在对应对象内。

JScope 中可直接搜索并勾选 `sys_tick`、`main_loop_cnt`、`trace_log_write_count`，以及 `gnetif.flags`、`last_status.enet_phy_link`、`desc.rx_frame_info.seg_count` 等成员。主循环正常运行时 `main_loop_cnt` 递增，日志调用增加 `trace_log_write_count`；`sys_tick` 按原来的定时回调递增，当前配置约 2 秒一次。网络配置和 PHY 状态在稳定运行时可能保持不变。

`_SEGGER_RTT` 新地址为 **0x4c00046c**。烧录新固件后，调试器/JScope/RTT 页面都应重新加载这一份 ELF；如果 RTT 转发地址框仍填写旧地址，应更新或清空后由 ELF 重新定位。没有烧录目标，也没有声称完成真机采样验证。

## 范围限制

迁移结构体不会递归迁移指针指向的对象。`gnetif.state` 所指的动态对象、TCP PCB、pbuf 等仍使用原来的内存池或堆，不能据此认为全部网络状态已非缓存化。

当前 JScope 页面没有手动输入采样地址/类型或数组表达式的入口，数组和指针项仍会被自动列表跳过。这次只修改例程布局，没有增加网页手动通道功能。

## 保留的核对材料

工作区 `tmp/tcpecho-nocache/before/` 保留六个源文件的修改前副本，`after/` 为实施时的修改版本。`tmp/tcpecho-nocache-build.log` 为构建日志，`tmp/tcpecho-nocache-check.json` 为 ELF 地址和自动采样项核对结果。
