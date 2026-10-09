# 2026-10-09 主线合并回归

Web 主线从 `52f02e6` 快进合并至 `ed9af6d`，完整纳入 `codex/swo-pc-trace` 的 14 个提交，无冲突。固件主线从 `5d1e9af` 快进至 `0842761`，纳入 UART 默认 240 MHz 与 SWO 接收时钟租约的 2 个提交。

## 主目录验证

Web 检查在 `E:/web-serial-rtt-tools` 执行；8911 静态服务已切换到该目录，浏览器使用专用 9345 会话。未连接实物探针、未烧录目标。

- `make check test test-swo` 全部通过，包含 95 个离线测试脚本。
- 352 个模块语法检查及 Markdown 检查通过。
- 回归包括探针协调和释放、ADC/DAC、RTT、JScope、ARM/RISC-V 调试与异常、HPM porting 与烧录、SPI/I2C，以及 SWO 解码、导出、时钟、失败恢复、取消设置和历史采样记录兼容性。

| 浏览器回归 | 结果 |
|---|---|
| 调试器 | 156 通过 / 0 失败 |
| JScope | 100 通过 / 0 失败 |
| SPI/QSPI 桥 | 169 通过 / 0 失败 |
| SPI/QSPI 屏 | 182 通过 / 0 失败 |
| I2C | 147 通过 / 0 失败 |
| 四页侧栏 | 23 通过 / 0 失败 |
| SWO 页面 | 43 通过 / 0 失败 |
| ADC/DAC 连接状态 | 7 通过 / 0 失败 |
| SPI 转发 | 启停、连接按钮、接线、CDC 显示／记录均通过；4,915,200 字节收录一致 |

有计数的页面检查合计 827 项；SPI 转发检查另计。测试产生的非必要截图变化已还原，保留原有验收截图。

固件在 `E:/Share/github/akaLinkPro` 执行 `make build-app test-host`，编译和全部生产 C 主机测试通过。默认时钟选择仍为 UART 240 MHz／最高 30 Mbaud，不修改 PLL0 根频率或 CPU 时钟。主目录重新生成的 ELF 随固件回归报告保存。固件包签名、长度、CRC 均正确。

## Worktree 清理

删除前确认分支均已被主线包含且无未提交改动。保留分支历史，备份全部被忽略的本地文件：

| Worktree | 备份位置 | 文件 / 字节 |
|---|---|---:|
| Web SWO | `E:/worktree-archives/2026-10-09-merge/web-swo` | 680 / 225,883,443 |
| 固件 UART | `E:/worktree-archives/2026-10-09-merge/firmware-uart` | 408 / 50,926,293 |

每个备份文件均做复制前后 SHA256 核对，清单为备份目录下的 `backup-manifest.json`。原始采样、Flash 备份、日志与构建文件均保留。固件主目录预先存在的 `.zcodeignore` 未修改。

清理已完成：Web SWO worktree 已删除，固件 UART worktree 已通过 Codex 归档并移除工作目录。两个仓库的 `git worktree list` 均只剩各自主目录；原分支和固件可恢复归档仍保留。

完整日志位于 Web `tmp/merge-20261009` 和固件 `build/merge-20261009`。本次为本地主线合并与验证，未推送远端。
