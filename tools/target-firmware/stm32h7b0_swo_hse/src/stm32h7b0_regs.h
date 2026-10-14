/*
 * STM32H7B0（Cortex-M7）最小寄存器定义 —— SWO fixture / register-clock setup.
 *
 * 为什么手写而不用 ST 的 HAL/CMSIS 头：这份例程要能"一条 gcc 命令就编出来"、不引任何外部依赖
 * （与本仓库其他 H7B0 轻量固件相同，不依赖 HAL。）
 *
 * ---------------------------------------------------------------------------
 * ⚠️ H7B0 属于 **RM0455**（H7A3/B3/B0 这一代），与 H743 的 **RM0433** 不是同一份手册，
 *    照 H743 抄会**静默出错**（写进去不报错，就是不生效）。本文件每条都与
 *    `tools/target-firmware/stm32h7b0_rtt_speed/sdk/` 里那份**板子自带 SDK 的
 *    stm32h7b0xx.h / stm32h7xx_hal_rcc.h** 逐条核对过（那是 ST 原版头，且那份 SDK 的
 *    demo 时钟配置在同一块板子上实测跑到了 280MHz）。
 *
 * 本工程真正踩过/核过的差异：
 *   ① `RCC_APB4ENR` 偏移 = **0xF4**（H743 是 0x6C）—— 本工程不用外设时钟，但记在这里
 *      免得下次照 H743 抄；
 *   ② PWR 里没有 H743 的 `D3CR`，叫 **`SRDCR`**（VOS[15:14] / VOSRDY[13]），
 *      也没有 H743 那个 `SYSCFG_PWRCR.ODEN` 超频开关（H7B0 上不需要）；
 *   ③ 供电来源寄存器 `PWR_CR3` —— **本文件只读不写**（见 README 坑 1：无条件写它会
 *      把板子带进"AP 事务恒 WAIT、只能整板断电"的死状态）。
 *
 * 🚨 一条**很容易抄错**的地方（本仓库的兄弟例程 `stm32h7b0_rtt_speed` 的 -Minimal 版就抄错了，
 *    写成了 `(divm - 1)`，于是实际是 350MHz 而固件自以为 280MHz）：
 *      `RCC_PLLCKSELR.DIVM1[9:4]` 里放的是**分频值本身**（5 = /5），**不是"分频值-1"**！
 *    依据（两条独立证据，都在本机 SDK 里）：
 *      · `__HAL_RCC_PLL_CONFIG` 宏：`MODIFY_REG(RCC->PLLCKSELR, PLLSRC|DIVM1,
 *        (__RCC_PLLSOURCE__) | ((__PLLM1__) << 4U))` —— 直接写 PLLM，没有减 1；
 *      · `HAL_RCC_GetSysClockFreq()`：`pllm = (RCC->PLLCKSELR & DIVM1) >> 4;` 之后
 *        `pllvco = (pllsource / pllm) * plln` —— 直接做除。
 *      · 旁证：板子 SDK 的 `SystemClock_Config()` 用 `PLLM = 5` 得到 5MHz 参考
 *        （HSE 25MHz /5），注释写明"→ ×112 → 560MHz VCO → /2 = 280MHz"。
 *    只有 N1/P1/Q1/R1 才是"值-1"。
 */
#ifndef STM32H7B0_REGS_H
#define STM32H7B0_REGS_H

#include <stdint.h>

#define REG32(addr) (*(volatile uint32_t *)(uintptr_t)(addr))

/* ---------------- RCC（0x58024400）---------------- */
#define RCC_BASE        0x58024400u
#define RCC_CR          REG32(RCC_BASE + 0x00)   /* HSION[0] HSIRDY[2] HSEON[16] HSERDY[17] PLL1ON[24] PLL1RDY[25] */
#define RCC_CFGR        REG32(RCC_BASE + 0x10)   /* SW[2:0] / SWS[5:3] */
#define RCC_CDCFGR1     REG32(RCC_BASE + 0x18)   /* HPRE[3:0] / CDPPRE[6:4](APB3) / CDCPRE[11:8](CPU) */
#define RCC_CDCFGR2     REG32(RCC_BASE + 0x1C)   /* CDPPRE1[6:4](APB1) / CDPPRE2[10:8](APB2) */
#define RCC_SRDCFGR     REG32(RCC_BASE + 0x20)   /* SRDPPRE[6:4](APB4) */
#define RCC_PLLCKSELR   REG32(RCC_BASE + 0x28)   /* PLLSRC[1:0] / DIVM1[9:4]（写**分频值本身**） */
#define RCC_PLLCFGR     REG32(RCC_BASE + 0x2C)   /* FRACEN[0] VCOSEL[1] RGE[3:2] DIVP1EN[16] ... */
#define RCC_PLL1DIVR    REG32(RCC_BASE + 0x30)   /* N1[8:0] P1[15:9] Q1[22:16] R1[30:24]（值-1） */
#define RCC_PLL1FRACR   REG32(RCC_BASE + 0x34)
#define RCC_APB4ENR     REG32(RCC_BASE + 0xF4)   /* 🚨 0xF4，不是 H743 的 0x6C（本工程不用外设时钟） */

#define RCC_CR_HSEON    (1u << 16)
#define RCC_CR_HSERDY   (1u << 17)
#define RCC_CR_PLL1ON   (1u << 24)
#define RCC_CR_PLL1RDY  (1u << 25)

#define RCC_CFGR_SW_MASK   0x7u
#define RCC_CFGR_SW_HSI    0x0u
#define RCC_CFGR_SW_PLL1   0x3u
#define RCC_CFGR_SWS_MASK  0x38u
#define RCC_CFGR_SWS_PLL1  0x18u

/* PLLCKSELR */
#define RCC_PLLCKSELR_PLLSRC_HSI  0x0u
#define RCC_PLLCKSELR_PLLSRC_CSI  0x1u
#define RCC_PLLCKSELR_PLLSRC_HSE  0x2u
#define RCC_PLLCKSELR_DIVM1_SHIFT 4u             /* DIVM1[9:4]：写**分频值**（5 = /5） */

/* PLLCFGR */
#define RCC_PLLCFGR_PLL1FRACEN (1u << 0)
#define RCC_PLLCFGR_PLL1VCOSEL (1u << 1)         /* 0 = 宽量程 192~836MHz（我们要的） */
#define RCC_PLLCFGR_PLL1RGE_SHIFT 2u             /* 00:1~2MHz 01:2~4 10:4~8 11:8~16 */
#define RCC_PLLCFGR_DIVP1EN    (1u << 16)
#define RCC_PLLCFGR_DIVQ1EN    (1u << 17)
#define RCC_PLLCFGR_DIVR1EN    (1u << 18)

/* ---------------- PWR（0x58024800）----------------
 * H7B0 用 CR3 选供电来源（LDO）、SRDCR 设电压档：
 *   VOS0 = 0b11 = 0xC000 → 280MHz 必需。写完等 VOSRDY[13]。
 *   （H743 那套 "先 SYSCFG_PWRCR.ODEN=1" 在 H7B0 上不存在，别照搬。） */
#define PWR_BASE        0x58024800u
/* 🚨 偏移是 **0x0C**，不是 0x08（0x08 是 CR2）。依据：本目录同名 SDK 的 stm32h7b0xx.h
 *    `PWR_TypeDef` = CR1(0x00) CSR1(0x04) CR2(0x08) **CR3(0x0C)** CPUCR(0x10) SRDCR(0x18)。
 *    本文件**只读**这一格判"供电是不是 LDO"，读错寄存器会让那条报警失真。 */
#define PWR_CR3         REG32(PWR_BASE + 0x0C)   /* LDOEN[1] BYPASS[0] —— **只读** */
#define PWR_SRDCR       REG32(PWR_BASE + 0x18)   /* VOS[15:14] VOSRDY[13] */

#define PWR_CR3_LDOEN       (1u << 1)
#define PWR_CR3_BYPASS      (1u << 0)
#define PWR_SRDCR_VOS_MASK  0xC000u
#define PWR_SRDCR_VOS0      0xC000u              /* 0b11 → Scale 0 */
#define PWR_SRDCR_VOSRDY    (1u << 13)

/* ---------------- FLASH（0x52002000）----------------
 * ACR：LATENCY[3:0] + WRHIGHFREQ[5:4]。取值跟板子 SDK 对齐：
 *   HAL_RCC_ClockConfig(..., FLASH_LATENCY_7) → LATENCY = 7；WRHIGHFREQ = 0b11（高频档）。
 * 🚨 LATENCY 宁大不小：给少了会取到错指令（现象千奇百怪，极难查）。 */
#define FLASH_BASE      0x52002000u
#define FLASH_ACR       REG32(FLASH_BASE + 0x00)
#define FLASH_ACR_LATENCY(n)     ((n) & 0x0Fu)
#define FLASH_ACR_WRHIGHFREQ(n)  (((n) & 0x3u) << 4)

/* ---------------- DBGMCU（0x5C001000）----------------
 * 让内核在调试器停住时**时钟继续跑**（否则拿调试器看时序会误判）。 */
#define DBGMCU_BASE     0x5C001000u
#define DBGMCU_CR       REG32(DBGMCU_BASE + 0x04)
#define DBGMCU_CR_DBG_CLOCKS 0x7u

/* ---------------- Cortex-M7 内核外设 ---------------- */
#define SYST_CSR        REG32(0xE000E010u)
#define SYST_RVR        REG32(0xE000E014u)
#define SYST_CVR        REG32(0xE000E018u)
#define SCB_VTOR        REG32(0xE000ED08u)
#define SCB_CCR         REG32(0xE000ED14u)       /* bit16 = DCACHEEN, bit17 = ICACHEEN */
#define SCB_CCR_ICACHE  (1u << 17)
#define SCB_CCR_DCACHE  (1u << 16)
#define SCB_ICIALLU     REG32(0xE000EF50u)
#define SCB_CPACR       REG32(0xE000ED88u)
#define FPU_FPCCR       REG32(0xE000EF34u)

/* ---------------- 本板时钟目标 ---------------- */
#define HSE_HZ          25000000u                /* STM32H7B0VBT6 KIT 板载 25MHz 晶振 */
#define HSI_HZ          64000000u                /* H7 的 HSI = 64MHz（无晶振时的后备） */
#define SYSCLK_HZ       280000000u               /* HSE/5 ×112 /2 = 280MHz（VCO 560MHz） */
#define HCLK_HZ         280000000u               /* HPRE=/1、CDCPRE=/1 → CPU 与 AXI 同为 280MHz */
#define TICK_HZ         10000u                   /* 采样靶子的时基 */

/* 时钟路径（g_z_clk_src） */
#define CLK_SRC_HSE_PLL 0u                       /* 25MHz 晶振 → PLL1 → 280MHz（正常路径） */
#define CLK_SRC_HSI     1u                       /* HSI 64MHz 直出（PLL 任一步没成时的保命档） */

/* 时钟初始化出错位（g_z_clk_err）：不接调试器也能知道卡在哪一步 */
#define CLK_ERR_VOSRDY       (1u << 1)
#define CLK_ERR_HSE_RDY      (1u << 2)
#define CLK_ERR_PLL_RDY      (1u << 3)
#define CLK_ERR_SW_PLL1      (1u << 4)
#define CLK_ERR_FALLBACK     (1u << 7)           /* 最终没跑到 280MHz，退在 HSI 64MHz */
#define CLK_ERR_SUPPLY_NOLDO (1u << 8)           /* PWR_CR3 显示供电不是 LDO（只报警，**不改**） */

#endif /* STM32H7B0_REGS_H */
