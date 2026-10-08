/**
 * HPM 移植入口：新增芯片/板卡只修改本文件的数据与钩子。
 * Flash 共用 SDK openocd_algo；ROM 地址相同不是复用的唯一依据，
 * 官方 hpm_xpi 驱动实际加载统一 flash_algo[]，由 flash_init 参数选择板级配置。
 * 数据来源：HPM SDK v1.11.0 boards/openocd/{soc,boards}/*.cfg。
 */
export const DEFAULT_HPM_BOARD = 'hpm6800evk';
export const HPM_COMMON = Object.freeze({
  tapIdcode: 0x1000563D, irLength: 5, romApiTable: 0x2001FF00,
  workAreaAddr: 0, workAreaSize: 0x20000, xpi0Base: 0x80000000, xpi1Base: 0x90000000,
});
const DEBUG = { tapIdcode: HPM_COMMON.tapIdcode, irLength: 5, hart: 0, idle: 8 };
const MEMORY = {
  workArea: { addr: 0, size: 0x20000 }, healthPeekAddr: 0,
  // Preserve the existing XPI0 SBA fence. Additional windows belong to the chip port.
  sbaReadForbidden: [{ start: 0x80000000, end: 0x90000000 }],
};
const RESET = {
  halt: (dm, hart) => {
    if (typeof dm.resetHalt !== 'function') throw new Error('页面模块版本不一致：没有 resetHalt，请强制刷新页面');
    return dm.resetHalt(hart);
  },
  haltForRun: (dm, hart) => dm._haltByReset(hart),
  run: (dm, hart) => dm.resetRun(hart),
};
async function prepareFlash({ dm, port, resetFirst }){
  if (resetFirst) {
    await port.reset.halt(dm, port.debug.hart);
    await dm.init();
  }
  await dm.activate(port.debug.hart);
  await dm.halt(port.debug.hart, 3000);
}
async function checkHpm6880Ddr({ dm, sym }, addr, length){
  if (!length || addr >= 0x50000000 || addr + length <= 0x40000000 ||
      !sym?.find?.('_init_ext_ram') ||
      !(sym.find('init_ddr3l_1333') || sym.find('init_ddr2_800'))) return;
  const word = async a => {
    const bytes = await dm.readMem(a, 4, 1500);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  };
  // HPM6880 DDR0 resource 263: read always-on SYSCTL before gated DDRCTL.
  const group = await word(0xf4000800), resource = await word(0xf400041c);
  const mode = resource & 3;
  const ready = mode !== 2 && mode !== 3 && (mode === 1 || (group & 0x80)) && !(resource & 0x40000000);
  if (!ready || ((await word(0xf3010004)) & 7) !== 1) {
    const error = new Error('外部 SDRAM 尚未初始化；继续运行到 main 或初始化完成的位置后可读取');
    error.code = 'MEMORY_NOT_READY'; error.sbaHandled = true; throw error;
  }
}
const HOOKS = { prepareFlash, checkMemoryReady: async () => {} };
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const chip = (id, family, rttRange, extra = {}) => freeze({
  id, family, debug: { ...DEBUG, ...extra.debug },
  memory: { ...MEMORY, rttRange, ...extra.memory,
    workArea: { ...MEMORY.workArea, ...extra.memory?.workArea } },
  reset: { ...RESET, ...extra.reset }, hooks: { ...HOOKS, ...extra.hooks },
});
/** RTT defaults are linker-script hints, not a claim that firmware uses noncacheable RAM there. */
export const HPM_CHIPS = freeze({
  hpm5361: chip('hpm5361', 'HPM5300', '0x00080000-0x00090000'),
  hpm5301: chip('hpm5301', 'HPM5301', '0x00080000-0x00090000'),
  hpm5e31: chip('hpm5e31', 'HPM5E00', '0x01200000-0x01210000'),
  hpm6280: chip('hpm6280', 'HPM6200', '0x01080000-0x01090000'),
  hpm6360: chip('hpm6360', 'HPM6300', '0x010C0000-0x010D0000'),
  hpm6750: chip('hpm6750', 'HPM6750', '0x01100000-0x01110000'),
  hpm6880: chip('hpm6880', 'HPM6880', '0x01240000-0x01250000', {
    hooks: { ...HOOKS, checkMemoryReady: checkHpm6880Ddr },
  }),
  hpm6e80: chip('hpm6e80', 'HPM6E80', '0x01280000-0x01290000'),
  hpm6p81: chip('hpm6p81', 'HPM6P81', '0x01200000-0x01210000'),
});
const u32 = (value, name) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`porting ${name} 必须是 32 位无符号整数`);
  return value;
};
/** Custom boards can reuse a chip and override data/functions without changing engines. */
export function createHpmTarget(chipPort, board){
  if (!chipPort || !board?.id) throw new Error('porting 需要芯片配置和板卡 id');
  const debug = { ...DEBUG, ...chipPort.debug, ...board.debug };
  const memory = { ...MEMORY, ...chipPort.memory, ...board.memory };
  memory.workArea = { ...MEMORY.workArea, ...chipPort.memory?.workArea, ...board.memory?.workArea };
  const flash = { ...board.flash };
  for (const key of ['flashBase', 'flashSize', 'xpiBase', 'option0', 'option1'])
    if (Object.hasOwn(board, key)) flash[key] = board[key];
  for (const key of ['flashBase', 'flashSize', 'xpiBase']) u32(flash[key], key);
  if (!flash.flashSize || flash.flashBase + flash.flashSize > 0x100000000) throw new Error('porting Flash 窗口无效');
  for (const key of ['option0', 'option1']) if (flash[key] != null) u32(flash[key], key);
  if (flash.option1 != null && flash.option0 == null) throw new Error('porting option1 需要 option0');
  u32(memory.workArea.addr, 'workArea.addr'); u32(memory.workArea.size, 'workArea.size');
  if (!memory.workArea.size || memory.workArea.addr % 4 || memory.workArea.addr + memory.workArea.size > 0x100000000)
    throw new Error('porting 工作区无效');
  u32(debug.hart, 'hart'); u32(debug.tapIdcode, 'tapIdcode'); u32(debug.idle, 'idle');
  if (debug.hart > 0x3ff || debug.irLength !== 5) throw new Error('porting 不支持的 hart 或 JTAG IR 长度');
  u32(memory.healthPeekAddr, 'healthPeekAddr');
  memory.sbaReadForbidden = memory.sbaReadForbidden.map(r => ({ ...r }));
  if (!memory.sbaReadForbidden.some(r => flash.flashBase >= r.start && flash.flashBase + flash.flashSize <= r.end))
    memory.sbaReadForbidden.push({ start: flash.flashBase, end: flash.flashBase + flash.flashSize });
  for (const range of memory.sbaReadForbidden) {
    u32(range.start, 'SBA fence start');
    if (!Number.isInteger(range.end) || range.end <= range.start || range.end > 0x100000000) throw new Error('porting SBA 窗口无效');
  }
  const reset = { ...RESET, ...chipPort.reset, ...board.reset };
  const hooks = { ...HOOKS, ...chipPort.hooks, ...board.hooks };
  for (const fn of [...Object.values(reset), ...Object.values(hooks)]) if (typeof fn !== 'function') throw new Error('porting 钩子必须是函数');
  return freeze({ portVersion: 1, id: board.id, name: board.name || board.id, chipId: chipPort.id,
    family: chipPort.family, debug, memory, flash, reset, hooks, ...flash });
}
const board = (id, name, chipId, size, xpiBase, option0, option1 = null) => createHpmTarget(HPM_CHIPS[chipId], {
  id, name, flash: { flashBase: 0x80000000, flashSize: size, xpiBase, option0, option1 },
});
export const HPM_BOARDS = freeze([
  board('hpm5300evk', 'HPM5300EVK（HPM5361）', 'hpm5361', 0x2000000, 0xF3000000, 0x5, 0x1000),
  board('hpm5301evklite', 'HPM5301EVKLite', 'hpm5301', 0x2000000, 0xF3000000, 0x5, 0x1000),
  board('hpm5e00evk', 'HPM5E00EVK', 'hpm5e31', 0x2000000, 0xF3000000, 0x5, 0x1000),
  board('hpm6200evk', 'HPM6200EVK（HPM6280）', 'hpm6280', 0x1000000, 0xF3040000, null),
  board('hpm6300evk', 'HPM6300EVK（HPM6360）', 'hpm6360', 0x1000000, 0xF3040000, null),
  board('hpm6750evk2', 'HPM6750EVK2', 'hpm6750', 0x2000000, 0xF3040000, 0x7),
  board('hpm6750evkmini', 'HPM6750EVKMINI', 'hpm6750', 0x1000000, 0xF3040000, 0x7),
  board('hpm6800evk', 'HPM6800EVK（HPM6880）', 'hpm6880', 0x2000000, 0xF3000000, 0x7),
  board('hpm6e00evk', 'HPM6E00EVK（HPM6E80）', 'hpm6e80', 0x2000000, 0xF3000000, 0x7),
  board('hpm6p00evk', 'HPM6P00EVK（HPM6P81）', 'hpm6p81', 0x2000000, 0xF3000000, 0x5, 0x1000),
]);
export const GENERIC_RISCV_PORT = freeze({
  portVersion: 1, id: 'riscv-other', name: '其它 RISC-V',
  debug: { ...DEBUG, tapIdcode: null }, memory: { ...MEMORY, healthPeekAddr: null, rttRange: '' },
  reset: { ...RESET }, hooks: { ...HOOKS },
});
export const hpmBoard = id => HPM_BOARDS.find(b => b.id === id) || null;
export function resolveHpmTarget(value = DEFAULT_HPM_BOARD){
  if (value === 'riscv-other') return GENERIC_RISCV_PORT;
  if (value?.portVersion === 1) return value;
  const known = hpmBoard(typeof value === 'string' ? value : value?.id);
  if (!known) throw new Error(`不认识的 HPM 板卡：${typeof value === 'string' ? value : value?.id}`);
  if (typeof value === 'string') return known;
  return createHpmTarget(HPM_CHIPS[known.chipId], { ...known, ...value });
}
export function assertHpmIdentity(port, info){
  if (port.debug.tapIdcode != null && (info?.idcode >>> 0) !== port.debug.tapIdcode)
    throw new Error(`TAP IDCODE 与 ${port.name} 不符：0x${(info?.idcode >>> 0).toString(16)}；期望 0x${port.debug.tapIdcode.toString(16)}`);
  // Shared IDCODE identifies the TAP, not the specific HPM chip; board selection is explicit.
}
export const overlapsSbaFence = (port, addr, length) => length > 0 &&
  port.memory.sbaReadForbidden.some(r => addr < r.end && addr + length > r.start);
/** Allocate code/copy/info/data/stack inside one work area; all intervals are disjoint. */
export function hpmWorkLayout(port, algoBytes, copyBytes, requestedChunk = 65536){
  const { addr, size } = port.memory.workArea;
  const align = (n, a) => Math.ceil(n / a) * a;
  if (![algoBytes, copyBytes, requestedChunk].every(n => Number.isInteger(n) && n > 0)) throw new Error('工作区尺寸/分块必须是正整数');
  const copy = align(addr + algoBytes, 256), info = align(copy + copyBytes, 4096), data = info + 4096;
  const stackTop = Math.min(0xfffffff0, Math.floor((addr + size) / 16) * 16), stackBottom = stackTop - 4096;
  const maxChunk = Math.floor((stackBottom - data) / 4) * 4;
  if (maxChunk < 4 || overlapsSbaFence(port, addr, size)) throw new Error('算法、拷贝例程、数据区和栈放不进工作区');
  return Object.freeze({ loadAddr: addr, copyAddr: copy, scratchInfo: info, dataBuf: data,
    stackTop, stackBottom, chunkBytes: Math.min(align(requestedChunk, 4), maxChunk), maxChunk });
}
