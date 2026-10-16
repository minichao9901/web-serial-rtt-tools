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

1. **60 MHz 门槛（A01）——已定位到探针固件的设计行为，不是网页缺陷。**
   - 用本修复后的代码重跑 `make hw-campaign-f103ze`（`campaign-02.log` / `campaign-02.txt`）：
     RTT Viewer 60 MHz 档通过（387.6 KB/s），但**转发桥自报 45 MHz** → 门槛再次 FAIL
     （1 通过 / 1 失败），与之前两次正式 `full_flow_f103ze` 同一签名。
   - `bridge-clock-sweep.mjs`：把请求固定为 60 MHz，连续启动转发桥 10 次（每次都是独立的
     固件侧 SWD 初始化）。3 次在等待窗口内就绪，档位为 **[45, 60, 60]** —— 换手后的第一次
     就掉到 45；其余 7 次是脚本等待窗口（12 s）内没就绪，不作为样本。
   - 探针固件（`akaLinkPro/src/rtt/rtt_bridge.c`）里这是**有意设计**：
     `RTT_RESCAN_AFTER 3`（3 次读失败触发重扫）→ `RTT_RESCANS_PER_STEP_DOWN 2`（2 次重扫
     降一档），`rtt_clock_step_down()` 只降不升；文件头注释写明 60 MHz "能跑但长跑不稳"
     （3×10 s 里 1 次出现 rd_err=10/wr_err=4 与约 1400 字节流异常，45 MHz 3/3 干净），
     所以 **默认档就是 45 MHz**，60 MHz 要靠 HID action 7 主动切、抖动时自动退回。
   - ⇒ 网页侧本次修的是**另一处**缺陷（清错报文 / 传输层）。要让"转发稳定跑在 60 MHz"，
     要么在探针固件上消除 60 MHz 的瞬态读失败，要么放宽/改写该判据（接受自动降档后的档位，
     或允许页面在降档后重试一次启动）。**本轮不改产品行为，留给用户决定**。
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

## 五、证据清单

`abort-hardware-02.json` · `bundle-fault-check.json` · `restore-app.json` · `production-ui.json` ·
`bundle-check.json` · `browser-matrix.json` · `web-clock-matrix.json` · `native-clock-matrix.json` ·
`native-direct.json` · `atomic-ramp.json` · `clock-sequence.json` · `resync-matrix.json` ·
`transport-matrix.json` · `packet-matrix.json` · 各 `job-*.log` 与源码/测试日志。
`baseline-*` 是修复前各文件快照（用于把上午的审查修复与本次 SRAM 修复拆成两个提交）。
