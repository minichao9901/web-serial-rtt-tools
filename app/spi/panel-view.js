/**
 * 「SPI/QSPI 屏」页（`#panel`）—— 把屏点亮那一页：**面板初始化代码** + **图片/图案刷屏**。
 *
 * 与「SPI/QSPI 桥」页（`#spi`）共用同一个 `SpiSession`（一次连接，两页共用）：
 * 基础配置（SCLK / CS 策略 / 通用辅助脚）归桥页；这里只做屏相关的事，并且能按屏型号**一键套用推荐值**。
 *
 * 三块内容：
 *   1. **面板初始化**：一个大文本框 —— 把 C 数组贴进来（或载入内置示例 / 文件）→ 解析成步骤表 →
 *      重放全部 / 单发 / 从此重放。解析器在 `panel-code.js`（纯函数，Node 自测 71 项）。
 *   2. **图片 / 图案**：内置图案现画现发；BMP 自己解析、PNG/JPEG 交给浏览器解码 →
 *      摆放/对齐 → RGB565 → 492 B 切片 → 开窗 + 像素帧（`image.js`，同样是纯函数）。
 *   3. 复位 / 显示、面板档、按屏套用推荐值。
 *
 * 预览里显示的是**量化后的样子**（走一遍 565 往返 + R/B 交换 + 电平），所以"预览 == 发出去的"。
 */
import { $, setStatus, appendLogLine } from '../ui/dom.js';
import { store } from '../core/store.js';
import * as P from './protocol.js';
import * as C from './panel-code.js';
import * as I from './image.js';
import { BitPopover } from './bit-editor.js';
import { PanelAnim } from './anim.js';
import * as RD from './panel-read.js';
import { fmtBytes } from './session.js';

/** 两块目标屏的推荐值。`short` 是侧栏下拉用的短名（长名字会把 300px 宽的侧栏撑爆 → 字被裁）*/
export const PANEL_PRESETS = {
  axs15352: {
    label: '天马 2P01 / AXS15352（240×296 · 4 线 SPI + DC）',
    short: 'AXS15352（240×296）',
    profile: { profile: 1, defLines: 1, dcActiveHigh: true, csHoldInStep: true, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3 },
    /* 引脚与「引脚分配图」的推荐值一致（`protocol.AUX_DEFAULT`：DC=PA26 / RST=PA02 / BL=PA31）——
     * 用户 2026-10 要求"跟大家都一样"，省得两块屏各记一套。
     *   · RST=PA02（J3[7]）、BL=PA31（J3[11]）：两根都经 LA 实测过（复位脉冲 / 背光电平干净）
     *   · DC=PA26（J3[24]）：原 SPI1 显示 CS，桥搬到 SPI2 后释放；慢速输出，实测固件接受索引 14
     *   · 🚨 PA10（J3[33]）别用：板载 LED 任务每 50 ms 写它，驱动不出持续电平（2026-09-30 LA 实测） */
    cfg: { sclkHz: 40000000, csPolicy: 0, padDc: 14 /*PA26 J3[24]*/, padRst: 5 /*PA02 J3[7]*/, padBl: 13 /*PA31 J3[11]*/, padActiveLow: 0x06 },
    geom: 'axs15352',
    /* 推荐值说明：拆成三段（协议 / 接线 / 注意）渲染成小表 —— 原来是一整段密排文字塞在
     * 230px 宽的侧栏里，用户（2026-10-02 review）明确说读不动。 */
    note: {
      proto: '档 1：同一个 CS 窗口里「命令 → 翻 DC → 参数」；像素管道化刷（除末片都保持 CS）',
      wire: 'SPI2：SCLK=J3[13] MOSI=J3[28] CS=J3[26]　DC=PA26(J3[24]) RST=PA02(J3[7]) BL=PA31(J3[11])',
      tips: 'RST/BL 两根都经 LA 实测；PA10(J3[33]) 别用（板载 LED 任务每 50 ms 写它）',
    },
  },
  st77916: {
    label: 'ST77916（圆屏 360×360 · QSPI 四线）',
    short: 'ST77916（360×360）',
    profile: { profile: 2, defLines: 1, dcActiveHigh: true, csHoldInStep: true, qspiWrOpcode: 0x02, qspiColorOpcode: 0x32, qspiAddrBytes: 3 },
    /**
     * RST 用 **PA02（J3[7]）**、BL 用 **PA31（J3[11]）**，两根都经 LA 实测过：
     *   · PA02：复位脉冲干净（10 ms 低电平，一次就抓到）
     *   · PA31：BL 电平干净（300 ms 高/低 ×3，实测宽度 327~347 ms）
     *   · 🚨 **PA10（J3[33]）不能用**：探针跑的是 hpm5301evklite 那份固件（只有它
     *     `BOARD_HAS_SPI_BRIDGE=1`），其 board.h 里 `LED1_PIN = LED2_PIN = IOC_PAD_PA10`
     *     且 `LED_TICK_PERIOD_MS = 50` —— LED 任务每 50 ms 写这个脚，实测只有 ~20 ns
     *     毛刺、驱动不出持续电平（LA 上毛刺周期正好 50 ms，与 LED tick 对上）。
     *   · 早先"PA31 死活不动"的结论是**测试脚本发错了帧类型**（把 PING 0x05 当 GPIO 0x03
     *     发）造成的冤案 —— PA31 本身完全正常，别再照那条旧结论排除它。
     * 「重放前先复位」和「复位并开背光」就发在这两个脚上，默认值配错等于没复位/没背光。
     *
     * 🚨 **mode 必须是 0（标准 SPI mode 0）—— 这是"屏点不亮"的真凶**：
     *   ST77916 手册（3/4-line serial）明写 "SDA is sampled at the rising edge of SCL"，
     *   即**屏在 SCLK 上升沿采样**，主机必须在**下降沿**换数据、给它留建立时间。
     *   验收实测（LA 500 MHz，量 D0 相对 SCLK 边沿）：mode 0 时 D0 跳转全部落在
     *   **下降沿**后 0~2 ns，**上升沿**采样解码与内置表逐字节一致
     *   （02 00 F0 00 28 = {0xF0,{0x28}}）。
     *
     *   ⚠️ 历史坑（别再踩）：2026-09-30 之前的探针固件把 CPHA 的 odd/even 写反了 ——
     *   那时 mode 0 出来的是**标准 mode 1**（数据正好在上升沿换 → 屏采到上一位 →
     *   194 条初始化全废 → 黑屏）。akaLinkPro 侧已修（commit e7bc24f），现在编号与
     *   标准一致。**如果配到没修的旧固件，这里要填 1**；拿不准就用 LA 量数据换在哪个沿。
     *   ⚠️ AXS15352 那档没实测过，先别跟着改。
     */
    cfg: { sclkHz: 40000000, mode: 0, csPolicy: 0, padDc: 0, padRst: 5 /*PA02 J3[7]*/, padBl: 13 /*PA31 J3[11]*/, padActiveLow: 0x06 },
    geom: 'st77916',
    note: {
      proto: '档 2：QSPI 四线。开窗 = 0x02 + 24bit 地址（00 XX 00，命令字在中间字节）；像素 = 0x32 + 四线连续流',
      wire: 'SPI2：CS=J3[26] SCLK=J3[13] D0=J3[28] D1=J3[27] D2=J3[10] D3=J3[8]　RST=PA02(J3[7]) BL=PA31(J3[11])',
      tips: 'RST/BL 都经 LA 实测；PA10(J3[33]) 被固件 LED 任务占用（50 ms 写一次，驱动不出持续电平）；mode 必须 0',
    },
  },
};

const GEOMETRY_SRC = { axs15352: 'axs15352', st77916: 'st77916' };

export class SpiPanelView {
  constructor(session){
    this.session = session;
    this.tag = 'panel';
    this.rows = [];            // 解析出来的面板步骤
    this.parsed = null;        // 最近一次解析结果（含 errors/warnings）
    this.playAbort = false;
    this.src = null;           // 当前图片/图案：{ w, h, rgba, name }
    this.patternKind = null;
    this.unsub = null;
    /** 解析表里的"字节 → 位"开关板（点字节弹出，改位即改那个字节） */
    this.bitpop = new BitPopover({ onEdit: (row, i, k, v) => this.onByteEdit(row, i, k, v) });
    this._sum = null;          // 摘要的原始文案（改过字节后要在后面补一句"已改 N 行"）
    /**
     * 右列 dock（刷屏 / 面板初始化 / 读回）与"当前在跑什么"。
     * `_act` = 正在进行的长操作：{ kind, done, total, note, abortable } —— 运行胶囊与「中止」
     * 都读它，所以**切到哪个 tab 都看得见**（用户 2026-10："右边部分做成分 tab"）。
     */
    this.dockTab = 'img';
    this._act = null;
    this.imgAbort = false;     // 「刷这一张」也能中止：半张图留在屏上无害（不像 flash 擦写）
    /**
     * 「刷这一张」那条路的局部刷新跟踪器：记住**上一次真正发出去的整窗像素**。
     * 第二次点「刷这一张」时只发与它不同的包围盒；一个像素都没变就整帧跳过（一次 USB 都不喊）。
     * 会重置它的地方：换图/换图案、改摆放或颜色开关、换屏几何、以及任何"面板被清过"的操作
     * （复位脉冲 / 上下电 / 套用推荐值）—— 屏上内容归零了，基准帧就不能还算数。
     */
    this.imgPartial = new I.PartialRefresh({ enabled: false, tolerance: 1 });
    this.imgPlan = null;       // 最近一次刷图的局部刷新决策（summary/日志用）
  }

  init(){
    const s = this.session;
    this._booting = true;      // 初始化期间别让 revealCanvas() 把 dock 顶回刷屏 tab（见该函数注释）

    for (const [v, label] of Object.entries(P.PROFILE_SHORT || P.PROFILE_NAME)) $('pn-profile').appendChild(new Option(label, v));
    for (const [k, p] of Object.entries(PANEL_PRESETS)) $('pn-preset').appendChild(new Option(p.short || p.label, k));
    for (const [k, d] of Object.entries(C.PANEL_DATA)) $('pn-code-preset').appendChild(new Option(`${d.label} · ${d.expect.rows} 条`, k));
    for (const [k, g] of Object.entries(I.PANEL_GEOMETRY)) $('pn-geom').appendChild(new Option(`${k}（${g.w}×${g.h}）`, k));
    /* 「自定义…」：内置两款之外的屏（比如手边的 240×240 GC9A01）自己填宽高。
     * 协议参数（开窗命令 / 线数 / qspi 色命令 / 对齐）沿用**当前档**那一套 —— 见 geometry()。 */
    $('pn-geom').appendChild(new Option('自定义…', 'custom'));
    this._geomBase = I.PANEL_GEOMETRY.st77916;      // 自定义的"协议参数底座"（选过命名几何就跟着换）
    this.syncCustomGeomInputs();

    // 连接（与桥页同一个会话）
    $('pn-connect').addEventListener('click', () => s.connectHid(true));
    $('pn-reconnect').addEventListener('click', () => s.connectHid(false));
    $('pn-usb').addEventListener('click', () => s.connectUsb(null, { inFlight: +($('pn-inflight').value || 4) }));
    $('pn-mock').addEventListener('change', e => s.setMock(e.target.checked));
    /**
     * 攒批档位：一次 `transferOut` 带多少字节（见 `protocol.batchPacks` 的注释）。
     * 落 store 是为了实验时不用每次重设；512 = 老行为（一片一次调用）。
     */
    store.bind($('pn-batch'), 'spi.batch');

    // 档位 / 推荐值
    $('pn-prof-get').addEventListener('click', () => this.wrap(() => s.loadProfile({ tag: this.tag })));
    $('pn-prof-set').addEventListener('click', () => this.applyProfile());
    $('pn-preset').addEventListener('change', () => this.fillPresetNote());
    /* 屏型号落 store：刷新/重开标签页后还停在上次选的那块屏。
       （引脚图的默认脚位不再依赖它 —— 那边用的是固定表 `protocol.AUX_DEFAULT`，
        只按配置值覆盖；曾因为跟着屏型号走而出现"DC 消失 / BL 指到不能用的 PA10"。）*/
    store.bind($('pn-preset'), 'panel.preset');
    this.fillPresetNote();
    $('pn-preset-apply').addEventListener('click', () => this.applyPreset());

    // 面板初始化代码
    $('pn-code-load').addEventListener('click', () => this.loadPresetCode());
    $('pn-code-file').addEventListener('click', () => $('pn-code-file-input').click());
    $('pn-code-file-input').addEventListener('change', e => this.loadCodeFile(e.target.files[0]));
    $('pn-code-parse').addEventListener('click', () => this.parseCode());
    $('pn-code-play').addEventListener('click', () => this.playRows(0, (this.effectiveRows || this.rows).length - 1));
    $('pn-code-stop').addEventListener('click', () => { this.playAbort = true; });
    $('pn-code-clear').addEventListener('click', () => { $('pn-code-text').value = ''; this.rows = []; this.bitpop.close(); this.renderCodeTable([]); this.setCodeSummary('已清空'); });
    for (const [id, kind] of [['pn-code-c', 'c'], ['pn-code-json', 'json'], ['pn-code-text-out', 'text']]) $(id).addEventListener('click', () => this.exportRows(kind));
    $('pn-code-body').addEventListener('click', e => {
      // ① 点参数字节格子 → 开「位开关板」（命令字节那格只用来敲十六进制，与参考页一致）
      const cell = e.target.closest('input.bx');
      if (cell && !cell.classList.contains('cmd')){
        const i = +cell.dataset.i;
        this.bitpop.open({
          row: (this.effectiveRows || this.rows)[i],
          base: (this.baseRows || [])[i] || null,
          index: i, k: +cell.dataset.b, anchor: cell,
        });
        return;
      }
      // ② 行尾的「单发 / 从此重放 / 改回」
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const i = +btn.dataset.i, act = btn.dataset.act;
      if (act === 'one') this.playRows(i, i);
      else if (act === 'from') this.playRows(i, (this.effectiveRows || this.rows).length - 1);
      else if (act === 'revert') this.revertRow(i);
    });
    /**
     * 改字节：**手打十六进制**与位开关板走同一条路（都落到 `setRowByte`），
     * 所以"脏标记 / 改回 / 导出 / 重放"全都不用特殊照顾（参考页也是这么做的）。
     * `change` 而不是 `input`：输入框里敲到一半（"5"）不该立刻当 0x05 提交。
     */
    $('pn-code-body').addEventListener('change', e => {
      const cell = e.target.closest?.('input.bx');
      if (!cell) return;
      const i = +cell.dataset.i;
      const row = (this.effectiveRows || this.rows)[i];
      if (!row) return;
      const isCmd = cell.classList.contains('cmd');
      const k = isCmd ? 'cmd' : +cell.dataset.b;
      const t = String(cell.value).trim().replace(/^0x/i, '');
      if (!/^[0-9a-f]{1,2}$/i.test(t)){
        this.session.log('e', `第 ${i} 行：'${cell.value}' 不是一个字节（要 00~FF 的十六进制）`, this.tag);
        cell.classList.add('bad');
        setTimeout(() => cell.classList.remove('bad'), 1500);
        cell.value = hx(isCmd ? row.cmd : row.data[k]);      // 还原成模型里的值
        return;
      }
      const v = parseInt(t, 16);
      if (v !== (isCmd ? row.cmd : row.data[k])){
        C.setRowByte(row, k, v);
        this.onByteEdit(row, i, k, v);
      } else {
        cell.value = hx(v);                                   // 只是大小写/前导零不同：规范化显示
      }
    });
    this.bitpop.init();

    // 图片 / 图案
    this.buildPatternChips();
    $('pn-drop').addEventListener('click', () => $('pn-img-file').click());
    $('pn-img-file').addEventListener('change', e => this.pickImage(e.target.files[0]));
    for (const ev of ['dragenter', 'dragover']) $('pn-drop').addEventListener(ev, e => { e.preventDefault(); $('pn-drop').classList.add('hot'); });
    for (const ev of ['dragleave', 'drop']) $('pn-drop').addEventListener(ev, e => { e.preventDefault(); $('pn-drop').classList.remove('hot'); });
    $('pn-drop').addEventListener('drop', e => this.pickImage(e.dataTransfer.files[0]));
    for (const id of ['pn-fit', 'pn-x', 'pn-y', 'pn-level']) $(id).addEventListener('change', () => { this.resetPartial('摆放/电平变了'); this.renderPreview(); });
    for (const id of ['pn-fit', 'pn-x', 'pn-y', 'pn-level']) $(id).addEventListener('input', () => { this.resetPartial('摆放/电平变了'); this.renderPreview(); });
    /* 两个"显示开关"（字节序 / R-B 交换）在**读回 tab 里也有一份**（#pn-read-byteorder / #pn-read-swap）：
     * 读回的画面单独占一张画布，翻颜色不该逼用户切回刷屏 tab。两边是同一组语义、双向同步。 */
    for (const id of ['pn-swap', 'pn-byteorder']) $(id).addEventListener('change', () => {
      this.syncViewSwitches('img'); this.resetPartial('颜色开关变了'); this.renderPreview(); this.drawReadBack();
    });
    /* 局部刷新：刷屏 tab 一个开关、动画行一个开关，**同一份状态双向同步**（照字节序/交换那两个副本的做法）。
     * 开关一变就把基准帧丢掉 —— 换了语义再拿旧帧比，会把整屏算成"变了"。 */
    for (const id of ['pn-partial', 'pn-anim-partial']){
      $(id)?.addEventListener('change', () => {
        const on = $(id).checked;
        for (const other of ['pn-partial', 'pn-anim-partial']) if ($(other)) $(other).checked = on;
        this.resetPartial(on ? '打开局部刷新' : '关闭局部刷新');
        this.renderPreview();
        s.log('i', on
          ? `局部刷新已开：只发与上一帧不同的包围盒（容差 ${$('pn-partial-tol').value} 位）——「刷这一张」第二次起、以及播放动画都生效`
          : '局部刷新已关：每帧整屏发', this.tag);
      });
    }
    $('pn-partial-tol')?.addEventListener('change', () => { this.resetPartial('容差变了'); this.renderPreview(); });
    /* 屏幕几何：选命名款 → 把宽高填进自定义框（方便在此基础上微调）并换底座；
     * 选「自定义…」→ 用框里的宽高。两种都要重算画布 / 读回窗口 / 假探针 GRAM ⇒ applyGeometry()。 */
    $('pn-geom').addEventListener('change', () => {
      const k = $('pn-geom').value;
      if (k !== 'custom' && I.PANEL_GEOMETRY[k]){
        this._geomBase = I.PANEL_GEOMETRY[k];
        if ($('pn-w')) $('pn-w').value = String(this._geomBase.w);      // 混版时可能没有这两个框
        if ($('pn-h')) $('pn-h').value = String(this._geomBase.h);
      }
      this.syncCustomGeomInputs();
      this.applyGeometry();
    });
    for (const id of ['pn-w', 'pn-h']) $(id)?.addEventListener('change', () => { this.syncCustomGeomInputs(); this.applyGeometry(); });
    $('pn-img-send').addEventListener('click', () => this.sendImage());

    /**
     * 动画 / 视频：解码（`<video>`+rVFC 或 `ImageDecoder`）→ 逐帧发给屏。
     * 播放器在 `anim.js`（纯逻辑 + 一个 `<video>` 元素），这里只接按钮与状态显示。
     * 发送是节拍器：解码更快就丢帧（`stat.dropped`），不会在 USB 队列里堆延迟。
     * 局部刷新：勾了 `#pn-partial`（或动画行那个同状态的副本）就只发变化包围盒。
     */
    this.anim = new PanelAnim({
      session: s,
      video: $('pn-anim-video'),
      geometry: () => this.geometry(),
      profile: () => s.profile?.profile ?? 0,
      pixelOpts: () => ({
        swap: $('pn-swap').checked,
        littleEndian: $('pn-byteorder').value === 'le',
        level: Math.max(0, Math.min(255, +$('pn-level').value || 255)),
        fit: $('pn-fit').value,
      }),
      partial: () => this.partialOpts(),
      log: (kind, text, tag) => s.log(kind, text, tag || this.tag),
      onFrame: (px, win) => this.drawAnimFrame(px, win),
      onState: st => this.renderAnim(st),
      batchBytes: () => this.batchBytes(),
      callsOf: () => s.transport?.writes ?? 0,     // transferOut 调用计数（状态行显示"调用/帧"）
    });
    this.anim.loop = $('pn-anim-loop').checked;
    $('pn-anim-file').addEventListener('click', () => $('pn-anim-input').click());
    $('pn-anim-input').addEventListener('change', e => this.loadAnim(e.target.files[0]));
    $('pn-anim-play').addEventListener('click', () => this.playAnim());
    $('pn-anim-stop').addEventListener('click', () => this.anim.stop());
    $('pn-anim-loop').addEventListener('change', e => {
      this.anim.loop = e.target.checked;
      if (this.anim.video) this.anim.video.loop = e.target.checked;
    });

    // ============================================================ 读回（寄存器 / GRAM）
    this.readAbort = false;
    this.readBack = null;                    // 最近一次读回的 { rgba, bytes, w, h, ms, plan }
    for (const r of RD.REG_READS) $('pn-read-reg').appendChild(new Option(r.name, String(r.cmd ?? '')));
    $('pn-read-reg').addEventListener('change', () => {
      const r = RD.REG_READS.find(x => String(x.cmd) === $('pn-read-reg').value);
      if (r && r.cmd != null){ $('pn-read-reg-cmd').value = r.cmd.toString(16).toUpperCase().padStart(2, '0'); $('pn-read-reg-len').value = r.rx; }
    });
    $('pn-read-reg').dispatchEvent(new Event('change'));
    $('pn-read-reg-go').addEventListener('click', () => this.wrap(() => this.readRegister()));
    $('pn-read-go').addEventListener('click', () => this.wrap(() => this.readGram()));
    $('pn-read-stop').addEventListener('click', () => { this.readAbort = true; });
    $('pn-read-bmp').addEventListener('click', () => this.saveReadBmp());
    $('pn-read-full').addEventListener('click', () => this.fillReadWindow());
    // 读回 tab 里的显示开关副本（与刷屏 tab 双向同步，见 syncViewSwitches）
    for (const id of ['pn-read-byteorder', 'pn-read-swap']) $(id)?.addEventListener('change', () => {
      this.syncViewSwitches('read'); this.renderPreview(); this.drawReadBack();
    });
    this.syncViewSwitches('img');

    // 面板电源 / 显示：4 个独立命令（上电 11h / 开显示 29h / 关显示 28h / 下电 10h）+ RST 脉冲
    $('pn-rst-send').addEventListener('click', () => this.sendResetPulse());
    $('pn-rst-bl').addEventListener('click', () => this.resetAndBacklight());
    for (const [id, cmd, delayMs, label] of [
      ['pn-pwr-on', 0x11, 120, '上电 11h（sleep out）'],
      ['pn-disp-on', 0x29, 0, '开显示 29h'],
      ['pn-disp-off', 0x28, 0, '关显示 28h'],
      ['pn-pwr-off', 0x10, 120, '下电 10h（sleep in）'],
    ]) $(id).addEventListener('click', () => this.sendPowerCmd(cmd, delayMs, label));
    $('pn-enable').addEventListener('click', () => this.wrap(() => s.setEnabled(true, this.tag)));
    $('pn-disable').addEventListener('click', () => this.wrap(() => s.setEnabled(false, this.tag)));

    $('pn-log-clear').addEventListener('click', () => { $('pn-log').innerHTML = ''; });

    // ============================================================ 右列 dock + 日志高度 + 运行胶囊
    this._bindDock();
    this._bindGrips();

    this.unsub = s.subscribe(this);
    this.fillPresetNote();
    this.loadPresetCode();                    // 一进来就有内容（跟参考页"内置图案"一个意思）
    this.setPattern('BAR');                   // 预览区也别空着：垫一张色条（只画不发）
    this.applyGeometry();
    this.renderState(s.stateInfo());
    this.renderCounters(s.counters);
    this.syncRunPill();
    this._booting = false;
  }

  // ==================================================================== 右列 dock

  /**
   * tab 段 + 「中止」按钮（照 #dbg / #spi / #i2c 那套）。
   * 折叠按钮（.foldbtn）在这一页**全部删除**：tab 本身就是"显示 / 隐藏"，
   * 日志改成常驻之后也没有可折的东西了。
   */
  _bindDock(){
    const tabs = $('pn-dock-tabs');
    if (tabs){
      for (const b of tabs.querySelectorAll('button[data-dock]')){
        b.addEventListener('click', () => this._dockSelect(b.dataset.dock));
      }
    }
    const ab = $('pn-run-abort');
    if (ab) ab.addEventListener('click', () => this.abortAll());
    const saved = store.get('panel.dock', '');
    if (saved && tabs?.querySelector(`button[data-dock="${saved}"]`)) this._dockSelect(saved, { save: false });
    else this._dockSelect('img', { save: false });
  }

  /** 切右列 tab（只显示一个；选择记进 localStorage）*/
  _dockSelect(name, { save = true } = {}){
    const tabs = $('pn-dock-tabs'), box = $('pn-box-dock');
    if (tabs) for (const b of tabs.querySelectorAll('button[data-dock]')) b.classList.toggle('on', b.dataset.dock === name);
    if (box) for (const p of box.querySelectorAll('.dockpage')) p.classList.toggle('on', p.dataset.dock === name);
    this.dockTab = name;
    if (save) store.set('panel.dock', name);
    // 刚显示出来的内容补一次刷新：整个页面被切走时浏览器会把 rAF 挂起，
    // 隐藏期间攒下的渲染可能还没落地（`display:none` 本身不影响 rAF）。
    // 画布尤其明显：CSS 尺寸随 tab 出现才算得出来（object-fit 要按行高重新铺一次）。
    if (name === 'read') this.drawReadBack();
    else if (name === 'img') this.renderPreview();
  }

  /** 日志高度 + 源码文本框高度两条分隔条（复用 #spi 那套，拖完落 store）*/
  _bindGrips(){
    const box = $('pn-logbox');
    const h = Number(store.get('panel.logH', 0)) || 0;
    if (box && h > 0) box.style.height = Math.round(h) + 'px';
    this._bindGrip($('pn-grip-log'), {
      get: () => box?.getBoundingClientRect().height || 0,
      apply: v => { if (box) box.style.height = Math.round(v) + 'px'; },
      min: () => 72,
      max: () => Math.max(120, (document.querySelector('#tab-panel .main')?.clientHeight || 700) - 260),
      save: v => store.set('panel.logH', Math.round(v)),
    });

    const ta = $('pn-code-text');
    const th = Number(store.get('panel.codeH', 0)) || 0;
    if (ta && th > 0) ta.style.height = Math.round(th) + 'px';
    this._bindGrip($('pn-grip-code'), {
      get: () => ta?.getBoundingClientRect().height || 0,
      apply: v => { if (ta) ta.style.height = Math.round(v) + 'px'; },
      min: () => 70,
      max: () => Math.max(120, (document.querySelector('#tab-panel .main')?.clientHeight || 700) - 320),
      save: v => store.set('panel.codeH', Math.round(v)),
    });
  }

  /** 通用分隔条拖拽（不用 setPointerCapture：合成的 CDP 事件也能驱动它 —— 抄的 #dbg / #spi）*/
  _bindGrip(el, { get, apply, min, max, save }){
    if (!el) return;
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      const startY = e.clientY;
      const startVal = get();
      if (!startVal) return;
      const move = ev => apply(Math.max(min(), Math.min(max(), startVal - (ev.clientY - startY))));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        save(get());
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // ==================================================================== 运行胶囊 / 中止

  /**
   * 记下"正在跑什么"。长操作进来时 set、finally 里清 —— 胶囊与「中止」按钮都读它。
   * `abortable` 为 false 的操作（暂时没有）不该给中止按钮。
   */
  setActivity(kind, { done = 0, total = 0, note = '', abortable = true } = {}){
    this._act = kind ? { kind, done, total, note, abortable } : null;
    this.syncRunPill();
  }

  /** 运行胶囊：切到哪个 tab 都看得见（空闲 / 未连接数据端点 / 桥忙 / 具体在跑什么）*/
  syncRunPill(){
    const el = $('pn-run-pill');
    if (!el) return;
    const s = this.session, a = this._act;
    let text = '空闲', cls = '';
    if (a){
      text = a.kind + (a.total ? ` ${a.done}/${a.total}` : '') + (a.note ? ` · ${a.note}` : '');
      cls = 'on';
    } else if (s.busy){ text = '桥忙（不可中止的那桩）'; cls = 'warn'; }
    else if (!s.dataReady){ text = s.mock ? '假探针 · 未连数据端点' : '未连接数据端点'; }
    else if (!s.enabled){ text = '桥未使能'; cls = 'warn'; }
    el.textContent = text;
    el.className = 'hint dockrun' + (cls ? ' ' + cls : '');
    const ab = $('pn-run-abort');
    if (ab) ab.disabled = !a?.abortable;
  }

  /** 中止当前这一桩（刷图 / 重放 / 读回 / 播放都归它管；切到别的 tab 也按得到）*/
  abortAll(){
    const s = this.session, a = this._act;
    if (!a || !a.abortable){
      s.log('i', s.busy ? '当前这桩操作不能中止' : '当前没有在跑的操作', this.tag);
      return;
    }
    this.playAbort = true;
    this.readAbort = true;
    this.imgAbort = true;
    this.anim.stop();
    s.log('w', `已请求中止：${a.kind}（当前这一片发完就停）`, this.tag);
  }

  onSession(type, payload){
    if (type === 'log') this.appendLog(payload);
    else if (type === 'state'){ this.renderState(payload); this.refreshButtons(); }
    else if (type === 'busy') this.refreshButtons();
    else if (type === 'cfg' || type === 'profile'){ this.renderSummary(); this.fillProfile(payload); }
    else if (type === 'counters') this.renderCounters(payload.counters);
  }

  // ==================================================================== 渲染

  appendLog(e){
    appendLogLine($('pn-log'),
      (e.tag === 'bus' ? '[桥] ' : '') + e.text,
      e.kind === 'g' ? 'ok' : e.kind === 'e' ? 'err' : e.kind === 'w' ? 'warn' : 'dim');
  }

  renderLogFromRing(){
    const el = $('pn-log');
    if (!el) return;
    el.innerHTML = '';
    for (const e of this.session.ring) this.appendLog(e);
  }

  renderState(st){
    setStatus($('pn-state'), st.text, st.kind || '');
    $('pn-info').textContent = st.mock ? '假探针（无需硬件）' : (st.hidLabel || '未连接');
    $('pn-usbinfo').textContent = st.dataReady ? st.transportLabel : '未连接数据端点';
    $('pn-mock').checked = !!st.mock;
  }

  renderCounters(c){
    if (!c) return;
    $('pn-c-ok').textContent = String(c.framesOk ?? 0);
    $('pn-c-err').textContent = String(c.framesErr ?? 0);
    $('pn-c-tx').textContent = fmtBytes(c.bytesTx ?? 0);
    $('pn-c-rx').textContent = fmtBytes(c.bytesRx ?? 0);
    $('pn-sclk-actual').textContent = c.actualSclkHz ? P.sclkLabel(c.actualSclkHz) : '—';
  }

  renderSummary(){
    const s = this.session;
    const c = s.cfg, p = s.profile;
    $('pn-sum-sclk').textContent = c ? P.sclkLabel(c.sclkHz) : '—';
    $('pn-sum-cs').textContent = c ? (P.CS_POLICY.find(x => x.v === c.csPolicy)?.label || c.csPolicy) : '—';
    $('pn-sum-pads').textContent = c
      ? `DC=${P.PAD_NAME[c.padDc]} · RST=${P.PAD_NAME[c.padRst]} · BL=${P.PAD_NAME[c.padBl]}` +
        ((c.padActiveLow & 0x06) ? '（RST/CS 低有效）' : '')
      : '—';
    $('pn-sum-profile').textContent = p ? `${P.PROFILE_NAME[p.profile]} · 线数 ${p.defLines}` : '—';
  }

  fillProfile(p){
    if (!p) return;
    $('pn-profile').value = String(p.profile);
    $('pn-deflines').value = String(p.defLines);
    $('pn-dcactive').checked = !!p.dcActiveHigh;
    $('pn-cshold').checked = !!p.csHoldInStep;
    $('pn-qspiwr').value = '0x' + p.qspiWrOpcode.toString(16).padStart(2, '0');
    $('pn-qspicolor').value = '0x' + p.qspiColorOpcode.toString(16).padStart(2, '0');
    $('pn-qspiaddr').value = String(p.qspiAddrBytes);
  }

  /**
   * 推荐值说明：渲染成「协议 / 接线 / 注意」三行小表。
   *
   * 🚨 原来是一次 `textContent = note`，把十来行信息密排在一段里塞进 230px 宽的侧栏 ——
   *    用户 2026-10-02 review 明确说读不动。现在按字段渲染成对齐的小表（label 定宽 + 值自动换行）。
   *    为兼容仍然接受纯字符串（老调用/外部注入）。
   */
  fillPresetNote(){
    const el = $('pn-preset-note');
    if (!el) return;
    const note = PANEL_PRESETS[$('pn-preset').value]?.note;
    el.textContent = '';
    if (!note) return;
    if (typeof note === 'string'){ el.textContent = note; return; }
    for (const [k, label] of [['proto', '协议'], ['wire', '接线'], ['tips', '注意']]){
      if (!note[k]) continue;
      const row = document.createElement('div');
      row.className = 'noterow';
      const b = document.createElement('b');
      b.textContent = label;
      const s = document.createElement('span');
      s.textContent = note[k];
      row.append(b, s);
      el.appendChild(row);
    }
  }

  refreshButtons(){
    const s = this.session, c = s.connected, d = s.dataReady, busy = s.busy;
    $('pn-prof-get').disabled = !c; $('pn-prof-set').disabled = !c;
    $('pn-enable').disabled = !c; $('pn-disable').disabled = !c;
    $('pn-preset-apply').disabled = !c;
    const canSend = d && !busy;
    for (const id of ['pn-code-play', 'pn-img-send', 'pn-rst-send', 'pn-rst-bl', 'pn-pwr-on', 'pn-disp-on', 'pn-disp-off', 'pn-pwr-off']) $(id).disabled = !canSend;
    $('pn-code-stop').disabled = !busy;
    $('pn-code-parse').disabled = false;
    // 动画：有源 + 端点就绪 + 不忙 才能播；播放中「播放」变灰、「停止」可用
    const anim = this.anim;
    $('pn-anim-play').disabled = !(canSend && anim?.src);
    $('pn-anim-play').textContent = anim?.running ? '播放中…' : '播放到屏';
    $('pn-anim-stop').disabled = !anim?.running;
    $('pn-anim-file').disabled = !!anim?.running;
    for (const b of $('pn-code-body').querySelectorAll('button[data-act]')) b.disabled = !canSend;
    this.syncRunPill();          // 胶囊也要跟着状态走（未连接 / 未使能 / 忙）
  }

  // ==================================================================== 面板初始化

  /** 一进来就把内置示例填好（用户可以直接看"贴进来长什么样"）*/
  loadPresetCode(key){
    const k = key || $('pn-code-preset').value || C.PANEL_KEYS[0];
    const d = C.PANEL_DATA[k];
    if (!d) return;
    $('pn-code-text').value = d.text;
    this.session.log('i', `已载入内置示例：${d.label}（${d.expect.rows} 条）`, this.tag);
    this.parseCode();
  }

  async loadCodeFile(file){
    if (!file) return;
    try {
      const text = await file.text();
      $('pn-code-text').value = text;
      this.session.log('i', `已载入文件：${file.name}（${text.length} 字符）`, this.tag);
      this.parseCode();
    } catch (e){ this.session.log('e', '读文件失败：' + (e?.message || e), this.tag); }
  }

  parseCode(){
    this.bitpop.close();          // 行对象要整批重建：位开关板指着的那一行已经作废
    const text = $('pn-code-text').value;
    const r = C.parsePanelCode(text);
    this.parsed = r;
    this.rows = r.rows;
    /**
     * **面板不再替用户的表补任何命令**（用户 2026-09-30 明确要求去掉"自动补 MADCTL/COLMOD"）：
     * 厂家表的完整性该由**用户贴进来的文本**负责 —— 面板只老实解析、重放、导出它。
     * 曾经自动插的两条（0x36 MADCTL=0x00 / 0x3A COLMOD=0x55）是当年为 AXS15352
     * 那种"厂家表里没有、缺了会全黑"的情况打的补丁；现在多数表（如 ST77916 的 192 条）
     * 自己就带这两条，再插反而重复。需要的人把它们写进自己的表即可。
     */
    this.effectiveRows = r.rows;
    // 原值快照：表格里的"脏标记 / 改回 / 恢复原值 / 哪些位动过"全靠它比对（不是靠一个粘住的 flag ——
    // 改回原值就该自己变干净）。深拷贝 data，别和行共享同一个 Uint8Array。
    this.baseRows = this.effectiveRows.map(r2 => ({ ...r2, data: Uint8Array.from(r2.data) }));
    this.renderCodeTable(this.effectiveRows);
    const bits = [`认出 ${r.stats.rows} 条`, `${r.stats.paramsBytes} 参数字节`, `累计延时 ${r.stats.delayMs} ms`,
                  `格式 ${r.format}`];
    if (r.errors.length) bits.push(`⚠ ${r.errors.length} 行没认出来`);
    if (r.warnings.length) bits.push(`⚠ ${r.warnings.length} 条告警`);
    this.setCodeSummary(bits.join(' · '), r.errors.length ? 'err' : (r.warnings.length ? 'warn' : 'ok'));
    if (r.errors.length){
      for (const e of r.errors.slice(0, 5)) this.session.log('e', `第 ${e.line} 行没认出来：${e.why} —— ${e.text}`, this.tag);
    }
    if (r.warnings.length){
      for (const w of r.warnings.slice(0, 5)) this.session.log('w', `第 ${w.line} 行：${w.why}`, this.tag);
    }
    this.session.log('g', `解析完成：${r.stats.rows} 条 / ${r.stats.paramsBytes} 参数字节 / 累计 ${r.stats.delayMs} ms` +
      (r.errors.length ? `（${r.errors.length} 行未识别，见上）` : ''), this.tag);
  }

  setCodeSummary(text, kind){
    this._sum = { text, kind };
    this.renderSum();
  }

  /** 这一行和"解析出来的原值"是否不同（指纹比对：改回原值就自己变干净）*/
  rowDirty(i){
    const r = (this.effectiveRows || [])[i], b = (this.baseRows || [])[i];
    if (!r || !b) return false;
    return fingerprint(r) !== fingerprint(b);
  }

  dirtyCount(){
    const rows = this.effectiveRows || this.rows;
    let n = 0;
    for (let i = 0; i < rows.length; i++) if (this.rowDirty(i)) n++;
    return n;
  }

  /** 摘要 = 解析结果 + "已改 N 行"（改过字节后一眼知道表格与文本框不再一致）*/
  renderSum(){
    const el = $('pn-code-sum');
    if (!el || !this._sum) return;
    const n = this.dirtyCount();
    el.textContent = this._sum.text + (n ? ` · 已改 ${n} 行（按改后的值重放/导出）` : '');
    el.className = 'hint';
    if (this._sum.kind) el.classList.add(this._sum.kind);
    el.style.color = this._sum.kind === 'err' ? 'var(--err)' : this._sum.kind === 'warn' ? 'var(--warn)' : this._sum.kind === 'ok' ? 'var(--ok)' : '';
  }

  /** 表格：命令字节与每个参数字节都是**可编辑的十六进制格子**（照 `tools/bmp_sender.html`）。
   *  点参数字节 → 位开关板；直接敲 → 改值。两者都走 `setRowByte`。 */
  renderCodeTable(rows){
    const body = $('pn-code-body');
    if (!rows.length){
      body.innerHTML = '<tr><td colspan="6" style="color:var(--fg2)">（还没有内容 —— 贴代码后点「解析并预览」）</td></tr>';
      this.bitpop.close();
      return;
    }
    body.innerHTML = rows.map((r, i) => {
      const isAuto = !!r.auto;
      const cls = [isAuto ? 'auto' : '', this.rowDirty(i) ? 'dirty' : ''].filter(Boolean).join(' ');
      const params = r.data.length
        ? [...r.data].map((v, j) =>
            `<input class="bx" data-i="${i}" data-b="${j}" maxlength="2" spellcheck="false" value="${hx(v)}"` +
            ` title="第 ${j} 字节 · 0x${hx(v)} = ${C.bitsText(v)} —— 直接敲十六进制改它；点一下开位开关板">`).join(' ')
        : '<span style="color:var(--fg2)">（无参数）</span>';
      const acts = `<button class="mini" data-act="one" data-i="${i}">单发</button> ` +
        `<button class="mini" data-act="from" data-i="${i}">从此重放</button>` +
        (this.rowDirty(i) ? ` <button class="mini" data-act="revert" data-i="${i}" title="这一行改回解析出来的原值">改回</button>` : '');
      return `<tr${cls ? ` class="${cls}"` : ''}>` +
        `<td>${i}</td><td style="color:var(--fg2)">${isAuto ? '补' : (r.line || '')}</td>` +
        `<td><input class="bx cmd" data-i="${i}" maxlength="2" spellcheck="false" value="${hx(r.cmd)}" title="命令字节（DCS 命令）—— 直接敲十六进制"></td>` +
        `<td class="params">${params}${isAuto ? ` <span style="color:var(--warn)">← ${r.name}</span>` : ''}</td>` +
        `<td>${r.delayMs || ''}</td>` +
        `<td class="acts">${acts}</td></tr>`;
    }).join('');
    this.drawRuler();
    this.bitpop.reattach();       // 整表重建 → 把弹窗的锚点找回来（找不到就自己关掉）
    if (this.bitpop.isOpen) this.bitpop.render();
  }

  /** 表头那行"字节序号标尺"：按当前**最长的那一行**生成（0 1 2 3 …）
   *  ⚠️ 每个 span 的宽度必须和 `.bx` 格子一致（都 25px、都用空格分隔），否则会越往后越偏。 */
  drawRuler(){
    const el = $('pn-code-ruler');
    if (!el) return;
    const maxb = (this.effectiveRows || []).reduce((m, r) => Math.max(m, r.data.length), 0);
    const parts = [];
    for (let i = 0; i < maxb; i++) parts.push(`<span>${i}</span>`);
    el.innerHTML = parts.join(' ');
  }

  /** 只把一行改回原值（表格里手改错了不用整表重解析）*/
  revertRow(i){
    const b = (this.baseRows || [])[i];
    if (!b || !(this.effectiveRows || [])[i]) return;
    this.effectiveRows[i] = { ...b, data: Uint8Array.from(b.data) };
    this.renderCodeTable(this.effectiveRows);
    this.renderSum();
    this.session.log('i', `第 ${i} 行已改回解析出来的原值（0x${hx(b.cmd)}）`, this.tag);
  }

  /** 位开关板改了某个字节（bit-editor.js 的回调）：重绘表格 + 摘要 + 记一条日志 */
  onByteEdit(row, i, k, v){
    this.renderCodeTable(this.effectiveRows || this.rows);
    this.renderSum();
    const what = k === 'cmd' ? '命令' : `参数[${k}]`;
    this.session.log('i', `第 ${i} 行「${what}」改成 0x${hx(v)}（重放/导出按改后的值，文本框不动）`, this.tag);
  }

  exportRows(kind){
    // 导出的就是**表格里现在这份**：含自动补的前缀、含刚用位开关板改过的字节
    const rows = this.effectiveRows || this.rows;
    if (!rows.length){ this.session.log('w', '还没有解析出内容', this.tag); return; }
    const text = kind === 'c' ? C.rowsToC(rows) : kind === 'json' ? C.rowsToJson(rows) : C.rowsToText(rows);
    const name = kind === 'c' ? 'panel_init.c' : kind === 'json' ? 'panel_init.json' : 'panel_init.txt';
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.session.log('g', `已导出 ${name}（${rows.length} 条）`, this.tag);
    } catch (e){ this.session.log('e', '导出失败：' + (e?.message || e), this.tag); }
  }

  /** 重放 [start, end]（只有最后一条要应答；192 条会被打包器攒批成十几包）*/
  async playRows(start, end){
    const s = this.session;
    const rows = this.effectiveRows || this.rows;
    if (!rows.length){ s.log('w', '先「解析并预览」再来重放', this.tag); return; }
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    if (!s.enabled) s.log('w', '桥还没使能 —— 先点「使能」：未使能时 bulk OUT 端点不武装，写会一直 NAK/超时', this.tag);
    if (s.busy) return;
    const a = Math.max(0, Math.min(start, rows.length - 1));
    const b = Math.max(a, Math.min(end, rows.length - 1));
    // 复位 + 开背光：必须在 setBusy(true) **之前**跑完（这两条自己也要走 sendFrames，忙碌时会被拒）
    await this.replayPrelude();
    const items = C.rowsToItems(rows, { start: a, end: b });
    const totalBytes = rows.slice(a, b + 1).reduce((n, r) => n + r.data.length, 0);

    // 🚨 `setBusy(true)` 之后到 `try` 之间**不许再有能抛的语句**：中间抛出去就永远走不到
    //    finally 里的 `setBusy(false)`，会话会卡在"忙"上，后面所有操作都被 `if (s.busy) return`
    //    静默吃掉（2026-10 踩过：少了一行 `const label`，整节重放全空、还查了半天）。
    this.playAbort = false;
    const t0 = performance.now();
    const label = a === b ? `单发第 ${a} 条` : `重放 ${a}..${b}`;
    s.setBusy(true);
    try {
      this.setActivity(label, { total: rows.slice(a, b + 1).length });
      this.refreshButtons();
      $('pn-code-prog').textContent = `${label} 进行中…`;
      s.log('i', `${label}：${items.length} 条 / ${totalBytes} 参数字节`, this.tag);
      const r = await s.sendFrames(items, {
        tag: this.tag, quiet: true, timeoutMs: 4000, batchBytes: this.batchBytes(),
        onProgress: (sent, total) => {
          $('pn-code-prog').textContent = `${label}：${sent}/${total} 包`;
          this._act = { kind: label, done: sent, total, abortable: true };
          this.syncRunPill();
          if (this.playAbort) throw new Error('用户中止');
        },
        shouldStop: () => this.playAbort,
      });
      const ms = performance.now() - t0;
      const bad = r.rsps.filter(x => x && x.status !== P.ST.OK).length;
      s.log(bad ? 'e' : 'g', `${label} 完成：${r.packs} 包 · ${r.batches ?? r.packs} 次提交 · ${ms.toFixed(0)} ms` +
        ` · 平均 ${(totalBytes / Math.max(1, ms) * 1000 / 1024).toFixed(1)} KB/s` + (bad ? ` · ${bad} 个非 OK 应答` : ''), this.tag);
      $('pn-code-prog').textContent = `${label} 完成（${r.packs} 包 / ${ms.toFixed(0)} ms）`;
    } catch (e){
      s.log('e', `${label} 失败：` + (e?.message || e), this.tag);
      $('pn-code-prog').textContent = `${label} 失败`;
    } finally {
      this.setActivity(null);
      s.setBusy(false);
      this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== 图片 / 图案

  buildPatternChips(){
    const box = $('pn-patterns');
    box.innerHTML = '';
    box.classList.add('pattern-groups');
    const colors = {R:'#f85149',G:'#3fb950',B:'#58a6ff',MRG:'#e3b341',MRB:'#db61a2',MGB:'#39c5cf',W:'#fff',K:'#000',GY:'#808080'};
    const groups = {};
    for (const name of ['纯色','对比','测试图']){
      const row = document.createElement('div'); row.className = 'pattern-group';
      const title = document.createElement('span'); title.className = 'pattern-label'; title.textContent = name;
      row.append(title); groups[name] = row; box.append(row);
    }
    for (const [label, kind] of I.PATTERNS){
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = label;
      if (colors[kind]){
        const swatch = document.createElement('i'); swatch.className = 'pattern-swatch'; swatch.style.background = colors[kind];
        swatch.setAttribute('aria-hidden','true'); b.prepend(swatch);
      }
      b.dataset.kind = kind;
      b.addEventListener('click', () => this.setPattern(kind));
      groups[colors[kind] ? '纯色' : ['RG','GB','RB'].includes(kind) ? '对比' : '测试图'].appendChild(b);
    }
  }

  setPattern(kind){
    const g = this.geometry();
    const p = I.makePattern(kind, g.w, g.h);
    this.patternKind = kind;
    this.src = { ...p, name: `内置图案 ${kind}` };
    this.resetPartial('换图案');              // 内容换了一整张，基准帧作废
    for (const b of $('pn-patterns').querySelectorAll('button')) b.classList.toggle('on', b.dataset.kind === kind);
    this.renderPreview();
    this.revealCanvas();
    this.session.log('i', `图案 ${kind}（${p.w}×${p.h}）`, this.tag);
  }

  /** 点图案/选图之后把预览滚进视野 —— tab 化之后**不需要滚了**：画布就占满当前这块
   *  （`#pn-canvas` 走 object-fit:contain 填满所在行）。这里只兜"图案按钮被别处触发、
   *  而人停在读回 tab"的情况：切回刷屏 tab。
   *  🚨 初始化那一次 `setPattern('BAR')` 必须放行 —— dock 刚按 store 恢复好，
   *     在这儿切回 img 会把用户上次停留的 tab 顶掉。 */
  revealCanvas(){
    if (this._booting) return;
    if (this.dockTab !== 'img') this._dockSelect('img');
  }

  async pickImage(file){
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let src;
      if (buf[0] === 0x42 && buf[1] === 0x4d){                       // BMP 自己解析（浏览器不解 16bpp）
        const d = I.parseBMP(buf);
        src = { w: d.w, h: d.h, rgba: d.rgba, name: file.name };
      } else {
        const bmp = await createImageBitmap(new Blob([buf]));
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const id = g.getImageData(0, 0, bmp.width, bmp.height);
        src = { w: bmp.width, h: bmp.height, rgba: new Uint8Array(id.data), name: file.name };
        bmp.close?.();
      }
      this.src = src;
      this.patternKind = null;
      for (const b of $('pn-patterns').querySelectorAll('button')) b.classList.remove('on');
      this.resetPartial('换图');
      this.renderPreview();
      this.revealCanvas();
      this.session.log('g', `已载入 ${src.name}：${src.w}×${src.h}`, this.tag);
    } catch (e){
      this.session.log('e', '载入图片失败：' + (e?.message || e), this.tag);
    }
  }

  /**
   * 自定义宽高：只在选「自定义…」时可编辑（其它档灰掉，避免误改内置屏的尺寸）。
   *
   * 🚨 这两个框是 2026-10 新加的 —— **页面混版**（浏览器缓存着旧 index.html + 拿到新 app/*.js）
   *    时它们还不存在，直接取 `.disabled` 会抛 TypeError，把整个页面的初始化打断（表现=白屏/加载不出来）。
   *    所以这里一律用可选访问，缺元素就跳过：宁可少个功能，也不能让页面起不来。
   */
  syncCustomGeomInputs(){
    const custom = ($('pn-geom')?.value === 'custom');
    for (const id of ['pn-w', 'pn-h']){ const el = $(id); if (el) el.disabled = !custom; }
  }

  /**
   * 当前屏几何。
   *   · 命名款 → `PANEL_GEOMETRY[k]` 原样返回
   *   · 「自定义…」→ 宽度/高度取 `pn-w` / `pn-h`，其余协议参数（开窗命令 / 线数 / qspi 色命令 / 对齐）
   *     沿用 `_geomBase`（最近一次选过的命名款，默认 st77916）—— 所以自定义**不用重配协议**，
   *     换块 240×240 的 GC9A01 只要填两个数字。
   */
  geometry(){
    const k = $('pn-geom').value || 'st77916';
    if (k === 'custom'){
      const base = this._geomBase || I.PANEL_GEOMETRY.st77916;
      const w = Math.max(1, Math.min(4096, +($('pn-w')?.value) || base.w));    // 混版时框可能不存在 → 用底座尺寸
      const h = Math.max(1, Math.min(4096, +($('pn-h')?.value) || base.h));
      return { ...base, w, h, custom: true };
    }
    const g = I.PANEL_GEOMETRY[k] || I.PANEL_GEOMETRY.st77916;
    this._geomBase = g;
    return g;
  }

  /**
   * 攒批档位（一次 `transferOut` 带多少字节）。
   * ⚠️ 只影响**主机侧提交粒度**：固件仍按 512 B 槽解析（包序列一模一样），
   *    所以刷屏结果不变，变的只是"喊几次 USB" —— 见 `protocol.batchPacks` 的注释。
   */
  batchBytes(){
    const v = +($('pn-batch')?.value || 0);
    return P.BATCH_CHOICES.includes(v) ? v : 8192;
  }

  /**
   * 局部刷新的选项（两个开关是同一份状态，读哪个都一样；容差只有刷屏 tab 有）。
   * 缺元素（页面混版）时按"关"处理 —— 宁可多发包，也不能让页面起不来。
   */
  partialOpts(){
    const el = $('pn-partial') || $('pn-anim-partial');
    return {
      enabled: !!el?.checked,
      tolerance: Math.max(0, Math.min(4, +($('pn-partial-tol')?.value ?? 1) || 0)),
      littleEndian: ($('pn-byteorder')?.value === 'le'),   // 差异比较的掩码要按字节序换位
    };
  }

  /** 丢掉局部刷新的基准帧（换图 / 改摆放 / 换几何 / 面板被清过时必须调）*/
  resetPartial(reason){
    this.imgPartial?.reset();
    this.imgPlan = null;
    if (reason) this._partialReset = reason;
  }

  /**
   * 进度回调的**限流器** —— 往 DOM 写进度必须限流，别每次回调都写。
   *
   * 🚨 实测（2026-09-30 真机 A/B，360×360 / 253 KB / 527 片 / 攒批 16 KB）：
   *    `onProgress` 是**在每次 USB 提交之后同步调用**的（见 `transport.sendPacks`），
   *    而写一次可见元素的 `textContent` 实测约 **5 ms**（文本变更 → 样式/布局重算）。
   *    于是"攒批把 527 次 USB 调用压到 18 次"省下来的时间，又被 18 次 DOM 写入吃了回去：
   *      · 不传回调：45 ms（6.2 MB/s）
   *      · 传回调  ：134 ms（1.9 MB/s）——**慢 3 倍**
   *    读回那条路更狠：**每片写一次**，519 片 × 约 2 ms ≈ 1.2 s，直接把读回压在 205 KB/s。
   *
   * 限流后：中间的调用只更新变量，**至多每 `minGapMs` 写一次 DOM**；收尾那次（sent ≥ total）
   * 一定放行，保证最终进度不会停在 90%。
   */
  progressThrottle(fn, minGapMs = 150){
    let last = -1e9;
    return (sent, total, ...rest) => {
      const done = total > 0 && sent >= total;
      const now = performance.now();
      if (!done && now - last < minGapMs) return;
      last = now;
      fn(sent, total, ...rest);
    };
  }

  applyGeometry(){
    const g = this.geometry();
    this.resetPartial('换屏几何');            // 尺寸变了，基准帧没法比
    $('pn-canvas').width = g.w;
    $('pn-canvas').height = g.h;
    const rc = $('pn-read-canvas');
    if (rc){ rc.width = g.w; rc.height = g.h; }              // 读回那张也换几何（它有自己的画布）
    this.fillReadWindow();                                  // 读回窗口跟着屏走
    this.session.mockProbe?.setPanelGeometry?.(g.w, g.h);   // 假探针的 GRAM 也换成这块屏
    this.renderPreview();
    if (this.readBack) this.drawReadBack();
  }

  /** 预览 = **将要发出去的样子**（compose → 565 → 回读，含 R/B 交换与电平）*/
  renderPreview(){
    const g = this.geometry();
    const canvas = $('pn-canvas');
    if (canvas.width !== g.w || canvas.height !== g.h){ canvas.width = g.w; canvas.height = g.h; }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.w, g.h);
    if (!this.src){
      $('pn-img-sum').textContent = '选一张图或点一个内置图案';
      ctx.strokeStyle = '#2e3440';
      ctx.strokeRect(0.5, 0.5, g.w - 1, g.h - 1);
      return;
    }
    const x = Math.max(0, +$('pn-x').value || 0), y = Math.max(0, +$('pn-y').value || 0);
    const cw = I.composeWindow(this.src.rgba, this.src.w, this.src.h, {
      geometry: g, x, y, fit: $('pn-fit').value,
      swap: $('pn-swap').checked,
      littleEndian: $('pn-byteorder').value === 'le',
      level: Math.max(0, Math.min(255, +$('pn-level').value || 255)),
    });
    const win = cw.win, px = cw.px;
    const shown = I.rgb565ToRgba(px);

    const off = document.createElement('canvas');
    off.width = win.w; off.height = win.h;
    off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(shown), win.w, win.h), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, win.x0, win.y0);

    // 橙色虚线 = 探针真正下发的对齐窗口；青色实线 = 请求的落点
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#ffb020';
    ctx.strokeRect(win.x0 + 0.5, win.y0 + 0.5, win.w - 1, win.h - 1);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#4ea1ff';
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, win.w) - 1, Math.max(1, win.h) - 1);

    const slices = Math.ceil(px.length / I.PIXEL_SLICE);
    const prof = this.session.profile?.profile ?? 0;
    const po = this.partialOpts();
    $('pn-img-sum').textContent =
      `${this.src.name} · ${this.src.w}×${this.src.h} → 窗口 ${win.x0}..${win.x1} × ${win.y0}..${win.y1}` +
      `（${win.w}×${win.h}${win.padX ? `，对齐补 ${win.padX} 列` : ''}）\n` +
      `${px.length} 字节 → ${slices} 片（每片 ${I.PIXEL_SLICE} B）` +
      (prof === 1 ? ` + RAMWR 命令 + 2 条开窗（CS 一路保持到末片）= ${slices + 3} 帧`
                  : ` + 2 条开窗 = ${slices + 2} 帧`) +
      (po.enabled ? `\n局部刷新：开（容差 ${po.tolerance} 位）—— 第二次点「刷这一张」只发与上次不同的那块，` +
                    `一模一样就整帧跳过` : '\n局部刷新：关（每次整帧发）');
    $('pn-img-info').textContent = `${this.src.name}\n源图 ${this.src.w}×${this.src.h} · 目标 ${win.w}×${win.h}`;
  }

  /**
   * 刷这一张。
   *
   * 默认整帧：开窗 2 帧 +〔档 1 的 RAMWR〕+ 527 片像素（只有末片要应答）。
   * 勾了「局部刷新」则先与**上一次发出去的整窗**比较：
   *   · 一个像素都没变 → 整帧跳过（一次 USB 都不喊，日志里说清为什么）；
   *   · 变了但面积小 → 只发那个包围盒（对齐到 4 像素）；
   *   · 变化超过整窗 60% → 还是整帧（开窗那几帧的固定开销不值）。
   */
  async sendImage(){
    const s = this.session;
    if (!this.src){ s.log('w', '先选一张图或图案', this.tag); return; }
    if (!s.dataReady){ s.log('e', '先「连接数据端点」（或勾「用假探针」）', this.tag); return; }
    if (!s.enabled) s.log('w', '桥还没使能 —— 先点「使能」：未使能时 bulk OUT 端点不武装，写会一直 NAK/超时', this.tag);
    if (s.busy) return;
    if (!s.profile){ s.log('w', '还没读到面板档 —— 先「读取档位」或点「套用推荐值」', this.tag); }
    const g = this.geometry();
    const x = Math.max(0, +$('pn-x').value || 0), y = Math.max(0, +$('pn-y').value || 0);
    const opt = {
      geometry: g, x, y, fit: $('pn-fit').value,
      profile: s.profile?.profile ?? 0, lines: g.lines,
      swap: $('pn-swap').checked,
      littleEndian: $('pn-byteorder').value === 'le',
      level: Math.max(0, Math.min(255, +$('pn-level').value || 255)),
    };
    const cw = I.composeWindow(this.src.rgba, this.src.w, this.src.h, opt);

    /* 局部刷新决策。注意 `cw.px` 每帧都是新建的，跟踪器直接存引用（省一次 260 KB 的拷贝）。 */
    const po = this.partialOpts();
    this.imgPartial.enabled = po.enabled;
    this.imgPartial.tolerance = po.tolerance;
    this.imgPartial.littleEndian = po.littleEndian;
    const plan = this.imgPartial.plan(cw.px, cw.win, { align: g.align, scrW: g.w, scrH: g.h });
    this.imgPlan = plan;
    if (plan.action === 'skip'){
      s.log('i', `整帧跳过：这一张与上一次发出的逐像素相同（局部刷新，容差 ${po.tolerance} 位）——` +
        `一个字节都没发。要强制重发就取消勾选「局部刷新」。`, this.tag);
      $('pn-img-sum').textContent = `整帧跳过（与上次相同，容差 ${po.tolerance} 位）· 省下 ${(cw.px.length / 1024).toFixed(0)} KB`;
      return;
    }
    const out = { items: I.itemsForWindow(plan.px, plan.win, opt), px: plan.bytes, slices: 0, bytes: plan.px, window: plan.win };
    const profile = opt.profile;
    out.slices = out.items.length - 2 - (profile === 1 ? 1 : 0);

    this.imgAbort = false;
    const t0 = performance.now();
    s.setBusy(true);
    try {
      this.setActivity('刷图中');
      this.refreshButtons();
      const what = plan.action === 'partial' ? `局部刷新 ${plan.win.x0}..${plan.win.x1} × ${plan.win.y0}..${plan.win.y1}` : '整帧';
      s.log('i', `刷图开始：${what} · ${g.w}×${g.h} · ${out.slices} 片 / ${out.px} 字节 · 档 ${profile ?? '?'}` +
        (plan.reason ? `（${plan.reason}）` : ''), this.tag);
      const r = await s.sendFrames(out.items, {
        tag: this.tag, quiet: true, timeoutMs: 5000, batchBytes: this.batchBytes(),
        shouldStop: () => this.imgAbort,
        onProgress: this.progressThrottle((sent, total) => {
          const pct = (sent / total * 100).toFixed(0);
          const dt = (performance.now() - t0) / 1000;
          $('pn-img-sum').textContent = `发送中 ${pct}%（${sent}/${total} 包）· ${dt.toFixed(1)} s · ` +
            `${(out.px / 1024 / Math.max(0.001, dt)).toFixed(0)} KB/s`;
          this._act = { kind: '刷图中', done: sent, total, abortable: true };
          this.syncRunPill();
        }),
      });
      const ms = performance.now() - t0;
      const bad = r.rsps.filter(v => v && v.status !== P.ST.OK);
      const kbPerSec = out.px / 1024 / Math.max(0.001, ms / 1000);
      this.lastRun = { ms, bytes: out.px, slices: out.slices, frames: out.items.length,
                       calls: r.batches ?? null, sclkHz: s.counters.actualSclkHz, kbPerSec, badRsp: bad.length, when: Date.now(),
                       partial: plan.action === 'partial', area: plan.area, fullArea: plan.full,
                       win: plan.action === 'partial' ? { x0: plan.win.x0, y0: plan.win.y0, x1: plan.win.x1, y1: plan.win.y1 } : null };
      s.log(bad.length ? 'e' : 'g',
        `刷图完成（${what}）：${out.slices} 片 · ${r.batches ?? out.slices} 次提交 · ${fmtBytes(out.px)} · ${ms.toFixed(0)} ms · ` +
        `${kbPerSec.toFixed(0)} KB/s` +
        (plan.action === 'partial' ? ` · 像素只有整帧的 ${(plan.area / plan.full * 100).toFixed(1)}%` : '') +
        (this.imgAbort ? ' · 用户中止（屏上是半张图）' : '') +
        (bad.length ? ` · ${bad.length} 个非 OK 应答（${P.ST_TEXT[bad[0].status] || bad[0].status}）` : ''), this.tag);
      this.renderPreview();
    } catch (e){
      s.log('e', '刷图失败：' + (e?.message || e), this.tag);
    } finally {
      this.setActivity(null);
      s.setBusy(false);
      this.refreshButtons();
      await s.pollStatus(true);
    }
  }

  // ==================================================================== 动画 / 视频

  /** 选文件 → 建源（视频走 `<video>`+rVFC，GIF/APNG/动画 WebP 走 ImageDecoder）*/
  async loadAnim(file){
    if (!file) return;
    try {
      const src = await this.anim.load(file);
      // ImageDecoder 那条路能吃的其实有 GIF / APNG / 动画 WebP，别一律写成"（GIF）"——
      // 用户看到「rgb-ramp.webp · 36 帧（GIF）」会以为选错文件了。
      const ext = (/\.([a-z0-9]+)$/i.exec(src.name || '')?.[1] || 'gif').toUpperCase();
      $('pn-anim-video').classList.toggle('on', src.kind === 'video');
      const po = this.partialOpts();
      $('pn-anim-info').textContent = `${src.name} · ${src.w}×${src.h}` +
        (src.kind === 'gif' ? ` · ${src.frames} 帧（${ext}）` : ` · ${(src.duration || 0).toFixed(1)} s（视频）`) +
        `　→ 开窗后整帧 ${this.geometry().w * this.geometry().h * 2} 字节，` +
        (po.enabled ? `局部刷新（只发变化区，容差 ${po.tolerance} 位）` : '整帧刷');
      this.session.log('g', `动画已就绪：${src.name}（${src.w}×${src.h}）—— 点「播放到屏」开播`, this.tag);
    } catch (e){
      this.session.log('e', '动画源加载失败：' + (e?.message || e), this.tag);
      $('pn-anim-info').textContent = '加载失败：' + (e?.message || e);
    }
    this.refreshButtons();
  }

  async playAnim(){
    try {
      await this.anim.start();
    } catch (e){
      this.session.log('e', '动画播放失败：' + (e?.message || e), this.tag);
    }
    this.refreshButtons();
  }

  /** 每帧的预览：画的是**量化后真正发出去的那份**（与静图预览同一个口径）*/
  drawAnimFrame(px, win){
    const canvas = $('pn-canvas');
    const g = this.geometry();
    if (canvas.width !== g.w || canvas.height !== g.h){ canvas.width = g.w; canvas.height = g.h; }
    if (!this._animOff){ this._animOff = document.createElement('canvas'); }
    const off = this._animOff;
    if (off.width !== win.w || off.height !== win.h){ off.width = win.w; off.height = win.h; }
    const shown = I.rgb565ToRgba(px);
    off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(shown), win.w, win.h), 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, win.x0, win.y0);
  }

  /** 播放状态行（每帧刷新一次；同时同步按钮可用性）*/
  renderAnim(st){
    if (!st) return;
    const el = $('pn-anim-info');
    // 「调用」= 这一帧喊了几次 transferOut（`st.calls/frames`）：攒批档位有没有生效，看这个数最直接
    const calls = st.frames ? ` · USB 调用 ${(st.calls / st.frames).toFixed(1)} 次/帧` : '';
    /* 局部刷新的战果：省下的像素比例 = 1 - 实发/整帧等效 —— 「帧率为什么涨了」的答案就在这个数里 */
    const part = (st.partial || st.skipped)
      ? ` · 局部 ${st.partial} / 跳过 ${st.skipped} · 像素省 ${st.savePct.toFixed(1)}%`
      : '';
    if (el){
      if (st.running){
        el.textContent = `发送中：${st.frames} 帧 · 实测 ${st.fps.toFixed(1)} fps · ${st.kbs.toFixed(0)} KB/s` +
          ` · 最后帧 ${st.lastMs.toFixed(0)} ms` + part + calls + (st.dropped ? ` · 丢帧 ${st.dropped}（解码比发送快，正常）` : '');
      } else if (st.frames){
        el.textContent = `上次：${st.frames} 帧 · ${(st.bytes / 1024).toFixed(0)} KB · ${(st.ms / 1000).toFixed(1)} s · ` +
          `实测 ${st.fps.toFixed(1)} fps · ${st.kbs.toFixed(0)} KB/s` + part + calls + (st.dropped ? ` · 丢帧 ${st.dropped}` : '');
      }
    }
    // 运行胶囊（在 tab 栏上，切到别的 tab 也看得见）：动画这桩的进度只有这里能跨 tab 看到
    if (st.running) this._act = { kind: '播放中', done: st.frames, note: `${st.fps.toFixed(1)} fps`, abortable: true };
    else if (this._act?.kind === '播放中') this._act = null;
    this.refreshButtons();
  }

  // ==================================================================== 读回（寄存器 / GRAM）

  /** 窗口填成整屏（切几何 / 换屏时也调）*/
  fillReadWindow(){
    const g = this.geometry();
    $('pn-read-x0').value = 0; $('pn-read-y0').value = 0;
    $('pn-read-x1').value = g.w - 1; $('pn-read-y1').value = g.h - 1;
  }

  /** 当前面板档（读回要靠它选时序：1 = SPI+DC 走 DCS，2 = QSPI 走"读命令+地址"）*/
  panelProfile(){
    return this.session.profile?.profile ?? 0;
  }

  /** 档位是 raw(0) 时给一句提醒（屏基本都要 1 或 2，否则时序不对）*/
  warnIfRawProfile(what){
    if (this.panelProfile() !== 0) return false;
    this.session.log('w', `${what}：当前档位是 raw(0) —— 屏一般是「spi_dcx(1)」或「qspi(2)」，` +
      '先在「面板档（profile）」里点「写入档位」再读，否则时序对不上', this.tag);
    return true;
  }

  /** UI 上的读时序（dummy/线数/opcode/地址…）→ panel-read 的 opts */
  readTiming(){
    return {
      dummy: Math.max(0, Math.min(4, +$('pn-read-dummy').value || 0)),
      lines: +$('pn-read-lines').value || 1,
      dcs: { ramrdCmd: hxOf($('pn-read-ramrd').value, 0x2e), contCmd: hxOf($('pn-read-cont').value, 0x3e) },
      qspi: { opcode: hxOf($('pn-read-opcode').value, 0x0b), addrLen: Math.max(0, Math.min(4, +$('pn-read-addrlen').value || 0)),
              baseAddr: hxOf($('pn-read-addr').value, 0x2e00),
              // 开窗命令用的 opcode 跟着面板档走（与像素写侧同一个值），别硬编码 0x02
              wrOpcode: parseHexByteSafe($('pn-qspiwr').value, 0x02) },
    };
  }

  /** 读寄存器（一条事务就回来）*/
  async readRegister(){
    const s = this.session;
    if (!s.dataReady) return s.log('e', '读寄存器：先「连接数据端点」（或勾「用假探针」）', this.tag);
    if (s.busy) return s.log('w', '读寄存器：桥上正忙（刷屏/重放没结束）', this.tag);
    const t = this.readTiming();
    this.warnIfRawProfile('读寄存器');
    const cmd = hxOf($('pn-read-reg-cmd').value, 0x04);
    const rx = Math.max(1, Math.min(+$('pn-read-reg-len').value || 1, RD.READ_CHUNK_MAX));
    const { items, label } = RD.regReadItems({ cmd, rx, profile: this.panelProfile(), lines: t.lines,
                                               dummy: t.dummy, qspi: t.qspi });
    const t0 = performance.now();
    const r = await s.sendFrames(items, { tag: this.tag, quiet: true, timeoutMs: 2500, batchBytes: this.batchBytes() });
    const ms = performance.now() - t0;
    const rsp = [...r.rsps].reverse().find(x => x);
    const data = rsp?.data || new Uint8Array(0);
    const hexs = [...data].map(v => v.toString(16).toUpperCase().padStart(2, '0'));
    const body = data.length ? `${hexs.join(' ')}` : '（没读到数据）';
    // dummy 是**固件在数据相位之前发的**，所以这里显示的整串都是参数（别把第一个当成 dummy 丢掉）
    const note = t.dummy > 0 ? `（dummy=${t.dummy} 周期已由固件发过）` : '';
    $('pn-read-reg-out').textContent = `${label} → ${body} ${note} · ${ms.toFixed(0)} ms`;
    this.lastReg = { cmd, rx, bytes: data.length, hex: body, ms, dummy: t.dummy };
    s.log(rsp ? 'g' : 'e', `读寄存器 0x${cmd.toString(16).padStart(2, '0')}：${body} ${note}（${ms.toFixed(0)} ms）`, this.tag);
    await s.pollStatus(true);
  }

  /**
   * 读 GRAM：按 `panel-read.gramReadPlan()` 一片一片读回来（每片 ≤504 B），拼成一帧。
   * 读回来的画面直接画进「图片 / 图案刷屏」的预览框 —— 与"发出去的那一帧"同一个位置。
   */
  async readGram(){
    const s = this.session;
    if (!s.dataReady) return s.log('e', '读回：先「连接数据端点」（或勾「用假探针」）', this.tag);
    if (s.busy) return s.log('w', '读回：桥上正忙（刷屏/重放没结束）', this.tag);
    const g = this.geometry();
    const t = this.readTiming();
    this.warnIfRawProfile('读回');
    const num = (id, dflt) => { const v = $(id).value.trim(); return v === '' ? dflt : (+v || 0); };
    const plan = RD.gramReadPlan({
      geometry: g, profile: this.panelProfile(),
      x0: num('pn-read-x0', 0), y0: num('pn-read-y0', 0),
      x1: num('pn-read-x1', g.w - 1), y1: num('pn-read-y1', g.h - 1),
      chunk: Math.max(2, Math.min(+$('pn-read-chunk').value || RD.READ_CHUNK_DEFAULT, RD.READ_CHUNK_MAX)),
      lines: t.lines, dcs: { ...t.dcs, dummy: t.dummy }, qspi: { ...t.qspi, dummy: t.dummy, lines: t.lines },
    });
    const bad = RD.readPlanProblem(plan);
    if (bad) return s.log('e', '读回：' + bad, this.tag);

    this.readAbort = false;
    const t0 = performance.now();
    const buf = new Uint8Array(plan.total);
    let off = 0, done = 0, missed = 0;
    // 🚨 这里原本是**每片写一次 DOM**：519 片 × 约 2 ms ≈ 1.2 s，正好等于整个读回耗时
    //    （实测 1235 ms / 205 KB/s）—— 限流后再写，收尾那片一定放行。
    const updProg = this.progressThrottle((done, total, off2, dt, miss) => {
      $('pn-read-prog').textContent = `读片 ${done}/${total} · ${(off2 / 1024).toFixed(1)} KB · ` +
        `${dt.toFixed(1)} s · ${(off2 / 1024 / Math.max(0.001, dt)).toFixed(0)} KB/s` + (miss ? ` · 丢 ${miss} 片` : '');
      this._act = { kind: '读回中', done, total, abortable: true };
      this.syncRunPill();
    });
    s.setBusy(true);                 // 与重放 / 刷图同一条纪律：到 try 之间不许再有能抛的语句
    try {
      this.setActivity('读回中');
      this.refreshButtons();
      s.log('i', `读回开始：${plan.w}×${plan.h} → ${plan.total} B / ${plan.chunks.length} 片` +
        `（${s.profile?.profile === 2 ? 'QSPI：读命令 + 地址递增' : 'DCS：2E 读 + 3E 续读'}）`, this.tag);
      for (const c of plan.chunks){
        if (this.readAbort) break;
        const r = await s.sendFrames(c.items, {
          tag: this.tag, quiet: true, timeoutMs: 4000, batchBytes: this.batchBytes(),
          shouldStop: () => this.readAbort,
        });
        const rsp = [...r.rsps].reverse().find(x => x);
        if (!rsp || !rsp.data?.length){ missed++; }
        else { buf.set(rsp.data.subarray(0, c.bytes), off); }
        off += c.bytes; done++;
        updProg(done, plan.chunks.length, off, (performance.now() - t0) / 1000, missed);
      }
    } finally {
      const ms = performance.now() - t0;
      this.setActivity(null);
      s.setBusy(false);
      this.refreshButtons();
      const littleEndian = $('pn-byteorder').value === 'le';
      const swap = $('pn-swap').checked;
      const rgba = RD.decodeGram(buf, { littleEndian, swap });
      this.readBack = { rgba, bytes: buf, w: plan.w, h: plan.h, x0: plan.x0, y0: plan.y0,
                        ms, chunks: plan.chunks.length, missed, littleEndian, swap };
      this.drawReadBack();
      const kbs = off / 1024 / Math.max(0.001, ms / 1000);
      $('pn-read-prog').textContent = `读回 ${plan.w}×${plan.h} · ${fmtBytes(off)} · ${ms.toFixed(0)} ms · ` +
        `${kbs.toFixed(0)} KB/s · ${plan.chunks.length} 片` + (missed ? ` · ⚠ 丢 ${missed} 片` : '') +
        (this.readAbort ? '（已中止）' : '');
      s.log(missed || this.readAbort ? 'w' : 'g',
        `读回结束：${plan.w}×${plan.h} · ${fmtBytes(off)} · ${ms.toFixed(0)} ms · ${kbs.toFixed(0)} KB/s` +
        (missed ? ` · ${missed} 片没拿到数据` : '') + (this.readAbort ? ' · 用户中止' : ''), this.tag);
      await s.pollStatus(true);
    }
  }

  /**
   * 两个"显示开关"（字节序 / R-B 交换）在刷屏 tab 与读回 tab 各有一份：
   * `from` 是"用户刚动过的那一边"，把另一边的控件值补齐。改哪边都作用于同一帧。
   */
  syncViewSwitches(from){
    const bo = $('pn-byteorder'), sw = $('pn-swap');
    const rbo = $('pn-read-byteorder'), rsw = $('pn-read-swap');
    if (!bo || !sw) return;
    if (from === 'read'){
      if (rbo) bo.value = rbo.value;
      if (rsw) sw.checked = rsw.checked;
    } else {
      if (rbo) rbo.value = bo.value;
      if (rsw) rsw.checked = sw.checked;
    }
  }

  /** 把读回来的一帧画进**读回 tab 自己的**预览框（窗口不是整屏时按 x0/y0 摆放，其余保持黑）。
   *  🚨 画布必须是 `#pn-read-canvas` 而不是 `#pn-canvas`：后者在「刷屏」tab 里，
   *     tab 不是活动页时它是 display:none —— 结果会画进一个看不见的地方。 */
  drawReadBack(){
    const rb = this.readBack;
    const canvas = $('pn-read-canvas');
    if (!rb || !canvas) return;
    const g = this.geometry();
    // 显示开关随时可翻（用户："颜色不对时先只翻一个"）→ 与上次解码用的口径不一致就重解一次
    const littleEndian = $('pn-byteorder').value === 'le';
    const swap = $('pn-swap').checked;
    if (rb.littleEndian !== littleEndian || rb.swap !== swap || !rb.rgba){
      rb.rgba = RD.decodeGram(rb.bytes, { littleEndian, swap });
      rb.littleEndian = littleEndian; rb.swap = swap;
    }
    if (canvas.width !== g.w || canvas.height !== g.h){ canvas.width = g.w; canvas.height = g.h; }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, g.w, g.h);
    const tmp = document.createElement('canvas');
    tmp.width = rb.w; tmp.height = rb.h;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rb.rgba), rb.w, rb.h), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, rb.x0, rb.y0);
    const sum = $('pn-read-sum');
    if (sum) sum.textContent = `读回 ${rb.w}×${rb.h} @(${rb.x0},${rb.y0}) · ${fmtBytes(rb.bytes.length)} · ${rb.ms.toFixed(0)} ms` +
      `　（${rb.littleEndian ? '低字节在前' : '高字节在前'}${rb.swap ? ' · R/B 交换' : ''}）` +
      (rb.missed ? ` · ⚠ ${rb.missed} 片没拿到数据` : '');
  }

  /** 读回来的那一帧 → 24 位 BMP（浏览器不会导出 BMP，自己拼头）*/
  saveReadBmp(){
    const rb = this.readBack;
    if (!rb) return this.session.log('w', '还没读回一帧 —— 先点「读一帧」', this.tag);
    const bmp = RD.encodeBMP(rb.rgba, rb.w, rb.h);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `panel-read-${rb.w}x${rb.h}-${stamp}.bmp`;
    saveBlob(new Blob([bmp], { type: 'image/bmp' }), name);
    this.session.log('g', `已保存 ${name}（${fmtBytes(bmp.length)}，${rb.w}×${rb.h} 24 位 BMP）`, this.tag);
  }

  // ==================================================================== 档位 / 推荐值 / 复位

  async wrap(fn){
    try { await fn(); } catch (e){ this.session.log('e', e?.message || String(e), this.tag); }
  }

  readProfileFromUI(){
    return {
      profile: +$('pn-profile').value || 0,
      defLines: +$('pn-deflines').value || 1,
      dcActiveHigh: $('pn-dcactive').checked,
      csHoldInStep: $('pn-cshold').checked,
      qspiWrOpcode: parseHexByteSafe($('pn-qspiwr').value, 0x02),
      qspiColorOpcode: parseHexByteSafe($('pn-qspicolor').value, 0x32),
      qspiAddrBytes: Math.max(0, Math.min(4, +$('pn-qspiaddr').value || 3)),
    };
  }

  async applyProfile(){
    await this.wrap(() => this.session.applyProfile(this.readProfileFromUI(), this.tag));
  }

  /** 按屏型号一键套用：档位 + SCLK + DC/RST/BL + 预览按该屏的几何 */
  async applyPreset(){
    const key = $('pn-preset').value;
    const preset = PANEL_PRESETS[key];
    if (!preset) return;
    this.resetPartial('套用推荐值');          // 档位/引脚可能换了，刷屏基准帧作废
    await this.wrap(async () => {
      const s = this.session;
      s.log('i', `套用推荐值：${preset.label}`, this.tag);
      await s.applyProfile(preset.profile, this.tag);
      const cur = s.cfg;
      if (!cur){ s.log('w', '还没读到当前配置（先「连接探针」），只套用了档位', this.tag); }
      else {
        await s.applyConfig({ ...cur, ...preset.cfg }, this.tag);
        await s.pollStatus(true);
      }
      if (preset.geom && GEOMETRY_SRC[preset.geom]){ $('pn-geom').value = preset.geom; this.applyGeometry(); }
      this.fillProfile(s.profile);
    });
  }

  async sendResetPulse(){
    this.resetPartial('面板复位');            // 复位后 GRAM/寄存器归状态机，基准帧不算数了
    await this.wrap(() => this.session.sendFrames([{
      type: P.T.RESET,
      payload: P.resetPayload(Math.max(0, +$('pn-rst-low').value || 0), Math.max(0, +$('pn-rst-post').value || 0)),
      flags: P.F.RSP, label: 'RESET 脉冲',
    }], { tag: this.tag }));
  }

  /** 面板电源/显示：一条 STEP 命令（11h 上电 / 29h 开显示 / 28h 关显示 / 10h 下电）*/
  async sendPowerCmd(cmd, delayMs, label){
    this.resetPartial(`面板命令 0x${cmd.toString(16)}`);
    await this.wrap(() => this.session.sendFrames([{
      type: P.T.STEP,
      payload: P.stepPayload({ cmd, params: new Uint8Array(0), delayMs }),
      flags: P.F.RSP,
      label: label || `STEP 0x${cmd.toString(16)}`,
    }], { tag: this.tag }));
  }

  /** 辅助脚写。`level` 是**逻辑**电平（1 = 有效），极性取反在固件侧做（与桥页同一套语义）*/
  async sendGpio(line, level, label, { quiet = false } = {}){
    await this.wrap(() => this.session.sendFrames([{
      type: P.T.GPIO,
      payload: P.gpioPayload(line, level),
      flags: P.F.RSP, label,
    }], { tag: this.tag, quiet }));
  }

  /**
   * pad 是否"没用上"。🚨 协议里 **0 = （不用）**（见 `protocol.PADS[0]`），不是 0xFF ——
   * 按 0xFF 判会漏掉真机的"不用"，那样重放前会照发复位脉冲到一个没配的脚上。
   * 0xFF 一并留着：老配置/手写值见过它，多认一个不吃亏。
   */
  static isPadUnused(pad){ return pad == null || pad === 0 || pad === 0xff; }

  /**
   * 一键：RST 脉冲 → 开背光。
   *
   * 顺序不能反：RST 释放后的 post 延时（默认 120 ms）就是屏内部初始化/上电稳的时间，
   * 背光在这之后点亮才看得见东西；反过来先开背光只会先闪一下白。
   *
   * `quiet` 给重放前置用：重放时不想为这两条再刷两行"上电/下电"式的日志。
   */
  async resetAndBacklight({ quiet = false } = {}){
    const s = this.session, c = s.cfg;
    if (!c){ s.log('w', '还没读到桥的引脚配置（先「连接探针」）—— 不知道 RST/BL 脚，跳过', this.tag); return false; }
    this.resetPartial('复位并开背光');         // 屏上内容被复位冲掉了
    let did = false;
    if (SpiPanelView.isPadUnused(c.padRst)){
      s.log('w', `桥里 RST 脚配的是「不用」（pad ${c.padRst}）—— 跳过复位。到「USB→SPI/QSPI」页把 RST 脚配上再试`, this.tag);
    } else {
      const low = Math.max(0, +$('pn-rst-low').value || 0);
      const post = Math.max(0, +$('pn-rst-post').value || 0);
      await this.wrap(() => s.sendFrames([{
        type: P.T.RESET,
        payload: P.resetPayload(low, post),
        flags: P.F.RSP, label: `RST 脉冲 ${low}+${post}ms`,
      }], { tag: this.tag, quiet }));
      // 主机侧这一步是"发完就返回"（非阻塞）；屏那边要按 low+post 走完复位时序，
      // 所以紧跟的 GPIO 帧在固件队列里天然排在复位之后 —— 这里不需要再 sleep。
      did = true;
    }
    if (SpiPanelView.isPadUnused(c.padBl)){
      s.log('w', `桥里 BL 脚配的是「不用」（pad ${c.padBl}）—— 跳过开背光`, this.tag);
    } else {
      await this.sendGpio(P.LINE.BL, 1, '背光开', { quiet });
      did = true;
    }
    return did;
  }

  /**
   * 重放前的护栏：**勾了才做**。返回是否真的发了东西（自测直接读它，不用解析日志）。
   * 注意 `quiet` 只压掉"发送中"那些行，跳过时的告警仍然会打 —— 那是要让人看见的。
   */
  replayPrelude(){
    if (!$('pn-replay-prereset')?.checked) return Promise.resolve(false);
    return this.resetAndBacklight({ quiet: true });
  }

  // ==================================================================== 生命周期

  onShow(){
    this.renderLogFromRing();
    this.renderSummary();
    this.renderPreview();
    this.refreshButtons();
    this.session.pollStatus(true);
  }

  summary(){
    return {
      ...this.session.summary(),
      preset: $('pn-preset')?.value || null,
      geom: $('pn-geom')?.value || null,
      geomW: this.geometry().w,                    // 自定义分辨率时就是 pn-w / pn-h 的值
      geomH: this.geometry().h,
      rows: this.rows.length,
      tableRows: (this.effectiveRows || []).length,      // 表格行数（含自动补的前缀）
      editedRows: this.dirtyCount(),                     // 与原值不同的行（表格里手改或位开关板改的）
      bitpopOpen: this.bitpop.isOpen,
      parseErrors: this.parsed?.errors?.length ?? 0,
      source: this.src ? `${this.src.name} ${this.src.w}×${this.src.h}` : null,
      /* 局部刷新（2026-10 加）：静图那条路的状态 + 最近一次决策；动画那条在同一条里的 anim.* 里 */
      partial: {
        enabled: this.partialOpts().enabled,
        tolerance: this.partialOpts().tolerance,
        animSameSwitch: $('pn-anim-partial') ? $('pn-anim-partial').checked === ($('pn-partial') ? $('pn-partial').checked : true) : null,
        lastAction: this.imgPlan?.action || null,        // 'full' | 'partial' | 'skip'
        lastWin: this.imgPlan && this.imgPlan.action === 'partial'
          ? { x0: this.imgPlan.win.x0, y0: this.imgPlan.win.y0, x1: this.imgPlan.win.x1, y1: this.imgPlan.win.y1 } : null,
        lastArea: this.imgPlan?.area ?? null,
        lastFullArea: this.imgPlan?.full ?? null,
        lastReason: this.imgPlan?.reason || null,
        resetReason: this._partialReset || null,          // 最近一次"基准帧作废"的原因（排查用）
        stat: { ...this.imgPartial.stat },
      },
      anim: this.anim ? {
        src: this.anim.src ? `${this.anim.src.name} ${this.anim.src.w}×${this.anim.src.h} ${this.anim.src.kind}` : null,
        kind: this.anim.src?.kind || null,
        srcFrames: this.anim.src?.frames ?? null,        // 源自身帧数（GIF/APNG/WebP）；视频为 null
        srcDuration: this.anim.src?.duration ?? null,    // 视频时长（s）
        batchBytes: this.batchBytes(),                   // 攒批档位（一次 transferOut 的字节上限）
        calls: this.anim.stat.calls,                     // 累计 transferOut 次数
        callsPerFrame: this.anim.stat.frames ? +(this.anim.stat.calls / this.anim.stat.frames).toFixed(2) : null,
        running: this.anim.running, frames: this.anim.stat.frames, dropped: this.anim.stat.dropped,
        bytes: this.anim.stat.bytes, fps: +this.anim.stat.fps.toFixed(2), kbs: +this.anim.stat.kbs.toFixed(1),
        lastMs: +this.anim.stat.lastMs.toFixed(1),
        partial: this.anim.stat.partial, skipped: this.anim.stat.skipped,
        pxSent: this.anim.stat.pxSent, pxFull: this.anim.stat.pxFull,
        savePct: this.anim.stat.pxFull ? +(100 - this.anim.stat.pxSent / this.anim.stat.pxFull * 100).toFixed(2) : 0,
      } : null,
      lastRun: this.lastRun || null,          // 最近一次刷图的客观数字（脚本/自检直接读，别去解析日志）
      readBack: this.readBack ? {             // 最近一次读回（寄存器另见 lastReg）
        w: this.readBack.w, h: this.readBack.h, x0: this.readBack.x0, y0: this.readBack.y0,
        bytes: this.readBack.bytes.length, ms: +this.readBack.ms.toFixed(1),
        chunks: this.readBack.chunks, missed: this.readBack.missed,
        littleEndian: this.readBack.littleEndian, swap: this.readBack.swap,
        // 抽样几个像素（脚本对账用；整帧 RGBA 太大不进 summary）
        sample: [0, 1, 2].map(i => [this.readBack.rgba[i * 4], this.readBack.rgba[i * 4 + 1], this.readBack.rgba[i * 4 + 2]]),
      } : null,
      lastReg: this.lastReg || null,
      logLines: this.session.ring.length,
    };
  }
}

/** 表格里的字节文本（小写两位十六进制，与老的纯文本渲染一致）*/
const hx = v => (v & 0xff).toString(16).padStart(2, '0');

/** 一行的指纹（命令 + 延时 + 全部参数）：与解析时的原值快照比 → 脏标记 / 「改回」/「恢复原值」
 *  🚨 用指纹而不是一个"改过"的 flag：改成原值再改回来，那一行就该自己变干净。 */
const fingerprint = r => `${r.cmd}|${r.delayMs | 0}|${[...r.data].join(',')}`;

/** "0x2C" / "2c" → 44；空/非法 → fallback（面板档那两个 opcode 用）*/
function parseHexByteSafe(s, fallback = 0){
  const t = String(s ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(t)) return fallback;
  return parseInt(t, 16) & 0xff;
}

/** 读时序那几个格子：十六进制，位数不限（读命令 0B / 地址 0x2E00 都要用）*/
function hxOf(s, fallback = 0){
  const t = String(s ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(t)) return fallback;
  return parseInt(t, 16) >>> 0;
}

/** 存文件（与「工程生成」页同一个做法：a[download] + objectURL）*/
function saveBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
