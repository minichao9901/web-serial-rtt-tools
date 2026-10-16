# Web 审查问题修复与验证记录

日期：2026-10-16（Asia/Shanghai）  
范围：[合并修改清单](../../web-review-fix-list-2026-10-16.md)中的 F01–F13，以及已确定的共性维护／界面调整。

**结果：13 项功能问题均已完成软件修复与回归。** 保留原有探针／USB 资源保护，未修改固件；需要实板核验的 H01–H04 仍单独保留。网页源码、发布脚本和便携桥包的网页副本已同步。

## 1. 修复结果

| 编号 | 最终行为 | 主要位置 |
| --- | --- | --- |
| F01 | 本次串口写失败会拒绝返回的 Promise；内部写队列恢复后仍可处理下一次写。 | `app/serial/session.js` |
| F02 | 定时发送最多一笔在飞；停止／改周期会取消未提交到底层的旧代次；人工写入独立。 | `app/serial/assistant.js`、`session.js` |
| F03 | 新 ADC 采集在首个有效数据块到达后才切换记录；连接、参数、START 失败均保留原波形。 | `app/analog/view.js` |
| F04 | SPI 配置、切档、复位、失能、模拟切换通过统一控制门；忙碌期两页一致禁用；寄存器操作也占用共享忙碌状态。只读查询保留；即便视图没有显式置忙，所有在飞 sendFrames 事务也持有忙碌状态。 | `app/spi/session.js`、`bus-view.js`、`panel-view.js`、`reg-view.js` |
| F05 | STOP 未确认时仍保留占用，提供“重试停止”；关闭连接也可进入受控重试，未成功确认前不允许冲突功能接管。 | `app/spi/acq-view.js`、`session.js` |
| F06 | SPI 使能／失能等待实际状态确认；拒绝或无法确认时不打印“引脚已释放”。不把粘性历史错误位当本次错误码。 | `app/spi/session.js` |
| F07 | 所有 15 个页面从同一视图登记表分发 onShow，烧录器回调不再遗漏。浏览器实测 HPM5301 → 调试器 HPM6800 → 烧录器可同步为 HPM6800。 | `app/main.js` |
| F08 | 读写、自愈、DHCSR 控制写和显式调试口恢复共用内存互斥；自愈失败保持 fault，并拒绝继续执行本次读写。 | `app/rtt/dap-webusb.js` |
| F09 | USB 超时恢复接口后标记目标会话待恢复；普通 SWD 读写在锁内恢复，JTAG 操作要求重新建立连接，不自动误切 SWD。 | 同上 |
| F10 | 块读零进展明确报地址和剩余长度；部分数据之后再出现零进展也失败，不以缺失尾部的零值伪装完整成功。 | 同上 |
| F11 | 命令表独立携带 resultRow；脚本行号只作脚本定位，不能覆盖命令表结果。 | `app/i2c/view.js` |
| F12 | 单步前清除旧 resume 应答，接受新应答以支持同 PC 自循环；未确认执行不宣称完成；请求／等待失败仍清理临时 step 和 resumereq，清理失败双报。 | `app/dbg/riscv.js` |
| F13 | SPI 转发连接和周期采集同时发生主体／清理错误时以 AggregateError/cause 双报；失败句柄、失败占用保留。 | `app/spi-cdc/session.js`、`app/core/bus-periodic.js` |

## 2. 维护与界面调整

- 统一 dock 与生成文件预览 Tab 的键盘导航、焦点、选中状态和 aria；保留各页业务回调。所有受查 Tab 均可切换。
- 顶栏布局收敛到单一主体定义；390px 下允许状态区换行。屏读回的参数行换行，生成文件条可滚动，避免裁切。
- SPI／屏／J-Scope／RTT 转发／SPI 转发增加控制、数据或接收口的分项状态，复用已有低频状态更新，不新增硬件轮询。
- 隐藏页减少统计 DOM 写入与只读 STATUS 轮询；采集、记录、必要确认和用户定时发送继续运行。
- 连接／SWD 初始化与 RTT 校验／初始化增加逻辑总预算和阶段信息。**预算用来限制后续新请求，不放弃已经在飞的 USB 请求；生命周期收尾可能超过逻辑预算。**
- 关键短等待采用已有 pace 原语；保留长等待和超时看门狗。
- 烧录日志改为增量、有界、每帧合并滚动；没有把此前估计的单行耗时当本轮性能结果。
- USB 所有权错误使用稳定错误码，Scope 恢复不再依赖中文文案识别冲突。
- Mock SPI 停止后不再交付旧代次应答；终端渲染异常会暂停该显示并提示清空重试，原始接收与记录继续。
- 补充 GIF loop 初值，删除一条重复的 DWARF data16 分支与过期说明。ADC 两条接收实现保留现有结构，以共同契约回归覆盖，未进行不必要的数据通路重写。
- 修复两项 SVD 测试夹具缺失状态；周期总线测试可显式指定固件路径，并自动为子进程补齐 api 头文件路径。没有修改全局环境设置。

逐页美观建议仍保留在原审查报告中。本轮落实的是上述共性、可验证调整，没有一次性重排所有页面的业务工作流。

![窄窗口参数自动换行（模拟连接）](final-preview.png)

## 3. 验证证据

| 验证 | 结果与证据 |
| --- | --- |
| 新功能回归 | [web-review-fixes.test.mjs](../../../tools/selftest/web-review-fixes.test.mjs)：覆盖错误传播、慢写背压／取消、ADC 数据保留、SPI 忙碌／重试停止／状态确认、串行自愈／短读、I2C 归属、单步应答和请求失败清理、双错误。 |
| 新维护回归 | [web-review-maintenance.test.mjs](../../../tools/selftest/web-review-maintenance.test.mjs)：验证总预算不启动过期新请求且不丢弃在飞请求、显示故障后恢复、Mock 旧响应取消、稳定资源错误码、Tab 键盘与 aria。 |
| 最终逐项回归 | **107 个入口全部通过**；[最终结果](regression-ownership/results.json)，每项独立原始日志；[执行器](run-regressions-ownership.py)。包含原有未提交 AP discovery 测试。 |
| 标准离线入口 | `make test-offline` 退出码 0；[完整日志](make-test-offline.log)。包含 406 模块语法检查、Markdown 检查、发布包一致性和标准自测。最后补强了单步请求失败清理与单帧事务占用保护，随后又执行上述最终逐项回归，避免把旧结果当最终通过。 |
| ETM 控制器／服务器 | 43 个 Node 测试、8 个服务器测试、23 个生命周期测试、3 个 Demo 初始化测试，全部通过，含 200 组操作顺序场景；[结果](etm-tests/result.json)。 |
| 浏览器主页面 | 源码入口 15 页，1440×1000／1024×768／390×844 共 **45 组**，未发现整页横向溢出和重复 ID；[测量](browser-layouts.json)。 |
| 浏览器 Tab | **83 个内部 Tab／显示模式／文件预览全部可切换**；[结果](browser-subtabs.json)。SPI 箭头键切换及焦点实测见 [dock-browser.json](dock-browser.json)。 |
| 目标同步／共享串口 | HPM 板型跨页同步已实际验证；[截图](flash-sync-fixed.png)。发布包中 Demo 串口发送与终端共用连接正常，见 [状态](bundle-serial-shared.json)。 |
| 源码／发布包 | 发布包 169 个源模块，build/check 通过；浏览器发布包入口 15 页正常，[结果](bundle-pages.json)。最终发布脚本逐页复核见 [bundle-ownership-browser.json](bundle-ownership-browser.json)。 |
| 便携桥包 | 官方构建器重建下载 ZIP，补齐未提交新模块的源文件收集；当前包的 **7 项独立便携验证通过**，包含中文／空格路径、缺少 Python/Node 环境的运行、Demo 重解码、记录排除等；[最终日志](portable-ownership.log)。 |
| 实物硬件 | **not-run**：没有连接、烧录、复位或采集实物探针／目标板／Kingst。模拟结果未被当作实机性能。 |

### 验证中的失败与修正

首轮 106 项中 105 项通过，唯一失败是 `flash-sram-flow.test.mjs` 的 Node DOM 夹具没有 requestAnimationFrame。改用按帧日志后该夹具必须提供帧调度；已修复测试夹具并重测。原始失败保留在 regression-1，最终逐项验证为 107/107。没有通过给生产代码吞错或可选链来掩盖测试问题。

## 4. 版本、产物与保留项

- 原有 AP discovery 未提交逻辑保留；[前置差异](before.diff)、[原文件副本](dap-webusb.before.js)与[保留检查](preserved-ap-discovery.json)可复核。
- 未修改 `E:/Share/github/akaLinkPro` 固件仓库。H01 电源 ACK 策略、H02 遗留固件引擎、H03 固件中断时序、H04 配置感知引脚租约仍等待对应实物专项，不冒充已验收。
- 当前网页及便携包均包含原有未提交 AP 改动，验证对应此完整工作树，不代表只包含本轮差异的干净提交。
- 当前源码清单：[inputs-ownership.json](inputs-ownership.json)；生成产物与最终代码指纹见 final-status.json／SHA256SUMS.txt；[产物核对脚本](verify-artifacts.py)逐一核对最终源码、169 个随包模块和发布脚本。
- 下载 ZIP：`E:/web-serial-rtt-tools/bridge/etm/downloads/etm-bridge-win64.zip`。它已在本地同步，不代表已部署到线上。
- 本轮未提交 Git、推送、部署或修改全局设置。证据保存在当前持久工作区，未形成远端备份。

## 5. 验证元数据

- Agent: Codex
- Stage: ready-for-review
- Tested-Revision: pre-commit-worktree
- Tested-Base: fb06da2348543b75db5fbc237dd4d3b0ffe1d655
- Tested-Dirty: true
- Validation-Run-ID: 20261016-web-fixes-074958
- Validation-Result: passed（软件回归、浏览器检查及便携包检查范围）
- Validation-Cwd: E:/web-serial-rtt-tools
- Validation-Script: docs/validation/20261016-web-fixes-074958/run-regressions-ownership.py
- Validation-Script-Fullpath: E:/web-serial-rtt-tools/docs/validation/20261016-web-fixes-074958/run-regressions-ownership.py
- Validation-Command: python docs/validation/20261016-web-fixes-074958/run-regressions-ownership.py
- Validation-Report: E:/web-serial-rtt-tools/docs/validation/20261016-web-fixes-074958/report.md
- Evidence-Fullpath: E:/web-serial-rtt-tools/docs/validation/20261016-web-fixes-074958
- Related-Revision: akaLinkPro=321487255d2ececea8d56282b07f3c7254e9862b
- Hardware-Test: not-run
- 重要证据和报告 SHA256 见同目录 SHA256SUMS.txt，报告不自引用自身指纹。
