# HPM5301EVKLite SPI2 从机回显靶子

供 `USB→SPI/QSPI` 通用总线页验证真实探针 SPI 转发。探针端 HPM5301EVKLite 的 SPI2 为主机；目标端 HPM5301EVKLite 的 SPI2 作为从机，使用 Mode 0、8 位全双工。目标首个 256 字节事务返回固定签名；每次事务结束后，它把收到的 MOSI 数据作为下一次事务的 MISO 响应。

请按同名信号连接两块板并共地：PB10↔PB10（CS）、PB11↔PB11（SCLK）、PB13↔PB13（MOSI）、PB12↔PB12（MISO）。不要把 PB12 和 PB13 交叉；探针侧 MOSI 是 PB13，目标侧 MISO 是 PB12。

构建：

```powershell
pwsh -File tools\target-firmware\hpm5301evklite_spi_echo\build.ps1
```

使用烧录页选择 `HPM5301EVKLite` 和生成的 `fw.elf`。连接 USB→SPI/QSPI 页后设 Mode 0、SCLK 10 MHz 并使能。自动真机测试：

```powershell
node tools\selftest\spi-hpm5301-hw.mjs --sclk=10 --frames=64
```

脚本先用两笔事务同步回显状态，再逐笔发送 64 个 256 字节全双工事务，逐字节核对 MISO 与上一笔 MOSI。逐笔往返给从机留出片选间重新装载 FIFO 的时间。HPM5301EVKLite 实测 10 MHz 为 64/64 帧正确、探针协议错误为 0。20 MHz 在此中断服务型靶子上出现重复/错位字节，因此当前验收基准定在 10 MHz；20 MHz 的失败不能单独证明探针本身达不到该速率，若要测更高速率，需要改用 DMA 靶子并验证信号完整性。测试吞吐包含浏览器/USB 逐笔往返开销，不代表 SPI 线速。

速率选项与探针实际配置回读一致后才开始数据校验。可用 `--sclk=10,20,40,60,75` 手动进行上限探索；脚本会在首个错误档停止并返回失败。

调试器可观察 `g_spi_magic`（`0x53504945`）、`g_spi_frames`、`g_spi_errors`、`g_spi_last_bytes` 与 `g_spi_clock_hz`。它们位于 HPM5301 DLM 的 `.noncacheable.bss`，地址以 ELF 符号表为准。靶子使用中断补充 SPI FIFO，并交换 TX/RX 缓冲区，避免从机等待或复制数据造成连续帧漏收。
