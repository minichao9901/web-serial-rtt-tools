# ============================================================================
#  串口 / RTT 工具箱 —— 常用操作一键化
#
#  用法：make            看这份帮助
#        make open       起服务 + 打开自测浏览器（真机调试最常用）
#        make test       跑不需要硬件的自测
#        make test-hw    跑真机 WebUSB 验收（探针 + 目标板）
#        make fw-restore 把测试固件烧回板子（板子被烧花了就靠它）
#
#  设计约束（Windows 实测）：
#   · 本机 GNU Make 用的是 PATH 里的 sh.exe（E:\Share\env-windows\tools\bin\sh.exe），
#     别的机器上可能只有 cmd.exe —— 所以配方里**只用单条命令**，
#     平台相关动作一律交给 `pwsh -NoProfile -Command`（Windows 必装 PowerShell）。
#   · 路径统一用正斜杠（反斜杠会被 sh 当转义吃掉）。
#   · 中文输出走 tools/dev/help.ps1（把控制台编码切到 UTF-8，避免 GBK 下乱码）。
#   🚨 **配方（tab 后面那行）里一律不要写中文**（2026-10 实测，不只是乱码）：本机 make 走
#      sh.exe，非 ASCII 字符串经编码转换后**有的能跑（输出乱码）、有的直接让这条配方
#      Error 1 且不给任何提示** —— 可复现的最小例子是 `Write-Host '已在跑'`（换成
#      `'port 8899 is already up'` 立刻正常）。中文只放在 # 注释里，或放进 .ps1 脚本。
# ============================================================================

PY      ?= python
NODE    ?= node
PORT    ?= 8899
CDP     ?= 9333
TARGET  ?= stm32f103
APP     ?= http://127.0.0.1:$(PORT)/index.html
FW_DIR   = tools/target-firmware/stm32f103
LA       = tools/la/kingst_la.py
# 以太网回显靶子（HPM6800EVK 跑 lwIP tcpecho 例程时的默认地址）
TCP_HOST ?= 192.168.100.10
TCP_PORT ?= 5001
BOARD       ?= ze
HSS_SECONDS ?= 8
HSS_CLOCK   ?= 60
HSS_CPU     ?= 72
HSS_PERIODS ?= 2,2.25,2.5,3

.DEFAULT_GOAL := help
.PHONY: test-hss-rate
# 真机 HSS/JScope 测速：备份原 Flash，烧录额定主频测试固件，再跑真实网页。
# make test-hss-rate BOARD=ze；依赖探针、匹配的 F103 板和已授权浏览器。
test-hss-rate:
	$(NODE) tools/dev/hss-rate-hw.mjs --board=$(BOARD) --seconds=$(HSS_SECONDS) --clock=$(HSS_CLOCK) --cpu=$(HSS_CPU) --periods=$(HSS_PERIODS) --port=$(PORT) --cdp=$(CDP) $(ARGS)
.PHONY: help serve serve-dev serve-stop browser open page-prep spi-flash-hw idcode board-check-f103ze board-check-f103cb board-check-h743 board-check-6800evk test test-offline test-board-matrix test-random-flow test-ui test-gen test-gen-page gen-embed samples-anim test-hid test-dwarf test-scope test-scope-page test-scope-render test-spi test-read test-spi-page test-hw test-record test-bridge test-bridge-gate test-hpm test-image test-all test-dbg test-dbg-page test-dbg-hw test-dbg-stress test-dbg-stress-f103ze test-dbg-stress-f103cb flash-dbgstress-f103ze flash-dbgstress-f103cb flash-dbgstress-h743 flash-dbgstress-6800evk test-dbg-riscv test-idcode test-dsl test-flash flash-timing hw-campaign hw-campaign-f103ze hw-campaign-f103cb hw-campaign-h743 hw-campaign-hpm hw-campaign-riscv hw-random-flow-f103cb hw-random-flow-h743 hw-random-flow-6800evk build-f103ze-examples build-f103cb-examples build-h743-examples build-6800evk-examples build-all-examples rebuild-all-examples clean-firmware campaign-summary full_flow_f103ze full_flow_f103cb full_flow_h743 full_flow_6800evk tcpecho tcpecho-server tcpecho-selftest \
        bridge bridge-stop fw-build fw-flash fw-restore fw-h7-build fw-h7-flash \
        algo-check flash-plan la-info la-capture git-status git-log check clean spi-hw spi-flow i2c-hw spi-partial-hw spi-periodic-hw dbg-step-hw probe-diag

# 探针 HID 直驱诊断（绕开页面）：rc=-4 归因 / RTT 字节级完整性
#   make probe-diag ARGS="--mode=disc --iters=40 --clk=60"
#   make probe-diag ARGS="--mode=loss --seq --clk=45 --iters=3 --window=15"
# 各模式与实测数据见 docs/probe-rc4-and-rtt-loss.md §四
probe-diag:
	python tools/selftest/probe-hid-diag.py $(ARGS)

probe-diag-help:
	python tools/selftest/probe-hid-diag.py --help

help:
	pwsh -NoProfile -ExecutionPolicy Bypass -File tools/dev/help.ps1

# ---------------------------------------------------------------- 起页面
serve:
	$(PY) -m http.server $(PORT) --bind 127.0.0.1

# 开发用静态服务：**明确不发缓存**。—— 改页面时用这个
# 🚨 python -m http.server 不发 Cache-Control，浏览器就按"启发式缓存"自己决定存多久，
#    于是"改完代码 → 刷新 → 还是老的"，强刷都不一定管用（ES 模块的缓存尤其顽固）。
serve-dev:
	$(NODE) tools/dev/serve-nocache.mjs $(PORT)

serve-stop:
	pwsh -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$$_.OwningProcess -Force }"

browser:
	pwsh -NoProfile -File tools/selftest/launch-browser.ps1 -Port $(CDP) -Url $(APP)

# 起服务（后台，已在跑就跳过）再开浏览器 —— 一条命令进入真机调试状态
# 服务用**不发缓存**的那个（node tools/dev/serve-nocache.mjs）：改完代码普通刷新就能看到
open:
	$(NODE) tools/selftest/serial-grant.mjs --if-idle
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(NODE)' -ArgumentList 'tools/dev/serve-nocache.mjs','$(PORT)' -WorkingDirectory (Get-Location) -WindowStyle Hidden; Start-Sleep -Seconds 1 }; & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'"
	pwsh -NoProfile -Command "Write-Host '页面：$(APP)    浏览器调试端口：$(CDP)'"

# 探针授权（串口 + WebHID + WebUSB）——默认补「make open 起的那个 profile」和「自动化脚本用的那个」，
# 来源覆盖 线上 Pages / 127.0.0.1:8899 / localhost:8899。换 USB 口或换探针之后重跑一次即可。
#   make grant                 # 补（该 profile 的浏览器在跑会先关掉它）
#   make grant ARGS=--show     # 看：每个 profile / 来源下都有哪些授权、当前口在不在里面
#   make grant ARGS=--clean    # 清：删掉换口/换探针留下的过期条目
grant:
	$(NODE) tools/selftest/serial-grant.mjs $(ARGS)

# ---------------------------------------------------------------- 自测
test: test-stability test-dbg-features test-board-matrix test-random-flow
	$(NODE) tools/selftest/analog.test.mjs
	$(NODE) tools/selftest/analog-connect.test.mjs
	$(NODE) tools/selftest/pin-map.test.mjs
	$(NODE) tools/selftest/adc-transport.test.mjs
	$(NODE) tools/selftest/adc-scope.test.mjs
	$(NODE) tools/selftest/adc-measure.test.mjs
	$(NODE) tools/selftest/adc-view.test.mjs
	$(NODE) tools/selftest/adc-session.test.mjs
	$(NODE) tools/selftest/dac-protocol.test.mjs
	$(NODE) tools/selftest/dac-generator.test.mjs
	$(NODE) tools/selftest/rtt.test.mjs
	$(NODE) tools/selftest/rtt-campaign-wait.test.mjs
	$(NODE) tools/selftest/campaign-summary.test.mjs
	$(NODE) tools/selftest/serial-display.test.mjs
	$(NODE) tools/selftest/gen-parity.mjs
	$(NODE) tools/selftest/hid-proto.test.mjs
	$(NODE) tools/selftest/dwarf.test.mjs
	$(NODE) tools/selftest/scope-array.test.mjs
	$(NODE) tools/selftest/scope-proto.test.mjs
	$(NODE) tools/selftest/scope-rate.test.mjs
	$(NODE) tools/selftest/scope-transport.test.mjs
	$(NODE) tools/selftest/scope-store-batch.test.mjs
	$(NODE) tools/selftest/bridge-origin.test.mjs
	$(NODE) tools/selftest/bridge-lifecycle.test.mjs
	$(NODE) tools/selftest/flash-image.test.mjs
	$(NODE) tools/selftest/hpm-flash.test.mjs
	$(NODE) tools/selftest/hpm-porting.test.mjs
	$(NODE) tools/selftest/spi-proto.test.mjs
	$(NODE) tools/selftest/spi-panel-code.test.mjs
	$(NODE) tools/selftest/spi-read.test.mjs
	$(NODE) tools/selftest/spi-frames-dsl.test.mjs
	$(NODE) tools/selftest/spi-flash.test.mjs
	$(NODE) tools/selftest/stm32-devid.test.mjs
	$(NODE) tools/selftest/dbg-core.test.mjs
	$(NODE) tools/selftest/dbg-riscv-reset.test.mjs
	$(NODE) tools/selftest/dbg-riscv-memory.test.mjs
	$(NODE) tools/selftest/riscv-sba-async.test.mjs
	$(NODE) tools/selftest/dbg-riscv-resume.test.mjs
	$(NODE) tools/selftest/dbg-src-suggest.test.mjs
	$(NODE) tools/selftest/i2c-proto.test.mjs
	$(NODE) tools/selftest/i2c-dsl.test.mjs
	$(NODE) tools/selftest/i2c-registers.test.mjs
	$(NODE) tools/selftest/spi-regs.test.mjs
	$(NODE) tools/selftest/scenery-samples.test.mjs

# 离线总入口：先做语法/液体页面检查，再跑纯 Node 自测；不打开浏览器、不碰探针。
test-offline: check test test-swo

test: test-stats
.PHONY: test-stats
test-stats:
	$(NODE) tools/selftest/stats.test.mjs

.PHONY: test-bus-periodic
test-bus-periodic:
	$(NODE) tools/selftest/bus-periodic.test.mjs

# 板卡/例程唯一清单的静态检查；发现路径漂移时在进入真机流程前就失败。
test-board-matrix:
	$(NODE) tools/selftest/board-matrix.test.mjs

test-random-flow:
	$(NODE) tools/selftest/hw-random-flow.test.mjs

# USB→I2C 页的协议层 + 假探针 + 假器件（AT24C02/MPU6050/ADS1115/Si5351）—— 不需要硬件
test-i2c:
	$(NODE) tools/selftest/i2c-proto.test.mjs

# USB→I2C 页的命令协议（DSL + C 表 + as 解码 + 表格互转）+ 四个模块示例必须零错误
test-i2c-dsl:
	$(NODE) tools/selftest/i2c-dsl.test.mjs

# SPI 桥的「寄存器」面板与定时采集：档位→帧、假器件（寄存器器件/命令型 ADC）端到端、loop/as 采集、DSL 语法
test-spi-regs:
	$(NODE) tools/selftest/spi-regs.test.mjs

# USB→I2C 页的「寄存器」面板：长写分片 planWrite + 输入解析/diff/bit + 假探针端到端 + EEPROM 页写回归
test-i2c-reg:
	$(NODE) tools/selftest/i2c-registers.test.mjs

# USB→I2C 页的真页面验收（假探针，不需要硬件；需要 8899 服务 + 9333 CDP 浏览器）
test-i2c-page: page-prep
	$(NODE) tools/selftest/i2c-page.test.mjs

# 调试器页的逻辑层（纯 Node）：寄存器位域 / FPB 断点编码 / 命令解析 / 符号表 +
# 拿内置假目标真跑一遍「连接 → 读寄存器 → 写内存 → 下断点 → 继续 → 命中断点 → 单步 → 复位」
test-dbg: test-dbg-features
	$(NODE) tools/selftest/dbg-core.test.mjs

.PHONY: test-dbg-features
.PHONY: test-diagnostics test-diagnostics-page
test-diagnostics:
	$(NODE) tools/selftest/diagnostics.test.mjs

test-diagnostics-page: page-prep
	$(NODE) tools/selftest/diagnostics-page.test.mjs

test-dbg-features:
	$(NODE) tools/selftest/dbg-source-syntax.test.mjs
	$(NODE) tools/selftest/dap-resume.test.mjs
	$(NODE) tools/selftest/diagnostics.test.mjs
	$(NODE) tools/selftest/dbg-dwt.test.mjs
	$(NODE) tools/selftest/dbg-backtrace.test.mjs
	$(NODE) tools/selftest/dbg-frame-locals.test.mjs
	$(NODE) tools/selftest/dbg-frame-riscv.test.mjs
	$(NODE) tools/selftest/dbg-frame-contract.test.mjs
	$(NODE) tools/selftest/dbg-frame-hw-runner.test.mjs
	$(NODE) tools/selftest/dbg-watch-bt-ui.test.mjs
	$(NODE) tools/selftest/dbg-svd.test.mjs

# 调试器页的真页面自测（CDP，不需要硬件；用的是页面里的假目标）
test-dbg-page: page-prep
	$(NODE) tools/selftest/dbg-page.test.mjs

# 调试器页的真机冒烟（真探针 + 真目标板；只读为主，跑完把目标放回运行状态）
# ⚠️ 探针接口同时只能被一个程序占着：别的浏览器/页签还连着就得先让它断开，否则会报
#    "Unable to claim interface"（脚本会明确提示，不会假装成功）
test-dbg-hw: page-prep
	$(NODE) tools/selftest/dbg-hw.mjs

# 调试器**真机验收**：停止 / 单步 / 断点时「PC ↔ 源码行 ↔ 高亮 ↔ 滚动」是否同步（23 项断言）
#   需要：真探针 + 真目标板 + 板上有行号信息的固件（默认 tools/target-firmware/stm32f103/build/fw.elf）
#   make dbg-step-hw ARGS="--steps=10"
# 里面含"BOOT0=1 那块板"的唤醒配方（AIRCR 软复位 → 手工搬 VTOR/SP/PC），换板子看脚本头注释。
dbg-step-hw: page-prep
	$(NODE) tools/selftest/dbg-step-hw.mjs $(ARGS)

# 调试器**真机压力测试**（发布前总验收，80+ 项断言）：
#   断点 / 代码同步 / 单步(in-out-over) / 复位重跑 / 结构体树与位域 / FPB 泄漏 / 总线 FAULT 自愈 /
#   连续 60 轮"停—走—停"，并在有 gdb 对照 JSON 时与 gdb **逐地址**比对。
#   ⚠️ 需要先把靶子固件烧进去；`make full_flow_h743` 会替你烧（flash-dbgstress-h743），
#      单独跑这条时也要先烧：make flash-dbgstress-h743
#   换 DWARF5 靶子：make test-dbg-stress ARGS="--elf=/tools/.../build-dw5/fw.elf --oracle=tmp/none.json"
#   生成 gdb 对照：node tmp/probe-free.mjs --blank && node tmp/dbg-gdb-oracle.mjs
test-dbg-stress: page-prep
	$(NODE) tools/selftest/dbg-hw-stress.mjs $(ARGS)

# 同一套压测 · **F103ZE 靶子**（Cortex-M3，6 个比较器；同一份源码换个芯片编出来）。
#   make test-dbg-stress-f103ze                 # 自己会先把靶子固件烧进去
#   make test-dbg-stress-f103ze ARGS=--keep-going
# 与 H743 那几处差别（都在脚本的 BOARD 表里）：靶子固件/源码目录、BOOT0=1 的唤醒配方、
# 比较器个数按硬件报的来（不再写死 8）。
test-dbg-stress-f103ze: page-prep flash-dbgstress-f103ze
	$(NODE) tools/selftest/dbg-hw-stress.mjs --board=f103ze $(ARGS)

# 同一套压测 · **F103CB 靶子**（128KB Flash / 20KB SRAM；BOOT0=0）。
test-dbg-stress-f103cb: page-prep flash-dbgstress-f103cb
	$(NODE) tools/selftest/dbg-hw-stress.mjs --board=f103cb $(ARGS)

# 调试器的靶子固件（就是各自 target-firmware/*_dbgstress 那份）烧进板子 —— 页面 WebUSB 烧录。
# 为什么要有这一步：跑完 hw-campaign 的板子上是"狂发/scope"固件，不换靶子压测必然连不上；
# 以前这一步藏在 tmp/ 的脚手架里（tmp/ 不进仓库，新克隆根本没有）。
.PHONY: flash-dbgstress-5301evklite build-dbgstress-5301evklite flash-spi-5301evklite build-spi-5301evklite flash-spi-dma-5301evklite build-spi-dma-5301evklite build-spi-master-5301evklite flash-spi-master-5301evklite spi-cdc-hpm5301-master-hw test-dbg-riscv-5301evklite hw-campaign-hpm-5301evklite build-5301evklite-examples board-check-5301evklite spi-hpm5301-hw spi-hpm5301-dma-hw
flash-dbgstress-f103ze:
	$(NODE) tools/selftest/flash-elf.mjs --board=f103ze $(ARGS)

flash-dbgstress-f103cb:
	$(NODE) tools/selftest/flash-elf.mjs --board=f103cb $(ARGS)

flash-dbgstress-h743:
	$(NODE) tools/selftest/flash-elf.mjs --board=h743 $(ARGS)

flash-dbgstress-6800evk:
	$(NODE) tools/selftest/flash-elf.mjs --board=6800evk $(ARGS)

build-dbgstress-5301evklite:
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_dbgstress/build.ps1 -BuildType flash_xip

flash-dbgstress-5301evklite: build-dbgstress-5301evklite
	$(NODE) tools/selftest/flash-elf.mjs --board=5301evklite $(ARGS)

build-spi-5301evklite:
	 pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_spi_echo/build.ps1 -BuildType flash_xip

flash-spi-5301evklite: build-spi-5301evklite
	$(NODE) tools/selftest/flash-elf.mjs --board=5301evklite --elf=tools/target-firmware/hpm5301evklite_spi_echo/fw.elf $(ARGS)

# 调试器 **RISC-V 真机验收**（HPM6800EVK 靶子 + akaLinkPro 的 JTAG 通路，约 53 项断言）：
#   断点（文件:行 / 符号 / static / 多断点轮转）/ 代码同步 / 单步 n·si·fin（RV32 解码 + dcsr.step）/
#   复位重跑（复位会清掉 hart 的触发器 → 必须重新下发）/ 结构体树与位域（含 flash 里的 const）/
#   40 轮"停—走—停" 与触发器泄漏 / 有 tmp/rv-gdb-oracle.json 时与 gdb 逐地址比对。
#   前置：板子上跑着 tools/target-firmware/hpm6800evk_dbgstress/fw.elf（页面里烧，或
#        node tmp/rv-flash-and-smoke.mjs --flash 那条路），且探针没被别的程序占着。
#   生成 gdb 对照：node tmp/probe-free.mjs --blank && node tmp/rv-gdb-oracle.mjs
test-dbg-riscv: page-prep
	$(NODE) tools/selftest/dbg-hw-riscv.mjs $(ARGS)

test-dbg-riscv-5301evklite: page-prep flash-dbgstress-5301evklite
	$(NODE) tools/selftest/dbg-hw-riscv.mjs --board=5301evklite $(ARGS)

# HPM6800EVK + lwip_tcpecho 例程专用的调试器真机压测（穷举运行控制/内存/断点/回栈/RTT/复位组合）
#   make test-dbg-tcpecho            # 全量
#   make test-dbg-tcpecho ARGS=--quick
test-dbg-tcpecho: page-prep
	$(NODE) tools/selftest/dbg-hw-tcpecho.mjs $(ARGS)

# 目标身份解码（「读 IDCODE」按钮）：DP IDCODE / CPUID / STM32 DBGMCU DEV_ID → 型号
test-idcode:
	$(NODE) tools/selftest/stm32-devid.test.mjs

# 固件文件解析（ELF 按节取 + VMA→LMA、HEX、.bin）—— 离线
test-image:
	$(NODE) tools/selftest/flash-image.test.mjs

# HPM（RISC-V）零安装烧录：跑在模拟 DTM + 模拟 XPI flash 上（不需要探针/板子）
test-hpm:
	$(NODE) tools/selftest/hpm-flash.test.mjs
	$(NODE) tools/selftest/hpm-porting.test.mjs

# 重新构建 HPM flashloader（需要 HPM SDK + RISC-V 工具链），并刷新 app/flash/hpm/algo.js
hpm-algo:
	pwsh -NoProfile -File tools/target-firmware/hpm_flash_algo/build.ps1

# 靶子固件的「高速平滑正弦」表：仓库里那份必须与生成公式一致
# （改了表长或更新率就要重跑 python tools/dev/gen-sin-table.py）
sin-table-check:
	python tools/dev/gen-sin-table.py --check

# 桥的 WebSocket 准入（Origin 白名单 + 口令）：纯离线，自己拉一个桥实例只做握手
test-bridge-gate:
	$(NODE) tools/selftest/bridge-origin.test.mjs

# ELF/DWARF 变量提取（scope 页的变量浏览器底座）—— 基线是真 ELF 快照
test-dwarf:
	$(NODE) tools/selftest/dwarf.test.mjs

# J-Scope 引擎层：采样计划 / 512B 包编解码 / 缓冲+LOD / 触发 / 假探针端到端
test-scope:
	$(NODE) tools/selftest/hpm-scope-contract.test.mjs
	$(NODE) tools/selftest/scope-array.test.mjs
	$(NODE) tools/selftest/scope-proto.test.mjs
	$(NODE) tools/selftest/scope-rate.test.mjs
	$(NODE) tools/selftest/scope-transport.test.mjs
	$(NODE) tools/selftest/scope-store-batch.test.mjs

# 「工程生成」页与 Python 工具（uvprojx2cmake.py）产物的逐字节对账
# 外加「本地桥安装包」生成器的自测（桥源码哈希对账 + bat/ps1/config 内容）
test-gen:
	$(NODE) tools/selftest/gen-parity.mjs
	$(NODE) tools/selftest/bridge-kit.test.mjs

# 改完 bridge/rtt-bridge.mjs 必须重嵌一次（否则「工程生成」页发出去的桥是旧的）
# 忘了也没事：test-gen 里那条哈希对账会红
gen-embed:
	$(NODE) tools/dev/embed-bridge.mjs

# 探针自定义 HID（RTT→CDC 转发）协议自测：组包 / 状态字 / 假探针流程
test-hid:
	$(NODE) tools/selftest/hid-proto.test.mjs

# 页面端到端（演示串口 + 假探针；驱动会自己拉 CDP 浏览器）
test-ui:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	$(NODE) tools/selftest/ui.page.test.mjs

.PHONY: test-ui-layout
test-ui-layout: page-prep
	$(NODE) tools/selftest/ui-layout-page.test.mjs

# 「工程生成」页的真页面验收（需要 8899 服务 + 9333 CDP 浏览器，见 make open）
test-gen-page:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	pwsh -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:$(CDP)/json/version' -TimeoutSec 2 -UseBasicParsing | Out-Null } catch { & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'; Start-Sleep -Seconds 2 }"
	$(NODE) tools/selftest/gen-page.test.mjs

# 「J-Scope 波形」页的真页面验收（假探针，不需要硬件；需要 8899 服务 + 9333 CDP 浏览器）
test-scope-page:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	pwsh -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:$(CDP)/json/version' -TimeoutSec 2 -UseBasicParsing | Out-Null } catch { & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'; Start-Sleep -Seconds 3 }"
	$(NODE) tools/selftest/scope-page.test.mjs

# 波形渲染的几何自测：数 canvas 路径，钉住"放大到亚像素不能再断线"这个回归
test-scope-render:
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	$(NODE) tools/selftest/scope-render.test.mjs

# 「SPI/QSPI 屏」页的引擎层：帧编解码 / 打包器（一帧不跨包）/ HID 0x35 偏移 / 假探针帧执行
test-spi:
	$(NODE) tools/selftest/spi-proto.test.mjs

# 屏的回读（读寄存器 / 读 GRAM → 预览 + BMP）：读计划、解码、BMP 头、假探针 GRAM 往返
test-read:
	$(NODE) tools/selftest/spi-read.test.mjs

# 手写多帧 DSL：解析 / 自动规则 / 错误必须带行号拦住（含面板示例的回归）
test-dsl:
	$(NODE) tools/selftest/spi-frames-dsl.test.mjs

# 外接 SPI NOR：JEDEC ID / SFDP / 状态寄存器解析 + 连续读拆帧 + 按页编程 + 器件模型
test-flash:
	$(NODE) tools/selftest/spi-flash.test.mjs

# 「SPI/QSPI 桥 + 屏」两页的真页面验收（假探针，不需要硬件；需要 8899 服务 + 9333 CDP 浏览器）
test-spi-page: page-prep
	$(NODE) tools/selftest/spi-bus-page.test.mjs && $(NODE) tools/selftest/spi-panel-page.test.mjs

.PHONY: test-tool-sidebar-page
test-tool-sidebar-page: page-prep
	$(NODE) tools/selftest/tool-sidebar-page.test.mjs

# 「SPI/QSPI 屏」真机验收（探针 + 真屏）：默认 AXS15352/40MHz
#   make spi-hw                                  # 一屏一套：连接 → 推荐值 → 面板初始化 → 刷图
#   make spi-hw ARGS="--panel=st77916"           # 换 ST77916（档 2，QSPI）
#   make spi-hw ARGS="--sclk=20,40,60,75"        # 逐档 SCLK 刷一遍对比
#   make spi-hw ARGS=--loop                      # 先跑回环自检（要 J3[19]↔J3[21] 跳线）
spi-hw: page-prep
	$(NODE) tools/selftest/spi-hw.mjs $(ARGS)

# 「SPI/QSPI 屏」的**局部刷新**真机验收（真探针 + 真屏，23 条断言）
#   make spi-partial-hw                          # 默认 AXS15352（档 1，SPI+DC）
#   make spi-partial-hw ARGS="--panel=st77916"   # 换 ST77916（档 2，QSPI）
#   make spi-partial-hw ARGS="--sclk=60"         # 换 SCLK 档
# 判据（不靠看屏）：同内容重刷 = 线上 0 帧；8x8 改动 = 线上 4/3 帧、CASET/RASET 参数正确、
# 且那 128 B 与"同一张图整帧里该子矩形"**逐字节相同**；再顺带量一次动画的 fps 与像素节省比。
spi-partial-hw: page-prep
	$(NODE) tools/selftest/spi-partial-hw.mjs $(ARGS)

# 「SPI/QSPI 屏」页面功能流程验收（用户 2026-09-29 指定顺序，出错即停）：
#   打开 web -> 连接探针 -> 初始化屏 -> 发图 x3 -> 再次初始化屏 -> 发图 x3
spi-flow: page-prep
	$(NODE) tools/selftest/spi-hw-flow.mjs $(ARGS)

# 「SPI/I2C probe 定时采集」的 SPI 真机回归：重复只读 W25Q64 JEDEC ID，不写/擦 Flash。
spi-periodic-hw: page-prep
	$(NODE) tools/selftest/spi-periodic-hw.mjs $(ARGS)

# 「SPI/NOR Flash 测试」卡的**真机回归**（真探针 + 外接 NOR，本机 = W25Q64）：
#   认 ID（EF 40 17）→ 先把第 2 个扇区写成 0x00 → 跑「写测速」（擦 N 扇区 → 写 → 回读）
#   → 独立回读逐字节对账 → 擦除后必须全 0xFF。
# 钉的是代码审查 #2：老擦除序列"先单独擦一次 + 循环里又从 addr 擦 + 每条之间不等 BUSY"
# → 只有扇区 0 真被擦，回读不一致，而日志把它归因成「页间等 tPP 太短」，方向完全错。
#   make spi-flash-hw                            # 默认擦 0x7F0000 起 8 KB（flash 末尾，破坏性）
#   make spi-flash-hw ARGS="--addr=0x7E0000 --kb=16"
#   make spi-flash-hw ARGS="--id=EF 40 18"       # 换器件（W25Q128）
spi-flash-hw: page-prep
	$(NODE) tools/selftest/spi-flash-hw.mjs $(ARGS)

# USB→I2C 页的真机冒烟（真探针 + 真 I2C 器件）：扫描 → PINTEST → 读写 → 定时读
#   make i2c-hw                       # 默认 AT24C02@0x50，只读 + 一次页写回读（会还原）
#   make i2c-hw ARGS="--dev=0x68"     # 换器件地址（探测 + 只读，不做写）
i2c-hw: page-prep
	$(NODE) tools/selftest/i2c-hw.mjs $(ARGS)

# ---------------------------------------------------------------- 页面类脚本的共同前置
# 8899 静态服务 + 9333 CDP 浏览器（哪个不在就起哪个）。
# 🚨 2026-10 用户现场：直接 `make hw-campaign` 撞到
#    `TypeError: fetch failed … ECONNREFUSED 127.0.0.1:9333` —— 那是**CDP 浏览器没起**，
#    不是探针/板子的问题，但报错里只写着 "connect"，很容易往硬件上想。
#    现在这些"CDP 驱动真页面"的目标都依赖本前置，一条命令就能跑。
page-prep:
	$(NODE) tools/selftest/serial-grant.mjs --if-idle
	pwsh -NoProfile -Command "if (-not (Get-NetTCPConnection -State Listen -LocalPort $(PORT) -ErrorAction SilentlyContinue)) { Start-Process -FilePath '$(PY)' -ArgumentList '-m','http.server','$(PORT)','--bind','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 1 }"
	pwsh -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:$(CDP)/json/version' -TimeoutSec 2 -UseBasicParsing | Out-Null } catch { & 'tools/selftest/launch-browser.ps1' -Port $(CDP) -Url '$(APP)'; Start-Sleep -Seconds 3 }"

test-hw:
	$(NODE) tools/selftest/browser-hw.test.mjs webusb

# ---------------------------------------------------------------- 以太网：lwIP tcpecho
# 被测例程是 SDK 的 samples/lwip/lwip_tcpecho（构建目录
# E:\sdk_env_v1.11.0\work\lwip_lwip_tcpecho_hpm6800evk_flash_sdram_xip_debug）。
# 例程里**板子是 TCP 服务端**：CMakeLists 里 -DLWIP_DHCP=0，地址取 netinfo.h 的
# IP0_CONFIG = 192.168.100.10/24，tcp_echo.c 监听 TCP_LOCAL_PORT = 5001，收多少回多少。
# 所以 PC 有线网卡要在 192.168.100.0/24（本机 .11），板子串口应打印
# "IPv4 Address: 192.168.100.10" 和 "Link Status: Up"。不需要浏览器、探针、OpenOCD。
#   make tcpecho                    # 连发 3 条 hello, echo!\n 并校验回显，PASS 退出码 0
#   make tcpecho TCP_HOST=192.168.100.20 TCP_PORT=5002
#   make tcpecho ARGS="--count 5 --payload PING\n"
tcpecho:
	$(PY) tools/selftest/tcpecho.py client --host $(TCP_HOST) --port $(TCP_PORT) $(ARGS)

# PC 当 TCP 服务端（回显对照）：给改成客户端角色的板子当靶子，或配 nc / 网页工具验证
#   make tcpecho-server ARGS="--no-greet --accept-timeout 120"
tcpecho-server:
	$(PY) tools/selftest/tcpecho.py server --port $(TCP_PORT) $(ARGS)

# 不开硬件：本地 127.0.0.1 起服务端 + 客户端，自检脚本本身（带问候 / 纯回显各一轮）
tcpecho-selftest:
	$(PY) tools/selftest/tcpecho.py selftest $(ARGS)

# 烧录耗时体检（真机：探针 + 目标板 + 8899/CDP 浏览器）：把"慢在哪一步"量出来。
#   make flash-timing                        # 一轮时间线
#   make flash-timing ARGS=--minimize-after=1  # 第 2 轮前最小化窗口（真节流：页面不可见）
#   make flash-timing ARGS=--clamp             # 确定性模拟"每个短等待都被钳成 1 s"
flash-timing: page-prep
	$(NODE) tools/selftest/flash-timing.mjs $(ARGS)

# 「记录到文件」实测（OPFS 当 showSaveFilePicker 替身；createWritable/write/close 都是真的）
# 含"把 write 拖慢"的积压用例与逐字节校验 —— 钉住 .crswap 那套落盘语义
test-record: page-prep
	$(NODE) tools/selftest/recorder-file.test.mjs

# 真机场景基准（探针 + 目标板）:烧录 / RTT Viewer / RTT 转发 / J-Scope 全场景跑一遍并记时
#   make hw-campaign                        # 3 轮全场景 + 狂发↔scope 交替烧录 5 遍（约 4 分钟）
#   make hw-campaign ARGS="--cycles=1 --alt=1"   # 只冒烟一遍
#   make hw-campaign ARGS="--board=h743"    # 换 H743 靶子（靶子固件与 RTT 控制块区间一起换）
#   make hw-campaign ARGS=--local           # 打**本地 8899 页面**（默认打线上已发布那份）
# 🚨 四条 full_flow_* 会**强制加 --local**（见下面 FLOW_LOCAL 的说明）：流程验的是当前这棵树，
#    而线上是"最后一次 push 的快照"，可能落后到会把流程带沟里。
hw-campaign: page-prep
	$(NODE) tools/selftest/hw-campaign.mjs $(FLOW_LOCAL) $(ARGS)

# 同一套网页流程的 F103ZE 档案：先把 RTT、Scope、调试压力三个例程按 ZE 容量构建。
# RTT 缓冲保持 32 KiB；这是 ZE 的板卡条件，不能与 CB 的 12 KiB 混用。
#   make hw-campaign-f103ze ARGS="--cycles=1 --alt=1"
hw-campaign-f103ze: page-prep build-f103ze-examples
	$(NODE) tools/selftest/hw-campaign.mjs --board=f103ze $(FLOW_LOCAL) $(ARGS)

build-f103ze-examples:
	pwsh -NoProfile -File tools/target-firmware/stm32f103_rtt_speed/build.ps1 -Board ze
	pwsh -NoProfile -File tools/target-firmware/stm32f103_rtt_seq/build.ps1 -Board ze
	pwsh -NoProfile -File tools/target-firmware/stm32f103_scope/build.ps1 -Board ze
	pwsh -NoProfile -File tools/target-firmware/stm32f103_dbgstress/build.ps1 -Board ze

# 同一套网页流程的 F103CB 档案：固件与 RTT 扫描窗口都按 128KB/20KB 目标构建。
hw-campaign-f103cb: page-prep build-f103cb-examples
	$(NODE) tools/selftest/hw-campaign.mjs --board=f103cb $(FLOW_LOCAL) $(ARGS)

build-f103cb-examples:
	pwsh -NoProfile -File tools/target-firmware/stm32f103_rtt_speed/build.ps1 -Board cb
	pwsh -NoProfile -File tools/target-firmware/stm32f103_rtt_seq/build.ps1 -Board cb
	pwsh -NoProfile -File tools/target-firmware/stm32f103_scope/build.ps1 -Board cb
	pwsh -NoProfile -File tools/target-firmware/stm32f103_dbgstress/build.ps1 -Board cb

# 同上，靶子是 STM32H743（阿波罗 H743）：狂发/scope 固件换成 stm32h743_*，
# RTT 控制块在 **AXI SRAM(0x24000000)** —— H7 的 DTCM 探针走 AHB-AP 读不到，
# 所以自动搜的区间必须跟着换（脚本的 BOARD 表里写着）。F103 那条线不适用于 H7。
#   make hw-campaign-h743                         # 2 轮 + 交替 5 遍
#   make hw-campaign-h743 ARGS="--cycles=1 --alt=1"   # 只冒烟一遍
hw-campaign-h743: page-prep build-h743-examples
	$(NODE) tools/selftest/hw-campaign.mjs --board=h743 $(FLOW_LOCAL) $(ARGS)

build-h743-examples:
	pwsh -NoProfile -File tools/target-firmware/stm32h743_rtt_speed/build.ps1
	pwsh -NoProfile -File tools/target-firmware/stm32h743_scope/build.ps1
	pwsh -NoProfile -File tools/target-firmware/stm32h743_dbgstress/build.ps1

# 真机场景基准 · HPM6800EVK（HPM6880 / RISC-V + JTAG，akaLinkPro 探针）
# 与上面那份同一套编排，差别：目标类型 RISC-V、RTT 控制块地址取自 ELF（AXI SRAM 0x01240000）、
# 不做 ARM-only 的 RTT Viewer 判决、速度线是 HPM 自己那套（见脚本里的 SPEC）。
#   make hw-campaign-hpm ARGS=--record          # 第一遍：只记录 + 打印"实测 × 80%"的 spec 建议
#   make hw-campaign-hpm                        # 之后：按 SPEC 判决（2 轮 + 交替 5 遍，约 7 分钟）
#   make hw-campaign-hpm ARGS="--cycles=1 --alt=1"   # 只冒烟一遍
hw-campaign-hpm: page-prep build-6800evk-examples
	$(NODE) tools/selftest/hw-campaign-hpm.mjs $(FLOW_LOCAL) $(ARGS)

# HPM5301EVKLite uses the same RTT/J-Scope campaign and records its own baseline.
#   make hw-campaign-hpm-5301evklite ARGS="--record --cycles=1 --alt=1"
hw-campaign-hpm-5301evklite: page-prep build-5301evklite-examples
	$(NODE) tools/selftest/hw-campaign-hpm.mjs --board=5301evklite --chip=hpm5301evklite $(FLOW_LOCAL) $(ARGS)

hw-campaign-hpm-5301evklite: FLOW_LOCAL = --local

build-6800evk-examples:
	pwsh -NoProfile -File tools/target-firmware/hpm6800evk_rtt_flood/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm6800evk_scope/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm6800evk_dbgstress/build.ps1 -BuildType flash_xip

build-5301evklite-examples:
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_rtt_flood/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_scope/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_dbgstress/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_spi_echo/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_spi_dma/build.ps1 -BuildType flash_xip
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_spi_master/build.ps1

# 别名（用户口径叫"RISC-V 那条"）：就是上面 hw-campaign-hpm（脚本名按探针/芯片叫 hpm）
hw-campaign-riscv: hw-campaign-hpm

# 多轮随机顺序压力：交错完整功能基准与调试压力，并为每一步保留独立 JSON。
#   make hw-random-flow-f103cb ARGS="--seed=20261005 --rounds=3"
#   make hw-random-flow-h743 ARGS="--seed=7 --rounds=4"
#   make hw-random-flow-6800evk ARGS="--seed=7 --rounds=4"
# 固定种子可以复现顺序；默认 3 轮包含 2 个功能场景和 1 个调试场景。
hw-random-flow-f103cb: page-prep board-check-f103cb build-f103cb-examples
	$(NODE) tools/selftest/hw-random-flow.mjs --board=f103cb $(ARGS)

hw-random-flow-h743: page-prep board-check-h743 build-h743-examples
	$(NODE) tools/selftest/hw-random-flow.mjs --board=h743 $(ARGS)

hw-random-flow-6800evk: page-prep board-check-6800evk build-6800evk-examples
	$(NODE) tools/selftest/hw-random-flow.mjs --board=6800evk $(ARGS)

# 四块活动板卡的全量固件构建。每个例程的唯一产物见 board-matrix.json。
build-all-examples: build-f103cb-examples build-f103ze-examples build-h743-examples build-6800evk-examples build-5301evklite-examples
	REQUIRE_BUILDS=1 $(NODE) tools/selftest/board-matrix.test.mjs

# 清掉所有被忽略的旧 build/build-* 目录后再从源码全量重建。
rebuild-all-examples: clean-firmware build-all-examples

# ---------------------------------------------------------------- 认板子（真机流程的硬前置）
# 在**真页面**上点「读 IDCODE」，把目标身份读出来：
#   ARM/SWD：DP IDCODE（1BA01477 = Cortex-M3 / 6BA02477 = Cortex-M7）→ CPUID →
#            STM32 DBGMCU DEV_ID（**这个才认得出型号**：0x414 = F103ZE、0x450 = H743）→ flash 容量
#   RISC-V ：JTAG TAP IDCODE（1000563D = HPM6800）
#   make idcode                      # 只读 + 打印（人工看）
#   make idcode ARGS=--board=h743    # 按板子档案判决，型号对不上退 1
# 🚨 规矩（用户 2026-10）：**换板子 / 换探针之后先认板子再跑流程** —— 流程每一步都跟着
#    "是哪块板"走（烧哪份靶子、控制块去哪个窗口找、判决线取哪套），认错板就是十几分钟
#    跑在错的假设上，失败信息还看着像"工具坏了"。下面四条 full_flow_* 各自带这个前置。
idcode: page-prep
	$(NODE) tools/selftest/read-idcode.mjs $(ARGS)

board-check-f103ze: page-prep
	$(NODE) tools/selftest/read-idcode.mjs --board=f103ze

board-check-f103cb: page-prep
	$(NODE) tools/selftest/read-idcode.mjs --board=f103cb

board-check-h743: page-prep
	$(NODE) tools/selftest/read-idcode.mjs --board=h743

board-check-6800evk: page-prep
	$(NODE) tools/selftest/read-idcode.mjs --board=6800evk

board-check-5301evklite: page-prep
	$(NODE) tools/selftest/read-idcode.mjs --board=5301evklite

spi-hpm5301-hw: page-prep flash-spi-5301evklite
	$(NODE) tools/selftest/spi-hpm5301-hw.mjs $(ARGS)

build-spi-dma-5301evklite:
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_spi_dma/build.ps1 -BuildType flash_xip

flash-spi-dma-5301evklite: page-prep build-spi-dma-5301evklite
	$(NODE) tools/selftest/flash-elf.mjs --board=5301evklite --chip=hpm5301evklite --elf=/tools/target-firmware/hpm5301evklite_spi_dma/fw.elf

build-spi-master-5301evklite:
	pwsh -NoProfile -File tools/target-firmware/hpm5301evklite_spi_master/build.ps1

flash-spi-master-5301evklite: page-prep build-spi-master-5301evklite
	$(NODE) tools/selftest/flash-elf.mjs --board=5301evklite --chip=hpm5301evklite --elf=/tools/target-firmware/hpm5301evklite_spi_master/fw.elf

spi-cdc-hpm5301-master-hw: page-prep flash-spi-master-5301evklite
	$(NODE) tools/selftest/spi-cdc-hpm-sweep.mjs --rates=20000000,40000000,60000000,80000000 --seconds=10 --out=tmp/hpm5301-spi-cdc-sweep.json $(ARGS)

spi-hpm5301-dma-hw: page-prep flash-spi-dma-5301evklite
	$(NODE) tools/selftest/spi-hpm5301-hw.mjs $(ARGS)

# ---------------------------------------------------------------- 全流程（一块板一条命令）
# 当前三块活动板的流程在固定验收后再随机交错运行功能基准与调试压测；
# 每条 =「认板子」+「真机场景基准」+「调试器真机压测」+「随机顺序压力」。
# 中间那一步不能省：跑完基准的板子上是狂发/scope 固件，不换靶子压测必然连不上；
# 烧录走 tools/selftest/flash-elf.mjs（以前藏在 tmp/ 里，新克隆没有）。
#
#   make full_flow_f103ze     探针挂 STM32F103ZE 时用：hw-campaign + test-dbg-stress-f103ze
#   make full_flow_f103cb     探针挂 STM32F103CB 时用：CB 容量固件 + 固定及随机场景压力
#   make full_flow_h743       换阿波罗 H743 之后用：  hw-campaign-h743 + ARM 调试与随机压力
#   make full_flow_6800evk    换 HPM6800EVK 之后用：  hw-campaign-hpm + RISC-V 调试与随机压力
#
# 🚨 **流程一律打本地页面**（下面每条都带 `FLOW_LOCAL = --local`）。
#    为什么：流程验的是**工作区这棵树**，而线上 GitHub Pages 是"最后一次 push 的快照"——
#    2026-10 真机现场就栽在这上面：线上还是 review 那版 `bufferSize: 65536`（本地已经是 4096），
#    转发跑到 2.9 MB/s 时整页被冻住，于是"打开 CDC 串口"那步超时，看着像串口/探针坏了。
#    想故意打线上（例如验收线上版本）就 `make full_flow_f103ze FLOW_LOCAL=`。
#
# 四条都会把结果写进 tmp/；出错**立刻停**。三块活动板的随机结果按板卡及步骤分开保存；
# 想只跑其中一段就单独叫那一条（ARGS 照样透传）。
# 真机步骤共享探针和 USB 资源；即使传 `-j`，每条 full_flow 也按依赖顺序串行执行。
.NOTPARALLEL: full_flow_f103cb full_flow_h743 full_flow_6800evk hw-random-flow-f103cb hw-random-flow-h743 hw-random-flow-6800evk

full_flow_f103ze: FLOW_LOCAL = --local
full_flow_f103ze: board-check-f103ze hw-campaign-f103ze test-dbg-stress-f103ze
	pwsh -NoProfile -Command "Write-Host 'full flow (f103ze) done'"

full_flow_f103cb: FLOW_LOCAL = --local
full_flow_f103cb: board-check-f103cb build-f103cb-examples hw-campaign-f103cb test-dbg-stress-f103cb hw-random-flow-f103cb
	pwsh -NoProfile -Command "Write-Host 'full flow (f103cb) done'"

full_flow_h743: FLOW_LOCAL = --local
full_flow_h743: board-check-h743 hw-campaign-h743 flash-dbgstress-h743 test-dbg-stress hw-random-flow-h743
	pwsh -NoProfile -Command "Write-Host 'full flow (h743) done'"

full_flow_6800evk: FLOW_LOCAL = --local
full_flow_6800evk: board-check-6800evk hw-campaign-hpm flash-dbgstress-6800evk test-dbg-riscv hw-random-flow-6800evk
	pwsh -NoProfile -Command "Write-Host 'full flow (6800evk) done'"

# 把基准结果打成小结表（跑完会自动打；这里是对着历史 JSON 重打，不用碰硬件）
#   make campaign-summary                                   # 默认读 HPM 那份
#   make campaign-summary ARGS=tmp/campaign-result.json     # 读 F103 那份
campaign-summary:
	$(NODE) tools/selftest/campaign-summary.mjs $(ARGS)

test-bridge:
	$(NODE) tools/selftest/bridge.test.mjs

# 屏页「动画 / 视频」的示例素材（GIF / APNG / 动画 WebP / MP4 / WebM）—— 见 samples/anim/README.md
samples-anim:
	$(PY) tools/dev/make-anim-samples.py $(ARGS)

# 屏页「图片/图案刷屏」的风景照片素材（4 类 x 2 张 x 2 种屏）—— 见 samples/test_images/scenery/README.md
samples-scenery:
	$(PY) tools/dev/make-scenery-samples.py $(ARGS)

# 风景照片素材的完整性（文件齐 + parseBMP 解得动 + sha256 对账）—— 纯 Node、离线
test-scenery:
	$(NODE) tools/selftest/scenery-samples.test.mjs

test-all: test test-ui test-hw test-bridge
	pwsh -NoProfile -Command "Write-Host '全部自测跑完'"

# ---------------------------------------------------------------- 本地桥
bridge:
	$(NODE) bridge/rtt-bridge.mjs --target $(TARGET)

bridge-stop:
	pwsh -NoProfile -Command "Get-Process openocd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$$_.CommandLine -like '*rtt-bridge.mjs*' } | ForEach-Object { Stop-Process -Id \$$_.ProcessId -Force -ErrorAction SilentlyContinue }"

# ---------------------------------------------------------------- 目标固件
fw-build:
	pwsh -NoProfile -File $(FW_DIR)/build.ps1

fw-flash:
	pwsh -NoProfile -File $(FW_DIR)/flash.ps1

fw-restore: fw-build fw-flash
	pwsh -NoProfile -Command "Write-Host '测试固件已烧回，板子随时可用'"

# STM32H7B0（RTT 吞吐测试固件；板子换成 H7B0 时用这组）
H7_DIR = tools/target-firmware/stm32h7b0_rtt_speed

fw-h7-build:
	pwsh -NoProfile -File $(H7_DIR)/build.ps1

fw-h7-flash:
	pwsh -NoProfile -File $(H7_DIR)/flash.ps1

# 不依赖硬件的两项体检：flash 算法条目自洽性、烧录计划（擦除/分块/补齐/范围）
algo-check:
	$(PY) tools/dev/verify-algo.py

flash-plan:
	$(NODE) tools/dev/check-flash-plan.mjs $(FW_DIR)/build/fw.elf $(H7_DIR)/build/fw.elf

# ---------------------------------------------------------------- 逻辑分析仪
la-info:
	$(PY) $(LA) info

la-capture:
	$(PY) $(LA) capture --rate 100000000 --time 0.05 --out tmp/la-now.csv
	pwsh -NoProfile -Command "Write-Host '波形已存 tmp/la-now.csv；SWD 解码： $(PY) $(LA) decode tmp/la-now.csv --ch-clk 0 --ch-dio 1'"

# ---------------------------------------------------------------- git / 体检
git-status:
	git status --short
	git log --oneline -5

git-log:
	git log --oneline -15

check:
	$(NODE) tools/dev/check-syntax.mjs
	$(NODE) tools/dev/check-liquid.mjs
	pwsh -NoProfile -Command "Write-Host 'syntax + liquid check ok'"

clean: clean-firmware
	pwsh -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue tmp/*.csv, tmp/*.bin, tools/la/__pycache__"
	pwsh -NoProfile -Command "Write-Host '清理完成（临时文件与固件构建目录）'"

# 只清理靶子固件的生成目录；根上的入库 fw.elf 和源码会保留。
clean-firmware:
	pwsh -NoProfile -ExecutionPolicy Bypass -File tools/dev/clean-firmware.ps1

.PHONY: test-stability test-probe
test-probe:
	$(NODE) tools/selftest/probe-status.test.mjs
	$(NODE) tools/selftest/probe-manager.test.mjs
	$(NODE) tools/selftest/probe-feature-registry.test.mjs
	$(NODE) tools/selftest/hid-channel.test.mjs
	$(NODE) tools/selftest/probe-bus.test.mjs
	$(NODE) tools/selftest/probe-cross-tab.test.mjs
	$(NODE) tools/selftest/probe-integration.test.mjs
	$(NODE) tools/selftest/usb-device.test.mjs
	$(NODE) tools/selftest/usb-transports.test.mjs
	$(NODE) tools/selftest/cdc-mode.test.mjs
	$(NODE) tools/selftest/spi-cdc.test.mjs
	$(NODE) tools/selftest/spi-connect.test.mjs
	$(NODE) tools/selftest/spi-teardown.test.mjs

test-stability: test-probe
	$(NODE) tools/selftest/bridge-memory.test.mjs
	$(NODE) tools/selftest/bridge-rpc.test.mjs
	$(NODE) tools/selftest/spi-runner-lifecycle.test.mjs
	$(NODE) tools/selftest/i2c-lifecycle.test.mjs
	$(NODE) tools/selftest/recorder-lifecycle.test.mjs
	$(NODE) tools/selftest/flash-lifecycle.test.mjs
	$(NODE) tools/selftest/flash-runner-abi.test.mjs
	$(NODE) tools/selftest/dbg-lock.test.mjs
	$(NODE) tools/selftest/dbg-view-lock.test.mjs
	$(NODE) tools/selftest/dbg-backend-lifecycle.test.mjs
	$(NODE) tools/selftest/dap-register-ready.test.mjs
	$(NODE) tools/selftest/dap-disconnect.test.mjs
	$(NODE) tools/selftest/probe-handoff.test.mjs
	$(NODE) tools/selftest/probe-users.test.mjs
	$(NODE) tools/selftest/probe-bus-failure.test.mjs
	$(NODE) tools/selftest/rtt-lifecycle.test.mjs
	$(NODE) tools/selftest/rtt-cdc-lifecycle.test.mjs
	$(NODE) tools/selftest/scope-lifecycle.test.mjs
	$(NODE) tools/selftest/scope-watchdog.test.mjs
	$(NODE) tools/selftest/target-switch.test.mjs

.PHONY: test-spi-cdc test-spi-cdc-page spi-cdc-hw
test-spi-cdc:
	$(NODE) tools/selftest/spi-cdc.test.mjs

test-spi-cdc-page:
	$(NODE) tools/selftest/spi-cdc-page.test.mjs

spi-cdc-hw:
	$(NODE) tools/selftest/spi-cdc-hw.mjs

.PHONY: test-analog test-analog-connection-page
test-analog-connection-page: page-prep
	$(NODE) tools/selftest/analog-connection-page.test.mjs

test-analog:
	$(NODE) tools/selftest/analog.test.mjs
	$(NODE) tools/selftest/analog-connect.test.mjs
	$(NODE) tools/selftest/adc-scope.test.mjs
	$(NODE) tools/selftest/adc-measure.test.mjs
	$(NODE) tools/selftest/adc-view.test.mjs
	$(NODE) tools/selftest/adc-session.test.mjs
	$(NODE) tools/selftest/adc-transport.test.mjs
	$(NODE) tools/selftest/dac-protocol.test.mjs
	$(NODE) tools/selftest/dac-generator.test.mjs

# 真页面游标与自动测量验收，使用已知原始样本，不连接 USB。
.PHONY: test-adc-measure-page
test-adc-measure-page:
	$(NODE) tools/selftest/adc-measure-page.test.mjs $(ARGS)

# ADC 真机矩阵：4 种转换位宽 × 多档时基，有限/连续/环回采集与安全收尾。
# 需要 HPM5301 EVKLite 探针、USB ADC 页面和授权的 Chrome/Edge；生成 tmp/JSON 报告。
.PHONY: test-adc-hw
test-adc-hw: page-prep
	$(NODE) tools/selftest/adc-hw-stress.mjs $(ARGS)

# 真实 BMP 发送测速：无需接屏，核对探针执行计数，默认两款屏各自整屏尺寸。
.PHONY: test-spi-image-rate-hw
test-spi-image-rate-hw: page-prep
	$(NODE) tools/dev/spi-image-rate-hw.mjs $(ARGS)

.PHONY: test-analog-wire
test-analog-wire:
	$(NODE) tools/selftest/analog-wire.test.mjs

# Selected-frame/locals release gate: a matching independently collected GDB oracle is required.
# H743 only: a SysTick/FPB coincident halt is resumed only when CPUID, DFSR, DWT, active FPB
# and the exception-stacked checkpoint PC all agree; every other wrong-PC stop remains a failure.
FRAME_BOARD ?= f103cb
FRAME_ELF ?= /tools/target-firmware/stm32f103_dbgstress/build-cb-og/fw.elf
FRAME_ORACLE ?= tmp/frame-oracle-$(FRAME_BOARD).json
FRAME_REMOTE ?= 127.0.0.1:3333
FRAME_GDB ?= arm-none-eabi-gdb
FRAME_ROUNDS ?= 200
.PHONY: build-dbg-frames-f103cb build-dbg-frames-6800evk dbg-frame-oracle test-dbg-frames test-dbg-frames-6800evk test-dbg-frame-native test-dbg-frame-gdb
build-dbg-frames-f103cb:
	pwsh -NoProfile -File tools/target-firmware/stm32f103_dbgstress/build.ps1 -Board cb -Optimization Og $(ARGS)

dbg-frame-oracle:
	$(NODE) tools/selftest/dbg-frame-gdb-oracle.mjs --board="$(FRAME_BOARD)" --elf="$(patsubst /%,%,$(FRAME_ELF))" --remote="$(FRAME_REMOTE)" --gdb="$(FRAME_GDB)" --out="$(FRAME_ORACLE)" $(ARGS)

test-dbg-frames:
	$(NODE) tools/selftest/dbg-frame-gdb-oracle.mjs --validate-only --board="$(FRAME_BOARD)" --elf="$(patsubst /%,%,$(FRAME_ELF))" --out="$(FRAME_ORACLE)"
	$(MAKE) page-prep
	$(NODE) tools/selftest/dbg-hw-stress.mjs --board="$(FRAME_BOARD)" --elf="$(FRAME_ELF)" --frames-only --require-frame-oracle --frame-oracle="$(FRAME_ORACLE)" --frame-rounds="$(FRAME_ROUNDS)" $(ARGS)

build-dbg-frames-6800evk:
	pwsh -NoProfile -File tools/target-firmware/hpm6800evk_dbgstress/build.ps1 -Optimization $(FRAME_OPT) -Dwarf $(FRAME_DWARF) -NoCopy $(ARGS)

flash-dbg-frames-6800evk:
	$(NODE) tools/selftest/flash-elf.mjs --board=6800evk --elf="$(FRAME_ELF)" $(ARGS)

test-dbg-frames-6800evk:
	$(NODE) tools/selftest/dbg-frame-gdb-oracle.mjs --board=6800evk --elf="$(patsubst /%,%,$(FRAME_ELF))" --remote="$(FRAME_REMOTE)" --gdb="$(FRAME_GDB)" --out="$(FRAME_ORACLE)" --validate-only
	$(MAKE) page-prep
	$(NODE) tools/selftest/dbg-hw-riscv.mjs --elf="$(FRAME_ELF)" --frames-only --frame-oracle="$(FRAME_ORACLE)" --frame-rounds="$(FRAME_ROUNDS)" --out="$(FRAME_RESULT)" $(ARGS)

test-dbg-frame-native:
	$(NODE) tools/selftest/dbg-frame-contract.test.mjs --native

test-dbg-frame-gdb:
	python tools/selftest/dbg-frame-gdb.test.py

# HPM target selection and port lifecycle in the browser, no hardware.
.PHONY: test-hpm-porting-page
test-hpm-porting-page: page-prep
	$(NODE) tools/selftest/hpm-porting-page.test.mjs

# SWO: pure offline / real browser offline / F103CB hardware with full Flash restore.
.PHONY: test-swo test-swo-page build-swo-f103cb test-swo-hw test-swo-baud-hw
test-swo:
	$(NODE) tools/selftest/swo.test.mjs
	$(NODE) tools/selftest/swo-capture.test.mjs
	$(NODE) tools/selftest/swo-ports.test.mjs
	$(NODE) tools/selftest/swo-export.test.mjs
	$(NODE) tools/selftest/swo-demo.test.mjs
	$(NODE) tools/selftest/swo-matching.test.mjs
test-swo-page:
	$(NODE) tools/selftest/swo-page.test.mjs
build-swo-f103cb:
	pwsh -NoProfile -File tools/target-firmware/stm32f103cb_swo/build.ps1

.PHONY: build-swo-f103cb-hse
build-swo-f103cb-hse:
	pwsh -NoProfile -File tools/target-firmware/stm32f103cb_swo_hse/build.ps1
test-swo-hw:
	$(NODE) tools/selftest/swo-hw.mjs

test-swo-baud-hw:
	$(NODE) tools/selftest/swo-baud-hw.mjs

.PHONY: build-swo-f103cb-clock test-swo-clock-hw
build-swo-f103cb-clock:
	pwsh -NoProfile -File tools/target-firmware/stm32f103cb_swo_clock/build.ps1
test-swo-clock-hw:
	$(NODE) tools/selftest/swo-clock-hw.mjs

# Current fixed-clock fixture acceptance; does not flash/reset/halt the target.
.PHONY: test-swo-current-hw
test-swo-current-hw:
	$(NODE) tools/selftest/swo-current-hw.mjs
