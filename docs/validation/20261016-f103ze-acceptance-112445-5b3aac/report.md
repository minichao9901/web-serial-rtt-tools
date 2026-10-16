# F103ZE 整板验收：前置检查记录

- Validation-Run-ID: 20261016-f103ze-acceptance-112445-5b3aac
- Tested-Revision: pre-commit-worktree
- Tested-Base: fb06da2348543b75db5fbc237dd4d3b0ffe1d655
- Tested-Dirty: true
- Related-Revision: akaLinkPro=321487255d2ececea8d56282b07f3c7254e9862b
- Validation-Cwd: E:\web-serial-rtt-tools
- Validation-Command: python E:\web-serial-rtt-tools\docs\validation\20261016-f103ze-acceptance-112445-5b3aac\preflight.py
- Validation-Result: partial
- Hardware-Test: not-run
- 当前状态：等待本机探针重新连接；用户已确认验收方案，无需重新确认。

## 已实际完成

1. USB/PnP/串口枚举：没有发现 VID 0D28 探针，没有串口。原始输出见 usb-enumeration.log、pnp-before.json。
2. KingstVIS 23367 查询接口有响应，返回支持 500 MSa/s、当前 500 MSa/s、深度 5000000、no error；这仅说明查询接口可用，不是本轮实物采集通过。
3. `make -n full_flow_f103ze` 成功；仅检查命令编排，没有执行完整实板流程。
4. `make build-f103ze-examples` 成功：RTT、序列 RTT、Scope、默认调试固件四份。
5. 额外构建 Og 调试、八类故障诊断、24 MHz SWO ZE 固件成功，共七份 ELF；SWO 使用 ZE 的 512 KiB Flash/64 KiB SRAM 链接脚本。产物已复制到 built-artifacts，指纹见 artifacts.json。
6. OpenOCD 版本检查成功。默认 arm-none-eabi-gdb 不含 Python；gdb-py 缺少 site。通过本轮目录中的空 site 启动模块和仅对子进程设置 PYTHONPATH，已确认 _gdb 可用，版本 10.2.90.20210621-git；未修改全局环境。原始失败与成功日志均保留。调用栈对照采集器原有 _gdb 兼容逻辑可使用该入口，真实目标采集仍未运行。

## 验收入口问题与处理

- 现有 swo-hw.mjs 写死 CB 的 128 KiB 备份、0x410 身份与 1 KiB 页恢复逻辑，不能直接用于 ZE。新 SWO ELF 已按 ZE 链接，实板执行还需配套 ZE 备份及恢复流程；不能仅修改脚本 board 标签。
- full 流程 RTT/Scope 默认是 96 MHz 超频基准。该事实来自当前测试固件源码；后续须独立记录该基准，并补做 72 MHz 额定档，不能用超频吞吐数字替代额定验收。
- page-prep/部分 campaign 自动准备会调整多个既有测试浏览器授权或停止占端口进程。当前只做 dry run，没有执行这些动作；实板使用时限定本轮浏览器、端口和授权资源。
- 协调目录现有 hardware.lock 的 PID 36460 不存在，owner 仍记录 H7B0 旧任务。未抢占或删除；连接硬件后还须核实实际采集状态，再按项目租约规范归档旧锁并原子取得新锁。

## 尚未执行

芯片身份/容量/保护位读取、原 Flash 双份备份、真实 make full、GDB 断点/单步/调用栈、SWO 采样、ETM 采集/解码及原固件恢复，全部为 not-run。未对板子发送暂停、复位、擦除或烧录操作。

需要用户恢复这台电脑上的探针 USB 连接。连接恢复后，继续既定验收顺序；所有会写目标的动作以原 Flash 完整备份通过为前置。

## 证据与工作区

命令、时间、工作目录、返回码见 preflight-results.json 和 gdb-python-scoped.json。工作区原始差异见 worktree-before.patch；源码未因本轮预检修改。两份构建改变的已跟踪下载 ELF 已在保留本轮产物后恢复到本轮开始前状态。没有提交、推送、发布、修改全局设置、取得硬件锁或启动后台服务。

全部本轮文件指纹见 SHA256SUMS.txt（不包含自身）。本报告描述本轮真实执行，不沿用历史实板通过结论。
