# 三个 worktree 合并与验收（2026-10-09）

主目录、F103ZE 异常诊断分支和 HPM porting 分支已合入 `main`。完整离线测试、10 组浏览器页面回归以及 F103ZE 实板回归通过；原固件已恢复，所有其它 worktree 已删除，只保留主目录。

## 合并范围

| 来源 | 提交 | 保留的工作 |
| --- | --- | --- |
| 原主目录未提交 UI 改进 | db5b90f | 紧凑工具导航、7 个常用工具与 6 个更多功能、可调列宽、寄存器与监视变化高亮、工作区布局 |
| codex/f103ze-fault-diagnostics | 7a8d353；合并 e3c7151 | F103ZE 异常夹具、8 场景验收脚本、源码定位、现场只读判据和原固件恢复记录 |
| codex/hpm-target-porting | 4633d54；合并 ef3e66d | HPM 目标 port、10 个 SDK 板型配置、共享烧录/调试入口、ARM 回归与 RTT/JScope/SPI 对照记录 |

两个分支以保留历史的 merge 提交合入。唯一文本冲突为 build 标识，统一为 `2026-10-09-r8`。自动合并后检查了调试器、RTT 与页面入口，确认 inspector 和 HPM 选择器同时保留。

## 验证及修复

- `make test-offline`：整套通过，包含板型矩阵、HPM port、模拟烧录、ARM/RISC-V 调试与协议测试。
- `make check`：319 个模块语法与 Markdown Liquid 检查通过；`git diff --check` 通过。
- 10 组真浏览器页面回归全部退出 0：inspector（29）、workspace（74）、layout（58）、HPM porting（10）、debugger（156）、JScope（100）、SPI bus（168）、SPI panel（179）、diagnostics、通用 UI（25）。括号为各套件打印的通过数；diagnostics 使用整体断言。
- 检查了 600/960/1280/1920 宽度的 inspector 与菜单截图。600 宽度下常用页签横向滚动条撑高顶栏，已隐藏该滚动条，仍保留横向滚动能力；600 宽度验收通过。
- JScope 和 SPI 的旧测试仍要求旧菜单排列，已改为核验新菜单中的实际位置和完整顺序。两个渲染测试先将其页面置于前台，避免后台标签页的 requestAnimationFrame 暂停使实时值断言失真；SPI 的实时值与迷你曲线断言保留并通过。

## F103ZE 实板结果

本轮先通过真实网页认板：DP IDCODE `0x1BA01477`、CPUID `0x411FC231`、DEV_ID `0x414`、512 KiB Flash。探针、COM5 和 SPI 接线沿用前一轮，探针固件未改动。

原固件下的 ARM 回归通过：选择 HPM5300EVK 后 ARM 后端仍正常连接；身份与 23 个寄存器读取、20 次暂停/继续、两次单步、断点安装/移除、HardFault 捕获开关恢复、只读异常快照均通过，完整 Flash 前后相同。

烧入匹配异常夹具后，8 个真实场景全部通过：UDF/MSP、除零、精确总线错误、PSP 带对齐填充、非对齐访问、PSP 无填充、处理函数序言展开、复位后重复捕获。每项均核对 CFSR/HFSR、原始 PC、栈帧和调用链；验证现场读取前后寄存器/SCB 不变、源码定位正确、DEMCR 恢复以及恢复计数未增加。

随后使用额定 72 MHz 的目标夹具做合并版转发烟测，每档正式窗口 8 秒，绘图开启：

| 项目 | 参数 | 合并版结果 |
| --- | --- | ---: |
| RTT 转发 | SWD 60 MHz，连续已知文本 | 2.535504 MB/s |
| JScope 单通道 | SWD 60 MHz，2.5 µs，u_hi | 399960.04 样本/s |
| JScope 三通道 | SWD 60 MHz，20 µs，u_hi/f_sin/i_tick | 49996.88 样本/s |
| SPI 转发 | 真实 SPI1→探针 SPI2→CDC，SCK 18 MHz | 2.250116 MB/s |

MB/s 使用十进制。本轮与[此前交替对照](2026-10-09-transfer-performance.md)的量级一致，仅做合并后的有限窗口复核，没有重新执行全部 A/B 轮次。

RTT 模式不匹配、读错、写错为 0；重复文本不检测整行遗漏。SPI 序号缺帧、乱序、载荷不匹配、FIFO/DMA 错误、丢弃及目标补环迟到均为 0。JScope 正式窗口 USB 丢样和读错为 0，单/三通道调度跳拍分别为 155/1，已知数值契约异常与序号倒退为 0；单通道整个会话在停止后仍显示 385 个 USB 丢样计数，不能把正式窗口的零值扩展为全程无损结论。

测试事务先读回完整 Flash 两遍确认一致，异常夹具最长 6144 B；最后恢复前三个 2 KiB 页并再次读回全部 512 KiB，逐字节一致。DEMCR 恢复 `0x01000000`，目标复位运行，网页与探针资源已释放。

原固件及恢复后 SHA256 均为：

`c2ed64c452949005c057cb0d0e58c1dde508e7296962022d4f88aabd56faba98`

本轮没有 HPM 实板，HPM 各型号仅使用已合入的 SDK 比对、算法构建与模拟验证，不能据此声称各型号硬件均已验证。

## worktree 清理与证据

已确认各来源没有未提交的 tracked/untracked 工作、其提交均为 main 的祖先，重要 ignored 文件先复制并再次核对源/目的 SHA256 后才清理。

- 已删除两个独立目录：`E:/web-serial-rtt-tools-f103ze-fault`、`E:/web-serial-rtt-tools-hpm-porting`。
- 已删除主目录 tmp 下两个干净的旧对照 worktree：`old-e5e3b66`、`old-f9dadcb`。
- `git worktree list` 只剩 `E:/web-serial-rtt-tools`。来源分支引用保留，已合入的提交历史仍可追溯。
- 主目录 `tmp/worktree-archive/20261009/` 保存固件原备份、调试证据、驱动和构建产物，共 1162 个文件、135780750 B；每个文件校验一致。浏览器缓存未保留，旧测试 profile 的 Preferences 单独保留。
- 本轮备份、恢复镜像、完整日志及驱动保留于主目录 `tmp/merge-20261009/`；UI 截图位于 `tmp/ui-inspector/`、`tmp/ui-workspace/`、`tmp/ui-review/after/`。这些忽略目录不推送原固件。

[机器可读验收记录](2026-10-09-worktree-merge-results.json)包含页面退出码、ARM 与异常判据、采集前后计数及原固件恢复/清理结果。
