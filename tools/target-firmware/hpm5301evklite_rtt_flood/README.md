# HPM5301EVKLite RTT 吞吐靶子

连续写入 `hello world!\n`，RTT 上行缓冲使用 `BLOCK_IF_FIFO_FULL`。主机读取速率就是目标 RTT 通道的实际交付速度。HPM5301 没有 D-cache，RTT 控制块和 32 KiB 上行环位于默认 DLM `.bss` 中；页面使用 ELF 的 `_SEGGER_RTT` 符号定位控制块，不需要猜地址。

构建：

```powershell
pwsh -File tools\target-firmware\hpm5301evklite_rtt_flood\build.ps1
```

烧录并运行：在烧录页选择 HPM5301EVKLite，载入本目录 `fw.elf`。之后从 RTT Viewer 或 RTT 转发页加载同一 ELF，控制块起点由 ELF 自动解析。目标侧 `g_bytes`、`g_loops`、`g_hclk_mhz` 可用于确认产速和实际 CPU 主频。
