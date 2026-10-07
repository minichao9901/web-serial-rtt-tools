# 串口 / RTT 工具箱（网页版）

[![在线打开](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E6%89%93%E5%BC%80-GitHub%20Pages-2f6feb)](https://minichao9901.github.io/web-serial-rtt-tools/)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![Probe](https://img.shields.io/badge/%E6%8E%A2%E9%92%88-akaLinkPro%20%C2%A569-important)](https://github.com/minichao9901/5301evk_akaLinkPro)

> ## 一根 USB 线 + 一个网页 = 整套调试工作台
>
> **不装驱动、不装 IDE、不装 OpenOCD、不装 gdb、不装 J-Link 软件包。**
> 桌面版 Chrome / Edge 打开下面这个网址，插上我们自研的 **akaLinkPro** 探针
> （整机 = 一块 **¥69** 的 HPM5301 开发板 + 一根线），
> 调试、烧录、串口、RTT、变量示波、点屏、摸总线 —— 全在浏览器里干完。

**👉 [马上打开](https://minichao9901.github.io/web-serial-rtt-tools/)** ·
探针硬件与固件：[**akaLinkPro**](https://github.com/minichao9901/5301evk_akaLinkPro) ·
许可 Apache-2.0（两个仓库都是）

**30 秒上手**：① 探针插上电脑（或把固件烧进你手边的 HPM5301EVKLite）→ ② 打开上面那个网址 →
③ 在页面里点一次「连接探针」授权 → **没有第 4 步**。
探针怎么接线看[下面的 40pin 图](#40pin-引脚定义hpm5301evklite--j3)，
浏览器权限怎么配见[这一节](#浏览器权限怎么配edge--chrome串口--hid--webusb)。

## 卖点一览（每一格都是**上板实测**，不是标称值）

| # | 卖点 | 实测数字 |
|---|---|---|
| ① | **1% 的价格，同量级的性能** | 整机 **¥69** 对标 J-Link PRO（¥7000 档）：纯传输**写 3384 / 读 2928 KB/s**（60 MHz 档，OpenOCD 口径） |
| ② | **RTT 轮询下沉进探针**（J-Link 式，主机只读一个串口） | 探针侧 RTT→CDC **2954 KB/s 零丢包** = 主机轮询上限（1140 KB/s）的 **2.6 倍**；本仓库网页端实测 **2.90 MB/s** |
| ③ | **变量示波比 J-Link 快 3.3 倍** | 探针侧 HSS 直读目标 RAM：单变量 u32 **330 kHz**、8 通道 82 kHz（J-Link PRO 的 J-Scope 同口径 100 kHz）；**目标固件一行都不用改** |
| ④ | **RISC-V 目标也照样调**（不是只会 ARM） | JTAG + DMI/SBA 引擎：HPM6800EVK SRAM 读 **1504** / 写 **1512 KB/s** = OpenOCD 主机驱动的 **9 倍**；RTT 1385 KB/s 字节级零丢 |
| ⑤ | **真·零安装**（浏览器直连，不是"免驱"话术） | WebUSB / WebHID / Web Serial 直连探针：**13 个标签页**，授权一次；没有本地程序、没有后台服务、没有插件 |
| ⑥ | **一块板当七种仪器** | CMSIS-DAP 调试器 · 串口 · RTT→CDC 桥 · J-Scope 变量示波 · flash 烧录器 · USB→SPI/QSPI 桥（点屏 / 外接 NOR）· USB→I2C 桥 |
| ⑦ | **全开源、可复现** | 网页纯静态、**零依赖零构建**（`index.html` + `app/*.js`）；每个数字都有验收脚本，`make hw-campaign` 一条命令跑完并**当场判决**（当前 20/20） |

> ①②③④ 的口径、靶子型号与测量脚本在 akaLinkPro 仓库的 `script_test/`（上板实测，可复现）；
> ⑤⑥⑦ 就是**本仓库** —— 逐页功能见下面的「[功能一览](#功能一览11-个标签页)」，
> 每条实测与自测入口见「[实测状态](#实测状态)」。

## 两半合起来，才是完整的故事

### 硬件那半边：**akaLinkPro**（自研探针，Apache-2.0）

一颗 **HPM5301（RISC-V）** 被做成一整套调试基础设施 —— USB-HS 复合设备
（**CMSIS-DAP + CDC + 自定义 HID + WebUSB + DFU**），一根线同时是调试器、串口和七种仪器：

- **两条目标侧通路，同一份固件按需切**：
  **ARM** —— SWD 为主、也支持 JTAG，bit-bang 引擎**按速度预编译**（20/30/36/45/60 MHz 档 + Slow C 版）；
  **RISC-V** —— JTAG-only，探针侧 Debug Module（DMI + SBA）+ 专用扫描汇编。
- **七种仪器的控制面全塞在自定义 HID 里**（协议真源见本仓库 `app/hid/probe.js`、
  `app/spi/protocol.js`、`app/i2c/protocol.js`、`app/scope/protocol.js`）：
  `0x31` RTT→CDC 桥 · `0x32` HSS 采样 + bulk `0x83` · `0x33` RISC-V 引擎 ·
  `0x34` 采样期让路 · `0x35` USB→SPI/QSPI + bulk `0x8B/0x0B` · `0x36` I2C 桥。
- **硬件级的外设相位**：USB→SPI/QSPI自带 cmd / addr / dummy / token 相位与**单 / 双 / 四线**，
  一次 CS 窗口跑完（回环自检 20/40/60/75 MHz 全过）；I2C 桥 100 k / 400 k / 1 M 三档，
  带总线扫描、引脚自检与总线恢复。
- **升级不需要烧录器**：长按 USER 键进 DFU，把 `.bin` 拖进虚拟 U 盘 `AKALINKPRO` 就完事
  （APP 带签名 + 长度 + CRC32 校验，校验不过就停在 DFU）；配置存板载 QSPI NOR，插拔不丢。
- **两块硬件一套源码**：akaLinkPro 原板与 HPM5301EVKLite 移植板，靠 `board.h` 特性宏切换。

### 软件这半边：**本仓库 —— 零安装的网页工作台**

上面那些能力，在浏览器里长成 **13 个标签页**：调试器（源码级断点 + gdb 风格命令行）·
烧录器（页内跑 flashloader）· 串口助手 · 终端 · RTT Viewer（SWD/ARM 与 RISC-V/JTAG 都能看）·
RTT 转发 · J-Scope 波形 · USB→SPI/QSPI · SPI/QSPI 屏（含**局部刷新**）· SPI→USB · USB→I2C · USB→ADC/DAC · 工程生成。
纯静态页面，**没有任何构建步骤**：GitHub Pages 直接托管，也可以下载下来双击打开。

> ⚠️ **发布给 Pages 的话**：那边的 `pages build and deployment` 会用 Jekyll 把**每个 `.md`
> 都送进 Liquid**（有 `jekyll-optional-front-matter`，没有 front matter 也渲染）。所以文档里
> 写 C 代码时别出现 **Liquid 定界符**（两个连续左花括号、或"花括号 + 百分号"）—— 它会被当成
> 变量起始，一句 `= { {cmd, len, …} }`（原文无空格）就足以让**整个部署失败**，而
> `git push` 本身却是成功的（2026-10-03 实测：线上因此停更了三次构建）。
> 兜底：`make check` 里的 `tools/dev/check-liquid.mjs` 会扫出所有没被 Liquid 的 **raw 块**
> 包住的定界符（真要在文档里写这种字符，就用 raw 块把它包起来）。

> 为什么"零安装"这件事不容易：J-Link 与 OpenOCD 都是**本机程序**，浏览器无权启动进程、
> 也无权开 TCP。所以这里的零安装通路是 **WebUSB 直连 CMSIS-DAP 探针**（RTT / J-Scope / 烧录 /
> 调试全走它），想用 J-Link 或 OpenOCD 时再启动那个**可选**的本仓库 `bridge/`。

## 日常验证入口

固件、构建目录和测试脚本曾经随着不同板卡逐步增加，容易把 F103ZE 的旧产物拿给 F103CB。
现在由 [`tools/target-firmware/board-matrix.json`](tools/target-firmware/board-matrix.json) 统一
记录板卡、容量、例程和唯一 ELF 路径；行为约定见
[`tools/target-firmware/CONTRACT.md`](tools/target-firmware/CONTRACT.md)，测试顺序见
[`tools/selftest/README.md`](tools/selftest/README.md)。

```powershell
make check                  # 语法与文档模板
make test-offline           # 全部离线逻辑回归
make rebuild-all-examples   # 清理旧生成目录并重建四块活动板卡
make full_flow_f103cb       # 当前 F103CB：认板 → 基准 → 调试压力 → 随机顺序压力
```

只清固件生成目录用 `make clean-firmware`；`make clean` 还会清理临时采集文件，但会保留
源码、文档、根目录入库的 `fw.elf` 和 bundle。真机日期记录统一从
[`docs/validation/README.md`](docs/validation/README.md) 进入。

## 功能一览（11 个标签页）

| 标签页 | 干什么 | 需要什么 |
|---|---|---|
| **串口助手** | SSCOM 那套核心功能：端口/波特率、ASCII/HEX 收发、**ANSI 彩色接收**（像 MobaXterm）、时间戳、定时发送、5 条快捷发送、保存接收数据、**记录到文件**（高速采集不丢数）、**高速自动关显示**（>50KB/s 停渲染、数据照收） | 桌面版 Chrome / Edge（Web Serial） |
| **终端** | Xshell 式串口终端：xterm.js 渲染 ANSI、本地回显、回车/退格映射、粘贴发送；侧栏还能开 **akaLinkPro 的 RTT→CDC 转发**（探针自己读 RTT 塞进 CDC，主机只读一个 COM 口） | 同上（与串口助手共用同一个串口会话）；转发功能需要 akaLinkPro 探针 |
| **RTT Viewer** | SEGGER RTT 多通道查看 + 下行输入 + 复位目标，四种后端；**目标类型可选 SWD/ARM 或 RISC-V/JTAG**（HPM 等，零安装走 JTAG+DMI+SBA）；同样支持记录到文件与高速自动关显示 | **零安装**：WebUSB + CMSIS-DAP 探针<br>**可选**：本地桥 + OpenOCD / J-Link |
| **RTT 转发** | akaLinkPro 的**探针侧** RTT→CDC：探针自己通过 SWD 轮询目标控制块、把数据塞进它的 CDC 串口；本页开那个 COM 口收数据。**纯输出，没有发送**：ASCII/ANSI/HEX、时间戳、暂停、保存数据、记录到文件、高速自动关显示 | akaLinkPro 探针（配置走它的自定义 HID；接收走它的 CDC 口） |
| **J-Scope 波形** | 类 SEGGER J-Scope 的**变量示波器**：探针自己按固定周期读目标 RAM（HSS，目标固件不用改），数据走 WebUSB 的独立批量端点，网页画多通道波形、带**触发**、导出 CSV、原始包可回放 | **网页侧已可用**：勾「用假探针」或打开 `.jsp` 回放即可体验；真机需要探针固件支持 `HID 0x32`（见 [`docs/scope-page.md`](docs/scope-page.md)） |
| **烧录器** | .elf/.hex/.bin 写进目标：**零安装 WebUSB**（页面跑 flashloader，擦/写/校验/复位一条龙）或**本地桥 OpenOCD** | 零安装：同上探针；桥：OpenOCD |
| **调试器** | 网页里的极简调试器，**不装 OpenOCD、不装 gdb**：暂停 / 继续 / **单步** / 复位、寄存器表（回车即改）、内存 hexdump（点字节即改）、**FPB 硬件断点**、按符号名的 gdb 风格命令行、旁边顺手看 RTT。**载入 .elf 后按源码行下断点**，停下来时源码区跟着 PC 走（DWARF 行号表） | 零安装：同上探针（WebUSB）；无硬件可切「后端 → 模拟目标」；设计与五条硬约束见 [`docs/dbg-page.md`](docs/dbg-page.md) |
| **USB→SPI/QSPI** | 探针当 USB→SPI/QSPI 主站。右列分六个 tab：**命令表**（一行一条 `XFER`）· **寄存器**（按"器件档位"读一段回来——读/写 opcode、地址并入 opcode 还是独立字节、dummy、每寄存器字节数、自增都可配；16 列字节表里每个字节能点开 8 个 bit 改，改完「只写改动 / 整块写回」）· **脚本**（贴 C 表 / 手写帧 DSL，支持 `loop 20ms … end` 定时采集与行尾 `as ax=i16be(0)/16384` 解码，`cmd=0x80\|0x3B` 这种位运算直接写）· **实时值**（`as` 解出来的变量 + 迷你曲线，用于 SPI 接口的 ADC / 传感器连续采集）· **Flash 测试**（外接 NOR：读 ID/SFDP/状态、读测速、擦写校验）· **回环自检**（MOSI↔MISO 跳线）。tab 栏常驻**运行胶囊**与共享「中止」；SCLK、模式、CS 策略、辅助脚与有效电平在左栏配 | akaLinkPro 探针（HID `0x35` 控制面 + bulk 帧流）；接线照上面的 40pin 图；方案见 [`docs/spi-bridge-page.md`](docs/spi-bridge-page.md)、寄存器面板与常见 SPI 器件寄存器约定见 [`docs/spi-register-panel.md`](docs/spi-register-panel.md) |
| **SPI/QSPI 屏** | 把屏点亮那一页。右列分三个 tab：**刷屏**（内置图案 / 拖入图片 → 预览 → 开窗对齐、492 B 切片刷；**局部刷新**——只发与上一帧不同的包围盒，同内容重刷整帧跳过；**动画/视频** MP4/WebM/GIF 逐帧发，发送当节拍器）· **面板初始化**（贴 C 数组 → 解析成步骤表 → 重放；每个字节可直接改、点开看/改它的 8 个 bit）· **读回**（读寄存器 / 读 GRAM 还原成一帧图 + 存 BMP）。tab 栏常驻**运行胶囊**与共享「中止」，日志常驻底部（高度可拖） | 与「USB→SPI/QSPI」页**共用同一次连接** |
| **SPI→USB** | 外部 SPI 主机 → 探针 SPI 从机循环 DMA → 现有 CDC；模式/位顺序、接收统计、清空/暂停/文件记录。F103ZE 18 MHz 真实网页实收约 **2.250 MB/s**，全量字节/序号检查通过 | 与 RTT 共用接收串口，数据源互斥；[使用与验收](docs/spi-cdc.md) |
| **USB→I2C** | 探针当 **USB 转 I2C 主机**。右列分五个 tab：**扫描总线**（0x08..0x77）· **命令表**（读/写/探测/延时，一行一次事务）· **寄存器**（读一段，默认 **128 B = 16×8 表**；每个字节点开就是 8 个 bit 的开关板，改完按「只写改动 / 整块写回」发下去 —— 调器件寄存器不用自己把 `0x55` 拆成 8 位再拼回去）· **脚本**（贴 C 表或写脚本，`loop 100ms … end` 就是 while(1) 定时读/写）· **实时值**（`as` 解码把字节变成有名字的量：g / ℃ / V + 迷你曲线）。**长读自动分片**（`rd 0x50 0x00 256` 直接写，内部拆成 5 笔、日志只出一行），长写也分片（EEPROM 页写可给「写分片 / 片间等待」按页写、等 tWR）；tab 栏常驻**运行胶囊**与「停止」，切到哪个 tab 都知道任务还在跑。内置 **AT24C02 / MPU6050 / ADS1115 / Si5351** 四个模块示例，后两个是传感器，示例里直接做成 while(1) 连续采样 | akaLinkPro 探针（HID `0x36`，**只走 HID** 一条通路）；**仅 HPM5301EVKLite** 固件；方案见 [`docs/i2c-page.md`](docs/i2c-page.md) |
| **工程生成** | 拖进 Keil `.uvprojx` 就能生成调试/下载配套文件：`Makefile.jlink`、`jlink_gdb.script`、`Makefile.pyocd`、`Makefile.openocd`（连带 `rtt_logger.py`）、`test_sram.bin`；右列分三个 tab：**工程文件**（产物实时预览 + 复制/单独下载）· **调试参数**（把左栏填的值逐项列全，长路径看得全、点值即复制）· **本地桥**（安装包 7 个文件的预览 + 一键下载桥包）。**左栏卡片跟着 tab 走**（只显示当组的设置） | 不需要任何硬件/后端（纯前端生成） |


## 40pin 引脚定义（HPM5301EVKLite / J3）

探针对外的线**全部走板上的 J3 40pin 排针**。下图是引脚定义（俯视，1 / 2 脚在 USB 那一端），
标记口径与页面里「USB→SPI/QSPI → 引脚分配图」**完全一致**；接屏、接 flash、接逻辑分析仪都照它看：

![HPM5301EVKLite J3 40pin 引脚定义](docs/shots/40pin-j3.png)

- ★ **桥固定占用**（SPI2 的 SCLK / MISO / MOSI / CS；四线档再加 D2 / D3）—— 换不了；
- ○ **空闲，可当辅助脚**（DC / RST / BL / CS_AUX / TE 在页面上随便挑）；
- △ 能用但要留意（按键脚、板上有 10k 上拉）；⛔ 别用（log 口 / PIOC 域不支持 / 被板载电路按住 / 板载 LED 任务占用）。
- **实测推荐**：RST = `J3[7] PA02`、BL = `J3[11] PA31`（两根都用逻辑分析仪量过，电平干净）；
  **GND 必须接**（6 / 9 / 14 / 20 / 25 / 30 / 34 / 39 任一根），VCC 接 `J3[1]` 或 `J3[17]` 的 3V3。

常接的四种（"哪根能释放、哪根被板载电路占着"的逐脚判断见 [`docs/j3-pin-verdict.md`](docs/j3-pin-verdict.md)）：

| 接什么 | 怎么接 |
|---|---|
| **4 线 SPI + DC**（AXS15352 档 1） | `SCLK=J3[13]` `MOSI=J3[28]` `CS=J3[26]` `DC=J3[24]` `RST=J3[7]` `BL=J3[11]` |
| **QSPI 四线**（ST77916 档 2） | `SCLK=J3[13]` `D0=J3[28]` `D1=J3[27]` `D2=J3[10]` `D3=J3[8]` `CS=J3[26]` `RST=J3[7]` `BL=J3[11]` |
| **外接 SPI NOR flash** | 与屏同一组 SPI2：`CS=J3[26]` `SCLK=J3[13]` `IO0=J3[28]` `IO1=J3[27]`（四线再加 `IO2=J3[10]` `IO3=J3[8]`） |
| **回环自检**（不接屏） | 一根跳线：`J3[28] MOSI` ── `J3[27] MISO` |

> 这张图是**脚本生成**的，不是手画的：改引脚表就重跑 `node tools/dev/make-40pin-figure.mjs`
> （产出 `docs/shots/40pin-j3.png` 与同名 `.html`）。引脚数据与可用性标记的唯一真源是
> `app/spi/protocol.js` 的 `PADS` 表 + 真机实测结论 —— 改了那边记得同步这张图。

## 最近更新（2026-10-04）

| 做了什么 | 在哪 | 真机实测 |
|---|---|---|
| **调试器发布前压力测试**：新写一块"结构足够复杂"的 H743 靶子固件（11 段流水线 / 6 层嵌套 / 递归与互递归 / 函数指针 / 位域·联合体·链表·二维数组），在真机上把断点 / 代码同步 / 单步（in-out-over）/ 复位重跑 / 结构体树全压一遍，**并用 openocd + arm-none-eabi-gdb 做对照** | 靶子：`tools/target-firmware/stm32h743_dbgstress/`（含 DWARF 4 与 DWARF 5 两种构建）；压测：`make test-dbg-stress`；gdb 对照：`tmp/dbg-gdb-oracle.mjs`；设计与七条修法见 [`docs/dbg-page.md`](docs/dbg-page.md) §9 | **81/81 断言全过**（DWARF 5 版 76/76）：`engine_linear` 内连续 17 步落点与 gdb **逐地址一致**、`文件:行` 断点落点一致、复位向量一致、位域排布经 gdb 逐字段核对；连续 60 轮"停—走—停"零比较器泄漏 |
| 压测抓到并修掉的 **7 个真机缺陷** | `app/dbg/{session.js,thumb.js,watch.js,symbols.js}`、`app/elf/lines.js`、`app/rtt/dap-webusb.js` | ① 嵌套结构体里的**位域全读错**（读到根对象头 4 字节）；② `p`/`w` 不认复合路径 `a.b[2].c`；③ `fin` 在**非叶子函数**里原地打转（LR 被内部调用覆盖/陈旧）；④ 断点单步遇分支/返回指令会"跑到随机位置"（新增落点解码，单步 500 ms → **15 ms**）；⑤ 「复位并停」没停在复位向量（改用 `DEMCR.VC_CORERESET`）；⑥ 一次**总线 FAULT 打死整条链路**（只有 `_targetInit()` 能救 → 现在自动自愈）；⑦ 函数最后一条语句要按两次 F10（新增 `tail` 判定，与 gdb 一致） |
| 调试器硬约束补两条 | `docs/dbg-page.md` §8.2 / README 调试器节 | ① 源码级单步要**临时占一个 FPB 比较器**（占满时明确报错、不静默降级）；② **F11 是浏览器全屏、F5 是刷新**（页面拦不住）→ 快捷键只是补充，**不绑 F5**，工具栏按钮与 `n`/`si`/`fin` 才是等价入口 |

## 历史更新（2026-10-03）

| 做了什么 | 在哪 | 真机实测 |
|---|---|---|
| **调试器补齐"手感"**：按 `文件:行` 下断点（`b main.c:192` / `b main:192` / `b +5`）、**源码级单步**（跳过 `n`/F10 · 进入 `si`/F11 · 跳出 `fin`/Shift+F11）、**运行到光标**（源码行双击 / `rc`）、**结构体·数组树形监视**（含位域、字符数组、明说截断）、PC 的**行内偏移**显示（`main.c:192 +0x4`） | `app/dbg/{thumb.js,watch.js,cmd.js,session.js,view.js}`、`app/elf/{lines.js,dwarf.js}`、`app/dbg/mock.js`（假目标补 BL/BX 以便离线跑"进入→跳出"）；设计与约束见 [`docs/dbg-page.md`](docs/dbg-page.md) §8 | 离线全绿：`test-dbg` **307**、`test-dbg-page` **141**（含结构体树展开、快捷键、双击运行到光标）；真机：H743 靶子上源码级单步逐条对齐（见上一条） |

## 历史更新（2026-10-02）

| 做了什么 | 在哪 | 真机实测 |
|---|---|---|
| **SPI/QSPI 屏「局部刷新」**：只发与上一帧不同的那块**差异包围盒**，静止区域一个字节都不发；同内容重刷直接整帧跳过 | 页面「SPI/QSPI 屏 → 刷屏」的「局部刷新」勾选（动画行也有同一个开关），实现见 `app/spi/image.js` | 8×8 的改动线上只发 **128 B / 4 帧**（整帧要 142 KB / 292 帧），且这 128 B 与整帧里该子矩形**逐字节相同**；动画 28.9 → **53.6 fps**（档 1）、23 → **131 fps**（档 2） |
| **调试器真机验收**：暂停 / 单步时「PC ↔ 源码行 ↔ 高亮 ↔ 滚动」四者一致（23/23 断言）；并修掉一个真问题 —— 这块板上 `C_STEP` 不执行，之前**静默当成功**（现象是"点了单步没反应"） | `app/dbg/session.js` 的 `step()`，现在发现 PC 没前进就自动改用**断点单步**并在命令行说明原因 | 连续单步 10 次，PC 与高亮行逐步对齐、行号跟着换；断点命中后 PC 落在该行的地址区间内 |
| **全站布局 review + 修复**：11 个标签页 × 3 档窗口的机器判据体检，修掉 5 处（SPI 桥页 dock 窄窗横向被裁 / 矮窗纵向被裁、屏页推荐值密排文字、监视名字列太窄、生成页长路径框） | `docs/review-2026-10-02.md`（含每条的真因、改法、复测口径与对照图） | 复测 `squash` / `clipped` 全空；`spi-bus-page` 133 · `spi-panel-page` 179 · `gen-page` 57 · `dbg-page` 113 · `ui.page` 19 全绿 |
| 顺手修 3 个既有小 bug | 档 2 动画开窗漏传 profile（与静图不一致）· 两处短等待用 `setTimeout`（页面不可见时被钳到 ≥1 s）· `dbg-page` 测试写死下标（假故障） | — |


## 界面

2026-10-06 已统一字号、标签对齐、连接状态和总线日志，调整 ADC 工作区、SPI 命令表、屏图案和 I2C 地址图。
最新的全部 12 页截图、前后对比及采纳理由见 [UI 评审记录](docs/validation/2026-10-06-ui-review.md)。下方保留历史功能截图。

| 串口助手 | 终端 |
|---|---|
| ![串口助手](docs/shots/1-serial.png) | ![终端](docs/shots/2-terminal.png) |

| RTT Viewer（内置模拟目标） | 工程生成 |
|---|---|
| ![RTT](docs/shots/3-rtt-mock.png) | ![工程生成](docs/shots/4-gen.png) |

| RTT 转发（探针侧 RTT→CDC；截图里是内置假探针 + 演示串口） |
|---|
| ![RTT 转发](docs/shots/5-rttcdc.png) |

| J-Scope 波形（假探针 · 8 通道 · 20 kHz · 带触发标记） |
|---|
| ![J-Scope 波形](docs/shots/6-scope.png) |

| J-Scope 波形（**真机** · akaLinkPro 探针 HSS · 分道显示：正弦/锯齿/方波各一条泳道 · 100.00 kHz · 丢样本 0 · 标尺停在 13.56 ms，A/B 量出一个完整周期 Δt 10.00 ms → 100.00 Hz） |
|---|
| ![J-Scope 真机](docs/shots/13-scope-ab-cursors.png) |

| 调试器（零安装 · 暂停/继续/单步/复位 · 寄存器可直接改 · 内存 hexdump · 硬件断点 · gdb 风格命令行 · RTT 同屏） |
|---|
| ![调试器](docs/shots/14-dbg.png) |

| USB→I2C（假探针 · 右列五个 tab：扫描 / **命令表** / **寄存器** / 脚本 / 实时值 · 命令表在跑 while(1)：MPU6050 每 50 ms 读 14 B 解出 ax/ay/az，ADS1115 每 200 ms 读电压，还有一条 `rd 0x50 0x00 256` 的长读 —— 日志里只出一行「256 B · 分 5 笔」；寄存器 tab 一次读 128 B 成 16×8 表，点字节能逐位改后只写改动） |
|---|
| ![USB→I2C](docs/shots/15-i2c.png) |

| USB→SPI/QSPI（历史截图 · 假探针 · 右列六个 tab：**命令表** / **寄存器** / 脚本 / **实时值** / Flash 测试 / 回环自检；当前命令表默认 3 行，可按需添加，结果列逐行显示读回的字节） |
|---|
| ![USB→SPI/QSPI](docs/shots/16-spi.png) |

| SPI/QSPI 屏（假探针 · 右列三个 tab：**刷屏** / 面板初始化 / 读回 · 刷完一整屏 529 帧 / 253 KB 只用 12 ms；日志与运行胶囊常驻底部） |
|---|
| ![SPI/QSPI 屏](docs/shots/17-panel.png) |

（截图里第一个标签用的是**内置演示串口**，所以显示的是假设备；`?demo=serial` 就能自己试。）

## 实测状态

### UI 回归（2026-10-06）

**903 项通过 / 0 失败**：通用 UI 24、SPI 桥 168、屏 179、I2C 145、调试器 143、工程生成 81、Scope 页面 95、Scope 渲染 14、布局 54。
布局覆盖 1600 和 1280 两种宽度的 12 个页面；`make test-probe test-analog` 也全部通过。详情和完成时间见 [记录](docs/validation/2026-10-06-ui-review.md)。
新增入口 `make test-ui-layout`，会在 `tmp/ui-review/after/` 保存布局判据及 24 张截图。

### 历史快照（2026-10-03）

**页面自测**（大部分不需要硬件；CDP 类先 `make page-prep` 起 8899 服务 + 9333 浏览器）：

| 套件 | 结果 |
|---|---|
| `make test-dbg` 调试器逻辑层（含拿假目标真跑一遍「连接→读寄存器→写内存→下断点→继续→命中→单步→复位」） | **321/321** |
| `make test-dbg-page` 调试器真页面（CDP + 假目标） | **142/142** |
| `make test-spi` / `test-read` / `test-dsl` / `test-flash` SPI 桥与屏的逻辑层 | **90 / 54 / 126 / 66** |
| `make test-spi-regs` SPI 寄存器面板与定时采集（档位→帧、假器件端到端、loop/as 采集、DSL 语法） | **97** |
| `make test-spi-page` USB→SPI/QSPI + 屏 两页真页面（CDP + 假探针） | **167 + 179** |
| `make test-i2c` / `test-i2c-dsl` / `test-i2c-reg` USB→I2C 逻辑层（协议+假器件 / 命令表与脚本 / 寄存器面板与长写分片） | **178 / 265 / 76** |
| `make test-scope` / `test-dwarf` J-Scope 协议 / DWARF 解析 | **127 / 78** |
| `make test-rtt` / `test-hid` RTT 协议 / akaLinkPro HID 协议 | **45 / 55** |
| `make test-gen` / `test-gen-page` 工程生成对账（与 Python 工具逐字节）+ 真页面（含三 tab 与左栏联动） | **55 / 81** |
| `make test-scenery` 屏页风景照片素材（结构 + sha256 对账 + 页面解码器真解一遍） | **15/15** |
| `make test-ui` 整页 UI 步进自测 | **19/19** |
| `make check` 语法/引用体检 + 上面这些的合集入口 | 全绿 |

**真机验收**（板子插在 akaLinkPro 探针上就能跑，带判决、出错立刻停）：

| 目标 | 结果 |
|---|---|
| `make hw-campaign` F103 全场景（烧录 / RTT Viewer / 转发 / 10 s 存盘 / J-Scope / 交替烧录） | **20 通过 / 0 失败** |
| `make hw-campaign-hpm` HPM6800EVK（RISC-V/JTAG，含 RTT Viewer 的 RISC-V 通路） | 见下一节 |
| `make spi-partial-hw` 屏的**局部刷新**逐字节对账（AXS15352 档 1 · ST77916 档 2） | **23 / 23** |
| `make dbg-step-hw` 调试器**停止 / 单步 / 断点**时源码区的显示与同步 | **23/23** |
| `make test-dbg-stress` 调试器**发布前压力测试**（H743 靶子 + gdb 逐地址对照） | **81/81**（DWARF 5 靶子 76/76） |
| `make spi-hw` 真屏刷图（逐档 SCLK，看吞吐与错误计数） | 40 MHz：292 帧 / 0 错 / 32 ms / 4.18 MB/s |

### 历史基线（2026-09-26 · MicroLink CMSIS-DAP + STM32F103）

| 用例集 | 结果 |
|---|---|
| Node 协议层（控制块定位/环形绕回/丢包信号/下行写入/ELF 符号/HEX） | **34/34** |
| 桥端到端（真板，上行 ch0+ch1、下行命令、flood、复位） | **19/19** |
| 浏览器无硬件（演示串口的整条 UI 链路） | **15/15** |
| 浏览器 + 真探针（WebUSB 零安装 RTT：定位/上行/下行/复位） | **11/11** |
| 浏览器 + 桥（OpenOCD 后端：定位/上行/下行） | **5/5** |
| 串口助手真板（DAPLink CDC 桥到 PA9/PA10，`help/info/ansi/hex` 回包） | ✅ |

速度实测（同一探针同一条 SWD）：**WebUSB 单命令往返 0.34 ms、连续读 127 KB/s**；
**OpenOCD Tcl RPC 只有 ~17 KB/s** —— 大流量 RTT 优先用 WebUSB。详见 [`docs/backends.md`](docs/backends.md)。

## 真机场景验收（2026-10：STM32F103ZE + akaLinkPro，一条命令全跑完）

"全流程能不能用"这件事现在有**可重复的自动化验收**了（跑一遍约 2 分钟，带判决，出错立刻停）：

```powershell
make hw-campaign                          # 2 轮全场景 + 狂发↔scope 交替烧录 5 遍
make hw-campaign ARGS="--cycles=1 --alt=1"    # 冒烟
make hw-campaign ARGS="--keep-going"          # 出错也跑完（长稳观察用）
```

它按固定口径跑四步并**当场判决**（脚本头写着完整口径）：

| 步骤 | 判决 |
|---|---|
| ① 烧狂发固件 → 测 RTT Viewer | **> 300 KB/s** |
| 　 同一条链 → 测 RTT 转发（60 MHz 档） | **> 2.5 MB/s** |
| 　 转发 **10 s 存盘**（页面「记录到文件」） | 文件字节 = 同窗口收数（<2%）· 内容可读 · 无积压 |
| ② 烧 scope 固件 → J-Scope 1 变量 / 3 变量（@2 µs 与 @20 µs） | 跑通；50 kHz 档**零丢样本** |
| ③ ①②重复 2 遍　④ 狂发↔scope 交替烧录 5 遍 | 逐次计时 |

**2026-10 基线（判决 20 通过 / 0 失败，原样可复现）**

| 项目 | 实测 |
|---|---|
| 烧录 狂发（ZE 版 1.0 KB）/ scope（3.3 KB） | **0.73 s / 1.04 s**（交替 5 遍：0.7×5、1.0×5） |
| RTT Viewer | **616 / 609 KB/s**（60 MHz 档） |
| RTT 转发 | **2.90 / 2.90 MB/s**（探针侧自报 2.60 / 2.55） |
| 转发 10.2 s 存盘 | **29.4 MB**，逐字节核对误差 0.2%，积压 ~200 KB |
| J-Scope 1 变量 @2 µs | 436~441 kHz（1 span / 4 B） |
| J-Scope 3 变量 @2 µs | 109 kHz（1 span / 10 B） |
| J-Scope @20 µs（50 kHz 档） | 50.00 kHz，**探针丢 0 / USB 丢 0** |

完整数据与读法见 [`docs/真机基准测试.md`](docs/真机基准测试.md)。跑之前要知道的三件事：

F103ZE 的 609～616 KB/s 与 F103CB 当前约 445～465 KB/s 不属于同一板卡条件；容量、RTT 缓冲和排线差异的完整对照见 [`docs/validation/2026-10-05-rtt-viewer-comparison.md`](docs/validation/2026-10-05-rtt-viewer-comparison.md)。

现在三块目标板的例程构建也接入了同一套 full flow：命令会先按对应容量/内存布局编译 RTT、Scope 和调试压力例程，再认板、烧录、跑场景和调试压测。H743 保留 AXI SRAM 配置，HPM6800EVK 保留 RISC-V/JTAG 与非缓存变量配置。

```powershell
make full_flow_f103ze
make full_flow_f103cb
make full_flow_h743
make full_flow_6800evk
```

F103CB、H743 和 HPM6800EVK 的全流程还会按固定随机种子交错执行两轮功能基准与一轮调试压力；
每一步结果单独保存，失败时停止后续场景。F103ZE 保留原有固定顺序流程。

1. **狂发固件要用 ZE 版**：`pwsh -File tools/target-firmware/stm32f103_rtt_speed/build.ps1 -Board ze`
   → `build-ze/fw.elf`（96 MHz + RTT 32 KB 缓冲）。仓库里曾长期躺着一份**旧简化版**
   （没有 PLL 设置、`SYST_RVR=8000`、缓冲 4 KB）—— 用它测转发只有 **0.45 MB/s**，
   会被误判成"探针慢/工具坏了"，其实是目标喂不满。
2. **串口授权只能人工点一次**（Web Serial 的浏览器规定）；之后用
   `node tools/selftest/serial-grant.mjs` 可以把授权搬进测试 profile / 补"当前这个 USB 口"的实例 ID。
3. 跑之前**别让别的浏览器/工具占着探针**（你自己那个浏览器里的 RTT Viewer、J-Scope 数据端点都算）。

## 真机场景验收 · HPM6800EVK（RISC-V/JTAG，2026-10）

同一套口径搬到 RISC-V 板子上 —— **RTT Viewer 现在也有 RISC-V 通路了**（零安装，走
HID 切 SWD+JTAG → WebUSB 的 `DAP_JTAG_Sequence` → RISC-V DMI → SBA 系统总线读内存）：

```powershell
make hw-campaign-hpm                          # 2 轮全场景 + flood↔scope 交替烧录 5 遍（约 5 分钟）
make hw-campaign-hpm ARGS=--record            # 只记录不判决，末尾打印"实测 × 80%"的 spec 建议
make hw-campaign-hpm ARGS="--cycles=1 --alt=1"   # 冒烟
```

| 步骤 | 判决（spec = 首跑实测 × 80%） |
|---|---|
| ① 烧 flood 固件（RTT 在**非缓存 AXI SRAM**） | ≤ 11.3 s |
| 　 RTT Viewer（RISC-V 通路，控制块地址从 ELF 的 `_SEGGER_RTT` 取） | **> 56.5 KB/s** · 零错位读 |
| 　 RTT 转发（探针侧桥 → CDC） | **> 1.10 MB/s** |
| 　 转发 **10 s 存盘** | 文件字节 = 同窗口收数（≥98%）· 内容可读 · 无积压 |
| ② 烧 scope 固件 → J-Scope 1 变量 / 3 变量（采**非缓存** `g_v` 成员） | ≥ 206.6 kHz / ≥ 32.6 kHz |
| 　 @20 µs（50 kHz 档） | **探针丢 0 / USB 丢 0** |
| ③ ①②重复 2 遍　④ 交替烧录 5 遍 | 逐次计时（实测均 8.4 s / 8.4 s） |

**2026-10 基线（实测均值；`make hw-campaign-hpm` 原样可复现）**

| 项目 | 实测 |
|---|---|
| 烧录 flood（45.6 KB）/ scope（45.1 KB，JTAG + 校验） | **9.5 s / 8.5 s**（交替 5 遍各 8.4 s 上下） |
| RTT Viewer（RISC-V/JTAG，SBA 读法） | **70.6 KB/s**（轮询 2.7 Hz，零错位读） |
| RTT 转发 | **1.377 MB/s**（探针侧自报 1.20~1.23） |
| 转发 10.2 s 存盘 | **13.95 MB**，一致性 99.6~99.7%，积压 48~68 KB |
| J-Scope 1 变量 @2 µs | 257~259 kHz（1 span / 4 B） |
| J-Scope 3 变量 @2 µs | 40.8 kHz（1 span / 12 B） |
| J-Scope @20 µs（50 kHz 档） | 1 变量 50.00 kHz · **探针丢 0 / USB 丢 0**（缺口固定 6，是起跑边界） |

跟 F103 那份的差别（也是不能拿 F103 的线来卡 HPM 的原因）：

- **RTT Viewer 慢一个量级**（70 KB/s vs 616 KB/s）：RISC-V 走 SBA，一次读要"每字两次 DMI 扫描"，
  瓶颈是**每条 CMSIS-DAP 命令的 USB 往返**（实测 TCK 1 MHz 与 60 MHz 一样快）。已按"一条命令塞多拍"
  优化（512 个字从 ~1024 条命令降到 69 条，真机 6.3 → 59 KB/s），仍远低于探针固件自己搬的那条路。
- **烧录慢十几倍**（9.5 s vs 0.73 s）：HPM 是 XPI flash + JTAG，页面要跑 ROM API 算法，
  每写一批都过 DMI/SBA；离线校验读回的那 45 KB 现在也走批量读。
- **控制块地址要自己给**：HPM 的结构体在 AXI SRAM（本机固件 `_SEGGER_RTT = 0x01240000`），
  从 `0x20000000` 起自动搜是搜不到的 —— 页面「载入 ELF…」或基准脚本从 ELF 符号表取。
- **必须是非缓存内存**：探针的 SBA 读**不旁路 D-Cache**，放可缓存区会读到陈旧值
  （scope 固件故意放了 `g_v` / `g_v_cached` 两份做对照）。

完整数据、读法与三条踩坑见 [`docs/真机基准测试-hpm.md`](docs/真机基准测试-hpm.md)。

## 现场三大痛点与对策（2026-10 HPM6800EVK 实测后落地）

用户原话：**"web 总是卡住授权，好麻烦" · "web flash 烧录总是卡死，走不下去" · "rtt 转发 + rtt viewer 也挺困难"**。
三条都查到了机制，且**都已经改在代码里**：

### 1）授权弹框（Web Serial / WebHID / WebUSB）

- **为什么烦**：这三类授权**都只能人工点一次**，CDP 也管不了（`DeviceAccess` 不覆盖 Web Serial，
  `Browser.grantPermissions` 没有 `serial` 类型）。授权按「**页面来源 + 设备标识**」记在浏览器 profile 里：
  串口那条记的是**设备实例 ID**（`...MI_01\8&305E904C&6&0001`，**换个 USB 口 `&6&` 就变** →
  "昨天还能用，今天弹框里挑不到设备"）；HID/WebUSB 记的是 vid/pid/serial（换口仍认）。
- **对策（一条命令，补的就是你平时开网页的那个 profile）**：
  ```powershell
  make grant                     # 补：串口 + WebHID + WebUSB，一次写进下面这些 profile × 来源
  make grant ARGS=--show         # 看：每个 profile/来源下有哪些授权、当前 USB 口在不在里面
  make grant ARGS=--clean        # 清：删掉换口/换探针留下的过期条目
  ```
  等价的直接调用：`node tools/selftest/serial-grant.mjs [--if-idle] [--origin=…] [--profile=…]`。
  默认改**两个** profile，因为它们是两个不同的浏览器实例：
    · `%TEMP%\edge-rtt-tools-test` —— **`make open` / `make page-prep` 起的那个窗口**（平时看的）；
    · `%TEMP%\chrome-rtt-authorized` —— 自动化基准脚本（`hw-campaign*.mjs`）用的。
  来源默认覆盖 **线上 Pages + `http://127.0.0.1:8899` + `http://localhost:8899`**（来源不同授权不通用）。
  它从你自己 Chrome 的 profile 里**抄**探针的 HID/WebUSB 条目、再补上当前 CDC 口实例 ID；
  **不碰**你日常的 Chrome profile（要动得显式 `--profile=user --force`，且浏览器必须全退）。
  `make open` / `make page-prep` 每次都会先跑一次 `--if-idle`（**只在浏览器没跑时改**，跑着就跳过并提示），
  所以正常情况下你**再也不会看到授权框**。换 USB 口或换探针之后重跑 `make grant` 即可。
- **"弹框里一个设备都没有"**的三种真实原因：① 探针被另一个页签/另一个程序占着（关掉那个页签，
  或 `node tmp/usb-holders.mjs` 看谁占着）；② 探针在 DFU 模式（没回到 CMSIS-DAP）；③ 换了 USB 口而授权记录还指着旧口（`make grant ARGS=--clean` 后再 `make grant`）。
- **权限被浏览器/系统策略锁死**（症状：站点面板里「串行端口」写着"不允许(默认)"且点不动）：
  这是**组策略**干的，跟上面的设备授权无关 —— 见下一节「浏览器权限怎么配」的 ① 层。

### 2）网页烧录卡死

- **机制**：上一次会话（或一次失败的读）会在目标系统总线上留下**永不完成的事务**，此后 `sbcs` 的
  `sbbusy`/`sbbusyerror` 常驻，**任何 SBA 访问都失败** —— 现象就是烧录报 `SBA 写 0x0 出错`，
  重试多少次都过不去（实测只有整板断电或 ndmreset 能解；`dm.init()` 那套清不掉）。
  另一类卡死是"擦除后等目标 halt 超时"（偶发，重试即过）。
- **对策（已内置）**：烧录页在**动手之前**先跑一次 `dm.sbaHealthCheck()`
  （`app/flash/hpm/riscv-dm.js`），分级自愈：**清错误位 → DM 复位 → ndmreset**，
  自愈成功才继续；三级都救不回来才报错并提示断电重上电。
  日志里会写 `SBA 健康检查：干净` 或 `⚠ SBA 之前是脏的 → 已自愈：…`。
- **另一类卡死是"CPU 楔在永不完成的 XPI 事务上"**（HPM6800EVK 上必现，回读校验/首次 erase 都会踩）——
  这是靠 **LA 解码 OpenOCD 的烧录波形**定出来的，完整过程、三处修复与**通用排查流程**
  见下面「网页烧录稳定性定因全过程」一节。

### 3）RTT 转发 / RTT Viewer 连不上、时好时坏

- **机制（2026-10 定因）**：
  ① RTT 上行环**开得太大**（HPM SDK 默认 `BUFFER_SIZE_UP = 8 MB`）：固件只写不读时，
     主机晚连几分钟就攒下几 MB；慢链路（RISC-V/SBA ~30 KB/s）要排好几分钟，
     而 SBA **一次读几 MB 会直接失败**（实测 1 MB 报 `DMI 写 0x39 失败`）。
  ② 探针的 RISC-V/SBA 读会**偶发返回全 0 / 挂起**，一次就把"控制块好好的目标"判成
     「没有 SEGGER RTT 标识」→ 界面表现就是"一会儿好一会儿坏"。
- **对策（已改在代码里）**：
  · `app/rtt/protocol.js`：`readUp` **分块读**（`MAX_READ_PER_POLL = 64 KB`，大积压慢慢排而不是一次读崩）、
    通道缓冲上限 1 MB → 32 MB（8 MB 环是合法配置，不再被拒）、
    `validate()`/`_entry()` **读到全 0/校验不过时重试 3 次并顺手让链路自愈**（`mem.recover()`）。
  · 固件侧：**环的大小别动**（保持 SDK 默认）。我们试过把上行环缩到 256 KB，结果冷启动那一波
    插桩 trace 当场把环灌满 —— 通道是 `BLOCK_IF_FIFO_FULL`，固件就**阻塞在 `SEGGER_RTT_Write`
    里出不来了**（现象是"板子 ping 不通、像坏了"，只有调试器连上把积压排空才会继续）。
    要减小积压请在**主机侧**做（上面那两条就是），别缩目标的环。
    另外**控制块地址不用动**：HPM 的 `.noncacheable` 段本来就落在真非缓存区
    （`board_init_pmp()` 用 PMA 配的 `MEM_TYPE_MEM_NON_CACHE_BUF`），改地址不解决任何问题。
- **算法"跑不回来"也不再卡死**（2026-10 用户现场）：HPM 烧录时算法末尾那条 `ebreak` 偶发不回来
  （`waitHalted` 超时），旧代码直接抛错走人、**核被扔在跑飞状态**（板子随即 ping 不通）。
  现在 `HpmFlasher.call()` 会**就地自愈**（强行 halt → 复位 DM → 重装算法镜像并读回校验）后再跑一次；
  两次都不过才报错，且失败收尾会 `halt + resetRun` 把目标放回可用状态，提示"直接再点一次烧录通常就过"。
- **验收（本轮真机）**：新固件 + 上述修复后，**全程零手动复位**：
  Viewer 空闲 43.3 KB/s（8.4 Hz，零错位读）· Viewer **打流中** 12.8 KB/s（之前是连不上）；
  转发打流中 **1.387 MB/s**（探针侧 1.479，与仓库基线 1.377 一致）；10 s 存盘 13.16 MB、一致性 99.5%。

## 网页烧录稳定性定因全过程（拿 LA 抓 OpenOCD 当"标准答案"）

> 背景：HPM6800EVK 上网页烧录"动不动就在校验阶段卡死 60 s ×2 → 整轮失败"，一度被当成偶发时序问题。
> 最后靠**逻辑分析仪把 OpenOCD 的完整烧录过程录下来解码**，与我们的 DMI 流水逐条对比，
> **一次性定位到唯一差异**；三处修复后整轮稳过。
> 下面既是结论，也是**这套排查的通用流程**（换个目标芯片同样适用）。
> 完整的原始记录见 [`docs/交接-HPM6800EVK-RTT与烧录.md`](docs/交接-HPM6800EVK-RTT与烧录.md) 第 7 节。

### 第 1 步：把"偶发"变成"确定性"（不然没法查）

翻 4 份历史日志 + 现场复现 5 次，模式 **100% 一致**：

- **`read`（回读校验）在 flash 偏移 ≥ `0x30000` 且长度 ≥ 32768 时必卡**；同址 4096/8192/16384 正常，
  `0x0/0x10000/0x20000` 各 64 KB 也正常 → 坏区间收窄到 **(0x34000, 0x38000]**。
  真机表现 = "校验走到 81%（第 4 块）卡死 60 s×2 → 整轮失败"。
- **第一次 `erase` 也必卡满 60 s**（靠重试自愈才过）。

卡死瞬间的现场（四件套取证）：

| 观测 | 值 | 说明 |
|---|---|---|
| `dmstatus` | 恒报 **running** | 核没停 |
| 写 `haltreq` | **停不住核** | 不是"我们没请求停" |
| 抽象命令 `cmderr` | **4**（halt/resume 失败） | 调试模块也进不去 |
| SBA 读 ILM | **48/48 字节仍是我们装载的算法** | 排除"应用把算法覆盖了" |
| `dtmcs.dmistat` | **0** | 排除"DTM 进错误态" |

⇒ 结论：**核楔在一条永不完成的 XPI 总线事务上**，只有 `ndmreset` / 整板断电可解。

### 第 2 步：先判"哪条读路径可行"

| 路径 | 结果 |
|---|---|
| SBA 直读 XPI 窗口 `0x80000000` | ❌ 自己就挂（`readMem(0x80000000,16)` 超时） |
| **CPU 走 XIP 窗口** `lw`（progbuf 里执行） | ✅ `0x80000000/0x30000/0x34000/0x36000/0x38000/0x3E000` 全部 ~6 ms 秒回真实内容 |

这条判据一出来，方向就有了：**能读，只是不能用"那条"读**。

### 第 3 步：用 LA 抓 OpenOCD 的完整烧录过程

接法：LA `CH0..3 = TCK / TMS / TDI / TDO`，**500 MS/s**。

- **为什么必须这么高的采样率**：这支探针的 JTAG 引擎是**固定时序的 ASM blob**，
  `adapter speed` 基本被忽略（实测 4 KB 写 100 kHz 与 8 MHz 都是 ~0.14 s）——
  想解码只能靠高采样率硬啃。
- **窗口怎么对齐**：LA 只支持自由采集 + 简单边沿触发，所以用"**让被观测方等一个 GO 文件**"握手
  （页面侧 `opts.waitGo` 等 `tmp/LA-GO`），这样一次采集正好罩住一次完整烧录。
- **怎么解**：KingstVIS 自带 JTAG 解码模块导出 → 本仓脚本解成 DMI 流水账
  （实测覆盖 2 次完整烧录、**220133 次扫描**）。

### 第 4 步：两条流水逐条对齐 —— 差异只有**一条**

| | OpenOCD | 我们（改前） |
|---|---|---|
| `sbcs` / `sbaddress0` / `sbdata0` 写入 | **0 次**（完全不用 SBA） | 全程 SBA |
| 抽象内存访问（`cmdtype=mem`） | 0 次 | 0 次 |
| 读目标内存 | progbuf 跑 `lw s1,0(s1)`（CPU 自己走 XIP 窗口） | SBA |
| 写目标内存 | progbuf 跑 `sw s1,0(s0); addi s0,s0,4` + `abstractauto` | SBA |
| 擦 / 写 flash | 算法 `init/erase/program`，参数与我们**一模一样** | 相同 |
| fence 段 | `fence.i; fence rw,rw(+ebreak)`（progbuf） | **逐字相同** |
| **回读校验** | **根本不读**：算法 `read`（`dpc=0x12`）调用次数 = **0** | 调 `read` → ROM `flash_read` → **楔死** |

同时排除掉两个"看起来很像"的假说：`nor_config` 解出来完全正常
（size 16384 KB / page 256 / sector 4 KB / block 64 KB，不是"erase 除零"），
算法 blob 与 SDK `samples/openocd_algo` 源文件**逐字节相同**（差异不在算法，在"怎么驱动"）。

> **⇒ 差异就是：我们多做了一步"用 ROM 的 `flash_read` 回读校验"，而这一步在这颗芯片上会楔死总线。**
> OpenOCD 要么不校验，要么就用 **CPU 走 XIP 窗口**读，**从来不碰 ROM 的 read**。

### 第 5 步：三处修复

| # | 问题 | 修法 | 提交 |
|---|---|---|---|
| 1 | 校验用 ROM `flash_read` → 楔死总线 | 新增 `app/flash/hpm/xip-copy.js`：**手工汇编**的 7 条指令拷贝例程（`lw/sw/addi×3/bne/ebreak`，28 B）装到 SRAM `0x600`，`verify()` 改用 `copyFromXip()` 从 XIP 窗口搬回来比 —— **完全不碰 ROM read** | `d353b4c` |
| 2 | 应用已配过 XPI 时，第一次 `erase` 必卡 | `riscv-dm.js` 新增 `resetHalt()`；`setup()` 先 reset-halt 再跑算法（`resetFirst:false` 可关） | `8ecba48` |
| 3 | 途中偶发 `DMI 写 0x39 失败（op=3）` 导致"烧到一半中止" | 识别 `op=3` = DTM 进 DMI 错误态 → 写 `dtmcs.dmireset` 后重试 | `6b7420a` |

第 2 条的真机 A/B（同参数 erase 8192 B）特别有说服力：

| 前置动作 | 结果 |
|---|---|
| 直接 `setup()` → `erase` | **卡 > 60 s** |
| 先 reset-**run**（复位后应用立刻重启并重配 XPI）→ `setup()` → `erase` | **仍然卡** |
| 先 reset-**halt**（`ndmreset` + 保持 `haltreq`，核停在复位向量）→ `setup()` → `erase` | **118 ms 通过** ✅ |

根因：目标上跑着 `flash_sdram_xip` 应用时**它已经把 XPI 配过一遍**，在这种状态上再跑
`flash_init`（ROM 的 auto_config 重配一次），第一次写类操作就会楔死；reset-halt 让 XPI 从 POR 态由我们重配。

**真机端到端（demo.elf 246360 B，三处修复一起）**：

| 段 | 擦除 | 编程 | 校验 |
|---|---|---|---|
| `0x80000400`（3216 B） | **122 ms**（原 63,336 ms） | 48 ms | 53 ms |
| `0x80003000`（243144 B） | 1857 ms | 2675 ms | **3096 ms**（改前必卡 60 s×2） |

**整轮 8.2 s** ✓（OpenOCD 基线约 4.9 s；改前要么整轮失败、要么侥幸 71 s）。
现在的日常基线见上节「真机场景验收 · HPM6800EVK」表。

### 第 6 步：把结论钉进自测（否则下次还会踩）

- `tools/selftest/hpm-sim.mjs`：认这 7 条拷贝例程；按实测阈值**建模"ROM read 会楔死总线"**；
  建模"松开 `ndmreset` 时核是跑还是停，取决于 `haltreq` 有没有保持"（**这条语义不建模，修复就测不出来**）；
  支持注入 DMI 错误态（`op=3`）。
- `tools/selftest/hpm-flash.test.mjs`：§4b 反解 7 条机器码 + `0x30000` 起校验 64 KB 通过且
  **ROM read 调用 0 次** + **反证**（真去调 `read` 读同一形状 → 模拟目标当场楔死）；
  §4c 钉住 `op=3 → 写 dmireset 自愈`。`make test-hpm` 全过。

### 通用流程（换个目标芯片照做）

1. **先量化**：把"偶发"做成复现矩阵（地址 × 长度），拿到**确定性**的失败条件；
2. **取证四件套**：`dmstatus` / `haltreq` 是否有效 / `cmderr` / 内存内容是否被改 → 区分
   "核跑了""调不动""算法被覆盖""DTM 错误态"；
3. **判读路径**：SBA 直读 vs CPU(progbuf) 走窗口，二选一先跑通一条；
4. **抓标准答案**：LA 上 `TCK/TMS/TDI/TDO`（采样率 ≥500 MS/s），抓**能成功的那个工具**（OpenOCD/pyOCD）的
   完整流程，用 GO 文件对齐窗口；
5. **逐条对齐**：把两边都解成 DMI 流水账（谁读写哪个寄存器、什么顺序、什么参数），
   差异往往**只有一条**；
6. **改 + A/B 验证 + 钉进自测**：修复必须配"能失败的对照实验"，再把语义写进模拟目标。

### 三个坑（这一轮踩到的）

- LA 只支持**自由采集 + 边沿触发**，窗口对齐得靠外部握手（GO 文件），别指望"触发在某个 DMI 扫描上"；
- 探针 JTAG 是**固定时序**的，`adapter speed` 别当真 —— 采样率不够就解不出来；
- **页面混版会让你"看着日志对、跑的却是旧代码"**：ES 模块按 URL 缓存，改了模块不重载页面就会新旧混跑
  （当时 `resetHalt` 被静默跳过、日志却打印成功）。已加**构建标记 + 陈旧页面自检**（`app/core/build.js`，
  不一致时顶栏报警），排查硬件问题时**先看这一条**。

## 浏览器权限怎么配（Edge / Chrome：串口 / HID / WebUSB）

> 页面里 `navigator.serial` / `navigator.hid` / `navigator.usb` 能不能用，由**四层**设置共同决定。
> 任何一层说"不"，页面上就是"点了没反应"。最典型的症状：站点面板里「**串行端口**」显示
> **不允许(默认)** 而且**整行点不动** —— 那是被最上面的**策略层**锁住了（2026-10 用户现场实测）。
> 两家浏览器是同一套 Chromium 机制，**只有 scheme 和注册表根不同**，下面统一说明。

| 层级 | 管什么 | 在哪改 | 界面能改吗 |
|---|---|---|---|
| ① **组策略** | 全局总闸，优先级最高 | 注册表 `…\Policies\Microsoft\Edge` / `…\Policies\Google\Chrome` | ❌ 只能看：`edge://policy` / `chrome://policy` |
| ② **浏览器默认值** | 对所有网站的默认行为 | `edge://settings/content/serialPorts` 等（见下） | ✅ |
| ③ **单站点例外** | 只针对某一个来源 | 地址栏左侧图标 → 串行端口 / HID 设备 / USB 设备 | ✅（被 ① 锁住时整行变灰） |
| ④ **设备授权** | 这个来源可以用**这一支**探针 | 弹框人工选一次；批量写 profile 用 `make grant`（见上一节） | 半自动 |

### ① 组策略（"点不动"的病根就在这层）

**症状**：站点面板里那一行是灰的、写着「不允许(默认)」；浏览器里可能还显示「**由你的组织管理**」。

**先看**（界面里唯一能看策略的地方，页面上有「重新加载政策」按钮）：
```
edge://policy        （Chrome 用 chrome://policy）
```
搜 `Serial` / `Usb` / `Hid`，能看到策略名、当前生效值和来源。

**关键策略名与取值**（`2` = 禁止，`3` = 允许网站询问）：

| 策略 | 作用 | 正常值 |
|---|---|---|
| `DefaultSerialGuardSetting` | 网站能否请求**串行端口** | **3**（设成 2 = 全场禁止，就是上面那个病） |
| `DefaultWebHidGuardSetting` | 网站能否请求 **HID 设备** | 3 |
| `DefaultWebUsbGuardSetting` | 网站能否请求 **USB 设备** | 3 |

**改**（改完必须**完全退出浏览器**再打开，策略只在启动时读）：
```powershell
# 恢复正常值（允许网站询问）——Edge 与 Chrome 各一条
reg add "HKCU\SOFTWARE\Policies\Microsoft\Edge"   /v DefaultSerialGuardSetting /t REG_DWORD /d 3 /f
reg add "HKCU\SOFTWARE\Policies\Google\Chrome"    /v DefaultSerialGuardSetting /t REG_DWORD /d 3 /f
# 顺带把 HID / USB 也确认一遍（可选）
reg add "HKCU\SOFTWARE\Policies\Microsoft\Edge"   /v DefaultWebHidGuardSetting /t REG_DWORD /d 3 /f
reg add "HKCU\SOFTWARE\Policies\Microsoft\Edge"   /v DefaultWebUsbGuardSetting /t REG_DWORD /d 3 /f
# 查看当前值
reg query "HKCU\SOFTWARE\Policies\Microsoft\Edge" /v DefaultSerialGuardSetting
```

**顺带：免弹框放行某支设备**（做自动化很有用 —— 指定来源 + VID/PID 直接放行，连选择框都不弹）：

| 策略 | 例子（给本地页放行 akaLinkPro，0x0D28/0x0202） |
|---|---|
| `SerialAllowUsbDevicesForUrls` | `[{"devices":[{"vendor_id":3608,"product_id":514}],"urls":["http://127.0.0.1:8899"]}]` |
| `WebUsbAllowDevicesForUrls` | 同上 |
| `WebHidAllowDevicesForUrls` | 同上（HID 只认 VID/PID） |
| `SerialAllowAllPortsForUrls` | `["http://127.0.0.1:8899"]`（该来源放行**所有**串口） |

> ⚠️ 这些都是 **HKCU 策略**，会让浏览器显示「由你的组织管理」。自己机器上自测无所谓；
> 不想要这个提示就把对应值 `reg delete` 掉（删除 = 回落到浏览器默认，也就是"询问"）。

### ② 浏览器默认值（界面上就能改）

| 权限 | Edge | Chrome |
|---|---|---|
| 串行端口 | `edge://settings/content/serialPorts` | `chrome://settings/content/serialPorts` |
| HID 设备 | `edge://settings/content/hidDevices` | `chrome://settings/content/hidDevices` |
| USB 设备 | `edge://settings/content/usbDevices` | `chrome://settings/content/usbDevices` |

（菜单点法：设置 → **Cookie 和网站权限** → 往下找对应项。）串口那页选「**站点要访问串行端口时询问**」= 正常值；下面还能手动把某些网站拉进「不允许」列表。

### ③ 单站点例外（日常最常用）

地址栏**左侧图标** → 点「串行端口 / HID 设备 / USB 设备」→ 选「询问 / 允许 / 不允许」，
下方能看到**已授权的设备清单**并可逐条「**撤消访问权限**」。
> 被 ① 的策略锁住时，这一行是灰的 —— 先去 ① 解锁。

### ④ 设备授权（跟"权限"不是一回事）

权限开着，但**换了个 USB 插口**，串口那条授权就失效了（它记的是设备实例 ID，`&N&` 那段会变）——
现象是"弹框里挑不到设备"。补的办法就是上一节的：

```powershell
make grant                                   # 补串口 + WebHID + WebUSB（默认只改临时测试 profile）
node tools/selftest/serial-grant.mjs --profile="$env:LOCALAPPDATA\Microsoft\Edge\User Data"   # 补你自己的 Edge
node tools/selftest/serial-grant.mjs --profile="$env:LOCALAPPDATA\Google\Chrome\User Data" --force   # 补你自己的 Chrome
```
（**写之前必须退出对应浏览器**，否则 profile 会被浏览器覆盖回去。）

### 附：不想让探针插拔时弹系统通知

Chromium 系浏览器（Chrome / Edge / 钉钉内置浏览器等）会在探针插上时弹「检测到 akaLinkPro CMSIS-DAP，
请前往 … 进行连接」——它来自 `WebUsbDeviceDetection` 这个功能（依据探针固件里的 **WebUSB 落地页描述符**）。
只关这一条、不动其它通知：

```powershell
# 给启动该浏览器的快捷方式 / 开机自启项加上开关（完全退出浏览器后重启才生效）
--disable-features=WebUsbDeviceDetection
```
反过来，如果希望"没打开浏览器也能收到提醒"，保留一个**后台常驻**的浏览器即可
（Edge 默认开机自启：`msedge.exe --no-startup-window --win-session-start`）。

## 快速开始

1. 打开页面（Pages 地址或本机的 `http://127.0.0.1:17321/`）。
2. **串口**：点「选择…」在浏览器弹框里选一次 COM 口（浏览器规定必须手动选一次），然后「连接」。
3. **RTT（零安装）**：RTT Viewer → 后端选 `WebUSB · CMSIS-DAP` → 「连接探针」→ 它会自动扫描 RAM 找到 `SEGGER RTT` 控制块（换芯片先在「RTT 控制块 → 芯片」选系列，RAM 范围自动带出；也可以先「载入 ELF…」用符号直接定位，更快）。
4. **RTT（J-Link / OpenOCD）**：双击 `bridge/start-bridge.bat`，页面里后端选「本地桥 · OpenOCD」→ 选目标芯片（常用 STM32 系列已内置；其它芯片选「自定义 cfg…」填 cfg 文件）→ 连接。
   桥要 Node 18+（零 npm 依赖）；**退出请用 Ctrl+C**（或先关网页）—— 桥会把 OpenOCD / J-Link 子进程一起收掉，
   不会留下孤儿占着探针（这正是"下次连不上"最常见的根因）。
   手边没有仓库也没关系：**「工程生成」页最下面「本地桥」那一栏能一键下载整个桥包**（含启动器 / 便携 Node 兜底 / 环境预检）。

串口和 RTT 可以**同时**用（一个走 USB CDC、一个走探针）。

## 工程生成（.uvprojx → 调试配套文件）

标签栏的**最后一个**（用户 2026-09-30 调的顺序；它跟硬件无关，放在最边上不挡日常那几个）。
把 Keil 工程文件拖进去（`<Device>` / `<Cpu>` 里的 Flash、RAM 会被读出来自动填），
勾一勾、改几个参数，就能拿到 5 类配套文件：模板是**逐字节移植**自 `uvprojx2cmake.py`（另一个 Python 工具）的，
页面再**固定套 4 项修正**（见下），所以默认产物 = Python 产物 + 这 4 处修补；
把修正整个关掉（代码里传 `fixes: null`，对账自测走的就是这条路）即与 Python 工具**逐字节一致**。

| 勾选 | 产物 | 用途 |
|---|---|---|
| J-Link Makefile | `Makefile.jlink` | `make -f Makefile.jlink jlink-prog / jlink-rtt / jlink-gdb / jlink-debug` |
| GDB 脚本 | `jlink_gdb.script` | 连 `JLinkGDBServerCL` 的 3333 端口、`load`、`break main`；OpenOCD/PyOCD 的 Makefile 也复用它 |
| PyOCD Makefile | `Makefile.pyocd` | `pyocd erase/flash/gdbserver/rtt` |
| OpenOCD Makefile | `Makefile.openocd` **+ `rtt_logger.py`** | 擦/烧/校验、`openocd-rtt`（RTT server + 那份 socket 日志脚本）、`openocd-sram` |
| SRAM test bin | `test_sram.bin` | 20KB 的 `0x00 01 02 … FF` 递增图案，给 `openocd-sram` 灌进 RAM 再回读比对（**不是可执行代码**） |

文件怎么落地：

- **Edge / Chrome**：「写入文件夹…」选一次目录，多个文件**直接写进去**（不打包、不解压；同名文件会先问你，和 Python 工具"存在就不覆盖"一个意思）；
- **其它浏览器**：自动退化成「打包 ZIP」落「下载」文件夹；
- 预览区还能单独下载 / 复制当前那个文件。

网页**不能**静默写你的项目目录 —— 必须你亲手选一次文件夹（浏览器安全模型）。

### 顺带生成「本地桥」安装包（J-Link / OpenOCD 那条路）

同一页最下面「本地桥」那一栏：勾上（默认开）就多出 7 个文件，打包成 `rtt-bridge-kit/` 一层；
点「下载桥包（ZIP）」可以**只**下这一包（~77 KB）。解压后**双击 `start-bridge.bat`** 就是一条龙：

```
rtt-bridge-kit/
  start-bridge.bat    找 Node（没有就下便携版）→ 环境预检 → 起桥 → 打印网页地址
  check-tools.bat     只跑预检：端口 / OpenOCD / scripts / J-Link 逐个查，并告诉你该改哪一行
  get-node.ps1        start-bridge.bat 的便携 Node 下载器（国内镜像优先 + sha256 校验）
  start-bridge.sh     macOS / Linux 版
  rtt-bridge.mjs      桥本体（与仓库里那份**逐字节一致**，sha256 印在 README 里）
  bridge.config.json  你在页面上填的参数（目标 / 工具路径 / J-Link 默认值）
  README-bridge.txt   三步上手 + 换机器改哪三行 + 常见问题
```

- **不依赖仓库**：桥自己会托管网页，所以用线上页面 `https://minichao9901.github.io/web-serial-rtt-tools/`
  也行（那个 Origin 本来就在桥的白名单里）；
- **不写死路径**：`bridge.config.json` 里 `openocd` / `scripts` / `jlink.*` **留空 = 桥自己探测**
  （ESP-IDF 的 `openocd-esp32` → `Program Files\OpenOCD` → PATH；J-Link 找 SEGGER 目录里版本号最大的）；
  找不到时预检会把"找过哪些路径"列出来；
- **没装 Node 也不怕**：bat 检测到没有就下便携版（~30 MB，绿色，放到包里的 `node\`，不动系统 PATH），
  国内走 npmmirror、官方兜底，下载后按 `SHASUMS256.txt` 校验 sha256；企业内网可关掉这个开关；
- 退出请用 **Ctrl+C**（桥会把 OpenOCD / J-Link 子进程一起收掉，不留孤儿占探针）。

改过 `bridge/rtt-bridge.mjs` 就要 `make gen-embed` 重嵌一次（否则页面发出去的桥是旧的）——
忘了也不要紧，`make test-gen` 里那条哈希对账会红。

**固定套用的 4 项修正**（2026-09-27 逐条过审；改的是 Python 模板里用起来硌人的地方）：

| # | 修正 | 原来会怎样 |
|---|---|---|
| 1 | `Makefile.jlink` 的 `RTT_SIZE` `0x5000 → 0x2000` | 在 20KB RAM 的 F103 上 `0x20002000+0x5000` 越过 RAM 顶 |
| 2 | `clean-jlink` 不再删 `*.log` | 会把 J-Link 自己写的 `JLinkLog.txt` 一起删掉 |
| 3 | `openocd-rtt` 改用双引号 `-c "…"`（内层 `\"SEGGER RTT\"`） | 原来 `-c '…'` 在 cmd.exe 里单引号不是引号 → 直接报错 |
| 4 | 去掉 `jlink-swo` 目标 | 硬编码 72MHz 只对 F103 成立，且固件没开 PB3/TRACESWO，跑出来是空日志 |

修正都是**逐行定点替换**，匹配不到就抛错（绝不静默产出半成品）；你自己在页面上填过的值优先，
例如 RTT 范围填了 `0x1000` 就不会被改回 `0x2000`。

三点与 Python 工具**故意不同**（更顺手，也更忠实于工程文件本身）：

1. **项目名**：Python 工具取 `.uvprojx` 所在**目录名**；网页在拖入文件夹/相对路径时同样取目录名，否则退回 `<TargetName>`（再不然用文件名），反正这个框可以手改。
2. **换行符**：默认 **CRLF**（与 Python 产物逐字节一致）；想给 git 用切成 LF 即可，除换行外内容完全相同。

细节与对账方法见 [`docs/gen-page.md`](docs/gen-page.md)。

## RTT → CDC 转发（akaLinkPro 探针侧桥）

独立一页（**RTT 转发**，排在 RTT Viewer 后面）：让**探针自己**通过 SWD 轮询目标的 RTT 控制块、
把数据塞进它的 CDC 虚拟串口 —— 主机只要读一个 COM 口，不用每轮三次 USB 往返。本机实测
（akaLinkPro + STM32F103 洪水固件）：**2468 KB/s**，而且满速转发时 HID 控制通道照样 260 ms 一次应答。

这一页按「串口助手」的接收半边做，**砍掉了所有发送**（这是纯输出：数据是探针从目标搬过来的）：
端口选择/连接、ASCII / ANSI / HEX 显示、时间戳、暂停、清空、自动滚动、**保存数据**、
**记录到文件**（高速采集不丢数）、高速自动关显示。

用法：RTT 转发页 →「连接探针」（HID，授权一次后页面会自动重连）→ RTT 地址手填或「载入 ELF…」
自动解析 `_SEGGER_RTT` →「启动转发」→ 在**同一页**点「选择…」授权探针的 CDC 口并「连接」，
数据就出来了。「停止」把 CDC 交回 UART。

⚠️ Cortex-M7（H743 / H7B3…）的 DTCM 探针读不到，地址要给 AXI SRAM（如 `0x24000000`）。

协议、返回码（含 `-100` = "排队中"这个坑）、实测数字与踩坑记录都在 [`docs/rtt-cdc.md`](docs/rtt-cdc.md)。
自测：`make test-hid`（协议层，不需要硬件）+ `make test-ui`（页面里假探针 + 演示串口走一遍）。

## J-Scope 波形（变量示波器）

探针侧 HSS 采样：探针自己按你设的周期去读目标 RAM 里那几个变量（**目标固件一行都不用改**），
主机只负责收包、解码、画图。8 个变量正好装进一条 HID 配置报文，数据走 interface 0 上
**原本闲置的 bulk IN 端点 `0x83`**（零描述符改动、不用装驱动）。

页面里现在就能玩的（**不需要硬件**）：
1. 勾「**用假探针（无需硬件）**」→「开始采样」→ 立刻出波形（8 个通道，f32/i32/u16/i16/u8/i8/f64 各一）；
2. 「载入 ELF…」→ 从 DWARF 里选变量（**全局/静态变量 + 结构体成员**，带类型；采不了的会写明原因）；
3. 触发：选通道/阈值/预触发 → 实时命中，或「**查找下一个**」在已采到的数据里重新定位（不用重采）；
4. 导出 CSV、勾「记录原始包」存 `.jsp`、再用「打开回放」离线看波形。

速率的关键不是 USB 而是 **SWD 读**：变量排在一起（同一个结构体）能比散落快 3~4 倍 ——
页面上「读计划」那行会直接告诉你当前选择的 span 数与预计上限。
原理、协议、速率模型、踩坑记录都在 [`docs/scope-page.md`](docs/scope-page.md)。

自测：`make test-scope`（引擎层 127 项，含 8 通道 × 10000 样本逐点对账）+
`make test-dwarf`（ELF/DWARF 78 项）+ `make test-scope-page`（真页面 CDP 95 项）。

**目标类型（SWD/ARM ↔ RISC-V/JTAG）**：探针的目标类型是**全局且粘性**的（HID `0x31` action 10），
波形页和 RTT 转发页都能切。页面显示的是**探针回报的生效后端**（DEF 的 `flags bit6` / 状态字 0 的 `bit1`），
不是"你下发的那个" —— 后端拉不起来时探针会自己换一条路重试，所以要以生效值为准。
切到 RISC-V 后：时钟档自动置灰、**那一格的名字由「SWD 时钟」改成「JTAG 时钟」**（JTAG 下它是 TCK，
探针会忽略这个档位）、计划行的速率提示换成实测分档
（单变量 ≈3.17 µs / 8 通道 ≈36.6 µs，零丢建议周期 ≥1.5×）、标定里的 blob/clock_delay 不再显示。
**切换当场生效、不用等采样**（用户 2026-09-30："我切换了，没有变化"）：显示按 `uiBackend()` 走 ——
用户刚改过下拉就按"你选的"渲染，探针回报过生效值就按"生效的"渲染（两者不一致时红字提醒）。
数字来源：akaLinkPro 的 [`web-handoff-riscv-scope.md`](https://github.com/minichao9901/akaLinkPro)
与 `docs/代码审查报告.md`（2026-09-30 第二轮：P1-1 修完单字 4.25 → **3.17 µs**）。

「RTT 控制块 → 芯片」是**一个下拉、两个组**（ARM / RISC-V，见 `<optgroup data-arch>`）：
选 RISC-V 那颗会自动把目标类型切到 RISC-V/JTAG（RISC-V 只能 JTAG），选 ARM 那颗切回 SWD；
两块各自记住上次选的那颗（`rtt.ocdTarget` / `rtt.rvChip`）。**ARM 也能走 JTAG** —— 那是桥侧
你自己的 cfg 的事，这个下拉只管"哪颗芯片 + RAM 窗口"；桥送出去的 OpenOCD target 名永远取 ARM 组那颗。

真机还差探针固件那一步：补丁草稿在 [`tools/probe-firmware/`](tools/probe-firmware/) ——
`scope_sampler.c/.h`（采样器本体）+ `patch-notes.md`（6 处集成改动，逐段可粘贴）+ 验收清单
（M0 标定 → 用仓库里的 F103 靶子固件逐项对账 → 撕裂率/混叠的量化检查）。

### 真机实测（2026-09-29，探针固件已实现 HSS）

| 配置 | 探针侧标定 @60 MHz | 本页端到端实测 | 丢样本 |
|---|---|---|---|
| **单变量 u32**（3 µs 周期） | 1.54 µs/样本 → **649 kHz** | **333 kHz** | 探针 0 · USB 0 · 缺口 6 / 1.11 M |
| **8 通道**（`g_pack`，1 个 24 B span，12 µs） | 11.14 µs → **90 kHz** | **68.9~72.4 kHz** | 探针 0 · USB 0 · 缺口 7 / 240.9 k |

契约核对全过（`i_sq1k ∈ {±1000}`、`u_hi` 高位 = 1、`f_sin ∈ [-1,1]`、`g_tick` 步进 0/1 零异常），
与探针仓库自己的命令行工具（1.605 µs / 622.9 kHz）同量级。
> 单变量能到几百 kHz 是因为固件把"单字 span"优化成了**每拍 1 次传输**（抱 TAR + 流水读）；
> 多通道才是"字数决定天花板"（6 字 span 光传输就 90 kHz 到顶）。

**只有真机才暴露的三个坑**（都已修）：WebUSB 报的 `endpointNumber` **不含方向位**（0x83 读出来是 3）；
必须先开数据面读**再**发启动（否则最先那个 DEF 包早被丢掉，起跑线永远等不到）；
上一轮的残留包会污染新一轮（用每轮开头的 DEF 当起跑线，之前的一律丢弃并计数）。

## 调试器（零安装：暂停 / 源码级单步 / 硬件断点 / 结构体监视 / 命令行 / RTT 同屏）

网页里直接干调试器该干的那几件事，**不装 OpenOCD、不装 gdb**：
暂停 / 继续 / 单步 / 复位、寄存器表（可改）、内存 hexdump（可改）、
**FPB 硬件断点**、按符号名的命令行、旁边顺手看 RTT 的 printf。

```
连上探针 → 载入 .elf 拿到符号 → b main.c:192 → 继续 → 命中 → 看寄存器/内存 → n/si/fin 源码级单步
```

| 能力 | 说明 |
|---|---|
| 运行控制 | 暂停 / 继续 / 单步 / **跳过 `n`(F10) · 进入 `si`(F11) · 跳出 `fin`(Shift+F11)** / 复位并停 / 复位并跑（走 `AIRCR.SYSRESETREQ`，**不依赖 NRST 接线**） |
| 断点 | **硬件 FPB**（真机 Cortex-M7 = 8 个比较器）：`b main`（符号）、**`b main.c:192`（文件:行）**、`b main:192`（函数:行）、`b +5`（相对当前行）；`bl` 显示源码出处；命中后「继续」会自己跨过断点 |
| 源码级单步 | 用行号表算落点（**不是**逐条指令）：跳过 = 下一行、进入 = 被调函数第一条语句（`prologue_end` 优先）、跳出 = LR 里的返回地址；**源码行双击 = 运行到这一行**（`rc`） |
| 精准位置 | 停下来时显示 `main.c:192 +0x4`（**行内偏移**）与 `函数名+偏移`；源码视图高亮并自动滚动到那一行 |
| 寄存器 | R0-R12 / SP / LR / PC / xPSR / MSP / PSP + **CFBP 拆出的 PRIMASK / BASEPRI / FAULTMASK / CONTROL**；回车即写 |
| 内存 | 任意地址 hexdump（1~1024 字节），勾「可写」后点字节即改；可选**跟随 PC** |
| 监视 | `w g_var` 看标量；**结构体/数组点 ▸ 展开成树**（含位域、字符数组当字符串、超限明说截断）；`p <结构体>` 在命令行打成缩进树 |
| 符号 | 载入 `.elf` → `p g_var`（DWARF 带类型就解出数值）、PC/LR 显示 `函数名+偏移`、`sym <子串>` 搜符号 |
| 命令行 | `h` `r` `md` `mw` `ms` `p` `x` `b` `bd` `bl` `c` `s` `n` `si` `fin` `rc` `halt` `reset` `info` `sym`（↑↓ 翻历史 · Tab 补全） |
| RTT 同屏 | 目标在跑时也能读同一个 RTT 环，停住时照样看 printf |
| 无硬件也能试 | 侧栏「后端 → 模拟目标」是内置的假 Cortex-M（有寄存器/内存/FPB 比较器/BL/BX/RTT 环），自测就跑在它上面 |

六条真机硬约束（都写在 [`docs/dbg-page.md`](docs/dbg-page.md) 与代码注释里）：

1. **PPB（`0xE0000000` 那一片）时钟别乱调高** —— 内核调试寄存器都在那，这颗探针固件在时钟偏高时读回 0；
   页面默认 10 MHz，连接时会**主动验一次**，读回不可信就自动退回 1 MHz 并写日志。
2. **命中断点后"继续"必须先单步跨过**：FPB 命中后 PC 停在断点那条指令上，直接跑会立刻再命中
   （现象是"点了继续没反应"）。做法与 gdb/pyOCD 一致：临时摘比较器 → 单步 → 装回 → 继续。
3. **CFBP 的字节顺序**：`[7:0]=PRIMASK / [15:8]=BASEPRI / [23:16]=FAULTMASK / [31:24]=CONTROL`
   （依据 OpenOCD `armv7m.c` 与 pyOCD 的实现，不是猜的）。
4. **谁在占用探针**：连接前会请别的页签让出探针、并停掉「RTT 转发」的探针桥 ——
   那个桥在**探针侧**一直轮询目标内存，不停的话单步一次要等好几秒。
5. **`C_STEP` 不是哪儿都能用**（2026-10-02 真机实测）：本机 akaLinkPro + STM32F103ZE 上写完
   `C_STEP` 后 DHCSR 回读**恒定** `0x30007`（C_STEP 位在、S_HALT 从不掉）、PC 一动不动；
   带/不带 `C_MASKINTS` 一样，复位到线程模式也一样 —— 但**同一地址"放 FPB 比较器 + 运行"能精确
   停在下一条指令**。所以 `step()` 现在以 **PC 有没有前进**判定成败（不是 S_HALT，那个位会读滞后），
   没前进就自动改用**断点单步**并把原因写进命令行 —— 以前这里是**静默当成功**，"点了单步没反应"就是它。
6. **源码级单步要临时占一个 FPB 比较器**（2026-10）：所以"断点下满了再单步"会失败 ——
   页面**明确报错并提示先删一个**，不静默降级；另外 **F11 在浏览器里是全屏、F5 是刷新**（页面拦不住），
   所以快捷键只是补充，工具栏按钮与命令 `n`/`si`/`fin` 才是等价入口（**不绑 F5**，按下去会丢掉整个会话）。

明确**不做**（与"简单"冲突的无底洞）：反汇编、局部变量/表达式求值、**调用栈回溯**、RTOS 感知、
多核、软件断点、指针跟踪（`*p`）。
自测：`make test-dbg`（纯 Node，**321 项**：寄存器位域 / FPB 编码 / 行号表 / Thumb BL-BLX 编解码 /
断点目标解析 / 结构体树 / 命令解析 + 拿假目标真跑一遍「连接→读寄存器→写内存→下断点→继续→命中→
源码级单步（跳过/进入/跳出）→运行到光标→复位」，含"`C_STEP` 不生效时自动改走断点单步"）、
`make test-dbg-page`（CDP 真页面，**142 项**，含结构体树展开/快捷键/双击运行到光标）、
`make test-dbg-hw`（真探针冒烟；**前提是探针没被别的浏览器/页签占着**，否则会明确提示无法认领接口）。

## 支持的调试后端

| 后端 | 通道 | 双向 | 目标控制 | 依赖 |
|---|---|---|---|---|
| **WebUSB · CMSIS-DAP v2** | 全部（页面读 ch0） | ✅ | 复位（nRESET 脉冲，复位后让它继续运行） | 只认 CMSIS-DAP 类探针（DAPLink / MicroLink / 自制 cherrydap…） |
| **本地桥 · OpenOCD** | 全部 | ✅ | halt/go/reset | 本机装 OpenOCD（ESP-IDF 自带那份即可） |
| **本地桥 · J-Link** | ch0（telnet 19021）或 `JLinkRTTLogger` 落文件 | ch0 ✅ | — | SEGGER J-Link 软件 |
| **内置模拟目标** | 1 up / 1 down | ✅ | 复位 | 无（演示与自测用） |

`WebUSB` 不支持 J-Link 探针（协议不开放）；反过来 J-Link 后端也不需要 WebUSB。

## 零安装烧录

| 目标 | 后端 | 算法 | 进度 |
|---|---|---|---|
| **STM32** F0/F1/F4/F7/H7/L0/L4 | WebUSB · CMSIS-DAP | ARM flashloader（pyOCD 的算法块，见 `app/flash/algos.js`） | 真机打通（F103 实测逐字节一致） |
| **HPM 系列**（RISC-V）5300/5E00/6200/6300/6700/6800/6E00/6P00 | WebUSB · CMSIS-DAP **JTAG** | 自制 RV32 flashloader（HPM SDK 的 `openocd_algo`，1.4 KB，**一份通吃全系**） | ✅ **真机打通**（HPM6800EVK，45 KB 约 9 s，含校验；见 [`docs/真机基准测试-hpm.md`](docs/真机基准测试-hpm.md)） |

HPM 那条路的要点：探针切 SWD+JTAG 输出模式 → `DAP_Connect(JTAG)` → 用 `DAP_JTAG_Sequence`
驱动 RISC-V 的 DMI（IR=0x11）→ Debug Module + SBA 把 flashloader 写进 SRAM → 调它的
`flash_init/erase/program/read`（算法自己调芯片 ROM 里的 XPI NOR 驱动去擦写外部 flash）。
板级参数直接取自 HPM SDK 的 `boards/openocd/boards/*.cfg`。

为什么能"一份 blob 通吃 HPM 全系"：所有 HPM 系列的 ROM API 表地址都是 `0x2001FF00`，
差异只在运行时参数（`flash_base` / `xpi_base` / `option0/1`）。

自测：`make test-hpm`（94 项，**纯离线**：把真实代码跑在模拟 TAP+DTM+Debug Module+SBA+XPI flash 上，
包括"擦→写→校验"端到端与 NOR 的按位与语义）；重建算法：`make hpm-algo`。
设计、证据链、以及**真机 bring-up 的 6 步检查表**见 [`docs/hpm-riscv-flash.md`](docs/hpm-riscv-flash.md)。

## 目录

```
index.html              单页三标签（无构建步骤）
app/
  core/                 bus/store/hex/format/rxview/stats/bin/b64 —— 与界面无关的纯逻辑
  serial/               session(Web Serial 封装) / assistant / terminal / demo(演示串口)
  rtt/                  protocol(RTT 协议) / dap-webusb(CMSIS-DAP) / bridge / elf / mock / view
  elf/                  ELF 与 DWARF：dwarf(解析 .debug_info/.debug_abbrev 等) / lines(.debug_line v2~v5 行号表)
  spi/                  SPI/QSPI：protocol(帧协议) / transport(WebUSB bulk) / mock(假探针·可切 NOR/寄存器器件/ADC) / session(共享会话) /
                        regs+reg-view(通用寄存器面板·档位表) / runner+acq-view(定时采集与实时值) /
                        image(图案·BMP·RGB565·切片·**局部刷新的差异包围盒**) / anim(动画/视频逐帧发) /
                        panel-code + bit-editor(面板初始化表解析与字节编辑) / panel-read(读回) /
                        flash(外接 NOR) / frames-dsl(手写多帧) / bus-view + panel-view(两页界面)
  i2c/                  USB→I2C：protocol / transport / mock / session / dsl(命令表·脚本) / expr(实时值表达式) / runner / registers+reg-view(寄存器面板) / view
  scope/                J-Scope 波形：protocol(读计划/包) / transport(WinUSB) / mock / render(画布) / store / view
  gen/                  工程生成：templates(模板移植自 uvprojx2cmake.py) / fixes(固定 4 项修正) / model(参数+器件表+uvprojx 解析) / zip(零依赖打包) / view
  hid/                  akaLinkPro 自定义 HID：probe(协议 + WebHID 客户端) / mock(假探针) / view(桥的面板) / stream(RTT 转发页，纯输出接收)
  dbg/                  **调试器**（零安装的极简调试前端）：session(会话/运行控制/FPB 断点) / cmd(命令行) /
                        symbols(ELF 符号) / regs(xPSR 与 CFBP 拆位) / bp(FPB 编解码) / fmt(解析与 hexdump) /
                        mock(假 Cortex-M，自测用) / view(界面)；设计与踩坑见 docs/dbg-page.md
  flash/                烧录器：image(固件解析) / algos+runner(ARM flashloader) / view
    hpm/                HPM 系列（RISC-V）：jtag(TAP/DMI 编码) / riscv-dm(DM+SBA) / dap-transport(WebUSB) /
                        flash(擦写流程) / chips(板级参数，来自 SDK cfg) / algo(自动生成的 blob) / entry(入口表解析)
  vendor/xterm/         xterm.js 本地副本（离线可用，MIT）
  ui/                   tabs / toast / dom 小工具
bridge/
  rtt-bridge.mjs        Node 单文件、零 npm 依赖：静态托管 + WebSocket + OpenOCD/J-Link 后端
                        （Ctrl+C / 关窗口会把调试器子进程一起收掉，不留孤儿占探针）
  bridge.config.json    目标配置（stm32f103 / esp32s31 / …）
  start-bridge.bat|sh   双击启动
tools/
  selftest/             自测：Node 协议测试 / 工程生成对账 / HID 协议 / 页面端到端(CDP) / 桥端到端 / 浏览器真机(CDP) / LA 参考流量
    spi-read.test.mjs   **屏的回读**（读寄存器 / 读 GRAM → 预览 + BMP）：读计划、解码、BMP、假探针 GRAM 往返（`make test-read`）
    i2c-registers.test.mjs  **I2C 寄存器面板**：128 B 读回的分组/diff/ASCII、长写分片（页写回卷与 tWR 用假 EEPROM 钉死；`make test-i2c-reg`）
    spi-regs.test.mjs   **SPI 寄存器面板与定时采集**：器件档位（读/写 opcode、地址相位、dummy、自增、MB）→ 帧、假器件端到端、`loop`/`as` 采集（`make test-spi-regs`）
    scenery-samples.test.mjs  屏页**风景照片素材**：目录结构 + manifest 的 sha256 逐个对账 + 页面 parseBMP 真解一遍（`make test-scenery`）
    dbg-core.test.mjs   **调试器页的逻辑层**：寄存器位域 / FPB 断点编码 / 命令解析 / 符号表 + 拿假目标真跑一遍调试动作（`make test-dbg`）
    dbg-page.test.mjs   **调试器页的真页面自测**（CDP + 页面里的假目标，不需要硬件；`make test-dbg-page`）
    hw-campaign.mjs     **真机场景验收**（烧录+Viewer+转发+10s存盘+J-Scope+交替烧录计时，带判决，`make hw-campaign`）
    flash-timing.mjs    烧录耗时体检（`make flash-timing`，ARGS=--clamp 复现"后台页被限速"）
    recorder-file.test.mjs  「记录到文件」落盘语义（`.crswap`/积压/落盘进度，OPFS 替身；`make test-record`）
    serial-grant.mjs    Web Serial 授权的搬运/补当前口/清过期（CDP 管不了串口授权，只能这样自动化）
    com-read.py         独立的主机侧 COM 读者（转发测速/存盘用，os.read 大块读）
    tcpecho.py          **以太网 TCP 回显测试**（server/client/selftest 三种角色，连发 3 条
                        hello, echo!\n 并校验回显；`make tcpecho` / `make tcpecho-server`，
                        靶子是 HPM6800EVK 的 lwIP tcpecho 例程：板子=服务端 192.168.100.10:5001）
  fixtures/gen/         对账基线：Python 工具（uvprojx2cmake.py）对真实工程的原始产物，逐字节比对用
  fixtures/dwarf/       DWARF 解析基线：两份**真 ELF**（scope 靶子固件 + RTT 吞吐固件）
  la/                   逻辑分析仪：kingst_la.py（KingstVIS Socket API 单文件工具）+ SWD 流量发生器
  dev/                  extract-algo.py（从 pyOCD 抽 flash 算法，别手抄 base64）、help.ps1、
                        make-40pin-figure.mjs（生成 README 开头那张 **J3 40pin 引脚定义图**）、
                        make-anim-samples.py（造屏页动画/视频示例素材，`make samples-anim`）、
                        make-scenery-samples.py（造风景照片素材：Commons 原图 → 裁剪/缩放到两套
                        屏几何，写 manifest 与署名表，`make samples-scenery`）、
                        check-liquid.mjs（**Pages 地雷检查**：Markdown 里没被 raw 块包住的
                        Liquid 定界符会让 Jekyll 整个构建失败，`make check` 里会跑）
  target-firmware/          **靶子固件总索引见 tools/target-firmware/README.md**；
                            每个目录根上的 `fw.elf` 是**编好的产物（入库）**，用户不必装工具链
    stm32f103/          STM32F103 测试固件（UART + RTT，含 SEGGER RTT 源码）
    stm32f103_rtt_speed/      F103 RTT 吞吐测试（死循环灌 hello world）；
                              **`-Board ze` 出 96 MHz + 32 KB 缓冲版**（本机板子用这份，见 README 的真机验收一节）
    stm32f103_scope/          **F103 J-Scope 靶子固件**：**96 MHz** 时基 + 契约已知的波形/变量，
                              `-Board ze|c8`（默认 ze）、check.py 客观验收（含 4 KB 地址空洞 → 两个 span 的读计划场景）；与探针仓库里那份逐字节同步
    stm32h743_rtt_speed/      **H743 RTT 吞吐测试**：同 F103 那套量法；RTT 缓冲必须放 AXI SRAM
                              （H7 的 DTCM 外部调试器读不到）。只交 **flash 版**（不做纯 RAM 版）
    stm32h743_scope/          **H743 J-Scope 靶子**：与 F103 同一套变量契约，变量放 AXI SRAM；
                              `-DDCACHE_ON=1` 可打开 D-cache，专门用来复现"H7 上 AHB-AP 读到 cache 旧值"
    stm32h7b0_rtt_speed/      **H7B0 RTT 吞吐测试**（HSI→PLL1 280MHz，DTCM 布局，见其 README）
    stm32h7b0_scope/          **H7B0 J-Scope 靶子**：同一套契约的 H7B0 版（变量放 AXI SRAM）
    hpm6800evk_rtt_flood/     **HPM6800EVK（RISC-V）RTT 吞吐靶子**：96 MHz 死循环灌 hello world，
                              RTT 控制块放**非缓存 AXI SRAM**（`_SEGGER_RTT = 0x01240000`）
    hpm6800evk_scope/         **HPM6800EVK J-Scope 靶子**：契约变量块 `g_v`（非缓存）+ 对照 `g_v_cached`
docs/                   后端配置与排障；逻辑分析仪攻略.md（含 LA 工具完整源码与踩坑）；
                        j3-pin-verdict.md（**J3 40pin 逐脚：该限制谁 / 该释放谁**，接线前先看它）；
                        review-2026-10-02.md（**全站布局 review 与修复记录**：真因 / 改法 / 复测口径 / 对照图）；
                        scope-page.md（J-Scope 波形页方案）；真机基准测试.md（**F103 全场景基线与前置**）；
                        真机基准测试-hpm.md（**HPM6800EVK / RISC-V 基线与 RTT Viewer 的 RISC-V 通路**）；
                        rtt-cdc.md（RTT 转发 + 4.5 节「.crswap 与落盘时机」）；
                        dbg-page.md（调试器页设计）；spi-bridge-page.md / spi-register-panel.md / i2c-page.md（方案）
  shots/                界面截图 + 40pin-j3.png/.html（由 tools/dev/make-40pin-figure.mjs 生成）
samples/
  anim/                 屏页「动画 / 视频」的示例素材：6 个文件（GIF/APNG/动画 WebP/MP4/WebM），
                        每个都写明"看什么"（彩条·弹跳球·色相·帧号·棋盘·立方体），
                        `make samples-anim` 重造；用法与两条口径坑见 samples/anim/README.md
  panel_init_many/      **44 份屏驱动**的初始化档案（从 SiFli-SDK 的 LCD 驱动提取）：
                        `panel_init.json`（44 drivers / 50 init_sequences / 4361 steps）+
                        schema + SPEC + 合并/核对脚本 + 44 份机械 dump；见其 README.md
  test_images/          **BMP 测试图样**：37 张一套，`./` 是 24bpp、`bpp16/` 是**同名同尺寸的
                        16bpp(RGB565)** 对照（各留一张异格式当反例）；240×296 为主，另有
                        16×16 / 41×20 / 64×64 / 120×40 边界；见 samples/test_images/README.md
    scenery/            **风景照片素材**（刷屏看画质用）：4 类（花朵绿树 / 人像 / 蓝天白云 / 大海）
                        × 2 张 × 两套几何（axs15352 = 240×296、st77916 = 360×360）= 16 个 24bpp
                        BMP；`manifest.json` 记作者 / 许可 / 来源页 / sha256，`make samples-scenery`
                        重造、`make test-scenery` 守结构；见 samples/test_images/scenery/README.md
```

## 自测（不需要硬件也能跑一部分）

> 常用操作都收进 **`Makefile`** 了：`make` 看帮助，`make open` 一键盘起页面+浏览器，
> `make test` 纯逻辑自测，`make test-hw` 真机验收，`make fw-restore` 把测试固件烧回板子。
> 下面这些是等价的原始命令。

```powershell
# 1) 纯逻辑（RTT 协议 / ELF 符号 / HEX 解析）—— 不需要浏览器、不需要硬件
node tools\selftest\rtt.test.mjs

# 1b) 工程生成页对账：与 Python 工具 uvprojx2cmake.py 的真实产物逐字节比对（含 ZIP 自解、.uvprojx 解析）
node tools\selftest\gen-parity.mjs

# 1c) akaLinkPro 自定义 HID 协议（RTT→CDC 转发）：组包 / 状态字 / 假探针流程
node tools\selftest\hid-proto.test.mjs

# 1d) 桥的 WebSocket 准入（Origin 白名单 + 口令）：自己拉一个桥实例只做握手，不碰硬件
node tools\selftest\bridge-origin.test.mjs

# 1e) 调试器页的逻辑层（纯 Node，不需要浏览器/硬件）：寄存器位域、FPB 断点编码、命令解析、符号表，
#     并用内置假目标真跑一遍「连接 → 读寄存器 → 写内存 → 下断点 → 继续 → 命中断点 → 单步 → 复位」
node tools\selftest\dbg-core.test.mjs

# 1f) 调试器页的真页面自测（CDP + 假目标；先 page-prep：8899 服务 + 9333 浏览器）
node tools\selftest\dbg-page.test.mjs

# 1g) USB→SPI/QSPI + 屏 + USB→I2C 的逻辑层（纯 Node，不需要浏览器/硬件）
node tools\selftest\spi-proto.test.mjs          # 帧协议 / 打包 / 假探针（make test-spi）
node tools\selftest\spi-panel-code.test.mjs     # 面板初始化表解析 + 图片→帧（含局部刷新，make test）
node tools\selftest\spi-read.test.mjs           # 屏的回读：读计划 / 解码 / BMP（make test-read）
node tools\selftest\spi-frames-dsl.test.mjs     # 手写多帧 DSL（make test-dsl）
node tools\selftest\spi-flash.test.mjs          # 外接 NOR flash 的读/擦/写模型（make test-flash）
node tools\selftest\i2c-proto.test.mjs          # I2C 桥协议（make test-i2c）
node tools\selftest\i2c-dsl.test.mjs            # I2C 命令表/脚本 DSL（make test-i2c-dsl）

# 1h) 那三页的真页面自测（CDP + 假探针，不需要硬件；先 page-prep）
node tools\selftest\spi-bus-page.test.mjs       # USB→SPI/QSPI页（make test-spi-page 的第一半）
node tools\selftest\spi-panel-page.test.mjs     # SPI/QSPI 屏页（含「局部刷新」一节）
node tools\selftest\i2c-page.test.mjs           # USB→I2C 页（make test-i2c-page）
node tools\selftest\ui-layout-page.test.mjs     # 全部 12 页，1600/1280 布局与截图（make test-ui-layout）

# 1i) 真机专项（探针 + 板子）
make spi-partial-hw ARGS="--panel=axs15352"     # 屏的局部刷新：线上字节逐字节对账（换 --panel=st77916 就是档 2）
make dbg-step-hw ARGS="--steps=10"              # 调试器：停止/单步/断点时源码区的显示与同步

# 2) 页面端到端（内置演示串口，无需硬件）
python -m http.server 8899 --bind 127.0.0.1        # 仓库根
pwsh -File tools\selftest\launch-browser.ps1
node tools\selftest\browser-hw.test.mjs            # 只跑页面加载/缓存新鲜度检查
#   完整串口用例（无头跑不了设备授权，需要真窗口 + 已授权端口）：
#   http://127.0.0.1:8899/index.html?demo=serial&selftest=1

# 3) 桥 + 真硬件（需要 OpenOCD + 探针 + 目标板）
node bridge\rtt-bridge.mjs --target stm32f103
node tools\selftest\bridge.test.mjs

# 4) 浏览器 + 真硬件（CDP 驱动，需真窗口 + 已授权设备）
node tools\selftest\browser-hw.test.mjs webusb     # 零安装 RTT
node tools\selftest\browser-hw.test.mjs bridge     # 桥 + OpenOCD
node tools\selftest\browser-hw.test.mjs serial     # 串口助手

# 5) 真机场景验收 / 体检（`make` 会自己起 8899 服务与 CDP 浏览器，页面类目标都依赖 page-prep）
make hw-campaign                                   # F103：①烧狂发→Viewer/转发(判决+10s存盘) ②烧scope→J-Scope ③重复2轮 ④交替5遍
make hw-campaign-hpm                               # HPM6800EVK（RISC-V）：同一套口径，含 **RTT Viewer 的 RISC-V 通路**判决
make hw-campaign-hpm ARGS=--record                 # 只记录不判决，末尾打印"实测 × 80%"的 spec 建议
make flash-timing                                  # 烧录耗时时间线（慢在哪一步）；ARGS=--clamp 模拟"后台页被限速"
make test-record                                   # 「记录到文件」的落盘语义（.crswap / 积压 / 落盘进度），OPFS 替身，不需要硬件
node tools\selftest\serial-grant.mjs --show        # 看测试 profile 里的 Web Serial 授权 / 默认=补当前口 / --clean 清过期
```

## 零安装烧录（WebUSB，2026-09-27 真机打通）

`烧录器` 标签页 → 后端 `WebUSB · 零安装`：页面把 flashloader 算法加载进目标 RAM 跑起来，
自己完成擦/写/校验/复位（与 RTT 共用同一根探针）。实测：
`✅ stm32f103 · 4.6 KB · 校验通过 · 已复位运行`（约 3 秒）。

它踩过的坑比较硬核，都写在 `app/flash/*.js` 注释里，也是本次修 bug 的主要战场：

| 现象 | 真因 |
|---|---|
| 连探针就报 `SWD FAULT` | `_targetInit` 里"先掉电再上电"，掉电写之后那个上电写**必 FAULT**（本探针 + F103） |
| `调试寄存器同步超时（S_REGRDY 没置位）` | `readMem` 里 `addr & ~3` 是 **32 位有符号**运算，PPB 地址（≥0x80000000，如 DHCSR）变负数 → `subarray` 越界 → **读回空数组**，其实寄存器写得进去 |
| `flashloader 执行超时（停在 pc=入口）` | ① LR 必须指向算法 blob 开头的 `BKPT`（`load_address｜1`），写 0xFFFFFFFE 会跑飞；② PC 必须**最后**写；③ 跑算法前要**摁住中断**（SysTick/NVIC），否则擦掉向量表后中断进来直接 LOCKUP |
| `校验失败：读到 0x0` | 块访问**跨 4KB 边界时 TAR 自增会绕回页首**（ADIv5 的有界自增）：长读的第 9 块读到的是页首数据；写则会**写错地址** |
| 块读数据"跳相位/错位" | 同址连读时**不能省 TAR 写**（自增会把地址往前带）；读还是**挂起读**，所以每次访问都重写 TAR + 读两遍取新值 |
| 偶发 `SWD NO ACK` / 界面卡死 | WebUSB **没有取消接口**：`withTimeout` 超时后底层传输仍挂着，会偷响应、甚至把 `getDevices()` 卡死 → 现在超时即把设备标脏并在下次认领前做 **USB 端口复位** |


## 踩过的坑（都写在代码注释里）

> 📌 **2026-10 的两轮真机排查**（"烧录每一步都要好几秒" / "记录到文件后 .crswap 一直长" /
> "转发页一打开就显示已连接" / "测试脚本跑到转发就说没有串口授权"）逐条根因与修法，
> 见下面这几条 + [`docs/真机基准测试.md`](docs/真机基准测试.md) 与
> [`docs/rtt-cdc.md`](docs/rtt-cdc.md) 的 4.5 节。

- **短等待绝不能用 `setTimeout`**（2026-10 定因）：页面不可见（切走页签 / 窗口被盖住 / 最小化）时，
  浏览器把 `<1 s` 的延时**钳到 ≥1 s**，而烧录里有几十处 2~60 ms 的轮询间隔（isHalted 5 ms、
  S_REGRDY 2 ms、稳定读 20 ms…）→ 3.3 KB 固件从 **1.4 s 变 47 s**，现象就是"每一步都要好几秒"。
  → 轮询一律用 `app/core/pace.js` 的 `yieldTask()`（MessageChannel 让一步，不受节流）/
  `waitMs()`（短等待自旋）；硬件 settle 才用 `sleep()`。诊断：`make flash-timing ARGS=--clamp`。
- **`.crswap` 是浏览器自己的临时文件**：File System Access 是"先写 `<名字>.crswap`、`close()` 才改名"。
  记录中看到它**是正常的**，**点「停止记录」才落盘**；记录中关页面/刷新会让 Chrome **删掉**它
  （实测丢过 11.4 MB，正式文件还是 0 B）。「停止转发」**不等于**停止记录（记录挂在 CDC 串口会话上）。
  → 记录按钮现在实时显示"已写/待落盘"，停止时显示"正在落盘…"；切后台会提醒；
  还有积压时 `beforeunload` 拦一下。自测：`make test-record`。
- **Web Serial 的端口授权只能人工点一次**：CDP 的 `DeviceAccess` 域不管串口选择框，
  `Browser.grantPermissions` 里也没有 `serial` 这个权限类型（实测 Unknown permission type）。
  但授权记录存在 profile 的 `serial_chooser_data`（「来源 + **设备实例 ID**」，插到别的 USB 口 ID 就变）——
  所以可以搬：`node tools/selftest/serial-grant.mjs`。
  另外：真页面脚本要**认浏览器**——`make page-prep` 起的是 Edge（默认 profile，没有那些授权），
  而授权在 Chrome 的那个 profile 里，认错了就会"页面没有已授权的串口"。
- **跨页签的"鬼页签"**：BroadcastChannel **不会**在对端消失时通知这边，被关掉的页签会永远留在名单里，
  每次烧录白等满 1.2 s（日志里的「请 1 个其他页签让出探针，0 个确认（等了 1236 ms）」）。
  → 关页签时喊 `bye`，连续两轮不吭声的除名；没同伴时不再干等。
- **下拉是 store 绑定的，测试脚本必须自己校准**：`f-chip` 会被上一次测试留在别的芯片上
  （烧 STM32 报「地址低于 flash 基址 0x80000000」）；`#h-clock` 的值单位是 **Hz**（`60000000`）、
  `#r-usb-clock` 是 **kHz**（`60000`）—— 填错单位不匹配任何 option，会"悄悄没设上"。
- **Makefile 配方里别写中文**：本机 make 走 sh.exe，非 ASCII 经编码转换后**有的能跑（输出乱码）、
  有的直接让这条配方 `Error 1` 且不给任何提示**（最小复现 `Write-Host '已在跑'`）。中文只放注释或 .ps1。
- **`.bat` 两条硬规矩**（2026-10 用户报「双击 start-web.bat 弹出来的 cmd 是乱码」查出来的，
  两条都会让中文 Windows 上的双击体验崩掉，改 bat 前必看）：
  1. **必须是 CRLF 行尾**。`.gitattributes` 里 `*.bat -text` 保证字节原样进出，但如果你用工具
     按 LF 重写了整个文件，cmd 的批处理解析会**错位**：实测 `bridge/start-bridge.bat`（LF）在 936
     控制台下把注释行的残片当命令执行，报 `'saved' 不是内部或外部命令` 之类一串鬼话。
  2. **中文要用「UTF-8 引导段」**：文件是 UTF-8 存的，而中文控制台默认 936(GBK) → 直接双击全是乱码。
     只写一行 `chcp 65001` **不够**：cmd 按块读批处理文件，切代码页那一刻若正好把某个汉字劈成两半，
     剩下的半个字会被当成命令（实测 `'切到' 不是内部或外部命令`）。正确做法见 `start-web.bat` 开头：
     **引导段全 ASCII** → `chcp 65001` → `set "RTT_TOOLS_UTF8=1"` → `cmd /c ""%~f0" %*"`
     重新进入自己（子进程从第一个字节起就按 UTF-8 解析），中文正文全部放在引导段之后。
     用环境变量而不是给子进程加个 `__utf8` 参数：`shift` 不影响 `%*`，加参数会把它透传给被调程序。

> 📌 **2026-09-27 的大排查**（RTT 连不上 + WebUSB 烧录校验失败 + 吞吐回退）逐条根因、
> 复现方法与更正过的旧结论，整理在 [`docs/backends.md`](docs/backends.md) 的
> 「五点五 / 五点六」两节 —— 动 `app/rtt/dap-webusb.js` 之前建议先读一遍。

- **CMSIS-DAP 响应回显**：响应首字节 = 命令回显。探针 IN 端点里可能残留**上一次会话**的响应包，
  天真地"发一条读一条"会整条错位；更阴的是 `DAP_Info` 的回显恰好是 `0x00`，错位后前两条 Info 会假装成功，
  一直到 `DAP_Connect` 才炸。→ 按命令回显匹配、丢弃陈旧包。
- **别做「掉电再上电」**：写 DP CTRL/STAT=0 再写 0x50000000，上电那笔在本探针上**必 FAULT**，
  且炸过之后自锁（下次连接继续炸）。→ 只写上电位，FAULT 时清 sticky + 重激活后重试。
- **`addr & ~3` 会溢出**：PPB 地址（≥0x80000000，如 DHCSR）经 32 位有符号位运算变负数 →
  `subarray` 越界 → **静默返回空数组**（表现成"寄存器写不进去"，其实写对了）。→ 地址先 `>>> 0`。
- **TAR 每次都要重写**：CSW.AddrInc=1 让 TAR 自动前进且不回来，省掉 TAR 写就会"错位读"；
  写 TAR 后也别加"屏障读"（AP 读是挂起读，会把旧值顶进流水线，反而更糟）。
- **块访问有边界**：跨 4KB 边界 TAR 自增会绕回页首（读错、写错地址）；探针还会**截短响应**，
  旧代码把没填到的字当 0。→ 按 1KB 切块 + 边界重写 TAR + 按响应实际条数推进。
- **WebUSB 没有取消接口**：超时后底层传输仍挂着，会偷响应、甚至卡死 `getDevices()`。
  → 超时即标脏设备，下次认领前做 USB 端口复位；所有 USB 操作都要有超时。
- **并发要加锁**：RTT 轮询与下行写交错会搅乱共享的 TAR/流水线 → 下行命令丢失。
- **烧完要 AIRCR 系统复位**：只拉 nRESET 在很多接线（本机这块 F103）上等于没复位，
  而跑 flashloader 前关过 SysTick/NVIC，不复位就是"连得上但不打印"。
- **SWJ 激活序列**：`DAP_Connect` 只做引脚初始化，**主机必须自己发** 88 位序列
  （JTAG→SWD `9E E7` + 线复位 64 个 1 + 空闲 8 个 0）。少了它、或拆成几次发、或把末尾空闲写成 `0xFF`，
  都会让传输一路 `NO ACK(0x07)`（看着像"固件不应答"）。
- **`DAP_SWJ_Sequence` 的位计数是 1 字节**（0 表示 256），不是 2 字节。
- **`DAP_Transfer` 请求 = `[命令, DAP索引, 传输条数, (请求字节 + 4 字节数据)×N]`**，
  漏掉"索引+条数"两个字节 → 固件把请求字节当条数 → `count=0 / ACK=0`。
- **复位别用 `DAP_ResetTarget`**：它常把目标"复位并停住"，甚至留在半启动状态（`.bss` 都没清完）。
- **`FAULT` 之后必须写 DP ABORT 清 sticky**，否则后面每次 AP 访问继续 FAULT（表现成"探针突然瞎了"）。
- **RTT 不重传**：目标写太快会覆盖/丢弃未读数据。最实用的过载信号是**缓冲水位**（≥3/4 记高位）+ 峰值，
  而不是死等"读满"。
- **页面在后台时浏览器会限速定时器**（RTT 轮询会掉到几 Hz），界面会如实提示。
- **ASCII 视图要按 UTF-8 解码**：逐字节当 Latin-1 会把设备发的中文全变成 `·`。
- **Windows 路径别喂给 Tcl**：OpenOCD 的 `program` 命令里 `\t`/`\b` 会被当转义吃掉（`couldn't open E:web...`）。
- **python -m http.server 不带 Cache-Control**：浏览器会启发式缓存 JS 模块，改完代码跑测试可能仍在跑旧模块
  （跑自测前先 `Network.setCacheDisabled`）。

## 许可

本仓库自有代码：Apache-2.0。第三方：`app/vendor/xterm/`（xterm.js，MIT）、
`tools/target-firmware/stm32f103/segger_rtt/`（SEGGER RTT，SEGGER 自己的许可，随上游分发）、
`tools/` 下的自测脚本（自有）。设备与调试器名称、商标归各自所有者。
