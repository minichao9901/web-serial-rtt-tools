/*
 * STM32F103 · **J-Scope 波形页（探针侧 HSS 采样）专用测试固件**
 *
 * 目的：把"采样率对不对、有没有混叠、丢了多少、有没有撕裂读"从"看着像"
 *      变成**可客观判定**。做法是：每一个被采样的量都有**精确已知的数学波形**，
 *      主机按取到的 `i_tick` 就能反算其余通道的应有值，从而逐点断言。
 *
 * 时基：**HSE 8 MHz ×12 = 96 MHz**（照抄兄弟例程 `stm32f103_rtt_speed` 的
 *      `clock_init()`；F103 额定 72 MHz，96 是超频但 flash 等待周期够，那边实测稳）
 *      → SysTick 每 9600 周期中断 = **10 kHz**。
 *      ISR 里所有量一次更新完（更新顺序见下），`g_tick` 是主计数器。
 *
 * ⚠️ **为什么必须提频**：AHB-AP 的每次读都要花目标侧几个 HCLK，探针把 SWD 拉到多高都没用。
 *    8 MHz 时实测块读封顶 **1.47 MB/s（0.68 µs/字节）**，而且 45 MHz 与 30 MHz 的读数
 *    一模一样（目标已饱和）；96 MHz 下同一路径是 **3.4 MB/s（0.29 µs/字节）**。
 *    拿 8 MHz 的靶子量采样率，量到的是靶子的上限（≈46 kHz），不是探针的上限。
 *
 * ---------------------------------------------------------------------------
 * 变量表（t = 10 kHz tick 序号；两组变量在地址上刻意分开，用来对比"读计划"的两条路径）
 *
 * ── g_pack：**连续 24 B**（→ 一次块读全拿到 = 快路径）
 *      off  名字     类型   应有值
 *      0    f_sin    f32    SIN100[t%100] / 1000        （100 Hz 正弦，±1.0）
 *      4    f_tri    f32    100 Hz 三角，峰值在 t%100==50（与正弦差 90°）
 *      8    i_tick   i32    = t                          （10 kHz 斜坡，主对齐量）
 *      12   u_ramp   u16    = t % 1000                   （100 Hz 锯齿 0..999）
 *      14   i_sq1k   i16    = (t%10 < 5) ? +1000 : -1000  （1 kHz 方波）
 *      16   u_cnt    u8     = (uint8_t)t                 （约 39 Hz 回绕）
 *      17   i_saw    i8     = (int8_t)(t*3)              （8 位锯齿，步进 3）
 *      18   rsv0     u8     保留（仅为让 u_hi 4 字节对齐）
 *      20   u_hi     u32    = 0x10000000 | (t & 0xFFFF)  （高位非零 → 验 u32 精度）
 *
 * ── 散落量（→ 多 span，走"每变量 2 个 op"的慢路径）
 *      g_tick     u32  = t
 *      g_isr_count u32 = t                               （与 g_tick 同值，验"两个地址都对"）
 *      g_sq5k     i16  = (t&1) ? +1000 : -1000           （**5 kHz 方波**：采样率 <10 kHz 必混叠）
 *      g_pulse    u8   = (t % 2000) < 100 ? 1 : 0        （5 Hz 脉冲、5% 占空比 → 触发测试用）
 *      g_pair_a   u16  = (uint16_t)t
 *      g_pair_b   u16  = (uint16_t)~t                    （**撕裂自检**：a^b != 0xFFFF 即读到两次更新之间）
 *      g_lfsr     u32  xorshift32 伪随机（宽带，验"看不出规律"的数据）
 *      g_ramp64   f64  主循环更新：1.0 + t*1e-6          （验 8 字节载荷与浮点精度）
 *
 * ---------------------------------------------------------------------------
 * 更新顺序（**契约**，主机侧据此放宽/收紧断言）：
 *      ① `g_tick` 先更 → 主机看到新 tick 时，载荷可能还是上一 tick 的 ⇒ 允许 ±1 tick；
 *      ② 再更 `g_pack` 的各字段（**逐个 store，不是原子快照**，所以 g_pack 内部也可能撕裂）；
 *      ③ 最后更散落量；
 *      ④ `g_pair_a/g_pair_b` 是**成对**的（a^b==0xFFFF 才算一致）→ 撕裂率可以被量化：
 *         采样率 × (写这两个变量的时间 / 100 µs) ≈ 撕裂样本占比，实测值应当在同一量级。
 *
 * 注意：F103 **没有 D-cache**，所以这块板子量出来的问题一定是采样/协议本身的问题，
 *      不会掺进 H7 那种"AHB-AP 读到 cache 旧值"的干扰（那条要在 H7 上单独验）。
 */
#include <stdint.h>

#include "stm32f103_regs.h"

#define TICK_HZ      10000u
#ifndef CPU_HZ
#define CPU_HZ       96000000u
#endif
#define SYST_RELOAD  (CPU_HZ / TICK_HZ - 1u)      /* core cycles per 10 kHz tick */

/* ---- 96 MHz 时钟序列：照抄 script_test/stm32f103_rtt_speed/src/main.c ----
 * 三条关键点（那边都实测踩过）：
 *   1. FLASH_ACR 必须先给足等待周期 + 预取，**再**提速；
 *   2. PLL 的配置位在 PLLON=1 时是**写保护**的 —— 必须走完整时序
 *      （SW→HSI、关 PLL、改倍频、开 PLL、SW→PLL），直接改倍频位无效；
 *   3. HSE 起不来就退回 HSI/2×16 = 64 MHz，绝不把板子跑死（时基会偏，check.py 会报）。 */
#define FLASH_ACR (*(volatile uint32_t *)0x40022000)
#define RCC_CR_HSEON   (1u << 16)
#define RCC_CR_HSERDY  (1u << 17)
#define RCC_CR_PLLON   (1u << 24)
#define RCC_CR_PLLRDY  (1u << 25)
#define RCC_CFGR_SW_HSI  (0u)
#define RCC_CFGR_SW_PLL  (2u)
#define RCC_CFGR_SWS_MASK (3u << 2)
#define HSE_MHZ 8u
#define PLL_MULL (((CPU_HZ / 1000000u) / HSE_MHZ) - 2u)   /* PLLMULL 编码：0 == ×2 */

static void clock_init(void)
{
  /* 1) 开 HSE 并等起振 */
  RCC_CR |= RCC_CR_HSEON;
  for (volatile uint32_t i = 0; i < 200000u; i++) {
    if (RCC_CR & RCC_CR_HSERDY) { break; }
  }
  if (!(RCC_CR & RCC_CR_HSERDY)) {
    RCC_CFGR = (RCC_CFGR & ~(0xFu | (7u << 8) | (7u << 11) | (3u << 16) | (0xFu << 18)))
             | (0x5u << 8) | (0x4u << 11) | (0u << 16) | (0xEu << 18);   /* HSI/2 ×16 */
    RCC_CR |= RCC_CR_PLLON;
    while (!(RCC_CR & RCC_CR_PLLRDY)) { }
    RCC_CFGR = (RCC_CFGR & ~3u) | RCC_CFGR_SW_PLL;
    while ((RCC_CFGR & RCC_CFGR_SWS_MASK) != (RCC_CFGR_SW_PLL << 2)) { }
    return;
  }

  /* 2) Flash 等待周期 + 预取 —— 必须在提速之前 */
  FLASH_ACR = 0x12;                        /* latency 2 + prefetch */

  /* 3) 先切回 HSI 并关掉 PLL（否则下面的倍频位写不进去） */
  RCC_CFGR = (RCC_CFGR & ~3u) | RCC_CFGR_SW_HSI;
  while ((RCC_CFGR & RCC_CFGR_SWS_MASK) != (RCC_CFGR_SW_HSI << 2)) { }
  RCC_CR &= ~RCC_CR_PLLON;
  while (RCC_CR & RCC_CR_PLLRDY) { }

  /* 4) 分频与倍频：AHB=/1, APB1=/4 (24 MHz), APB2=/2 (48 MHz), PLLSRC=HSE, ×12 */
  RCC_CFGR = (RCC_CFGR & ~(0xFu | (7u << 8) | (7u << 11) | (3u << 16) | (0xFu << 18)))
           | (0x0u << 4)               /* HPRE  = /1  */
           | (0x5u << 8)               /* PPRE1 = /4  */
           | (0x4u << 11)              /* PPRE2 = /2  */
           | (1u << 16)                /* PLLSRC = HSE */
           | ((uint32_t)PLL_MULL << 18);

  /* 5) 开 PLL、等锁定、切过去 */
  RCC_CR |= RCC_CR_PLLON;
  while (!(RCC_CR & RCC_CR_PLLRDY)) { }
  RCC_CFGR = (RCC_CFGR & ~3u) | RCC_CFGR_SW_PLL;
  while ((RCC_CFGR & RCC_CFGR_SWS_MASK) != (RCC_CFGR_SW_PLL << 2)) { }
}

/* 连续块：24 B。字段顺序/偏移见文件头表格，改动请同步改表与 README */
typedef struct {
  float    f_sin;    /*  0 */
  float    f_tri;    /*  4 */
  int32_t  i_tick;   /*  8 */
  uint16_t u_ramp;   /* 12 */
  int16_t  i_sq1k;   /* 14 */
  uint8_t  u_cnt;    /* 16 */
  int8_t   i_saw;    /* 17 */
  uint8_t  rsv0;     /* 18 保留 */
  uint32_t u_hi;     /* 20 */
} scope_pack_t;

volatile scope_pack_t g_pack;

volatile uint32_t g_tick;
volatile uint32_t g_isr_count;
volatile int16_t  g_sq5k;
volatile uint8_t  g_pulse;
volatile uint16_t g_pair_a;
volatile uint16_t g_pair_b;
volatile uint32_t g_lfsr = 0x12345678u;
volatile double   g_ramp64;                       /* 主循环更新 */

/* --- 故意制造"远距离"：中间隔 4 KB 空洞，逼读计划出现**第二个 span**（走慢路径）。
 *     这一组是两个普通的量，只是地址离前面那坨有 4 KB —— 用来验证
 *     "多 span 计划"确实生效（页面上会显示 span 数与预计周期）。 --- */
volatile uint8_t  g_hole[4096];                   /* 占位用，不采它（见 main 里那句引用） */
volatile int16_t  g_far_sq100;                    /* 100 Hz 方波 ±1000 */
volatile uint32_t g_far_cnt;                      /* = t（与 g_tick 同值 → 跨 span 一致性） */

/* sin(2πi/100) × 1000，四舍五入；100 点 = 100 Hz@10 kHz，周期正好 100 个 tick */
static const int16_t SIN100[100] = {
       0,    63,   125,   187,   249,   309,   368,   426,   482,   536,   /*   0..  9 */
     588,   637,   685,   729,   771,   809,   844,   876,   905,   930,   /*  10.. 19 */
     951,   969,   982,   992,   998,  1000,   998,   992,   982,   969,   /*  20.. 29 */
     951,   930,   905,   876,   844,   809,   771,   729,   685,   637,   /*  30.. 39 */
     588,   536,   482,   426,   368,   309,   249,   187,   125,    63,   /*  40.. 49 */
       0,   -63,  -125,  -187,  -249,  -309,  -368,  -426,  -482,  -536,   /*  50.. 59 */
    -588,  -637,  -685,  -729,  -771,  -809,  -844,  -876,  -905,  -930,   /*  60.. 69 */
    -951,  -969,  -982,  -992,  -998, -1000,  -998,  -992,  -982,  -969,   /*  70.. 79 */
    -951,  -930,  -905,  -876,  -844,  -809,  -771,  -729,  -685,  -637,   /*  80.. 89 */
    -588,  -536,  -482,  -426,  -368,  -309,  -249,  -187,  -125,   -63,   /*  90.. 99 */
};

void SysTick_Handler(void){
  /* ① 主计数先更（主机据此知道"新一 tick 开始"） */
  uint32_t t = g_tick + 1u;
  g_tick = t;
  g_isr_count = t;

  /* ② 连续块（逐个 store） */
  uint32_t ph = t % 100u;
  g_pack.f_sin  = (float)SIN100[ph] * 0.001f;
  int32_t tri   = (ph < 50u) ? ((int32_t)ph * 40 - 1000) : (3000 - (int32_t)ph * 40);
  g_pack.f_tri  = (float)tri * 0.001f;
  g_pack.i_tick = (int32_t)t;
  g_pack.u_ramp = (uint16_t)(t % 1000u);
  g_pack.i_sq1k = (int16_t)(((t % 10u) < 5u) ? 1000 : -1000);
  g_pack.u_cnt  = (uint8_t)t;
  g_pack.i_saw  = (int8_t)(t * 3u);
  g_pack.u_hi   = 0x10000000u | (t & 0xFFFFu);

  /* ③ 散落量 */
  g_sq5k   = (int16_t)((t & 1u) ? 1000 : -1000);
  g_pulse  = (uint8_t)(((t % 2000u) < 100u) ? 1u : 0u);
  g_pair_a = (uint16_t)t;
  g_pair_b = (uint16_t)~t;                 /* a ^ b == 0xFFFF 才算"同一 tick 内读到" */
  g_far_sq100 = (int16_t)(((t % 100u) < 50u) ? 1000 : -1000);
  g_far_cnt   = t;
  uint32_t l = g_lfsr;                     /* xorshift32：便宜、周期长、频谱平 */
  l ^= l << 13; l ^= l >> 17; l ^= l << 5;
  g_lfsr = l;
}

int main(void){
  clock_init();      /* 先设置 CPU_HZ 对应主频，再设置 SysTick，顺序不能反 */

  /* 只开时钟，不碰任何外设（和兄弟例程一样，越小越干净） */
  RCC_APB2ENR |= RCC_APB2ENR_AFIOEN | RCC_APB2ENR_IOPAEN | RCC_APB2ENR_IOPCEN;

  SYST_RVR = SYST_RELOAD;
  SYST_CVR = 0;
  SYST_CSR = 7;                            /* 内核时钟 + 中断使能 + 计数使能 */

  /* 🚨 g_hole 的作用只是"占位拉开地址距离"，编译器/linker 看不到任何引用就会把它
   *    连同那 4 KB 一起 gc 掉（-fdata-sections + --gc-sections，本轮实测踩到：
   *    bss 只涨了 8 字节，两个 g_far_* 又贴回了前面那坨）。这里给它一个真实引用。 */
  g_hole[0] = 0;

  /* 主循环：按 tick 节拍更新那个 f64 慢斜坡（软浮点，故意放在 ISR 外，别污染 10 kHz 时基） */
  uint32_t last = 0;
  for (;;){
    uint32_t t = g_tick;
    if (t != last){
      last = t;
      g_ramp64 = 1.0 + (double)t * 1e-6;   /* t=10000 → 1.01；t=600000（60 s）→ 1.6 */
    }
  }
}
