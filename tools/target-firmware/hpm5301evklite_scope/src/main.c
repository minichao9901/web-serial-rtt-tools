/*
 * HPM5301EVKLite (RISC-V) · J-Scope 靶子固件
 *
 * 与 script_test/stm32f103_scope 同一套路：一份**已知契约**的变量块 + 已知时基，
 * 让探针的 HSS 采样器（HID 0x32 + bulk IN 0x83，走 JTAG 的 SBA 后端）采回来之后
 * 能逐项核对"采到的到底对不对"，而不只是"有多少包"。
 *
 * 契约（8 × u32 = 32 B，全部 4 字节对齐）：
 *
 *   | 偏移 | 名字    | 类型 | 内容 |
 *   | --- | --- | --- | --- |
 *   | +0  | g_tick  | u32  | 10 kHz 计数（每 100 µs +1）—— 用来验时基/斜率 |
 *   | +4  | u_hi    | u32  | 高位恒为 1（0x1xxxxxxx）—— 高位校验用 |
 *   | +8  | f_sin   | f32  | 500 Hz 正弦，-1..+1 |
 *   | +12 | f_tri   | f32  | 500 Hz 三角，-1..+1 |
 *   | +16 | i_sq1k  | i32  | 1 kHz 方波 ±1000 |
 *   | +20 | i_sq5k  | i32  | 5 kHz 方波 ±1000（采样率 < 10 kHz 必混叠，专门留的坑） |
 *   | +24 | u_ramp  | u32  | 0..999 每拍 +1 的斜坡（10 kHz 周期 = 100 ms） |
 *   | +28 | lfsr    | u32  | 32 位 LFSR，每拍一步（伪随机，验"值在动"） |
 *
 * 🟢 **高速平滑块 `g_v_hi`（2026-10 另加，契约块一个字节都没动）**
 *
 * 契约块是 **10 kHz 更新 + 20 点查表** ⇒ 一个 500 Hz 周期只有 20 个**不同**值、
 * 每级台阶 100 µs。用 100 kHz 采样时，一个台阶里 10 个采样点取到同一个值，
 * J-Scope 上看到的就是"台阶"（**不是采样率不够**，是信号本身就这样——这就是"契约"）。
 * 想看**连续**曲线必须让**更新率 ≫ 采样率**，所以另开一块：
 *
 *   | 偏移 | 名字          | 类型 | 内容 |
 *   | --- | --- | --- | --- |
 *   | +0  | g_v_hi.tick   | u32  | 200 kHz 计数（每 5 µs +1）—— 用来核对**真实更新率** |
 *   | +4  | g_v_hi.f_sin  | f32  | 500 Hz 平滑正弦（400 级），-1..+1 |
 *
 * 频率 = 更新率 / 表长 = 200 kHz / 400 = **500.00 Hz**（表 `kSinHi[]` 由
 * `tools/dev/gen-sin-table.py` 生成，改表长必须同步改本文件的 `HI_UPDATE_HZ`）。
 * 采样 100 kHz 时两次采样之间信号必变 ⇒ 画出来是连续曲线。
 * 判据：`g_v_hi.tick` 每级台阶 +1、采样相邻两点的 tick 差 ≈ 采样率/200 kHz。
 *
 * 变量块放在 `.noncacheable.bss`，落入 HPM5301 的 DLM（约 0x0008xxxx）。HPM5301
 * 没有 D-cache；这里沿用 section 主要是为了把 J-Scope 契约和异常现场集中放在
 * porting 配置的 DLM/SBA 可读窗口内，不需要做 cache clean。
 *
 * 时基：MCHTMR（machine timer）直接轮询，每 `f/10000` 个计数更新一拍。不用中断
 * —— 靶子的职责只是"让变量按已知速率变化"，polling 的抖动是纳秒级，比 ISR 简单
 * 且不依赖 SDK 的定时器驱动。实测频率上报在 `g_mchtmr_hz`。
 *
 * 异常自报：覆盖 SDK 的 weak `exception_handler`，把第一次异常的 cause/epc/mtval
 * 记在**非缓存区**再停住 —— 主机（或 OpenOCD）可以直接把现场读出来。SDK 默认实现是
 * `return epc`，会把出错指令无限重试，表现出来就是"靶子不动了"，没有任何线索。
 *
 * 构建/烧录：见同目录 README。变量地址用 nm 查（会随编译变化，不要硬编码）：
 *   riscv32-unknown-elf-nm -S build/flash_xip/output/demo.elf | findstr g_v
 */
#include <stdint.h>

#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_common.h"
#include "hpm_mchtmr_drv.h"
#include "sin_hi_table.h"   /* kSinHi[]：400 点正弦表（自动生成，见 tools/dev/gen-sin-table.py） */

typedef struct
{
    volatile uint32_t tick;
    volatile uint32_t u_hi;
    volatile float    f_sin;
    volatile float    f_tri;
    volatile int32_t  i_sq1k;
    volatile int32_t  i_sq5k;
    volatile uint32_t u_ramp;
    volatile uint32_t lfsr;
} scope_vars_t;

/** 高速平滑块：更新率 ≫ 采样率，用来在 J-Scope 上看"连续"波形（见文件头） */
typedef struct
{
    volatile uint32_t tick;     /* +0  200 kHz 计数（每 5 µs +1） */
    volatile float    f_sin;    /* +4  500 Hz 平滑正弦（400 级），-1..+1 */
} scope_hi_vars_t;

/* g_v_hi 的更新率：200 kHz（5 µs 一拍）。改这个值必须同步改 kSinHi[] 的表长，
 * 否则频率不再是 500 Hz：f = HI_UPDATE_HZ / SIN_HI_N */
#define HI_UPDATE_HZ 200000U

/* ---- 契约块（非缓存区，探针 SBA 直读得到当前值）---- */
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(32) volatile scope_vars_t g_v;
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(32) volatile scope_hi_vars_t g_v_hi;  /* 高速平滑块 */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_mchtmr_hz;  /* 实测 MCHTMR 频率 */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_updates;    /* 更新次数（tick 的镜像） */
/* 自描述头：主机可以先读这两个字确认"这里的 32 B 就是变量块" */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_block_magic; /* 'SCOP' */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_block_addr;  /* = (uint32_t)&g_v */

/* ---- 异常现场（非缓存区，出问题也能读出来）---- */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_count;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_cause;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_epc;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_mtval;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_tick;

/* 500 Hz 正弦：20 个点一个周期（10 kHz / 20 = 500 Hz）。
 * 用查表而不是 sinf()：一是避免拖 libm 进固件，二是表就是契约的一部分。 */
static const float kSin20[20] = {
     0.000000f,  0.309017f,  0.587785f,  0.809017f,  0.951057f,
     1.000000f,  0.951057f,  0.809017f,  0.587785f,  0.309017f,
     0.000000f, -0.309017f, -0.587785f, -0.809017f, -0.951057f,
    -1.000000f, -0.951057f, -0.809017f, -0.587785f, -0.309017f,
};

/* 覆盖 SDK 的 weak 实现：
 * 记现场 → 停在原地。停住比"无限重试出错指令"好排查得多，而现场的四个字都在
 * 非缓存区，任何 SBA 调试器（本探针 / OpenOCD / J-Link）都能直接读出来。 */
long exception_handler(long cause, long epc);
long exception_handler(long cause, long epc)
{
    uint32_t mtval = 0U;

    __asm volatile("csrr %0, mtval" : "=r"(mtval));

    g_trap_cause = (uint32_t)cause;
    g_trap_epc   = (uint32_t)epc;
    g_trap_mtval = mtval;
    g_trap_tick  = g_v.tick;
    g_trap_count++;

    for (;;)
    {
    }
}

int main(void)
{
    board_init();
    board_init_led_pins();

    g_block_magic = 0x53434F50U;                  /* 'SCOP' */
    g_block_addr  = (uint32_t)(uintptr_t)&g_v;

    uint32_t hz = (uint32_t)clock_get_frequency(clock_mchtmr0);
    g_mchtmr_hz = hz;
    if (hz < 100000U)
    {
        hz = 24000000U;                 /* 时钟没起来时的兜底：按 24 MHz 算，契约照旧 */
    }

    const uint32_t step = hz / 10000U;  /* 100 µs 一拍 */
    uint32_t next = (uint32_t)mchtmr_get_count(HPM_MCHTMR) + step;
    uint32_t t = 0U;
    uint32_t lfsr = 0x12345678U;

    /* 高速平滑块的节拍：200 kHz（5 µs）。MCHTMR 是 24 MHz ⇒ hi_step = 120，整除无误差；
     * 万一主频不是整倍数，用 while 补齐（下面），频率只由 hi_step 决定，不受循环抖动影响。 */
    const uint32_t hi_step = (hz / HI_UPDATE_HZ) ? (hz / HI_UPDATE_HZ) : 1U;
    uint32_t next_hi = (uint32_t)mchtmr_get_count(HPM_MCHTMR) + hi_step;
    uint32_t th = 0U;

    for (;;)
    {
        uint32_t now = (uint32_t)mchtmr_get_count(HPM_MCHTMR);

        /* ---- 高速平滑拍：每 5 µs 写一次（while 补齐欠账，保证 f = HI_UPDATE_HZ / SIN_HI_N 精确）----
         * 两个 volatile 写是**非缓存区**，约几十 ns；200 kHz 下占 CPU 个位数百分比。
         * 注意契约块的节拍一个字都没改 —— 这里只多花一点循环时间。 */
        while ((int32_t)(now - next_hi) >= 0)
        {
            next_hi += hi_step;
            th++;
            g_v_hi.tick  = th;
            g_v_hi.f_sin = kSinHi[th % SIN_HI_N];
        }

        /* 只推进到"到点了"为止：轮询抖动是几十 ns，10 kHz 完全够用 */
        if ((int32_t)(now - next) < 0)
        {
            continue;
        }
        next += step;
        t++;

        uint32_t p10 = t % 10U;                       /* 1 kHz 相位（10 拍一周期） */
        uint32_t p20 = t % 20U;                       /* 500 Hz 相位 */

        /* x^32 + x^22 + x^2 + x^1 + 1（标准 maximal LFSR 的右移形式） */
        lfsr = (lfsr >> 1) ^ ((uint32_t)(-(int32_t)(lfsr & 1U)) & 0x80200003U);

        float    f_sin  = kSin20[p20];
        float    f_tri  = ((float)((p20 < 10U) ? p20 : (20U - p20)) / 10.0f) - 1.0f;
        int32_t  i_sq1k = (p10 < 5U) ? 1000 : -1000;
        int32_t  i_sq5k = ((t & 1U) != 0U) ? 1000 : -1000;
        uint32_t u_ramp = t % 1000U;

        /* 契约块（非缓存区：写入直达 SRAM，探针读到的就是这一拍的值） */
        g_v.tick   = t;
        g_v.u_hi   = 0x10000000U | (t & 0xFFFFU);
        g_v.f_sin  = f_sin;
        g_v.f_tri  = f_tri;
        g_v.i_sq1k = i_sq1k;
        g_v.i_sq5k = i_sq5k;
        g_v.u_ramp = u_ramp;
        g_v.lfsr   = lfsr;
        g_updates  = t;

        /* 对照样本：同一份数据写进可缓存区，不做写回（探针走 SBA 应当读不到新值） */

        if ((t & 0x1FFFU) == 0U)                      /* ~0.8 s 闪一次，证明在跑 */
        {
            board_led_toggle();
        }
    }
}
