# 自测入口顺序

异常诊断与采集质量：`make test-diagnostics` 验证只读现场、坏栈／时效／单位和报告；`make test-diagnostics-page` 在独立浏览器标签中验证模型故障、捕获位恢复、导出、抽屉高度和高流量接收。前者已纳入离线回归；页面测试不烧写目标，模拟速率不作为硬件吞吐验收。

H743 真实异常验收：先完整备份原始 Flash，烧入 `tools/target-firmware/stm32h743_fault/fw.elf`，启动 8899 / 9333 服务，然后执行 `node tools/selftest/diagnostics-hw.mjs`。脚本注入 8 个故障场景并检查保存 PC、帧类型、调用链、只读一致性和捕获位恢复；它会停机、复位及写测试 RAM，**不自动备份、烧录或恢复固件**，结束后必须恢复原始 Flash 并读回核对。`DIAG_FIXTURE` / `DIAG_OUT` 可覆盖 ELF 和输出目录；设置 `DIAG_SOURCE` 为夹具的 `src` 目录，可加载实际 `main.c` 并逐项验证源码正文跳转。

性能对照：用 `git archive milestone-2026-10-08-pre-diagnostics app index.html` 导出基线到 `tmp/diagnostics-hw/baseline`，事先烧入对应夹具。执行 `node tools/selftest/diagnostics-perf-hw.mjs --kind=dbg`（故障夹具正常模式）、`--kind=scope`（`stm32h743_scope/fw.elf`），或 `--kind=rtt --clock=45000`（`stm32h743_rtt_speed/fw.elf`）。`--clock` 仅设置 RTT 请求 SWD 时钟，单位 kHz；Scope 固定请求 60 MHz，正常调试固定 10 MHz。默认每状态 3 轮、每采集窗口 8 秒，可用 `--seconds` / `--repeats` / `--baseline` / `--out` 覆盖。脚本按交替顺序测基线／关闭／打开，不改固件；RTT 重复行模式不匹配保留证据，不能据此计算 BER。固定时钟读错、网页错误会中止，已有结果仍保留。

本轮 [硬件验收与性能数据](../../docs/validation/2026-10-08-h743-diagnostics.md)包含失败压力窗口及原固件完整恢复判据；重测时同一时间只运行一项硬件脚本，按生效 SWD 时钟比较。

JScope 数组元素回归：`node tools/selftest/scope-array.test.mjs`，也包含在 `make test-offline` 和 `make test-scope` 中。覆盖真实 DWARF 4/5 的元素地址、多维步长、结构体成员、越界检查、8 MB 数组不全量展开，以及同时采样 8 项的限制。

自测分成离线、页面和真机三层。编号表示推荐顺序，日期记录放在
[`docs/validation/README.md`](../../docs/validation/README.md)。真机步骤会占用探针，
同一时间只运行一个页面/脚本。

## 00. 静态体检

```powershell
make check
make test-board-matrix
```

第一条检查 Node 模块和页面模板；第二条检查四块活动板卡的例程、构建脚本和产物路径，
避免容量档或旧目录混用。

## 10. 离线逻辑回归

```powershell
make test-offline
```

覆盖协议、ELF/DWARF、SPI/I2C、桥、调试器、J-Scope、生命周期和 SVD 等纯逻辑测试。
这一步不需要浏览器、探针或目标板。需要定位问题时再使用同组的细分目标：
`make test-dbg`、`make test-scope`、`make test-hid`、`make test-gen`、`make test-i2c-dsl`。

RISC-V SBA 的异步协议回归已接入 `make test-offline`，也可单独运行
`node tools/selftest/riscv-sba-async.test.mjs`。它按实际 TCK 推进模拟总线，核对
尾字访问范围、BUSY/FAILED、完成时错误、忙冲突的实际进度、写入完成和超时后的命令隔离。
这组测试不会操作真机；板上对照必须强制 OpenOCD 使用 `riscv set_mem_access sysbus`。

HPM6800EVK 运行 SDK 的 `lwip_tcpecho/flash_sdram_xip` 固件时，可使用
`node tools/selftest/dbg-hw-sba-reset.mjs --rounds=5 --clock=10000` 复现
连接、载入 ELF、`b main`、展开 `desc`、开启运行中刷新、复位并停和继续的组合。
需要先启动 8899 页面与 9333 测试浏览器；`--elf=路径` 必须与板上固件一致。
脚本会复位/停机/继续并设置硬件断点，不烧录固件、不写目标 RAM，结果保存在
`tmp/sba-reset-hardware.json`。结束时页面停在 `main`，保留展开的观察项供检查。

## 20. 页面回归

```powershell
make open
make test-ui
make test-dbg-page
make test-scope-page
make test-gen-page
```

页面测试使用假探针和 CDP 浏览器，不烧录目标板。`make open` 已经启动本地静态服务和
自动化浏览器；页面端口被占用时先用 `make serve-stop`。

RTT/串口突发流量显示回归：`node tools/selftest/serial-display.test.mjs`（已接入离线测试），
`node tools/selftest/serial-display-page.test.mjs`（真实浏览器、独立 localhost 页面、假串口/假探针）。
页面测试覆盖 2 MB 历史恢复、连续立即返回的读取、15 MB 突发、隐藏终端、ANSI 暂停/恢复/清空，
200 / 512 / 1024 KB/s 持续流量与自动恢复，以及 25 项普通 UI 回归；记录内容逐字节核对，不使用真实串口或目标板。
需先启动 8899 服务和 9333 CDP 浏览器，可用 APP/CDP 环境变量覆盖。

## 30. 换板确认

```powershell
make board-check-f103cb
make board-check-f103ze
make board-check-h743
make board-check-6800evk
```

只选择当前连接的那一条。流程会读取 IDCODE/DEV_ID/TAP IDCODE，型号不匹配就停止，避免
把错误容量的固件烧到板上。

## 40. 构建与真机基准

```powershell
make rebuild-all-examples
make hw-campaign-f103cb ARGS="--cycles=1 --alt=1"
make hw-campaign-f103ze ARGS="--cycles=1 --alt=1"
make hw-campaign-h743 ARGS="--cycles=1 --alt=1"
make hw-campaign-hpm ARGS="--cycles=1 --alt=1"
```

完整基准包括烧录、RTT Viewer、RTT 转发、10 秒落盘和 J-Scope；`--cycles=1 --alt=1` 是
快速冒烟，正式验收省略参数。HPM 第一次可加 `--record` 重新生成自己的速度线。

## 50. 一条命令全流程

```powershell
make full_flow_f103cb
make full_flow_f103ze
make full_flow_h743
make full_flow_6800evk
```

每条流程都按“认板 → 构建 → 场景基准 → 调试器压力”执行，并固定使用本地页面。
F103CB、H743 和 HPM6800EVK 会继续按固定随机种子交错运行两轮功能基准与一轮调试压力，
覆盖 RTT 转发、RTT Viewer、J-Scope、烧录、断点、单步、复位、BT/DWT Watch 和跨功能切换。
每个随机步骤有独立日志和 JSON；出错后默认停止后续场景。想单独复现或换顺序可用：

```powershell
make hw-random-flow-f103cb ARGS="--seed=20261005 --rounds=3"
make hw-random-flow-h743 ARGS="--seed=7 --rounds=4"
make hw-random-flow-6800evk ARGS="--seed=7 --rounds=4"
```

## 90. 诊断与历史脚本

`rtt-speed*.mjs`、`flash-timing.mjs`、`dbg-step-hw.mjs`、`probe-hid-diag.py` 等是针对
单一问题的诊断工具，不作为默认回归入口。它们仍保留，
但默认固件路径已经指向板卡清单；需要跑时先看脚本头注释和对应历史记录。
