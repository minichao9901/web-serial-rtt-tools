/**
 * Cortex-M FPB（Flash Patch and Breakpoint）—— 硬件断点的**纯逻辑**部分。
 *
 * 为什么必须用 FPB 而不是软件断点（往代码里塞 BKPT）：
 *   · flash 上的软件断点要先擦一整页再写回，又慢又费寿命；
 *   · 塞进 RAM 也会改掉"同一份固件两种跑法"的一致性（跑完还得记得还原）。
 *   FPB 是内核自带的地址比较器：取指地址命中就 halt，flash / RAM 一视同仁，随时开关。
 *
 * 编码依据 pyOCD `pyocd/coresight/fpb.py`（真机久经考验，2026-10 抄进本仓）：
 *   · FP_CTRL：bit0 = ENABLE、bit1 = KEY（写时必须同时置 1，否则忽略）、[31:28] = REV；
 *   · 比较器个数 nb_code = ((fpcr >>> 8) & 0x70) | ((fpcr >>> 4) & 0x0f)（这个写法同时兼容 rev1/rev2）；
 *   · rev1：bits[31:30] 是 BP_MATCH（上半字 0x2 / 下半字 0x1），
 *       comp = (addr & ~3) | bp_match | 1；**只能匹配 0x20000000 以下的地址**；
 *   · rev2：comp = (addr & ~1) | 1，地址不限；
 *   · "删掉一个断点" = 往比较器写 0（bit0 = ENABLE 归零）。
 *
 * 🚨 两个真机会咬人的点：
 *   1) 命中后内核停在**那条指令的地址上**，直接"继续"会立刻再命中一次 ——
 *      必须先临时摘掉这个比较器、单步一条、再装回去（见 session.cont()）。
 *   2) 断点数量是**硬件上限**（M7 有 8 个、M3/M4 常见 6 个、M0+ 只有 4 个），
 *      超出时不能"静默少下一个"，必须报出来（planComparators 的 overflow）。
 */

/** FPB 的寄存器（PPB 固定地址） */
export const FPB = {
  CTRL: 0xe0002000,
  REMAP: 0xe0002004,
  COMP0: 0xe0002008,       // 比较器 n 的地址 = COMP0 + 4n
};
export const FP_CTRL_KEY = 1 << 1;
export const compAddr = n => (FPB.COMP0 + 4 * n) >>> 0;

/** 解析 FP_CTRL（读回值时用；写入时只用 KEY|ENABLE） */
export function decodeFpCtrl(v){
  v = v >>> 0;
  return {
    raw: v,
    rev: 1 + ((v & 0xf0000000) >>> 28),                    // 0 → rev1、1 → rev2（其余值当未知，按 1 处理）
    numCode: ((v >>> 8) & 0x70) | ((v >>> 4) & 0x0f),
    numLit: (v >>> 7) & 0x0f,
    enabled: (v & 1) === 1,
  };
}

/**
 * 这个地址能不能用 FPB 打？
 * rev1 的比较器只装 27 位地址（[28:2]），所以 0x20000000 以上直接没戏
 * （例如 H7 的 QSPI 映射代码在 0x90000000 —— 那种情况只能靠 RAM 里的软件断点，本页暂不支持）。
 */
export function canBreak(addr, rev = 1){
  return (rev >>> 0) === 2 ? true : ((addr >>> 0) < 0x20000000);
}

/** 一个断点地址 → 比较器寄存器的值 */
export function encodeComparator(addr, rev = 1){
  addr = addr >>> 0;
  if (rev === 2) return ((addr & 0xfffffffe) | 1) >>> 0;
  const bpMatch = (addr & 0x2) ? (2 << 30) : (1 << 30);
  return (((addr & 0x1ffffffc) | bpMatch | 1) >>> 0);
}

/**
 * 反解：探针里现在装的是哪个地址（回读对账用）。
 * 🚨 rev1 的 bit1 不在地址字段里（地址字段是 (addr & ~3)），它编码在 BP_MATCH[31:30]
 *    —— 0x1 = 下半字、0x2 = 上半字。不还原的话 0x…102 会被解成 0x…100，
 *    回读对账会"看起来没问题"但断点其实打在隔壁半字上。
 */
export function decodeComparator(comp, rev = 1){
  comp = comp >>> 0;
  const enabled = (comp & 1) === 1;
  let addr;
  if (rev === 2) addr = comp & 0xfffffffe;
  else {
    const bpMatch = (comp >>> 30) & 3;
    addr = (comp & 0x1ffffffc) | (bpMatch === 2 ? 2 : 0);
  }
  return { enabled, addr: addr >>> 0 };
}

/**
 * 把"用户要的断点列表"映射到比较器槽位（第 i 个断点用第 i 号比较器，顺序稳定好排查）。
 * @param {number[]} addrs 断点地址（按加入顺序）
 * @param {number} capacity 硬件比较器个数
 * @param {number} rev FPB 版本
 * @returns {{slots:(number|null)[], overflow:number[], bad:number[]}}
 *   slots[i] = 第 i 号比较器该写的值（null = 清 0）
 *   overflow = 数量超限、装不下的断点；bad = 地址根本没法用 FPB 表示的断点
 */
export function planComparators(addrs, capacity, rev = 1){
  const n = Math.max(0, capacity | 0);
  const slots = new Array(n).fill(null);
  const overflow = [], bad = [];
  let i = 0;
  for (const a of addrs || []){
    if (!canBreak(a, rev)){ bad.push(a >>> 0); continue; }
    if (i >= n){ overflow.push(a >>> 0); continue; }
    slots[i++] = encodeComparator(a, rev);
  }
  return { slots, overflow, bad };
}
