# HPM6800EVK JScope 全零变量：真机缓存对照

日期：2026-10-07。设备：HPM6800EVK + akaLinkPro CMSIS-DAP，RISC-V/JTAG；固件为用户已运行的 `lwip_tcpecho` / `demo.elf`，不重新烧录。

## 结论

普通 SDRAM 中的热点计数器确实在更新，但 CPU 的 D-cache 新值没有写回 SDRAM。JScope 使用系统总线读内存，看到旧值。此问题不能用采样包数或长度正确来排除。

证据包含三个独立步骤：运行中直接 SBA 读、实际 JScope 采样、停核后对两条缓存行执行 SDK 定义的回写，再读取同一地址。单纯停核没有使这些值可见。

`errno` 正常情况下可能保持 0；`tcp_ticks` 也不是保证变化的校验量。本次明确验证的变化量为 `main_loop_cnt`、`trace_log_write_count`，以及不可缓存 RTT 控制块的 `WrOff`。

## 地址与真实采样

| 量 | 地址 | 用途 |
| --- | --- | --- |
| `sys_tick` | `0x4000b9f8` | 缓存回写对照 |
| `main_loop_cnt` | `0x4000ba08` | 主循环约每 200 ms 增加一次 |
| `trace_log_write_count` | `0x4000ba0c` | 日志写入计数 |
| `hpm_core_clock` | `0x4000ba14` | 非零常量校验，600 MHz |
| `RTT_WrOff` | `0x4c0003e4` | 临时加入当前页面的 u32 通道；RTT 上行 0 写指针 |

RTT 控制块在 `0x4c0003c0`，上行描述符 0 在 `0x4c0003d8`，`WrOff` 偏移 12。此地址经读取完整描述符确认，并非猜测外设地址。

第一轮真实 JScope：周期 1000 µs，时长约 3.019 s，3020 个样本、160 个包、零丢包。`sys_tick` / `main_loop_cnt` / `trace_log_write_count` / `tcp_ticks` 全为 0；`hpm_core_clock` 恒为 600000000；`RTT_WrOff` 从 3559446 增至 3584986，捕获 19 次变化。运行中独立 Web SBA 读取同样看到普通计数器为 0，RTT 写指针继续增长。

## 回写实验

通过 Web 调试器停核并核验 halted；读取 `MCACHE_CTL`（CSR `0x7ca`）为 `0x7f03`，D-cache 使能位为 1。

仅对 `0x4000b9c0` 和 `0x4000ba00` 两条 64 字节缓存行做写回，不失效、不禁用缓存。操作与 HPM SDK `l1c_dc_writeback` 一致：保存 `MCCTLBEGINADDR`（CSR `0x7cb`），指定缓存行地址，写 `MCCTLCOMMAND`（CSR `0x7cc`）命令 1（`L1D_VA_WB`），最后恢复地址 CSR。每次实验结束均继续运行目标。

| 值 | 运行中 / 停核后，尚未回写 | 第一次回写后 | 稍后第二次回写后 |
| --- | ---: | ---: | ---: |
| `sys_tick` | 0 | 506646 | 506646 |
| `main_loop_cnt` | 0 | 2531 | 2797 |
| `trace_log_write_count` | 0 | 48968 | 54068 |
| `hpm_core_clock` | 600000000 | 600000000 | 600000000 |

恢复运行 1 秒后，普通 SBA 读数仍停在刚写回的值，进一步说明总线读不会自动取得 CPU 缓存中的后续更新。`sys_tick` 第二次实验没有变化，不据此宣称它在本轮持续计时。

第二次回写后再次真实 JScope 采样：周期 1000 µs，约 3.006 s，3007 个样本、104 个包、零丢包。两个普通计数器恒为 2797、54068；常量为 600000000；`RTT_WrOff` 从 5239361 增至 5265592，捕获 20 次变化。页面保留这轮数据并切换分道显示。

## 处理建议与测试收尾

需要运行中观察的变量应放入板级 PMA 已配置的 noncacheable 区域，例如当前 RTT 控制块使用的区域。另一种方式是固件在合适位置主动对观察数据做 cache writeback。`volatile` 只影响编译器访问，不能解决 CPU cache 与调试系统总线的可见性。

禁止为了每个采样点隐式 halt/resume 或禁用 D-cache；这会改变目标运行和采样时序。对通用任意变量做 CPU 访问与系统总线访问的自动选择，需要另行设计其时序与使用约束。

选取硬件定时器作独立对照时，尝试了 `0xe6000000` 和 `0xf0088030`，遇到 SBA 超时。重连未恢复后，通过一次显式 reset + continue 恢复目标。本次结果不使用这些无效外设读取。后续测试只用已验证的 RAM 地址。未修改或烧录目标固件。

最终采样已停止、调试器已断开，目标运行。恢复原 RTT 转发和原 CDC 接收：1.2 秒内转发字节从 6573287 增至 6582994，CDC 接收字节同步增长 9707；`rdErr=0`。保留用户 ELF 和源文件映射、波形数据与本次选择的通道；周期/时长留为用于对照的 1000 µs / 3 s，暂停 CDC 选项保持未选中。

原始测试数据和截图保存在工作区 `tmp/jscope-cache-capture.csv`、`tmp/jscope-cache-capture.png`，详细读数在 `tmp/jscope-cache-proof.json`、`tmp/jscope-cache-proof-repeat.json` 和 `tmp/jscope-final-result.json`（tmp 不纳入 Git）。本轮没有修改生产代码。

SDK 对照来源：本机 HPM SDK v1.11.0 的 `arch/riscv/l1c/hpm_l1c_drv.c` / `.h`、`soc/HPM6800/HPM6880/hpm_csr_regs.h`、`hpm_soc_feature.h`、启动代码和板级 PMA 配置。在线对应 [HPM SDK L1CACHE 驱动 API](https://hpm-sdk.readthedocs.io/en/latest/api_doc/group__l1cache__interface.html)。
