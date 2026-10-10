# 内置 STM32 SVD

`STM32F103xx.svd` 是从 CMSIS-SVD 数据仓库下载的 STM32F103 系列外设描述文件：

<https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/STMicro/STM32F103xx.svd>

调试器的 SVD 页提供 STM32F103、STM32H743、STM32H750 三个内置型号；用户仍可以载入兼容 CMSIS-SVD 的 `.svd` 文件。F103 文件的版权和许可信息以来源仓库为准。

H743 / H750 来自 [Arm Keil STM32H7xx_DFP 4.1.3](https://www.keil.arm.com/packs/stm32h7xx_dfp-keil/)，固定到官方仓库标签 `v4.1.3` 的提交 `4c77d2ffa6e885b6da9d6fe949c2d6070b21fe7d`：

- [STM32H743.svd](https://github.com/Open-CMSIS-Pack/STM32H7xx_DFP/blob/4c77d2ffa6e885b6da9d6fe949c2d6070b21fe7d/CMSIS/SVD/STM32H743.svd)，XML 版本 1.9。
- [STM32H750.svd](https://github.com/Open-CMSIS-Pack/STM32H7xx_DFP/blob/4c77d2ffa6e885b6da9d6fe949c2d6070b21fe7d/CMSIS/SVD/STM32H750.svd)，XML 版本 2.3。

两份 H7 文件保留 STMicroelectronics 2024 版权及 Apache-2.0 许可头。解析器展开外设 `derivedFrom` 继承：H743 为 122 个外设 / 2946 个寄存器，H750 为 122 个外设 / 3067 个寄存器。

`.svd.gz` 为按 LF 规范化后的压缩副本，现代 Chrome / Edge 通过原生 `DecompressionStream` 解压；不支持时读取原 XML。文件只在选择型号时加载，不进入首屏合并脚本。压缩体积：F103 32,696 B，H743 195,801 B，H750 236,478 B。更新 XML 后运行 `node tools/dev/build-svd.mjs`；`npm run build:web` 也会生成压缩副本。

“运行中也刷新”只读取当前选择的寄存器及位域；变化高亮和自动读取约束见 [调试器说明](../../../docs/dbg-page.md)。
