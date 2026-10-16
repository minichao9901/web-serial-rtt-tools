# ETM 执行轨迹页 · 只读代码审查报告

- **日期**：2026-10-14（会话时间 23:26 +08:00）
- **审查对象**：`web-serial-rtt-tools` @ `6f51462b58a86091c439153753e6eaf3a6473b81`（2026-10-14 22:48；开始审查时工作区干净，审查过程中另有并行会话改动了 `package.json` / `package-lock.json`，见 §9 第 6 条，与本报告无关）
- **参考工程**：`E:\web-etm-trace`（原始 ETM 工程，1130 条记录、docs 齐全；只读引用，未修改）
- **审查范围**：主工具 `#tab-etm` 内嵌页、`bridge/etm` 本地工作台（Python 服务 / 网页 / OpenCSD 解码器）、桥包生成与启动链路、探针仲裁接线、相关自测
- **方法与纪律**：**只读**。未修改/新建/删除仓库内任何文件，未启动服务，未接触探针 / 串口 / KingstVIS。手段 = 逐行读码、`git diff --no-index`、SHA256/字节比对、离线复现（werkzeug 测试客户端 + `%TEMP%` 临时目录、随包 Demo 走真实 `trace_port`）。复现脚本落在 `%TEMP%\etm-audit\`，不在仓库内。
- **结论分级**：E1 起按「高 / 中高 / 中 / 低」编号；每条给出 `文件:行`、证据、影响、修复方向、置信度。「确定」= 代码或实测证据闭环；「较可能」= 机制成立但未在运行时复现；「待验证」= 需要一次真机/真浏览器复核。

> 本报告同时包含**对我方子审查结论的纠偏**（§7）：三条最初被判为高危/中危的结论，经离线实测或代码复核后**不成立**，已从发现清单中剔除。

---

## 1. 结论摘要

1. **功能完整、搬运忠实**。工作台的 ELF 载入、断点与采集起点、时钟核对、ETM/TPIU 配置与恢复、Kingst 联动采集、OpenCSD 解码、执行流 / 调用统计 / Timeline / 火焰图 / 源码对照、历史记录导入导出都在；`bridge/etm` 快照与原工程逐字节一致，出货 ZIP 与仓库快照逐字节一致（§6）。
2. **风险集中在内嵌生命周期，而不是解码正确性**。ETM 标签页一旦进入异常态就**无法自愈**（E1），SWD 故障后清理被整段跳过（E2），且没有任何卸载钩子（E5）。
3. **没有发现会静默产出错误指令流的确定性缺陷**。解码链路的失败基本都是"响的"：无 FSYNC、帧内非法 ID、候选相位不唯一、指令数与反汇编不符、超 200 万条都会抛错。
4. **探针仲裁与安全面（本机回环）设计良好**：`etm` 资源契约与 `EtmView` 四接口一一对应；`directory()` 白名单挡路径穿越；`import` 对 `input` 有白名单（已实测）；`subprocess` 全列表参数无命令注入。
5. **工程债集中在回归覆盖**：6 个 ETM 自测套件**没有任何 make 目标引用**；`make test` 不含 ETM；整仓**没有 ETM 的 CDP 页面套件**（其它页都有）。
6. 出货包自洽性、Demo 管线、探针仲裁契约、采集流程顺序均已实测/逐行核对通过（§6）。

---

## 2. 系统构成与数据流（便于定位）

```
┌─ 主工具页面（同源，由本地桥托管）────────────────────────────┐
│  index.html #tab-etm ── app/etm/view.js (EtmView)            │
│    · fetch /etm/integration.json（protocol 校验）            │
│    · iframe src=/etm/?embedded=1  ← 子页读 window.parent.__tools.etm
│    · 子页 host.attach(bridge,window) 回注桥对象              │
│    · 硬件动作 → host.run(fn) → ProbeManager.run('etm', …)    │
└──────────────────────────────────────────────────────────────┘
            │ tools/dev/serve-etm.py（开发）／ 包内 runtime/serve-etm.py（便携）
            ▼
┌─ ETM 工作台（/etm/ 挂载）────────────────────────────────────┐
│  backend/server.py（Flask：/api/*，记录落 data/records）      │
│  backend/web/app/*（target.js 探针控制、view.js 装配、history…）│
│  backend/tools/*（trace_port → tpiu_demux → etm_decode.exe →  │
│                   decode_trace → flow_analysis）              │
└──────────────────────────────────────────────────────────────┘
```

- 便携包入口：`bridge/etm/etm_bridge.py` → 载入包内 `runtime/serve-etm.py` → 同时托管"工具箱静态副本（toolbox/）"与"ETM 工作台（/etm/）"，因此内嵌是同源。
- 记录目录：便携包 `data/records`（`WEB_ETM_RECORDS`）；开发模式用 ETM 工程自己的 `records/`。

---

## 3. 发现清单

### 3.1 高

#### E1 · ETM 标签页进入异常态后无法自愈（静默白屏 / 探针租约卡死）

**位置**：`app/etm/view.js:16-19`（`onShow` 早退）、`app/etm/view.js:32-38`（`attach` 抛错）、`bridge/etm/backend/web/app/view.js:236`（子页顶层 attach）

**证据**

```js
// app/etm/view.js
async onShow(){ if(this.bridge)return; … }                     // :16-19  已 attach 就永不重载
attach(bridge,child){
  if(child!==this.frame.contentWindow||child.location.origin!==location.origin) throw Error('ETM 页面来源不匹配');
  if(this.bridge&&this.probe)throw Error('请先断开原 ETM 探针再重新载入页面');   // :35
  …
}
```
```js
// bridge/etm/backend/web/app/view.js
const embeddedBridge={probe:()=>target.probe,busy:()=>!!(state.hardwareOperation||target.probe&&(state.job||state.waiting)),…};  // :233
if(host)host.attach(embeddedBridge,window);                    // :236  模块顶层、无 try/catch
window.__etm={target,state,history,api};  init();              // :238-239
```

**机制**：`attach()` 在"探针仍连着"时抛错 → 子页模块求值中断 → `init()` 不执行 → 区域白屏；父页 `frame.load` 回调只在 `!this.bridge` 时提示（`app/etm/view.js:11-14`），因此**没有任何错误提示**。反向地，一旦 `bridge` 已注入，`onShow()` 早退，iframe **再也不会被重载**（"重新检测服务"按钮此时已随 notice 隐藏）。

**影响**：白屏只能靠 F5 整页刷新恢复。更麻烦的是：子页崩在采集任务中途时 `embeddedBridge.busy()` 恒真 → 父页永远放不掉租约 → 其它功能持续报"探针释放尚未确认（etm）…请重连原功能并停止"，而"重连"入口正是那个不会再重载的 iframe。

**修复方向**：`load()` 重载前先让子页释放或允许 attach 覆盖旧 bridge；`onShow()` 增加"已 attach 但子页失联 → 强制重载"分支；子页顶层 attach 包 try/catch 并写 `#job-state`；父页 `load` 回调无论 `bridge` 是否存在都给提示。

**置信度**：确定（代码路径闭环）。

---

#### E2 · SWD 故障时"采集后清理"整段被跳过，目标停在采集态

**位置**：`bridge/etm/backend/web/app/view.js:180`、`web/app/target.js:29`、`web/app/target.js:33-39`

**证据**

```js
// web/app/view.js:180（start 的 withCleanup 清理闭包）
},async()=>{if(sync&&target.probe){target.assertTransport();await target.clearEntryBreak();
  await target.restore();await resumeBreakpoints(suspendedBps);await showTarget(await target.inspect());…}}
```
```js
// web/app/target.js
assertTransport(){if(this.transportFault)throw Error('SWD 已故障，已保留现场；请点击“恢复调试口”后重试');}   // :29
async recoverDebugPort(){ … await this.probe.recoverDebugPort();this.debugFault=false;await this.halt();
  await this.clearEntryBreak();await this.restore();const info=await this.inspect();return info;}            // :33-39 不重下断点
```

**机制**：`assertTransport()` 是清理第一步，`transportFault` 时立即抛错 → `clearEntryBreak / restore / resumeBreakpoints / inspect` 全部不执行。Trace 寄存器留在采集配置，本页 FPB 断点留在"待下发"；`withCleanup` 只记录一行"采集后的清理/回读失败（未覆盖首次错误）"。恢复路径 `recoverDebugPort()` 也不重下断点，但页面提示是"调试口已恢复，目标暂停；请重新联动采集"（`web/app/view.js:150`）。

**影响**：目标状态与 UI 描述不一致；期间的"继续运行"不会再被本页断点拦住。下一次采集或重连探针可自愈（`on('connect')` 会 `breakpoints.resume()`）。

**修复方向**：清理逐步 try/catch（首步失败也继续尝试其余步骤）；`recoverDebugPort` 之后补 `resumeBreakpoints`；UI 显式标出"断点未恢复"。

**置信度**：确定（代码路径闭环；故障注入后的运行时表现未复现）。

---

### 3.2 中高

#### E3 · "直接采集"（不联动）恒按 ETMv4 落盘与解码

**位置**：`web/app/view.js:166,177`、`backend/server.py:562`、`backend/tools/decode_trace.py:26-41`

**证据**

```js
// web/app/view.js
let config={traceid:Number($('traceid').value),config:1},…            // :166  未连探针时的兜底
… }else if(target.config)config=target.config;                        // :177  target.config 只有连接后才存在
```
```python
# tools/decode_trace.py
def decoder_config(config=None):
    protocol = config.get('protocol', 'ETMv4')                        # :28
    …
    elif protocol == 'ETMv4':
        config = {**DEFAULT_CONFIG, **config}                         # :36  补齐 idr1=0x4100F401 等，校验必然通过
```

**机制**：不联动（或已断开探针）时页面上送的 config 只有 `traceid` 与 `config`，`protocol` 缺省为 `ETMv4`；F103 等 ETMv3 目标的字节流会按 v4 寄存器模型落盘与解码。页面当前没有 protocol 输入项。联动路径正常（`config=target.config`，含 protocol）。

**影响**：F103 用户在"直接采集"模式下无法正确解码，且记录里的 config 也是 v4 口径。

**修复方向**：给"直接采集"加协议必填项，或从上次连接 / ELF 推断并明示。

**置信度**：确定（口径链路逐行可追）；解码端的具体报错形态未在真机验证。

---

### 3.3 中

#### E4 · 长操作期间"忙"标记缺失 → 内嵌时探针可被并发抢占

**位置**：`web/app/view.js:192`（载入 ELF）、`web/app/view.js:226`（导入记录）、`web/app/view.js:233`（busy 定义）

```js
$('elf-file').onchange=async()=>{…state.operation=true;controls();…if(target.probe)await target.halt();
  await target.breakpoints.clear();…}                                  // :192  只置 state.operation
const embeddedBridge={…busy:()=>!!(state.hardwareOperation||target.probe&&(state.job||state.waiting)),…};  // :233 不看 state.operation
```

**机制**：这两处都真碰探针，但 `busy()` 为假 → 父页 `ProbeManager` 认为 ETM 不忙 → 别的功能可以拿到租约并在同一条 SWD 上交错访问（本项目已实测过"两次操作交错必读垃圾"）。导入记录（`view.js:226`）整段上传 + 解码期间连 `state.operation` 都没有，探针按钮全亮。

**修复方向**：`busy()` 纳入 `state.operation`，并给 import 补 `state.operation` + `controls()`。

**置信度**：确定（代码路径）；实际撞车概率未实测。

#### E5 · 没有卸载钩子：iframe 单独重载 / 整页刷新可能留下"僵尸认领"

**位置**：`web/app/shared/core/probe-bus.js:47-57`（`closeProbeUsbDevices` 只定义未调用）、`:80`（唯一 `pagehide` 仅广播 `bye`）、`app/main.js:116`（唯一真正 close 的路径）

**机制**：主工具里唯一会 `close()` 探针句柄的路径是**跨页签让位**（另一个页签广播 release → `main.js` 收尾调 `closeProbeUsbDevices()`）。刷新 / 关页签 / iframe 被销毁都不会主动关句柄，而"只丢 JS 引用不 close"正是本项目 `Unable to claim interface` 的既有成因。这是全工具形态，但 ETM 是第一个住在 iframe 里的功能——iframe 单独销毁而父页存活的情况只有它会遇到（与 E1 叠加）。

**修复方向**：子页（或父页）挂 `pagehide`/`beforeunload` 走一次 `close()`；至少让 E1 的重载路径先释放。

**置信度**：较可能（机制与既有教训一致；浏览器侧未复现）。

#### E6 · 短等待用 `setTimeout`，违反本仓 pace.js 纪律

**位置**：`web/app/target.js:11` 定义 `sleep`，被 `:94`（`wait()` 80×10 ms）、`:183`（运行至起点轮询）、`:207`（AIRCR 后 60 ms）、`:209`（等待 S_HALT）使用

**机制**：页面不可见时浏览器把短延时钳到 ≥1 s（本仓真机实测过 1.4 s → 47 s）。共享驱动 `app/rtt/dap-webusb.js` 已全量改用 `waitMs/yieldTask`，工作台这一层仍是旧写法。

**修复方向**：换 `app/core/pace.js` 的 `yieldTask/waitMs`（工作台已有 `shared/core/pace.js`）。

**置信度**：确定（写法与影响机制均已在本仓验证过）。

#### E7 · 采集任务无超时/无取消，"停止"只在两个状态可用

**位置**：`web/app/view.js:144-148`、`backend/server.py:593-596`

```js
$('stop').disabled=!['starting','armed'].includes(job.state);          // :144
```
```python
if jobs[jid]['state'] not in ('starting','armed'): …                    # :593-596
```

**机制**：job 卡在 `queued/saving/decoding` 时，所有操作按钮 + 停止一起变灰；`watchJob` 没有超时。用户唯一动作是刷新。

**修复方向**：停止对全部非终态放行，或至少给出"记录在哪 / 日志在哪"的提示；`watchJob` 加超时。

**置信度**：确定（代码路径）。

#### E8 · 本机服务来源校验形同虚设（Host 自证）

**位置**：`backend/server.py:37-42`、`tools/dev/serve-etm.py:52-54`

```python
@app.before_request
def local_only():
    if request.remote_addr not in ('127.0.0.1', '::1'): abort(403)
    if request.method != 'GET' and request.headers.get('Origin') not in (None, request.host_url.rstrip('/')):
        abort(403)                                                     # :41  Host 头由客户端控制
```

**机制**：`request.host_url` 来自 `Host` 头，DNS rebinding 场景下 `Host` 与 `Origin` 同为攻击者域 → 守卫放行；且**所有 GET（记录读取、browse、download）完全不校验来源**。`serve-etm.py` 外层只查 `remote_addr`。现代浏览器对"公网页面访问私网地址"有 PNA / Local Network Access 限制，会削弱可读性，故定级为"中"。

**修复方向**：写死白名单（`http://127.0.0.1:<port>`、`http://localhost:<port>`、线上 Pages 来源）+ 校验 Host；GET 同样纳入。

**置信度**：确定（校验逻辑）；实际可利用路径标"较可能"。

#### E9 · 下载端点不复校验 `input`（纵深防御缺口）

**位置**：`backend/server.py:632-638`、`:643`

```python
if kind in ('raw','kvdat'):
    m = meta(sid)
    file = folder / (m['input'] if kind == 'raw' else 'capture.kvdat')   # :637
    return send_file(file, as_attachment=True)
```

**实测**：本地手工放置 `session.json` 含 `"input": "../../outside-secret.txt"` 时，`GET /api/download/<sid>/raw` 返回 **HTTP 200 + 记录目录之外的文件内容**（见 §7 复现脚本 Case C）。远端不可达（import 侧有白名单），但任何"从别处拷来的记录目录 / 其它工具生成的 session.json / 手工解压的 .etmrecord"都会命中。

**修复方向**：下载侧重新校验为固定白名单值（或与 `input` 分离出只读的 `sourceName` 字段）。

**置信度**：确定（已实测）。

#### E10 · 包内缺固件 → 3 个端点成"死 API"

**位置**：`backend/server.py:196-203`、`:206-221`、`:262-276`

`/api/default-elf`、`/api/firmware` 指向包内不存在的 `firmware/stm32h7b0_etm_board_v1/fw.elf`；`PROFILES` 中 `fixture / spi-140 / spi-140-r8 / spi-280*` 同样不在包内（包内只有 `stm32f103_cdc_trace/fw-ze.elf`、`stm32h7b0_spi_trace/stable-70-35-v1/fw.elf`）。当前前端未调用这些端点（已 grep 确认），属"误导性错误 + 手工调用踩坑"。

**修复方向**：删除或改写这些端点，或在 `elf_info` 前统一 `exists()` 检查并返回"该档未随便携包提供"的明确 4xx。

**置信度**：确定。

#### E11 · 几处"非原子 / 不回收"的持久化与任务

| 项 | 位置 | 机制与影响 |
|---|---|---|
| Demo 播种非原子 | `bridge/etm/etm_bridge.py:19-26` | 先 `folder.mkdir()` 再写 6 个成员 + 解压 27 MB；中途失败留下**永久半成品**（下次启动因 `folder.exists()` 直接 return）。当前包内容完整、实测播种正常 |
| `decoded.json` 非原子写 | `backend/server.py:82`、`:412`、`:374` | 几十 MB JSON 直接 `write_text`；中断/并发读会拿到半截文件，且没有"结果损坏，请重新解码"的提示 |
| `jobs` 只增不减 | `backend/server.py:33-34`、`:385-394`、`:423-428` | 无 TTL、无丢弃；`/api/decode` 不判重 → 可叠加多条解码线程与 `etm_decode.exe` |

**置信度**：确定（写法）。

---

### 3.4 低

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| E12 | 标签页"打开本地 ETM 工作台"硬编码 `8878` | `index.html:84`；端口可改于 `app/gen/view.js:60,135` / `#g-etm-port` | 用户改端口后该链接失效（同源检测不受影响） |
| E13 | 内嵌模式报错文案指向"更新完整 ETM 桥包" | `web/app/target.js:32` | 内嵌时驱动来自主工具，应提示刷新主页面 |
| E14 | `#tab-etm` 上方注释写"串口助手" | `index.html:78` | 复制粘贴残留 |
| E15 | **6 个 ETM 自测套件无任何 make/文档引用**：`etm-host-control`、`etm-source-ui`、`etm-integration-hw`、`etm-host-reset-hw`、`test_etm_portable`、`test_etm_launcher`；`make test` 不含 ETM；无 CDP 页面套件 | `Makefile:40-45`、`:100`、`:342-345` | 详见 §5.3；本轮我手动跑了 4 个纯 Node 套件，全绿 |
| E16 | 嵌入改写是字符串替换（`href="/` → `href="/etm/`） | `tools/dev/serve-etm.py:29-45` | ETM 侧 index.html 换引号/属性顺序即静默失效；Python 测试用合成页，真实页无守卫 |
| E17 | 三处"每次交互全量重建" | `web/app/view.js:59-67,87`（`oninput=renderSymbols` 无防抖，每次重建全部函数行）、`web/app/history.js:129-131`（每次选中整文件重建源码 DOM）、`web/app/function-timeline.js:17-22`（每帧 `canvas.width/height` 重建 backing store；收起时隐藏的是外层 `<section hidden>`，canvas 自身 `hidden` 仍为 false，重绘保护不生效） | 大工程下卡顿；无 O(n²) |
| E18 | 独立模式 `ProbeBus._on` 不校验请求方 | `web/app/shared/core/probe-bus.js:98-120` | 同源任一页面广播 release 即可让采集中断并 restore（本工具自身页签是可信面，属加固项） |
| E19 | 驱动层既有项（非 ETM 引入）：DP 上电 ACK 掩码 `0x30000000`（代码自述"已知、有意保留"）；`_dhcsr()` 未走 `_withLock` | `app/rtt/dap-webusb.js:844`、`:1235-1238` | 属全工具共享驱动，改动需逐板真机验收 |
| E20 | CSV 编码探测只试一次 UTF-8 后一律 GB18030；`min_data_transition_distance_ns` 只进报告不进 quality | `backend/tools/trace_port.py:16-24`、`:174-176` | 导出环境变化时可能按错编码解出乱码表头；采样裕量（本机 Demo 实测 2.5 ns）不阻断也不在页面提示 |

---

## 4. 与原工程的对照（是否引入回归）

| 层 | 对照结果 |
|---|---|
| 后端工具 | `tools/` 下 7 个 `.py` + `tools/la/kingst_la.py` 与原工程 **SHA256 逐字节相同** |
| 后端服务 | `server.py` 仅 2 处本地适配：`+import os`、`RECORDS = Path(os.environ.get('WEB_ETM_RECORDS', …))` |
| 原生解码器 | `native/decoder.cpp` 仅加 Windows UTF-16 路径/argv 适配（由 `tools/dev/sync-etm-runtime.py` 生成） |
| 工作台前端 | `bridge/etm/backend/web` 24 个文件与原工程 `web/` **SHA256 全同** |
| 集成层（新增） | `tools/dev/serve-etm.py`（`/etm/` 路径改写、`data-embedded` + `/etm/api/` 注入、两个按钮搬家、header 隐藏、布局补偿）、`app/etm/view.js`、`app/core/probe-users.js` 的 `etm` 条目、桥包生成/启动链路 |

**结论**：没有功能性删减。E2/E5/E6/E18 属**继承缺陷**（原工程同样存在），修复时两个仓库需要同步；E1 是集成层新增（内嵌特有）。

---

## 5. 已核对为正常（证据）

### 5.1 出货包自洽（实测哈希）

| 检查 | 结果 |
|---|---|
| ZIP SHA256 vs `downloads/manifest.json` | `7cdfae651f9324c8a302e6e2292fb39db03ea60437ae9a71934ce1fd43b7d3f8` **一致** |
| ZIP 大小 | 24,472,245 B **一致**；`zipfile.testzip()` **OK**（508 条目） |
| 包内 `runtime/backend/**` vs 仓库快照 | **57/57 逐字节相同**（0 缺失、0 差异） |
| 包内 `toolbox/**` vs 仓库 | **188/188 逐字节相同**（含 `index.html` 的 bundle 开关改写） |
| 包内驱动是否含新接口 | `toolbox/app/rtt/dap-webusb.js` 含 `writeMemDiagnostic`、`recoverDebugPort`，且与仓库 `app/rtt/dap-webusb.js` **逐字节相同** |
| `provenance.json` 的 `packagedHashes` | **0 处不匹配** |
| 包内 `toolbox` 是否含 ETM 入口 | `index.html` 含 `tab-etm` / `etm-frame`；`app/etm/view.js`、`app/gen/etm-kit*.js`、`docs/etm-integration.md` 均在 |

### 5.2 随包 Demo 走真实解码前置（离线实测）

从 `backend/demo/sample.etmrecord` 取出 `capture.csv`（3,016,828 B），调用**随包的** `trace_port.extract(csv, 0, [1,2,3,4], 0.25)`：

| 量 | 实测 | 与原始工程验收记录对照 |
|---|---|---|
| CH0 跳变 | 70,000 / 1 ms | — |
| `clock_hz_average` | **35.000 MHz** | 35 MHz ✓ |
| `clock_hz_median` | 35.714 MHz（2 ns 量化） | ✓ |
| `half_period_ns` | 14.0 | ✓ |
| `min_data_transition_distance_ns` | **2.5 ns** | 原始记录"0.25 处最小跳变距离约 2.5 ns" ✓ |
| 候选相位 | phase 1 = 2337 个 FSYNC 匹配（phase 0 = 0） | 唯一相位 ✓ |
| `clock_gaps` | 0 | ✓ |

### 5.3 自测实跑（纯 Node，离线）

| 套件 | 结果 | 是否被 Makefile 引用 |
|---|---|---|
| `tools/selftest/etm-ownership.test.mjs` | PASS | 是（`test-etm-integration`） |
| `tools/selftest/etm-host-control.test.mjs` | 5/5 PASS（控制写只发一次、不读回、不触发 healer、遗留驱动先拒绝、恢复不动 CPU） | **否** |
| `tools/selftest/etm-source-ui.test.mjs` | 2/2 PASS | **否** |
| `tools/selftest/etm-kit.test.mjs` | PASS（启动文件身份 / 编码 / ZIP） | 是（`test-gen`） |
| `test_etm_portable.py` / `test_etm_launcher.py` / `etm-integration-hw.mjs` / `etm-host-reset-hw.mjs` | 未运行（需 `VALIDATION_DIR` / 真机） | **否** |

### 5.4 其他核对

- **探针仲裁契约**：`app/core/probe-users.js:36-40` 的 `etm` 资源声明（`target-engine/debug-pins/dap-bulk/probe-clock`）与 `EtmView` 的 `probe / busy / releaseProbe / summary` 一一对应；`ProbeManager.run()` 的租约靠 `client.active()` 保留（`app/core/probe-manager.js:91`），ETM 的 `active` 正是"探针已连"，语义正确。
- **前后端契约**：工作台只有一处 fetch 基址（`web/app/view.js:12` 的 `document.body.dataset.apiBase||'/api/'`），无绝对 `/api/` 硬编码；ELF 下载地址用 `request.script_root` 保挂载前缀（有 Python 测试）；`index.html` / `style.css` 无绝对资源引用，`url(/`)` 为 0。
- **安全面**：仅绑 `127.0.0.1`；`directory()` 字符白名单挡路径穿越（`server.py:52-55`）；`import` 的 `input` 白名单实测生效（§7）；`subprocess` 全列表参数；`MAX_CONTENT_LENGTH=150 MB` 且页面把 413 转成友好文案。
- **采集流程顺序**（`web/app/view.js:168-179` 逐行核对）：`verifyElf → 挂起本页断点 → 复位/运行至起点 → 核对实际时钟（不符即中止且保持暂停）→ configure → 建任务 → 仅 armed 才继续 CPU`。
- **断言类**：断点只租空闲 FPB 槽、不越权开 FPB（`web/app/breakpoints.js:38-41`）；跨源 `attach` 明确失败；全库无 `innerHTML` / `insertAdjacentHTML` / `eval` / `new Function`（无 HTML 注入面）。

---

## 6. 与父页面（主工具）接线的核对

| 项 | 位置 | 结论 |
|---|---|---|
| 菜单与标签 | `index.html:56`（更多功能 → ETM 执行轨迹）、`:79-87`（`#tab-etm` / `#etm-notice` / `#etm-frame`） | 正常；`:78` 注释残留（E14） |
| 服务探测 | `app/etm/view.js:24` `fetch('/etm/integration.json')` + `protocol!==1` 校验 | 正常；非本地托管时给明确提示 |
| iframe | `index.html:86` `allow="usb" hidden`，`view.js:28` 赋 `src=/etm/?embedded=1` | 同源 + 权限策略齐备 |
| 探针让位 | `probe-users.js:39` `release → releaseProbe()`、`guarded → busy` | 正常（`etm-ownership` 覆盖） |
| 驱动来源 | `app/etm/view.js:5` `probeType=WebUsbDapProbe` → 子页 `target.js:15` 优先用它 | 内嵌时驱动单一真源，版本漂移风险被规避 |
| 桥包下载 | `app/gen/view.js:555-570` 拉 manifest → 拉 ZIP → `crypto.subtle` 校验 SHA256 → 保存 | 正常；24 MB 全量入内存（可接受，可改流式） |
| 启动文件包 | `app/gen/etm-kit.js:10-37`（5 个文件，BAT 强制 CRLF、PS1 带 BOM） | 正常（`etm-kit.test.mjs` 覆盖） |

---

## 7. 复核纠偏：三条被否定的重结论

审查过程中先出现三条"高危/中危"结论，经离线实测或代码复核**不成立**，在此留档以免后人重复追：

### 7.1 「crafted `.etmrecord` 造成任意文件读」→ 不成立

**原始主张**：导入时 `session.json` 的 `input` 可被写成 `firmware.elf` 等任意名，随后 `download raw` 据此读该记录目录内任意文件。

**复核结论**：导入侧白名单在**成员拷贝之前**执行，`save()` 存的就是被校验过的同一份 dict，`input` 无法被污染。

**实测**（werkzeug 测试客户端 + `%TEMP%` 临时 records 目录，见附录 A）：

```
--- Case A: session.json 声明 input=firmware.elf ---
HTTP 400 -> {'error': '记录格式无效。'}
--- Case B: 合法 input=capture.csv，同时夹带 firmware.elf ---
HTTP 200 -> {'record': 'record-e5c2fabd…'}
磁盘上的 session.json input = 'capture.csv'
GET /api/download/<sid>/raw -> 200 b'CAPTURE-BYTES\n'
是否读到 firmware.elf(ELF 魔数) = False
--- Case C: 本地手工放置的 session.json 带 ../ 穿越 ---
GET raw -> 200 b'TOP-SECRET\r\n'     ← 穿越成功（＝本报告 E9，本地可达、远端不可达）
```

### 7.2 「TPIU 解复用不在帧边界重新对齐，会静默错数据」→ 不成立

`tools/tpiu_demux.py:38` 的 `if not frame and raw[position:position+4]==FSYNC` **恰好在每个 16 字节帧边界**（`frame.clear()` 之后）复核同步码；帧内出现 `FF FF` 直接 `raise`（`:47-50`，不静默拼接）；`frame` 非空时出现 FSYNC 也不会被当同步吞掉。真实残余风险仅是"数据突发内部错位且期间不出现同步码"——所有 TPIU 接收器同理，不足以定为缺陷。

### 7.3 「`clock_hz_average` 多除了 2，频率差 2 倍」→ 不成立

`tracks[clock]` 记录的是**该通道的全部电平跳变**（半周期一个），跳变率 = 2f，因此 `(edges-1)/duration/2` 得到的就是时钟频率。随包 Demo 实测 35.000 MHz（§5.2），与原始工程验收值一致。

---

## 8. 修复优先级建议

| 优先级 | 条目 | 一句话动作 |
|---|---|---|
| **P0** | E1 / E2 / E5 | ETM 标签页可自愈 + 清理逐步容错 + 卸载时释放探针 |
| **P1** | E3 / E4 / E7 | 直接采集的协议口径、忙标记纳入 `state.operation`、任务超时与停止放行 |
| **P2** | E8 / E9 / E10 / E11 | Host/Origin 白名单、下载侧复校验、死 API 收敛、原子落盘与 job 回收 |
| **P3** | E15 + 其余低危 | 把 6 个 ETM 套件接进 Makefile，补一个 ETM 的 CDP 页面套件（防 E1/E3 类回归的唯一自动化手段） |

**建议的验收口径**（改完后）：

1. `node tools/selftest/etm-ownership.test.mjs`、`etm-host-control.test.mjs`、`etm-source-ui.test.mjs`、`etm-kit.test.mjs` 全绿；
2. 新增 CDP 套件覆盖：`#tab-etm` 无服务时的提示、`/etm/integration.json` 就绪后的 iframe 载入、`attach` 成功/失败两条路径、`pagehide` 后接口可被重新认领；
3. 真机一次：F103ZE 联动采集 3 轮（对照 `docs/etm-integration.md` 的 174786/174785/174786 条指令、overflow 与包错误为 0）；
4. 故障注入一次：采集途中制造 SWD FAULT，确认 trace 配置与断点都被恢复。

---

## 9. 覆盖不到的部分（如实说明）

1. **没有真机、没有真浏览器**：E1/E2/E4/E5/E7 的运行时表现只有代码级证据（机制可复核，未复现）；F103/H7B0 真机链路、KingstVIS 采集本次一律未跑。
2. KingstVIS 未接入 → GBK CSV 的真实导出路径、DDR 相位在现场的表现未验证。
3. 未审计共享驱动 `app/rtt/dap-webusb.js` 的 SWD 协议实现本身（超出 ETM 范围，E19 只做登记）。
4. 未解压运行 `etm-bridge.exe`（PyInstaller 包只做静态一致性核对与哈希比对，未执行）。
5. `test_etm_portable.py`（便携包端到端）与两个真机脚本未运行：需要 `VALIDATION_DIR` / 设备 / 浏览器授权。
6. **并行改动提示**：本次审查期间（2026-10-14 22:58:29），工作区里的 `package.json` 与 `package-lock.json` 被**另一个并行会话**改动（新增 `linkedom@0.18.12` devDependency），不属于本报告的审查范围，也**不是**本次审查所为——本报告的写入只新增了 `docs/etm-page-review-2026-10-14.md` 一个文件。该改动会影响 `npm run build:web` / `make check` 的工具链，请在提交前自行确认归属与意图。

---

## 附录 A · 离线复现脚本

以下脚本落在 `%TEMP%\etm-audit\`，**不写入仓库**；Windows 上直接 `python <脚本>` 即可复现。共同约定：`WEB_ETM_RECORDS` 指向临时目录，werkzeug 测试客户端需要 `environ_overrides={'REMOTE_ADDR':'127.0.0.1'}`（否则 `local_only` 一律 403）。

### A.1 导入白名单与下载穿越（§7.1）

```python
import importlib.util, io, json, os, sys, tempfile, zipfile
from pathlib import Path
SNAP = Path(r'E:\web-serial-rtt-tools\bridge\etm\backend')
tmp = Path(tempfile.mkdtemp(prefix='etm-audit-'))
os.environ['WEB_ETM_RECORDS'] = str(tmp / 'records')
spec = importlib.util.spec_from_file_location('etm_server_audit', SNAP / 'server.py')
server = importlib.util.module_from_spec(spec); sys.modules['etm_server_audit'] = server
spec.loader.exec_module(server)
from werkzeug.test import Client
from werkzeug.wrappers import Response
client = Client(server.app, Response)
LOCAL = {'REMOTE_ADDR': '127.0.0.1'}
elf_bytes = (SNAP / 'firmware/stm32f103_cdc_trace/fw-ze.elf').read_bytes()

def make_record(input_name):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('session.json', json.dumps(dict(input=input_name, name='crafted', config={}, fraction=.25)))
        z.writestr(input_name, b'CAPTURE-BYTES\n')
        z.writestr('firmware.elf', elf_bytes)
    buf.seek(0); return buf

def post_import(buf):
    return client.post('/api/import', data={'capture': (buf, 'crafted.etmrecord')},
                       content_type='multipart/form-data', environ_overrides=dict(LOCAL))

print('Case A', post_import(make_record('firmware.elf')).status_code)          # 期望 400
r = post_import(make_record('capture.csv')); print('Case B', r.status_code)     # 期望 200
sid = r.get_json()['record']
print('input on disk =', json.loads((server.RECORDS / sid / 'session.json').read_text('utf8'))['input'])
print('raw bytes =', client.get(f'/api/download/{sid}/raw', environ_overrides=dict(LOCAL)).get_data()[:14])
outside = tmp / 'outside-secret.txt'; outside.write_text('TOP-SECRET\n', encoding='utf8')
bad = server.RECORDS / 'record-manual'; bad.mkdir(exist_ok=True)
(bad / 'session.json').write_text(json.dumps(dict(input='../../outside-secret.txt')), encoding='utf8')
print('Case C traversal =', client.get('/api/download/record-manual/raw',
      environ_overrides=dict(LOCAL)).get_data()[:12])                            # 期望 b'TOP-SECRET\r\n'
```

### A.2 随包 Demo 走真实 `trace_port`（§5.2）

```python
import importlib.util, sys, tempfile, zipfile
from pathlib import Path
SNAP = Path(r'E:\web-serial-rtt-tools\bridge\etm\backend')
tmp = Path(tempfile.mkdtemp(prefix='etm-demo-'))
with zipfile.ZipFile(SNAP / 'demo/sample.etmrecord') as z:
    (tmp / 'capture.csv').write_bytes(z.read('capture.csv'))
sys.path[:0] = [str(SNAP / 'tools'), str(SNAP / 'tools/la')]
spec = importlib.util.spec_from_file_location('trace_port_audit', SNAP / 'tools/trace_port.py')
tp = importlib.util.module_from_spec(spec); sys.modules['trace_port_audit'] = tp
spec.loader.exec_module(tp)
report = tp.extract(tmp / 'capture.csv', 0, [1, 2, 3, 4], 0.25)[0]
for k in ('clock_edges', 'clock_hz_median', 'clock_hz_average', 'half_period_ns',
          'min_data_transition_distance_ns', 'candidates'):
    print(k, '=', report[k])
```

### A.3 出货包一致性（§5.1）

```python
import hashlib, json, zipfile
from pathlib import Path
root = Path(r'E:\web-serial-rtt-tools')
z = root / 'bridge/etm/downloads/etm-bridge-win64.zip'
man = json.loads((root / 'bridge/etm/downloads/manifest.json').read_text('utf8'))
print('zip sha256 match :', hashlib.sha256(z.read_bytes()).hexdigest() == man['sha256'])
zf = zipfile.ZipFile(z); print('testzip :', zf.testzip() or 'OK')
snap = root / 'bridge/etm/backend'; diff = miss = 0
for p in snap.rglob('*'):
    if not p.is_file(): continue
    key = 'etm-bridge-kit/runtime/backend/' + p.relative_to(snap).as_posix()
    if key not in zf.namelist(): miss += 1
    elif hashlib.sha256(zf.read(key)).hexdigest() != hashlib.sha256(p.read_bytes()).hexdigest(): diff += 1
print('backend missing/diff :', miss, diff)
tb = [n for n in zf.namelist() if n.startswith('etm-bridge-kit/toolbox/')]
print('toolbox entries :', len(tb))
```

---

## 附录 B · 相关文件索引

| 主题 | 文件 |
|---|---|
| 主工具内嵌页 | `app/etm/view.js`、`app/etm/style.css`、`index.html:56,79-87,2055-2058,2132-2143` |
| 探针仲裁 | `app/core/probe-users.js`、`app/core/probe-manager.js`、`app/core/probe-bus.js`、`app/main.js:103,115-116` |
| 桥包生成/启动 | `app/gen/etm-kit.js`、`app/gen/etm-kit-src.js`、`app/gen/view.js:538-570`、`tools/dev/embed-etm-kit.mjs`、`tools/dev/etm-launcher.ps1`、`tools/dev/start-etm.ps1`、`tools/dev/build-etm-package.py`、`tools/dev/sync-etm-runtime.py` |
| 本地服务 | `tools/dev/serve-etm.py`、`bridge/etm/etm_bridge.py`、`bridge/etm/backend/server.py` |
| 工作台前端 | `bridge/etm/backend/web/index.html`、`web/app/{view,target,target-f103,history,analysis-views,function-timeline,clock,breakpoints,embedding,operation,trace-options,zoom-controls,source-snapshot}.js`、`web/app/shared/**` |
| 解码管线 | `bridge/etm/backend/tools/{trace_port,tpiu_demux,decode_trace,flow_analysis,record_store,source_export,breakpoint_resolver}.py`、`tools/la/kingst_la.py`、`native/decoder.cpp` |
| 自测 | `tools/selftest/{etm-ownership,etm-host-control,etm-source-ui,etm-kit}.test.mjs`、`tools/selftest/{test_etm_server,test_etm_launcher,test_etm_portable}.py`、`tools/selftest/etm-integration-hw.mjs` |
| 文档 | `docs/etm-integration.md`、`bridge/etm/README.md`、`bridge/etm/provenance.json` |

---

## 附录 C · 与原始工程记录的对齐点

| 本报告结论 | 原始工程记录（`E:\web-etm-trace\docs\`） |
|---|---|
| ETM 页面能力清单（ELF/断点/时钟/采集/执行流/Timeline/火焰图/源码） | `交接摘要_2026-10-11.md` §4 |
| 已知能力边界（条件指令 unknown、火焰图非耗时、无变量面板、长记录整载） | `交接摘要_2026-10-11.md` §6 |
| 内嵌集成的分工（子页注入父页驱动、关闭子页 BroadcastChannel、历史读取不占目标资源） | `工具箱内嵌集成.md` |
| F103ZE 联动验收数字（48/24 MHz、500 MSa/s、10 ms、三轮 174786/174785/174786） | `工具箱内嵌集成.md`、`docs/etm-integration.md` §当前验收 |
| Demo 的 35 MHz / 2.5 ns / FSYNC 特性 | `F103ZE-ETMv3-解码验收.md`、`SPI例程Trace验收与频率边界.md`（本报告 §5.2 已离线复现） |

---

*本报告为只读审查产物，不包含任何代码改动；本次写入只新增本文件（`docs/etm-page-review-2026-10-14.md`）。若需要针对 P0/P1 的具体改动方案（含补丁草案与验收脚本），可另开一轮。*
