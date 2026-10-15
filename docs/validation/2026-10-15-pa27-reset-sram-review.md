# PA27 复位修正、SRAM 测速与网页验收

验证编号：`20261015-2145-pa27-correction-accepted-280mhz`。

- Tested-Revision: pre-commit-worktree
- Tested-Base: 734f83d0d43c2a91eb56a4d7b8e8ce0da5c84811
- Tested-Dirty: true
- Validation-Result: passed（功能）；高速 SWD 上限未验收。

## 功能与 Review 修正

| 问题 | 修正 |
| --- | --- |
| 旧开关控制 PA08，和 PA27 可切换的要求相反 | 顶栏改为 NRST 开漏；HID 能力 bit2 确认 PA27 新映射，旧固件禁用控件，防止含义反转 |
| 切模式失败后实际状态不确定 | 禁用开关，重新查询后才能继续，不把猜测当作读回 |
| HID 响应截短仍可能被接受 | 检查长度、模式值；通用“不支持”响应仅用于新 RESET_IO 请求，不放宽其他在途命令匹配 |
| 全局硬复位必须先连通目标 SWD | 只认领 USB 并启用复位输出，即可发送脉冲，不依赖 CPUID／内存访问成功 |
| 把 SWJ_Pins.wait 当成脉宽 | 两条命令间实际保持拉低至少 20 ms，失败也尝试释放；wait 仅用于释放匹配等待 |
| 复位后文案直接宣称目标已运行 | 改为“脉冲已发送”，说明 NRST 接线要求；真正复位由硬件验收的 PC、VCATCH、PINRSTF 判断 |
| SRAM 只校验最后一次读回 | 每轮写不同图案、逐轮读回校验；所有计时读取也校验，校验耗时不混入方向吞吐 |
| 测速先显示成功，再尝试恢复／关闭 | 运行状态读取失败时禁止写 RAM，恢复或关闭失败不报成功；成功信息在收尾之后显示 |
| SRAM 测速锁死在 1 MHz 且使用小块多次往返 | 增加独立 SWD 档位与自动模式；支持时使用 atomic TAR+TransferBlock、最多四笔 FIFO，保持 1 KiB 地址边界并校验所有命令、ACK、计数和长度；不改变普通调试和烧录访问方式 |
| PA27 已保留，网页 SPI 仍显示可选 | 辅助脚选项和共用引脚图同步禁用，旧配置会回退为“不用” |

自动档某档任一轮失败，会记录错误、回到 1 MHz 恢复调试口、确认 CPU 仍暂停，然后在更低档重做完整测试；失败样本不进入最终速率。手选档失败则直接报错，不悄悄换档。控制寄存器和 CPU 恢复使用 1 MHz。测试区仍按用户要求覆盖且不备份，支持 20、32、64、128 KiB。

## 真实网页验收

探针为 HPM5301EVKLite akaLinkPro，目标是用户新烧入的 H7B0 280 MHz 固件。PA27→NRST，PA08→TRST。Chrome 页面 `http://127.0.0.1:8899/index.html?modules=bundle#flash` 使用最终生成的发布包；USB 和 HID 都经真实浏览器授权，没有模拟数据。

- 网页模式开关：推挽、开漏设置及 HID 回读通过，能力位 `0x07`。
- 两种模式的复位：复位前目标运行；Reset Vector Catch 捕获到 PC=`0x080002c8`，对应复位向量。DHCSR=`0x00030003`、DFSR=`0x0b`，清除旧标志后 RCC_RSR=`0x00400000`（外部 NRST）。测试恢复 DEMCR 并继续运行。
- 连续三次全局复位通过。最终 `flash.busy=false`，探针租约／失败列表为空，顶栏回到“探针：未使用”，页面异常列表为空。
- SRAM 地址 `0x24080000`，各长度三轮写、逐轮校验，以及三轮计时读取均通过：

| 长度 | 最终 SWD 档 | 读 MB/s | 写 MB/s |
| --- | --- | --- | --- |
| 20 KiB | 36 MHz | 1.63 | 1.64 |
| 32 KiB | 20 MHz | 1.19 | 1.17 |
| 64 KiB | 20 MHz | 1.20 | 1.19 |
| 128 KiB | 20 MHz | 1.19 | 1.19 |

这些是当次校验通过的窗口，不是高档长期稳定性保证。各失败档位和原始计时全部保留在 JSON 中。用户决定次日换板测上限，本次不再继续性能排查。

PA08 接 TRST 只能复位 JTAG TAP，不能代替 NRST。上一份报告通过读回 CPUID 推断系统复位，证据不足；本次以 PC／VCATCH／PINRSTF 的结果更正它，不改写旧报告。`SWJ_Pins` 当前固件回读的是输出锁存位，不代表目标实际重启；本次未用示波器逐路测电气波形。

## 自动回归与发布包

工作目录 `E:/web-serial-rtt-tools`。实际执行并通过 12 个离线入口：

`reset-io-protocol.test.mjs`、`reset-io-ui.test.mjs`、`sram-bench.test.mjs`、`sram-transfer.test.mjs`、`target-reset.test.mjs`、`flash-sram-flow.test.mjs`、`flash-lifecycle.test.mjs`、`probe-manager.test.mjs`、`hid-channel.test.mjs`、`hid-proto.test.mjs`、`spi-proto.test.mjs`、`spi-panel-code.test.mjs`（均位于 `tools/selftest/`，使用 `node` 执行）。

覆盖新旧模式映射、截短响应、引脚脉冲保持与失败释放、64/512 B 包、1/4 深 FIFO、跨 1 KiB 地址、ACK／计数／回显／短包／stall、各轮数据损坏、状态读取失败、恢复／关闭失败、自动降档完整重测、资源仲裁与既有 SPI 协议。

发布输入在临时干净工作树 `E:/web-serial-rtt-tools-build-pa27-20261015` 从上述基线加本次源码构建，`npm run build:web` 与 `npm run check:web` 通过，165 模块。既有 DWARF duplicate-case 构建警告保留。本地原有 `app/rtt/dap-webusb.js` 未提交修改、AP discovery 自测和 ETM review 文档不属于本次改动，未混入提交／发布包。最终硬件验收使用发布包的页面功能；诊断脚本为核对寄存器也会动态加载本地 DAP 源码，源代码原有差异在输入快照中记录。

## 证据与复现

硬件脚本：`tools/selftest/reset-sram-hw.mjs`。实际命令：

```text
node tools/selftest/reset-sram-hw.mjs E:/web-etm-trace-coordination/artifacts/hpm5301evklite-reset-sram/20261015-2145-pa27-correction/accepted-280mhz
```

持久证据目录：`E:/web-etm-trace-coordination/artifacts/hpm5301evklite-reset-sram/20261015-2145-pa27-correction/`。最终结果为 `accepted-280mhz/web-hardware.json`，SHA256 `f8ad35db1d54511a84245e7593c8a6e213d093ac891cf8e5f7adaf9ca6dcbea0`；截图 `accepted-280mhz/web-acceptance-idle.png`。离线日志 `offline-accepted.log`，构建日志 `web-build-accepted.log`；其他证据指纹见 `accepted-evidence-sha256.json`。早期失败尝试保留在独立子目录，不作为最终通过数据。大证据不随 Git 推送，保存在该本机目录。

## 历史性能口径核对

akaLinkPro 的 `docs/upstream-speed-claims.md` 明确记录 H743 AXI SRAM：写 3421.9 KiB/s、读 2685.9 KiB/s，SWD 60 MHz、64 KiB、OpenOCD 自带计时、哈希校验通过；F103ZE 也有约 3 MB/s 的结果。`docs/validation/2026-10-08-h743-diagnostics.md` 另记录 H743 RTT 约 3.038 MB/s 短测，并记录长测异常。未找到对应的 H7B0 约 3 MB/s 已验收证据，不能将 RTT、主机 SRAM 和探针内部纯 SWD 基准混为一项。

当前高档错误在修改前的 2026-10-10 探针镜像中也出现，且原生 OpenOCD 对照也失败；这不足以认定具体电气原因或绝对排除所有性能回退。本次只交付功能和完整校验，后续换板再确认高速档。

配套固件已提交：`321487255d2ececea8d56282b07f3c7254e9862b`（akaLinkPro，PA27 模式修正）。`sram-clock-matrix.mjs` 最后版本只做语法检查；用户决定停止继续测速，未再执行该诊断入口。
