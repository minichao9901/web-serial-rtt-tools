# 关闭 DAP 阶段日志及 RAM 填充命令验证

日期：2026-10-16（北京时间）。执行者：Codex。结果：passed。

- Tested-Revision: pre-commit-worktree
- Tested-Base: 5a6beb7d7b19c7b42982fb3176a689ade751e4f7
- Tested-Dirty: true
- Validation-Result: passed
- Validation-Run-ID: ram-fill-20261016-223752
- Validation-Cwd: E:/web-serial-rtt-tools
- Validation-Report: E:/web-serial-rtt-tools/docs/validation/ram-fill-20261016-223752/report.md
- Hardware-Test: passed

## 修改与输入

WebUSB 操作预算不再把正常 DAP 阶段交付给 onLog；15 秒逻辑总预算、阶段记录、超时错误和既有异常恢复日志保留。没有修改 SWD 初始化顺序。

新增 `fill_ram 地址 长度 值` 和 `fill_inc 地址 长度 [起始值]`。长度按字节计算且大于零；值为 0–255；递增填充默认起点 0，255 后回到 0。数字支持十进制、0x 十六进制（也支持 0b/0o）。地址不要求对齐，检查 32 位地址溢出。分块最多 4096 字节，写入后回读核对，支持 Ctrl+C；错误和取消说明已核对数量及已写内容保留。复用 DebugSession 内存接口及页面互斥，不自动更改目标运行状态。已补帮助、补全、异常现场失效及内存窗口刷新。

此次输入还包含上一轮尚未提交的 load_image / dump_image 功能，未覆盖或删除这些改动。新旧功能一起验证并重新生成发布包。未执行 Git 提交或推送。

输入清单及 SHA256 见 input-sha256.json；已跟踪文件相对 Tested-Base 的差异见 worktree.patch。环境：Windows、PowerShell、Node.js v24.13.1、Chrome 155.0.8059.84；页面 localhost:8899，自动化端口 9333。脚本完整路径为 Validation-Cwd 加下列仓库相对路径。

## 实际软件验证

| 命令 | 结果 |
| --- | --- |
| `node tools/selftest/dbg-ram-fill.test.mjs` | 通过：重复/递增、回绕、非对齐、9001 字节跨块、默认起点、邻接字节保持、无效参数写入前拒绝、32 位末地址单字节、短读/数据错误/写失败、取消、DebugSession 状态保持及帮助/补全 |
| `node tools/selftest/web-review-maintenance.test.mjs` | 通过：正常预算阶段无日志、超时仍含命令阶段、真实诊断仍可输出；既有维护回归通过 |
| `node tools/selftest/web-review-fixes.test.mjs` | 通过：失败传递、串口背压、采集状态、SPI 状态、DAP 恢复及短读、I2C、RISC-V 与双错误回归 |
| `make test-dbg` | 通过：核心 326 项通过/0 失败，全部前置套件、镜像命令和新增填充命令通过；原始输出 test-dbg.log |
| `npm run build:web` | 成功：170 模块，发布包 1,327,153 字节 |
| `npm run check:web` | 通过，最终发布包与源码一致 |
| `git diff --check` | 通过，仅有既有 Git 换行转换提示 |
| `$env:IMAGE_OUT='E:/web-serial-rtt-tools/docs/validation/ram-fill-20261016-223752/browser'; node tools/selftest/dbg-image-page.test.mjs` | 源码和发布包入口均通过，见 browser/result.json |

浏览器测试在独立页连接模拟目标，验证 fill_ram 与 fill_inc 的 9001 字节回读、fill_inc 的 Tab 补全、帮助、PC/停止状态/符号保持；上一轮镜像命令的目录按钮、12289 字节文件往返、取消导出、越界拒绝、零长度文件及 1280/1600 布局同时通过。两个入口的页面错误列表均为空。截图存于 browser/。

## F103ZE 实板验证

实际命令：`node docs/validation/ram-fill-20261016-223752/hardware.mjs`。脚本完整路径：E:/web-serial-rtt-tools/docs/validation/ram-fill-20261016-223752/hardware.mjs。原始结果：hardware.json。运行时间：2026-10-16 22:39:45–22:40:08。探针序列号：8F538633E6AEC4CA8ABB6A36FEBB1AC2。目标低 12 位 ID 为 0x414，Flash 512 KiB，SRAM 64 KiB；SWD 1 MHz。

先取得硬件租约、请求其他页面释放探针，确认型号后暂停 CPU；两次读全部 SRAM 确认稳定，并在任何填充写入前保存 original-sram.bin 与 backup.json。记录 20 个核心寄存器选择项和全 Flash 哈希。未复位或烧录 Flash。

实测命令：

```text
fill_ram 0x20008001 12289 0xA5
fill_inc 0x20008001 12289 0xFD
fill_ram 0x2000c003 513 0
fill_ram 0x2000c403 513 255
fill_inc 0x2000c803 513
```

以上全部由真实命令处理器和 DebugSession 执行，再用独立探针读取核对每个字节以及两侧邻接字节，结果通过。12289 字节递增数据另存 increment-readback.bin。

另外执行 `fill_ram 0x20002001 8193 0x7B`，在首块写入后设置取消信号：只写一块 4096 字节，之后及之前的字节保持备份内容，未报告完整成功。使用真实 recoverDebugPort 路径核对正常日志数组为空，确认 SWD 重建未再输出 DAP 阶段明细。

finally 恢复并回读全部 65536 字节 SRAM，20 项寄存器一致，512 KiB Flash SHA256 前后一致：9a919d719de031f9da8a13ed587cdae4977c2927196d4ad76437524a5875f7dd。CPU 从测试前运行状态恢复为运行；探针断开、租约释放。

第一次尝试时自动化浏览器未启动，连接失败，没有接触硬件；原始 not-run 结果保存在 hardware-cdp-unavailable.json。启动现有独立测试 profile 的浏览器后重新运行上述实板脚本通过，未修改用户日常浏览器设置或权限配置。

## 边界与证据

本轮未重新烧录 Flash；日志关闭由实际 SWD 重建及预算单元测试验证。填充范围是否属于当前芯片实际 RAM 由使用者指定，不内置型号地址表。只有 F103ZE 做了实板验证。浏览器测试使用模拟目标，不能替代实板结果。

证据存于 E:/web-serial-rtt-tools/docs/validation/ram-fill-20261016-223752/，重要文件 SHA256 见 evidence-sha256.json；报告哈希见 report.sha256。日志、截图和二进制中部分内容被 Git 忽略，保存在本机持久目录，不会随源码提交自动备份。
