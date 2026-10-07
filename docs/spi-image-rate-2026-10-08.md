# SPI/QSPI 的 BMP 发图实测（2026-10-08）

在实际 Chrome/WebUSB 页面与 HPM5301EVKLite 探针上，先测 AXS15352，再测 ST77916。没有接屏，结果验证发送及探针执行，不代表显示效果或屏端最高时钟。

主要限制已定位到探针的 SPI TX DMA：原路径每次搬一个字节；对齐的 TX-only 数据改为 word DMA，并开启 SPI DATAMERGE 自动拆为四个字节。短包、非整字尾包、非对齐、RX/全双工及轮询仍用字节路径。Web 帧协议及 CS 行为保持兼容。

| 整屏 BMP，60 MHz、32 KiB USB 批量 | 原固件 MB/s | 优化后 MB/s | 含页面处理的操作速度 MB/s |
|---|---:|---:|---:|
| AXS15352，240×296、单线 SPI＋DC | 5.90 | 6.18 | 4.53 |
| ST77916，360×360、四线 QSPI | 7.14 | 16.36 | 9.33 |

每组预热 2 张，再发 20 张；MB 按 1,000,000 字节。较长的 100 张测试中，QSPI 约为 12.50 MB/s（8 KiB 批量）／15.00 MB/s（32 KiB 批量），两屏合计发 400 张，错误和溢出增量均为 0。F103 捕获实际 SPI 输出 1500 字节，逐字节相同。

`lastRun.ms` 在像素转换后开始，包含帧打包、USB 发送及最后响应；`wallMs` 覆盖整个 `sendImage()`，另含像素转换、预览和末尾 HID 查询。BMP 初次载入的解码单独测量，不能将这些速度混用。脚本的 CPU 分段计时、USB 提交次数、完成计数和全部逐张数据都有保留。

60 MHz 单线数据上限 7.5 MB/s，四线为 30 MB/s。当前桥不执行 SPI、只收并解析完整 PING 槽时约 18–19 MB/s；这不是 USB HS 总带宽上限或 CDC 测速。下一步余量主要在探针逐 512 字节的 USB 完成／重武装、逐片 SPI 设置，以及网页逐张转换、预览和状态查询。

完整报告与原始数据位于 akaLinkPro 工程的 `docs/validation/2026-10-08-spi-image-rate/`。探针最终固件已编译和烧录，APP ELF SHA256：`72e21b69e9951289a9f890a613b26c4dfe3582206b136a76ee9f7f9d882190b4`。

复现前先停止其他探针会话，授权浏览器设备并启动本地服务：

```powershell
make test-spi-image-rate-hw ARGS="--out=tmp/spi-image-rate.json --rounds=20 --clocks=40,60 --batches=8192,32768"
```

脚本走生产页面的 `pickImage()` 和 `sendImage()`，关闭局部更新，生成对应屏尺寸的真实 24-bit BMP，并用末帧响应与累计计数检查实际完成。结束后恢复原配置和档位、关闭桥并释放设备句柄。`--full-panel=false` 使用 240×296 窗口，便于复现早期同尺寸时钟／批量矩阵。32 KiB 批量可提高 QSPI 长测速度；本轮没有改变页面默认值。
