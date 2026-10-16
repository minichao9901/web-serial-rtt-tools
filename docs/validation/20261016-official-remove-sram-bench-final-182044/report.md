# 正式版移除烧录页 SRAM 读写测速验收

本次将烧录页 SRAM 读写测速作为一次性实验功能从正式版移除。侧栏入口、测速表单、`FlashView` 测速流程、专用 SWD 批量传输/档位逻辑，以及只服务于该功能的测试均已清理。烧录算法继续通过 SRAM 工作区运行，通用目标内存读写和全局硬复位保留。

| 项目 | 结果 |
| --- | --- |
| Validation-Run-ID | `20261016-official-remove-sram-bench-final-182044` |
| 验证时间 | 2026-10-16 18:20（Asia/Shanghai） |
| Tested-Revision | `pre-commit-worktree` |
| Tested-Base | `e7fba054d2e7803ad131a36768784adc75e81d17` |
| Tested-Dirty | `true`；受测工作树包含本次源码改动及仓库已有的未跟踪验收资料；提交范围按路径隔离 |
| 环境 | Node.js `v24.13.1`，npm `11.8.0`，Windows PowerShell |
| 总结果 | `passed`（本报告列明的离线和浏览器验收通过） |
| 硬件测试 | `not-run`；本次只移除实验页面及专属代码，复位协议实现未变，由页面模拟与协议回归覆盖 |

## 验证记录

工作目录：`E:/web-serial-rtt-tools`

| 命令 | 脚本绝对路径 | 结果 |
| --- | --- | --- |
| `npm run build:web` | `E:/web-serial-rtt-tools/tools/dev/build-svd.mjs`、`E:/web-serial-rtt-tools/tools/dev/build-web.mjs` | 通过；SVD 生成 3 份，网页包从 167 个源码模块构建，体积 1,311,839 字节 |
| `npm run check:web` | `E:/web-serial-rtt-tools/tools/dev/build-web.mjs` | 通过；167 个源码模块与生成网页包一致 |
| `node tools/selftest/flash-reset-flow.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/flash-reset-flow.test.mjs` | 通过；全局 CMSIS-DAP 复位页面流程及探针释放 |
| `node tools/selftest/target-reset.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/target-reset.test.mjs` | 通过；复位脉冲时长、DAP 封包和断言/释放失败路径 |
| `node tools/selftest/flash-lifecycle.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/flash-lifecycle.test.mjs` | 通过；烧录/读身份的探针占用、失败关闭恢复和生命周期 |
| `node tools/selftest/flash-data-clock.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/flash-data-clock.test.mjs` | 通过；烧录 SRAM 数据通路、时钟恢复和写后校验 |
| `node tools/selftest/flash-runner-abi.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/flash-runner-abi.test.mjs` | 通过；烧录算法 ABI 与分块几何 |
| `node tools/selftest/dap-abort.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/dap-abort.test.mjs` | 通过；通用 DAP sticky 错误清除与失败传播 |
| `node tools/selftest/ui-layout-page.test.mjs` | `E:/web-serial-rtt-tools/tools/selftest/ui-layout-page.test.mjs` | 独立复跑通过；1280 / 1600 宽度、15 个页面入口，共 66 项断言，0 失败；无页面异常 |
| `node --check tools/selftest/target-reset-hw.mjs` | `E:/web-serial-rtt-tools/tools/selftest/target-reset-hw.mjs` | 通过；保留的真机复位验收脚本语法检查 |
| `git diff --check` | Git 内置检查 | 通过 |

页面布局测试原先把工具入口总数写成 14，源码实际有 15 个入口；已修正这条过期断言。一次并行执行时浏览器 CDP 调用超时，之后独立重跑整套页面布局验收，最终 66/66 通过。`ui-layout.json` 保存通过后的页面结果；`flash-1280.png` 留存清理后的烧录页截图。

源码和生成包检查确认，正式页面、模块清单与程序包已不含 SRAM 测速入口或实现。历史验证报告、`test_sram.bin` 固件生成夹具和通用 SRAM 访问路径保留，不属于产品测速入口。

## 证据

- 浏览器布局结果：`E:/web-serial-rtt-tools/docs/validation/20261016-official-remove-sram-bench-final-182044/ui-layout.json`
- 烧录页截图：`E:/web-serial-rtt-tools/docs/validation/20261016-official-remove-sram-bench-final-182044/flash-1280.png`
- 发布包：`E:/web-serial-rtt-tools/app/site/main.js`
- 发布包模块清单：`E:/web-serial-rtt-tools/app/site/manifest.json`
- SHA256 清单：`E:/web-serial-rtt-tools/docs/validation/20261016-official-remove-sram-bench-final-182044/sha256.json`

未执行真实板卡操作；本轮不覆盖写目标内存，也没有重新执行先前已完成的整板验收。
