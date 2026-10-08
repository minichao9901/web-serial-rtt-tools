/**
 * HPM 系列（RISC-V）WebUSB 烧录流程 —— 把 flashloader 搬进目标 SRAM 再驱动它。
 *
 * 与 ARM 那边的 flashloader 是同一套思路（`app/flash/runner.js` + `algos.js`），差别只在"怎么调"：
 *   ARM：写 DHCSR 停核、写 DCRSR/DCRDR 传参、靠 BKPT 停住；
 *   RISC-V：抽象命令写 a0..a4、写 dpc 当 pc、resume 之后**轮询 dmstatus.allhalted**
 *           （算法最后一条是 ebreak → 硬件 halt），返回码在 a0。
 *
 * 🚨 轮询 halt 时**不能**再写 haltreq：那会把还在跑的算法当场打断（返回码就永远是垃圾）。
 *
 * 算法 blob 的来源与入口表语义见 `tools/target-firmware/hpm_flash_algo/README.md`；
 * 公共 blob 与官方 hpm_xpi 的参数化设计一致；板级差异由 target port 提供。
 */

import { HPM_ALGO, hpmAlgoBytes } from './algo.js';
import { algoEntries } from './entry.js';
import { hpmInitArgs, hpmCheckRange } from './chips.js';
import { resolveHpmTarget, hpmWorkLayout, assertHpmIdentity } from '../../targets/hpm/porting.js';
import { xipCopyBytes } from './xip-copy.js';

/** flashloader 调用 ROM API 的返回码（`hpm_stat_t`，只列常见的）*/
export const HPM_STATUS = {
  0: '成功',
  1: '参数无效（invalid argument）',
  2: '地址/长度越界（out of range）',
  3: '超时（timeout）',
  4: '没找到 flash（no flash）',
  5: 'flash 未初始化',
  6: '扇区被保护',
  101: 'XPI 未初始化',
};
export const hpmStatusText = c => HPM_STATUS[c >>> 0] || `未知状态 0x${(c >>> 0).toString(16)}`;

export class HpmFlasher {
  /**
   * @param {import('./riscv-dm.js').RiscvTransport} dm 已经 init 过的传输层
   * @param {{board:object, log?:Function, chunkBytes?:number, onProgress?:Function}} opts
   */
  constructor(dm, opts){
    if (!opts?.board) throw new Error('HpmFlasher 需要 board（见 chips.js 的 HPM_BOARDS）');
    this.dm = dm;
    this.port = resolveHpmTarget(opts.board);
    if (!this.port.flash) throw new Error('所选目标没有 HPM Flash port');
    this.board = { ...this.port };
    this.resetFirst = opts.resetFirst !== false;
    this.log = opts.log || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    /**
     * 中转区一次搬多少字节。
     *
     * 🚨 2026-10 对照 OpenOCD 定标：原来是 4 KB —— 243 KB 镜像要调 **60 次** `flash_program`
     *    + 60 次 `flash_read`，每次都要"写 a0..a4 → prepareRun(dcsr+fence.i) → resume →
     *    轮询等 halt → 读回 a0"（实测每次 20~70 ms），光这部分就吃掉十几秒。
     *    默认取 64 KB；实际分块按 port 工作区扣除算法、拷贝例程和栈后收缩。
     */
    this.layout = hpmWorkLayout(this.port, hpmAlgoBytes().length, xipCopyBytes().length, opts.chunkBytes ?? 65536);
    Object.assign(this, this.layout);
    this.inited = false;
    this.entries = null;
    this.chipInfo = null;
  }

  /** 把算法写进 SRAM 并调 flash_init + flash_get_info（拿到芯片回报的真实容量/扇区）*/
  async setup(){
    this.inited = false; this.chipInfo = null;
    /**
     * 🚨 **先 reset-halt 把 XPI 打回 POR 态**（2026-10 真机 A/B 定因，见 `RiscvTransport.resetHalt`）：
     *    目标上跑着 flash_sdram_xip 的应用时，它已经把 XPI 配过一遍；在那种状态下跑 flash_init
     *    再 erase，**第一次写类操作会把核楔死**（历史日志"第一次 erase 必卡 60 s"）。
     *    reset-halt 让核停在复位向量、应用来不及重配 XPI，实测同参数 erase 从 >60 s 变成 118 ms。
     *    `opts.resetFirst === false` 可关掉（离线自测/特殊场合用）。
     */
    /* Reset/init sequencing belongs to the port. Fail before loading code if it cannot complete. */
    assertHpmIdentity(this.port, { idcode: this.dm.idcode });
    await this.port.hooks.prepareFlash({ dm: this.dm, port: this.port, resetFirst: this.resetFirst });
    assertHpmIdentity(this.port, { idcode: this.dm.idcode });
    const bytes = hpmAlgoBytes(this.loadAddr);
    const parsed = algoEntries(bytes);
    if (parsed.count < 7){
      throw new Error(`flashloader 入口表只认出 ${parsed.count} 个入口（期望 7）—— blob 不对？`);
    }
    this.entries = parsed.byName;
    for (const name of ['init', 'erase', 'program', 'read', 'info', 'eraseChip', 'deinit']){
      if (!this.entries[name]) throw new Error(`flashloader 缺少入口 ${name}`);
    }
    // Layout was validated before any target command in the constructor.
    this.log(`准备 flashloader：${bytes.length} B（入口 7 个，偏移 ` +
      Object.entries(this.entries).map(([k, v]) => `${k}+0x${v.entryOffset.toString(16)}`).join(' ') + '）');
    await this.dm.writeMem(this.loadAddr, bytes);
    this.log(`写完 flashloader：${bytes.length} B → SRAM 0x${this.loadAddr.toString(16)}`);

    /**
     * 🚨 **写完立刻读回校验**（2026-10 真机教训）：SBA 写丢字（例如 DMI 忙时被丢掉的那条写）
     *    不会报错，只会让核跑一段残缺代码 —— 表现是"加载完 flashloader 就卡住"，
     *    排查起来极费劲（用户看到的只是转圈）。1388 B 读回约 0.2 s，换一个**当场能看懂的报错**很值。
     */
    const back = await this.dm.readMem(this.loadAddr, bytes.length);
    let badAt = -1;
    for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]){ badAt = i; break; }
    if (badAt >= 0){
      throw new Error(`flashloader 写进 SRAM 后读回不一致（第 ${badAt} 字节：写 0x${bytes[badAt].toString(16)}、` +
        `读回 0x${back[badAt].toString(16)}）—— SBA 写丢了数据，别继续跑（会卡死）。` +
        ' 常见原因：探针/目标被别的会话抢占（另一个标签页的 RTT 转发、RTT Viewer）、USB 线材或供电不稳。' +
        ' 先关掉其他会话、拔插一次探针再试');
    }

    /**
     * 🚨 **同时把 XIP 拷贝例程写进 SRAM**（2026-10 LA 对照 OpenOCD 后加的，见 `xip-copy.js`）。
     *    verify 靠它从 XIP 窗口把 flash 搬回 RAM —— **不再碰 ROM 的 `flash_read`**（那个会楔死总线）。
     *    它必须每次 setup 都写：`recoverCore()` 会重写算法区，而这里紧挨着算法区。
     */
    const copyBytes = xipCopyBytes();
    await this.dm.writeMem(this.copyAddr, copyBytes);
    const copyBack = await this.dm.readMem(this.copyAddr, copyBytes.length);
    for (let i = 0; i < copyBytes.length; i++){
      if (copyBack[i] !== copyBytes[i]){
        throw new Error(`XIP 拷贝例程写进 SRAM 后读回不一致（第 ${i} 字节）—— SBA 写丢了数据，别继续跑`);
      }
    }
    this.log(`XIP 拷贝例程就绪：${copyBytes.length} B → SRAM 0x${this.copyAddr.toString(16)}（verify 走 CPU 读 XIP 窗口，不用 ROM 的 flash_read）`);

    const a = hpmInitArgs(this.board, { 0: HPM_ALGO.headerWords0, 1: HPM_ALGO.headerWords1, 2: HPM_ALGO.headerWords2 });
    let rc = await this.call('init', [a.flashBase, a.header, a.option0, a.option1, a.xpiBase]);
    if (rc) throw new Error(`flash_init 失败：${hpmStatusText(rc)}` +
      `（base=0x${a.flashBase.toString(16)} xpi=0x${a.xpiBase.toString(16)} opt0=0x${a.option0.toString(16)} opt1=0x${a.option1.toString(16)}）`);

    rc = await this.call('info', [a.flashBase, this.scratchInfo]);
    if (rc) throw new Error(`flash_get_info 失败：${hpmStatusText(rc)}`);
    const info = await this.dm.readMem(this.scratchInfo, 8);
    const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
    this.chipInfo = { totalBytes: dv.getUint32(0, true), sectorBytes: dv.getUint32(4, true) };
    if (!this.chipInfo.totalBytes || !this.chipInfo.sectorBytes ||
        this.chipInfo.totalBytes % this.chipInfo.sectorBytes ||
        this.chipInfo.sectorBytes % 4 ||
        this.board.flashBase + this.chipInfo.totalBytes > 0x100000000){
      throw new Error(`flashloader 回报的容量不合理（总 ${this.chipInfo.totalBytes} B / 扇区 ${this.chipInfo.sectorBytes} B）——` +
        ' 多半是 XPI 没配起来（option0/1 或 xpi_base 与板子不符）');
    }
    this.board.flashSize = this.chipInfo.totalBytes;
    this.inited = true;
    this.log(`flashloader 就绪：总容量 ${(this.chipInfo.totalBytes / 1048576).toFixed(2)} MB · 扇区 ${this.chipInfo.sectorBytes} B`);
    return this.chipInfo;
  }

  /**
   * 调一个入口：写 a0..a4 → 写 pc → resume → 等 halt → 读 a0。
   *
   * 🚨 2026-10 用户现场（线上页点「烧录」卡在"加载 flashloader"转圈，**而且把板子扔在核跑飞状态**
   *    —— 之后 ping 都不通，看起来像板子坏了）：
   *    算法末尾那条 `ebreak` 没回来（`waitHalted` 超时），旧代码直接抛错走人，
   *    核还在跑那半截代码/垃圾指令。现在：
   *      · **第 1 次没回来就地自愈再跑一次**（强行 halt → 复位 DM → 重装算法镜像并读回校验 →
   *        重新置 `dcsr.ebreak*` + `fence.i`）—— 这条 JTAG/SBA 通路偶发丢拍，"重来一次就过"是常态；
   *      · 两次都不过才抛错，并且由调用方（`view.js`）兜底做一次 `recoverAfterFailure()` 别让核飞着。
   */
  async call(entry, args = [], timeoutMs = 20000){
    const e = this.entries[entry];
    if (!e) throw new Error(`没有入口 ${entry}`);
    return await this.callAt((this.loadAddr + e.entryOffset) >>> 0, args, timeoutMs);
  }

  /**
   * 跑 SRAM 里**任意一段以 `ebreak` 收尾的例程**（算法入口与 `xip-copy.js` 的拷贝例程共用）。
   * @param {number} addr 例程入口（SRAM 绝对地址）
   */
  async callAt(addr, args = [], timeoutMs = 20000){
    await this.dm.writeReg(0x1002, this.stackTop); // RV32 ABI: an aligned, reserved stack inside work area.
    // 参数放 a0..a4（x10..x14）
    for (let i = 0; i < args.length; i++) await this.dm.writeReg(0x1000 + 10 + i, args[i] >>> 0);
    // 🚨 跑之前必须：置 dcsr.ebreak*（否则收尾的 ebreak 变成异常，核跑飞）+ fence.i（刚写进去的代码）
    await this.dm.prepareRun();
    await this.dm.resume(addr >>> 0, this.port.debug.hart);
    await this.dm.waitHalted(timeoutMs);
    return (await this.dm.readReg(0x1000 + 10)) >>> 0;
  }

  /**
   * 核跑飞之后的现场恢复：`haltreq` 停住 → 复位 DM（dmactive 0→1）→ 重新 halt →
   * 把算法镜像**再写一遍并读回校验**（DMI 丢字 / 指令预取拿到旧内容都靠这步兜住）。
   */
  async recoverCore(){
    const bytes = hpmAlgoBytes(this.loadAddr);
    try { await this.dm.halt(this.port.debug.hart, 3000); } catch { /* 停不住也继续往下试 */ }
    try { await this.dm.init(); } catch { /* DM 复位失败就让后面的读去报错 */ }
    await this.dm.activate(this.port.debug.hart);
    await this.dm.halt(this.port.debug.hart, 3000);
    await this.dm.writeMem(this.loadAddr, bytes);
    const back = await this.dm.readMem(this.loadAddr, bytes.length);
    for (let i = 0; i < bytes.length; i++){
      if (back[i] !== bytes[i]){
        throw new Error(`恢复时重写算法仍不一致（第 ${i} 字节：写 0x${bytes[i].toString(16)}、读回 0x${back[i].toString(16)}）` +
          ' —— 探针↔目标链路不稳，建议拔插一次探针/给板子断电重上电再烧');
      }
    }
    const copy = xipCopyBytes();
    await this.dm.writeMem(this.copyAddr, copy);
    const copyBack = await this.dm.readMem(this.copyAddr, copy.length);
    if (copy.some((b, i) => b !== copyBack[i])) throw new Error('恢复时 XIP 拷贝例程读回不一致');
    this.log('   已恢复现场（核已停、DM 已复位、算法镜像已重写并校验）');
  }

  /**
   * **失败收尾**：烧录中途失败时调用，尽量别把核扔在"跑飞"状态
   * （用户看到的会是"板子 ping 不通了、像坏了"，实际只是核在跑垃圾）。
   */
  async recoverAfterFailure(){
    try { await this.dm.halt(this.port.debug.hart, 2000); } catch { /* 停不住就算了 */ }
    try { await this.port.reset.run(this.dm, this.port.debug.hart); } catch { /* 复位失败也认了 */ }
  }

  /**
   * 擦除 [addr, addr+len)：算法内部按扇区/块自己安排。
   *
   * 🚨 **传给算法的是"偏移"，不是绝对地址**（2026-10 真机定标）：
   *    算法里 `flash_erase/program/read` 只在 `ROMAPI_SUPPORTS_HYBRIDXPI()`
   *    （ROM API 版本 ≥ 0x56010300）时才做 `address += flash_base`；HPM6800EVK 这版 ROM
   *    不是 hybrid，所以 `address` 必须**相对 XPI 窗口**（0x80000000 起算的偏移）。
   *    实测：传绝对地址 0x80000000 → `rc=2`（out of range）；传偏移 → 擦/写/读全部 rc=0。
   *    对外的 API 仍然用绝对地址（好看、好和芯片规格对照），在调用点换算。
   */
  async erase(addr, len){
    const chk = hpmCheckRange(this.board, addr, len);
    if (!chk.ok) throw new Error('擦除范围不合法：' + chk.why);
    if (!this.inited) throw new Error('先 setup()');
    /**
     * 🚨 **擦除范围必须对齐到扇区**（2026-10 对照 OpenOCD 定标）。
     *    OpenOCD 的 `flash write_image` 会自己补齐并打一行
     *    `Warn : Adding extra erase range, 0x80000000 .. 0x800003ff`；
     *    我们原来把 ELF 段里那个**非对齐**的范围（如 `0x80000400 + 3.1 KB`，起点落在扇区中间）
     *    直接交给 ROM API，实测会**卡住不回来**（等 halt 超时）。
     *    对齐规则：起点向下取整到扇区、终点向上取整（多擦的字节本来也要写，语义等价）。
     */
    const sec = this.chipInfo?.sectorBytes || 4096;
    const start = (addr >>> 0) - ((addr >>> 0) % sec);
    const end = Math.ceil(((addr >>> 0) + len) / sec) * sec;
    const aligned = end - start;
    if (start !== (addr >>> 0) || aligned !== len){
      this.log(`擦除范围对齐到扇区：0x${start.toString(16)} + ${aligned} B` +
        `（原 0x${(addr >>> 0).toString(16)} + ${len} B）`);
    }
    const rc = await this.withAlgoRetry('erase', [this.board.flashBase, this.offsetOf(start), aligned >>> 0], 60000,
      `擦除 0x${start.toString(16)} + ${aligned} B`);
    if (rc) throw new Error(`flash_erase 失败：${hpmStatusText(rc)}`);
    this.log(`已擦除 0x${start.toString(16)} 起 ${aligned} B`);
  }

  /**
   * 跑一次算法调用，**"没回来"就地自愈后重跑一次**。
   *
   * 🚨 自愈必须包含 **重新 `setup()`**（`flash_init` + `flash_get_info`）：
   *    实测只重启核的话，ROM API 内部状态是乱的，下一次调用直接回
   *    `rc=2（地址/长度越界）` —— 反而比不重试更迷惑（2026-10 真机日志）。
   */
  async withAlgoRetry(entry, args, timeoutMs, label){
    try {
      return await this.call(entry, args, timeoutMs);
    } catch (e){
      if (!/halt 超时|一直 BUSY/.test(String(e?.message || ''))) throw e;
      this.log(`⚠ ${label}：算法没回来（${String(e.message).split('\n')[0]}）→ 停核 + 复位 DM + 重装算法 + 重跑 flash_init，再试一次`);
      await this.recoverCore();       // 停核 / DM 复位 / 重写镜像并读回校验
      await this.setup();             // ROM API 状态重置（关键：别只重启核）
      return await this.call(entry, args, timeoutMs);
    }
  }

  /** 绝对地址 → 算法要的偏移（XPI 窗口内）*/
  offsetOf(addr){
    const off = ((addr >>> 0) - (this.board.flashBase >>> 0)) >>> 0;
    if (off >= (this.board.flashSize >>> 0)) throw new Error(`地址 0x${(addr >>> 0).toString(16)} 不在 flash 窗口内`);
    return off;
  }

  /** 烧写：分块写进 RAM 中转区 → flash_program */
  async program(addr, data){
    if (!this.inited) throw new Error('先 setup()');
    const chk = hpmCheckRange(this.board, addr, Math.ceil(data.length / 4) * 4);
    if (!chk.ok || addr % 4) throw new Error('烧写范围不合法：' + (chk.why || '地址必须 4 字节对齐'));
    const total = data.length;
    for (let off = 0; off < total; off += this.chunkBytes){
      const n = Math.min(this.chunkBytes, total - off);
      const chunk = data.subarray(off, off + n);
      // 中转区必须 4 字节对齐、长度补到 4 的倍数（算法按字写 flash）
      const padded = new Uint8Array(Math.ceil(n / 4) * 4).fill(0xff);
      padded.set(chunk);
      await this.dm.writeMem(this.dataBuf, padded);
      const rc = await this.withAlgoRetry('program', [this.board.flashBase, this.offsetOf(addr + off), this.dataBuf, padded.length], 60000, `烧写 0x${(addr + off).toString(16)}`);
      if (rc) throw new Error(`flash_program 在 0x${(addr + off).toString(16)} 失败：${hpmStatusText(rc)}` +
        (rc === 1 ? '（该地址不是已擦除状态？先擦除，或地址落在别的 flash 窗口）' : ''));
      this.onProgress((off + n) / total, off + n, total);
    }
  }

  /**
   * 把 flash 的一段搬进 RAM 中转区 —— **用 CPU 走 XIP 窗口读，不走 ROM 的 `flash_read`**。
   *
   * 🚨 2026-10 LA 对照 OpenOCD 定因（细节见 `xip-copy.js`）：
   *    ROM 的 `flash_read` 在 flash offset `0x30000` 起、尺寸 ≥32768 时**会把核楔死**
   *    （事务永不完成 → `dmstatus` 恒 running、haltreq 都停不住、cmderr=4）—— 实测 5/5 复现。
   *    而 CPU 自己走 XIP 窗口 `lw` 读同一批地址全部正常，**OpenOCD 用的就是这条路**
   *    （它的 `sbcs/sbaddress0/sbdata0` 写入次数为 0，读内存全靠 progbuf 跑 `lw s1,0(s1)`）。
   *
   * @param {number} flashAddr 绝对地址（XPI 窗口内，如 0x80030000）
   * @param {number} dst SRAM 目的地址
   * @param {number} len 字节数（必须 4 的倍数）
   */
  async copyFromXip(flashAddr, dst, len){
    if (len <= 0) return;
    if (len % 4) throw new Error(`XIP 拷贝要求长度是 4 的倍数（${len}）`);
    try {
      await this.callAt(this.copyAddr, [flashAddr >>> 0, dst >>> 0, len >>> 0], 20000);
    } catch (e){
      throw new Error(`XIP 拷贝例程没回来（读 0x${(flashAddr >>> 0).toString(16)} + ${len} B）：${e.message}` +
        '　—— XPI 窗口可能没配上（flash_init 没跑？）或地址不在 flash 窗口内');
    }
  }

  /**
   * 校验：把 flash 读回 RAM 再逐字节比。
   *
   * 🚨 **绝对不要退回 ROM 的 `flash_read`**（2026-10 定因）：它在这颗芯片的
   *    `0x34000~0x38000` 区段用大尺寸读会把核楔在一条永不完成的 XPI 事务上，
   *    整个会话报废（要 ndmreset 才能救）。改成 CPU 走 XIP 窗口读（`copyFromXip`），
   *    与 OpenOCD 的做法一致，实测同一区段读得又快又稳。
   */
  async verify(addr, data){
    if (!this.inited) throw new Error('先 setup()');
    const chk = hpmCheckRange(this.board, addr, Math.ceil(data.length / 4) * 4);
    if (!chk.ok || addr % 4) throw new Error('校验范围不合法：' + (chk.why || '地址必须 4 字节对齐'));
    let bad = -1, firstBad = null;
    for (let off = 0; off < data.length; off += this.chunkBytes){
      const n = Math.min(this.chunkBytes, data.length - off);
      const padded = Math.ceil(n / 4) * 4;
      // addr 对外是**绝对地址**（如 0x80003000），而 XIP 窗口就是 flashBase 起 —— 直接用
      await this.copyFromXip((addr + off) >>> 0, this.dataBuf, padded);
      const back = await this.dm.readMem(this.dataBuf, padded);
      for (let i = 0; i < n; i++){
        if (back[i] !== data[off + i]){
          if (bad < 0){ bad = off + i; firstBad = { expect: data[off + i], got: back[i] }; }
        }
      }
      this.onProgress((off + n) / data.length, off + n, data.length, true);
    }
    if (bad >= 0){
      throw new Error(`校验失败：0x${(addr + bad).toString(16)} 读到 0x${firstBad.got.toString(16)}，` +
        `期望 0x${firstBad.expect.toString(16)}`);
    }
    return true;
  }

  /** 收尾：flash_deinit + 让目标从 flash 启动（系统复位）*/
  async finish({ run = true } = {}){
    try { await this.call('deinit', [], 3000); } catch { /* 收尾失败不影响结果 */ }
    if (run) await this.port.reset.run(this.dm, this.port.debug.hart);
  }

  /** 一步到位：擦 → 写 → 校验（可选） */
  async flashImage(addr, data, { verify = true, erase = true } = {}){
    await this.setup();
    if (erase) await this.erase(addr, data.length);
    await this.program(addr, data);
    if (verify) await this.verify(addr, data);
    return { addr, bytes: data.length, verified: verify };
  }
}
