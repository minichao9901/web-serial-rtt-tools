# web-serial-rtt-tools 全页面代码审查报告（2026-10-16）

- 基线：HEAD `fb06da2`（工作区对 `app/rtt/dap-webusb.js` 有未提交改动——B 组审查以工作区版本为准，该文件行号 1513 行 > git 版 1449 行）。
- 方法：**纯只读读码**（不跑 CDP、不上真机、不改代码），四个独立审查源交叉汇总：串口系+共享层（subagent）、探针系 4 页（subagent）、外设系 5 页（队长）、akaLinkPro 固件调度（队长）。历史审查文档一律未引用，全部结论来自本轮独立读码。
- 页面覆盖：15 个标签页全部覆盖（深度分级：核心页全文细读、视图大文件定向抽样），另含 `app/core`、`app/ui`、`site/main.js`（构建产物）与探针固件调度。

## 0. 总评与统计

**架构底子是好的**：分层纪律（session 不碰 DOM / view 只管 DOM）、三层互斥（USB 锁 / session exclusive / 探针单命令链）、四层探针共享协调、构建产物防漂移、固件协作式单主循环——这些骨架都成立且大多有回归钉住。问题集中在三类：

1. **异常路径的状态残留与清理缺口**（P1 与多个 P3 的共同模式：happy path 严密，catch/收尾路径漏一手）；
2. **组合防御没有总预算**（单层重试都有真机依据，叠起来最坏几十秒静默）；
3. **少量绕过互斥/纪律的路径**（锁外 heal、双队列插拍、裸 setTimeout 残留）。

| 类别 | P1 | P2 | P3 | 合计 |
|---|---|---|---|---|
| BUG | 1 | 6 | 10 | 17 |
| 过度防御 | 0 | 1 | 7 | 8 |
| 架构/调度 | 0 | 2 | 4 | 6 |

## 1. 必修清单（按优先级）

| # | 级 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 1 | P1 | `app/hid/view.js:407,419-425` | 「RTT 转发」启动**异常路径**不清 `_bridgeRequested`：`dev.start()` 抛错（探针掉线常态）后标志残留 → cdc-mode 判死"RTT 模式"拒发 UART（串口/终端/转发三页全哑），且 probe-users 恒真 + fail 账本挡住 flash/dbg/Viewer/J-Scope；界面提示却只说"请先停止" | catch 里与 rc<0 路径同样置 `this._bridgeRequested = false`（fail 记账保留） |
| 2 | P2 | `app/rtt/dap-webusb.js:507-522` | `_healIfFaulted` 在 `_withLock` **锁外**跑 `_targetInit()`（重写 DP SELECT/CSW/TAR），与持锁中的块读写交错——违反"一条 SWD 链上任何两次操作交错读出垃圾"铁律；注释"锁内会自锁死"的前提不成立（`_targetInit` 不走公开 readMem/writeMem） | heal 移进 `_withLock`（或先 `await this._lockChain`） |
| 3 | P2 | `app/rtt/dap-webusb.js:472-492,307,541-566` | `_onXferTimeout` 自愈（端口复位+claim）后**不置 `_faulted`**，而 claim 收尾的 resync 连发 8 条 DAP_Disconnect 已把探针 DAP 打回断开态——下一笔目标访问在"链路状态未知"的 DAP 上裸跑 | 恢复完成后 `this._faulted = true`，走既有 `_healIfFaulted` |
| 4 | P2 | `app/flash/hpm/riscv-dm.js:270-274` | `_exclusive` 按 key 分 `_dmiQueue`/`_sbaQueue` 两条队列：一队列的 DMI READ 与取结果 NOP 之间可被另一队列扫描插拍，`dmiResponse` 只认 op 不认地址 → **两次返回值静默互换**。当前靠上层单流掩盖，机制上无防线 | 统一单队列；或 `_dmiOp` 校验响应的 addr 字段 |
| 5 | P2 | `app/flash/hpm/riscv-dm.js`（50/20/10/25ms 六处）、`app/scope/view.js:1325`、`app/scope/transport.js:302`、`app/rtt/protocol.js:159`、`app/rtt/dap-webusb.js:1411,1442` | 烧录/标定主链上的短等待用裸 `setTimeout`：页面后台被钳 ≥1s，把毫秒级 settle 放大成十秒级（`detectLayout` 20×25ms → 后台 ~20s；标定轮询 → ~30s）——与 pace.js 记录的 1.4s→47s 同族事故 | 全部换 `pace.waitMs`/`yieldTask`；硬件 settle（nRESET 脉宽）保留 sleep 例外 |
| 6 | P2 | `app/i2c/view.js:830,863 + 779-792` | 从「脚本」tab 跑命令后，结果按**脚本行号**画进「命令表」结果列（`row = e.item.line - 1` 两路语义不同），且 `_runScript` 不清 `this.results` → 别的命令的结果顶在表格行上、旧结果残留（已用 node 脚本复现映射） | item 带来源标记（脚本路径 row=-1），或脚本入口清 results 分开两套存储 |
| 7 | P2 | `app/flash/view.js:1179-1183` | `_log` 用 `textContent +=` + `scrollTop=scrollHeight`，每行强制同步布局（本仓实测 16.8ms/行，#panel/#spi 已改 `ui/dom.js` 的 `appendLogLine` 并明令别写回）——烧录 100+ 行日志 ≈2s 纯布局开销，且与重试次数正相关 | 换 `appendLogLine` |
| 8 | P2 | 固件 `i2c_bridge.c`（poll 的 `s_enabled==0` 分支，约 766 行）+ `bus_periodic.c:41-43` | `bus_periodic_wake()` 条件 `dirty && req_kind==0`：XFER 排队期间 timer 到期 → wake 被挡、dirty=1；随后 **DISABLE I2C 桥**把 req_kind 清成 NONE，而 `i2c_bridge_poll` 的 `s_enabled==0` / `IB_REQ_NONE` 两个早退分支都**不触发尾部 wake** → dirty 悬挂 + timer 已 stop → **I2C/SPI/ADC 三总线周期作业全部停摆**，只有 BP_RUN/BP_STOP 能救。正常路径（XFER 执行完）由 poll 尾部 wake 补偿，唯独 DISABLE 时序漏 | 两个早退分支补 `bus_periodic_wake()`；或 wake 改成"dirty 未消费就置 BP_WAKE" |
| 9 | P2 | `app/rtt/protocol.js:147-227` + `riscv-mem.js:67-79` + `riscv-dm.js:182-319`（组合） | "读失败→recover→重试"多层叠加**无总预算**：validate 3 次×(recoverMem+80ms) + _entry 3 次 + 每字 700ms + _dmiOp 最多 64 次 BUSY 重试 + _dmWakeRecover 5×50ms——真死链上"连 RTT"要串行烧完所有层预算（估 10s+）才报错。单层都有真机依据，组合失去上界 | 一层会话级 deadline 贯穿下传（RiscvTransport 已有雏形，RTT 层没用上） |

以下 P3 按页面归位（均给出行号与修法，详见各节）。

## 2. 按页发现

### #serial 串口助手 / #terminal 终端
- [P3] `serial/assistant.js:306-312` 定时发送裸 `setInterval`（下限 20ms），后台被钳 ≥1s；数据不丢、纯节奏。建议 UI 注明或换 MessageChannel 节拍。
- [P3]（与 #rttcdc 共用）隐藏页轮询无 `document.hidden` 门（见 §4 A2）。

### #rttcdc RTT 转发
- [P1] 见必修 #1（`hid/view.js` 的 `_bridgeRequested` 异常残留——本页是触发点，也是最大受害页）。

### #spicdc SPI 转发
- [P3] `spi-cdc/session.js:27-30` connect 失败时清理层顶掉原始错误，且 `this.hid = hid` 留下半开会话（`connected` 显示 true）。建议始终抛原始 error，清理失败另记 fail()。（对照：`analog/session.js:38-44` 的同场景用 AggregateError 双报 + `_connectCleanupError` 门，是更好的写法。）

### #rtt RTT Viewer
- [P3] `rtt/protocol.js:263-274` `name()` 的 `Promise.race` 输掉的 readMem reject 无人接 → unhandledrejection。race 后给 readMem 挂 `.catch(()=>{})`。
- [P3] `rtt/dap-webusb.js:1120-1135` `_readMemOnce` 对"块读 ack=OK 但 count=0"静默填 0 返回——"按实际长度取字"纪律漏了 0 截短。n===0 应抛错。
- [P3] `rtt/dap-webusb.js:869,874` `_powerUpDP` 用 `st & 0x30000000`（REQ 位）判上电 ACK（应 0xA0000000），且用单次 `_transfer` 读（本文件自定义"DP 读要读两遍"）——检查双重失效，"目标真没上电"永远探不出来（APSEL 扫描兜底，后果有限）。
- [P3] 读残渣的三套判据（dap 双读全等 / flash `_readStable` 5 轮 / protocol 结构指纹）分层互不知晓，flash 校验失败无法归因是哪层读坏——至少给 `_readStable` 实际轮数留一行日志。

### #scope J-Scope 波形
- [P2]（并入必修 #5）`scope/view.js:1325` 标定轮询 100ms×30、`scope/transport.js:302` STALL 清除 10ms 用裸 setTimeout。
- [P3] `scope/transport.js:180,366` 用**中文报错文案正则**判定"共享资源冲突不可重试"——文案一改守卫静默失效。建议 UsbLease 错误带 `error.code`。

### #flash 烧录器
- [P2] 必修 #4/#5/#7/#9 都落在本页主链上。
- [P3] `dbg/session.js:1006,1018` 式外层超时同款：`flash/view.js` 校验 `_readStable` 之外的超时预算与内层脱节（见 B 组 #12 同族——外层 `withTimeout(204s)` 形同虚设，错误信息与真实状态脱节，建议删除或收敛到内层同量级）。
- [ARCH] `dap-webusb.js` open 路径自愈叠层无总预算：认领 3×退避 + 封包探测 2 轮 + 时钟协商 7 档×(targetInit+reopen) + APSEL 4×3 扫描——每层都有真机依据与日志，但 `_setup` 最坏 ~30-60s 静默，观感即"打开探针卡死"。建议总 wall-clock 预算 + 阶段性状态回报。

### #dbg 调试器
- [P3] `dbg/session.js:239-253` + `dbg/dwt.js:61` `disconnect()` 里 `dwt.clear()`/`p.disconnect()` 无兜底：探针已死时直接抛 → `this.probe` 不清空，会话卡"已连接"只能刷新。收尾应逐项 best-effort + 无条件置空。
- [P3] `dbg/view.js:1181-1183` 停机播报 `pc & 0xfffffffe`（有符号掩码）——≥0x80000000（HPM/H7 XIP）得负地址，符号/文件:行显示丢失。与 `fmt.align2` 的既有纪律不一致（session._bpAt 正是用它修的同类 bug）。
- [P3] `dbg/riscv.js:604-630` RISC-V `step()`：`_waitResumed(400ms)` 没观察到"真跑起来"时，`waitHalted(3000)` 因核仍 halted **立即成功** → 清 step 位 → 按"单步完成"返回，PC 未动且无提示。建议复用 ARM 的"PC 是否前进"判据。
- [P3] `dbg/session.js:42-46` `busFaultText` 承诺"会自己重新初始化，不用重连"——自愈可失败且只写日志，持续失败时文案与最坏行为不符。补一句"若连续失败请重连"。
- [ARCH] `dbg/session.js:168-174` ARM connect 停桥只认 `globalThis.__tools?.hid?.last?.running`（本页签状态）——跨页签的 RTT 转发时判不到 → 不发 HID 0x31 stop，单步被探针侧 1kHz 轮询拖慢十倍的经典症状回归。flash/view.js:948 与 dbg/riscv.js:120 都显式发 0x31（幂等、没跑时无副作用）——ARM 路径补一条即可。

### #spi USB→SPI/QSPI 桥
- 结论：**写路径当前防线完整**（本轮独立验证）：`flAddr()` 空/非十六进制/超 3 字节全抛错（bus-view.js:819-830）；`flWriteBench` 按扇区擦 + 每条 SE 后等 BUSY + 无重复擦（bus-view.js:1125-1138）；`flWriteData` 判空只看原始文本、`parseHexBytes` 对非法字符抛错（session.js:560-577）；transport 的 STALL clearHalt≤8 次、gen 代号防 worker 复活、EP11 drain 收尾、数据面停死告警齐全。
- [P3] `spi/runner.js:137` `_runProbe` 的 `onResult` 直接 `g.records[r.step].item`——固件回错 step 时 TypeError。加一次界检查。
- [P3] `spi/transport.js:384-389` `MockSpiTransport.stop()` 后仍在飞的一条 `_drain` 会继续推应答（仅测试环境）。
- [P3] `spi/anim.js:421` 帧间 yield 用 `setTimeout(0)`（后台页钳 1s；后台视频本就不渲染且有提示，影响有限）。

### #panel SPI/QSPI 屏
- 结论：**局部刷新的基准帧失效点齐全**——摆放/颜色/开关/容差/换图/换图案/换几何/推荐值/复位/面板命令/复位并开背光/换动画源共 12 处 `resetPartial(reason)` 全部在位；发送与读回进度都走 `progressThrottle`；未发现裸 `scrollTop=scrollHeight`。
- [P3] `anim.js:354-364` GIF「循环」依赖 `this.loop`，constructor 未声明（由视图在 load/change 时动态赋值，panel-view.js:288,293-295 已确认接上）——功能正确，但建议把 `loop` 挪进 constructor 声明，防止未来装配点遗漏时静默变成"永不循环"。

### #i2c USB→I2C
- [P2] 必修 #6（脚本结果错画进命令表）。
- [P3] `i2c/session.js:166-197` 探针已失联时「断开」必失败：对着已断开 HID 发 ENABLE(0) → 抛错 → `fail('i2c')` 记账挡住共享 `i2c-pins` 的 SPI/ADC，须重插探针才能恢复（物理拔线其实已释放引脚）。`!this.connected` 时跳过 ENABLE 确认改走 forget。
- [P3] `core/bus-periodic.js:124` `run()` 的 `finally { await this.stop(); }` 失败时顶掉原始错误——把"数据未被静默覆盖"这句最关键的定位信息换成干巴巴的"停止未确认"。保存 body 错误，两者都报。
- [P3]（同族存档）`i2c/runner.js:86-100` 一次性 delay 用 setTimeout——被钳只会"等更久"，安全方向。

### #analog USB→ADC/DAC
- 结论：质量高——worker 优先 + 主线程回退双实现同构；共享端点退场协议完整（retireSpiOut ZLP / retireSpiIn 接手 leftover 读 / 12 次有界重试）；`_openUncertain` 恢复、按提交序消费、序号/END 校验齐全。
- [P3] `analog/session.js:38-44` connect 清理失败时 `this.hid=hid` 留半开会话（但有 AggregateError 双报 + `_connectCleanupError` 门兜住下次连接，比 spi-cdc 好）。
- [P3] worker/主线程两份包校验逻辑重复（decodeAdcPacket 复用了，但序号/END 管理是两份）——改一处漏一处的面。

### #swo SWO 执行轨迹
- 结论：断点租约设计严谨（写前回读校验、拒绝覆盖他人槽位、清理失败 AggregateError 汇总）；RCC 读 6 取 3 次一致防交接陈旧读；MAX_RAW/transportGaps 双上限。
- [P3] `swo/capture.js:22,48` `waitRegister`/命中等待用裸 `setTimeout(5/20ms)`——后台页最坏放大百倍；属前台交互操作，影响有限，但与 pace.js 纪律同族。

### #etm ETM 执行轨迹
- [P3] `etm/view.js:19-29` iframe 一旦 attach 成功，onShow 不再重载；子页刷新后父页只报"未就绪请重新检测"，探针会被 childUnloaded 自动释放（这部分是好的），但恢复必须手动点一次。体验级：load 回调里 childReady()==false 时可提示"旧连接已释放，点击重新检测"（文案已接近，差半步自动重试）。

### #gen 工程生成
- 结论：无新发现。`site/main.js` 为构建产物，防漂移三件套齐全（manifest 输入哈希 + `?v=` 输出哈希 + BUILD 自检），动态 import 相对路径换算正确。

## 3. 过度防御：平衡点在哪里

先说结论：**本仓的防御绝大多数有真机学费背书，问题不在"多"，而在"组合无上界"与"错误信息失真"**。逐条：

### 3.1 有真机依据、必须保留（审查中特意排除、不要"优化"掉）
- WebUSB 无取消接口 ⇒ 一切传输带超时、超时标脏、收尾先 quiesce 再 HID STOP（scope/spi/adc 三处口径一致）；
- 探针自行掉线重枚举 ⇒ disconnect 监听、claim 失败退避重试、gen 代号防 worker 复活；
- 页面后台钳 1s ⇒ pace.js 纪律本身（问题只在**残留的裸 setTimeout**，见必修 #5）；
- 固件侧 service_gate 字节标志、SWD 全排队主循环、"USB 中断里绝不驱动位翻转引擎"；
- TAR 每次重写 / 1KB 切块 / 块读按实际长度取字 / 地址 `>>> 0`——硬件教训，别动。

### 3.2 失衡点（可收敛，附平衡原则）
1. **组合防御无总预算**（必修 #9、#flash ARCH）——原则：*每层重试可以有，但整条用户操作必须有一条会话级 deadline 兜底，且超时要报"走到哪一层"。*
2. **双层 catch 包装 / finally 顶掉原始错误**（spi-cdc connect、hid/probe 双层包装、bus-periodic stop）——原则：*错误保真：始终抛用户最需要的那条；清理失败用 AggregateError/cause 并行上报，不覆盖。*
3. **形同虚设的外层超时**（dbg memRead 外层 `max(3000, len/32×200)`：32KB 读预算 204s；真正防线是内层 3s+自愈）——原则：*超时只有一层是真实的，多余层删掉，不然报错时状态已脱节。*
4. **文案当协议用**（scope transport 用中文报错正则判定可否重试；busFaultText 承诺自愈）——原则：*控制流判据用 error.code，文案只给人看。*
5. **跨层口径不一的同类防御**（三套"读残渣"判据、隐藏页轮询有的有 hidden 门有的没有）——原则：*同类防御收敛成一个原语（`_readStable` 与 hidden 门都该是共享工具），组合处至少留可观测性（实际轮数/被跳过的拍数）。*

一句话平衡点：**单层防御按最坏真机情况配齐；组合防御必须有界、可观测、错误保真。** 现在的代码在第一句上做得很好，欠的是后两句。

## 4. 调度架构评审

### 4.1 浏览器侧
**总评：分层与互斥骨架成立，四个缺口。**

| 缺口 | 位置 | 后果 | 建议 |
|---|---|---|---|
| heal 绕锁 | `dap-webusb.js:507-522`（必修 #2） | 违反 SWD 交错铁律 | heal 入锁 |
| 双队列插拍 | `riscv-dm.js:270-274`（必修 #4） | DMI 响应互换 | 单队列或校验 addr |
| probe-bus 无自身仲裁 | `core/probe-bus.js:113-166`：两页签同时 requestRelease 互相凑齐 ack 各自放行 | 后认领者撞 claim 失败（正是这层要防的）；当前靠 probe-manager 的 Web Lock 串行化闭合，但 `dbg/session.js:161`、`dbg/riscv.js:105` 绕锁直呼 | requestRelease 内部自加 per-origin Web Lock |
| 隐藏页轮询口径不一 | i2c STATUS 有 `document.hidden` 门（全仓唯一）；hid 桥 2s、spi-cdc 1s、串口定时发送无门 | 后台白抢共享 HID 命令链 | 统一 hidden 门工具 |

另两条记录性说明：`probe-manager.js:95-98` 注释"锁在 setup 后释放"与实现不符（Web Lock 包整个 fn——效果是跨页签全局互斥，可用，但另一页签会无提示排队而非收到交接文案）；`dbg/session.js` 的 exclusive/tryExclusive 不可重入纯靠纪律（嵌套即挂死，建议加一层 `_opDepth` 断言——布尔缺陷修过，重入断言还没有）。

**调度模式盘点（浏览器侧，合并四路）**：

| 原语 | 位置 | 模式 | 风险 |
|---|---|---|---|
| pace.js | `core/pace.js:37-64` | MessageChannel yieldTask / waitMs≤128ms 自旋 / sleep | 纪律原语；残留裸 setTimeout 见必修 #5 |
| USB 互斥 | `rtt/dap-webusb.js:986` `_withLock` | promise 链互斥，显式不可重入 | 锁外 heal 绕过（必修 #2） |
| dbg 互斥 | `dbg/session.js:116/131` | exclusive（用户动作）+ tryExclusive（后台跳拍） | 无重入断言 |
| RISC-V 队列 | `riscv-dm.js:270` | 按 key 分双队列 | 跨队列插拍（必修 #4） |
| 探针 HID 链 | `hid/probe.js:188-207,400-428` | 每设备串行命令链（WeakMap）+ 单 pending + 3s 超时 | 密集节流下超时最长 1min 才报 |
| 探针共享协调 | probe-bus / probe-users / probe-manager / 0x31 停桥 | 四层（跨页签握手+清鬼、页内互斥+失败记忆、僵尸句柄、探针侧让位） | dbg ARM 停桥只认本页签；release 协议无自身仲裁 |
| Viewer 读环 | `rtt/view.js:599-694` | setTimeout 自排程 + `_sessionGen` 守卫 + corrupt 自愈升级 | 后台钳 1s 属"有 UI 告知的知情降级"（数据不丢）✓ |
| scope 数据面 | `scope/transport.js:251-347` | 单 worker + 条件在飞 + 按提交序消费 + STALL 清除≤8 | 收尾纪律由 view._stopData 按序拼装 ✓ |
| spi 数据面 | `spi/transport.js:133-298` | 多 worker + gen 代号 + EP11 drain 收尾 + onError 停死告警 | 良好 |
| adc 数据面 | `analog/transport.js` + worker | worker 优先 + 主线程回退，双实现同构 | 两份校验逻辑需同步维护 |
| 真机定时采集 | `core/bus-periodic.js` + `spi/runner.js:79-99` | 周期上传探针 BPT1，网页只读结果 | 大改进：浏览器节拍只剩假探针路径 |
| 渲染 flush | `core/rxview.js:40`、`display-stream.js:16` | setInterval 60ms，有 isVisible/paused 门 | term.write 抛错会进定时器回调（未捕获） |
| 记录落盘 | `core/recorder.js:165,282` | setInterval 300ms flush，积压记账+告警 | 有意取舍，无内存上限（文档已声明） |

### 4.2 固件侧（akaLinkPro @ 3214872）
**总评：干净。** main.c 协作式单主循环 + `service_gate` union 字节标志（ISR/主循环各写独立字节、无 RMW、天然 volatile）+ **所有 SWD 工作排队主循环**（HID 中断只置 pending，rc=-100=排队中）+ scope↔RTT 互斥靠 api_param 的"桥先停（排队补写 RdOff）、采样器后启（排队）、主循环轮次保证顺序" + bus_periodic 三总线周期引擎（epoch token 防 ABA、结果队列满即停全部"不做留不住结果的写"、辅助作业给 scope/RTT 让路 20ms）+ SPI 桥预算制帧执行与代数机制（区分"硬件作废"与"软件清环"）。自愈链（backoff→清 sticky→重扫 CB→连续 N 次才降档）与 `note_dap_activity` 作废影子缓存的设计都有真机现场注释。

| 缺口 | 级 | 说明 |
|---|---|---|
| bus_periodic dirty 悬挂 | P2 | 必修 #8（I2C DISABLE 时序） |
| HID 单槽请求竞态 | P3 | `bus_periodic_exec`（i2c_bridge.c:905-912）置 req_kind=XFER 执行期间，HID 中断登记的 XFER 会被 `ib_finish` 清掉——窄窗口丢主机请求（主机侧有超时，重发即可）。riscv_svc 的单请求槽同族（协议本就是一问一答，页面不并发时无暴露） |
| scope STOP 借还 CDC 在中断里碰 UART DMA | P3 待验证 | `scope_sampler_stop()`（USB 中断上下文）→ `chry_dap_usb2uart_set_enabled(1)` → `uartx_rx_resync()` 碰 UART DMA 寄存器；i2c 桠曾有"中断里读没开时钟的 IP → CPU 停在 ISR"前科，resync 的实现建议核一眼 |
| tight 采样忙等占主循环 ≤128µs | 说明 | bounded 且 STOP 可打断；CDC/SWO/spi_cdc 主循环服务延迟在此量级，设计意图内 |

### 4.3 跨层契约（值得肯定的三个设计）
1. **HID 一问一答 + rc=-100 排队中**：页面与固件的异步协议只有一条规则，两侧行为可预测。
2. **探针侧桥（0x31）+ 页面级四层协调**：跨页签抢探针这个 WebUSB 时代的核心难题，本仓的解法（BroadcastChannel 握手 + Web Lock + 失败记忆 + 探针侧引擎让位）是最大亮点，也是复杂度高地——B-17/A1 两个缺口都在这层的边角上，修的时候别动骨架。
3. **"错误码即契约"的协议面**（协议字段不夹取、回读对账、err 位是"最近一次错误"）——页面侧严格遵守了"信回读不信状态位"，这让固件的"err 不清零"之类怪癖无害化。

## 5. 附录：本轮验证过、当前为"良好"的高风险点
（供未来复查时不再重查）
- SPI flash 写路径三重防线（地址校验/扇区擦+等 BUSY/非法 hex 抛错）；
- SPI 局部刷新 12 处基准帧失效点 + 发送/读回进度节流；
- serial `_readLoop` 非致命错误内层 catch（继续读、不误判断开）；
- dbg `_opBusy` 已是计数（布尔缺陷已修）；`_bpAt` 地址掩码已走 `fmt.align2`（`>>>0` 后再掩）——view.js:1181 那处是漏网的同族；
- 构建产物防漂移（site/main.js）、gen 模板逐字节对账、`.bat` CRLF+UTF-8 引导段。

---
*四个审查源：A（串口系+共享层，subagent）、B（探针系 4 页，subagent）、C（外设系 5 页）、D（akaLinkPro 固件调度），均为只读读码；A 组附可复跑验证脚本 `tmp/review-i2c-rowmap.mjs`。*
