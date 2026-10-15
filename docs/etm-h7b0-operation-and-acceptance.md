# STM32H7B0 ETM Trace 操作与实板验收手册

更新日期：2026-10-15。读者：接手测试的 AI 或工程师。

本手册的任务是用 **akaLinkPro + Kingst + H7B0 SPI 验证例程**，从网页走通“ELF → 断点 → 时钟 → 联动采集 → 解码 → 源码/轨迹/火焰图 → 保存/重放”，再检查重复操作、停止和恢复。先验证稳定档，不把频率扫描、SWO、PXLogic 实验分支或 USB CDC 收发混进首次验收。

**本提交仅补文档；没有在本次重新连接 H7B0 或重新进行 H7B0 实板测试。** 下述历史数据是对照，不是本轮新通过结果。每个接手者必须留下自己的新日志和采集证据。

## 0. 交接后先做什么

1. 读本文件和仓库的 `AGENTS.md`；在本机多 AI 环境再读 `E:/web-etm-trace-coordination/plan.md`、自己的任务及消息。
2. 查看两个仓库 `git status`，保留别人的改动；记录当前 commit，不默认所有仓库已经同步。
3. **本机上一次实测接的是 F103ZE，CPU48/Trace24，不代表现在已经接好 H7B0。** 先确认用户已换板、探针和 LA 五条线均接到 H7B0。若读到 DEV_ID 0x414/Cortex-M3，停在识别阶段，请用户换板；不向它烧 H7 固件。
4. 确认没有其它网页、OpenOCD、Ozone、pyOCD、另一个 AI 同时控制这台探针或 Kingst。按约定先取得硬件租约，再进行连接/复位/烧录/采集。
5. 首次目标参数固定为下表。其它档位留到稳定档验收完成以后，另开 run-id。

| 项目 | 本轮起点 |
| --- | --- |
| 目标 | 实际板上 STM32H7B0；本例为非 Q 版本、25 MHz HSE、LDO |
| 固件 | `stable-70-35-v1/fw.elf`，不是任意同名 fw.elf |
| CPU / HCLK / 引脚 TRACECLK | 70 / 35 / 35 MHz |
| Trace | ETMv4，4 位并行 DDR，Trace ID 2 |
| 拓扑 | ETM → Funnel → ETF → TPIU → PE2～PE6 |
| ETM 选项 | 分支广播关、返回栈压缩关、周期计数关；先维持此基线 |
| LA | Kingst；500 MSa/s，1 ms 起步，再做 10 ms |
| 通道 | CH0=CLK，CH1～4=D0～D3；对应 PE2、PE3、PE4、PE5、PE6 |
| 阈值 / 取样位置 | 1.65 V / 每个实际半周期后的 0.25 |
| Trace 引脚速度 | 页面值 3，H7“超高速 · 基准值” |
| 业务起点 | `spi_trace_ready`；它在初始化后、while 循环前，仅调用一次 |

## 1. 文件、版本与分工

### 1.1 仓库及本机路径

| 用途 | 本机路径 / 获取位置 |
| --- | --- |
| 本手册 | `E:/web-serial-rtt-tools/docs/etm-h7b0-operation-and-acceptance.md` |
| 主工具仓库 | `E:/web-serial-rtt-tools`；远端 `https://github.com/minichao9901/web-serial-rtt-tools` |
| ETM 源工程 | `E:/web-etm-trace`；远端 `https://github.com/minichao9901/web-etm-trace` |
| H7 SPI 源码 | `<ETM_ROOT>/firmware/stm32h7b0_spi_trace` |
| 封存固件 | `<ETM_ROOT>/firmware/stm32h7b0_spi_trace/stable-70-35-v1/fw.elf`；同目录有 BIN/HEX |
| 工具箱内同一 ELF | `<SERIAL_ROOT>/bridge/etm/backend/firmware/stm32h7b0_spi_trace/stable-70-35-v1/fw.elf` |
| 完整下载包 | `<SERIAL_ROOT>/bridge/etm/downloads/etm-bridge-win64.zip` |
| 包版本/指纹 | `<SERIAL_ROOT>/bridge/etm/downloads/manifest.json`；本手册编写时为 1.0.4 |
| 历史 SPI 基准 | `<ETM_ROOT>/baselines/spi-70-35-v1/README.md`、`manifest.json` |
| 多 AI 协调 | 本机 `E:/web-etm-trace-coordination`；换机器时由接手者明确自己的协调位置 |

`<SERIAL_ROOT>`、`<ETM_ROOT>`、`<KIT_ROOT>` 和 `<RUN>` 在本文是路径占位符，必须替换后再执行命令。GitHub Pages 只托管静态网页，不替本机启动 Python、Kingst 或解码器。

正常使用完整桥包无需另外 clone ETM、安装 Python 或编译 OpenCSD。需要改固件、烧录、做深度 SPI 结构核对时，才需要 ETM 源工程及相应开发工具。SDK/编译器、本地 records 和部分临时产物不保证随普通 clone 获得；缺文件要检查，不能把缺失当作已存在。

### 1.2 固件与网页各自负责什么

| 固件必须负责 | 网页/SWD 可以负责 | 本地服务/LA 负责 |
| --- | --- | --- |
| HSE、供电/LDO、VOS、Flash 延迟、PLL、CPU/HCLK、外设/SysTick 时钟、MPU/缓存、业务程序 | 型号/RCC 回读、ELF 与 Flash 比对、断点、暂停/继续/业务起点复位 | Kingst Socket、采样率、阈值、触发、时长/深度 |
| 业务 GPIO 和 Trace 引脚预留，避免其它外设抢 PE2～PE6 | Trace GPIO 复用/速度、CoreSight 解锁/门控、ETM/Funnel/ETF/TPIU 配置与恢复 | CSV/KVDAT、配套 ELF/源码保存、OpenCSD 解码、记录导入导出 |

普通 SPI 固件不自行开启 ETM。页面填写“HSE=25”或“预期 CPU=70”只是解释和核对 RCC，不会把 MCU 改到这个频率。不要为“让数值变绿”填假晶振，也不要在 Trace 开着时临时乱写 PLL。

## 2. 接线与设备确认

### 2.1 SWD 与 Trace

探针 SWDIO、SWCLK、GND 接 H7 板对应针脚；VREF 按探针设计接目标电压，不能把“电压参考”当作任意供电输出。先确认目标供电正常、信号地共地。

| Kingst | H7B0 | 信号 |
| --- | --- | --- |
| CH0 | PE2 | TRACECLK |
| CH1 | PE3 | TRACED0 |
| CH2 | PE4 | TRACED1 |
| CH3 | PE5 | TRACED2 |
| CH4 | PE6 | TRACED3 |
| GND | GND | 共地，地线尽量短 |

**不是 PE1～PE5，也不是将 D0 接 CH0。** 基线在 Kingst 中使能五路；不要让 CH4 被禁用。不要同时挂两套 LA 探头增加负载。芯片封装/板卡必须实际引出这些脚，不能仅按型号族名称推断可接。

本 SPI 例程另有 PA12/SCK、PC2/MISO、PC3/MOSI、PC8 标记；首次 ETM 只使用上述五路 Trace，不把 SPI SCK 接成 TRACECLK。SPI2 持续轮询发送 100 字节：99 个 `b` 和末尾换行。Trace 中的 TXDR 写入结构不等于已经从线上读出了这些字节值。

### 2.2 启动 Kingst

1. 打开 KingstVIS，确认是真实设备连接状态，没有使用模拟采集。
2. 启用 Socket 接口，通常监听 `127.0.0.1:23367`。优先使用已有已启用实例；不要静默改全局设置或结束别人的 Kingst 进程。
3. 保留五路使能；首次不手动按 GUI 采集按钮，后面由网页联动。
4. 基准曾记录 CH0～4 启用 1 采样点滤波，500M 对应 2 ns。滤波应在 Kingst 中核对，公开 Socket API不能实时配置它；记录保存的 KVDAT 才是本次设置证据，磁盘 vis.config 不代表当前 GUI 实际值。

若需要只读核对 Socket，开发环境可执行：

```powershell
Set-Location 'E:/web-etm-trace'
python -X utf8 tools/la/kingst_la.py info
```

期望返回支持的采样率并包含 500000000；“连不上”时先解决 Socket/进程/端口，不先改 ETM 寄存器。

## 3. 启动正确的 ETM 工作台

### 3.1 推荐：完整桥包

1. GitHub 网页“更多功能 → 工程生成 → ETM 桥”（入口以当前菜单为准）选择 **下载完整 ETM 桥包**。
2. 解压整个目录，不单独拷 EXE，不只下载 BAT。保留 `runtime`、`toolbox`、解码器及其它随包文件。
3. 运行 `check-tools.bat`，预检成功后运行 `start-etm-bridge.bat`；保留其控制台。
4. 使用启动器打印并打开的 **本地 URL**。默认是 `http://127.0.0.1:8878/#etm`，本机既有实例曾用 8888；以实际端口为准。
5. 浏览器“更多功能 → ETM 执行轨迹”。内嵌工作台与主工具同源后才能共享探针管理。

对照文件的检查示例：

```powershell
$serialRoot = 'E:/web-serial-rtt-tools'
$download = Get-Content -LiteralPath "$serialRoot/bridge/etm/downloads/manifest.json" -Raw | ConvertFrom-Json
$actualHash = (Get-FileHash -LiteralPath "$serialRoot/bridge/etm/downloads/etm-bridge-win64.zip" -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $download.sha256) { throw '桥包指纹不匹配' }
$download | Select-Object version,bytes,sha256,sourceRevision
```

只下载“启动文件”不能提供 Python 运行环境和 OpenCSD。升级前保留自己的 `data`；先关闭自己启动的旧桥，再在新目录解压新版，不覆盖正在运行的资源或删除旧记录。push 到 GitHub 不会更新已经解压/运行的桥。

### 3.2 端口与网页常见误解

- 在线静态页显示“请启动本地 ETM 工作台”是预期行为；“打开本地工作台”只是打开 URL，不会双击运行 BAT。
- `ERR_CONNECTION_REFUSED` 表示对应端口没有服务响应。例如本机实际是8888、按钮却开8878。改“工程生成 → ETM桥”的端口或直接打开实际地址；不要据此判断固件或 LA 坏了。
- GitHub 域和 localhost 的浏览器设置分开保存；本地曾设8888，不意味着 GitHub 页面已经记住8888。
- `http://127.0.0.1:<端口>/etm-launcher.json` 可检查运行桥版本/数据目录；`/etm/integration.json` 应返回 protocol=1。后者不是硬件通过证明。
- 本文是仓库里的新增文档，已发布的1.0.4 ZIP未因文档提交自动重新打包。用 Git 仓库/提交读本手册，不假设旧包内已有此 MD。

### 3.3 开发者源码模式（与完整包二选一）

若已有两个源仓库和解码器，可以从主工具目录启动，不要同时让两个进程监听同一端口：

```powershell
Set-Location 'E:/web-serial-rtt-tools'
python -X utf8 -m pip install -r 'E:/web-etm-trace/requirements.txt'
pwsh -NoProfile -File tools/dev/start-etm.ps1 -EtmRoot 'E:/web-etm-trace' -Port 8878
```

该脚本在缺少解码器时尝试构建，需要对应工具链。仅有Python依赖并不能凭空产生 `build-native/etm_decode.exe`。

需要隔离验收记录、又要测工具箱当前随包快照时，另选空闲端口，例如8893，并显式设置专用数据目录：

```powershell
Set-Location 'E:/web-serial-rtt-tools'
$runDir = 'E:/web-etm-trace-coordination/artifacts/h7b0-acceptance/run-请替换为唯一ID'
New-Item -ItemType Directory -Path "$runDir/records" -ErrorAction Stop | Out-Null
$env:WEB_ETM_RECORDS = "$runDir/records"
python -X utf8 tools/dev/serve-etm.py --etm-root E:/web-serial-rtt-tools/bridge/etm/backend --port 8893
```

`WEB_ETM_RECORDS` 重定向针对工具箱 `bridge/etm/backend` 快照。不要假设原始 ETM server.py 也支持同一环境变量。正常验收也可以直接使用完整包的 `data/records`，只新增自己的记录。

## 4. 固件选择、核验与烧录

### 4.1 固定同一份 ELF

首选封存 `stable-70-35-v1`。编写本文时核对的文件指纹：

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| stable-70-35-v1/fw.elf | 2068492 | `4e25c663d9e1dda32e41e8c970afce4b176d996b99b396c9cb2b530b84cd02b2` |
| stable-70-35-v1/fw.bin | 19876 | `4275f9b8873aa602da8e5bf7e7acede3884d2b22fa510f3784dfec5d8e94dad2` |

工具箱内的同路径 ELF 与源工程封存 ELF应相同。网页载入这份ELF，烧录也使用其配对BIN/ELF。不要把新构建 `fw-70.elf`、旧 ARMCC AXF、任意同名 fw.elf 与封存BIN混用。新构建机器码和调试路径可以变化，不保证得到同一指纹。

如确需重建，先检查SDK完整且工具链已安装，再在自己的 worktree 中运行：

```powershell
Set-Location 'E:/web-etm-trace/firmware/stm32h7b0_spi_trace'
pwsh -NoProfile -File ./build.ps1 -CoreMHz 70
```

输出为 `fw-70.elf/.bin/.hex`，不会覆盖封存目录。**脚本默认 CoreMHz=280，首次不要省略70参数。** 重新构建只证明编译完成，不能直接继承封存版本的实板通过结论。

### 4.2 烧录前后的约束

1. 先确认实际目标是 H7B0：识别为 Cortex-M7、DEV_ID低12位0x480，并核对板上型号。0x480也可对应H7A3/H7B3，不能只凭这个数判断具体丝印。封存固件只按上述非Q H7B0、HSE25MHz、LDO板卡验证；硬件不同要先适配固件，不能靠修改网页输入冒充匹配。
2. 浏览器断开探针，关闭自己其它调试会话；硬件锁覆盖烧录、复位、SWD和LA整个串行阶段。
3. 如果需要保留板上原程序，先备份本板实际内部Flash及其SHA256。本例构建上限为128KiB，不使用未公开容量。别把历史的另一块板备份当作当前板备份。
4. 切换固件或RCC前，停止旧Trace并完成ETF/FIFO/TPIU刷新与关闭；不在活动Trace链路上直接换PLL。
5. 现有专用工具可作参考：`<ETM_ROOT>/tools/flash_spi.py 70` 优先使用封存BIN，并检查0x480、停旧Trace、烧录及读回；它会写固定日期的旧报告路径。**接手AI应先审阅，另存本轮输出/报告，不能覆盖历史证据后谎称为新验收。**
6. 其 `restore` 子命令引用2026-10-11那份原板备份，不是“恢复任意当前板”；禁止未经核对拿它恢复新板。
7. 烧录完成逐字节读回验证，记录实际烧入的文件SHA；然后让程序完成时钟/业务初始化。网页不是烧录器，“载入ELF”不会把该ELF写进目标Flash。

在已确认板型、备份且Trace链路已停妥的环境，可由接手者选用自己的烧录流程。不要以普通内存写或反复写AIRCR来代替正式烧录/复位控制。

## 5. 网页：第1页“调试”

### 5.1 ELF、源码和探针

1. 点击“浏览载入 ELF”，选稳定档ELF。记录显示名和SHA前缀，首次就核对完整SHA。
2. 展开“配套源码（可选）”，选择 `<ETM_ROOT>/firmware/stm32h7b0_spi_trace`。该目录同时含 `src` 和 `sdk`，应能匹配ELF的DWARF引用路径；不必选整个E盘。
3. 点击“连接探针”，首次浏览器设备选择由用户完成，选择实际akaLinkPro。不要同时连接另一页的RTT/SWO/调试器。
4. 应识别为 STM32H7B0/H7A3/H7B3族、Cortex-M7、ETMv4，且Trace能力支持。若为F103、其它目标或不支持，停止。
5. 选择源码目录不等于所有函数都会出现源码。用户代码 `spi_trace_ready`、`HAL_SPI_Transmit` 应可对照；`memset` 等库指令可能没有DWARF行号，选更多目录不能补造行号。

### 5.2 设置起点

1. 搜索 `spi_trace_ready`，点前面的“＋”加入断点。
2. 在“断点与采集起点”列表中点该项圆点，确认文本显示它是采集起点。
3. 勾选“联动采集前停在所选断点”和“先复位，再运行至起点”。
4. 首次建议先点“复位至起点”，确认当前PC等于**本ELF**解析出的地址，且暂停原因是所选断点。地址随构建变化，不照抄其它版本的0x地址。
5. 这里只停在初始化后的业务函数，不能把它称为从Reset_Handler开始的完整启动捕获。

`spi_trace_ready()` 在 while 前只调用一次，函数开头尚未执行时，`g_spi_trace.ready` 等诊断字段可能仍为0，不应因此判失败。继续后它才填写频率并置ready=1。

“继续”会经过起点；之后单点“运行至起点”不会自动回到这个一次性初始化函数。要再次从此处抓，使用“复位至起点”或保留“先复位”再联动。想测试不复位再次命中，另选持续调用的 `HAL_SPI_Transmit`，不能用旧起点假等。

## 6. 第2页“时钟”：先确认70/35/35

1. HSE按本板实际值填25 MHz（换板若不是25，不沿用）。
2. 保留“使用RCC回读频率自动填入预期值”，点“重新读取RCC与频率”。
3. 对稳定档应读得CPU70MHz、HCLK35MHz、物理TRACECLK35MHz、PLL1 R输出可用；保留寄存器/配置快照。
4. 如果还在HSI、频率未知、PLL未稳或R输出未启用，先检查是否停在过早初始化位置、固件是否正确、晶振输入是否真实，不能只改页面的预期频率。

本板基准路径：HSE25÷M5=5MHz；N112使VCO560MHz；P8给CPU70MHz；AHB÷2给HCLK35MHz；R8给TRACEPORTCK70MHz；四位DDR引脚TRACECLK=35MHz。

**H7的物理Trace时钟不固定为CPU÷2。** CPU与PLL1_R分别分频；70/35档只是数值恰好如此。例如CPU280/Trace35也能是合法档，但不作为首次基线。35MHz的半周期约14.286ns，500MSa/s约7.14个样点/半周期；这是取样几何，不是保证无误码的电气规格。

## 7. 第3页“采集”：标准设置

| 页面项 | 设置及核对 |
| --- | --- |
| Trace ID | 2 |
| 分支广播 | 取消勾选；额外直接分支地址会增加带宽，关闭仍依靠匹配ELF重建指令流 |
| 返回栈压缩、周期计数 | 均关闭；以后单独验证能力和行为 |
| 引脚驱动 | 3，“超高速 · 基准值” |
| 读取配置/配置并暂停 | 可分别检查编辑值与硬件回读；只编辑未应用时要保留“待应用”提示 |
| 检查连接 | 应显示Kingst已连接，支持500MSa/s |
| 采样率 | 500 MSa/s |
| 时长 | 首次1ms；1ms连续三轮通过后再10ms |
| 阈值 | 1.65V，本板3.3V逻辑基准 |
| CLK/D0～D3 | `0,1,2,3,4`，不重复，不换位 |
| 半周期取样位置 | 0.25 |
| SWD联动，LA就绪后继续CPU | 勾选 |
| 保存后自动解码 | 勾选 |

首次建议保持联动完整路径，不使用“直接采集”绕过ELF/协议/配置核对。H7使用ETMv4回读配置，不传只有traceid的假配置，也不把F103的ETMv3寄存器搬过来。

## 8. 第一次联动采集与通过条件

1. 点击“联动采集”。预期按顺序检查LA、核验ELF与Flash、暂时停用本页断点、复位/运行到所选起点、配置回读Trace、LA就绪、继续CPU、保存、解码、清理及恢复本页断点。
2. `queued → starting → armed → saving → decoding → done` 是正常阶段。不要在armed前先手动继续CPU；也不要再手动按Kingst启动键。
3. 完成后应出现一条新记录，而不是复用旧Demo或LA上一次buffer。记录应绑定本次ELF、协议、时钟快照、阈值、通道、取样位置及KVDAT滤波快照。
4. 观察执行流和函数：应看到 `HAL_SPI_Transmit`，其内部轮询/收尾函数，以及主循环和可能的SysTick；不要求每份短窗的指令数完全相同。
5. 拍下当前页面或保存结构化返回值，并保存原始记录。若失败，先保留错误、PC、采集任务状态及已保存波形，再做单因素修正。

| 检查 | 通过/说明 |
| --- | --- |
| Flash一致 | 确实逐字节核验了当前目标与选定ELF；不能伪造targetVerified=true |
| 解码协议 | ETMv4 |
| 错误 | 解码器lastErrorCode、packetIssues、overflowPackets期望0 |
| 核算 | unprocessedBytes、unaccountedBytes、overlapBytes、unknownSourceBytes期望0；字段缺失写“不可用”，不当作0 |
| 物理数据 | CLK约35MHz、五路使能；所有D位长期恒定要调查，不能只看CLK漂亮 |
| 边界 | 初始化失步、未完成尾帧/同步字单独记录；不能与帧中间持续错误混为一谈 |
| 未知条件 | IT/条件状态可以仍有未知项；保持未知，不以当前RAM倒推历史 |
| 源码 | `spi_trace_ready`/HAL/SPI路径可对照，来源与当前记录ELF绑定 |
| 恢复 | 原Trace设置恢复、本页断点恢复；目标最终运行或暂停状态写清楚 |

零错误只是必要证据之一，不证明完整无损。历史稳定1ms例有47,537条路径、12次闭合SPI发送、每次100次TXDR字节写入；10ms例有484,570条路径、132次闭合发送。**这些是2026-10-11历史对照，不能填进你的新验收结果，更不能把不完全相同的计数直接判为失败。**

## 9. 执行流、Timeline、火焰图和源码怎样检查

1. 在执行流选中一条 `HAL_SPI_Transmit` 指令，右侧源码应定位到其文件/行；前后指令和函数/源码导航应随游标更新。
2. 函数执行轨迹：选中一处，点放大/缩小/fit；检查游标仍指向同一执行序号，放大围绕游标，收起/展开轨迹图后状态合理。
3. 火焰图：分别看“按执行顺序”和“按调用权重”；拖选局部、放大/缩小/fit、返回上级、重置区间。灰色多段聚合块需要放大看细节，不把窄竖线自动理解为图被截断。
4. 收起源码后应给火焰图更多空间，调用深度可向下延展/滚动；再展开源码，点击函数仍能定位。
5. 查看历史调用栈，它是由这份Trace重建的栈，初始祖先/缺口可以未知；不是读取当前寄存器得到的历史栈。
6. 热点/调用统计可以比较本窗口的路径记录、已证实执行及未知部分；不是完整程序覆盖率百分比。
7. 横轴为执行序号。火焰图宽度是路径记录权重，不是函数耗时。启用周期计数不代表当前页面已支持已验收的逐指令时间轴。

## 10. 必测操作顺序矩阵

每项单独记case-id、动作、预期、实际、记录ID和证据；未执行写not-run，不用旧报告补结果。

| case | 操作 | 验收要点 |
| --- | --- | --- |
| H01 | 离线打开随包SPI Demo | 无探针也可浏览、缩放、源码定位；只是离线基线，不算实板通过 |
| H02 | ELF→探针→起点→时钟→1ms | 当前板确为H7，实际70/35/35，完整新记录 |
| H03 | 相同参数连续三轮1ms，均先复位 | 三份新ID、错误/overflow0、无卡死、配置与断点恢复 |
| H04 | 三轮10ms | 同上；不丢失完整业务窗口，记录真实边界和未知项 |
| H05 | 不复位运行至HAL_SPI_Transmit，再采 | 循环函数确可再次命中；不是再次等一次性ready |
| H06 | 不复位等待已经经过的spi_trace_ready | 应有超时/可取消，并保留可操作状态；无自动重置偷换动作 |
| H07 | 等待所选断点时取消 | 停止等待、清一次性断点，后续复位采集成功 |
| H08 | queued/armed阶段请求停止 | 不在停止后继续CPU，不导出旧buffer冒充新数据；停止已确认 |
| H09 | 停止/失败后再正常采集 | 清理确认后可继续；未确认停止时禁止抢新任务 |
| H10 | 编辑ETM选项→读取→应用 | 待应用编辑与实际回读分开；仅改一个选项，恢复基线后再测 |
| H11 | 带同页断点采集 | 采集时挂起、结束后恢复；采后暂停/继续能工作 |
| H12 | 更换ELF、源码和打开历史记录 | 不混用旧协议/旧源码；不允许文件选择回调覆盖活动硬件操作 |
| H13 | 导出etmrecord→重新导入/解码 | ELF/原始输入指纹与主要结果一致，源码无需重新手动选目录 |
| H14 | timeline/火焰图缩放、游标、源码收起 | 按第9节；无控制台异常或游标复位 |
| H15 | ETM断开→其它功能连接→释放→ETM重连 | 单探针仲裁成立，活动采集不被另功能抢走 |
| H16 | 明确恢复调试口 | 如真实故障发生，先保现场，再显式恢复；不把断线当成完成采集 |

保存/解码阶段当前不承诺立即中断本机写文件或OpenCSD子进程；应有超时/阶段提示，不强关进程去伪造“已停止”。不要为了跑H16随意破坏SWD寄存器；人为故障注入、物理拔插/换板可另列授权和隔离案例，未做就not-run。

## 11. 非桌面自动化：给接手AI的边界与接口

### 11.1 可自动化哪些动作

可以用Python管理进程、Socket、文件、原始USB转发；用实际生产JS `EtmTarget` / `WebUsbDapProbe` 驱动SWD。这样是实际硬件控制，不是模拟Trace，但**不等于已验证浏览器WebUSB授权/iframe生命周期**。报告中必须区分这几类。

实际前端在浏览器里测试时，硬件操作应走父页 `ProbeManager`。首次USB选择若需要人工授权，就交由用户完成；不用伪造授权状态或绕过工具限制。

以下是接口时序，不是已运行的完整H7脚本：

```text
检查目标/设备/租约 → 载入与Flash一致的ELF
→ 生产控制器 verifyElf（会暂停CPU）
→ reset({address:本ELF的spi_trace_ready地址}) 或 runTo(循环函数地址)
→ configure({traceid:2,branchBroadcast:false,returnStack:false,cycleCount:false,pinSpeed:3})
→ 使用返回的 target.config、硬件快照发起 capture
→ 轮询 job；仅armed时且未取消，继续CPU一次
→ done后读overview/window，校验质量和业务路径
→ finally停止仍活动的任务、恢复Trace/本页断点、释放探针
```

API前缀是本地集成桥的 `http://127.0.0.1:<实际端口>/etm/api/`，不是独立旧工程的 `/api/`。常用接口：

| 方法/路径 | 作用 |
| --- | --- |
| GET `status` | 只检查Kingst及支持的采样率 |
| POST `elf`（multipart字段elf） | 上传ELF，返回elfId/segments/functions/sourceFiles |
| POST `capture` | 创建采集任务，返回job和record |
| GET `jobs/<job>` | 轮询阶段和错误，不把连接中断当成done |
| POST `stop/<job>` | 请求停止；确认终态/清理，不复用旧缓存 |
| GET `browse/<record>/overview` | 主要质量/计数/硬件快照 |
| GET `browse/<record>/window?fromSeq=...&toSeq=...` | 执行序号范围分析 |
| GET `download/<record>/record` | 可重新解码的完整记录包 |
| GET `download/<record>/simplified-html?fromSeq=...&toSeq=...` | 离线源码执行流 |

capture参数示意（变量由实际运行填充，不能原样提交占位符）：

```javascript
{
  elfId: uploadedElf.elfId,
  rate: 500000000, seconds: 0.001, threshold: 1.65,
  sync: true, decode: true, clock: 0, data: [1, 2, 3, 4], fraction: 0.25,
  config: target.config,             // 必须是此次H7回读的完整ETMv4配置
  targetSnapshot: configuredInfo,
  targetVerified: true,              // 只有真正校验Flash后才可为true
  captureEntry: selectedAddress,
  captureScope: 'business-unfiltered-window',
  libraryOrigin: 'validation'
}
```

实验记录可能默认被隐藏。需要在“文件”页勾“显示实验历史记录”，才能从列表看到 `libraryOrigin=validation` 的新记录。

### 11.2 不要直接照跑的旧脚本

- 工具箱 `tools/selftest/etm-audit-hw.mjs`、`etm-host-reset-hw.mjs`、`etm-integration-hw.mjs` 含F103的48/24MHz、cdc入口和端口/桥假设，不能不改就给H7跑。
- ETM源工程的 `tools/spi-hardware.mjs` / `freeze-spi-70.mjs` 是早期H7流程，含8766/8767及旧probe适配。当前控制器要求安全 `writeMemDiagnostic`，旧适配不一定提供。只能审阅后有针对性适配并保存本轮版本，不能把旧成功摘要当新脚本通过。
- `tools/usb_acceptance_bridge.py` 是本机早期akaLinkPro原始字节适配，固定VID/PID、接口0、OUT2/IN0x81和8768。换探针必须先核对描述符；其它进程占用时不强夺。转发它并不能测浏览器授权/原生USB关闭逻辑。
- 不把通用可重试 `writeMem` 当作AIRCR等控制写的替代；不得故障后无条件重试复位/继续。需要实现安全接口时必须保持生产契约和首次错误。

若还要测Windows应用消息驱动Trace，提前打开Python串口/准备发送器。不能等完整 `run()` 回读确认返回后才发送并假设仍在短采集窗内；此前真实案例证实它会错过20ms窗口。应以实际继续控制写完成事件触发、短暂同步预热后发送，并在Trace中验证目标收发函数存在。**SPI基线不需要Windows串口消息；H7 CDC例程是另一项测试，不能把F103 COM33/hello流程当成此SPI验收。**

## 12. 故障定位表

| 现象 | 先检查/处理 |
| --- | --- |
| GitHub页提示启动本地桥 | 从完整包启动，并打开实际localhost端口；push不启动服务 |
| localhost拒绝连接 | 控制台进程是否活着、8878/8888是否一致；不要改目标固件来修端口 |
| “Unable to claim interface”/USB打开被拒绝 | 让占用者停止并断开，保留现场；不要结束不属于自己的进程 |
| 识别成F103/型号不符 | 板子/探针接错；不强选H7或直接刷H7镜像 |
| CPU/Trace未知或不等70/35 | 实际晶振、ELF/固件档位、是否停在时钟初始化前、PLL1_R输出 |
| 等待spi_trace_ready超时 | 初始化已过去且没有复位；复位至起点，或改选循环函数做不复位测试 |
| 复位停在其它PC | 保存实际/期望PC及DHCSR、DFSR、DEMCR/故障信息，保持暂停；不要反复继续越过异常 |
| “缺少安全控制写接口” | 刷新整个主页面并使用匹配完整桥包；检查自制RPC适配是否过时 |
| armed长时间不触发 | 是否已按正确顺序继续CPU、真实五路是否使能、D0是否接对、是否有其它LA任务 |
| 只有CLK、某D线恒定 | 接线/通道使能/接地/引脚复用；常见为漏CH4/PE6，不能只怪GPIO驱动能力 |
| 无法唯一确定TPIU字节相位 | 先回基准35MHz/500M/.25；核对D0～D3顺序、DDR与滤波，再做离线相位扫描 |
| overflow | 目标Trace输出带宽压力；先确认分支广播关闭和固件正确，不把它直接判为LA采样不够 |
| 保存/解码卡住 | 看阶段/错误、进程、原始文件是否已保存；用停止/超时流程，保留失败记录，不刷新掩盖 |
| 源码选择后仍是机器码 | 看这条指令是否有DWARF；验证用户/HAL指令及匹配路径，区分库函数缺行号 |
| 旧历史源码/选择串档 | 当前记录应使用自身ELF/源码；重新导入包复核，保留状态竞争证据 |
| 停止未确认 | 保留任务ID/LA状态，显式重试停止或人工确认；确认前不启动新任务 |
| SWD故障 | 保存首次错误；用“恢复调试口”显式恢复并回读/核验，未恢复不继续寄存器清理写入 |

数字LA的窄脉冲只能说明采样记录中的边沿，不能仅凭单个2ns样点断言模拟驱动不足。毛刺、缺沿、采样相位与目标FIFO overflow分开分析。原始CSV/KVDAT保留，修改阈值/速度/滤波时一次只改一个参数。

## 13. 验证SPI结构、相位与后续频率

对**同一份封存构建**，源工程 `tools/validate_spi_capture.py <记录目录>` 可检查直接分支落点、闭合 `HAL_SPI_Transmit` 的100次TXDR字节存储。该脚本绑定特定反汇编形式及HAL第959行；新编译器/源码变更时不能照搬硬编码断言，也不为“通过”改统计器而不说明。

它会写记录目录 `spi-validation.json`。只对自己的新记录执行，不覆盖封存基准或他人的只读证据。窗口首尾可以截断一次SPI发送；只统计闭合调用，部分调用单列，不硬凑100。

稳定档成功后，如另有测试频率授权，可保持CPU280，通过R8/6/5/4比较35/46.667/56/70MHz；先独立保存各构建ELF/源配置，每档新run-id。历史35MHz有稳定相位窗，46.667MHz相位敏感，56/70MHz在当时连接下帧校验未通过；这些不是当前LA绝对额定上限。本手册不自动启动扫频，也不要求为首轮验收编译/烧录高频档。

零OpenCSD错误还应结合不同相位产生的ETM字节SHA、重复采集、分支/发送结构和物理波形。不同相位“都无错误”但字节流不同，仍应判为存在歧义；记录原始结果，不只挑成功相位截图。

## 14. 必须交付什么，怎样结束

每次run建立不覆盖的持久证据目录，例如：`<协调目录>/artifacts/h7b0-acceptance/202610xx-唯一ID/`。

交付至少包括：

- 板型/晶振/供电/接线、探针与LA身份、工作台版本/端口及生产代码commit。
- 实际固件ELF/BIN SHA256、Flash校验结果；若重编译则保留参数和源码版本。
- 每case动作/预期/实际、是否通过/失败/not-run，任务ID/记录ID、配置/时钟/滤波快照。
- CSV、KVDAT、etmrecord、解码质量JSON、源码快照；重要证据SHA256。
- UI与非桌面协议测试分别说明；浏览器首次USB授权、关闭/刷新、拔插等未做写not-run。
- 首次失败、修正和复验分别留存，不覆盖失败文件；不用初始化边界冒充完整启动历史。
- 最终CPU运行/暂停、原Trace/断点是否恢复、探针/串口/LA是否释放、只停止自己的临时服务。

成功后先停止仍活动的任务、确认清理，恢复Trace/断点，再按约定让目标保持运行或暂停，断开探针，释放硬件租约。若清理失败，保留现场和锁信息并明确交接，不能假报设备已释放。

如果产生代码修改/提交，提交前审查status/diff、只暂存自己的单一目的改动；正文写问题/修改/真实验证/限制，并保存：`Tested-Revision`、`Tested-Base`、`Tested-Dirty`、`Validation-Result`、`Validation-Run-ID`、命令/工作目录、报告绝对路径与SHA256、`Hardware-Test`。提交后不为补结果amend已共享历史，不擅自push/部署。

### 接手AI最终汇报模板

```text
目标/固件：H7B0；HSE=；供电=；ELF SHA256=；Flash核验=
生产版本：serial commit=；ETM/runtime source=；桥版本/端口=
采集：CPU/HCLK/TRACECLK=；rate=；时长=；阈值=；相位=；滤波=
通过case：...；失败case：...；not-run：...
记录ID/路径：...
质量：错误=；overflow=；未处理/缺口/重叠=；边界=；未知条件=
源码/缩放/游标/源码收起/导入重放：实际结果...
自动化方式：真实网页 / 实际生产JS+原始USB / 其它（分别写明）
最终目标状态/探针/LA/服务/硬件租约：...
报告绝对路径=；SHA256=；原始证据路径=
修改commit=（无修改则写无）；限制与下一步=...
```

## 15. 原始参考与历史边界

- 工具箱启动/集成说明：[etm-integration.md](etm-integration.md)。
- 当前审查与限制：[etm-audit-2026-10-14.md](etm-audit-2026-10-14.md)、[etm-review-followup-2026-10-15.md](etm-review-followup-2026-10-15.md)。
- 封存ELF：[fw.elf](../bridge/etm/backend/firmware/stm32h7b0_spi_trace/stable-70-35-v1/fw.elf)。
- ETM源工程中查阅：`firmware/stm32h7b0_spi_trace/README.md`、`baselines/spi-70-35-v1/README.md`、`docs/SPI例程Trace验收与频率边界.md`。
- 旧频率报告里“当前推荐”等措辞属于当时状态，以封存70/35基准及本次实测为起点；F103近期48/24、72/36结果不能直接当作H7测试通过。
