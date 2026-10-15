# 烧录工作区、全屏与时钟选择：提交前验证

- Validation-Run-ID: 20261015-flash-ui-commit-1792077498978
- Tested-Revision: pre-commit-worktree
- Tested-Base: 353d94041ce5fd3f98b03683020bc55daf5ab981
- Tested-Dirty: true
- Validation-Result: passed（软件与发布包一致性）
- Hardware-Test: not-run（本轮未重新烧录目标板）

## 提交内容

烧录器使用“烧录／SRAM 读写测试”两个 tab，共用目标连接设置；切换保留输入，顶栏支持浏览器全屏进入、退出及状态同步。

烧录 tab 展示并保存时钟选项。WebUSB Cortex-M 数据载入与 Flash 校验使用所选档，执行控制维持 1 MHz；高速 RAM 拷贝必须完整读回一致后才允许执行算法，失败恢复控制时钟。本地桥和 RISC-V 路径传入所选时钟，复用的 OpenOCD 会话也重新设置档位；工程下载桥脚本同步更新。

SRAM 错误区分地址设置／完成检查、块读写、协议错误、WAIT／FAULT／无应答，保留原始响应；前一个操作失败时不能因后续块返回成功而接受整体结果。失败后状态栏退出“写入中”。本次没有判定线材是高档错误的唯一原因。

## 本轮实际执行

在 E:/web-serial-rtt-tools-commit-check-20261015 创建基线的干净临时工作树，并应用 staged.patch，未包含原有 app/rtt/dap-webusb.js 未提交修改。

执行 npm ci --ignore-scripts，然后逐一运行以下入口（node tools/selftest/入口名）：

- flash-data-clock.test.mjs
- sram-transfer.test.mjs
- flash-runner-abi.test.mjs
- flash-lifecycle.test.mjs
- flash-sram-flow.test.mjs
- hpm-flash.test.mjs
- bridge-kit.test.mjs
- bridge-lifecycle.test.mjs

8 个入口全部通过；覆盖时钟切换／恢复、数据损坏时禁止运行算法、默认行为、协议和响应错误、恢复与关闭失败、HPM 烧录软件流程、桥包逐字节一致性与生命周期。另执行 npm run check:web（167 个源码模块通过）及 node --check bridge/rtt-bridge.mjs。

前序实现阶段已检查真实浏览器的 tab 可见性、参数独立与刷新保存、不同后端下时钟选项，以及全屏 API 进入／退出与文字同步。本轮提交前没有重跑浏览器，也没有重新执行实板烧录，不把软件回归作为高频实板通过证据。

## 原始证据

本轮持久目录：E:/web-etm-trace-coordination/artifacts/ui-compact/20261015-flash-ui-commit-1792077498978/

tests.log、build-check.log、dependencies.log 保存实际输出，staged.patch 是受测变更快照，preexisting-dap.patch 记录排除的原有修改。证据指纹存 evidence-sha256.json；本机大证据不随 Git 上传。

前序浏览器证据：E:/web-etm-trace-coordination/artifacts/ui-compact/20261015-flash-clock/result.json、failure-state.json，以及 20261015-flash-tabs-fullscreen/result.json。CDP 合成 Escape 未证明浏览器原生 Esc 行为，未将其写作通过项。

未混入 app/rtt/dap-webusb.js、tools/selftest/dap-ap-discovery.test.mjs 和 docs/etm-page-review-2026-10-14.md 的原有未提交内容。
