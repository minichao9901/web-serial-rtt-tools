/** Compatibility exports; HPM target data/functions live in app/targets/hpm/porting.js. */
export { HPM_COMMON, HPM_BOARDS, hpmBoard } from '../../targets/hpm/porting.js';

/** RV32 flashloader 的入口签名（a0..a4 入参，a0 返回；细节见 tools/target-firmware/hpm_flash_algo/README.md）*/
export const HPM_ALGO_ABI = {
  init: '(flash_base, header, opt0, opt1, xpi_base)',
  erase: '(flash_base, address, size)',
  program: '(flash_base, address, buf, size)',
  read: '(flash_base, buf, address, size)',
  info: '(flash_base, info*)',
  eraseChip: '(flash_base)',
  deinit: '()',
};

/**
 * 组装 `flash_init` 的参数。
 * `header` 的编码：`words(4bit) | tag(0xfcf90) << 12`（见 SDK `xpi_nor_config_option_t`），
 * words = 实际给出的 option 字数（0/1/2）—— 与 OpenOCD 驱动把 cfg 里几个 option 透传下来一致。
 */
export function hpmInitArgs(board, headerConstants){
  const words = board.option1 != null ? 2 : (board.option0 != null ? 1 : 0);
  const H = headerConstants || { 0: 0xFCF90000, 1: 0xFCF90001, 2: 0xFCF90002 };
  return {
    flashBase: board.flashBase >>> 0,
    header: (H[words] ?? (words | (0xfcf90 << 12))) >>> 0,
    option0: (board.option0 ?? 0) >>> 0,
    option1: (board.option1 ?? 0) >>> 0,
    xpiBase: board.xpiBase >>> 0,
    words,
  };
}

/**
 * 范围检查（纯函数，自测里钉住）：允许写入的窗口 = [flashBase, flashBase + flashSize)。
 * `flashSize` 用的是 SDK cfg 里的探测上限；**真实容量**由 `flash_get_info` 在运行时读回，
 * 两者不一致时以芯片回报的为准（见 flash.js 的 `probe()`）。
 */
export function hpmCheckRange(board, addr, len){
  const start = board.flashBase >>> 0;
  const end = start + (board.flashSize >>> 0);
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xffffffff ||
      !Number.isInteger(len) || len <= 0 || addr + len > 0x100000000)
    return { ok: false, why: '长度为零或地址超出 32 位范围' };
  const a = addr, b = addr + len;
  if (a < start) return { ok: false, why: `地址 0x${a.toString(16)} 低于 flash 基址 0x${start.toString(16)}` };
  if (b > end) return { ok: false, why: `末端 0x${b.toString(16)} 超出 ${(board.flashSize / 1048576).toFixed(0)} MB 窗口` };
  return { ok: true };
}
