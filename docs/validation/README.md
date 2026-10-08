# 验证记录索引

按日期排列，新的记录放在后面；每份记录只写事实、判据和复现入口，避免把临时排障日志
误当成当前基线。

| 日期 | 记录 | 内容 |
| --- | --- | --- |
| 2026-10-04 | [`2026-10-04-f103cb.md`](2026-10-04-f103cb.md) | F103CB 多轮真机验证、调试压力和随机场景 |
| 2026-10-05 | [`2026-10-05-rtt-viewer-comparison.md`](2026-10-05-rtt-viewer-comparison.md) | F103ZE 609–616 KB/s 基线与 F103CB 杜邦线差异 |
| 2026-10-05 | [`../真机基准测试.md`](../真机基准测试.md) | 活动板卡场景基准的长期判据和历史数据 |
| 2026-10-05–06 | [`2026-10-05-hardware-test-results.md`](2026-10-05-hardware-test-results.md) | F103CB、H743、HPM6800EVK 真机结果；含 H743 栈帧矩阵、ADC 矩阵、6800EVK 最新 full flow 与 RISC-V 调试器覆盖边界 |
| 2026-10-06 | [`2026-10-06-ui-review.md`](2026-10-06-ui-review.md) | UI 逐项审核、修正前后截图，903 项页面/渲染/布局检查，1600/1280 下全部 12 页 |
| 2026-10-07 | [6800EVK SBA / 复位](2026-10-07-hpm6800evk-sba-reset.md)、[调试器操作](2026-10-07-debugger-usability.md) | SBA 状态与 SDRAM 初始化边界、命令滚动、函数尾行 next、RTT 清空 |
| 2026-10-07 | [RTT 突发流量](2026-10-07-rtt-cdc-burst-freeze.md) | 高流量接收与渲染阻塞的定因、修复及回归 |
| 2026-10-07 | [Cache 对照](2026-10-07-hpm6800evk-jscope-cache.md)、[tcpecho 非缓存区域](2026-10-07-tcpecho-jscope-nocache.md)、[数组元素](2026-10-07-jscope-array-elements.md) | 变量可见性、固件与 ELF 对应关系、结构体和数组采样 |
| 2026-10-07 | [速率与跳点审计](2026-10-07-jscope-rate-and-spikes.md)、[F103CB 优化](2026-10-07-f103cb-hss-optimization.md)、[F103ZE 复测](2026-10-07-f103ze-hss-rate-policy.md) | 修订推荐公式，区分读取标定、调度跳拍与 USB 丢样 |
| 2026-10-07 | [HPM6800EVK HSS](2026-10-07-hpm6800-hss-rate.md) | RISC-V 有界批次、网页预读覆盖与多字段非原子边界 |
| 2026-10-08 | [SPI 发图通路](../spi-image-rate-2026-10-08.md)、[SPI转发回归](2026-10-08-spi-cdc-regression.md) | 发图吞吐、SPI转发与既有服务并发回归 |
| 2026-10-08 | [探针固定 240 MHz 验证](https://github.com/minichao9901/5301evk_akaLinkPro/blob/main/docs/validation/2026-10-08-spi-fixed240.md) | H743 高频转发、实际 SCK 分频、SPI/QSPI 吞吐与 Web 缓冲对照 |

## 当前推荐顺序

1. `make check` + `make test-board-matrix`
2. `make test-offline`
3. `make rebuild-all-examples`
4. 当前板卡对应的 `make board-check-*`
5. `make hw-campaign-*` 或 `make full_flow_*`；F103CB / H743 / HPM6800EVK 的 full flow 会附带随机顺序压力阶段

活动板卡、例程和唯一 ELF 路径见 [`tools/target-firmware/CONTRACT.md`](../../tools/target-firmware/CONTRACT.md)。
真机结果写入 `tmp/`，提交时只把经过复核的判决和原因整理到日期记录中。
