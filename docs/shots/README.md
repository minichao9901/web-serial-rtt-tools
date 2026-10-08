# 产品主页截图

README 使用当前页面的原始截图，无图片后期修改。以下场景用于展示功能，不替代硬件性能验收。

| 截图 | 数据与场景 | 核对内容 |
| --- | --- | --- |
| [J-Scope](readme-scope-demo.png) | 内置模拟采样，正弦 / 斜坡 / 方波 | 逐点值、时间间隔、零缺口；[记录](readme-scope-demo.json) |
| [烧录器](readme-flash.png) | 真实 ELF 离线载入，未执行烧录 | 文件大小、地址区间和有效载荷；[记录](readme-flash.json) |
| [RTT 转发](readme-rttcdc.png) | 内置模拟 HID 控制与 DemoPort 日志接收 | 模拟串口与接收字节；[记录](readme-rttcdc.json) |
| [调试器](readme-dbg.png) | 模拟 Cortex-M、真实历史 ELF 与对应源码 | 源码行号、监视值与目标连接；[记录](readme-dbg.json) |
| [SPI/QSPI 发图](readme-panel.png) | 模拟探针与屏幕 GRAM，ST77916 四线色条 | 使能状态、259,200 B 像素载荷、零帧错误；[记录](readme-panel.json) |
| [ADC 示波器](readme-adc.png) | 虚拟 1 kHz / 1.8 Vpp 正弦，1.65 V 偏置，16 位、200 kSa/s | 自动频率 / 峰峰值，时间游标差 1 ms、电压差 1.8 V；[记录](readme-adc.json) |

调试器使用 [源码快照](../../tools/fixtures/readme/README.md)，避免将已演进的目标源码配给历史 ELF。模型只展示有限指令行为；截图中的变量初值由脚本写入模拟 RAM，不表示目标程序实际执行了这些赋值。

ADC 直接把量化后的虚拟信号注入 `AdcScopeStore`，沿用页面的触发、绘图、自动测量和游标流程；截图中的采样率是虚拟数据的时间轴参数，不是新一次硬件测量。

## 重新截图

前置：本地静态服务 8899、开启 CDP 的 Chrome / Edge 9333。脚本打开独立页面，完成后关闭，整个过程不连接、烧录或复位真实硬件。

```sh
node tools/dev/capture-readme-scope.mjs
node tools/dev/capture-readme-pages.mjs
# 也可只更新一个场景：
node tools/dev/capture-readme-pages.mjs adc
```

脚本位于 [J-Scope 截图工具](../../tools/dev/capture-readme-scope.mjs) 和 [功能截图工具](../../tools/dev/capture-readme-pages.mjs)。可通过 `PAGE_BASE` / `CDP_BASE` 调整服务地址。每张图旁保留 JSON，记录来源、视口与场景核对结果；脚本不隐藏报错或修改接收数据来美化结果。
