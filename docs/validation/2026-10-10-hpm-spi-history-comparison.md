# HPM 主从 SPI：历史对照、诊断修正与 80 MHz 验收

日期：2026-10-10。核对 akaLinkPro 工程中 2026-10-08 的原始 JSON、报告和发送端源码，并完成独立方向测试后，本轮以 **80 MHz、10.00 MB/s** 作为目标 Master → Probe Slave 转发路径的验收档位。旧回显测试的 20/40 MHz 通过档位不能当作探针或 HPM5301 的 SPI 上限。

## 本轮验收结果

目标和探针均为 HPM5301EVKLite，SPI 使用 PB10/11/12/13 一一对应连接并共地。目标发送采用 **32 KiB TX-only 循环 word DMA、CS 持续有效、变化载荷与连续序号**；探针使用 SPI Slave RX-only 循环 DMA，数据经 CDC/WebSerial 接收并校验。模式为 Mode 0、MSB first。

| 独立路径 | SCK | 测试窗口/数据量 | 实测结果 |
|---|---:|---|---|
| HPM Master → Probe Slave → WebSerial | 80 MHz | 10.011 秒；100,105,564 字节；1,564,150 帧 | 10.000 MB/s；载荷位错误、缺帧、乱序、坏帧、失步字节、探针丢弃、FIFO/DMA 错误均为 0 |
| Probe Master TX-only → HPM Slave RX-only | 10/20/30/40/60 MHz | 每档 128 × 256 B，共 32 KiB | 各档目标逐字节校验通过；位错误、目标 FIFO/DMA 错误、探针回复错误均为 0 |

80 MHz 档累计比较 **700,739,200 个载荷位**，观察到的载荷误码率为 0；目标 DMA 错误及缓冲补充超时计数也均为 0。吞吐按十进制 MB/s 计算，理论单线字节速率为 `80,000,000 / 8 = 10,000,000 B/s`，包含帧头和序号，并非全部为应用载荷。

该档目标实际时钟回读为 **PLL1CLK0 800 MHz / 5 = SPI 模块 160 MHz，SCLK 再 / 2 = 80 MHz**。探针从机模块仍为 240 MHz。目标只选择已有时钟源与整数分频，没有修改 PLL 参数或 CPU 主频；SCK 数值来自配置及回读，没有示波器测量。

验收使用 **64 KiB WebSerial 接收缓冲**，生产页面默认 4 KiB 缓冲未修改，也未在本轮重新验证其 80 MHz 表现。以上结论限定于记录中的测试窗口和配置，不代表全双工回显、无限时长或所有接线条件均已通过。用户确认达到 80 MHz 已满足需求，停止继续提速；目标发送、探针转发、串口及调试会话均已停止。

原始记录：

- [80/83.333/90 MHz 边界测试](2026-10-10-hpm-spi-rx-boundary.json)
- [独立 MOSI 接收校验](2026-10-10-hpm-spi-mosi-only.json)
- [40～120 MHz 初步扫描](2026-10-10-hpm-spi-rx-sweep.json)
- [83.333 MHz 延长测试](2026-10-10-hpm-spi-rx-soak.json)

## 更高档位的观察与限制

40/60/62.5/66.667/72/75/80 MHz 的约 3 秒初步扫描均通过。83.333 MHz 在约 10 秒窗口中通过，实收 10.417 MB/s；但延长至约 30 秒时出现 **13,804 字节探针丢弃、364 个序号缺口、33 个坏帧和 9,286 个失步字节**，因此不能作为持续可靠档位。该窗口 FIFO/DMA 错误和目标补充超时仍为 0。

83.333 MHz 延长记录中比较器累计报出 1,168 个载荷位差异，但已有丢弃和失步，不能将它直接解释成 SPI 物理误码率，原始记录的 `payloadBER` 为 `null`。90/100/120 MHz 测试也未通过完整性校验；吞吐数字不构成通过证据。更高频率下的接收时序、转发负载及缓冲因素未继续分离，本轮不判定芯片的硬件极限。

## 已验证的历史能力

固定 SPI2 模块时钟 240 MHz 的改动提交为 `ac3fc16`（2026-10-08 12:03:55 +0800）；TX word DMA 优化提交为 `ee08748`（同日 07:23:10）。

| 历史路径 | 时钟/模式 | 主机实测速率 | 原始数据中的完整性证据 |
|---|---|---:|---|
| Probe Master → 单线屏协议发送 | 60 MHz，32 KiB 批次 | 6.290 MB/s | 20 张图、5,840 帧；framesErr/outOverrun/inDrop 均为 0 |
| Probe Master → 四线屏协议发送 | 60 MHz，32 KiB 批次 | 16.766 MB/s | 20 张图、10,580 帧；上述错误均为 0 |
| H743 Master → Probe Slave → 原生 CDC | 标称 60 MHz，Mode 0 | 7.532 MB/s | 15 秒、1,765,434 帧；载荷位错误/缺帧/失步/窗口丢弃/FIFO/DMA 错误均为 0 |
| 同上 | 标称 66 MHz，Mode 0 | 8.286 MB/s | 15 秒、1,942,123 帧；上述错误均为 0 |
| 同上 | 标称 67 MHz，Mode 0 | 8.412 MB/s | 15 秒、1,971,638 帧；上述错误均为 0 |
| H743 Master → Probe Slave → WebSerial | 标称 60 MHz，默认 4 KiB 缓冲 | 7.531 MB/s | 30 秒、3,531,076 帧；缺帧/失步/窗口丢弃/FIFO/DMA 错误均为 0 |

屏协议测速 JSON 明确写有 `displayAttached=false`，因此这份记录证明了主机发送执行和吞吐量，未在屏端逐位核对。H743 接收记录则具有变化载荷、连续序号及实际数据校验，能证明探针 SPI Slave RX 在这些有限窗口中可靠接收。H743 SCK 是 HSI/PLL 配置的标称值，没有示波器频率读数。

原始来源位于 akaLinkPro 仓库：

- `docs/validation/2026-10-08-spi-fixed240.md`
- `docs/validation/2026-10-08-spi-fixed240/images.json`
- `docs/validation/2026-10-08-spi-fixed240/cdc-native.json`
- `docs/validation/2026-10-08-h743-spi-cdc/h743-web-60.json`
- `docs/validation/2026-10-08-h743-spi-cdc.md`

## 早期回显测试与历史路径的差异

1. 早期 HPM 主机转发夹具把 SCK 固定为 **10 MHz**。它每次生成 512 字节、启动一次全双工 DMA、等待完成并翻转 CS；没有像 H743 那样用 32 KiB 循环 DMA、word 打包和连续 CS 流。1.201 MB/s 接近 10 MHz 的 1.25 MB/s 线速，仅表示该档位通过，不能作为吞吐上限。后续更换为连续 TX-only 夹具后，已验证到 80 MHz。
2. 早期高频爬升使用 **Probe Master ↔ HPM Slave 的全双工回显**。历史屏发送是 TX-only word DMA，历史 H743 转发是 Probe Slave RX-only 循环 DMA，两者都没有检验目标 Slave TX/MISO 或探针 Master RX 这条新增方向。
3. 生产 Probe 全双工事务使用 TX 字节 DMA加 CPU 轮询 RX；屏 TX-only 满足对齐条件时使用 DATAMERGE/word DMA。不能用屏发送吞吐直接替代全双工接收性能。
4. 回显靶每笔 256 字节重新初始化 SPI、重新挂 RX/TX DMA并交换缓冲。20 MHz 的 batch=16 紧密突发仅 8/128 帧正确，显示当前靶的事务间准备存在问题；这个失败不能代表使用连续循环 RX DMA 的探针从机能力。
5. Mode 0 的部分失败集中在返回帧首字节的 bit 6，Mode 1 同速率通过。这曾提示首字节准备/CS 与采样边沿时序，但后续改变硬件 CS 策略、尝试 word DMA 后仍未解决完整回显失败，不能据此确认具体责任方。

## 已完成的诊断修正与剩余问题

已完成连续 TX-only 循环 DMA 发送夹具、时钟与分频回读、变化载荷及序号校验，并验证 Probe Slave 接收转发达到 80 MHz。独立 MOSI 测试也证明 Probe Master TX-only 与 HPM Slave RX-only 在 60 MHz 下可正确收发，旧全双工回显失败不能归因于这一独立方向的 60 MHz 硬件上限。

全双工回显仍有未解决的问题：硬件 CS 和 word DMA 尝试没有使 60 MHz 回显通过；同时 RX/TX 时目标接收缓冲也出现差异，与独立 RX-only 通过形成对照。现有证据尚未分离目标同时 RX/TX、事务重挂、Slave MISO 输出及 Probe Master RX 的影响。独立 MISO 夹具已编译，但未进行实机验证；按用户要求，本轮到 80 MHz 收工，不再继续定位。

诊断尝试记录：[硬件 CS 对照](2026-10-10-hpm-spi-hardware-cs.json)、[全双工 word DMA 对照](2026-10-10-hpm-spi-word-dma.json)、[60 MHz 全双工目标接收缓冲检查](2026-10-10-hpm-spi-word-mosi-60.json)。

上轮“60 MHz 目标从机采样裕量不足”的判断撤回。当前可交付结论是 **连续单向转发 80 MHz 通过、独立 MOSI 60 MHz 通过**；完整回显的失败原因仍未确认，不能推导为控制器输入采样或线缆信号完整性问题。
