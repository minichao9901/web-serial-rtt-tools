# 全局复位与 SRAM 测速网页验收

验证编号：`20261015-2046-hpm5301-reset-sram`

受测基线：`6ae80bc85f2abf5a32f979aba46408486549a09a`，提交前工作树含本次改动。

配套 akaLinkPro 固件：`3b292e06bae4446cfd740c5ad16e93c3ff491b44`；硬件日志及运行镜像见 `E:/web-etm-trace-coordination/artifacts/hpm5301evklite-reset-sram/20261015-2046-hpm5301-reset-sram/`。

页面顶栏加入 TRST 开漏/推挽选项和全局硬复位按钮。网页从新固件读取能力及当前模式；不支持的固件保持禁用。烧录器页加入 SRAM 测速面板，可选 20、32、64、128 KiB，并按所选 Cortex-M 芯片的 SRAM 区间校验地址。H7B0 默认推荐空闲 AXI SRAM `0x24080000`。测速暂停 CPU，三轮写入和读取后校验数据，并恢复 CPU 原运行状态；选定 RAM 内容会被覆盖且不保存。

离线回归通过：`flash-sram-flow.test.mjs` 验证读写、校验、运行状态恢复、失败收尾和全局复位调用；`reset-io-protocol.test.mjs` 验证 HID `0x3A` 请求、响应和旧固件不支持响应；`sram-bench.test.mjs` 验证界面控件、四档长度、H7B0 分段 RAM 边界、对齐和拒绝 Flash 地址。烧录生命周期、探针仲裁和 28 项固件镜像解析回归也通过。

静态发布包在干净构建工作树（基线 `6ae80bc85f2abf5a32f979aba46408486549a09a`）运行 `npm run build:web` 与 `npm run check:web`，163 个源码模块校验通过。主工作树里原有的未提交 `app/rtt/dap-webusb.js` 修改没有合入本次 bundle；因此主工作树直接运行 `npm run check:web` 会因该文件哈希与旧 bundle 不同而报错。该改动及对应未跟踪测试、ETM review 文档均保留原样。

H7B0 实板通过 akaLinkPro 的 CMSIS-DAP nRESET 和 PyOCD SRAM 写读验收，开漏/推挽模式、四种长度和数据校验均通过，CPU 最后恢复运行。物理验收脚本及速度结果见上述证据目录。另尝试使用新建隔离 Chrome 配置直接点击网页进行 WebUSB 实板 E2E；首次设备选择停留在浏览器授权选择阶段，CDP 没有交付可选设备提示，故未完成这项直接网页授权测试。页面业务流程由模拟探针回归，底层复位和 RAM 访问由 H7B0 实板回归。

验证结果：代码回归及硬件底层验收通过；首次授权后的浏览器页面实板点击流程未覆盖。完整命令输出和设备/构建 SHA256 保存在 `E:/web-etm-trace-coordination/artifacts/hpm5301evklite-reset-sram/20261015-2046-hpm5301-reset-sram/`。
