# RTT 转发速率：与 akaLinkPro 记录对照 + 页面版本 A/B（2026-10-16）

**结论：转发没有退化，也没有被近期新功能拖慢。** 在**同一块 F103ZE、同一个 akaLinkPro 探针、同一会话**
下，用专用口径（页面 RX 计数 `stream.rxc.total` + 探针自报 `moved`，每档 3 个 8 s 窗口）实测：

| 配置（页面版本 / CDC 缓冲） | 45 MHz 档 | 60 MHz 档 |
| --- | --- | --- |
| 历史基线页面 `60258a0`（2026-10-04，当年就是 4 KiB 缓冲） | 2.575 MB/s | **3.045 MB/s** |
| 当前 HEAD（RTT owner 64 KiB 缓冲） | 2.577 MB/s | **3.046 MB/s** |
| 当前 HEAD + 运行时强制 4 KiB 缓冲 | 2.577 MB/s | **3.046 MB/s** |
| 当前 HEAD，且先跑 6 s RTT Viewer 再转发 | 2.576 MB/s | — |
| **akaLinkPro 记录（端到端，探针侧交付）** | 2512 KiB/s = **2.572 MB/s** | 2954 KiB/s = **3.025 MB/s** |

- 45 MHz 档：2.577 vs 记录 2.572 → **+0.2%**
- 60 MHz 档：3.046 vs 记录 3.025 → **+0.7%**
- 页面版本差异：**0.03%**（3.045 vs 3.046）；CDC 缓冲 4 KiB vs 64 KiB 差异：**0**；
  先跑 Viewer 再转发：无影响（同档位下 2.576 vs 2.577）。
- 探针自报 `moved` 与页面 RX 在稳态下一致（差 ≤0.1%）：60 MHz 3.043~3.045 vs 3.045~3.046。

## 为什么上一轮的表里写着"−4% / −12%"

上一轮用的是 **campaign 流程内的数字**（`make hw-campaign-f103ze` 的 1b 段）：

| 口径 | 60 MHz | 45 MHz |
| --- | --- | --- |
| campaign 流程内：页面 RX | 2.90 MB/s（−4.1% vs 记录） | 2.46 MB/s（−4.4%） |
| campaign 流程内：探针 `moved` 差值 | 2.64~2.65 MB/s（−12%） | 2.25 MB/s（−12.5%） |
| **专用口径（本报告）** | **3.046（+0.7%）** | **2.577（+0.2%）** |
| 专用口径下的 `moved` | 3.043~3.045（≈RX） | 2.574（≈RX） |

两条原因：

1. **`moved` 差值不是可靠口径**：它来自页面轮询到的 HID 状态快照（`hid.last.moved`）。
   在 campaign 的短窗口里它可能落后于页面 RX；专用口径下两者一致，说明那 −12% 是取数问题。
2. **campaign 流程内的速率系统性偏低约 4.7%**（两个档位都一样：2.46/2.58、2.90/3.05）。
   本轮排除了以下原因：页面版本（基线 vs 当前）、CDC 缓冲（4 K/64 K）、窗口起点（0.8 s / 2 s）、
   先跑 Viewer 的顺序、档位混淆（同档位比较）。**仍属未定位的测量上下文差异**，
   留作后续；注意 campaign 的判决门限因此是**偏保守**的（本轮 full flow 仍 20/20 通过）。

## 关于「近期新功能」的两个具体疑点

1. **CDC 接收缓冲 4 KiB → 64 KiB**（提交 `9ed755c`，2026-10-10，`app/serial/session.js`
   `bufferSize: opts.owner === 'rtt' ? 65536 : 4096`）：当年那条注释写着"64 KB 在 2.9 MB/s 打流时
   会把整页冻住"，本轮实测**没有复现**——强制 4 KiB 与 64 KiB 的转发速率、窗口稳定性完全一致
   （3.046 / 3.046；三个窗口各自 3.046）。读循环每 8 ms 让出事件循环的写法应当是它不再卡住的原因。
2. **上午那批审查修复（F01–F13 / D01–D14）**：基线页面 vs 当前页面的 A/B 是 3.045 vs 3.046，
   没有任何回归迹象。

## 口径与证据

- 靶子固件：`tools/target-firmware/stm32f103_rtt_speed/build-ze/fw.elf`（96 MHz，RTT 上行 32 KiB）。
- 探针：akaLinkPro（0D28:0204），SWD 档由探针固件决定（本轮 45/60 MHz 都测到）。
- 页面：`http://127.0.0.1:8899/index.html`（当前 HEAD，发布包入口）与
  `http://127.0.0.1:8899/tmp/base-20261004/index.html`（`git worktree` 固定到 `60258a0` 的历史版本）。
- 脚本：[fwd-rate.mjs](fwd-rate.mjs)（`--app= --label= --clock= --windows= --force-buffer= --viewer-first= --ramp-ms=`），
  结果汇总：[fwd-summary.json](fwd-summary.json)，逐次原始数据：`fwd-*.json`。
- 记录来源：`E:/Share/github/akaLinkPro/README.md`「实测性能」表 +
  `E:/Share/github/akaLinkPro/docs/development-history.md`（2026-09-30 基线）。
