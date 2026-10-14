/* STM32H7B0VBT6 board clock: HSE 25 MHz -> PLL1 -> SYSCLK/HCLK 280 MHz.
 * The SWO page owns ITM/TPIU/DWT setup over SWD; this file only configures the
 * target CPU clock and leaves trace routing to the host.
 */
#include "stm32h7b0_regs.h"

#define WAIT_SPINS 20000000u

/* 0 = HSE -> PLL1 (280 MHz), 1 = HSI fallback (64 MHz). */
volatile uint32_t g_clock_hz = HSI_HZ;
volatile uint32_t g_clock_error;
volatile uint32_t g_clock_source = 1u;

enum {
  CLOCK_ERR_VOSRDY = 1u << 1,
  CLOCK_ERR_HSERDY = 1u << 2,
  CLOCK_ERR_PLLRDY = 1u << 3,
  CLOCK_ERR_SWITCH = 1u << 4,
  CLOCK_ERR_FALLBACK = 1u << 7,
  CLOCK_WARN_SUPPLY_NOT_LDO = 1u << 8
};

static int wait_field(uintptr_t address, uint32_t mask, uint32_t expected) {
  for (uint32_t spins = WAIT_SPINS; spins; --spins)
    if ((REG32(address) & mask) == expected)
      return 1;
  return 0;
}

uint32_t clock_init_hse(void) {
  uint32_t error = 0u;
  const uint32_t fatal_mask = ~(uint32_t)CLOCK_WARN_SUPPLY_NOT_LDO;

  /* Read supply mode for diagnostics, but never rewrite PWR_CR3. */
  if ((PWR_CR3 & (PWR_CR3_LDOEN | PWR_CR3_BYPASS)) != PWR_CR3_LDOEN)
    error |= CLOCK_WARN_SUPPLY_NOT_LDO;

  PWR_SRDCR = (PWR_SRDCR & ~PWR_SRDCR_VOS_MASK) | PWR_SRDCR_VOS0;
  if (!wait_field(PWR_BASE + 0x18u, PWR_SRDCR_VOSRDY, PWR_SRDCR_VOSRDY))
    error |= CLOCK_ERR_VOSRDY;

  /* Set flash latency before raising the system clock. */
  FLASH_ACR = (FLASH_ACR & ~0x3fu) | FLASH_ACR_LATENCY(7u) |
              FLASH_ACR_WRHIGHFREQ(3u);

  RCC_CR |= RCC_CR_HSEON;
  if (!wait_field(RCC_BASE, RCC_CR_HSERDY, RCC_CR_HSERDY))
    error |= CLOCK_ERR_HSERDY;

  if ((error & fatal_mask) == 0u) {
    /* HSE / 5 = 5 MHz reference; x112 / 2 = 280 MHz SYSCLK. */
    RCC_PLLCKSELR = RCC_PLLCKSELR_PLLSRC_HSE |
                    (5u << RCC_PLLCKSELR_DIVM1_SHIFT);
    RCC_PLL1FRACR = 0u;
    RCC_PLL1DIVR = ((112u - 1u) << 0) | ((2u - 1u) << 9) |
                   ((2u - 1u) << 16) | ((2u - 1u) << 24);
    RCC_PLLCFGR = RCC_PLLCFGR_DIVP1EN | RCC_PLLCFGR_DIVQ1EN |
                  RCC_PLLCFGR_DIVR1EN |
                  (2u << RCC_PLLCFGR_PLL1RGE_SHIFT);
    RCC_CR |= RCC_CR_PLL1ON;
    if (!wait_field(RCC_BASE, RCC_CR_PLL1RDY, RCC_CR_PLL1RDY))
      error |= CLOCK_ERR_PLLRDY;
  }

  if ((error & fatal_mask) == 0u) {
    RCC_CDCFGR1 = (4u << 4);  /* APB3 /2; CPU and HCLK /1 */
    RCC_CDCFGR2 = (4u << 8) | (4u << 4); /* APB2/APB1 /2 */
    RCC_SRDCFGR = (4u << 4);  /* APB4 /2 */
    RCC_CFGR = (RCC_CFGR & ~RCC_CFGR_SW_MASK) | RCC_CFGR_SW_PLL1;
    if (!wait_field(RCC_BASE + 0x10u, RCC_CFGR_SWS_MASK,
                    RCC_CFGR_SWS_PLL1))
      error |= CLOCK_ERR_SWITCH;
  }

  if ((error & fatal_mask) == 0u) {
    g_clock_hz = SYSCLK_HZ;
    g_clock_source = 0u;
    g_clock_error = error;
    return g_clock_hz;
  }

  /* Safe fallback: return to the reset-default 64 MHz HSI clock. */
  RCC_CR &= ~RCC_CR_PLL1ON;
  RCC_CFGR = (RCC_CFGR & ~RCC_CFGR_SW_MASK) | RCC_CFGR_SW_HSI;
  (void)wait_field(RCC_BASE + 0x10u, RCC_CFGR_SWS_MASK, 0u);
  RCC_CDCFGR1 = 0u;
  RCC_CDCFGR2 = 0u;
  RCC_SRDCFGR = 0u;
  g_clock_hz = HSI_HZ;
  g_clock_source = 1u;
  g_clock_error = error | CLOCK_ERR_FALLBACK;
  return g_clock_hz;
}
