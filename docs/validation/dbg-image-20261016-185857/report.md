# 调试器 load_image / dump_image 验证

日期：2026-10-16（北京时间）。执行者：Codex。结果：passed。

## 输入与范围

- Tested-Revision: pre-commit-worktree
- Tested-Base: 5a6beb7d7b19c7b42982fb3176a689ade751e4f7
- Tested-Dirty: true
- Validation-Result: passed
- Validation-Run-ID: dbg-image-20261016-185857
- Validation-Cwd: E:/web-serial-rtt-tools
- Validation-Report: E:/web-serial-rtt-tools/docs/validation/dbg-image-20261016-185857/report.md
- Hardware-Test: passed
- 环境：Windows，PowerShell，Node.js v24.13.1，Chrome 155，页面服务 127.0.0.1:8899，浏览器自动化端口 9333。
- 前序按钮统一修改已单独提交为上述 Tested-Base；本功能保留在工作区，未推送。
- 输入索引：本目录 input-sha256.json；已跟踪文件差异：worktree.patch。新增模块和测试脚本列在输入索引中。

命令参数依据 [OpenOCD 官方文档](https://openocd.org/doc/html/General-Commands.html#Image-loading-commands) 和 upstream `src/target/image.c`、`src/target/target.c` 实现。支持 BIN/IHEX/ELF/S19、内容识别、偏移后地址窗口裁剪、ELF PT_LOAD、保留空洞和 BSS。dump 固定输出二进制。复用现有 DebugSession 内存接口，不增加探针传输实现。

用户选择的文件模型是“选择一次镜像目录，随后使用文件名或相对路径”。目录权限保持在当前页面会话内，不跨刷新保存。支持带空格路径的双引号、大括号和反斜杠转义；不提供完整 Tcl 脚本解释、变量替换或表达式求值。当前目标接口限制为 32 位地址空间。读写不自动更改 CPU 运行状态和符号；load_image 不替代 Flash 烧录算法。

## 软件与页面验证

以下命令均实际执行，工作目录均为上述 Validation-Cwd；脚本完整路径为该目录加下列相对路径。

| 入口 | 实际结果 |
| --- | --- |
| `node tools/selftest/dbg-image.test.mjs` | 通过：参数/数字范围、文件名分组、BIN/IHEX/S19、ELF32/64 双字节序、PT_LOAD 地址选择、BSS/空洞、偏移/裁剪、分块读写、取消、短读、关闭失败、路径限制、真实 DebugSession 模拟目标往返 |
| `make test-dbg` | 最终输入再次运行通过；核心 326 项通过、0 失败，源代码、运行恢复、诊断、DWT、回溯、局部变量、RISC-V、SVD 等前置套件及新镜像套件通过；原始输出 test-dbg.log |
| `node tools/selftest/dbg-lock.test.mjs` | 通过：会话互斥回归 |
| `node tools/selftest/dbg-backend-lifecycle.test.mjs` | 通过：调试后端生命周期回归 |
| `node tools/selftest/dbg-riscv-memory.test.mjs` | 通过：RISC-V 内存接口回归 |
| `npm run build:web` | 最终生成 169 模块、1,325,143 字节发布包 |
| `npm run check:web` | 最终发布包与源码一致 |
| `git diff --check` | 通过，无空白错误；Git 提示既有换行转换策略 |
| `$env:IMAGE_OUT='E:/web-serial-rtt-tools/docs/validation/dbg-image-20261016-185857/browser-release'; node tools/selftest/dbg-image-page.test.mjs` | 源码入口、最终发布包入口均通过，见 browser-release/result.json |

浏览器测试新建独立页面，连接模拟调试目标；使用真实 OPFS FileSystemDirectoryHandle 和文件写入流，仅把目录选择器替换为返回该测试目录。不自动确认操作系统权限弹窗。通过目录按钮、命令输入框 Enter、帮助和 Tab 补全，执行 12,289 字节加载与导出，逐字节核对内存与文件；确认 PC、停止状态、符号未变；中断导出后原文件仍为 [99,88]；零长度导出、路径越界拒绝均通过。页面错误列表为空。1280/1600 宽度截图与横向溢出检查通过，截图位于 browser-release/。

早期 browser/、browser-final/ 是本轮较早检查，最终网页结果以 browser-release/ 为准。一次重建出现 Windows 打开 app/site/main.js 的 UNKNOWN 错误，重试构建成功，之后重新执行发布包检查及两入口页面测试；未把失败构建后的旧发布包结果当作最终验证。

## F103ZE 实板

命令：`node docs/validation/dbg-image-20261016-185857/hardware.mjs`。

脚本完整路径：E:/web-serial-rtt-tools/docs/validation/dbg-image-20261016-185857/hardware.mjs。原始结果：同目录 hardware.json。执行时间：2026-10-16 19:03:21–19:03:42。探针序列号：8F538633E6AEC4CA8ABB6A36FEBB1AC2。目标 DBGMCU ID 低 12 位 0x414，Flash 512 KiB，SRAM 64 KiB。

取得硬件独占租约后，使用新浏览器页面、真实 WebUSB 探针和真实 DebugSession 内存接口执行命令。测试使用 1 MHz SWD，旨在核对功能，不代表最大吞吐率。未重置目标。先暂停，连续两次核对全部 SRAM 稳定，保存 SRAM 与核心寄存器现场，并校验 Flash 哈希；原始 SRAM 在第一次测试写入前已落盘。

- `load_image input.bin 0x20008000 bin`：写入 12,289 字节。
- `dump_image output.bin 0x20008000 12289`：导出 12,289 字节；文件、独立探针回读和输入逐字节一致。
- `load_image input.bin 0x2000c000 bin 0x2000c007 1009`：仅写入裁剪范围；核对前 7 字节和之后 8 字节均保留原 SRAM 内容。
- 恢复全部 65,536 字节 SRAM 并回读一致；20 个核心寄存器选择项一致；512 KiB Flash 哈希前后一致。CPU 从测试前的运行状态恢复为继续运行；探针断开，硬件租约释放。

主要证据：original-sram.bin、backup.json、dump-image.bin、hardware.json。完整 SHA256 见 evidence-sha256.json。SRAM 原始 SHA256：f17b598b6b84f4f22f64b1fa130d641380b8f66342ce8c21b018cdc6ddbaa7b6；导出数据 SHA256：09390b1ee898165caec37beb1eb19b6d3bcc68e36c90b205cb44fcbef3f16baf；Flash 前后 SHA256：61a097c84c8ca7cae573a950618de6009083048755b5c26def16f6cc351a354d。

实板验证针对 BIN 往返与裁剪；ELF/IHEX/S19 的格式及稀疏地址语义由软件测试覆盖。本轮未执行真实 OpenOCD 命令作对照，也未对其他板型实测。硬件运行后仅修改了命令补全逻辑，已重新执行最终软件与两入口页面验证，镜像读写和探针路径未再更改。

## 证据保存

本报告、脚本、截图、日志、二进制和哈希索引均存于 E:/web-serial-rtt-tools/docs/validation/dbg-image-20261016-185857/，为本机持久目录。部分日志和二进制被仓库忽略，不会随源码提交或推送自动备份。本报告哈希另存 report.sha256；索引不包含自身，避免自引用。
