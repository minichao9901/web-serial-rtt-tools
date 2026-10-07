/**
 * 真机传输：用 **WebUSB + CMSIS-DAP** 把 `riscv-dm.js` 接到探针上。
 *
 * 数据通路（都是探针 interface 0 上的标准 CMSIS-DAP v2，bulk OUT 0x02 / IN 0x81）：
 *   HID（0xFF00 那条）→ 切探针 output_mode = SWD+JTAG（RAM-only，掉电即失）
 *   WebUSB           → DAP_Connect(2) → DAP_JTAG_Configure(irlen=5) → 一批 DAP_JTAG_Sequence
 *
 * `DAP_JTAG_Sequence` 的封包/解包**照探针固件 `DAP.c` 的实现**写（不是照记忆）：
 *   请求：`[0x14, 条数, (info, TDI 数据 ceil(拍/8) 字节) × 条数]`
 *         —— TDI 字节**无论 TMS 是 0 还是 1 都要给**（固件无条件 `request += count` 取走）
 *   响应：`[0x14, DAP_OK, 需要的 TDO 数据…]`，只有 info 的最高位（捕获位）置起的那些序列才回数据
 *
 * ⚠️ **本文件未在真机上验证**（探针被占用）。协议部分与固件源码逐行对齐，封包/解包有离线自测；
 *    真机 bring-up 时最可能需要调的三处：output_mode 切换是否需要 save、idle 拍数、DAP 包长协商。
 */

import { DAP, DAP_PORT, tapReset, tapLoadIR } from './jtag.js';
import { IR_DMI } from './riscv-dm.js';

/** 探针 output_mode 设置（来自 akaLinkPro 的 `script_test/hpm6800_probe.py set_mode()`，照抄）*/
export const PROBE_OUTPUT_MODE = { SWD_VCOM: 0, SWD_JTAG: 1 };
export const setOutputModeData = mode => Uint8Array.of(mode & 0xff, 1, 0, 1, 0, 0xc4, 0x0c);

/** 把一串序列封成 DAP_JTAG_Sequence 的请求（不含命令字节）*/
export function packJtagSequences(seqs){
  let n = 1;                                   // 条数
  for (const s of seqs) n += 1 + s.tdi.length;
  const out = new Uint8Array(n);
  out[0] = seqs.length & 0xff;
  let o = 1;
  for (const s of seqs){
    out[o++] = s.info;
    out.set(s.tdi, o);
    o += s.tdi.length;
  }
  return out;
}

/**
 * 解析 DAP_JTAG_Sequence 的响应（已剥掉命令回显）。
 * @returns {Uint8Array[]} 只含**需要捕获**的那些序列的 TDO 字节，顺序与请求一致
 */
export function parseJtagSequenceResponse(body, seqs){
  if (body[0] !== 0x00) throw new Error(`DAP_JTAG_Sequence 返回状态 0x${body[0].toString(16)}（非 OK）`);
  const out = [];
  let o = 1;
  for (const s of seqs){
    const bytes = s.tdi.length;
    if (s.captureBytes > 0){
      if (o + bytes > body.length) throw new Error('DAP_JTAG_Sequence 响应长度不足（协议/包长不对？）');
      out.push(body.subarray(o, o + bytes));
      o += bytes;
    }
  }
  return out;
}

/**
 * 真机 transport：把一个已打开的 `WebUsbDapProbe`（见 app/rtt/dap-webusb.js，
 * 它负责认领 interface 0 / 端口复位 / 陈旧包丢弃）包成 `riscv-dm.js` 要的形状。
 */
export class DapJtagTransport {
  /**
   * @param {{_ctrl:(cmd:number, payload?:Uint8Array)=>Promise<Uint8Array>, device:any}} probe
   * @param {{irLength?:number, log?:Function}} [opts]
   */
  constructor(probe, opts = {}){
    this.probe = probe;
    this.irLength = opts.irLength ?? 5;
    this.log = opts.log || (() => {});
    this.jtag = false;
    this.batches = 0;
    this.bytes = 0;
  }

  get connected(){ return !!(this.probe && this.probe.device && this.probe.device.opened); }

  /** DAP_Connect(JTAG) + DAP_JTAG_Configure(irlen)。**必须在 init() 之前调**（riscv-dm 会调它）*/
  async connectJtag(){
    if (!this.connected) throw new Error('探针还没连上（先「连接探针」+「连接数据端点」）');
    const r = await this.probe._ctrl(DAP.CONNECT, Uint8Array.of(DAP_PORT.JTAG));
    const granted = r[0];
    if (granted !== DAP_PORT.JTAG){
      throw new Error(`DAP_Connect 没拿到 JTAG 口（返回 ${granted}）——` +
        ' 多半是探针的 output_mode 还不是 SWD+JTAG：本页会先发 HID 设置，若仍失败就拔插一次探针');
    }
    // DAP_JTAG_Configure：请求 = 设备数 + 每个 TAP 的 IR 长度
    const cfg = await this.probe._ctrl(DAP.JTAG_CONFIGURE, Uint8Array.of(1, this.irLength));
    if (cfg[0] !== 0x00) throw new Error(`DAP_JTAG_Configure 失败（状态 0x${cfg[0].toString(16)}）`);
    this.jtag = true;
    this.log(`DAP 已切到 JTAG（IR 长度 ${this.irLength}，TAP 数 ${cfg[1] ?? 1}）`);
  }

  /** 读 TAP IDCODE（探活用；失败说明 JTAG 链路/接线/上电有问题）。
   *  🚨 **必须带一个字节的 TAP 序号**：固件 `DAP_JTAG_IdCode` 把 `*request` 当 device index，
   *    不带的话它读到的是缓冲区里的垃圾 → `index >= count` → 直接回 `DAP_ERROR(0xFF)`
   *    （2026-10 真机实测就是 0xff，卡了好一会儿）。akaLinkPro 的示例脚本也没带这个字节。*/
  async idcode(index = 0){
    const r = await this.probe._ctrl(DAP.JTAG_IDCODE, Uint8Array.of(index & 0xff));
    if (r[0] !== 0x00) throw new Error(`DAP_JTAG_IdCode 失败（状态 0x${r[0].toString(16)}）——` +
      ' 检查 JTAG 接线/供电，或探针 output_mode 是不是刚被切回去');
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    return dv.getUint32(1, true) >>> 0;
  }

  /** 一批 JTAG 序列（riscv-dm 的 `sequences()` 直接调它）*/
  async jtagSequences(seqs, { deadline } = {}){
    if (!this.jtag) throw new Error('还没切到 JTAG（先 connectJtag()）');
    const body = await this.probe._ctrl(DAP.JTAG_SEQUENCE, packJtagSequences(seqs), { deadline });
    this.batches++;
    this.bytes += body.length;
    return parseJtagSequenceResponse(body, seqs);
  }

  /** 常用批次：TAP 复位 + 装 IR（真机调试时可以单独拿来探活）*/
  async resetTapAndLoadIR(ir = IR_DMI){
    await this.jtagSequences(tapReset());
    await this.jtagSequences(tapLoadIR(ir, this.irLength));
  }

  /** 诊断摘要（页面显示/日志用）*/
  summary(){
    return { jtag: this.jtag, batches: this.batches, bytes: this.bytes, irLength: this.irLength };
  }
}
