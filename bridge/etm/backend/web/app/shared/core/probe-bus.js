import { usbDeviceInUse } from './usb-device.js';
/**
 * 跨标签页的「探针占用」协调（BroadcastChannel）。
 *
 * 为什么必须有这一层（2026-10 真机复现）：
 *   同一个浏览器里，两个标签页同时抓着同一台探针时 ——
 *     · WebHID（配置/引擎）可以两边都开着，互不报错；
 *     · 但 **WebUSB 的接口只能被一个连接认领**，第二个页签拿到的是
 *       `Unable to claim interface`，而且 `device.reset()` 也救不回来
 *       （实测：占用方在浏览器进程里还活着 → reset 直接回 "Unable to reset the device"）。
 *   探针**物理上只有一套 JTAG/调试引擎**，两个页签同时用本来也是错的：
 *   烧录时另一个页签还在轮询目标内存，轻则每条 DMI 都跟它抢（慢十倍），
 *   重则认领失败直接烧不动。以前只能靠"用户自己去关掉另一个页签"。
 *
 *   现在改成**抢之前先喊一嗓子**：请求方广播 `release`，别的页签收到就把自己的
 *   探针会话收干净（断开 RTT / 停采样 / 关数据端点）并回 `released`。
 *   请求方等一小会儿（有回应就提前结束）再去认领 —— 大部分情况下这一下就够。
 *
 * 设计约束：
 *   · **不能阻塞太久**：没人应答时最多等 `settleMs`（默认 250 ms）；
 *     有同伴但还没回时最多等 `waitMs`（默认 6000 ms），响应失败时禁止继续抢接口。
 *   · 浏览器没有 BroadcastChannel（老浏览器/无头环境）时**静默降级**成空操作，
 *     绝不让协调层成为新的失败点。
 *   · 只在同源页签之间生效（BroadcastChannel 的天然边界），正合适。
 */

import { sleep, waitMs } from './pace.js';

export const PROBE_BUS_CHANNEL = 'web-serial-rtt-tools/probe-bus';

/** 探针的 VID（akaLinkPro / DAPLink 都是 0x0d28） */
export const PROBE_VID = 0x0d28;

/**
 * 把本页签手里**所有**指向探针的 WebUSB 连接关掉 —— 包括"引用已经丢了"的那种。
 *
 * 🚨 这一步是跨页签让出探针的关键（2026-10 真机定点实验）：
 *    接口认领挂在 USBDevice 连接上；页面只是丢了 JS 引用、没调 `close()` 时，
 *    浏览器仍然认为接口被占着，别的页签每次 `claimInterface` 都失败（`reset()` 也救不回），
 *    要等垃圾回收才莫名好转 —— 表现就是"有时候能用、有时候认领不上"。
 *    实测：补一次 `close()`（哪怕那个对象 `opened` 已经是 false）→ 接口立刻可被认领。
 *    `navigator.usb.getDevices()` 对同一台设备返回的是**同一个** USBDevice 实例，
 *    所以这里拿到的正是那个僵尸连接，关得掉。
 *
 * @returns {Promise<number>} 实际关掉了几个
 */
export async function closeProbeUsbDevices(vid = PROBE_VID){
  if (typeof navigator === 'undefined' || !navigator.usb?.getDevices) return 0;
  let n = 0;
  try {
    for (const d of await navigator.usb.getDevices()){
      if (d.vendorId !== vid || usbDeviceInUse(d)) continue;
      try { await d.close(); n++; } catch { /* 已经关了/设备不在了，都无所谓 */ }
    }
  } catch { /* 枚举不到就当没有 */ }
  return n;
}

export class ProbeBus {
  /**
   * @param {string} name 本页签的名字（日志/排障用；同一页面多个实例也能区分开）
   */
  constructor(name = 'page'){
    this.name = name + '-' + Math.random().toString(36).slice(2, 7);
    this.peers = new Set();
    this.log = null;                 // (s:string)=>void 可选
    /** 收到别人"让出探针"时要做的事（返回 Promise）。没设 = 本页签本来就不占探针 */
    this.onRelease = null;
    this._acked = 0;
    /** 本轮"还活着"的同伴（说过话的）与"连续几轮没动静"的计数 —— 用来清掉已经不在的页签 */
    this._heard = null;
    this._missed = new Map();
    this._channel = null;
    /**
     * 关页签/刷新时喊一声"我走了"。
     * 🚨 BroadcastChannel **不会**在对端消失时通知这边，所以不喊的话名单里会永远留个"鬼"：
     *    每次烧录都要为它白等满 waitMs，日志上就是「请 1 个其他页签让出探针，0 个确认（等了 1236 ms）」。
     */
    this._bye = () => { this._post({ t: 'bye' }); };
    try { if (typeof addEventListener === 'function') addEventListener('pagehide', this._bye); } catch {}
    try {
      if (typeof BroadcastChannel === 'function'){
        this._channel = new BroadcastChannel(PROBE_BUS_CHANNEL);
        this._channel.onmessage = e => this._on(e.data);
        this._post({ t: 'hello' });
      }
    } catch (e){
      this._channel = null;          // 老浏览器：降级成空操作
    }
  }

  get supported(){ return !!this._channel; }

  _post(m){
    try { this._channel?.postMessage({ ...m, from: this.name, at: Date.now() }); } catch { /* 关掉了就算了 */ }
  }

  _on(m){
    if (!m || m.from === this.name) return;
    if (this._heard) this._heard.add(m.from);      // 本轮收到过它的任何消息 = 它还活着（清鬼的依据）
    switch (m.t){
      case 'bye':                                  // 对方关页签/刷新了，立刻从名单里去掉
        this.peers.delete(m.from);
        this._missed.delete(m.from);
        break;
      case 'hello':
        this.peers.add(m.from);
        this._post({ t: 'here' });
        break;
      case 'here':
        this.peers.add(m.from);
        break;
      case 'release':
        this._post({ t: 'releasing', requestId: m.requestId });
        this.log?.(`另一个页签要占用探针（${m.why || '未说明'}），本页先让出来`);
        Promise.resolve()
          .then(() => this.onRelease?.(m.why || ''))
          .then(() => this._post({ t: 'released', requestId: m.requestId }))
          .catch(e => this._post({ t: 'releaseFailed', requestId: m.requestId, why: e?.message || String(e) }));
        break;
      case 'releasing':
        if (this._heard && (!m.requestId || m.requestId === this._releaseId)) this._releasing.add(m.from);
        break;
      case 'released':
        if (this._heard && (!m.requestId || m.requestId === this._releaseId)){
          this._released.add(m.from);
          this._acked = this._released.size;
        }
        break;
      case 'releaseFailed':
        if (this._heard && (!m.requestId || m.requestId === this._releaseId)) this._releaseError = m.why || '对方无法释放探针';
        break;
      default:
        break;
    }
  }

  /**
   * 请别的页签让出探针。
   * @returns {Promise<{supported:boolean, asked:number, acked:number, ghosts:number, ms:number}>}
   *   asked = 这次真的喊到的同源页签数；acked = 回执"已让出"的个数；
   *   ghosts = 其中**已经不在**的页签数（关掉/冻结/刷新掉，连喊话都不应答）
   */
  async requestRelease(opts = {}){
    if (this._requestInProgress) throw new Error('探针交接正在进行，请稍后再试');
    this._requestInProgress = true;
    try { return await this._requestRelease(opts); }
    finally { this._heard = null; this._requestInProgress = false; }
  }

  async _requestRelease({ why = '', settleMs = 250, waitMs: waitCap = 6000 } = {}){
    if (!this._channel) return { supported: false, asked: 0, acked: 0, ghosts: 0, ms: 0 };
    const t0 = Date.now();
    this._acked = 0;
    this._heard = new Set();
    this._releasing = new Set(); this._released = new Set(); this._releaseError = null;
    this._releaseId = this.name + ':' + (this._releaseSeq = (this._releaseSeq || 0) + 1);
    const asked = this.peers.size;
    this._post({ t: 'release', why, requestId: this._releaseId });
    /**
     * 先等一下 'here' 回执：一个同伴都没有就别干等 —— 250 ms 的固定等待在"本来就没别人"
     * 的常见情况下纯属白花（那 80 ms 用让路自旋，页面不可见时也不会被钳成 1 s）。
     */
    if (asked) await sleep(settleMs);
    else await waitMs(Math.min(settleMs, 80));
    while (Date.now() - t0 < waitCap && this._acked < this.peers.size && !this._releaseError) await waitMs(40);
    if (this._releaseError) throw new Error('探针交接失败：' + this._releaseError);
    if ([...this._releasing].some(p => !this._released.has(p)))
      throw new Error('探针交接超时：另一个页签的操作还未退出，请等待它完成');
    /**
     * 清鬼：一轮下来**一句话都没说过**的同伴，就是已经不在了 —— 它会让每次烧录都白等满 waitMs。
     * 判据很稳：活着的页签收到 'release' 会立刻回一句 'releasing'（同步发的），
     * 只有"关掉/被浏览器冻结/在 bfcache 里"的页签才一声不吭。
     * 连续两轮没动静才除名（一轮可能是它正忙着），除名只是"以后不再等它"，没有别的副作用。
     */
    let ghosts = 0;
    for (const p of [...this.peers]){
      if (this._heard.has(p)){ this._missed.delete(p); continue; }
      const n = (this._missed.get(p) || 0) + 1;
      this._missed.set(p, n);
      if (n >= 2){ this.peers.delete(p); this._missed.delete(p); ghosts++; }
    }
    this._heard = null;
    return { supported: true, asked, acked: this._acked, ghosts, ms: Date.now() - t0 };
  }

  close(){
    try { if (typeof removeEventListener === 'function') removeEventListener('pagehide', this._bye); } catch {}
    try { if (this._channel) this._post({ t: 'bye' }); } catch {}
    try { this._channel?.close(); } catch {}
    this._channel = null;
  }
}
