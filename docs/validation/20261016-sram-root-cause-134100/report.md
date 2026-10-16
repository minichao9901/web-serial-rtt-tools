# 烧录页 SRAM 高速档失败定因与修复（F103ZE）

**结论：36/45/60 MHz 失败不是线材或目标上限。根因是网页的「清除 SWD 错误」报文（DAP_WriteABORT）漏了
DAP 索引字节——固件实际收到的 abort 值为 0，sticky 错误永远清不掉；一次瞬态错误就把整条链路毒化，
页面只能一路降档到 20 MHz。修复后真实网页在 60 MHz 稳定通过：读 2.5~2.8 MB/s、写 2.7~3.1 MB/s
（修复前 20 MHz 档约读 1.17 / 写 1.16 MB/s），自动档三次全部选到 60 MHz。**

## 元数据与实际入口

- Validation-Run-ID: 20261016-sram-root-cause-134100
- Tested-Revision: pre-commit-worktree（修复前基线 fb06da2348543b75db5fbc237dd4d3b0ffe1d655；
  修复后固化为提交 1f27947）
- Tested-Dirty: true
- Validation-Result: passed（软件回归 + 真实网页 + 发布包入口 + 实板报文对照）
- Hardware-Test: partial（SRAM 读写 60 MHz、发布包 60 MHz、abort 报文对照通过；
  full_flow_f103ze 的 60 MHz 门槛见文末）
- 板卡：F103ZE（DEV_ID 0x414、Flash 512 KiB、SRAM 64 KiB），目标固件 48 MHz CDC 示例
- 入口：真实 Chrome 页面 `FlashView.benchmarkSram()`（WebUSB / CMSIS-DAP）、`index.html?modules=bundle`
  发布包入口、以及直接调用 `WebUsbDapProbe` 的报文级脚本
- 参考：`script_test/sram_speed_test.py`、`script_test/swd/benchmark_readback.tcl`（akaLinkPro 原生对照）

## 一、定因证据

### 1. 原生脚本在同一条线、同一个目标上 1~60 MHz 全部通过

`reproduce-native.py` / `native-clock-matrix.py` 用 akaLinkPro 自带脚本与 OpenOCD 在**当前接线**下复现：
1/4/10/20/36/45/60 MHz 读写全部校验通过；60 MHz 的 OpenOCD 传输计时约**写 3.55 MB/s、读 2.60 MB/s**。
⇒ 网页此前的失败不能归因于线材质量或 F103ZE 的能力上限。

### 2. 报文级缺陷：DAP_WriteABORT 少了 DAP 索引字节

CMSIS-DAP 的 `DAP_WriteABORT` 请求是 `[0x08, DAP索引, abort(4B LE)]`；修复前网页发的是
`[0x08, 0x1E, 0, 0, 0]` —— 0x1E 落在**索引**字节里，固件读到的 abort 值实际是 **0**，什么也没清。

实板对照（`abort-hardware-02.mjs`，源码入口；`bundle-fault-check.mjs`，发布包入口）：

| 步骤 | 观测 |
| --- | --- |
| 触发真实总线 FAULT（写 TAR=0x20020000 后读 DRW） | `SWD FAULT（传输 1/1 条，地址 0xc）` |
| 出错后 DP CTRL/STAT | `0xF0000020`（bit5 sticky 置位） |
| 旧报文 `[8,30,0,0,0]` | 回 `[0]`（传输层"成功"）但 sticky **仍是** `0xF0000020` |
| 新报文 `p.abort()` = `[8,0,30,0,0,0]` | 回 true，sticky 变 `0xF0000000`（**清零**） |
| 期间 Flash / 17 个体系寄存器 | 逐字节一致；核保持 halt；自愈计数 1 |

这解释了"为什么只有高速档崩"：时钟越高，换挡后第一次 AP 访问的瞬态失败概率越高（探针侧历史数据
60 MHz 约 13%），而**唯一能救回来的清错动作此前是坏的**。

### 3. 其余与原生脚本的实现差异（同批修复）

- 块传输一条命令 512 B → **1024 B**（原生用 1024 B）；
- 直接从低速跳高档 → **分步爬档并在每档核验 DP ID**；
- 一条组合命令里地址设置失败后，仍继续后续写 → **立即停止该命令的后续写入**；
- 地址完成检查与块传输错误分开报，失败不再显示成"写入中"。

## 二、修复内容

| 文件 | 改动 |
| --- | --- |
| `app/rtt/dap-webusb.js` | `abort()` 报文补上 DAP 索引字节：`[0x08, 0, 0x1E, 0, 0, 0]`（+5/-1） |
| `app/flash/sram-transfer.js` | 重写传输层：1024 B 命令、FIFO 深度 1/4 自适应、跨页完整性、TAR 失败即停、排空/续发在飞请求、严格时钟资格判定 |
| `app/flash/view.js` | 用严格档位资格判定替换静默降档 |
| `tools/selftest/dap-abort.test.mjs` | 新增：钉住报文编码与固件解码、命令失败传播 |
| `tools/selftest/sram-transfer.test.mjs` | 重写：64/512/1024 B、FIFO 深度、跨页、TAR 失败即停、排空/续发、时钟资格 |
| `index.html` / `app/site/*` | 重建发布包（169 个模块） |

## 三、验证结果

### 软件回归（本机，未接实板）

`dap-abort` · `sram-transfer` · `flash-sram-flow` · `sram-bench` · `web-review-fixes` ·
`web-review-maintenance` · `dap-ap-discovery` · `dap-disconnect` · `dap-register-ready` ·
`dap-resume` · `probe-handoff` · `dbg-backend-lifecycle` 全部 PASS（`bus-periodic` 需
`PROBE_FIRMWARE_REPO`，同样 PASS）；`npm run check:web` 报"发布包与 169 个源模块一致"。

### 真实网页（源码入口，20 KiB×3 轮写校验 + 3 轮读校验）

24 组全部校验通过（`production-ui.json`）。实测档位与速率（读数/写，MB/s，1 MB=1e6 B）：

| 请求 kHz | 实际 kHz | 读 | 写 |
| --- | --- | --- | --- |
| 1000 | 1000 | 0.088 | 0.087 |
| 4000 | 4000 | 0.324 | 0.348 |
| 10000 | 10000 | 0.765 | 0.812 |
| 20000 | 20000 | 1.384 | 1.387 |
| 36000 | 36000 | 2.097 | 2.210 |
| 45000 | 45000 | 2.202 | 2.637 |
| 60000 | 60000 | 2.743 | 3.042 |
| 自动 ×3 | **60000 ×3** | 2.844 等 | 3.103 等 |

修复前同一实验（`20261016-f103ze-sram-131809-fcaefe`）：36/45/60 MHz 首扫各失败一组，自动档只在
20/45 MHz 之间摆，固定 20 MHz 平均读 1.165 / 写 1.159 MB/s。

### 发布包入口（`index.html?modules=bundle`）

6 组全部通过（60 MHz ×3 + 自动 ×3，自动三次都选 60 MHz），60 MHz 读 2.73~2.79 / 写 2.73~3.25 MB/s。
其中 job-15 的"故障自愈"步骤当年读了 `0x60000000`（F103ZE 的 FSMC 窗口，**实测不 FAULT**）而卡在
`fault not triggered`；本次 `bundle-fault-check.mjs` 改用真故障地址 `0x20020000` 并**通过**（数值同上表）。

### 收尾与恢复

- 测速期间 CPU 保持暂停；测完由外层写回 RAM、寄存器一致，Flash 与选项字节未变。
- 页面本身**仍不备份/恢复 SRAM**（S02），所以本轮 RAM 恢复靠外层脚本，不能算页面功能。
- 收尾把目标从"基准跑过之后"拉回原例程：`USB_CNTR=PDWN|FRES` + PA12 开漏拉低 150 ms +
  `SYSRESETREQ` + `VTOR=0x08000000`、SP/PC 取向量、清 PRIMASK → resume（`restore-app.mjs`，
  只写 RAM/寄存器）。随后 COM34 实测 `PING/PONG`、`INFO sysclk=48000000Hz clk_err=0`、
  `ECHO` 全部通过。

## 四、遗留与边界

1. **60 MHz 门槛（A01）——已定位到探针固件的设计行为，并按用户决定改判据（不改固件）。**
   - 用本修复后的代码重跑 `make hw-campaign-f103ze`（`campaign-02.log` / `campaign-02.txt`）：
     RTT Viewer 60 MHz 档通过（387.6 KB/s），但**转发桥自报 45 MHz** → 门槛再次 FAIL
     （1 通过 / 1 失败），与之前两次正式 `full_flow_f103ze` 同一签名。
   - `bridge-clock-sweep.mjs`：把请求固定为 60 MHz，连续启动转发桥（每次都是独立的
     固件侧 SWD 初始化）。就绪样本 **[45, 60, 60]** —— 换手后的第一次掉到 45，后面两次是 60。
     ⇒ **不是"一次都到不了 60"**：能到，只是不稳（随后 3 次正式 campaign 实测 45/45/45/60 各半）。
   - 探针固件（`akaLinkPro/src/rtt/rtt_bridge.c`）里这是**有意设计**：
     `RTT_RESCAN_AFTER 3`（3 次读失败触发重扫）→ `RTT_RESCANS_PER_STEP_DOWN 2`（2 次重扫
     降一档），`rtt_clock_step_down()` 只降不升；文件头注释写明 60 MHz "能跑但长跑不稳"
     （3×10 s 里 1 次出现 rd_err=10/wr_err=4 与约 1400 字节流异常，45 MHz 3/3 干净），
     所以 **默认档就是 45 MHz**，60 MHz 要靠 HID action 7 主动切、抖动时自动退回。
   - **用户决定：不改探针固件，改判据**。已在 `tools/selftest/hw-campaign.mjs` 实施：
     判据从「转发跑在 60 MHz 档」改为「**档位 ≥ 45 MHz**（探针固件稳定档下限）」，
     速率线按实际档位取（60 MHz → 2.5 MB/s 原口径；45 MHz → 2.0 MB/s = 实测 2.46 × 80%）；
     同时新增 `--clock=<Hz>` 便于单独量某一档。
   - 判据改动后的三次真机验证（见 §六）：60 MHz 档 2.90 MB/s（本地页）· 45 MHz 档 2.46 MB/s ·
     线上页 60 MHz 2.90 MB/s，全部 10/10 通过。
2. **45 MHz 偶发错误**：定因过程中观察到分步爬档时 45 MHz 仍有偶发错误（60 MHz 反而连续三次通过），
   说明该档位也存在瞬态窗口，需要更多样本才能定性。
3. **页面 SRAM 保护（S02/S01）**：仍建议按 DEV_ID/容量识别 ZE 的 32/64 KiB，并默认备份/恢复或
   限定空闲区；本轮未改这些产品行为。
4. 原版 `abort-hardware.mjs` 在探针遗留 FAULT 状态下未跑完；本次以 `abort-hardware-02.mjs`
   显式自愈后完成，并额外在发布包入口复核。
5. 本轮编排把靶子刷成了 campaign 的 rtt_speed 固件，收尾已用
   `job-97-restore-firmware.json` → `restore-firmware.py` 把**原固件整块写回并校验**
   （524288 B、sha256 `61a097c8…`、选项字节未变），随后 `job-99-stop.json` 让 owner 正常退出、
   锁释放；`final-cdc.json`：COM34 PING/PONG、INFO 48 MHz/clk_err=0、ECHO 全部通过。

## 五、96 MHz 靶子上的 SRAM 读写测速（用户 2026-10-16 追加口径）

上一节的 24 组是**48 MHz 靶子**（用户原固件）。按用户要求把靶子换成 **96 MHz 固件**
（`tools/target-firmware/stm32f103_rtt_speed/build-ze/fw.elf`，HSE 8 MHz ×12）再跑同一套基准
（`sram-96mhz.mjs`，页面 `FlashView.benchmarkSram()`，20 KiB × 3 轮写校验 + 3 轮读校验）：

- 靶子证据：`CPUID=0x411FC231`；`RCC_CFGR=0x29250A` → `SW/SWS=PLL`、`PLLSRC=HSE`、`PLLXTPRE=HSE`、
  `PLLMUL=×12` ⇒ **SYSCLK 96 MHz**；`g_ms` 600 ms 里 1044→1647（约 1 kHz 心跳，固件在跑）。
- **24/24 组全部校验通过**，自动档三次都选 60 MHz；每组之后 CPU 仍暂停、17 个体系寄存器与
  RCC_CFGR 均未变。

三组重复的均值（读/写，MB/s；1 MB = 1e6 B）：

| 请求 SWD | 96 MHz 靶子 读/写 | 48 MHz 靶子 读/写（对照 §三） |
| --- | --- | --- |
| 1 MHz | 0.088 / 0.087 | 0.088 / 0.087 |
| 4 MHz | 0.332 / 0.349 | 0.329 / 0.348 |
| 10 MHz | 0.754 / 0.807 | 0.765 / 0.813 |
| 20 MHz | 1.352 / 1.342 | 1.368 / 1.389 |
| 36 MHz | 1.981 / 2.108 | 2.076 / 2.171 |
| 45 MHz | 2.111 / 2.293 | 2.074 / 2.527 |
| 60 MHz | **2.399 / 2.496** | **2.695 / 2.940** |
| 自动 ×3 | 2.543 / 2.600（都选 60） | 2.714 / 2.835（都选 60） |

**结论：把靶子主频从 48 MHz 提到 96 MHz 并不提高 SRAM 读写速率，60 MHz 档反而略低**
（读 2.40 vs 2.70、写 2.50 vs 2.94，约 −10%）。⇒ 这条路径的瓶颈不在目标侧 CPU/AHB 主频，
而在"每条 DAP 命令一次 USB 往返"的主机—探针链路（与 `datasheet` 无关的既有结论一致）。
96 MHz 的收益在 RTT 生产侧（喂得更满），对调试口内存访问没有帮助。

## 六、判据改动后的真机验证

| 运行 | 页面 | 请求档位 | 实际档位 | 页面 RX | 判决 |
| --- | --- | --- | --- | --- | --- |
| `campaign-02`（旧判据） | 本地 | 60 MHz | 45 MHz | 未测 | ❌ 原判据 FAIL（复现 A01） |
| `campaign-03` | 线上 | 60 MHz | **60 MHz** | 2.90 MB/s | ✅ 10/10 |
| `campaign-45mhz`（`--clock=45000000`） | 线上 | 45 MHz | 45 MHz | **2.46 MB/s** | ✅ 10/10（校验 2.0 线） |
| `campaign-04-local` | **本地** | 60 MHz | **60 MHz** | 2.90 MB/s | ✅ 10/10 |
| **`full_flow_f103ze`**（第一次） | 本地 | 60 MHz | 45 + 60 MHz | 2.46 + 2.90 MB/s | ❌ 卡在「存盘字节数」97.98%（见下） |
| **`full_flow_f103ze`**（修正后） | 本地 | 60 MHz | 45 + 45 MHz | 2.46 + 2.46 MB/s | ✅ **整条流程通过**（campaign 20/20 + dbg-stress 82/82） |

⇒ 新判据在两条分支上都有真机数据：60 MHz 档 2.90 MB/s（≥2.5）、45 MHz 档 2.46 MB/s（≥2.0）。
同时回答"是不是一次都到不了 60"：**不是** —— 最近 5 次正式运行里 2 次落在 60 MHz（两次都 2.90 MB/s），
其余按探针设计降到 45 MHz。

### 顺带修正的测量口径：存盘窗口起点

第一次 `full_flow_f103ze` 已经过了新档位判据（45 MHz / 2.46 MB/s ✅、60 MHz / 2.90 MB/s ✅），
却卡在「存盘字节数 = 同窗口收到的字节（误差 <2%）」：文件 30785536 vs 收到 31420416 = **97.98%**
（阈值 98%）。查过测量口径后发现是**脚本自身的系统性偏置**：`r0`（页面 RX 基准）在点「记录」
**之前**就采了，于是"点击 → 记录器真的 active"这 0.2~0.4 s（@2.9 MB/s ≈ 0.6 MB）被算进"同窗口收到"，
但那段根本没进文件。改成**记录器 active 之后再采 r0**，并把记录器自己的 `pushed` 一起记进日志/结果
（便于区分"写盘丢"与"窗口没对齐"）；修正后两轮文件都略大于 RX 窗口（记录了停止点击前的残余），
20/20 判据通过。这条不是产品缺陷，是测试口径。

## 七、证据清单

`abort-hardware-02.json` · `bundle-fault-check.json` · `restore-app.json` · `production-ui.json` ·
`sram-96mhz.json` · `sram-96mhz-60mhz.png` · `campaign-02.txt` · `campaign-03.log` ·
`campaign-45mhz.log` · `campaign-04-local.log` · `full-flow-01.txt` · `full-flow-02.txt` · `bridge-clock-sweep.json` ·
`bundle-check.json` · `browser-matrix.json` · `web-clock-matrix.json` · `native-clock-matrix.json` ·
`native-direct.json` · `atomic-ramp.json` · `clock-sequence.json` · `resync-matrix.json` ·
`transport-matrix.json` · `packet-matrix.json` · 各 `job-*.log` 与源码/测试日志。
`baseline-*` 是修复前各文件快照（用于把上午的审查修复与本次 SRAM 修复拆成两个提交）。
