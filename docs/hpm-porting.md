# HPM 调试与烧录移植接口

## 结构

新增 HPM 芯片或自定义板卡时，集中修改 `app/targets/hpm/porting.js`。

- `HPM_CHIPS`：芯片的 JTAG/hart 配置、RAM 工作区、SBA 访问限制、RTT 默认范围、复位与内存就绪检查。
- `HPM_BOARDS`：板卡选择项、Flash/XPI 地址、ROM 配置 option，以及需要覆盖的板级函数。
- `createHpmTarget(chip, board)`：合并配置、验证地址与函数，返回冻结的 port。
- `resolveHpmTarget(id)`：连接前解析明确选择的板卡；未知 id 报错。
- `reset.halt/haltForRun/run`：复位并停、复位后准备重装断点、复位并运行。
- `hooks.prepareFlash({dm, port, resetFirst})`：烧录前的准备步骤；默认复位并停、重新初始化 DM、选 hart 和停核。
- `hooks.checkMemoryReady(context, address, length)`：访问前只读检查；可以抛出 `MEMORY_NOT_READY`，不得隐式初始化控制器或复位目标。

公共 JTAG/DMI/SBA、触发器、ELF、擦除/编程/校验引擎仍共用。
`app/flash/hpm/chips.js` 保留旧导出作为兼容层，参数表不再重复维护。

## 新增板卡

已支持的芯片可以直接增加一项，页面无需另外增加 HTML option：

```js
createHpmTarget(HPM_CHIPS.hpm5301, {
  id: 'my-hpm5301-board',
  name: '我的 HPM5301 板卡',
  flash: {
    flashBase: 0x80000000,
    flashSize: 0x2000000, // 配置的探测窗口，实际容量由 ROM 回报
    xpiBase: 0xF3000000,
    option0: 0x5,
    option1: 0x1000,
  },
});
```

将此项加入 `HPM_BOARDS` 后，调试器、烧录器与 RTT 的板卡列表自动出现该项。
新芯片先在 `HPM_CHIPS` 增加相应配置，再注册板卡。可以覆盖 `debug`、`memory`、`reset`、`hooks`。
普通板卡直接使用默认函数；特殊启动、外部 RAM 或控制器准备由该板卡/芯片的钩子完成。
所有地址应来自对应 SDK/OpenOCD 配置和实际链接脚本，不能照搬 HPM6880 的 DDR 寄存器。

## Flash 算法的复用与重定位

SDK v1.11 的这些板卡都使用 `hpm_xpi`。官方驱动加载统一的 `flash_algo[]`，
运行时传入 Flash 基址、header、option0/1 和 XPI 地址。ROM API 表地址一致是基础之一，
实际共用数组和参数化调用才是共用算法的直接依据。
参考：[官方驱动](https://github.com/hpmicro/riscv-openocd/blob/riscv-hpmicro/src/flash/nor/hpm_xpi.c)。

默认构建仍使用 HPM6880 头文件，共用源文件和二进制；新增型号不要求重新编译。
修改 SDK 或算法源码时运行：

```powershell
pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
```

`-fpic` 不会自动修正已链接 GOT 表里的绝对数据指针。构建脚本从 ELF `.got`
生成 `HPM_ALGO.relocations`；`hpmAlgoBytes(loadAddr)` 复制原始 blob 并修正这些内部指针。
ROM API 地址和外围寄存器地址不重定位。默认零地址加载的算法字节保持不变。
构建时还会独立链接到 `0x4000`，逐字节比较运行时重定位结果，避免仅靠行为模拟证明兼容。

工作区按算法、XIP 拷贝例程、信息输出、数据中转区、4 KiB 栈分配。
块大小默认 64 KiB，较小工作区自动收缩到能容纳且按字对齐的大小；放不下时在目标访问前报错。
每次执行例程设置对齐的 SP。恢复流程重新写入并校验算法和 XIP 拷贝例程。
`flash_get_info` 回报的真实容量和扇区大小经过校验后，限制后续擦、写、校验范围。

## 选择与内存访问

板卡选择使用共享设置 `target.hpmBoard`，兼容迁移原来的 `rtt.rvChip` 和 `flash.chip`。
已连接会话捕获自己的 port；切换其他页面的板卡不会修改活动会话。
RTT 同步选择时更新原有默认扫描范围，保留手工扫描范围和 ELF 定位地址。
选择的板卡 Flash 窗口自动加入 SBA 读取限制；芯片 port 可以补充其他受限映射窗口。
扫描范围只作为 SDK 链接脚本提示，固件的非缓存区域和 `_SEGGER_RTT` 位置以实际 ELF 为准。

目前只有 HPM6880 的已知 SDK DDR 启动路径包含寄存器级就绪检查，保留原来的 ELF 符号识别条件。
其他芯片使用默认空检查函数，不会误访问 HPM6880 的 SYSCTL/DDRCTL。
如新增板卡需要外部内存就绪检查，应在 port 中补充对应函数。

共享 TAP IDCODE 不能识别具体型号；HPM 型号由用户明确选择。
调试器与 RTT 的“其它 RISC-V”保留通用连接入口，不执行 HPM IDCODE 校验，也不猜测健康检查 RAM 地址；它没有 HPM Flash 算法配置。
JScope 当前仍通过探针固件的 RISC-V 后端采样，网页 port 不改变其 HID 协议或固件实现。

## 无板自测

```powershell
make test-hpm
make test
# 页面服务与独立 CDP 浏览器已启动时：
$env:APP='http://127.0.0.1:8907/index.html'
$env:CDP='http://127.0.0.1:9341'
node tools/selftest/hpm-porting-page.test.mjs
```

新增测试包含 SDK 十块板卡的参数和完整模拟烧录、非零工作区和 hart、XPI1 自定义板卡、
小工作区、容量限制、错误参数、钩子失败、GOT 重定位、DDR 检查隔离，以及真实页面选择与活动会话隔离。
模拟器解释真实 TAP/DMI/SBA 请求；ROM 函数采用行为模型，不执行芯片 ROM。
真实 ROM/XPI 时序、板级复位和启动、外部 RAM 寄存器行为仍需要后续实板验收。
