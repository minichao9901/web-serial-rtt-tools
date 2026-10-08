# SWO 实测离线示例

全部来自 STM32F103CB PB3 → probe VCOM RX → Web Serial 的真实记录，配套 ELF 为 `tools/target-firmware/stm32f103cb_swo/fw.elf`，源码位于同目录 `src/`。

- `f103cb-route-b.swopc`：5 秒，4096 周期，B 分支，PC + ITM 阶段标记，8,432 PC，无溢出。页面「载入 F103CB 实测示例」使用这一份。
- `f103cb-route-a-fast.swopc`：3 秒，1024 周期，A 分支，20,320 PC，无溢出。
- `f103cb-overflow.swopc`：3 秒，4096 周期，A 分支，额外启用异常事件，5,048 PC、78 个真实溢出包。用于验证缺口与分段显示。
- `delayed-boundary.json`：真实 ITM/DWT 延迟时间戳边界片段，保留不可唯一排序的样本作为回归依据。
- `acceptance-final.json`：最终五场景真机复测，另含 4 Mbaud / 256 周期高密度记录的统计和独立核对。原始高密度记录保留在测试工作区忽略目录。
- `acceptance.json`：四轮验收的参数、解析计数、GNU 行号交叉核对、阶段核对和原 Flash 恢复结果。另一组 PC-only 原始记录保存在测试工作区的忽略目录中。

在 SWO 页面打开记录、载入配套 ELF 和源码目录即可分析，不需要探针。保存的 ELF SHA256 保证示例与发布 ELF 配套。详见 [使用与实测说明](../../docs/SWO-PC-SAMPLING.md)。
