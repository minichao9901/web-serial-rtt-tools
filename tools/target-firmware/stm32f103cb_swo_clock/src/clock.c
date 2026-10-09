/* STM32F103: WeAct Bluepill 8 MHz crystal, 72 MHz SYSCLK/HCLK.
 * APB1=36 MHz, APB2=72 MHz, ADC=12 MHz. No host-side clock changes needed.
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
static uint32_t change_clock(uint32_t hz) {
  REG(0x40021000) |= 1u; /* HSI stays available during clock transitions. */
  if (!ready(0x40021000, 2u, 2u)) { g_clock_error = 1; return g_clock_hz; }
  REG(0x40021004) &= ~3u;
  if (!ready(0x40021004, 12u, 0u)) { g_clock_error = 2; return g_clock_hz; }
  REG(0x40021000) &= ~(1u << 24);
  if (!ready(0x40021000, 1u << 25, 0u)) { g_clock_error = 3; return g_clock_hz; }
  REG(0x40021000) &= ~(1u << 18); /* crystal oscillator, not bypass */
  REG(0x40021000) |= 1u << 16;
  if (!ready(0x40021000, 1u << 17, 1u << 17)) { g_clock_error = 4; return g_clock_hz; }
  REG(0x40022000) = 0x12u; /* 2 Flash wait states, prefetch enabled */
  const uint32_t config = ((hz/(hz%8000000u?4000000u:8000000u)-2u) << 18) | (hz%8000000u?(1u<<17):0u) | (1u << 16) | (4u << 8) | (2u << 14);
  REG(0x40021004) = config;
  REG(0x40021000) |= 1u << 24;
  if (!ready(0x40021000, 1u << 25, 1u << 25)) { g_clock_error = 5; return g_clock_hz; }
  REG(0x40021004) = config | 2u;
  if (!ready(0x40021004, 12u, 8u)) { g_clock_error = 6; return g_clock_hz; }
  g_clock_hz = hz;
  return g_clock_hz;
}

volatile uint32_t g_clock_magic = 0x5357434b;
volatile uint32_t g_clock_request_hz;
volatile uint32_t g_clock_seq;
uint32_t clock_init_hse(void) { return change_clock(72000000); }
void clock_service(void) {
  if(g_clock_magic!=0x5357434b)return;
  uint32_t hz=g_clock_request_hz;
  if(!hz)return;
  g_clock_request_hz=0;
  if(hz<16000000||hz>72000000||hz%4000000){g_clock_error=7;g_clock_seq++;return;}
  __asm volatile("cpsid i" ::: "memory");
  REG(0xe000e010)=0;
  g_clock_error=0;
  change_clock(hz);
  /* On timeout RCC may already be on HSI: report the real fallback clock. */
  if((REG(0x40021004)&12u)==0)g_clock_hz=8000000;
  REG(0xe000e014)=g_clock_hz/1000-1;
  REG(0xe000e018)=0;
  REG(0xe000e010)=7;
  g_clock_seq++;
  __asm volatile("cpsie i" ::: "memory");
}
