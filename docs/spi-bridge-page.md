# USB → SPI/QSPI 桥页（`#spi` + `#panel`）方案

> 2026-10-08 时钟更新：新版探针 SPI2 模块固定 240 MHz，SPI/QSPI 主机和 SPI转发从机共用。外部 SCK 与内部模块时钟分别设置；10/20/40/60 MHz 可精确生成，75/100 MHz 请求实际降为 60 MHz，页面以状态回读的实际速率为准。旧 `moduleClkHz` 提示统一归一化为 240000000。网页默认配置与假探针已同步。

> 页面：`index.html` 新增第 8、9 个标签页 —— **`#spi`「SPI/QSPI 桥」** 与 **`#panel`「SPI/QSPI 屏」**（工作目录本仓库）
> 对端固件：`E:\Share\github\akaLinkPro` 分支 `feature/usb-spi-bridge`（HEAD `aedb705`，P1 已完成）
> 协议真源：`firmware/application_5301/src/spi_bridge/spi_bridge_proto.h`（+ `spi_bridge.c` 实现）
> 硬件方案：`E:\Share\github\akaLinkPro\docs\usb-spi-bridge-plan.md`
> 状态：**P1 已落地**（2026-09-29，未上板）；页面在用户建议下拆成"桥 / 屏"两页，见 §0 第 10 条与 §11.2。

---

## 0. 已拍板（2026-09-29 用户决策）

| # | 事项 | 结论 |
|---|---|---|
| 1 | v1 范围 | **控制台 + 面板初始化表 + 图片刷屏**，分 4 阶段实施（§11） |
| 2 | 上板条件 | **暂时不能上板** → 先把「假探针 + 离线自测」做完整；真机验收脚本提前写好，等板子 |
| 3 | 图片输入 | **BMP + PNG/JPEG**（BMP 自己解析，PNG/JPEG 走浏览器 `createImageBitmap`） |
| 4 | 面板表素材 | **内置两套现成表**（AXS15352 / ST77916）+ JSON / C 片段导入导出 |

**细项（2026-09-29 第二轮拍板）**

| # | 事项 | 结论 |
|---|---|---|
| 5 | 标签页名字 | **`SPI/QSPI 屏`**（`data-tab="spi"`） |
| 6 | SCLK 档位 | **10 / 20 / 40 / 60 / 75 MHz**（5301EVKLite 最高 75 MHz；页面同时显示固件回读的**实际生效**值） |
| 7 | TE 撕裂信号 | **先不做**（读电平 + 等 TE 同步刷屏一律 TBD）；`pad_te` 字段保留在协议层，页面暂不暴露配置 |
| 8 | 帧脚本/面板表持久化 | **先不做**（localStorage 存档留 TBD）；P1 只做单发帧 |
| 9 | README / 截图 | **等 P4 一起改**（P1~P3 期间只在本文档与本页里体现） |
| 10 | 页面拆分（2026-09-29 第二轮反馈："目前这个 web 有点繁重"） | **拆成两页**：`#spi`「SPI/QSPI 桥」= 通用链路（配置 / 通用帧 / 回环自检 / 统计）；`#panel`「SPI/QSPI 屏」= 调屏（面板档 / 初始化步 / 初始化表 / 刷图）。两页**共用同一个 `SpiSession`**（一次连接，跟"串口助手/终端共用一个串口会话"同理） |
| 11 | 屏页内容（2026-09-29 第三轮反馈："有各种内置图案+可以选择图片的功能，还有一个大大的初始化面板，我可以把初始化代码贴进去"） | ① **面板初始化 = 一个大文本框**：贴 C 数组（主格式，也认纯文本行与 JSON）→ 解析成步骤表 → 重放 / 单发 / 从此重放；内置两套示例（**存的是原始 C 文本**，跟"你自己贴"走同一条解析路径）。② **图片 / 图案**：18 种内置图案 + 拖入 BMP/PNG/JPEG → 预览（量化后的样子）→ 开窗 + 527 片下发。③ 像素字节序给 **R/B 交换**开关，默认 RGB565 高字节在前 |

---

## 1. 结论摘要（先看这个）

| 议题 | 结论 | 依据 |
|---|---|---|
| 页面形态 | 本仓库第 8 个标签页 `#spi`，模块化（`app/spi/*`），不是单文件页 | 与 `#scope`/`#flash` 同构；单文件页（参考页那套）在本仓库没有先例 |
| 控制面 | 复用 `app/hid/probe.js` 的 `AkaLinkHid`，新增 `CMD 0x35` 的组包/解析 | §2.2 |
| 数据面 | 新写 `app/spi/transport.js`：WebUSB 认领 **vendor 接口（class 0xFF + EP11 双向）**，OUT `0x0B` 发帧、IN `0x8B` 收应答 | §2.2 §5 |
| 打包粒度 | **一帧不跨 512 B 包**；小帧按包攒批（一次 `transferOut` ≤ 511 B 的短包）、大帧一帧一包；两个方向各 4~8 条在飞 | §2.3 §5.2 |
| 面板表 | 网页是**唯一真源**（探针无状态）：行 `{cmd, data[], delay_ms}` → 一条 `STEP` 帧；表可编辑/导入/导出 | §7 |
| 图片通路 | 拖图 → canvas → RGB565（高字节在前）→ 按 **492 B** 切片 → `XFER`（每片自带 opcode+地址，末片带 RSP） | §8 |
| 离线自测 | **假探针**（同一对象既当 HID 又当 bulk 执行器，含回环与故障注入）→ 无硬件跑通整条链路 | §6 §9 |
| 真机验收 | 最后阶段：`make spi-hw`（回环跳线长度扫描 + 4 线回环 + 可选实屏） | §9.3 |
| 不碰的东西 | 不改固件（只回馈两处注释订正）；不做 TE 同步刷屏、背光 PWM、多设备并发 | §12 |

**吞吐量级**（固件方案 §6.3 的推算，网页侧待实测）：单线 20 MHz ≈ 2.5 MB/s；四线 40 MHz ≈ 20 MB/s。
259 KB 的 ST77916 整屏 ≈ 527 帧 × 492 B，理论上十几毫秒，**USB 侧与主循环侧谁先撞墙要上板才知道**。

---

## 2. 已核实的事实（不是推测）

### 2.1 端点与接口（描述符侧）

| 项 | 值 | 出处 |
|---|---|---|
| 新接口 | vendor specific（class `0xFF`），`bNumEndpoints = 2` | `usb_composite.c` 的 `SPI_BRIDGE_DESC()` |
| OUT | `SPI_OUT_EP = 0x0B`（**EP11 OUT**），bulk，512 B | `usb_composite.h:35` |
| IN | `SPI_IN_EP = 0x8B`（**EP11 IN**），bulk，512 B | `usb_composite.h:34` |
| 接口号 | `SPI_INTF_NUM = HID_INTF_NUM + CONFIG_CHERRYDAP_USE_CUSTOM_HID`（EVKLite 构建下 = 4），**网页不硬编码，按特征找** | `usb_composite.c:66-71` |
| 构建门控 | **只在 HPM5301EVKLite 构建里有**：`BOARD_HAS_SPI_BRIDGE`（EVKLite = 1，akaLinkPro = 0） | `boards/*/board.h` |
| 同设备的其它 0xFF 接口 | WebUSB 平台接口（class `0xFF`、**0 个端点**）→ 不能用"class 0xFF"单独认接口 | `usb_composite.c:341` |

> ⚠️ **两处必须按实测代码走、不能照 proto.h 注释的字面**（见 §10.1）：
> 1. `cs_policy` 的真实语义是 `0/2 = PB10 作 GPIO CS（软件拉/放）`、`1 = 辅助脚作 GPIO CS`、`3 = 硬件 CS0`（`spi_bridge.c:483-499`）；proto.h 的注释写成"0=硬件 CS0 自动；1=辅助 CS 自动；2=手动"，与实现不符。
> 2. STATUS 的计数器顺序：`res[36] = 实际 SCLK`、`res[40] = frames_err`（`spi_bridge.c:1469-1481`），与 `sb_stats_t` 结构体顺序（`frames_err` 排第二）不符。

### 2.2 HID 控制面 `0x35`（响应形状按实现核对过）

请求 `req[2] = 0x35`、`req[3] = action`、`req[4..] = 参数`；响应 `res[1] = Data Length`、`res[2] = 0x35`、`res[3] = action` 回显。

| action | 名称 | 请求 | 响应（`res` 偏移） |
|---|---|---|---|
| 0 | `STATUS` | — | `[4..7]` 状态字 + 9 × u32：`frames_ok(8) bytes_tx(12) bytes_rx(16) tx_poll(20) tx_dma(24) out_ovf(28) in_drop(32) actual_sclk(36) frames_err(40)`，`res[1]=44` |
| 1 | `ENABLE` | `[4]` 0/1 | `[4..7]` 状态字，`res[1]=8` |
| 2 | `RESET` | — | 清环/清计数器，`[4..7]` 状态字 |
| 3 | `SET_CFG` | `[4..35]` = 32 B 配置块 | `[4..7]` 状态字（非法 → 错误码 `SB_E_RANGE`） |
| 4 | `GET_CFG` | — | `[4..35]` = 32 B 配置块，`res[1]=36` |
| 5 | `PIN_CFG` | `[4]=line [5]=pad 索引 [6]=有效电平` | `[4..7]` 状态字（quad 用了 PA30/31 会被拒） |
| 6 | `ABORT` | — | `[4..7]` 状态字 |
| 7 | `SET_PROFILE` | `[4..19]` = 16 B 面板档块 | `[4..7]` 状态字（非法值被夹取） |
| 8 | `GET_PROFILE` | — | `[4..19]` = 16 B 面板档块，`res[1]=20` |

配置块（32 B）：`sclk_hz(u32) mode bits cs_policy tx_dma_threshold pad_dc pad_rst pad_cs_aux pad_bl pad_active_low pad_te flags reserved0 out_ring_kb(u16) in_ring_kb(u16) max_frame_bytes(u16) reserved[10]`。
默认值（`spi_bridge.c:1365-1382`）：`sclk_hz=0`（→ 板级 20 MHz）、`threshold=100`、DC=PB11、RST=PB12、CS_AUX=PB10、BL=PB13、TE=PB10、`pad_active_low=0x06`（RST + CS 低有效）。

面板档（16 B）：`profile def_lines dc_active_high cs_hold_in_step qspi_wr_opcode qspi_color_opcode qspi_addr_bytes flags reserved[8]`；`profile`：`0=raw 1=spi_dcx 2=qspi`。

pad 索引表（0~13）：无 / PB11 / PB12 / PB13 / PB10 / PA02 / PA09 / PA00 / PA01 / PY00 / PY01 / PA10 / PA30 / PA31。

错误码：`0 OK, 1 DISABLED, 2 BAD_MAGIC, 3 BAD_FRAME, 4 RANGE, 5 TIMEOUT, 6 IN_FULL, 7 DMA, 8 BUSY, 9 GPIO`。

### 2.3 数据面语义（固件实现逐行看过）

1. **一帧不跨 USB 包**（主机侧纪律）：固件按"一次 OUT 回调 = 一个包"为单位解析，包内可含多帧。
2. **尾部残渣**：包尾不足 8 B（或放不下一整帧）时**静默丢弃、不计错**（`spi_bridge.c:1085-1089`）；但若剩余 ≥ 8 B 且 magic 不对 → `frames_err++`（`SB_E_BAD_MAGIC`）。→ **打包器绝不能产生 ≥ 8 B 的填充**，收尾只能靠"短包"或恰好放满。
3. **轮询预算**：`SB_POLL_MAX_FRAMES = 8`、`SB_POLL_MAX_BYTES = 2048`（`spi_bridge.c:92-93`）→ 每轮主循环最多吃 8 帧 / 2 KB，剩下的下一轮。
4. **环**：OUT 32 槽 × 512 B = 16 KB，IN 16 槽；**未使能时不 arm OUT 端点**（主机写会 NAK，天然背压）。
5. **RSP**：只有带 `SB_F_RSP` 的帧才产生 IN 应答；不带 RSP 的帧出错时发 `EVT`（`0x82`）。**读数据（`rx_len ≠ 0`）必须带 RSP**，否则 `SB_E_BAD_FRAME`。
6. **全双工要求收发等长**：`wlen != 0 && rlen != 0 && wlen != rlen` → `SB_E_RANGE`（`spi_bridge.c:527-530`）。回环自检必须 tx_len == rx_len。
7. **P1 全部走轮询**：`tx_dma_cnt` 恒为 0（`spi_bridge.c:585-588`），DMA 是固件 P2 的事 → 页面上"阈值/DMA"在 P1 固件下只是占位，**必须如实标注**，不能让用户以为在跑 DMA。
8. **延时非阻塞**：`DELAY` / `STEP.delay_ms` / `RESET` 都只登记"下一个允许执行的时刻"，期间主循环照常（DAP/RTT/Scope 不受影响）。
9. `dummy` 字段 1..4 → 驱动写 `dummy_cnt = dummy - 1`；`0` = 不发 dummy。

### 2.4 素材：两块屏的初始化表（可脚本提取，不需要手抄）

| 屏 | 文件 | 规模 |
|---|---|---|
| 天马 2P01 / AXS15352（240×296，4 线 SPI + DC） | `E:\esp-idf-wsh\projects\spi_lcd_axs15352\main\axs15352_init_cmds.h` | 30 条（带参数 28 条、带延时 1 条），`{cmd, data[], nbytes, delay_ms}` |
| ST77916（圆屏 360×360，QSPI） | `E:\esp-idf-wsh\projects\qspi_lcd_st77916\main\st77916_init_cmds_ch32.h` | 192 条 / 215 参数字节 / 累计 120 ms |

两份都是 `{cmd, (uint8_t[]){...}, len, delay_ms}` 的 C 数组，**用 Node 脚本正则提取 + 自测对账**（条数/总字节/逐行哈希），跟「工程生成」页 `templates.js` 的逐字节移植同一套纪律。
另有 `E:\esp-idf-wsh\资料\panel_init\dumps\st77916.json`（含接口/时序元数据）可作交叉校对。

### 2.5 仓库里可直接复用的东西

| 用途 | 现成模块 | 复用方式 |
|---|---|---|
| HID 0x35 客户端 | `app/hid/probe.js`（`AkaLinkHid.xfer`） | 直接用；新增 `spi(action, data)` 便捷方法 |
| WebUSB bulk 传输 | `app/scope/transport.js` | **同形新写**（它只做 IN；这里要 IN+OUT），但把"接口发现 / 认领失败退避 / 无取消接口的收尾纪律"照抄 |
| 短等待纪律 | `app/core/pace.js`（`yieldTask` / `waitMs`） | 页面里**不许用 `setTimeout` 做 ≤128 ms 的轮询等待**（页面不可见时会被钳到 1 s） |
| 跨页签协调 | `app/core/probe-bus.js` + `main.js` 的 `probeBus.onRelease` | 新页面接入：别人要占用探针时让位；本页也要能"要求别人让位" |
| 页面骨架/小工具 | `app/ui/dom.js`（`$`/`seg`/`setStatus`）、`app/ui/toast.js` | 直接用 |
| 页面自测骨架 | `tools/selftest/scope-page.test.mjs`（CDP + 真页面对象） | 照抄结构 |
| 参考交互设计 | `E:\esp-idf-s31\projects\spi_lcd_bmp\tools\bmp_sender.html` | **只借鉴交互**，见 §3 |

---

## 3. 与参考页 `bmp_sender.html` 的关系

**借鉴（好东西直接学）**

- 面板初始化表的**表格编辑器**：每行 `# / 命令 / 长度 / 延时 / 数据（每格一字节）`，行尾 `+` / `−` 加减字节，`单发` / `从此重放`。
- **位编辑器**：点某个字节弹出 8 个 bit，点一下翻转（省掉手算字段值），与本行原值不同的位标黄。
- **常驻操作条**：发送/中止 + 进度/速率/耗时 吸顶，"这一下会发什么"摘要写在第二行。
- 内置图案（纯色/色条/棋盘/渐变）+ **灰阶（电平）** 这种"不用准备素材就能试屏"的小工具。
- 屏幕预览画布上标出"图片实际落点（实线）/ 板子真正下发的对齐窗口（虚线）"。
- 导出 C 片段 / JSON 导入导出、快捷键 `Ctrl+Enter`。

**不一样（这次必须换掉的地方）**

| 维度 | 参考页（ESP32 工程） | 本页（探针 SPI 桥） |
|---|---|---|
| 链路 | Web Serial（COM 口）+ 自定义 `BMPX` 帧 | **WebHID 控制面 `0x35` + WebUSB bulk 帧流**（两条管道，顺序性只由 bulk 保证） |
| 表在哪 | **板子里内置**原表 → 可"读回原表"、按行指纹对账改动 | **探针无状态**：网页是唯一真源；没有"读回"，只有本地编辑 + 导入导出 |
| 帧上限 | 单帧 32 KB（板子侧缓冲） | **一帧 ≤ 504 B，且不跨 512 B 包** → 必须自己做打包器（§5.2） |
| 面板处理 | 板子按固定表 + `SET_POS`/`IMG_*` 语义 | 探针只认 `STEP`/`XFER`，**DC 翻转、QSPI opcode+24 bit 地址全由"面板档"在固件里展开**，网页只需选档 + 下行 |
| 屏 | 一块（AXS15352 240×296） | 两块（AXS15352 4 线 SPI+DC / ST77916 QSPI 360×360），档位 1 与档位 2 |
| 图片 | 只 BMP（16/24bpp） | BMP + **PNG/JPEG**（浏览器解码） |
| 无硬件时 | 无（必须插板子） | **假探针**：整条链路 + 故障注入都能离线跑（§6） |

---

## 4. 页面结构（两页 + 一层共享会话）

```
index.html  ──  <button class="tab" data-tab="spi">SPI/QSPI 桥</button>
                <button class="tab" data-tab="panel">SPI/QSPI 屏</button>
                <section class="panel" id="tab-spi"> …   ← 通用链路（配置/通用帧/回环/统计）
                <section class="panel" id="tab-panel"> … ← 调屏（面板档/初始化步/表/刷图）
app/main.js ──  const spiSession = new SpiSession();          ← **一次连接，两页共用**
                new SpiBusView(spiSession) / new SpiPanelView(spiSession)
                注册 init()/onShow()/summary()，接入 probeBus.onRelease
```

```
app/spi/
  protocol.js   协议唯一真源的 JS 镜像（帧/HID/档/错误码/pad 表）+ 打包器 + 应答切包/配对  ← 纯函数，Node 可测
  transport.js  数据面：WebUsbSpiTransport（claim vendor 接口，EP11 in/out，读写各 N 条在飞）
                + MockSpiTransport（把帧交给假探针执行）
  mock.js       假探针：HID 0x35 语义 + bulk 帧执行（XFER 回环 / STEP 展开 / 计数器…）+ 故障注入
  session.js    **共享会话**：连接、协议收发、配置/档位/状态读写、统计、日志 ring、订阅广播（不碰 DOM）
  bus-view.js   桥页视图：配置 / 辅助脚 / 使能与状态 / **右列四个 tab**（命令表 / 脚本 / Flash 测试 / 回环自检，+ 运行胶囊与共享中止）/ 日志 / 统计
  frames-dsl.js 手写多帧的**键值行 DSL**：解析 + 三条自动规则 + 带行号的错误定位（纯函数）        ← 2026-10
  flash.js      外接 SPI NOR：命令表 / JEDEC ID 与 SFDP 解析 / 连续读拆帧 / 按页编程 / 器件模型   ← 2026-10
  panel-view.js 屏页视图：面板档 / 按屏套用推荐值 / 快捷面板步 / 复位与显示 / 只读摘要 / 日志
  panels.js     内置面板表（脚本从 C 头文件提取的产物）+ 表模型（行增删改、JSON/C 片段导入导出）  ← P2
  image.js      图片 → RGB565：BMP 解析 + createImageBitmap 通路 + 缩放/裁剪/对齐 + 切片         ← P3
```

**为什么要那一层 `session.js`**：拆页之后"连接探针 / 连接数据端点 / 用假探针"只该做一次。
会话层持有硬件状态并广播（`subscribe()` → `onSession(type, payload)`），两个视图各自渲染自己的表单 ——
这跟「串口助手 / 终端」共用同一个串口会话是同一个模式。**会话层不碰 DOM**，否则两页会互相覆盖输入框。

**`#spi` 桥页的 UI**（左侧栏 = 设置，右区 = **一个带 tab 的面板**，日志钉在下面）
- 左栏：① 探针连接（`连接探针` / `重连` / `连接数据端点` / ☑ `用假探针` / 在飞读条数）② 桥配置（SCLK 档位 **10/20/40/60/75 MHz** + "板级默认(0)"、模式 0~3、CS 策略、DMA 阈值、`ENABLE 时清环`）③ 辅助脚 DC/RST/CS_AUX/BL + 有效电平位图（**TE 暂不暴露**）+ **背光开/关** + **RST 脉冲** ④ 使能 / 复位 / 中止 / 读状态 + 状态字 + 计数器 + 实际 SCLK
- 右区（`.spdock`，照「调试器」页那套 `.docktabs` / `.dockpage`；**一次只显示一块，每块吃满整块高度**）：

  | tab | 内容 |
  | --- | --- |
  | **命令表** | 一行一条 `XFER`，表头就是参数项（`cmd / 线数 / addr_len / addr / dummy / rx_len / tx 数据`），固定 10 行；空行不发，**每行都带 RSP**，结果列逐行显示 `OK · 前几字节` 或错误码。批量选项只有两个：`整段保持 CS（末条释放）` 与 `速率路径（自动/轮询/DMA）` |
  | **脚本** | 贴 C 表 / 脚本（键值行 DSL + C 表行），能读 `.c/.h/.txt/.json`，能导出 C 表 / JSON / 归一化文本 |
  | **Flash 测试** | 读 ID / SFDP / 状态 / 读一段 / 读测速 / 擦除 / 写+校验 / 写测速 |
  | **回环自检** | 长度扫描 × 线数 × 轮询/强制 DMA 对照，结果进表格（`跑回环` / `清空结果` / 摘要；**中止在 tab 栏**） |

  tab 栏右侧常驻**运行胶囊**（`空闲` / `▶ 忙（有操作在跑…）` / `▶ 回环自检 3/8`）与共享**「中止」**；
  下面是常驻的**日志**（帧流水，高度可拖，存 `spi.logH`）与统计条。tab 选择存 `spi.dock`。

> 2026-10-02 第三次改版（用户："布局优化一下，参考调试器界面右边做成多个 tab，现在有点繁琐"）：
> 之前是**单列 4 块、整体滚动、每块都能折叠**，但每块都被迫限高 —— 命令表限到 146px（只露约 7 行，
> 那是因为"不限的话这一块 310px，在 580px 高的窗口里会把中列可视区整个占满"）、
> Flash 卡的输出框/写数据框钉死 150px、脚本文本框封顶 220px。想同时看"命令表"和"它在跑什么"
> 得在三张卡之间滚。改成 tab 之后每块吃满高度（实测四个 tab 各 613px），
> 4 个「收起」按钮一并删掉（tab 化后冗余），折叠状态本来也不持久化。
> **日志与运行胶囊仍然常驻**：日志是 tab 化之后唯一的过程视图；胶囊是跨 tab 传达"桥在跑什么"的
> 唯一地方 —— 桥有**全局 busy**（一处置位就把二十多个按钮一起灰掉），少了它就只能去翻日志。

> 2026-10 前两次改版的来由：① 原来的「简单帧 / 引脚」整卡删掉（PING / CS / GPIO / DELAY / RESET 都是帧类型，
> 一行文字就能写），只把**背光开/关**与 **RST 脉冲**挪进左栏；② 用户看了两列那版直说"好丑"，
> 于是右区改成**单列 4 块**、通用帧从"一堆勾选框的表单"改成**一行一条的命令表**，
> 并去掉 `设 DC / DC=1 / 用辅助 CS / 0x69 token` —— 通用口是给 SPI 小模块（NOR / 传感器 / 无线模块）用的，
> 不是点屏那一套，DC/token 那类屏专用开关放在这儿只会让人犯迷糊（协议层仍然支持，DSL 里写 `dc1` / `token` 即可）。

**`#panel` 屏页的 UI**
- 左栏：① 探针（**与桥页共用会话**，两页都能连）② 屏型号与推荐值（AXS15352 / ST77916 → 一键套用档位 + SCLK + DC/RST/BL）③ 面板档（profile 七件套）④ 当前生效（只读摘要：SCLK / CS 策略 / 辅助脚 / 档位）+ 使能/失能 ⑤ 面板电源 / 显示（`11h/29h/28h/10h` + RST 脉冲）
- 右列：**一个带 tab 的面板**（刷屏 / 面板初始化 / 读回）+ **常驻**日志 + 统计条（见 §10.0b、§11.13）
  - **刷屏**：内置图案 chips、拖放选图、预览画布（吃满高度）、缩放/开窗/屏幕/字节序/R-B/电平、刷这一张，**动画 / 视频**（选文件 → 播放到屏）
  - **面板初始化**：内置示例 / 读文件、源码文本框（可拖高 70~400）、解析并预览、字节表格（吃剩余高度）、重放全部 / 单发 / 从此重放
  - **读回**：读寄存器、窗口（默认整屏）、读时序、读一帧 / 保存 BMP、**自己的预览画布** + 显示开关副本
- 基础配置（SCLK / 模式 / CS 策略 / 通用辅助脚 / 回环自检）**不在这里**，留在桥页 —— 免得同一件事两个地方都能改

---

## 5. 协议层设计（`app/spi/protocol.js`）

### 5.1 纯函数清单（Node 自测直接打）

```js
frame(type, payload, {flags, seq})            // → Uint8Array（8 B 头 + payload），>504 抛错
xferPayload({cmd, tcfg, addrLen, dummy, tx, rxLen, addr})   // 12 B 头 + tx
stepPayload({cmd, params, delayMs})           // u8 cmd, u8 nparams, u16 delay_ms, params[]
resetPayload({lowMs, postMs}) / delayPayload(us) / gpioPayload(line, level) / csPayload(assert)
packFrames(frames[], maxPacket = 512)         // → 一次 transferOut 的若干"包"（见 5.2）
parseRsp(u8)                                  // → {type, status, seq, data} | null
cfgEncode/Decode, profileEncode/Decode        // 32 B / 16 B 结构块
STATUS / ERR / PAD / PROFILE 常量与中文名
statusWord(u32) → {enabled, active, cs, inFlow, outFull, lastErr}
```

### 5.2 打包器（`packFrames`）—— 一帧不跨 512 包

规则（固件 `sb_process_packets` 的实际语义）：

- 累加帧，**若加入下一帧会超过 512 B → 当前组到此为止**，作为一次 `transferOut`（总长 ≤ 511 B，USB 侧是短包，固件解析到包尾正好干净结束）。
- **绝不填充**：剩余 ≥ 8 B 的填充会被当成帧头 → `frames_err++`。
- 收益：AXS15352 的 30 条 ≈ 0.8 KB、ST77916 的 192 条 ≈ 3~5 KB → **十几次 USB 往返**就下完（不分包的话是 200+ 次）。
- 图片帧（492 B payload + 8 B 头 = 500 B）→ 一帧一包，没有攒批空间；提速靠**多条 `transferOut` 在飞**（默认 4，可调）。

### 5.3 在飞与收尾纪律（`transport.js`）

1. **OUT**：维护 N 条在飞（默认 4）；写失败/超时即标脏设备；固件 OUT 环满时会 NAK → 表现为写挂起，**必须有超时**。
2. **IN**：保持 4 条 `transferIn(4096)` 在飞；按 8 B 头切包解析，按 `seq` 与在飞请求配对；`EVT(0x82)` 进错误日志。
3. **收尾**：WebUSB **没有取消接口** → `stop()` 必须先停发、再等在飞读写自己回来（照抄 `app/scope/transport.js` 的做法），否则残留的读会偷走下一场的应答。
4. **认领失败**：`Unable to claim interface` → 端口复位重试一次 → 仍失败给出"检查别的页签/OpenOCD/J-Link"的清单（照抄 scope 的文案思路）。
5. **SPI 桥接口找不到** → 明确报"这块固件没有 SPI 桥（EVKLite 构建才有）"，并列出设备实际暴露的端点（照抄 scope 的诊断输出）。

### 5.4 错误与统计

- 每个带 RSP 的请求有超时（默认 1 s，可调）；超时记为"丢应答"，**不静默**。
- 页面统计四类：协议层（`frames_ok/err`、`in_drop`、`out_ovf`，来自 HID `STATUS`）、传输层（在飞、写失败、超时）、应用层（本次任务已发字节/帧/耗时/速率）、告警（最近错误码 + 中文解释）。

---

## 6. 假探针（`app/spi/mock.js`）—— 没有硬件也能跑通整条链路

一个对象同时扮演两个角色（与 `#scope` 页 `MockScopeProbe` 同一思路）：

- **HID 侧**：`xfer(cmd, data)` 实现 `0x35` 的 9 个 action（配置读写/使能/状态/计数器/profile/pin），并模拟"实际 SCLK = 分频后的值"（照 `sb_pick_sclk` 的整除规则算，让页面能试显示）。
- **bulk 侧**：接收"包"，按固件同样的规则解析（含 8 B 头校验、尾部残渣丢弃、magic 错 → `frames_err++`），执行帧：
  - `XFER`：**回环模型**（tx 原样作为 rx 返回），可注入"位错/丢字节"；
  - `STEP`：按当前档位展开（档 1 = 命令 + 翻 DC + 参数；档 2 = `wr_opcode` + 24 bit 地址 + 参数）→ 产出**线上字节流**供自测逐字节对账（这是离线验证"档位展开对不对"的关键手段）；
  - `CS/GPIO/DELAY/RESET/AUX_IN`：改内部引脚状态 + 时间戳；`DELAY` 记录非阻塞调度。
- **故障注入**（自测错误路径用）：`in_full`、`bad_magic`、`timeout`、`drop_rsp`、`disabled`。
- **在飞/包序**：记录每个"包"的字节与帧边界 → 自测可断言"没有任何一帧跨包""没有 ≥8 B 的填充"。

页面开关：☑ `用假探针`（并把 HID 与 bulk 指向**同一个** mock 实例 —— 这是 `#scope` 页踩过的坑：两个实例会造出"配置发给 A、数据从 B 出来"的假象）。

---

## 7. 面板档与面板初始化表

- 表行的模型：`{ cmd: u8, data: u8[], delayMs: u16 }`（**灵活长度**，加/减字节不动协议）。
- 每行 → 一条 `STEP` 帧：`u8 cmd, u8 nparams, u16 delay_ms, params[]`。
- 档位语义（固件 `spi_bridge.c:744-801`）：
  - `raw(0)`：一次 `XFER`，cmd + params 同线数（`def_lines`）；
  - `spi_dcx(1)`：同一 CS 窗口内 `DC=命令 → 发 8 bit cmd → 翻 DC=数据 → 发 params`（AXS15352）；
  - `qspi(2)`：`cmd = qspi_wr_opcode(0x02)` → 24 bit 地址 = `面板命令字 << 16` → 1 线 params（ST77916）。
- 两套内置表 + 对应档位参数（页面"一键套用"）：
  | 屏 | profile | 关键参数 | 表规模 |
  |---|---|---|---|
  | AXS15352 / 天马 2P01 | `spi_dcx` | `dc_active_high=1`、`cs_hold_in_step=1`、SCLK 20~40 MHz、DC=PB11 / RST=PB12 / BL=PB13 | 30 条 |
  | ST77916 | `qspi` | `wr=0x02`、`color=0x32`、`addr_bytes=3`、SCLK 40 MHz | 192 条 |
- 导出：JSON（人看/再导入）、C 片段（贴回 `*_init_cmds.h`）、**帧序列十六进制**（可直接粘进 `script_test/spi_bridge_test.py` 做对照）。
- 与参考页的差别：没有"读回原表"和"行指纹对账"（探针无状态），改为"当前表 = 编辑区"，但保留"撤销全部修改 / 从内置表恢复"。

---

## 8. 图片通路（`app/spi/image.js`）

```
拖入 BMP/PNG/JPEG
  → 解码：BMP 自己解析（16/24bpp，BI_RGB / BI_BITFIELDS）；其余走 createImageBitmap
  → 画进离屏 canvas（目标尺寸 = 屏尺寸；缩放/裁剪/居中/边缘钳位）
  → getImageData → RGBA
  → RGB565（R5 G6 B5）→ **高字节在前**（探针字节透明，字节序由主机负责）
  → 开窗（按档位拼 CASET/RASET 那几条帧）+ 按 492 B 切片
  → 每片：XFER{cmd=color_opcode, addr_len=3, addr=RAMWR<<16, lines=4, tx=片}  （QSPI 档）
         或 XFER{dc_en, dc_level=1, tx=片}                                  （SPI+DC 档）
  → 只有最后一片带 RSP（避免 IN 流量拖慢灌数据）
```

细节纪律：

- **切片 492 B 上限**（`504 - 12`）；每片自带 opcode+地址（CS 每片一收一放），与参考页"每 chunk 都重发命令"同理。
- **x 4 像素对齐**（AXS15352 需要）：预览里画"实际落点（实线）/ 对齐窗口（虚线）"，多补的像素用边缘钳位填（参考页验证过的做法）。
- 灰阶/电平、内置图案、`整屏填充`、`Ctrl+Enter` 发送照参考页保留。
- 颜色顺序（RGB vs BGR）做成可选项：屏的 MADCTL 不同 → 给一个 `R/B 交换` 勾选，避免"颜色对不上只能改固件"。

---

## 9. 自测与验收（三档，前两档现在就能跑）

### 9.1 Node 纯函数（进 `make test`）

`tools/selftest/spi-proto.test.mjs`（**已落地，79 项全绿**）：

- 帧编解码往返；`>504` 拒绝；`packFrames` **断言没有任何一帧跨 512 包、没有 ≥ 8 B 填充**；
- HID 0x35 组包/解析：`GET_CFG`/`GET_PROFILE`/`STATUS` 的**字节偏移逐个钉死**（对着固件 `spi_bridge.c` 的行号写在测试注释里）；
- 面板表：内置两套表的条数/字节数/逐行哈希对账（对着 C 头文件）；
- 档位展开：档 1 / 档 2 的**线上字节流金样例**（如 `STEP{0xCE,[5A A5]}` → `DC0 CE DC1 5A A5`；`STEP{0xF0,[28]}` → `02 00 00 F0 28`）；
- 图片：小图（4×2 棋盘）→ RGB565 的**逐字节金样例**（含高低字节序、对齐补边）。

`tools/selftest/spi-frames-dsl.test.mjs`（**124 项全绿**，`make test-dsl`）：DSL 的词法/数字/时长、
三条自动规则（cmd/addr 自动开相位、`rx>0` 必带 RSP、零 RSP 时末帧补）、**24 条错误用例**（未知 key、
全双工不等长、tx 超 492、`addrl=0` 却给 addr、TE 不能写、引号没配对、C 表行列数不够…）以及"错误行号对准源文件"，
外加 **C 表行 / 导出 / 回灌的往返**（导出 C 表、JSON、归一化文本，再解析回来，逐帧比对字节与 flags）
与**面板示例片段的回归**（示例写错比功能写错更丢人）。

`tools/selftest/spi-flash.test.mjs`（**66 项全绿**，`make test-flash`）：JEDEC ID/SFDP/状态寄存器解析
（SFDP 布局以 Linux `drivers/mtd/spi-nor/sfdp.h` 为准）、连续读拆帧（首帧带 cmd+地址、续读帧 `cmd_en=0`、
末帧 `CS_OFF`）、按页编程不跨页、以及**器件模型按 NOR 的规矩答**（WEL/BUSY、只能 1→0、跨页报错、QE=0 拒四线）。

### 9.2 页面端到端（CDP 真页面 + 假探针，`make test-spi-page`）

`tools/selftest/spi-bus-page.test.mjs`（桥页，**133 项全绿**）与 `tools/selftest/spi-panel-page.test.mjs`（屏页，**154 项全绿**），骨架照 `scope-page.test.mjs`：

开假探针 → 连接 → 写配置并回读核对 → 选档 → `ENABLE` → 重放内置面板表（断言假探针收到的**帧数与字节流**）→ 刷一张 96×96 图（断言切片数/末片带 RSP/无 frames_err）→ `STATUS` 计数与页面显示一致 → 注入 `in_full`/`bad_magic` 看错误路径是否如实显示 → `ABORT`/`RESET` 收尾。

桥页那 133 项里有 32 项是 2026-10 新增的：右区就是那 4 块、命令表 10 行且字段齐全、
旧表单的 DC/token/辅助 CS 勾选项已撤、填 3 行发 3 条（空行不发）且结果列逐行显示读回的字节、
C 表行 + 非 XFER 帧混着发、语法错**一条都不发**且错误表带行号、读文件（造一个 `File` 对象）后自动解析、
三条导出的往返、引脚下拉的灰项与固件拒绝规则一致、flash 卡从读 ID 到"写 + 回读校验 + 擦除后再读回全 FF" 走一整轮。
2026-10-02 又加了 **1b「右列分 tab」与回环的中止/胶囊**：四个 tab 都在、点谁显谁、同时只有一个 `.on`、
选择落 localStorage、切 tab 不重建命令表也不污染回环结果、运行胶囊与中止挂在 legend 上（不属于任何 tab）、
起跑瞬间胶囊就报进度、**切到别的 tab 不打断回环**、跑完胶囊转结果且中止变灰。
再补上「清空结果」按钮和 Flash 卡的**排版回归**：动作按钮必须是内容宽（不是被 `flex:1` 拉成 591px）、
四个参数排一行、**两个数据窗口精确等高**（这条是量出来的 —— 光给 `flex` 不够，见 §10.0 第 8 条）。

### 9.3 真机（**已跑通**，2026-09-29 —— 屏点亮）

`tools/selftest/spi-hw.mjs`（`make spi-hw`）——CDP 驱动真页面 + 真探针，设备选择框自动应答：

```bash
make spi-hw                                # 默认 AXS15352 / 40 MHz
make spi-hw ARGS="--sclk=20,40,60,75"      # 逐档 SCLK 对比吞吐
make spi-hw ARGS="--panel=st77916"         # 换 ST77916（档 2，QSPI）
make spi-hw ARGS=--loop                    # 先跑回环自检（要 J3[28]↔J3[27] 跳线）
```

实测（天马 2P01 / AXS15352：面板初始化 32 帧 + 整屏 292 帧，**全部零错误，屏上出 8 条彩条**）：

| SCLK | 整屏 240×296×2（142 KB） | 吞吐 |
|---|---|---|
| 20 MHz | 67 ms | 2.01 MB/s |
| **40 MHz**（推荐） | **43 ms** | **3.15 MB/s** |
| 60 MHz | 37 ms | 3.71 MB/s |
| 75 MHz | 39 ms | 3.47 MB/s |

探针侧 Python 基线是 40 MHz 4.22 MB/s、60/75 饱和 ~4.7 MB/s；浏览器侧每帧多一层 IPC，差约 25%。
完整记录（含按交接文档改的 4 处、两个吞吐坑）见 §11.4。ST77916 的验收用 `--panel=st77916` 随时可跑（那边屏没接时跳过）。

---

## 10. 风险与坑（先认下来）

### 10.0 桥页右列 tab 化（2026-10-02）—— 这几条别改回去

1. **`.dockpage` 用 `display:flex`（不是 block）**：里面靠 `flex:1 1 auto` 吃满高度的滚动区
   （命令表 / 脚本文本框 / 回环结果表）只有在 flex 容器里才生效，改 block 就按内容高度塌掉、tab 化白做。
2. **命令表 `table-layout:fixed` + 显式列宽**：auto 布局下 `td{max-width}` **不生效**，
   结果列的长文本会把列宽撑开、把表格顶出横向滚动条（I2C 页实测踩过）。
   改成 fixed 之后**没写宽度的列会平分剩余空间**，所以序号列必须显式给死 26px，
   否则它会分到一大块（I2C 页量到过 233px）。实测本页：`#`26 / cmd56 / 线数52 / addr_len62 /
   addr82 / dummy56 / rx_len56 / **tx auto→749** / 结果180，`scrollWidth === clientWidth`（无横向溢出）。
3. **`refreshButtons()` 是唯一的可用性中枢**，tab 化之后也**不能**改成"只更新可见 tab"：
   隐藏 tab 里的按钮同样得是对的，切过去要立刻能用（它直接改 DOM 属性，与可不可见无关）。
4. **「中止」只对回环自检有效**：擦/写不能中途停 —— 那会把 flash 留在半擦状态，比跑完更糟。
   所以按钮在非回环的忙期保持灰，title 里写明了原因（`renderRunPill` 统一管它的可用性）。
5. **`spi.dock` 是持久化设置，会跨套件污染**：页面套件要先 `delete` 它再 reload，
   真机脚本收尾要把右列拨回「命令表」（I2C 页实测被这个红过两条）。
6. **CDP 截图可能拿到上一帧**：页面在后台时渲染被降频，切完 tab 立刻 `Page.captureScreenshot`
   会拍出上一个 tab 的画面。截图前先 `Page.bringToFront` 并留一拍，顺便打印 `dockTab` 核对。
7. **回环自检的"跑起来再看"会假红**：假探针 8 帧是毫秒级的，`await 60ms` 之后早就跑完了。
   `loopbackTest()` 里 `setBusy` / 胶囊 / 中止按钮都在**第一个 `await` 之前**同步做完，
   所以自测要**点完立刻读**（同一个同步块），不要靠 sleep 去撞。
8. **Flash 卡的「读数据 / 写数据」两窗等高**（用户 2026-10 明确要求）：两个都给 `flex:1 1 0`。
   🚨 **光给 `flex` 是不够的，还必须给「写数据」那行补上和 `.log` 一样的上下 padding/border**：
   `flex-basis:0` 下浏览器按**内容盒**算基准，边框盒再各自加上自己的 padding/border ——
   两个盒子 padding 不一样，"内容高"分到一样、**边框盒就不可能等**。
   实测差 14px（= `.log` 的 6+6 padding + 0.8×2 border），补上之后 168 vs 168 精确相等。
   只补上下不补左右，标签对齐不受影响。
9. **动作按钮别被 `.btnrow>button{flex:1}` 拉伸**：这是全局规则（第 92 行），在 1320px 宽的面板里
   会把 `读一段`/`读测速` 各撑到 **591px**、擦除那行四个控件各 328px（用户："布局是不是有点奇怪？"）。
   flash 卡里改成内容宽（`flex:0 0 auto`），与工具栏那些按钮对齐；`测速量` 那个 label 自带
   `margin-left:auto` 仍然靠右。
10. **参数排一行而不是 2×2**：`读模式 / dummy / 地址 / 长度` 原来是两行网格，读模式那个长下拉
    把 dummy 顶到最右边，看着很散，还白占一行高度。改成四列一行，省下的高度全给下面两个数据窗口。
11. **这一卡的"行距/tab 间隙"是数据窗口的生命线**：控件行最多（工具行 / 参数行 / 提示 / 读行 /
    擦写行 / 写数据行 / 填图案行 / 提示），两个数据窗口只能分剩下的。用户 2026-10 的原话是
    "写数据框，高度还可以高出一行字来" —— 处理办法是**压控件、不是撑那个框**（撑它等于从读数据抢）：
    · 「我确认要擦写」并进擦除行（省 24px）；
    · `#tab-spi #sp-flash-card{gap:4px}`（原来 6px，10 个间隙省 20px）——
      ⚠️ 必须写 `#tab-spi #sp-flash-card`（两个 id）：`#tab-spi .dockpage` 的 (1,1,0) 会压过单 id 的 (1,0,0)，间隙静默不生效；
    · `.row` 行距 3→2px（省 ~14px）。
    实测 820 高的窗口下两个窗口 110 → 136px（**正好多一行**），1600×900 下 176px。
12. **改这一卡的高度后要重新量"两窗等高"**：`.datarow` 的高度补偿（第 8 条）与 `min-height` 是绑在一起的，
    动任一处都可能让两个框差几像素 —— `spi-bus-page.test.mjs` 第 10.0 节就是盯这个的。

### 10.0b 屏页右列 tab 化（2026-10，用户："参考调试器界面，右边部分做成多个 tab，现在有点繁琐"）

同样是 `.docktabs` / `.dockpage` 那套（三个 tab：**刷屏 / 面板初始化 / 读回**）+ 常驻日志 + 运行胶囊。
下面几条是这一页**独有**的，别改回去：

1. **画布必须绝对定位**（`position:absolute; inset:0` + `object-fit:contain`）。
   `height:100%` 在"高度由内容决定"的父级里会退化成 `auto`，而 `<canvas>` 是**带固有比例的可替换元素** ——
   宽度一撑开，高度就按 240:296 反算回去（实测 **730×904**），把整个 tab 页顶爆、下面的控件全被挤走。
   绝对定位之后它不参与布局：盒子多高它就多高。
   **配套**：右侧控制列要 `max-height:100%`（矮窗口里它比整行还高，flex 单行布局下"行的交叉尺寸 =
   最高那个 item 的内容高"，画布会被它连累着一块儿撑出去、压到下面的提示上；实测 730 高的窗口里
   行 235 / 画布 249）。
2. **读回有自己的画布 `#pn-read-canvas`**。`#pn-canvas` 在「刷屏」tab 里，非活动 tab 是 `display:none` ——
   读回要是还往那张上画，就是"读回来了但屏幕上什么都没有"。同理，`#pn-img-sum` 那个摘要也另开了
   `#pn-read-sum`（它原来也在刷屏卡里）。
3. **两个「显示开关」在刷屏 / 读回各存一份、双向同步**（`syncViewSwitches()`）：读回的画面单独占一页，
   翻字节序不该逼用户切回刷屏 tab。切回来时 `drawReadBack()` 会用当前开关**重新解码**缓存的原始字节，
   所以翻开关是"立刻见效"，不是"重新读一遍"。
4. **`display:none` 不会让 `<video>` 的 rVFC 停摆**（与 `document.hidden` **不是**一回事）：
   实测非活动 tab 里 2 s 回调 **50** 次、可见时 **30** 次（`tmp/rvfc-check.mjs`）——
   动画放在被隐藏的 tab 里照跑，所以"动画跟着刷屏一个 tab"只是语义选择，不是被迫的。
   整个窗口被最小化/遮住时仍然不渲染，`anim.js` 里那条告警保留。
5. **`setBusy(true)` 之后到 `try` 之间不许再有能抛的语句**：中间抛出去就走不到 `finally` 里的
   `setBusy(false)`，会话会卡在"忙"上，后面**所有**操作被 `if (s.busy) return` 静默吃掉
   —— 实测少写一行 `const label`，整节重放全空（线上 0 字节、进度行空白），排查了半天。
   三个长操作（刷图 / 重放 / 读回）现在都是"先算好、再 `setBusy`、紧接着 `try`"。
6. **`overflow-y:auto` 只是兜底**：正常情况当前 tab 应当刚好装下，`spi-panel-page.test.mjs` §1b
   对三个 tab 都断言 `scrollHeight - clientHeight <= 1`（1600×1080/900/820/700 四档实测全 0）。
7. **`panel.dock`（停在哪张 tab）+ `panel.logH` / `panel.codeH`（两条分隔条）会跨套件污染**：
   页面套件跑之前先 `delete` 这三个键再 reload（I2C / 桥页都被这类键红过）。
8. **HTML 注释要用 `-->` 收尾**（血泪）：把新加的注释按 JS 习惯写成 `*/` 结尾，注释就没关，
   解析器一路吞到下一个 `-->` —— 现象是"`#pn-read-card` 整个不存在" + init 里
   `$('pn-read-reg').appendChild` 报 null，看着像 JS 崩了，其实是 HTML 吃掉了半页。
9. **折叠按钮（`.foldbtn`）在这一页全部删除**：tab 本身就是显示/隐藏，日志又改成了常驻，
   没有可折的东西（自测里有一条 `#tab-panel .foldbtn === 0` 盯着）。
10. **tab 页里的控件行一律 `flex:none`**（`#tab-panel .dockpage>*{flex:none}`）：
    flex 列布局默认 `flex-shrink:1`，窗口一矮就把"摘要 / 导出"这类行压到几像素 ——
    **字被切掉一半**（用户 2026-10 截图："箭头所指的地方字都被掩盖了一半"，实测 730 高的窗口下
    那一行只剩 **4px**、内容要 22px）。该让位的只有表格 / 画布那两块（单独给 `flex:1 1 auto` +
    `min-height`），真装不下就让 tab 页自己滚。自测里每个 tab 都断言"没有 `overflow:hidden` 的
    子元素被压到内容以下"（`auto/scroll` 的那两块本来就该滚，不算）。
11. **文本框按页高取 20%**（`#pn-code-text{height:20%;min-height:70px;max-height:200px}`）：
    写死 110px 时，730 高的窗口里解析表只剩 139px（约 3 行半）；改成百分比后同一窗口
    表格 166px、文本框 84px，900 高时 ≈ 118px 与原来持平。它本来就自己滚，用户还能拖。

### 10.1 契约层（要回馈固件侧，网页先按实现走）

1. `cs_policy` 注释与实现不符（§2.1）→ 网页下拉按**实现**写，并在文档里记一条"proto.h 注释待订正"。
2. `STATUS` 的 `actual_sclk` / `frames_err` 位置与 `sb_stats_t` 字段顺序不符 → 网页按实现解析；建议固件把两个字段补进 `sb_stats_t` 或改注释。

### 10.2 传输层

3. **一帧不跨包 + 不许填充**（§5.2）——违反的后果是 `frames_err` 涨、数据错位，且**回环测试会"看起来通过"**（写坏后回读也一致），所以打包器要单独自测。
4. **WebUSB 的 `endpointNumber` 不含方向位**（scope 页踩过）：`0x8B → 11/'in'`、`0x0B → 11/'out'`，**同一个号两个方向**，只能靠 `direction` 区分。
5. **同设备有两个 0xFF 接口**（SPI 桥 vs WebUSB 平台接口，后者 0 端点）→ 按"class 0xFF 且有 bulk EP11 双向"认接口。
6. **无取消接口** → 收尾纪律（§5.3）；超时即标脏设备，下次认领前复位端口。
7. **短等待必须走 `pace.js`**（页面不可见时 `setTimeout` 被钳到 ≥1 s）——这条在本仓库是铁律（见 `docs/` 与记忆里的实测）。
8. **跨页签/僵尸认领** → 复用 `probe-bus.js`；新页面必须接入让位链，否则"有时候认领不上"会重现。

### 10.3 硬件/语义层

9. **SPI 桥只在 EVKLite 构建里**（akaLinkPro 构建为 0）：页面对"没有这个接口"要给出明确、可操作的提示（刷 EVKLite 固件），而不是只说"设备没找到"。
10. **P1 固件全轮询**（`tx_dma_cnt` 恒 0）：页面别把 DMA 阈值装成"已在生效"。
11. **全双工必须等长**：回环与传感器读都要注意（不等长拆两帧）。
12. **辅助脚与排针共用**：PA09（TinyUF2 按键）、PA10（板载 LED）、PA00/PA01（UART0）列在表里但默认不选；开 quad 后 PA30/PA31 不能当辅助脚（固件会拒，页面要提前拦）。
13. **IN 环只有 16 槽**：批量刷图时**只有最后一片带 RSP**，否则 IN 流量会拖慢灌数据（固件方案 §7.6 的要求）。

---

## 11. 分阶段里程碑

| 阶段 | 内容 | 完成判据（离线） |
|---|---|---|
| **P1** ✅ 骨架 + 协议层 + 假探针（**已按 §0 第 10 条拆成两页**） | `app/spi/{protocol,transport,mock,session,bus-view,panel-view}.js`、两个标签页、连接/配置/档位/状态、通用帧控制台、回环自检（假探针内自环）、`make test-spi` + `make test-spi-page`、本文件转正 | ✅ Node 79 项 / CDP 页面 41 + 33 项全绿；假探针下"配置→使能→XFER 回环→状态对账"与"按屏套用→STEP 展开"都跑通 |
| **P2** 面板档 + 表 | `panels.js`（含两套内置表 + 提取脚本 + 对账测试）、表格编辑器、位编辑器、导入导出、单发/重放/复位 | 档 1/档 2 的线上字节流金样例逐字节通过；内置表与 C 头文件对账通过；页面自测覆盖重放整表 |
| **P3** 图片 | `image.js`（BMP + `createImageBitmap`）、预览/对齐/裁剪、RGB565、切片发送、进度/速率、内置图案 + 灰阶 | 小图逐字节金样例通过；页面自测：96×96 图切片数/末片 RSP/无 frames_err；预览与"实际下发窗口"一致 |
| **P4** 真机（等板子） | `spi-hw.mjs` + `make spi-hw`、错误诊断打磨、吞吐标定、README/docs 更新 + 截图 + 自测清单 | 回环长度扫描全 PASS（1/2/4 线）；SCLK 逐档记录；有屏时屏能亮 + 整屏刷图计时 |

每阶段一个中文提交；每阶段把新增入口写进 `Makefile`（`test-spi` / `test-spi-page` / `spi-hw`）与 `make check` 的语法检查清单，README 页面表与截图在 P4 一并补。

### 11.1 P1 实施记录（2026-09-29，已完成，未上板）

**落地清单**

| 文件 | 内容 |
|---|---|
| `app/spi/protocol.js` | 帧/HID 0x35/配置块/面板档 的编解码、`packFrames`（一帧不跨包）、`parsePack`（照固件的包解析语义）、`RspStream`（IN 字节流切包）、`RspMatcher`（seq 配对 + 超时 + cancel） |
| `app/spi/mock.js` | 假探针：HID 九个 action 的响应逐字节照固件 + 帧执行（XFER 回环 / STEP 三档展开 / DELAY 非阻塞 / CS/GPIO/RESET/AUX_IN）+ 故障注入（`loopback` / `dropRsp` / `inFull` / `forceStatus` / `disabledAlways`） |
| `app/spi/transport.js` | `WebUsbSpiTransport`（认领 class 0xFF + EP11 双向的接口、多条 IN 在飞、收尾等在飞读回来、认领失败端口复位重试）+ `MockSpiTransport`（同形） |
| `app/spi/view.js` | 页面装配：连接/配置/辅助脚/面板档/使能/状态/通用帧/回环自检/日志/统计 |
| `index.html` `app/app.css` `app/main.js` | 第 8 个标签 `SPI/QSPI 屏`（`#spi`）+ 面板 + 样式；注册 `SpiView`、`onShow`、`summary`；接入 `probeBus` 让位链 |
| `Makefile` | `make test-spi`（纯 Node）、`make test-spi-page`（CDP 真页面）、`make check` 语法清单 |
| 自测 | `tools/selftest/spi-proto.test.mjs`（**79 项**）、`tools/selftest/spi-panel-code.test.mjs`（**71 项**）、`tools/selftest/spi-bus-page.test.mjs`（**41 项**）、`tools/selftest/spi-panel-page.test.mjs`（**53 项**） |

**P1 踩到的四个坑（都已钉进自测）**

1. **状态字的 `err` 不能判断"本次是否成功"**：它是"最近一次错误码"，固件成功后**不清**（`spi_bridge.c` 只在出错时写 `s_last_err`）→ 拿它判 SET_CFG/PIN_CFG 会误报。页面改成 **SET_CFG 后回读对账**（顺带能发现固件把字段夹取走了，比如开 quad 后退掉 PA30/PA31）；自测里也钉了一条"成功写入后状态字里仍留着上一次的 RANGE"。
2. **发送半路失败会制造 unhandled rejection**：`sendFrames()` 里先登记了 N 个在飞请求，若第 1 个包就写失败（没使能 → NAK），后面的请求没人 await，1.5 s 后超时 reject → 页面自检报"整场跑完有未捕获错误"。修法：**登记时就挂 `onRejected`**，并在发送失败时 `matcher.cancel()` 掉本批。
3. **`decodeProfile` 要返回布尔**：否则页面里 `dcActiveHigh === true` 与固件回的 `1` 对不上（`1 !== true`），是个只在断言里现形的坑。
4. **`encodeCfg` 不夹取 `mode`/`bits`**：非法值原样下发、由固件用 RANGE 拒绝 —— 静默改值是最难查的一类问题（这条直接来自 §10.1 的第 1 条）。

**验收口径（本轮）**：`make test`（含 `spi-proto` 79 项）、`make test-spi-page`（41 + 33 项）、`make check` 全过；真机项（回环跳线、SCLK 逐档、实屏）**等板子**，见 §9.3。

### 11.2 拆页记录（2026-09-29，用户反馈"目前这个 web 有点繁重"）

**怎么拆的**：把原来那一页按"**这是通用链路的事，还是调屏的事**"切两半，并抽出一层共享会话。

| 层 | 文件 | 职责 |
|---|---|---|
| 会话 | `app/spi/session.js` | 连接（HID / 数据端点 / 假探针）、`sendFrames`、配置/档位/状态的读写与**回读对账**、统计、日志 ring、`subscribe()` 广播。**不碰 DOM** |
| 桥视图 | `app/spi/bus-view.js` | 桥配置、辅助脚、使能与状态、通用帧控制台、回环自检 |
| 屏视图 | `app/spi/panel-view.js` | 面板档、按屏套用推荐值（`PANEL_PRESETS`）、快捷面板步、复位/显示、只读摘要 |

**为什么共用会话而不是各连各的**：一个 USB 接口/一个 HID 只能被一个程序占用，两页各连一次既反直觉又容易撞"接口已被占用"；
共用之后"在屏页连上、桥页也能发帧"，这跟「串口助手 / 终端」共用串口会话是同一个模式。

**拆页带来的两个新坑（都已修 + 进了自测）**

1. **`session.lastStatus?.enabled` 恒为 `undefined`**：`parseStatusPayload()` 返回的是协议原样字段（`status` 是那个 u32 状态字），
   `enabled` 是 bit0，得用 `statusWord()` 解。后果是桥页"桥还没使能 —— 先点使能"那句提醒**从来没触发过**。
   现在会话上有一个 `get enabled()`，视图与自测都用它。
2. **假探针的延时单位不统一**：`STEP.delay_ms` 记的是毫秒、`DELAY` 帧记的是微秒、`RESET` 又是毫秒，
   自测里拿 `delays.includes(120)` 对账时才发现。现在统一记**毫秒**（`DELAY` 帧的 µs 在入口处除以 1000）。

**顺带确认的既有问题**：`make test-ui` 里「RTT Viewer：目标类型下拉（SWD / RISC-V）」那一项失败
（切 RISC-V 后 `r-range` 没换成 `0x01240000`，停在 `0x00080000`）—— 用 `git stash` 把我的改动摘掉重跑**同样失败**，
与本次拆页无关，待单独处理。

### 11.3 P2 + P3 实施记录（2026-09-29：面板初始化大框 + 图片/图案刷屏）

**新增模块**

| 文件 | 内容 |
|---|---|
| `app/spi/panel-code.js` | 初始化代码解析器：`parsePanelCode()`（C 数组为主 / 顺带纯文本行与 JSON）、`rowsToItems()`（表 → STEP 帧，只有末条带 RSP）、`rowsToC/Json/Text` 导出 |
| `app/spi/panels-data.js` | 内置两套表的**原始 C 文本**（由 `tools/dev/extract-panel-tables.mjs` 从 `E:\esp-idf-wsh` 的 `axs15352_init_cmds.h` / `st77916_init_cmds_ch32.h` 提取；带 `expect` 供对账） |
| `app/spi/image.js` | 18 种内置图案、`composeImage()`（适应/铺满/拉伸/原始）、`rgbaTo565()`（高字节在前 + R/B 交换 + 电平）、`parseBMP()`（16/24bpp，含 BI_BITFIELDS 掩码）、`alignWindow()`、`windowItems()`、`pixelItems()`、`imageToFrames()` |
| `tools/selftest/spi-panel-code.test.mjs` | **71 项**：解析器 + 与源 C 头文件对账 + 图片逐字节 + 整屏刷端到端（527 片喂给假探针） |

**页面（`#panel`）**：主区两块大卡片（可折叠）—— 「面板初始化」（大文本框 + 载入示例/文件 + 解析并预览 + 表格 + 重放/单发/导出）、「图片 / 图案刷屏」（图案 chips + 拖放 + 预览 + 缩放/开窗/屏幕/R-B/电平 + 刷这一张）；左栏补了「复位 / 显示」。

**这一轮踩到的坑（都进了自测）**

1. **BMP 的像素是 BGR 顺序存的**：我手搓测试 BMP 时按 RGB 写，结果"红绿蓝白"全反了 —— 自测里现在直接拿红/绿/蓝三色钉住。
2. **没有外层数组壳的 C 片段解析不了**：我们自己 `rowsToC()` 导出的就是 `{...},\n{...},` 这种形态，而解析器原来只会剥"`= { ... }` 外壳"。
   现在判据换成"最外层括号的顶层分隔里有没有以 `{` 开头的段"（有 = 容器，钻进去；没有 = 整段就是元素列表），导出 → 再解析的往返因此进了自测。
3. **行号差一行**：按"段起始偏移"算行号时没算段内前导空白里的换行 → 报错行号整体偏 1（排查时最误导的一类）。现在按"第一个非空白字符"算。
4. **解析纪律**：自报长度与实际字节不符 → 用实际字节 + **告警**；认不出的行 → **报错带行号与原文**（宁可报错也不猜）。
5. **几何要跟着"套用推荐值"走**：套用 ST77916 时把预览的屏幕几何一起切到 360×360，否则切片数/字节数全按错的屏算（页面自测里显式钉了这条）。
6. **预览要显示"发出去的样子"**：预览走一遍 `composeImage → rgbaTo565 → rgb565ToRgba`，所以 R/B 交换与电平的效果在预览里就能看出来，不用等屏。

### 11.4 真机验收记录（2026-09-29：AXS15352 屏点亮）

探针侧完工并给了交接文档（`akaLinkPro/docs/web-handoff-spi-bridge.md`）后，真机一次跑通：
**面板初始化 32 帧 + 整屏 292 帧全部零错误，屏上出现 8 条彩条**。

**按交接文档对齐的 7 处**（前 4 处是"不改就可能不亮/很慢"的）

| # | 改动 | 依据 |
|---|---|---|
| 1 | **档 1 刷像素改成"RAMWR 命令帧（DC=0）+ 像素片全程 CS_HOLD、末片才释放"** 的管道化写法 | 交接文档 §5 + `tools/panel_show.py:133-143`（原先我每片自成 CS 窗口且不发 RAMWR） |
| 2 | **自动补 `0x36 MADCTL=0x00` + `0x3A COLMOD=0x55`**（排在厂家序列之前，只影响重放/导出，不改用户贴的文本） | 厂家表里没有这两条，**缺了全黑**（文档明确） |
| 3 | 字节序给了 **高/低字节在前** 开关，与 **R/B 交换** 并存，提示"颜色不对只翻一个" | 两处交换会互相抵消（0x08 + 低字节在前），红蓝看着一样、绿色偏蓝 |
| 4 | **写请求并发**（`outInFlight`，默认 8）：1.47 → **3.15 MB/s** | 串行 `await transferOut` 时每片要等一个完整 USB 往返（真机每片 ~120 µs 开销） |
| 5 | 显示 `last_ticks`（"单笔事务 xx µs"） | 新增的 `STATUS` 第 10 个字（MCHTMR @24 MHz） |
| 6 | 配置块补上 `module_clk_hz`（解码保留，未做 UI） | 新增的"调板旋钮"，0 = 自动 |
| 7 | pad 表标注 `PY00/PY01` v1 不支持；发送前未使能会警告"bulk OUT 不武装，写会 NAK" | 文档 §4.3 / §7.1 |

**没做的**：固件的 `DBG(10)` / `PINTEST(11)` / `WIGGLE(12)` 三个诊断 action —— 用户明确说那是研发调板用的，对外交付不加（协议层只留一行注释说明号段被占）。

**真机数字**（142 KB 整屏，240×296×2，档 1 @40 MHz 推荐档）：

| SCLK | 实测 | 吞吐 | 单笔事务 |
|---|---|---|---|
| 20 MHz | 67 ms | 2.01 MB/s | 156.5 µs（贴线速） |
| 40 MHz | 43 ms | 3.15 MB/s | 79.9 µs |
| 60 MHz | 37 ms | 3.71 MB/s | 58.4 µs |
| 75 MHz | 39 ms | 3.47 MB/s | 47.5 µs |

**又一个"数字骗人"的坑**：验收脚本最早是从页面**累积日志**里正则取"刷图完成：… ms"——
日志是累积的，于是每一档都取到**第一次**那行，四档显示一模一样的 76 ms。
现在页面把最近一次刷图记成 `panel.summary().lastRun`（ms/bytes/slices/实际 SCLK），脚本读它 —— 客观、可复现。

**顺带修的体验问题**：「连接数据端点」以前每次都弹设备选择框（哪怕早授权过）。现在按钮先试**已授权设备**，
没有才弹框 —— 自动化脚本也因此不用再应答弹框。

### 11.5 页面功能流程验收（2026-09-29：一次通过，零错误）

用户指定的顺序，写成可复现脚本 `tools/selftest/spi-hw-flow.mjs`（`make spi-flow`）：

```
打开 web → 连接探针 → 初始化屏 → 发图 ×3 → 再次初始化屏 → 发图 ×3
```

**严格模式**：任何一步出错立刻停（不再往下跑），并打印现场（页面未捕获错误 / `frames_err` / err 级日志 /
最近一次刷图 / 两页日志尾部）。判"出错"的三条口径都取**增量**：
① 页面未捕获错误必须始终为 0；② 探针侧 `frames_err` 每步不得增长；③ 页面日志里 err 级新条目不得增长。

实测（AXS15352 @40 MHz，探针 + 真屏）：

```
① 打开 web ✓          页面错误 0
② 连接探针 ✓          HID + 数据端点（接口 4）
③ 配置就位 ✓          档 1 · 40 MHz · 表 30 条 · 自动补 0x36/0x3A
④ 初始化屏（第一次）✓  重放 0..31 完成（2 包 / 109 ms）
⑤ 发图 ×3 ✓           色条 8 / 混色卡 / 棋盘 16px：各 289 片 138.8 KB，43~65 ms，坏应答 0
⑥ 再次初始化屏 ✓      重放 0..31 完成（2 包 / 107 ms）
⑦ 发图 ×3 ✓           渐变 / 对半红绿 / 4px 网格：44~52 ms，坏应答 0
11 步全完成，16.5 s　累计 frames_ok=2140　frames_err=0　页面错误=0　err 级日志=0
```

吞吐在 2.08~3.17 MB/s 之间波动（并发写的抖动，同一档重复跑 ±10%）；关键是**反复初始化 + 连续刷图不累积错误**。

---

## 11.6 增补记录（2026-10：引脚可配性核实 + 手写多帧 DSL + 外接 NOR Flash 卡）

用户四条反馈：① 引脚下拉这么多选项，probe 到底能不能配？②「简单帧 / 单引脚」去掉；
③ 加一个"手写多条帧语句"的面板（像屏页的初始化面板那样）；④ 加 SPI/QSPI flash 专用测试面板
（读 ID / SFDP / 烧录 / 读写测速，1 线与 4 线都要）。

### A. 引脚可配性（逐行读固件后的结论，回答①）

| 层 | 能否配 | 固件事实（`spi_bridge.c` / `boards/hpm5301evklite/pinmux.c`） |
|---|---|---|
| **SCLK / MOSI / MISO** | ❌ 写死 | `pinmux.c` 的 `init_spi2_bridge_pins()`：SCLK=PB11、MISO=PB12、MOSI=PB13；四线时 DAT2/DAT3=PB14/PB15（CS=PB10）。协议里没有改这四根的字段 |
| **CS 从哪来** | ✅ 4 档 | `cs_policy`：0=PB10 GPIO（固件每帧自动开 CS 窗口）／1=用「CS 辅助」那根脚／2=手动（只有 CS 帧能拉放）／3=硬件 CS0。`cs_policy=3` **不支持面板档 1**（需要"一个 CS 窗口内翻 DC"） |
| **辅助脚 DC/RST/CS辅助/BL/TE** | ✅ 真配 | 协议里是 pad 索引 `1..13` → IOC pad 表（`:280-295`）；使能时 `sb_apply_aux_pins()` 真把它们配成 GPIO：DC 输出=0、RST 输出=复位无效电平、BL 输出=**关背光**、TE 输入+上拉；CS 辅助在 `sb_spi_hw_init()` 里配成输出、空闲=无效电平 |
| **有效电平** | ✅ 真配 | `pad_active_low` bit0 DC/bit1 RST/bit2 CS/bit3 BL：GPIO 写入取反（`:1399`）、CS 断言极性（`:391`）、RST/BL 初值（`:1831`） |

生效时机：**使能那一刻应用**；已使能时可用 `PIN_CFG(5)` 立刻重配。
`ENABLE 0` **不还原引脚**（PB10 会一直留在 SPI 状态直到探针重启，不影响 RTT/CDC）。

**固件真的会拒的三种选择**（`sb_pad_ok` + `sb_cfg_validate`，`:1754-1816`）：`PY00/PY01`（表里写死 0，v1 不支持）／
任何撞 PB10~PB15（SPI2 固定脚）或 PA30（被 Q1 短到地）的辅助脚。→ 页面下拉现在把这些项**灰掉**并在提示里写明原因，
但**只是提前告知**：真发下去固件仍会回 `RANGE(4)`，那是最后一道闸（回读对账会把它暴露出来）。

> 另外核实到一处固件细节：`PIN_CFG(5)` 的 `req[6]`（有效电平）**固件没读**，只用了 `req[4]=line` 与 `req[5]=pad`。
> 本页走的是整块 `SET_CFG`（带上 `pad_active_low`），不受影响；但用 `PIN_CFG` 的脚本别指望它能改极性。

### B. 通用命令：表格 + 文本两条路（回答③）

**① 命令表**（`#sp-cmd-card`，一行一条，固定 10 行，字段就是协议字段）：
`cmd / 线数 / addr_len / addr / dummy / rx_len / tx 数据`。空行不发；写了 `addr_len>0` 就自动带地址相位
（地址按 `addr` 里写的号）；**每行都带 RSP** —— 多花 8 B 应答，换来"哪一行出错"在结果列直接看得见。
批量选项只有两个：`整段保持 CS（末条释放）`（老器件要连续时序时用）与 `速率路径（自动/轮询/DMA）`。

**② 文本面板**（`#sp-dsl-card`）= `app/spi/frames-dsl.js`（纯函数）+ 载入/导出。
语法刻意长得像协议本身，屏幕上的字与协议字段一一对应：

```
0x11                              裸字节 = 一条 cmd 帧（最常用）
xfer cmd=0x9F rx=3                通用 XFER；xfer 可省略（直接 cmd=… 开写）
{0x9F, 1, 0, 0x000000, 0, 3, NULL},        C 表行 —— 列序与上面那张命令表完全一致
{0x02, 1, 3, 0x001000, 0, 0, (uint8_t[]){0xAA, 0xBB}},
step cmd=0x11 delay=120           面板初始化步（tx= 是参数）
delay 120ms / 500us / 1.5s        延时（裸数字 = µs）
gpio DC 1                         辅助脚写（按「有效电平」自动取反，与固件一致）
cs low | cs high                  片选：low = 占用，high = 释放
reset 10 120                      复位脉冲（拉低 10 ms + 等 120 ms）
ping | auxin                      保活 / 读辅助输入
```

XFER 的 key：`cmd= tx= rx= addr= addrl= dummy= lines=`；开关（不带值）：`rsp cs_hold cs_off cs_aux poll dma addrquad token dc dc1 dc0`。

**三条自动规则**（省得每行都写一遍）：① 写了 `cmd=` 自动加 cmd 相位、写了 `addr=`/`addrl>0` 自动加地址相位；
② `rx>0` 的帧自动带 RSP（固件规定读数据必须带，`spi_bridge.c:1312`）；③ 整段一条 RSP 都没有时给末帧补一个。

**错误在解析期就拦**（带源行号 + 原行文本 + 原因），**有错就一条都不发** —— 否则固件回一个 `RANGE`，
用户只能猜是哪一行的哪个字段。24 条错误用例在 `spi-frames-dsl.test.mjs` 里咬着。

**载入 / 导出**：读 `.c/.h/.txt/.json`（JSON 若是本站导出的形状会自动转回可读文本）；
导出 **C 表**（列序 = 命令表，能直接贴回来）、**JSON**（保真，含各帧的 flags）、**归一化文本**。
三条导出都做了"导出 → 回灌 → 帧字节逐条一致"的往返自测；C 表放不下的帧类型（delay/gpio/…）会**写成注释**留在文件里，不静默丢。

### C. 外接 SPI NOR 卡（回答④）

**板上那颗 NOR 够不着**：它在 XPI0 的 PX 专用脚上（`BOARD_APP_XPI_NOR_XPI_BASE = HPM_XPI0`），
而且固件就跑在它上面 —— 所以测的必须是**外接**到 J3 的 flash：

```
CS   ← J3[26] PB10      SCLK ← J3[13] PB11
IO0  ← J3[28] PB13      IO1  ← J3[27] PB12
IO2  ← J3[10] PB14      IO3  ← J3[8]  PB15（四线才接）
VCC/GND 按模块电压，WP# 与 HOLD# 上拉到 VCC
```

**不用改固件**：通用 `XFER` 帧自带 `cmd/addr_len(0..4)/dummy(0..4)/tx/rx/addr` 与 `tcfg` 的线数(1/2/4)、
地址相位四线开关 —— RDID(0x9F)、SFDP(0x5A)、读(0x03/0x0B/0x3B/0x6B/0xEB)、WREN(0x06)、擦除(0x20/0xD8/0xC7)、
编程(0x02/0x32)、读状态(0x05/0x35) 全能表达。**四线读不需要切 qspi 面板档**（那是屏专用的"每片带 0x32 + 24 bit 地址"），
raw 档 + 帧内 `lines=4` 即可。

**连续读是测速的关键**：一帧最多 492 B 数据，大块读必须拆帧。拆法是首帧发 cmd+地址、**后续帧 `cmd_en=0` + `CS_HOLD`**、
末帧 `CS_OFF` —— CS 一直摁着，flash 内部地址计数器自己往前跑。固件侧已确认接受 `cmd_en=0` 且 `rx_len>0` 的帧
（`:1287-1315` 的校验只看线数/长度/RSP，不要求 cmd 相位）。

**dummy 自动标定**：协议文档写"dummy 周期 0=无 1~4"，固件却写 `dummy_cnt = dummy-1`（`:897`），
在没上板标定过之前不猜 —— 「读 SFDP」先按当前 dummy 读 8 B 头，签名不是 `"SFDP"` 就自动试 0~4，
命中后把结果写回面板上的 dummy 输入框。

**面板默认值与联动（2026-10 用户现场定的口径，改这几处前先看）**：

- 读模式默认 **READ 0x03**（1 线、不要 dummy）—— 以前默认 QUAD I/O 0xEB，一上来就得先解决 QE 位和四线接线，
  容易"读不出东西"就卡在第一屏；
- dummy 默认 **0**，且**切换读模式会自动带出该模式的默认值**（0x03→0，0x0B/0x3B/0x6B/0xEB→1）；
  手动改过不会被覆盖，只有再次切换模式才重新带出默认值；
- **dummy 的单位是"8 个时钟拍"**（dummy=1 → 8 拍；既不是 bit，也不是单拍）：JESD216 的 `0x5A` 要 8 拍 dummy，
  实测 dummy=1 正好对上签名 —— 这条是**上板标定**出来的（协议文档只写"周期 0=无 1~4"）；
- 「读 SFDP」**只出原始 256 B**（JESD216 规定 SFDP 是 256 B 只读区），页面上不再做版本 / 参数表 / BFPT 的解读；
  `flash.js` 里的 `parseSfdp` / `parseBfpt` / `dumpDwords` 保留给离线分析与自测用，页面不再展示；
- 「读数据」与「写数据」两个窗口**等高**（150 px）—— 以前一个高一个矮，看着别扭。

**擦写有闸**：三个破坏性按钮（擦除 / 写+校验 / 写测速）在勾上「我确认要擦写这颗 flash」之前是禁用的；
整片擦除与写测速另有一次 `confirm()`。写完**自动回读校验**（不验的"成功"是假的）。

**页与页之间必须等 `tPP`**：NOR 在 BUSY 期间**会忽略后续命令**，一口气把两页塞下去第二页就静默丢了。
`programItems()` 因此在页间插一条**有序的 `DELAY` 帧**（固件侧非阻塞，延时期间后面所有帧排队等它），
一个 batch 就能灌完，不用主机来回轮询。默认 3 ms，面板上可调；延时太短时回读校验会当场发现。

### D. 假探针里的器件模型（`FlashDevice`）与一处真实性修正

`flash.js` 里的 `FlashDevice` 是"一颗忘了就报错的 NOR"：WEL/BUSY、**编程只能 1→0**、跨页报错、
QE=0 时拒四线读、擦除/编程时长用注入时钟推进。假探针缺省就挂一颗 W25Q128（`flash:false` 可关），
所以整张 flash 卡在**没有硬件**时也能跑通、也能被页面测试咬住。

同时修了假探针一处与固件不符的地方：**IN 环满不是"挤掉最老的应答"**。固件在 `sb_in_alloc()==NULL` 时
是 `return;`（**不消费这一帧**，等主机取走数据，`:1562-1568`）—— 固件从不丢应答。
照原来那样模拟，一包 25 条带 RSP 的读帧（25×20 B 正好一包）会在假探针上凭空丢 9 条，
"读测速"在离线环境里假失败而真机不会。现在假探针按固件语义**暂停消费**，并把状态字 bit3（IN 流控）点亮。
另外 `MockSpiTransport` 改成**每写一个包就排空一次应答** —— 真主机是"一边写 OUT、一边有几条 IN 读在飞"，
只在 3 ms 定时器里排会让上面的假失败重现。

### E. 本轮自测数字

| 套件 | 结果 |
|---|---|
| `make test-dsl`（新增） | 124 通过 / 0 失败 |
| `make test-flash`（新增） | 66 通过 / 0 失败 |
| `make test-spi` | 79 通过 / 0 失败 |
| `make test-spi-page`（桥页 84 + 屏页 54） | 138 通过 / 0 失败 |
| `make check`（含两个新模块的语法检查） | 通过 |
| `make test`（全套离线） | 全绿 |

**还没做**：文件级"整片烧录"（选 .bin → 擦 → 按页写 → 整片回读校验 + 进度条）。
本轮的"写 + 校验"一次最多 4 KB，够验证链路与 NOR 的脾气；整片烧录等外接 flash 接线跑通后再加。

### F. 右区改版（2026-10，用户："右边面板区这个布局好丑啊"）

原方案是 `.spcols` 两列（左 XFER 表单 / 右三张卡），在 1078px 窗口下会塌成一列、卡片互相挤。
改成 **`.busstack` 单列 4 块**，每块可折叠，整列自己滚动、日志钉在底部：

| 顺序 | 块 | 内容 |
|---|---|---|
| 1 | 通用命令表 | 10 行 × (cmd/线数/addr_len/addr/dummy/rx_len/tx)，行内结果列 |
| 2 | 通用命令（文本） | DSL + C 表 + 载入/导出 |
| 3 | SPI / NOR Flash | 读 ID / SFDP / 状态 / 读一段 / 读测速 / 擦除 / 写+校验 / 写测速 |
| 4 | 回环自检 | 长度扫描表 |

同时**撤掉**通用帧表单里的 `设 DC` / `DC=1（数据）` / `用辅助 CS` / `0x69 token` 四个勾选项
（协议层与 DSL 都还支持，只是不摆在通用口上）—— 用户的原话："通用 cs 区域，不是点屏的，
是用来驱动一些 spi 小模块的"。

**第二眼的三处收拾**（用户看完截图提的）：

1. **顶栏那条"通用帧：bulk OUT 0x0B 发 → IN 0x8B 收"整行删掉**（它只是在解释协议，白占 30px）。
   `清空日志` 改成**浮在日志右上角**（复用屏页的 `.logclear` 那套），日志区因此长高了一截。
   → 牵出一个 CSS 细节：`.log{height:30%}` 是相对**父容器**算的，所以桥页的日志必须套一层
   `#sp-logbox`（`height:30%` 落在它身上，`.log` 自己 `height:100%`），否则父高为 0、日志直接塌掉。
2. **`tx 数据` 收窄、省下的宽度给「结果」列**（第二眼：用户说"数据区域太短了，结果区域太宽了"——
   那是**只固定一边**的锅：tx 写死 148px + 结果吃剩余，宽窗口下结果就失控）。
   现在的口径是 **tx 跟着窗口伸缩、结果固定 180px**：1155px 窗口下 tx≈243 / 结果 180，
   1099px 下 tx≈155 / 结果 180。要再调就调第 9 列那一个数，别去动第 8 列。
3. **"刷新后只剩一张空表"**：命令表 10 行在 580px 高的窗口里高 310px，而中列可视区只有 287px ——
   它把整列**占满**，另外三块 `visible: 0`（用户："为什么页面一刷新变成这样？"）。
   三处一起改：① 表格自己限高（`#tab-spi .scroll.cmdscroll{max-height:146px}`，约 6~7 行，**表头 sticky**）；
   ② 表下那句说明压成一行；③ 日志从 30% 降到 24%。结果：命令表 238px、日志 105px、中列可视区 318px，
   **下一块的标题露出 70px** —— 一眼就知道下面还有东西。
   ⚠️ 那个 `max-height` 必须写成 `.scroll.cmdscroll`（两个类）：`.scroll{max-height:200px}` 在本文件里
   **排在后面**，同优先级反盖单类规则 —— 第一版就这么静默失效（量出来还是 200px），
   再加上探针用了同一个 URL（只有 `#spi` 没有 cache-buster）**根本没重新加载**，白测一轮。
4. **"滑条能左右拖但什么也不动"的真因**：`.tx` 这个类是 `width:100%;flex:none`，
   放到 flex 行里（`<span>写数据</span><textarea class="tx">`）就会**比容器宽出一个 label 的宽度**，
   于是 `overflow:auto` 的 `.busstack` 冒出一条只有 67px 行程的横向滑条。
   修法：`#tab-spi .row>.tx{width:auto;flex:1 1 auto;min-width:0}`。
   顺手把 `#sp-dsl-text` 改成 `white-space:pre-wrap; overflow-x:hidden`（贴长行/C 表时换行，不再横向滚）。
   排查手法值得记：**遍历 `#tab-spi *` 打印 `scrollWidth - clientWidth`**，一眼就能定位是谁在溢出
   （一次就抓到 `label.row` 的 80px）。

### G. 🚨 开发环境的坑：CDP 截图的视口覆盖会**留在用户正看的那个窗口上**

现象（用户 2026-10 现场："刷新后还是这样啊，分辨率不对吧"）：页面只渲染在窗口左上角一小块，
右边和下面是**黑的**，**刷新也不消失**，看起来像"分辨率不对"。

真因：截图/探针脚本里的 `Emulation.setDeviceMetricsOverride({width, height, deviceScaleFactor:1, mobile:false})`
**会一直生效到被清除**，而且它把 DPR 钉成 1。本机屏幕缩放是 125%，窗口 1374×728 物理像素 = 1099×582 CSS 像素；
覆盖一设（1099×582 **物理**像素），页面就只占窗口的 80%，其余留黑。
用户看到的那个窗口正是 `--remote-debugging-port=9333` 的调试 Chrome（Makefile 的 `page-prep` / `make open` 起的那个），
所以"我截图"和"他看页面"是同一个窗口 —— 刷新当然救不回来，只能从 CDP 侧清：

```js
await send('Emulation.clearDeviceMetricsOverride');   // 脚本收尾**必须**调用
```

教训两条：
1. 任何临时截图脚本，`setDeviceMetricsOverride` 之后**必须**在 `finally` 里 clear（仓库里 `tmp/reset-page.mjs`、
   `tmp/verify-ver.mjs` 早就是这么做的，我这次漏了）；
2. 只是想看真实窗口就**别设覆盖** —— 直接 `Page.captureScreenshot` 拿到的就是当前窗口的样子
   （`Page.getLayoutMetrics().cssLayoutViewport` 可以核对 CSS 视口）。

---

## 11.7 屏页改版（2026-09-30：刷图置顶 + 解析表 ×3 + 字节→位 开关板）

用户口径（原话）：
1. 图片/图案刷屏 panel 调到**最上面**（最常用，要顺手），并且**去掉收起**；
2. 面板初始化**调到下面**；
3. 面板初始化里那张"一条一条的"表**高度 ×3**，并且"参考初始化命令的编辑方式：**带标题 index 索引，
   每个 byte 可以展开为二进制 bit 解析**"（补充："点击后弹出二进制 bit，每个 bit 可以 toggle 它，
   改完后那个 byte 就改了"）；
4. 这样一来一屏放不下 ⇒ 主区**右边加滚动条**。

落地方式：

| 项 | 做法 | 钉住它的自测 |
|---|---|---|
| ① 顺序 + 去收起 | `index.html` 里把 `#pn-img-card` 挪到 `#pn-code-card` 前面，legend 里不再有 `.foldbtn`；`.main>fieldset{flex:0 0 auto}`（按自然高度排，不再三块弹性挤压） | `spi-panel-page.test.mjs` §1b |
| ③ 表 360px | `#pn-code-wrap{height:360px}`（原来只有 120px 下限）；表自己滚（`.scroll`），卡片跟在后面 | §1b（量到 360±2） |
| ④ 右列滚动 | `#tab-panel .main{overflow-y:auto;overflow-x:hidden}` —— 侧栏本来就有自己的滚动条，两条互不干扰 | §1b（`scrollHeight > clientHeight` 且整页无横向溢出） |
| 日志默认展开 | `#pn-log-card` 不再带 `folded`（刷屏/重放完第一眼就要看它有没有报错），按钮写「收起」 | §1b（`logH > 100`） |
| **表头吸顶** | `#pn-code-tab thead th{position:sticky;top:0;background:var(--bg2)}` —— 表头里挂着**字节序号标尺**，表一滚尺子就没了（用户："往下拉表头就上去了，看不到 byte 索引了"）。配套：这张表改 `border-collapse:separate`（collapse 下 sticky 表头的下边框会留在滚动区外），用 `box-shadow` 补分隔线；`z-index:3` 压住行里的输入框 | §1b（滚到底表头仍贴容器顶，偏移恒 1px） |
| ③ 字节编辑 | **每格一个参数字节**（`input.bx`，直接敲十六进制）+ 表头**字节序号标尺**；点格子开位开关板 | §5b（21 项） |
| 纯函数 | `app/spi/panel-code.js` 新增 `byteBits/bitsByte/toggleBit/bitsText/bitWeight/BIT_NAMES/setRowByte` | `spi-panel-code.test.mjs` §D |
| UI 控制器 | `app/spi/bit-editor.js` 的 `BitPopover`（`position:fixed`，滚动时自己跟；Esc/点别处/「完成」都能关） | §5b |

### 字节编辑：**照 `tools/bmp_sender.html` 重做**（用户 2026-09-30："这样不好用，参考那个网页"）

第一版是"每个字节一个小胶囊按钮，点开弹 8 个小勾选框" —— 能用，但改一个值要点三次、位名挤在
两列网格里看不清。参考页（`E:\esp-idf-s31\projects\spi_lcd_bmp\tools\bmp_sender.html`）的做法明显更顺手，
现在整套照它来：

| | 参考页怎么做 | 本页落地 |
|---|---|---|
| 表格单元格 | 每格一个 `<input class="bx">`，**直接敲十六进制**（值就在格子里） | 同款：`#pn-code-body input.bx`，命令字节是 `input.bx.cmd`（只编辑），参数字节点一下开位开关板 |
| 表头 | 数据列带**字节序号标尺**（0 1 2 3…，跟最长那行生成） | `#pn-code-ruler`，`span` 宽 25px 与格子同宽、同字体（等宽），所以能对齐 |
| 位开关板 | **8 个大方块横排**：上 `bit7`、中大字 `0/1`、下 `权重`；点一下翻转 | 同款 `.bitpop .bit`（47px 宽，`on` 高亮、`chg` 黄框标"和原值不同"） |
| 快捷键 | 清零 `00` / 全置 1 `FF` / 逐位取反 / **恢复原值** / 完成 | 同款五个按钮（`data-bit="zero|ones|inv|orig|close"`） |
| 脏标记 | 行指纹与原表比：`tr.dirty` + 输入框变色 + 行尾「改回」 | 同款（`fingerprint(row)` 与解析时的 `baseRows` 比；行尾多一个「改回」） |
| 定位 | `position:fixed` + `scroll/resize` 时 `lcdBitPos()` 重新定位 | 同款（`reattach()` 在整表重绘后把锚点找回来） |

三条**语义约定**（用户会踩，所以写进注释与自测）：
1. **改的是"这份步骤表"，不回写文本框** —— 重放/导出用改后的值，上面贴的原文一个字都不动
   （原文是用户的资产，页面不偷偷改它）；想丢弃改动就点「解析并预览」（按原文重建）或行尾「改回」（只还原那一行）；
2. 自动补的 MADCTL/COLMOD 两行**同样可编辑**（它们本来就是要发出去的字节）；
3. `setRowByte` **必须换一个新的 `Uint8Array`**：`REQUIRED_PREFIX` 的 `data` 是模块级共享常量，
   原地改会把"出厂值"一起污染（自测里专门钉了这条）。脏不脏**用指纹比**，不记粘住的 flag ——
   改成别的再改回原值，那一行就该自己变干净。

> 位名只给**有把握**的两条命令（0x36 MADCTL / 0x3A COLMOD，MIPI DCS 常见排法）；其余命令只显示
> bit7…bit0 与位权 —— 猜错位名比不标更糟。
>
> ⚠️ 参数列**不折行**（折了标尺就对不上）：字节多的行（AXS15352 那条 28 字节的）会让表格自己横向滚，
> 这与参考页的 `.cmdwrap` 是同一个取舍。

---

## 11.8 动画 / 视频（2026-09-30：逐帧整屏刷，先不做局部开窗）

用户需求："我想能够播放一个动画或视频，就是解码后一帧一帧的发" → 定了 **A 路线**（浏览器原生解码 + 发送驱动），
**先不做局部刷新**，验收屏 = AXS15352。

**为什么不是"更高的解码效率"**（真机数字，见 §9.3 与 akaLinkPro `web-handoff-spi-bridge.md`）：
一帧 240×296×2 = **142 KB**、360×360×2 = **259 KB**；链路实测 **3.15 MB/s（浏览器 @40 MHz）**、
60/75 MHz 四线也**饱和 ~4.7 MB/s**（瓶颈是"每帧一次 bulk 写"的包速率 ≈9.5k 包/s，不是 SCLK）。
⇒ 帧率上限 **AXS15352 ~23 fps / ST77916 ~13 fps**；而解码 + 缩放 + RGB565 打包只要 **1~3 ms/帧（<5%）**。
换 WebCodecs / 预转裸帧流省不下这一档，还要背依赖（ffmpeg.wasm 更是要 COOP/COEP，Pages 给不了）。

| 落地 | 在哪 |
|---|---|
| 播放器 | `app/spi/anim.js`：`PanelAnim`（源 → 抓帧 → `frameItems` → `session.sendFrames`） |
| 提交粒度 | `protocol.batchPacks()` + 屏页「攒批」旋钮：一次 `transferOut` 带 8 KB（16 片）——**见 §11.10**，它把"每帧 290 次调用"压到 11 次 |
| 摆放映射 | `fitRects()`（与 `image.js` 的 `composeImage` 同语义，交给 canvas 缩放：视频缩小要平滑，逐像素最近邻只对静图有意义） |
| 一帧的帧序列 | `frameItems()`：`CASET/RASET` +〔档 1 的 RAMWR〕+ 像素片 —— **与「刷这一张」同一条路**；"帧头"三条按窗口缓存复用 |
| UI | 图片/图案刷屏卡片底部一行：选择文件 / 播放到屏 / 停止 / 循环 + 源片段预览 + 状态行（实测 fps、KB/s、最后帧 ms、丢帧） |
| 视频源 | `<video>` + `requestVideoFrameCallback`（原生解码、硬件加速，零依赖） |
| 动图源 | `ImageDecoder`（GIF / APNG / 动画 WebP，逐帧解码 —— 发送完一帧再解下一帧，天然不积压） |

**四条设计纪律**（都写进 `anim.js` 的注释，自测 §9b 钉住）：
1. **发送是节拍器**：解码比发送快就**丢帧**（`MAX_QUEUE = 4`，队列满连抓都不抓 ⇒ `stat.dropped`），
   绝不按"视频帧率"无条件灌 —— 那样只会在 USB 队列里堆延迟，越播越滞后；
2. **背压靠暂停播放**：队列满 → `video.pause()`，快空了 → `play()`；
3. **一帧一次 `sendFrames`**（串行，不并发）：并发调用会让两帧的包交错到达，探针按到达顺序执行 ⇒ 花屏；
   每帧只有 RAMWR + 末片要应答（2 次 RSP/帧）；
4. **UI 让出主线程**：每 4 帧 `await setTimeout(0)`，否则 292 帧/帧的循环会把页面按钮冻住。

> 顺手修掉一个真 bug：`sendFrames` 被 `shouldStop`（停止/中止）打断时，**后面没发出去的帧永远等不到应答**，
> 那些 `await` 会一路挂到 `timeoutMs`（动画里 8 s）—— 表现就是"点了停止好几秒没反应"。
> 现在中止时立刻 `matcher.cancel()` 掉本批剩余的等待（`session.js` 的 `sendFrames`，对所有调用方都有益）。

**实测（假探针，本机）**：96×120 的 24 帧彩条 WebM → 播放 2.4 s 发 **28 帧**（8176 个协议帧、零错误、
3885 KB）→ **11.6 fps / 1.6 MB/s**；PNG 单帧循环 208 帧零错误。真机上按链路 3.15 MB/s 算应约 **20 fps**
（假探针每帧要 JS 展开 292 帧，比真固件慢）。

**下一步（想做更快时，按性价比）**：① **局部开窗**（每帧只发与上一帧不同的包围盒，按面积比提升帧率）；
② 在飞写 8→16；③ 60/75 MHz 档（1 线档有收益）；④ 接 TE 引脚"等 TE 再发下一帧"消撕裂。

---

## 11.9 示例素材 `samples/anim/`（2026-09-30：六个"看什么"明确的文件 + 顺手修两个真 bug）

用户："有没有视频和 gif 文件？帮我造几个，放到目录下。" —— 仓库里原本**一个都没有**（`docs/shots/` 只有截图），
所以补了一套**图案本身带预期**的素材，屏上出问题时能一眼归因：

```powershell
make samples-anim        # = python tools/dev/make-anim-samples.py → samples/anim/
```

| 文件 | 格式 | 看什么 |
|---|---|---|
| `bars-sweep-240x296.gif` | GIF · 50 帧 | 彩条顺序（R/B 交换立刻露馅）+ 11 级灰阶 + 横扫白线直不直 |
| `ball-grid-240x296.gif` | GIF · 60 帧 | 弹跳球带拖尾：丢帧 = 跳格，撕裂 = 圆边断开 |
| `rgb-ramp-240x296.webp` | 动画 WebP · 36 帧（无损） | 色相平移 + 16 级灰阶：RGB565 色深、字节序 |
| `count-cube-240x296.apng` | APNG · 50 帧（无损） | 帧号连续 + 秒针：帧序/丢帧；APNG 走 ImageDecoder |
| `checker-scroll-360x360.webm` | WebM/VP9 · 3 s | 棋盘斜移 + 红边框 + 蓝十字：撕裂/卷屏/开窗缺边 |
| `cube-clock-360x360.mp4` | MP4/H.264 · 4 s | 旋转立方体：流畅度上限（AXS15352 ~20 fps） |

生成器 `tools/dev/make-anim-samples.py` 只用 Pillow + numpy + imageio-ffmpeg（**自带 ffmpeg 7.1，本机没装 ffmpeg 也能编 H.264/VP9**），
每个素材的"看什么"写在函数注释里；中文说明烧帧上时优先用系统 `msyh.ttc`（Pillow 默认字体没有 CJK 字形，会画成豆腐块）。
合计 ~1.2 MB，**不进 Pages**（部署只拷 `index.html app docs`），素材说明见 `samples/anim/README.md`。

> **口径坑（写进 README）**：GIF 是按**链路速度**播的（发送才是节拍器），不按文件里的帧时长 ——
> 2 秒的 GIF 在假探针上 0.2 秒就播完；要判断"作者定义的时长/流畅度"用 MP4/WebM（`<video>` 那条路按真实时间播）。

拿真页面逐个装载这 6 个文件（CDP `DOM.setFileInputFiles`，走用户真实路径）时**逮到两个真 bug**：

1. **GIF/APNG 帧数记成 0 → 不勾"循环"时只播一帧**。`ImageDecoder` 的 `completed` 只保证**数据收齐**，
   这时 `tracks.selectedTrack` 还是 `null`：`src.frames` 记成 0 → 状态行写"0 帧"，
   且 `_runGif` 里 `i >= (frameCount ?? 0)` 第一帧就成立 → 直接收工。
   修法：`await dec.tracks.ready`（拿不到就退 `tracks[0]`），`_runGif` 再用"解码越界"兜底判播完（`anim.js`）。
   自测 §9c 钉住：素材 50 帧 → `summary().anim.srcFrames === 50`、不勾循环**播满 50 帧自己停**。
2. **探针掉线时控制台留未捕获错误**：`navigator.usb` 的 `disconnect` 回调里 `dev.close()` 返回 Promise，
   设备已经不在了会**异步 reject**（`NotFoundError: Failed to execute 'close'`），同步 `try/catch` 拦不住
   → 改成 `dev.close()?.catch?.(() => {})`（`dap-webusb.js` 的 `_watchUsb`）。

顺带把 `summary().anim` 补上 `kind` / `srcFrames` / `srcDuration`（源自身元数据，与"已发送帧数"分开；
脚本/自测不用再去解析状态行文本），状态行里的"（GIF）"也改成按扩展名显示 —— 动画 WebP 别再写成 GIF。

**自测**：`spi-panel-page` 由 97 → **102 通过 / 0 失败**（新增 §9c 五条）；真页面装载 6/6 成功、三段真播通过、
页面零未捕获错误（`tmp/check-anim-samples.mjs`）。

---

## 11.10 攒批：把"一帧 290 次 USB 调用"压到 11 次（2026-10，用户："3 MB/s 的瓶颈在哪里"）

用户实测：60 MHz 档播视频只有 **18~21 fps / 2.6~3.0 MB/s**，而 USB HS 明明能跑 20 MB/s+、SCLK 也不是瓶颈。

**先算清楚瓶颈**（一帧 240×296 = 142,080 B）：

| 组成 | 量 |
|---|---|
| 像素片（每片 492 B 像素 + 12 B XFER 头 + 8 B 帧头 = **正好 512 B**） | 288 片（末片 384 B → 404 B 帧） |
| 开窗 + RAMWR 命令帧（CASET/RASET/RAMWR） | 3 条（16/16/21 B） |
| **合计** | **292 个协议帧 / 147,913 B** |
| 老实现：每包一次 `transferOut` | **290 次调用/帧** × 实测 ~150 µs ≈ **44 ms** |
| SPI 60 MHz 单线刷一帧 | **18.9 ms**（38%） |
| USB HS 物理带宽占用 | 3 MB/s ÷ 40 MB/s ≈ **7.5%** |

⇒ 瓶颈是**主机侧每次调用的固定开销 × 调用次数**，跟带宽无关。

**关键认识（用户点破的）**：USB 层面**一次 bulk 传输可以带任意多个 512 B 包**（内核自动切包，设备没准备好就 NAK
= 背压）；固件那边"每次 arm 一个 512 B 槽、收满回调解析"的模型**完全不受影响** —— 包序列一模一样，只是主机少喊几次。
所以之前那句"要么改固件、要么补填充字节"是多余的：**像素片本来就是 512 B 整包，天然对齐**。

**实现**（四处，都在主机侧；固件零改动）：

| 落点 | 做什么 |
|---|---|
| `protocol.batchPacks(packs, batchBytes)` | 把包合并成"一次 transferOut 的批"；**唯一的硬约束：短包只能落在一批的末尾**（设备 arm 的是固定 512 B 缓冲，"收到短包 = 这次端点传输到此为止"，夹在中间会让后面的包白等一次 arm）。`batchBytes = PKT` 时退化成"一包一批"，与老行为逐字节等价 |
| `transport.sendRaw()` / `sendPacks({batchBytes})` | 真机那条路一次 `transferOut` 提交一批；假探针那条路同样攒批 |
| `mock.write()` | 照固件口径**按 512 B 拆槽**再解析（攒批不该改变设备看到的东西 —— 这条由自测钉住） |
| 屏页「攒批」旋钮（`#pn-batch`） | 512 B / 4 KB / **8 KB（默认，实测最优）** / 16 KB / 32 KB，落 store；状态行显示 **USB 调用 N 次/帧** |

**真机实测**（AXS15352 · 档 1 · 240×296 · SCLK 60 MHz · 素材 `samples/anim/ball-grid-240x296.gif`，
回读 SCLK=60 MHz、`frames_err` 全程 +0、`out_ring_overrun` 0）：

| 攒批 | 动画 fps | MB/s | USB 调用/帧 | 相对老行为 |
|---|---|---|---|---|
| 512 B（老行为） | 25.7 | 3.56 | 290 | 100% |
| 4 KB | 26.1 | 3.62 | 38 | 102% |
| **8 KB** | **35.3** | **4.89** | 11 | **137%** |
| 16 KB | 34.5 ~ 36.5 | 4.79 ~ 5.07 | 11 | 134~142% |
| 32 KB | 35.8 | 4.96 | 6 | 139% |

在飞批数（`outInFlight`）× 16 KB：4 → 34.3 fps、**8 → 36.1（默认）**、16 → 36.5、24 → 36.0 ⇒ 8 已经够，别再加。
40 MHz 档同样量过：512 B 22.0 fps → 16 KB 28.6 fps（+30%），整屏刷 93 ms → 51 ms。

**还剩多少余量**：60 MHz 下 SPI 本身只要 18.9 ms/帧（≈53 fps 上限），实测 28 ms/帧（36 fps）= **SPI 上限的 68%**；
差额是**主机侧每帧的 JS**（实测：抓帧+RGB565 4.14 ms + 预览回绘 1.00 ms + 打包 0.67 ms ≈ 5.8 ms）与固件每槽的
那点开销。再往上要么**少发字节**（局部开窗 / 帧间差分，见 §11.8 的下一步①），要么把预览做成可选。

**自测**：`spi-proto` 79 → **90**（攒批不变量：512 B 退化成老行为、短包只在批尾、攒批后按 512 B 槽解出来的帧序列
与逐包发一字不差、单包 >512 B 早炸、一次传输夹在 60 KB 内）；`spi-panel-page` 102 → **107**（§9d：16 KB 档每帧
11 次调用、512 B 档 290 次、两档设备侧都是 292 协议帧/帧且零错误）。

---

## 11.11 屏的回读：读寄存器 + 读 GRAM（2026-10，用户点名）

用户："spi/qspi 屏的回读功能（读一般都是 1 线读）：读寄存器；读 gram 值（发 2A+2B 开窗，2E 读数据，
3E 是续读），把读出的数据还原成一帧图片并显示在预览窗口里面，并提供保存为 bmp 的功能。"
位置也按用户要求调了：屏页卡片顺序 = **图片/图案刷屏 → 日志 → 面板初始化 → 读回**（日志挪到初始化前、读回放最后）。
> 🚨 2026-10 右列 tab 化之后，这句话被 §11.13 取代：三块变成三个 tab，日志改成**常驻在 dock 之外**
> —— 两条要求的本意（"日志默认展开""日志排在初始化之前"）由"永远看得见"同时满足。

**两条档位的读时序**（`app/spi/panel-read.js`）：

| 档 | 序列 |
|---|---|
| **1（SPI + DC，AXS15352）** | `CASET(2Ah)` + `RASET(2Bh)` 开窗 → `RAMRD(2Eh)` 命令（DC=0，**CS 保持**）→ 数据相位（**DC=1**、`rx_len` 字节、`dummy=1`）→ 之后每片先发 `RAMRDC(3Eh)` 再读（读指针自己往下走，CS 一路保持） |
| **2（QSPI，ST77916）** | 开窗同上（STEP 会展开成 `02h + 24bit 地址`）→ 每片一条 XFER：**读 opcode + 24 bit 地址 + dummy + 数据**，地址按片递增（与写侧 `0x2C0000` 同一个编码，读是 `0x2E0000`）—— 跟 SPI Flash 一模一样的形状 |

读命令/地址/dummy/线数/RAMRD/续读**都在页面上可配**（默认 `03h` / 3 字节 / `0x2E0000` / dummy=1 / 1 线 / `2Eh` / `3Eh`）。
寄存器那张表是 MIPI DCS 标准读命令：`04h` RDDID、`09h` RDDST、`0Ah..0Fh`、`DAh..DCh`、`D3h`（ST 常见），也能手填命令+长度。

### 🚨 三个坑（都是真机上撞出来的）

1. **一片最多读 503 B，不是 504**（真机定标）：应答包 = 8 B 头 + N 字节，N=504 时**正好 512 B = 一个满的
   HS bulk 包**；而主机的 `transferIn` 是"收满请求长度**或**收到短包"才收尾 —— 满包后面没有短包，
   这一笔就永远挂着。实测边界：`64 / 400 / 500 / 503` 都秒回，**`504` 必超时**（每次要等满超时，
   整屏读会被拖到几分钟）。固件侧 `rx_len ≤ SB_FRAME_MAX(504)` 是放行的，所以只有真机会撞。
   → `READ_CHUNK_MAX = 503`、默认片长 500（`panel-read.js` 顶部注释 + `transport.js` 纪律第 4 条）。
2. **屏上不一定有 MISO**：本机这块 AXS15352 **SDO 根本没接**（`akaLinkPro/docs/spi-bridge-wiring.md`：
   "这块屏没有 MISO，J3[27] 空着"）→ 读回来的永远是 `00`。这不是读的 bug；接一块带 SDO 的屏（或
   ST77916 的 D1）才有真数据。**判断方法**：先读 `04h` RDDID —— 有 MISO 的屏会回非零 ID。
3. **读到的字节序/R/B 要与写侧同一套口径**：默认"高字节在前、不交换"；不对时先只翻一个（页面上的
   「字节序 / R/B 交换」两个开关），别一起翻。

### 落地

| 落点 | 做什么 |
|---|---|
| `app/spi/panel-read.js` | `regReadItems()` / `gramReadPlan()`（切片 + 续读 + CS_HOLD）、`decodeGram()`（565→RGBA，带字节序/R-B 开关）、`encodeBMP()`（24 位 BMP，bottom-up + BGR + 行 4 字节对齐 —— 浏览器不会导出 BMP，只能自己拼头）、`readPlanProblem()` 静态检查 |
| `app/spi/mock.js` | 假探针加了 **GRAM 模型**（`PanelGram`）：窗口/写/读/续读语义齐全，**没写过的像素给确定性图案**，所以离线自测能逐像素断言；还有 `MOCK_DCS_REGS` 让读寄存器也有确定回包 |
| 屏页「读回（寄存器 / GRAM）」tab | 读寄存器（下拉 + 手填）、窗口（默认整屏）、读时序、`读一帧` / `停止` / `保存 BMP`、进度行；读回来的画面画进**它自己的画布** `#pn-read-canvas`（tab 化之后不再共用刷屏那张，见 §11.13） |
| `summary().readBack` / `lastReg` | 脚本/自测直接读（字节数、片数、丢片、耗时、抽样像素），不用解析日志 |

**自测**：`make test-read`（`tools/selftest/spi-read.test.mjs`，**46 项**：三种档位的帧形状、切片/续读/CS_HOLD、
503 上限与 504 夹取、字节序与 R/B、BMP 头与像素排布、**假探针 GRAM 往返逐字节相同**、子窗口语义、QSPI 地址递增）；
`spi-panel-page` 增 §9e（107 → **114**：卡片顺序、读寄存器、读回 40×20、预览像素 = 读回像素、BMP 尺寸、全程只读不写）。

**真机数据**（AXS15352 · 档 1 · 60 MHz · 整屏 240×296 = 142,080 B / 285 片）：**650 ms 读完、0 丢片**、
`frames_err` 0；数据全 0 = 这块屏没接 MISO（见坑 2）。假探针上整屏读回 20.6 ms，BMP 213,174 B，
Pillow 解开是 240×296 RGB，中心白块/渐变都对得上。

---

## 11.12 QSPI 地址编码修正：命令在**中间**字节（2026-10，用户指出）

用户："地址按片递增（0x2E0000，与写侧 0x2C0000 同编码）—— 这个是不是不太对？应该是 0x002E00 和 0x002C00？
我记得 qspi 协议的 lcd，地址中间 byte 才是 cmd?" —— **用户是对的，我们错了**，而且错的不止读回默认值。

**三份证据**：

1. **ST77916 数据手册 §8.8.5.1（Command write mode）**：
   > host needs to send 1 byte of write command instruction (0x02、0xA2、0x32 or 0x38). Then host sends
   > 3 bytes of AD[23:0] which is composed of **1 byte of 0x00, 1 byte of command address and 1 byte of 0x00** … `CMD : 0x00XX00`
   读那边（§8.8.5.2）同格式，读指令是 **`0x0B`（FASTREAD）**。
2. **ESP-IDF 官方驱动** `espressif__esp_lcd_st77916/esp_lcd_st77916_spi.c`：
   `lcd_cmd <<= 8; lcd_cmd |= LCD_OPCODE_WRITE_CMD << 24;` → `0x02 | 00 cmd 00`（同目录下 `qspi_lcd_mouse` 工程
   `use_qspi_interface = 1`，跑在真机上）。
3. 我们自己的老实现（`cmd << 16` → 线上 `2C 00 00`）与 akaLinkPro 固件 `sb_step_qspi()`（`addr = cmd` → 线上 `00 00 2C`）
   **两种都不对**。

**改了什么**：

| 位置 | 原来是 | 现在 |
|---|---|---|
| `image.js pixelItems`（档 2 像素） | 每片各自 `cmd=0x32 + addr=0x2C0000`（每片一条命令、各自一个 CS 窗口） | 地址 `0x002C00`；**首片**带 opcode+地址，后续片是纯数据相位，**CS 一路保持到末片**（一条命令 + 整帧连续流，与 ESP-IDF 的做法一致）。每片重发命令会把面板写指针打回窗口原点 |
| `image.js windowItems`（档 2 开窗） | `STEP` 帧（固件按 `addr = cmd` 展开，编码错） | **直接发 XFER**：`0x02 + 00 2A 00 / 00 2B 00 + 4 字节坐标`（绕开固件的 STEP 展开） |
| `panel-read.js`（档 2 读） | opcode `0x03`、地址 `0x2E0000`、每片重发 | opcode **`0x0B`**、地址 `0x002E00`；首片带 opcode+地址+dummy，后续片纯数据相位 + CS 保持 |
| 假探针 `mock.js` | 按 `cmd << 16` 认地址 | 按 `00 XX 00` 认（命令字在中间字节）；认"CS 保持的续传"（纯数据相位落到 GRAM 模型上）；寄存器查表也改成看地址里的命令字（否则读 opcode `0Bh` 会撞上 RDDMADCTL） |
| 页面「读时序」默认值 | `03` / `0x2E0000` | `0B` / `0x2E00`（都还能手改；换屏按各自手册来） |

**固件侧待修**（akaLinkPro，不在本仓库）：`sb_step_qspi()` 的 `x.addr = cmd` 要改成 `x.addr = (uint32_t)cmd << 8`，
注释里"命令字放在最低字节"的结论是错的（当初用 LA 只验了地址字段的**字节序**是 MSB 在前，没验"哪个字节装命令"）。
本页面的 QSPI 开窗已经绕开 STEP，所以在固件修好之前页面也能用。

**自测**：`spi-read.test` 46 → **52**（QSPI 读的地址/续读形状 + **QSPI 写→读往返逐字节相同**）；
`spi-panel-code` 加了两条（首片带命令+地址、后续片纯数据 + CS 保持，整屏只有 3 个 CS 窗口）；`spi-panel-page` 的 QSPI 线上字节随之改为 `259200 + 8`。

> 另一条环境坑（顺带记下）：**窗口被最小化/遮住时 Chrome 不渲染隐藏页面里的 `<video>`** ——
> `play()` 会 resolve 但 `currentTime` 不走、`rVFC` 一帧都不回调，症状是"视频那条路 0 帧"而 GIF/APNG 正常。
> 自测里已加 `Page.bringToFront`；页面也会在开播时提示一句。

---

## 11.13 屏页右列 tab 化（2026-10，用户："参考调试器界面，右边部分做成多个 tab，现在有点繁琐"）

**改之前的账**（1600×900 实测）：右列是一列纵堆的四张卡 + 状态条，内容 **1597px / 可视 836px**
→ **每次都要滚 761px**；三处高度写死（解析表 360 / 日志 190 / 预览画布 170 —— ST77916 的
240×296 缩到 **138×170**，根本看不清），矮窗口里三块互相挤。

**改之后**：`#tab-panel .main` 变成 `.paneldock`（`#pn-box-dock`）+ 常驻日志（`#pn-logbox` + grip）+ 状态条。

| | 改前 | 改后（1600×900） |
|---|---|---|
| 右列滚动 | 761px | **0**（`overflow:hidden`，高度交给当前 tab） |
| 刷屏预览画布 | 170px 写死 | **380×388**（`object-fit:contain` 铺满，1080 高时 568） |
| 解析表 | 360px 写死 | **吃剩余高度** 320px（900 高）/ 495px（1080 高）+ 一条**可拖分隔条**分给源码框（源码框按页高取 20%） |
| 读回的画 | 画进刷屏那张 170px 画布（大概率已滚出视野） | **自己的画布** 421×455 + 显示开关副本 |
| 日志 | 卡片，滚走就看不见 | **常驻 150px**（可拖 72~，记忆 `panel.logH`） |
| 运行状态 | 藏在各自的卡里 | tab 栏上的**运行胶囊**（刷图 / 重放 / 读回 / 播放）+ 一个**跨 tab 的中止** |

四档窗口实测（`tmp/pn-viewports.mjs` / `tmp/pn-clip.mjs`，三个 tab 溢出全 0、无横向滚动条、
**没有任何控件行被压扁**）：
1080 高 → 解析表 495 / 画布 568；900 → 320 / 388；820 → ~250 / 308；700 → 表格接近下限、整页改滚。
（矮窗口想给表格更多高度：拖它上面那条分隔条把源码框压到 70px，或拖日志那条。）

**顺带修掉的旧限制**：`#pn-canvas` 原来被三处共用（静图预览 / 动画帧 / 读回画面）—— tab 化之后
必须给读回一张自己的画布，否则结果画进 `display:none` 的页里（§10.0b 第 2 条）。

**动画为什么跟刷屏一个 tab**：它俩共用同一张预览画布、同一套"整屏刷"通路，本来就是一件事。
（不是被迫的：实测 `display:none` 下 rVFC 照常回调，见 §10.0b 第 4 条。）

**自测**：`spi-panel-page` 136 → **161 项**。§1b 整段重写（tab 段 / 默认停在刷屏 / 右列不滚动 /
日志常驻 / 胶囊与中止联动 / 三个 tab 各自吃满高度 / **每个 tab 都没有控件行被压扁** /
装不下时先让弹性块缩到下限再整页滚 / 画布正好填满所在行 + object-fit /
解析表是弹性元素 + 拖分隔条时**表格同步变矮**（与窗口尺寸无关的功能性证据）/ 读回独立画布 +
显示开关双向同步），§9e 的"卡片顺序"改成"三块 tab + 日志在 dock 之外"，读回像素断言改量
`#pn-read-canvas`；§5/§5b/§6/§7/§9b~§9e 每节开头显式切到对应 tab（真实用户只能点看得见的那块）。
桥页 133 项同轮复跑全绿。

> 🚨 **布局断言一律别写死像素**：自测跑在**用户正看着的那个窗口**上（本机这一天从 1600×900 变成
> 1536×730，同一个套件就从"全绿"变成三条红的）。要么断言**相对量**（画布高度 == 所在行高度、
> 表格占比、两窗等高），要么断言**行为**（拖一下就变矮）。`spi-bus-page` 里那条
> "两窗都够大（>= 120px）"也按这个口径改成了"占比 + 地板"。

---

## 12. 已拍板与 TBD

**已拍板**：见 §0（9 条），本轮不再有悬空问题。

**TBD（明确先不做，等以后）**

1. **TE 撕裂信号**：读电平与"等 TE 再发下一片"都留到上板看到撕裂之后再评估；页面暂不暴露 `pad_te`。
   `AUX_IN` 帧仍实现（手写多帧里一行 `auxin` 就能发，成本为零）。
2. **帧序列 / 面板表的本地持久化**：localStorage 存档、"某块屏 + 某个图案"的一键流程留 TBD；P2 做的是**文件**导入导出（JSON / C 片段），不是浏览器本地状态。
3. **背光 PWM 调光**：v1 只有 BL 开/关（固件方案 §9.2 已列为后续）。
4. **SCLK 80 MHz**：5301EVKLite 上限 75 MHz，不再考虑 80 MHz。
5. **README / 截图 / `docs/backends.md`**：P4 一起改。
6. **文件级整片烧录 / 读回镜像**（见 §11.6 E 末尾）：等外接 flash 接线跑通、1 线与 4 线的读测速都拿到数字之后再评估。

## 2026-10-08：BMP 发图吞吐量与探针 word DMA

整屏真机对照：60 MHz、32 KiB 批量下，AXS15352 为 5.90 → 6.18 MB/s，ST77916 为 7.14 → 16.36 MB/s。主要修正在探针 TX DMA，从逐字节搬运改为对齐写事务的四字节合并；非对齐、尾包和 RX 保留字节路径。完整计时口径、长测结果和复现命令见 [BMP 发图实测](spi-image-rate-2026-10-08.md)。无屏测试验证通路执行，显示效果待接屏确认。
