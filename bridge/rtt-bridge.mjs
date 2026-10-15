#!/usr/bin/env node
/**
 * rtt-bridge —— 给「串口 / RTT 工具箱」网页当本地桥（**可选**，零安装模式不需要它）。
 *
 * 为什么存在：J-Link 与 OpenOCD 都是本机程序，浏览器无权启动进程、也无权开 TCP。
 * 桥做三件事：
 *   ① 把仓库里的网页也托管一份到 http://127.0.0.1:17321/（同源 → 没有混合内容/
 *      本地网络访问权限提示；Web Serial 在 localhost 也算安全上下文）；
 *   ② WebSocket 服务（手写握手+帧，零 npm 依赖），把网页的请求翻译成调试器操作；
 *   ③ 两种后端：
 *      · openocd —— 走 OpenOCD 的 Tcl RPC(6666) 读写目标内存 + 控制目标。
 *                   浏览器那边照跑完整 RTT 协议，能力最全（多通道/丢包/下行）。
 *      · jlink   —— J-Link 的 RTT telnet(19021) 字节流转发（ch0 全双工）；
 *                   或用 JLinkRTTLogger 落文件后 tail（只读，可拿其它通道）。
 *
 * 用法：
 *   node bridge/rtt-bridge.mjs --target stm32f103
 *   node bridge/rtt-bridge.mjs --target esp32s31 --attach        # 复用已在跑的 OpenOCD
 *   node bridge/rtt-bridge.mjs --jlink-attach                    # 连本机 19021 的 J-Link RTT
 * 选项见 --help。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0';

/** Stop a backend child without turning a missing Windows utility into an
 * unhandled `error` event on Linux/macOS. `spawn()` reports ENOENT
 * asynchronously, so a surrounding try/catch is not sufficient. */
function terminateChildTree(child){
  if (!child) return;
  if (process.platform === 'win32'){
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('error', () => {});
    } catch {}
  }
  try { child.kill(); } catch {}
}

/* ============================ 参数 ============================ */
function parseArgs(argv){
  const a = { port: 17321, host: '127.0.0.1', root: path.join(__dirname, '..'), target: '', attach: false,
              openocd: '', scripts: '', tclPort: 6666, jlinkAttach: false, jlinkPort: 19021,
              jlinkLogger: '', jlinkDevice: '', jlinkChannel: 0, token: '', allowOrigin: [], doctor: false };
  for (let i = 0; i < argv.length; i++){
    const k = argv[i];
    const next = () => argv[++i];
    switch (k){
      case '--port': a.port = Number(next()); break;
      case '--host': a.host = next(); break;
      case '--root': a.root = path.resolve(next()); break;
      case '--target': a.target = next(); break;
      case '--attach': a.attach = true; break;
      case '--openocd': a.openocd = next(); break;
      case '--scripts': a.scripts = next(); break;
      case '--tcl-port': a.tclPort = Number(next()); break;
      case '--jlink-attach': a.jlinkAttach = true; break;
      case '--jlink-port': a.jlinkPort = Number(next()); break;
      case '--jlink-logger': a.jlinkLogger = next(); break;
      case '--jlink-device': a.jlinkDevice = next(); break;
      case '--jlink-channel': a.jlinkChannel = Number(next()); break;
      case '--doctor': case '--check': a.doctor = true; break;
      case '--token': a.token = next(); break;
      case '--allow-origin': a.allowOrigin.push(...String(next() || '').split(',').map(s => s.trim()).filter(Boolean)); break;
      case '-h': case '--help': a.help = true; break;
      default: console.warn('忽略未知参数：' + k);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help){
  console.log(`rtt-bridge ${VERSION}

用法: node rtt-bridge.mjs [选项]

  --port <n>            监听端口（默认 17321）
  --root <dir>          静态根目录（默认仓库根，网页从 http://127.0.0.1:<port>/ 打开）
  --target <名字>       目标配置名，见 bridge.config.json 的 targets（默认 stm32f103）
  --attach              复用已经在跑的 OpenOCD（不自己启动）
  --openocd <exe>       指定 openocd.exe（默认自动找 ESP-IDF 里那份）
  --scripts <dir>       OpenOCD 的 scripts 目录（默认跟着 openocd.exe 推断）
  --tcl-port <n>        OpenOCD Tcl RPC 端口（默认 6666）
  --jlink-attach        改当 J-Link 流桥：连本机 RTT telnet（默认 19021）
  --jlink-port <n>      J-Link RTT telnet 端口
  --jlink-logger <exe>  JLinkRTTLogger.exe 路径：自己拉一个只读的 RTT 日志流
  --jlink-device <名>   配合 --jlink-logger 用（如 STM32F103C8）
  --doctor              环境预检：Node / 端口 / 静态根 / OpenOCD+scripts / J-Link 逐个查一遍，
                        把找过的路径和该改哪一行都打出来（不启服务，装完工具先跑它）
  --token <串>          WebSocket 口令（默认空 = 不校验；填了就要求 ?token=… 或
                        Sec-WebSocket-Protocol: bearer.<token>）
  --allow-origin <o>    额外允许的 Origin（逗号分隔，可重复）。默认只允许：
                        http://127.0.0.1:* / http://localhost:* / file://（Origin: null）
                        / https://minichao9901.github.io
                        这是防 CSWSH：任何网页都能向 ws://127.0.0.1 发跨源 WebSocket，
                        不拦的话任意网页都能借这座桥驱动本机 OpenOCD/J-Link 读内存甚至烧固件。
`);
  process.exit(0);
}

/* ============================ 配置 ============================ */
function loadConfig(){
  const f = path.join(__dirname, 'bridge.config.json');
  const def = {
    targets: {
      stm32f103: {
        cfgs: ['interface/cmsis-dap.cfg', 'target/stm32f1x.cfg'],
        pre: ['cmsis-dap backend usb_bulk'],
        speed: 1000,
        note: 'CMSIS-DAP + STM32F103（SWD）',
      },
      stm32h7b0: {
        cfgs: ['interface/cmsis-dap.cfg', 'target/stm32h7x.cfg'],
        pre: ['cmsis-dap backend usb_bulk'],
        speed: 4000,
        note: 'CMSIS-DAP + STM32H7B0（SWD，H7A3/7B3/7B0 用同一个 target cfg）',
      },
      esp32s31: {
        cfgs: ['board/esp32s31-builtin.cfg'],
        pre: [],
        speed: 0,
        note: 'ESP32-S31 板载 USB-Serial/JTAG',
      },
      esp32: {
        cfgs: ['board/esp32-wrover-kit.cfg'],
        pre: [],
        speed: 0,
        note: 'ESP32 通用',
      },
    },
  };
  if (!fs.existsSync(f)) return def;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...def, ...j, targets: { ...def.targets, ...(j.targets || {}) } };
  } catch (e){
    console.warn('bridge.config.json 解析失败，用默认配置：' + e.message);
    return def;
  }
}
const config = loadConfig();

function findOpenOcd(){
  if (args.openocd) return args.openocd;
  const home = os.homedir();
  const roots = [
    path.join(home, '.espressif', 'tools', 'openocd-esp32'),
    'C:\\Program Files\\OpenOCD', 'C:\\Program Files (x86)\\OpenOCD',
    // 本机的 xpack OpenOCD（E:\Share\env-windows\xpack-openocd-*\bin\openocd.exe）：
    // 下面按 <root>\<dir>\bin\openocd.exe 的模式扫，正好命中，不用手写 --openocd
    'E:\\Share\\env-windows',
    '/usr/local/share/openocd', '/usr/share/openocd',
  ];
  for (const r of roots){
    if (!fs.existsSync(r)) continue;
    const hits = fs.readdirSync(r).map(d => path.join(r, d, 'openocd-esp32', 'bin', 'openocd.exe'))
      .concat(fs.readdirSync(r).map(d => path.join(r, d, 'bin', 'openocd.exe')))
      .filter(p => fs.existsSync(p)).sort();
    if (hits.length) return hits[hits.length - 1];
  }
  return 'openocd';
}

function openocdScripts(exe){
  if (args.scripts) return args.scripts;
  const base = path.dirname(path.dirname(exe));
  for (const c of [path.join(base, 'share', 'openocd', 'scripts'), path.join(base, 'scripts')]){
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/* ============================ WebSocket ============================ */
class WsConn {
  constructor(socket, onMessage, onClose){
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.alive = true;
    this.frag = null;                    // 分片消息的累积缓冲（见 _parse 的注释）
    socket.on('data', d => {
      this.buf = Buffer.concat([this.buf, d]);
      this._parse();
    });
    socket.on('close', () => { this.alive = false; onClose?.(); });
    socket.on('error', () => { this.alive = false; onClose?.(); });
  }
  _parse(){
    for (;;){
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126){ if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127){
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n){ this.close(1009); return; }
        len = Number(big); off = 10;
      }
      if (len > 64 * 1024 * 1024){ this.close(1009); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload;
      if (masked){
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(b.subarray(off + 4, need));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      } else {
        payload = Buffer.from(b.subarray(off, need));
      }
      this.buf = b.subarray(need);
      if (opcode === 0x8){ this.close(); return; }
      if (opcode === 0x9){ this._frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      /**
       * 🚨 **必须拼接分片**。浏览器发大消息（实测：页面上传 150KB 的 ELF → base64 后 ~205KB）
       *    时会把一个消息拆成多个帧（首帧 opcode=0x1、后续 opcode=0x0 续帧）。
       *    老代码把**每一片都当成完整消息**丢给上层 → `JSON.parse` 失败 →
       *    handle() 里 `catch { return; }` **静默丢弃** → 页面点烧录后永远等不到回包
       *    （现象：#f-result 一直是"—"、桥日志只看到"网页已连接"、没有任何 [flash] 行）。
       *    坑在于**用 Node 客户端测是好的**（Node 的 ws 不分片），只有真页面才复现 ✗。
       */
      if (opcode === 0x2){ this.frag = null; continue; }        // 二进制帧：协议里都走 base64，不用
      if (opcode === 0x1) this.frag = payload;
      else if (opcode === 0x0 && this.frag) this.frag = Buffer.concat([this.frag, payload]);
      else continue;
      if (!fin) continue;                                       // 还没拼完，等下一片
      const whole = this.frag;
      this.frag = null;
      this.onMessage?.(whole.toString('utf8'));
      // 二进制帧暂不用（协议里二进制都走 base64）
    }
  }
  _frame(opcode, payload){
    if (!this.alive) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536){ head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else {
      head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this.alive = false; }
  }
  send(obj){ this._frame(0x1, Buffer.from(JSON.stringify(obj))); }
  /**
   * 发**二进制帧**（opcode 0x2）—— RTT 字节流走这条。
   *
   * 为什么不用 JSON + base64：base64 让体积 +33%，且每个包都要 `JSON.stringify` + base64 编码。
   * ⚠️ 但**别把这条当成提速的银弹**：实测（J-Link PRO + F103，50MHz）改之前之后端到端都是
   *    ~557 → 567 KB/s，因为天花板根本不在转发层，而在数据源（JLinkGDBServerCL 的 RTT telnet
   *    只有 ~565 KB/s，见 JLinkBackend.start 的注释）。二进制帧的价值是：转发层不再额外
   *    放大/编码数据（裸 telnet 565 → 经桥 567 KB/s，已经是 100%），CPU 与内存拷贝也省下来。
   * `_frame` 本来就支持 126/127 两种长度头，32KB 的包自动落到 127（8 字节长度）分支。
   */
  sendBinary(buf){ this._frame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }
  close(code = 1000){
    if (!this.alive) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(0x8, p);
    this.alive = false;
    try { this.socket.end(); } catch {}
  }
}

/* ============================ OpenOCD 后端 ============================ */
class OpenOcdBackend {
  constructor(cfg = {}){
    this.cfg = cfg;                    // 网页传进来的配置（speed = adapter speed，kHz）
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.child = null;
    this.mode = '';
    this.expr = [];
    this.logBuf = [];                  // OpenOCD stdout 环形缓冲（烧录结果里回传给网页看）
    this.flashTarget = null;           // 当前会话服务的目标名（判断能否复用会话）
  }
  get name(){ return 'OpenOCD'; }

  /** 目标三级来源：网页这次指定的预设名 > 网页给的自定义 cfg 列表 > 启动参数 --target */
  resolveTarget(wc = {}){
    let name = wc.target || args.target || 'stm32f103';
    const t = config.targets[name];
    let cfgs, pre;
    if (wc.cfgs?.length){
      // 自定义：cfg 路径相对 OpenOCD scripts 目录，也可绝对路径；第一个是 cmsis-dap 时
      // 自动补 backend usb_bulk（和预设里的 pre 一致，用户不用记这条内部命令）
      cfgs = wc.cfgs;
      pre = wc.pre ?? (String(cfgs[0]).includes('cmsis-dap') ? ['cmsis-dap backend usb_bulk'] : []);
      name = 'custom';
    } else {
      if (!t) throw new Error(`bridge.config.json 里没有目标 "${name}"（网页端可以选「自定义 cfg…」直接给 cfg 列表）`);
      cfgs = t.cfgs || [];
      pre = t.pre || [];
    }
    return { name, t, cfgs, pre };
  }

  async start(onLog){
    const attachOnly = args.attach;
    if (!attachOnly){
      const exe = findOpenOcd();
      const scripts = openocdScripts(exe);
      const { name, t, cfgs, pre } = this.resolveTarget(this.cfg);
      this.flashTarget = name;
      const argv = ['-s', scripts];
      const cfgPath = c => path.isAbsolute(c) ? c : path.join(scripts, c);
      // 顺序要紧：interface cfg 之后立刻设后端（cmsis-dap backend usb_bulk），
      // 再加载 target cfg —— target cfg 会 transport select，之后就不能再改后端了
      if (cfgs.length) argv.push('-f', cfgPath(cfgs[0]));
      for (const c of pre) argv.push('-c', c);
      for (const c of cfgs.slice(1)) argv.push('-f', cfgPath(c));
      // 速度优先级：网页这次连接指定的（自定义档）> bridge.config.json 的 > 不设
      // （RTT 吞吐基本由 SWD 时钟决定：1 MHz 实测 ~68 KB/s，往上还能涨，详见 docs/backends.md）
      const speed = Number(this.cfg?.speed ?? t?.speed ?? 0);
      if (speed > 0) argv.push('-c', `adapter speed ${speed}`);
      argv.push('-c', 'init');
      onLog?.(`启动 OpenOCD：${exe} ${argv.join(' ')}`);
      this.child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      const pushLog = d => {
        for (const line of String(d).split(/\r?\n/)){
          const s = line.trimEnd();
          if (!s) continue;
          this.logBuf.push(s);
          if (this.logBuf.length > 400) this.logBuf.shift();
        }
        onLog?.(String(d).trimEnd());
      };
      this.child.stdout.on('data', pushLog);
      this.child.stderr.on('data', pushLog);
      this.child.on('exit', c => onLog?.(`OpenOCD 退出（code ${c}）`));
      // 等 Tcl RPC 端口起来
      await this._waitPort(args.tclPort, 20000);
      this.mode = 'spawn';
    } else {
      await this._waitPort(args.tclPort, 3000);
      this.mode = 'attach';
    }
    this.sock = await this._connect(args.tclPort);
    const v = await this.rpc('version');
    return { target: this.flashTarget || args.target, version: v.trim().split('\n')[0], mode: this.mode };
  }

  _waitPort(port, ms){
    const t0 = Date.now();
    return new Promise((res, rej) => {
      const tick = () => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); res(); });
        s.once('error', () => {
          s.destroy();
          if (Date.now() - t0 > ms) rej(new Error(`等 OpenOCD 的 ${port} 端口超时`));
          else setTimeout(tick, 250);
        });
      };
      tick();
    });
  }

  _connect(port){
    return new Promise((res, rej) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.setNoDelay(true); res(s); });
      s.once('error', rej);
    });
  }

  /** 发一条 Tcl RPC 命令：以 0x1A 结尾，读到 0x1A 结束 */
  rpc(line, timeout = 30000){
    const socket = this.sock;
    /**
     * 🚨 **必须串行化**：一次只允许一条命令在飞。
     *    每条调用各自挂一个 `data` 监听、共享同一个 socket 和 `this.buf`，两条并发时
     *    同一段回包会被双方各读一次 → 命令与响应错配（RTT 轮询的 mem.read 撞上用户点复位就是）。
     *    OpenOCD 的 Tcl RPC 本来就是"一问一答、0x1A 收尾"，排队既安全又不会拖慢什么。
     */
    const run = () => new Promise((res, rej) => {
      if (!socket || this.sock !== socket) return rej(new Error('OpenOCD 未连接或会话已替换，请重新连接'));
      let done = false;
      const fail = e => {
        if (done) return;
        done = true; cleanup();
        if (this.sock === socket){ this.sock = null; this.buf = Buffer.alloc(0); }
        // Tcl replies have no request ID: a timed-out socket cannot be reused.
        try { socket.destroy(); } catch {}
        rej(e);
      };
      const t = setTimeout(() => fail(new Error(`OpenOCD 命令超时：${line}；连接已关闭，请重新连接`)), timeout);
      const onData = d => {
        if (this.sock !== socket) return fail(new Error('OpenOCD 会话已替换，请重新连接'));
        this.buf = Buffer.concat([this.buf, d]);
        const i = this.buf.indexOf(0x1a);
        if (i >= 0 && !done){
          const out = this.buf.subarray(0, i).toString('utf8');
          this.buf = this.buf.subarray(i + 1);
          done = true; cleanup(); res(out);
        }
      };
      const onErr = e => fail(e);
      const onClose = () => fail(new Error('OpenOCD 连接已断开，请重新连接'));
      const cleanup = () => { clearTimeout(t); socket.off('data', onData); socket.off('error', onErr); socket.off('close', onClose); };
      socket.on('data', onData);
      socket.on('error', onErr);
      socket.on('close', onClose);
      try { socket.write(line + '\n\x1a'); } catch (e){ fail(e); }
    });
    const p = (this._rpcChain || Promise.resolve()).then(run, run);   // 前一条失败也要继续跑下一条
    this._rpcChain = p.catch(() => {});                              // 链尾永远 resolved（不留未处理拒绝）
    return p;
  }

  static _words(text){
    const out = [];
    for (const tok of text.split(/\s+/)){
      if (!/^0x[0-9a-f]+$/i.test(tok)) continue;
      out.push(parseInt(tok, 16) >>> 0);
    }
    return out;
  }

  /** 读内存：4 字节对齐且长度为 4 的倍数时用 32 位宽 + 文本字，否则退化成 8 位宽 */
  async readMem(addr, len){
    if (len <= 0) return new Uint8Array(0);
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    let a = addr, left = len, o = 0;
    const readWords = async (address, width, count) => {
      const w = OpenOcdBackend._words(await this.rpc(`read_memory 0x${address.toString(16)} ${width} ${count}`, 20000));
      if (w.length < count || (width === 8 && w.slice(0, count).some(v => v > 255)))
        throw new Error(`read_memory 数据不完整或无效：${w.length}/${count} 个 ${width} 位值（@0x${address.toString(16)}）`);
      return w;
    };
    // 头部对齐
    if (a & 3){
      const n = Math.min(4 - (a & 3), left);
      const w = await readWords(a, 8, n);
      for (let i = 0; i < n; i++) out[o + i] = w[i] & 0xff;
      a += n; left -= n; o += n;
    }
    while (left >= 4 && (left % 4 === 0 || left >= 8)){
      const n = Math.min(256, left >> 2);                    // 256 字 = 1KB/次（实测比大块更快）
      const w = await readWords(a, 32, n);
      for (let i = 0; i < n; i++) dv.setUint32(o + i * 4, w[i], true);
      a += n * 4; left -= n * 4; o += n * 4;
    }
    if (left > 0){
      const w = await readWords(a, 8, left);
      for (let i = 0; i < left; i++) out[o + i] = w[i] & 0xff;
    }
    return out;
  }

  async writeMem(addr, bytes){
    const data = Buffer.from(bytes);
    if (!data.length) return;
    const aligned = (addr % 4 === 0) && (data.length % 4 === 0);
    if (aligned){
      for (let o = 0; o < data.length; ){
        const n = Math.min(256, (data.length - o) >> 2);
        const words = [];
        for (let i = 0; i < n; i++) words.push('0x' + data.readUInt32LE(o + i * 4).toString(16));
        await this.rpc(`write_memory 0x${(addr + o).toString(16)} 32 {${words.join(' ')}}`, 20000);
        o += n * 4;
      }
    } else {
      for (let o = 0; o < data.length; ){
        const n = Math.min(64, data.length - o);
        const vals = [];
        for (let i = 0; i < n; i++) vals.push('0x' + data[o + i].toString(16).padStart(2, '0'));
        await this.rpc(`write_memory 0x${(addr + o).toString(16)} 8 {${vals.join(' ')}}`, 20000);
        o += n;
      }
    }
  }

  async halt(){ await this.rpc('halt'); }
  async go(){ await this.rpc('resume'); }
  async reset(){ await this.rpc('reset run', 20000); }

  stop(){
    try { this.sock?.destroy(); } catch {}
    /**
     * 子进程用 `taskkill /T /F` 收（和 J-Link 那条路一致）：Windows 上 `child.kill()` 只
     * 终止它自己，而 taskkill /T 连子孙一起收 —— OpenOCD 里那些 adapter 驱动、还有
     * "桥被 Ctrl+C"这种父进程先死的场景，靠它才收得干净。非 Windows 上 taskkill 不存在，
     * 会抛 ENOENT，被下面的 catch 吞掉、退回 `child.kill()`。
     */
    if (this.child){
      terminateChildTree(this.child);
    }
    this.sock = null; this.child = null;
  }
}

/* ============================ J-Link ============================ */
/** 读 config 里的 jlink 段（没有就空对象，调用方各自兜底） */
function cfgJlink(){ return (config && config.jlink) || {}; }

/**
 * 找 JLinkGDBServerCL.exe / JLink.exe / JLinkRTTLogger.exe：
 * 配置 → PATH → 默认安装目录里版本号最大的那份
 */
function findJLinkExe(which = 'server'){
  const name = which === 'server' ? 'JLinkGDBServerCL.exe'
             : which === 'rttlogger' ? 'JLinkRTTLogger.exe'
             : 'JLink.exe';
  const conf = cfgJlink();
  const explicit = which === 'server' ? (conf.gdbserver || args.jlinkServer)
                 : which === 'rttlogger' ? (conf.rttLogger || args.jlinkLogger)
                 : (conf.exe || args.jlinkExe);
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)){
    if (dir) candidates.push(path.join(dir, name));
  }
  for (const base of ['C:/Program Files/SEGGER', 'C:/Program Files (x86)/SEGGER']){
    try {
      for (const d of fs.readdirSync(base)){
        if (/^JLink_/i.test(d)) candidates.push(path.join(base, d, name));
      }
    } catch {}
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return name;                        // 交给 PATH 兜底，让报错更直观
}

/**
 * 极简 GDB RSP 客户端 —— 存在的唯一理由是**让目标跑起来**。
 *
 * 🚨 为什么必须发这一句 `c`：`JLinkGDBServerCL` 连上目标后会把 CPU 按在 **halt** 上，
 *    于是 RTT 只会吐出**缓冲里的存量** —— 实测（STM32F103 + 狂发固件）：12 秒恰好收到
 *    4095 字节 = 一个 4KB 缓冲，之后纹丝不动，看着特别像"RTT 坏了"，其实是目标没在跑。
 *    这里连上 GDB 端口、按 ack 模式（收到包回 `+`）应两声，然后发 `c`（continue）就不管了。
 *    ⚠️ `c` **不会立刻回包**（要等目标停下来才有 stop reply），所以绝不能等它的响应。
 */
function rspContinue(port, onLog){
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    let settled = false;
    const ck = p => { let n = 0; for (const ch of p) n = (n + ch.charCodeAt(0)) & 0xff; return n.toString(16).padStart(2, '0'); };
    const send = p => { try { s.write('$' + p + '#' + ck(p)); } catch {} };
    const done = ok => { if (settled) return; settled = true; ok ? resolve(s) : (s.destroy(), resolve(null)); };
    s.on('data', d => {
      buf += d.toString('latin1');
      let m;
      while ((m = /\$([^$]*)#([0-9a-fA-F]{2})/.exec(buf))){
        buf = buf.slice(m.index + m[0].length);
        try { s.write('+'); } catch {}         // ack 模式：收到每个包都要回 '+'
      }
    });
    s.once('error', e => { if (settled) onLog?.('[jlink] RSP 连接断开：' + e.message); else done(false); });
    s.once('connect', () => {
      send('qSupported:swbreak+');
      setTimeout(() => {
        send('c');                              // ← 本函数存在的全部理由
        onLog?.('[jlink] 已向 GDB 端口发 c（continue）：目标开始运行');
        done(true);
      }, 350);
    });
    setTimeout(() => done(false), 6000);
  });
}

/**
 * J-Link 的 RTT 走 **telnet 字节流**（ch0 全双工）。三种起法：
 *   · spawn（默认）—— 桥**自己拉起** JLinkGDBServerCL 的 RTT telnet，用户不用先开 JLinkRTTViewer；
 *   · attach —— 连一个已经跑着的 RTT telnet（老行为，`--jlink-attach`）；
 *   · logger —— JLinkRTTLogger 落文件后 tail（只读，可拿任意通道）。
 *
 * 🚨 两个实测坑（本机 J-Link V8.82 + STM32F103 亲测）：
 *   ① **绝对不要加 `-singlerun`**：任何一次 TCP 连上 GDB 端口再断开，都会被它当成
 *      "一个 GDB 会话结束"，服务器当场退出 —— 我就这么把自己坑过一次（现象是
 *      `connect ECONNREFUSED`，看着像端口没起，其实是被自己连死的）。
 *   ② server 会先吐一行横幅 `SEGGER J-Link V8.82 - Real time terminal output`，
 *      必须滤掉，否则页面终端里凭空多一行。
 *   另外实测：server 起来后**目标不会被按住**（流里数据一直在走），所以不需要额外 continue。
 */
/**
 * 转发批量化的两个阈值 —— **谁先到算谁**：
 *   · 攒够 32KB 立刻发（数据量一大基本都由它触发，等于"有多大发多大"）
 *   · 否则最多等 20ms 就发（低速时保证实时性：1KB/s 也照样每 20ms 见字）
 * 攒批不是"提速银弹"，它是**摊薄每字节开销**：telnet 的 data 事件很碎（实测每包 ~1.4KB），
 * 不攒的话每 1.4KB 就要付一次 JSON/base64/write 的固定成本。实测帧均值 4KB → 19.7KB。
 * 端到端吞吐的天花板在数据源那边（见 JLinkBackend 的两种模式）。
 */
const STREAM_FLUSH_BYTES = 32 * 1024;
const STREAM_FLUSH_MS = 20;

class JLinkBackend {
  constructor(cfg = {}){
    this.cfg = cfg || {};
    this.sock = null;
    this.child = null;
    this.file = '';
    this.pos = 0;
    this.timer = null;
    this.banner = Buffer.alloc(0);
    this.bannerDone = false;
    this.gdb = null;              // 常连的 GDB RSP 连接（发过 c，让目标一直跑）
    this.mode = '';               // 'logger' | 'spawn' | 'attach'（决定 name 与收尾动作）
    this.outBuf = [];             // 待转发的数据块（攒批用，见 _queue）
    this.outBytes = 0;
    this.flushTimer = null;
    this.onData = null;           // 上层给的"一段字节"消费者（桥里就是发二进制帧那个回调）
  }
  get name(){
    if (this.mode === 'logger') return 'J-Link (RTT logger 高速只读)';
    return this.child ? 'J-Link (RTT ch0 流 · 自启)' : 'J-Link (RTT ch0 流)';
  }
  get port(){ return Number(this.cfg.rttPort || cfgJlink().rttPort || args.jlinkPort || 19021); }
  get device(){ return String(this.cfg.device || this.cfg.jlinkDevice || cfgJlink().device || args.jlinkDevice || 'STM32F103C8'); }
  get speed(){ return Number(this.cfg.speed || cfgJlink().speed || 4000); }
  get gdbPort(){ return Number(this.cfg.gdbPort || cfgJlink().gdbPort || 2331); }

  async start(onLog, onData){
    /**
     * 🚨 转发路径上**唯一**的出入口：telnet 收到的字节先过 `_emit`（滤横幅），
     *    再进 `sink` → `_queue`（攒批），最后才由上层一次性发出去（二进制帧）。
     *    原来这里是 `d => this._emit(d, onData)`：telnet 每来一小包就发一条 base64+JSON 的
     *    WS 消息 —— 小包 + 编码开销，属于"转发层自己给自己加的成本"，现在没有了。
     */
    const sink = d => this._queue(d);
    this.onData = onData;
    const emit = d => this._emit(d, sink);
    /**
     * 高速只读模式：数据源换成 **JLinkRTTLogger**（落文件，桥 tail 转发）。
     *
     * 🚨 为什么需要它（实测，J-Link PRO + STM32F103RB，都是 50MHz SWD）：
     *    · JLinkRTTLogger 直写文件      = **1463 KB/s**（和用户 make do_log 的 1465.7 一致）
     *    · JLinkGDBServerCL 的 RTT telnet = **565 KB/s**（裸读，不经过桥；8192B/帧、约 71 帧/秒
     *      ≈ 每 14ms 才轮询一次 RTT —— 这是 server 自己的节奏，加 GDB 流量也压不上去，
     *      实测每 20ms 塞一个 GDB 请求只从 565 涨到 578 KB/s）
     *    也就是说**桥这条通路的天花板在数据源，不在转发层**：转发层已经做到裸 telnet 的 98%。
     *    想上 1MB/s 只能换源 —— 代价是 logger 只读（不能向下发 stream.write）。
     *    所以这是个**显式选择**：网页上勾「高速只读」走这条，不勾仍走全双工 GDB server。
     */
    const loggerExe = args.jlinkLogger ||
      ((this.cfg.mode === 'logger' || this.cfg.logger === true) ? findJLinkExe('rttlogger') : '');
    if (loggerExe){
      const exe = loggerExe;
      this.mode = 'logger';
      this.file = path.join(os.tmpdir(), `rtt-jlink-${Date.now()}.log`);
      const argv = [];
      if (this.device) argv.push('-Device', this.device);
      argv.push('-If', 'SWD', '-Speed', String(this.speed));
      /**
       * 钉死 RTT 控制块地址（页面从 ELF 里拿到 _SEGGER_RTT 时会给）。
       * 用 `-RTTAddress` 而不是搜索范围：logger 的用法说明里这是直给地址的那个开关，最不含糊。
       * 不传就让它自己搜（自动搜索可能撞上上一份固件留在 RAM 里的旧控制块，见 _spawnServer 的注释）。
       */
      if (this.cfg.rttAddr && Number(this.cfg.rttAddr) > 0){
        argv.push('-RTTAddress', '0x' + Number(this.cfg.rttAddr).toString(16));
      }
      argv.push('-RTTChannel', String(args.jlinkChannel));
      argv.push(this.file);                    // ← 输出文件名必须放最后（logger 的用法要求）
      // 先建空文件再起进程：反过来（先起进程再截断）会把 logger 刚写进去的内容截掉
      fs.writeFileSync(this.file, '');
      this.pos = 0;
      onLog?.(`启动 ${exe} ${argv.join(' ')}`);
      this.child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.stdout.on('data', d => onLog?.(String(d).trimEnd()));
      this.child.stderr.on('data', d => onLog?.(String(d).trimEnd()));
      // 25ms 一轮：1.4MB/s 时一次读 ~35KB，本地文件读不是瓶颈，只为压低"看到字"的延迟
      this.timer = setInterval(() => {
        try {
          const st = fs.statSync(this.file);
          if (st.size > this.pos){
            const fd = fs.openSync(this.file, 'r');
            const buf = Buffer.alloc(st.size - this.pos);
            fs.readSync(fd, buf, 0, buf.length, this.pos);
            fs.closeSync(fd);
            this.pos = st.size;
            sink(buf);                      // 同样走攒批（一轮可能读到几十 KB）
          }
        } catch {}
      }, 25);
      return { mode: 'logger', readOnly: true, file: this.file, device: this.device, speed: this.speed,
               note: `JLinkRTTLogger 高速只读（device=${this.device}，SWD ${this.speed}kHz）：实测 ~1463 KB/s，不能向下发送` };
    }

    let spawned = false;
    if (!args.jlinkAttach && this.cfg.spawn !== false){
      await this._spawnServer(onLog);
      spawned = true;
    }
    // attach：连 J-Link 的 RTT telnet（自启的场景下，这个口就是上面那个 server 开的）
    onLog?.(`连接 J-Link RTT telnet 127.0.0.1:${this.port}`);
    this.sock = await new Promise((res, rej) => {
      const s = net.connect(this.port, '127.0.0.1');
      s.once('connect', () => res(s));
      s.once('error', e => rej(new Error(`连不上 J-Link RTT telnet(${this.port})：${e.message}。` +
        (spawned ? '（server 已启动但端口连不上，看上面的 server 日志）'
                 : '请先用 JLinkRTTViewer 把它开起来，或去掉 --jlink-attach 让桥自启，或用 --jlink-logger。'))));
    });
    this.sock.on('data', emit);
    this.mode = spawned ? 'spawn' : 'attach';
    return {
      mode: this.mode, port: this.port, device: this.device, speed: this.speed,
      note: spawned ? `J-Link 自启 RTT telnet（device=${this.device}，SWD ${this.speed}kHz）：全双工，实测上限 ~565 KB/s（受 server 的 RTT 轮询节奏限制）`
                    : 'J-Link RTT ch0 全双工（telnet）',
    };
  }

  /** 拉起 JLinkGDBServerCL 并等它的 RTT telnet 端口就绪（不带 -singlerun，见类注释） */
  async _spawnServer(onLog){
    const exe = findJLinkExe('server');
    const argv = ['-device', this.device, '-if', 'SWD', '-speed', String(this.speed),
      '-port', String(this.gdbPort), '-RTTTelnetPort', String(this.port), '-silent', '-nogui'];
    /**
     * 🚨 指定 RTT 控制块地址（可选但强烈建议）。
     *    实测踩到：换了固件之后，**上一份固件的 RTT 控制块还留在 RAM 里**（复位不清 RAM），
     *    J-Link 的 RTT 自动搜索先撞上那个旧的，于是页面上显示的是**旧固件的输出** ——
     *    而 flash 里明明是新的（逐字节校验通过）。现象极具误导性。
     *    网页那边从 ELF 里能拿到 `_SEGGER_RTT` 地址，传进来就把搜索范围钉死在那附近。
     */
    if (this.cfg.rttAddr){
      const a = Number(this.cfg.rttAddr);
      if (a > 0) argv.push('-RTTSearchRanges', `0x${a.toString(16)},0x1000`);
    }
    onLog?.(`启动 ${exe} ${argv.join(' ')}`);
    this.child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = null;
    this.child.once('exit', (code) => { exited = code; });
    this.child.stdout.on('data', d => onLog?.(('[jlink] ' + String(d)).trimEnd()));
    this.child.stderr.on('data', d => onLog?.(('[jlink] ' + String(d)).trimEnd()));
    const t0 = Date.now();
    while (Date.now() - t0 < 20000){
      if (exited !== null) throw new Error(`JLinkGDBServerCL 起来就退出了（code=${exited}）：devcie/接线看一下`);
      const ok = await new Promise(res => {
        const s = net.connect(this.port, '127.0.0.1');
        const t = setTimeout(() => { s.destroy(); res(false); }, 600);
        s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });   // 连完立刻断，telnet 口可反复连
        s.once('error', () => { clearTimeout(t); res(false); });
      });
      if (ok){
        // 🚨 端口就绪后**立刻让目标跑起来**，否则 RTT 只出缓冲存量（见 rspContinue 注释）
        this.gdb = await rspContinue(this.gdbPort, onLog);
        if (!this.gdb) onLog?.(`[jlink] ⚠️ 没能连上 GDB 端口(${this.gdbPort})，目标可能仍被 halt：RTT 可能只出存量`);
        return true;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`等 J-Link RTT telnet(${this.port}) 就绪超时 20s —— server 日志见上`);
  }

  /**
   * 滤掉 server 的启动横幅。实测 RTT telnet 口会把 server 自己的启动信息也吐出来，形如：
   *   SEGGER J-Link Ultra V4.0, SN=59789780
   *   Process: JLinkGDBServerCL.exe
   *   ...（可能还有几行）
   * 这些都是**在 RTT 数据之前**的整行文本：逐行判断，丢掉像横幅的行；
   * 一旦遇到不像横幅的行，就把从该行起的内容原样放出去，之后不再过滤。
   * 只按单行匹配是不够的 —— 第一版就是这么写的，结果页面上多出一行 "SEGGER J-Link Ultra…"。
   */
  _emit(d, onData){
    if (this.bannerDone){ onData?.(d); return; }
    this.banner = Buffer.concat([this.banner, d]);
    const isBanner = s => /SEGGER J-Link|^Process:|^Firmware:|^DLL version|^Copyright|Real time terminal output|^Connecting to target|^J-Link>|^Info:|^Warning:/i.test(s.trim());
    let start = 0;
    for (;;){
      const nl = this.banner.indexOf(0x0a, start);
      if (nl < 0) break;
      const line = this.banner.subarray(start, nl + 1);
      if (isBanner(line.toString('latin1'))){ start = nl + 1; continue; }
      this.bannerDone = true;
      const rest = this.banner.subarray(start);
      this.banner = Buffer.alloc(0);
      onData?.(rest);
      return;
    }
    this.banner = this.banner.subarray(start);
    if (this.banner.length > 2048){ this.bannerDone = true; onData?.(this.banner); this.banner = Buffer.alloc(0); }
  }

  /**
   * 攒批：把 telnet 来的碎包堆进 outBuf，等 `_flush` 一次性交出去。
   * 🚨 为什么攒：telnet 的 `data` 事件很碎（实测每包 ~1.4KB），不攒的话每 1.4KB 就要付一次
   *    base64 编码 + `JSON.stringify` + `socket.write` 的固定开销。攒成 32KB 后这些成本被摊薄，
   *    帧均值从 ~4KB 涨到 ~19.7KB。注意：**这不是端到端提速的来源** —— 天花板在数据源
   *    （GDB server 的 telnet 只有 ~565 KB/s），攒批只是保证转发层不成为新的瓶颈。
   */
  _queue(d){
    if (!d || !d.length) return;
    this.outBuf.push(d);
    this.outBytes += d.length;
    if (this.outBytes >= STREAM_FLUSH_BYTES) this._flush();                 // 大数据量：攒够就走
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this._flush(), STREAM_FLUSH_MS);
  }

  /** 把攒着的字节一次性交上层（没东西可发就什么都不做） */
  _flush(){
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.outBytes) return;
    // 只有一块时直接原样发（零拷贝）；多块才拼
    const chunk = this.outBuf.length === 1 ? this.outBuf[0] : Buffer.concat(this.outBuf, this.outBytes);
    this.outBuf = [];
    this.outBytes = 0;
    try { this.onData?.(chunk); } catch {}
  }

  async write(bytes){
    if (this.sock) this.sock.write(bytes);
    else throw new Error('「高速只读」（JLinkRTTLogger）模式下只能读，不能向下发送：'
      + '需要下发就在 J-Link 那组里取消勾选「高速只读」，改走 GDB server 的全双工 telnet');
  }

  stop(){
    clearInterval(this.timer);
    this._flush();                            // 收摊前把攒着的尾巴先发出去，别丢最后一段数据
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.outBuf = [];
    this.outBytes = 0;
    this.onData = null;
    try { this.sock?.destroy(); } catch {}
    try { this.gdb?.destroy(); } catch {}     // 常连的 RSP（它在给目标"继续"状态，必须一起收掉）
    this.gdb = null;
    if (this.child){
      terminateChildTree(this.child);
    }
    /**
     * logger 模式会把 RTT 流全量写进 %TEMP%：1.4MB/s 下一小时就是 ~5GB，
     * 桥不负责长期保存，收摊时删掉（要存档请自己在页面上另存 RTT 记录）。
     */
    if (this.mode === 'logger' && this.file){
      try { fs.rmSync(this.file, { force: true }); } catch {}
    }
    this.sock = null; this.child = null; this.mode = '';
  }
}

/**
 * 用官方 JLink.exe 烧录（一次性进程）。**调用方必须先停掉 RTT 那条会话**——
 * J-Link 同一时刻只允许一个持有者，否则 JLink.exe 连不上探针。
 */
function jlinkFlash({ file, base, device, speed, verify = true, reset = true }, log, timeoutMs = 600000){
  return new Promise((resolve, reject) => {
    const exe = findJLinkExe('exe');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlink-'));
    const script = path.join(dir, 'flash.jlink');
    const lines = ['si SWD', `speed ${speed}`];
    if (device) lines.unshift(`device ${device}`);
    lines.push('connect', 'erase');
    if (/\.bin$/i.test(file)) lines.push(`loadbin ${file}, 0x${Number(base).toString(16)}`);
    else lines.push(`loadfile ${file}`);
    if (verify) lines.push(/\.bin$/i.test(file) ? `verifybin ${file}, 0x${Number(base).toString(16)}` : 'verify');
    if (reset) lines.push('r');
    lines.push('qc');
    fs.writeFileSync(script, lines.join('\n') + '\n');
    log?.(`J-Link 烧录：${exe} -device ${device} -CommanderScript ${script}`);
    log?.('  ' + lines.join(' | '));
    const ch = spawn(exe, ['-device', device, '-if', 'SWD', '-speed', String(speed),
      '-autoconnect', '1', '-CommanderScript', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      terminateChildTree(ch);
      reject(new Error(`JLink.exe 超时（${timeoutMs / 1000}s）：\n${out.slice(-800)}`));
    }, timeoutMs);
    ch.stdout.on('data', d => { out += d; log?.(String(d).trimEnd()); });
    ch.stderr.on('data', d => { out += d; log?.(String(d).trimEnd()); });
    ch.once('error', e => { clearTimeout(timer); reject(new Error('启动 JLink.exe 失败：' + e.message)); });
    ch.once('exit', code => {
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      const bad = /\bERROR\b|Error while|Failed to|cannot|not connected/i.test(out) || code !== 0;
      if (bad) reject(new Error(`J-Link 烧录失败（exit=${code}）：\n${out.slice(-800)}`));
      else resolve(out.trim());
    });
  });
}

/* ============================ HTTP + WS 服务 ============================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  const full = path.join(args.root, p);
  // 前缀比较要带路径分隔符：否则 `E:\root-evil` 也能通过 startsWith（本地服务影响有限，顺手补上）
  const rootAbs = path.resolve(args.root);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)){
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err){
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + p);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

let backend = null;      // 当前后端（OpenOCD 或 J-Link）
let client = null;       // 当前 WS 连接（单客户端足够）

/* ============================ 退出清理 ============================ */
/**
 * **Ctrl+C / 关窗口 / 被 kill 时，必须把调试器子进程一起收掉。**
 *
 * 🚨 为什么：Windows 上父进程退出**不会**带走子进程 —— 桥一退，OpenOCD / JLinkGDBServerCL
 *    就变成孤儿继续占着探针，之后网页/OpenOCD 再连就是"被占 / 连不上"（本机那条
 *    "首连失败十有八九是探针被占（孤儿 OpenOCD）"的经验，有一大半就是这么来的）。
 *    老代码只有"网页断开 WebSocket"那条路会 `backend.stop()`，Ctrl+C 走的是默认退出，什么都不做。
 *
 * 做法：三个终止信号都挂上 → `backend.stop()`（OpenOCD 走 taskkill /T /F，J-Link 还会删 logger
 * 的 %TEMP% 日志）→ 给子进程 250 ms 落地 → 退出；`process.on('exit')` 再兜一次底。
 *
 * @param {string} sig 触发信号（只为日志）
 * @param {{be?:object, exit?:Function, delayMs?:number, log?:Function}} [opts] 测试用注入点
 */
export function cleanupAndExit(sig, opts = {}){
  const be = opts.be !== undefined ? opts.be : backend;
  const exit = opts.exit || (c => process.exit(c));
  const delayMs = opts.delayMs ?? 250;
  const log = opts.log || (s => console.log(s));
  if (cleanupStarted) return false;               // 两个信号连着来（Ctrl+C 连按）只清一次
  cleanupStarted = true;
  log(`\n[退出] 收到 ${sig}：先把调试器子进程收掉（不然会留下孤儿占着探针）…`);
  try { be?.stop(); } catch (e){ log('[退出] 收子进程出错：' + (e?.message || e)); }
  if (be === backend) backend = null;
  try { client?.close(1001); } catch {}      // 告诉网页"桥要走了"，免得它以为还能接着用
  // 给 taskkill / 子进程一点落地时间，再退；250 ms 足够，也不至于让用户觉得"卡住"
  setTimeout(() => exit(0), delayMs);
  return true;
}
let cleanupStarted = false;                      // "只清一次"的进程级开关
function installExitHooks(){
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']){
    try { process.on(sig, () => cleanupAndExit(sig)); } catch {}
  }
  // 正常走完 / 被别的路径 exit 时兜底（exit 回调里只能干同步活，child.kill 是同步的）
  process.on('exit', () => { try { backend?.stop(); } catch {} });
}

/* ============================ WebSocket 准入 ============================ */
/** 默认放行的 Origin。**这不是可选项**：桥只监听 127.0.0.1 挡不住浏览器 ——
 *  任意网页都能向 ws://127.0.0.1:17321/ws 发起跨源 WebSocket（CSWSH），
 *  而这座桥能读目标内存、**还能烧固件**，等于把本机 OpenOCD/J-Link 借给随便哪个网页。 */
const DEFAULT_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'https://minichao9901.github.io'];
function originAllowed(origin){
  if (!origin) return true;                       // 非浏览器（curl/node 脚本）不带 Origin：本机工具，放行
  if (origin === 'null') return true;             // file:// 打开的页面（Origin: null）
  if (args.allowOrigin.includes(origin)) return true;
  for (const base of [...DEFAULT_ORIGINS, ...args.allowOrigin]){
    if (origin === base) return true;
    // 端口不定：同一个主机名换端口也算同一个页面（本地起静态服务器时常见）
    try { if (new URL(origin).hostname === new URL(base).hostname && base.startsWith('http://')) return true; } catch {}
  }
  return false;
}

/** 口令：默认不校验；给了 --token 就必须带对（query 或子协议都行）。
 *  为什么两种都收：浏览器 `new WebSocket(url, protocols)` 能带子协议但页面改起来麻烦，
 *  query 更顺手；两种都在 upgrade 阶段校验，不进来任何业务逻辑。 */
function tokenOk(req){
  if (!args.token) return true;
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.searchParams.get('token') === args.token) return true;
  const proto = String(req.headers['sec-websocket-protocol'] || '');
  return proto.split(',').map(s => s.trim()).includes('bearer.' + args.token);
}

server.on('upgrade', (req, socket) => {
  if (!(req.url || '').startsWith('/ws')){ socket.destroy(); return; }
  const origin = req.headers.origin;
  if (!originAllowed(origin)){
    console.warn(`[ws] 拒绝跨源连接：Origin=${origin}（要放行就加 --allow-origin ${origin}）`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!tokenOk(req)){
    console.warn('[ws] 拒绝连接：口令不对（--token 已启用；页面地址里加 ?token=…）');
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const log = line => client?.send({ t: 'log', line: String(line) });
  const conn = new WsConn(socket, text => handle(conn, text, log), () => {
    backend?.stop(); backend = null; client = null;
  });
  client = conn;
  conn.send({ t: 'ready', version: VERSION, caps: ['mem', 'stream', 'target'],
              targets: Object.keys(config.targets), defaultTarget: args.target || 'stm32f103' });
  console.log('[ws] 网页已连接');
});

/* ============================ 烧录 ============================ */
/**
 * 通过 OpenOCD 烧写固件（elf/hex/bin）。
 * 文件两种来源：wc.path（桥所在电脑上的路径，直接读）或 wc.dataB64（网页选的文件内容，
 * 落临时文件）。复用目标一致的已运行会话（烧完接 RTT 看日志的典型场景）；
 * 目标不一致或没开就（重）拉 OpenOCD —— 同一探针同一时刻只能服务一个目标。
 */
async function flashFirmware(wc, log){
  let file = String(wc.path || '').trim();
  let tmp = null;
  try {
    if (!file){
      if (!wc.dataB64) throw new Error('要给出固件路径，或把文件内容（dataB64）传上来');
      const safe = String(wc.name || 'firmware.bin').replace(/[^\w.\-]/g, '_');
      tmp = path.join(os.tmpdir(), `rtt-tools-flash-${Date.now()}-${safe}`);
      fs.writeFileSync(tmp, Buffer.from(wc.dataB64, 'base64'));
      log?.(`固件落盘：${tmp}`);
      file = tmp;
    }
    file = path.resolve(file).replace(/\\/g, '/');       // Tcl 路径用正斜杠（\t \b 会被当转义吃掉）
    if (!fs.existsSync(file)) throw new Error(`固件文件不存在：${file}`);
    const size = fs.statSync(file).size;

    /**
     * J-Link 分支：交给官方 JLink.exe 一次性烧录（erase → loadfile → verify → r）。
     *
     * 🚨 **先停掉正在跑的 J-Link 会话**（RTT 的 GDB server / telnet 流）：
     *    J-Link 同一时刻只允许一个持有者 —— 两个进程一起抢，后到的那个直接连不上探针。
     *    这和 WebUSB 那边"谁占着调试器"是同一类问题，只是这次是同一家的两个工具在抢。
     *    烧完**不自动重启** RTT 会话：让页面显式再 open 一次，状态最清楚（避免隐式抢回探针）。
     */
    if (wc.backend === 'jlink' || backend instanceof JLinkBackend){
      backend?.stop();
      backend = null;
      const targetName = String(wc.target || wc.chip || '').trim();
      const dev = String(wc.device || wc.jlinkDevice || cfgJlink().device ||
        (config?.targets?.[targetName]?.jlinkDevice) || 'STM32F103C8');
      const speed = Number(wc.speed || cfgJlink().speed || 4000);
      const t0 = Date.now();
      const out = await jlinkFlash({ file, base: wc.base, device: dev, speed,
        verify: wc.verify !== false, reset: wc.reset !== false }, log);
      return {
        target: targetName || dev, file, bytes: size,
        seconds: (Date.now() - t0) / 1000,
        verify: wc.verify !== false, reset: wc.reset !== false,
        backend: 'jlink', device: dev, speed, output: out,
      };
    }

    // 会话复用判断：解析目标名（三级来源同 open）
    const probe = new OpenOcdBackend(wc);
    const { name } = probe.resolveTarget(wc);
    if (!(backend instanceof OpenOcdBackend && backend.flashTarget === name && backend.sock)){
      backend?.stop();
      backend = new OpenOcdBackend({ target: wc.target, cfgs: wc.cfgs, speed: wc.speed });
      await backend.start(log);
    }
    const be = backend;
    // A reused target session must also honor the newly selected flash rate.
    if (Number(wc.speed) > 0) await be.rpc(`adapter speed ${Math.trunc(Number(wc.speed))}`);
    be.logBuf.length = 0;

    const t0 = Date.now();
    const out = [];
    const run = async (cmd, timeout = 60000) => {
      const r = await be.rpc(cmd, timeout);
      out.push(`> ${cmd}`, ...(r ? String(r).trim().split('\n') : []));
      return r;
    };
    if (/\.bin$/i.test(file)){
      // .bin 没有地址信息：显式 halt 后按基地址写入再校验
      const base = Number(wc.base);
      if (!base) throw new Error('.bin 没有地址信息：请在网页里填基地址（STM32 通用默认 0x08000000）');
      await run('reset init', 60000);                              // 写 flash 前必须 halt
      await run(`flash write_image erase {${file}} 0x${base.toString(16)}`, 600000);
      if (wc.verify !== false) await run(`verify_image {${file}} 0x${base.toString(16)}`, 300000);
    } else {
      // elf/hex 自带地址：program 一条龙（reset init → 写 → 校验）
      await run(`program {${file}} verify`, 600000);
    }
    if (wc.reset !== false) await run('reset run', 60000);

    const openocdLog = be.logBuf.splice(0).join('\n').trim();
    const all = out.join('\n') + '\n' + openocdLog;
    if (/\bError:|\bfailed\b|timed out/i.test(all)) throw new Error(`OpenOCD 报错：\n${all.slice(-800)}`);
    return {
      target: name, file, bytes: size,
      seconds: (Date.now() - t0) / 1000,
      verify: wc.verify !== false, reset: wc.reset !== false,
      output: all.trim(),
    };
  } finally {
    if (tmp){ try { fs.unlinkSync(tmp); } catch {} }
  }
}

async function handle(conn, text, log){
  let m;
  try { m = JSON.parse(text); } catch { return; }
  const reply = obj => conn.send({ ...obj, id: m.id });
  try {
    switch (m.t){
      case 'hello':
        // 必须带 id 回（客户端是按 id 匹配请求/响应的）—— 第一版漏了，客户端等 hello 直接超时
        reply({ t: 'ready.ack', caps: ['mem', 'stream', 'target', 'jlink'], version: VERSION,
                targets: Object.keys(config.targets), defaultTarget: args.target || 'stm32f103' });
        break;

      case 'target.cfgs': {
        /**
         * 列出 OpenOCD scripts 目录里**真实存在**的 cfg（页面上的「选择…」按钮用）。
         * 为什么由桥来列：浏览器出于安全**拿不到本地文件的完整路径**（`<input type=file>`
         * 只给文件名），而 OpenOCD 要的是 `target/stm32f4x.cfg` 这种**相对 scripts 目录**的路径。
         * 桥就跑在本机，能直接看到那份目录，列出来让用户点选，填进去的一定是对的路径。
         */
        let exe = '', scripts = '';
        try { exe = args.openocd || config.openocd || findOpenOcd(); } catch {}
        try { scripts = openocdScripts(exe); } catch {}
        const cfgs = [];
        if (scripts && fs.existsSync(scripts)){
          /**
           * 🚨 遍历顺序要**按用处排**，而且**不能在遍历途中截断**：
           *    第一版写了"收集到 500 条就停"，结果按字母序先扫完 `board/`（500+ 个），
           *    `interface/`、`target/` 一个都没进来 —— 而用户要的恰恰是这两个目录
           *    （`interface/cmsis-dap.cfg`、`target/stm32f1x.cfg`）。
           *    现在：先 interface → target → board → 其余，只在**输出**时设上限。
           */
          const rank = n => n === 'interface' ? 0 : n === 'target' ? 1 : n === 'board' ? 2 : 3;
          const walk = (dir, rel = '', depth = 0) => {
            if (depth > 3) return;
            let ents = [];
            try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            const dirs = ents.filter(e => e.isDirectory()).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
            for (const e of ents){
              if (!e.isDirectory() && /\.cfg$/i.test(e.name)) cfgs.push(rel ? `${rel}/${e.name}` : e.name);
            }
            for (const d of dirs) walk(path.join(dir, d.name), rel ? `${rel}/${d.name}` : d.name, depth + 1);
          };
          walk(scripts);
        }
        const total = cfgs.length;
        cfgs.sort((a, b) => {
          const rank = s => s.startsWith('interface/') ? 0 : s.startsWith('target/') ? 1 : s.startsWith('board/') ? 2 : 3;
          return rank(a) - rank(b) || a.localeCompare(b);
        });
        reply({ t: 'cfgs', info: { openocd: exe, scripts, count: cfgs.length, total, cfgs: cfgs.slice(0, 2000) } });
        break;
      }

      case 'open': {
        backend?.stop();
        if (m.backend === 'jlink'){
          backend = new JLinkBackend(m.cfg || {});
          /**
           * RTT 流用**二进制帧**发给网页（原来这里是 `{t:'stream.data', data: base64}`）。
           * 上层（JLinkBackend）已经攒成 ≥32KB / 20ms 一批，这儿直接原样发，零编码开销。
           * 页面侧 app/rtt/bridge.js 两种都认（二进制优先，JSON+base64 的老分支保留，兼容旧桥）。
           */
          const info = await backend.start(log, buf => conn.sendBinary(buf));
          reply({ t: 'opened', info });
          console.log('[jlink] ' + JSON.stringify(info));
        } else {
          backend = new OpenOcdBackend(m.cfg || {});
          const info = await backend.start(log);
          reply({ t: 'opened', info });
          console.log('[openocd] ' + JSON.stringify(info));
        }
        break;
      }

      case 'flash': {
        const info = await flashFirmware(m.cfg || {}, log);
        reply({ t: 'flashed', info });
        console.log('[flash] ' + JSON.stringify({ target: info.target, bytes: info.bytes, seconds: info.seconds }));
        break;
      }

      case 'mem.read': {
        if (!(backend instanceof OpenOcdBackend)) throw new Error('当前后端不支持读内存');
        const buf = await backend.readMem(m.addr, m.len);
        reply({ t: 'mem.data', data: Buffer.from(buf).toString('base64'), len: buf.length });
        break;
      }

      case 'mem.write': {
        if (!(backend instanceof OpenOcdBackend)) throw new Error('当前后端不支持写内存');
        await backend.writeMem(m.addr, Buffer.from(m.data || '', 'base64'));
        reply({ t: 'ok' });
        break;
      }

      case 'target.reset': await backend?.reset(); reply({ t: 'ok' }); break;
      case 'target.halt':  await backend?.halt();  reply({ t: 'ok' }); break;
      case 'target.go':    await backend?.go();    reply({ t: 'ok' }); break;

      case 'stream.write': {
        if (!(backend instanceof JLinkBackend)) throw new Error('当前后端不是流模式');
        await backend.write(Buffer.from(m.data || '', 'base64'));
        reply({ t: 'ok' });
        break;
      }

      default: reply({ t: 'error', message: '未知请求 ' + m.t });
    }
  } catch (e){
    reply({ t: 'error', message: String(e?.message || e) });
  }
}

/**
 * 只有"被当成脚本直接跑"时才起服务 + 挂退出钩子。
 * 为什么加这道门：自测要 `import` 这个模块去测 `cleanupAndExit()` 与两个后端的 `stop()`
 * （收子进程的行为必须用**真的子进程**验），import 时当然不能顺手把端口占了、还挂一堆 signal。
 * 判定用 `process.argv[1]` 与 `import.meta.url` 比 —— 直接 `node rtt-bridge.mjs` 时为真。
 */
const isMain = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return !!entry && entry === path.resolve(fileURLToPath(import.meta.url));
  } catch { return true; }        // 判不出来就按老行为（直接跑）
})();

if (isMain){
  if (args.doctor){
    // 预检只读：不占端口、不起服务、不碰探针（生成的桥包里 check-tools.bat 就是跑它）
    runDoctor().then(bad => process.exit(bad ? 1 : 0)).catch(e => { console.error('[预检] 出错：' + (e?.message || e)); process.exit(1); });
  } else {
    installExitHooks();
    server.listen(args.port, args.host, () => {
      console.log(`\nrtt-bridge ${VERSION}`);
      console.log(`  网页地址 : http://${args.host}:${args.port}/    （同源打开 → 没有本地网络访问权限提示）`);
      console.log(`  WebSocket: ws://${args.host}:${args.port}/ws`);
      console.log(`  静态根   : ${args.root}`);
      console.log(`  目标配置 : ${args.target || '(无，等网页指定)'}`);
      if (args.jlinkAttach){
        console.log(`  J-Link 流: 连 127.0.0.1:${args.jlinkPort}（先用 JLinkRTTViewer 把 RTT 会话开起来）`);
      } else {
        console.log(`  OpenOCD  : ${args.attach ? '复用已在跑的（--attach）' : findOpenOcd()}`);
      }
      console.log('\nCtrl+C 退出（会把 OpenOCD / J-Link 子进程一起收掉，不留孤儿占探针）\n');
    });
  }
}

/** 自测用的出口：两个后端（收子进程的行为要真验）+ 退出清理逻辑 + 环境预检 */
export { OpenOcdBackend, JLinkBackend };

/* ============================ 环境预检（--doctor） ============================ */
/**
 * 环境预检（`--doctor`）：把"为什么跑不起来"一次性说清楚 —— 生成的桥包里 `check-tools.bat` 就是跑它。
 *
 * 设计原则：**每一项都把找过的路径 / 该改哪一行写出来**，别让用户对着"连不上"猜。
 * 退出码：0 = 全就绪；>0 = 有需要处理的项（`check-tools.bat` 据此换结尾话术）。
 *
 * 只读：**不占端口、不起服务、不碰探针**（端口那项是"试听一下再放掉"）。
 */
async function runDoctor(){
  const rows = [];
  const row = (label, ok, text) => { rows.push({ label, ok, text }); };

  // ① Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  row('Node', major >= 18, `v${process.versions.node}${major >= 18 ? '（满足 18+）' : '（太老：要 18 或更高）'}`);

  // ② 静态根（有没有网页副本）
  const rootAbs = path.resolve(args.root);
  const hasWeb = fs.existsSync(path.join(rootAbs, 'index.html'));
  row('静态根', null, `${rootAbs}${hasWeb ? '（有 index.html，可离线用）'
    : '（没有网页 —— 用线上页面 https://minichao9901.github.io/web-serial-rtt-tools/ 也行，它在白名单里）'}`);

  // ③ 端口（试听一下再放掉）
  const portFree = await new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(args.port, args.host);
  });
  row(`端口 ${args.port}`, portFree, portFree ? '空闲 ✓'
    : `被占用 —— 换一个：start-bridge.bat --port ${args.port + 1}（或先关掉已经开着的桥）`);

  // ④ OpenOCD + scripts + 当前目标的 cfg
  let exe = '', scripts = '';
  try { exe = findOpenOcd(); } catch { exe = ''; }
  const exeOk = !!exe && (exe.includes(path.sep) ? fs.existsSync(exe) : true);
  row('OpenOCD', exeOk ? true : null,
    exeOk ? exe : `${exe || '(没找到)'} —— 装一个，或在 bridge.config.json 的 "openocd" 里写绝对路径（也可命令行 --openocd <路径>）`);
  if (exeOk){
    try { scripts = openocdScripts(exe); } catch { scripts = ''; }
    const sOk = !!scripts && fs.existsSync(scripts);
    const probes = ['interface/cmsis-dap.cfg', 'target/stm32f1x.cfg'];
    const miss = sOk ? probes.filter(p => !fs.existsSync(path.join(scripts, p))) : probes;
    row('OpenOCD scripts', sOk ? (miss.length ? null : true) : null,
      sOk ? `${scripts}${miss.length ? `（缺 ${miss.join(' / ')}）` : `（含 ${probes.join(' / ')}）`}`
          : '(没推断出来) —— 在 bridge.config.json 的 "scripts" 里写绝对路径（或命令行 --scripts <路径>）');
  }

  // ⑤ 当前目标的 cfg 是否都在
  const tname = args.target || 'stm32f103';
  const t = config.targets[tname];
  if (t?.cfgs?.length && scripts){
    const missing = t.cfgs.filter(c => !path.isAbsolute(c) && !fs.existsSync(path.join(scripts, c)));
    row(`目标 ${tname}`, missing.length ? null : true,
      missing.length ? `缺 cfg：${missing.join(' / ')}（查 bridge.config.json 的 targets.${tname}.cfgs）`
                     : `${t.cfgs.join(' + ')}${t.speed ? ` @ ${t.speed} kHz` : ''}`);
  } else if (t){
    row(`目标 ${tname}`, null, 'scripts 目录没找到，没法核对 cfg');
  } else {
    // 目标名都不认识 = 真问题（起桥时 resolveTarget 会直接抛）：标 ❌，让退出码带上它
    row(`目标 ${tname}`, false,
      `bridge.config.json 里没有这个目标（可选：${Object.keys(config.targets).join(' / ')}；网页端也可以选「自定义 cfg…」）`);
  }

  // ⑥ J-Link 三件套
  const jl = { server: 'JLinkGDBServerCL.exe', exe: 'JLink.exe', rttlogger: 'JLinkRTTLogger.exe' };
  const found = [];
  for (const [which, label] of Object.entries(jl)){
    const p = findJLinkExe(which);
    const ok = p.includes(path.sep) && fs.existsSync(p);
    found.push(`${label}${ok ? ' ✓' : ' ✗'}`);
    if (which === 'server'){
      row('J-Link', ok ? true : null,
        ok ? p : `${p || '(没找到)'} —— 装 SEGGER J-Link 软件包，或在 bridge.config.json 的 jlink.gdbserver 里写绝对路径`);
    }
  }
  row('J-Link 三件套', null, found.join(' · ') + '（只用 OpenOCD 的话，J-Link 没有也行）');

  // ⑦ 打印（拼好再一次性输出，避免和其它日志交错）
  // ⚠️ 对齐要按**显示宽度**补空格：中文/全角算 2 列，`padEnd` 只数字符 → 标签会参差不齐
  const width = s => [...s].reduce((n, ch) => n + (/[\u1100-\uFFE6]/.test(ch) ? 2 : 1), 0);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
  const out = [`rtt-bridge ${VERSION} · 环境预检（--doctor）`, ''];
  for (const r of rows) out.push(`  ${pad(r.label, 18)}: ${r.text}${r.ok === true ? ' ✅' : r.ok === false ? ' ❌' : ''}`);
  const bad = rows.filter(r => r.ok === false).length;
  out.push('');
  out.push(bad ? `有 ${bad} 项要处理（上面带 ❌ 的）：路径不对就改 bridge.config.json 的 openocd / scripts / jlink.*，`
                 + '\n或者命令行直接传 --openocd / --scripts / --jlink-logger，改完再跑一次本预检。'
               : '预检通过：双击 start-bridge.bat（或直接 node rtt-bridge.mjs）就能起桥了。');
  console.log(out.join('\n'));
  return bad;
}
