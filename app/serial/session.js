/**
 * 串口会话（Web Serial 封装）。串口助手与终端共用同一个会话：
 * 一个 COM 口只能被一个程序打开，共用才符合直觉（两个标签是同一路数据的两种看法）。
 *
 * 事件：open / close / data(Uint8Array, Date) / tx(Uint8Array) / error(Error)
 */
import { Bus } from '../core/bus.js';
import { waitMs, yieldTask } from '../core/pace.js';
import { isProbeCdcPort } from '../core/cdc-mode.js';
import { ProbeCancelled } from '../core/probe-manager.js';

export class SerialSession extends Bus {
  constructor(){
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.isOpen = false;
    this.opts = null;
    this.info = null;
    this._wq = Promise.resolve();
    this._closing = false;
    this._epoch = 0;
  }

  static supported(){ return typeof navigator !== 'undefined' && 'serial' in navigator; }

  static async listPorts(){
    if (!SerialSession.supported()) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  static async requestPort(){
    if (!SerialSession.supported()) throw new Error('这个浏览器不支持 Web Serial（请用桌面版 Chrome / Edge）');
    return await navigator.serial.requestPort();
  }

  static describe(port){
    let i = {};
    try { i = port.getInfo ? port.getInfo() : {}; } catch {}
    const vid = i.usbVendorId != null ? i.usbVendorId.toString(16).toUpperCase().padStart(4, '0') : null;
    const pid = i.usbProductId != null ? i.usbProductId.toString(16).toUpperCase().padStart(4, '0') : null;
    return vid && pid ? `${vid}:${pid}` : '（无 USB 信息）';
  }

  /**
   * @param {SerialPort} port
   * @param {{baudRate:number,dataBits:number,stopBits:number,parity:string,flowControl:string,
   *          dtr?:boolean,rts?:boolean,owner?:string}} opts
   *   `owner` = **这次打开是谁发起的**（'assistant' / 'rtt' …）。它会随 `open` 事件带出去：
   *   三个页面共用这一个会话，各自只该对"自己发起的那次"弹提示 / 起自动记录
   *   （2026-10 代码审查：以前不带，于是在串口助手里开普通 UART 也会弹 RTT 转发页那句
   *   「CDC 波特率不生效」，两页都勾自动记录还会把同一路数据写成两个文件）。
   */
  async open(port, opts){
    if (this._openTask || this._closeTask) throw new Error('串口连接正在切换，请稍后再试');
    const generation = ++this._epoch;
    const setup = () => this._openNow(port, opts, generation);
    this._openTask = this.probeManager && isProbeCdcPort(port)
      ? this.probeManager.run('serial', setup, {
        reason: '串口要使用探针 CDC',
        recovery: true,
        resources: ['rtt','spi-cdc'].includes(opts.owner) ? [] : ['cdc-mode'],
        rejectResources: ['cdc-port'],
        conflictMessage: 'CDC 当前被采样暂停：请先停止采样，或取消 JScope 的暂停 CDC 选项',
      }) : setup();
    try { return await this._openTask; }
    finally {
      this._openTask = null;
      if (this.isOpen){
        if (isProbeCdcPort(this.port)) this.probeManager?.narrow('serial');
        else this.probeManager?.forget('serial');
      }
    }
  }

  async _openNow(port, opts, generation){
    if (this.isOpen) await this._closeNow();
    if (generation !== this._epoch) throw new ProbeCancelled();
    const o = {
      baudRate: Number(opts.baudRate) || 115200,
      dataBits: Number(opts.dataBits) || 8,
      stopBits: Number(opts.stopBits) || 1,
      parity: opts.parity || 'none',
      flowControl: opts.flowControl || 'none',
      /**
       * 🚨 **保持 4 KB，别学 2026-10 审查建议提到 64 KB**（我们试过、真机打脸）：
       *    它的理由是"高速流下读取端慢一拍就 BufferOverrunError"，听着无害，实测在
       *    RTT→CDC 打流 **2.9 MB/s** 时**把整页冻住**（页面来不及排空大缓冲，用户看到的是
       *    "打开 CDC 串口"那步超时、像串口/探针坏了）—— 已回退（见 git 历史 743e66e）。
       *    这里是主机侧读+渲染的路径，缓冲大小不是吞吐杠杆；真要动它，先在真机上按
       *    `make hw-campaign`（转发 2.9 MB/s + 10 s 存盘）验一轮再说。
       */
      bufferSize: 4096,
      owner: opts.owner || '',
    };
    await port.open(o);
    if (generation !== this._epoch){
      try { await port.close(); }
      catch (e){ this.port = port; this.isOpen = true; this.probeManager?.fail('serial', e); throw e; }
      throw new ProbeCancelled();
    }
    this.port = port;
    this.opts = o;
    this.info = SerialSession.describe(port);
    this.isOpen = true;
    this._closing = false;
    // DTR/RTS：默认都不拉（很多开发板靠 DTR/RTS 复位/进下载模式，别乱动）
    try { await port.setSignals({ dataTerminalReady: !!opts.dtr, requestToSend: !!opts.rts }); } catch {}
    this.emit('open', { opts: o, info: this.info });
    this._readTask = this._readLoop();
  }

  async _readLoop(){
    const port = this.port;
    try {
      while (this.isOpen && port.readable){
        this.reader = port.readable.getReader();
        try {
          /**
           * 🚨 外层 while **每轮都重新取 `port.readable`**，这是 Web Serial 的标准读法：
           *    帧错误（FramingError）/ 奇偶校验错（ParityError）/ `BufferOverrunError` 都是
           *    **非致命**的 —— 规范规定它们不会关端口，只是把 `readable` 换成一个**新流**，
           *    读循环接着读就行；只有真断开（拔线/被抢占）时 `readable` 才变成 null。
           *
           *    老代码内层**只有 finally、没有 catch**：线上一个坏字节（波特率选错、干扰、
           *    高速下缓冲溢出）就把整个循环掀到外层 catch，然后当成"串口已断开"发出去 ——
           *    可端口其实还开着（`isOpen` 仍是 true、`port.close()` 从没调过），状态前后不一致；
           *    而串口助手 / 终端 / RTT 转发共用这一个会话，于是**三个页面一起"断"**。
           *    （2026-10 代码审查）
           */
          while (true){
            const { value, done } = await this.reader.read();
            if (done){ await yieldTask(); break; } // 让浏览器发布 readable 更新，关闭流也不能空转微任务
            if (value && value.length){
              this.emit('data', value, new Date());
              // 缓冲已满时 read() 可连续兑现微任务；定期让输入和显示定时器运行。
              if (performance.now() - (this._readYieldAt || 0) >= 8){
                this._readYieldAt = performance.now(); await yieldTask();
              }
            }
          }
        } catch (e){
          // 非致命错误：报一声继续（readable 已换成新流，外层的 while 会拿到它）
          if (this.isOpen && !this._closing) this.emit('error', e);
          await waitMs(20);                        // 让一步：万一 readable 没被换掉也不会把 CPU 空转满
        } finally {
          try { this.reader.releaseLock(); } catch {}
          this.reader = null;
        }
      }
    } catch (e){
      if (!this._closing && this.isOpen) this.emit('error', e);
    }
    if (this.isOpen && !this._closing) queueMicrotask(() => this.close({ unexpected: true }).catch(e => this.emit('error', e)));
  }

  async close({ unexpected = false } = {}){
    this.probeManager?.cancel('serial');
    if (this._closeTask) return await this._closeTask;
    ++this._epoch;
    this._closeTask = (async () => {
      if (this._openTask) await this._openTask.catch(() => {});
      await this._closeNow(unexpected);
      this.probeManager?.forget('serial');
    })();
    try { return await this._closeTask; }
    finally { this._closeTask = null; }
  }

  async _closeNow(unexpected = false){
    if (!this.isOpen) return;
    this._closing = true;
    // Invalidate queued writes before releasing any stream locks.
    this.isOpen = false;
    try {
      if (this.reader) await this.reader.cancel();
      if (this._readTask) await this._readTask;
      await this._wq;
      if (this.writer){ this.writer.releaseLock(); this.writer = null; }
      await this.port.close();
    } catch (e){
      this.isOpen = true;
      this.probeManager?.fail('serial', e);
      this.emit('error', e);
      throw e;
    }
    const p = this.port;
    this.port = null; this.opts = null; this.info = null; this._readTask = null;
    this.emit('close', { unexpected, port: p });
  }

  /** 写入（串行排队：Web Serial 同一时刻只允许一个 write） */
  write(bytes){
    if (!this.isOpen || !this.port) return Promise.reject(new Error('串口未打开'));
    try { if (isProbeCdcPort(this.port)) this.probeManager?.cdcMode.assertUart(); }
    catch (e){ return Promise.reject(e); }
    const generation = this._epoch;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    /**
     * 🚨 catch 里**不要 rethrow**：那会把 `_wq` 这条链永久留在 rejected 状态 ——
     *    之后每次 write() 的 then 体都被跳过（一个字节都写不出去），却对着同一个
     *    **旧**错误重复 emit('error')，直到重开串口。错误已经走过 'error' 事件了，
     *    这里把链恢复成 resolved，让后面的写继续。
     */
    this._wq = this._wq.then(async () => {
      if (!this.isOpen || generation !== this._epoch) throw new Error('串口已关闭或已切换');
      if (isProbeCdcPort(this.port)) this.probeManager?.cdcMode.assertUart();
      if (!this.writer) this.writer = this.port.writable.getWriter();
      await this.writer.write(data);
      this.emit('tx', data);
    }).catch(e => { this.emit('error', e); });
    return this._wq.catch(() => {});
  }

  async setSignals({ dtr, rts }){
    if (!this.isOpen) return;
    if (isProbeCdcPort(this.port)) this.probeManager?.cdcMode.assertUart();
    const s = {};
    if (dtr !== undefined) s.dataTerminalReady = !!dtr;
    if (rts !== undefined) s.requestToSend = !!rts;
    if (Object.keys(s).length) await this.port.setSignals(s);
  }
}
