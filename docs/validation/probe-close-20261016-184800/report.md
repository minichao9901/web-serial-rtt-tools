# 探针关闭按钮验证

Run-ID: probe-close-20261016-184800
Tested-Revision: pre-commit-worktree
Tested-Base: f080a3882bf965227120729a523cd16c833095c5
Tested-Dirty: true
Validation-Result: passed
工作目录：E:/web-serial-rtt-tools

本轮重新运行 node tools/selftest/rtt-cdc-lifecycle.test.mjs、node tools/selftest/scope-lifecycle.test.mjs、node tools/selftest/probe-integration.test.mjs、node tools/selftest/hid-channel.test.mjs 和 npm run check:web，全部通过，原始输出保存在本目录。
脚本绝对路径均为 E:/web-serial-rtt-tools/ 加上述仓库相对路径。

上一轮浏览器模拟页面验收为 67 通过 / 0 失败；本轮未重新运行浏览器，不将旧结果列为新运行。未操作实板。
