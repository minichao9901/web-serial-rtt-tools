/* STM32F103: WeAct Bluepill 8 MHz crystal -> PLL x3 -> 24 MHz SYSCLK/HCLK.
 * APB1=24 MHz, APB2=24 MHz, ADC=12 MHz. SWO is configured by the host.
 */
#include "pipeline.h"
volatile uint32_t g_clock_hz = 8000000;
volatile uint32_t g_clock_error;
static int ready(uint32_t address, uint32_t mask, uint32_t expected) {
  for (uint32_t n = 0; n < 1000000; n++)
    if ((REG(address) & mask) == expected)
      return 1;
  return 0;
}
uint32_t clock_init_hse(void) {
  REG(0x40021000) |= 1u; /* HSI stays available during clock transitions. */
  if (!ready(0x40021000, 2u, 2u)) { g_clock_error = 1; return g_clock_hz; }
  REG(0x40021004) &= ~3u;
  if (!ready(0x40021004, 12u, 0u)) { g_clock_error = 2; return g_clock_hz; }
  REG(0x40021000) &= ~(1u << 24);
  if (!ready(0x40021000, 1u << 25, 0u)) { g_clock_error = 3; return g_clock_hz; }
  REG(0x40021000) &= ~(1u << 18); /* crystal oscillator, not bypass */
  REG(0x40021000) |= 1u << 16;
  if (!ready(0x40021000, 1u << 17, 1u << 17)) { g_clock_error = 4; return g_clock_hz; }
  REG(0x40022000) = 0x10u; /* 0 Flash wait states, prefetch enabled */
  const uint32_t config = (1u << 18) | (1u << 16); /* PLL x3, APB /1, ADC /2 */
  REG(0x40021004) = config;
  REG(0x40021000) |= 1u << 24;
  if (!ready(0x40021000, 1u << 25, 1u << 25)) { g_clock_error = 5; return g_clock_hz; }
  REG(0x40021004) = config | 2u;
  if (!ready(0x40021004, 12u, 8u)) { g_clock_error = 6; return g_clock_hz; }
  g_clock_hz = 24000000;
  return g_clock_hz;
}
