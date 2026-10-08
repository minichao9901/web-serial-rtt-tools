/* SWO validation: real branches, nested helpers, loops, recursion, SysTick +
 * PendSV. HSI 8 MHz, no PLL, no UART/peripheral output. PB3 belongs to SWO
 * configured by host. */
#include "pipeline.h"
volatile uint32_t g_tick, g_scenario, g_phase, g_rounds, g_checksum, g_mark_seq,
    g_mark_dropped, g_enable_decoy;
volatile uint32_t g_irq_count, g_pendsv_count;
typedef struct {
  uint32_t sequence, phase, cycle;
} stage_log_t;
volatile stage_log_t g_stage_log[256];
NOINLINE void trace_phase(uint32_t id) {
  g_phase = id;
  uint32_t seq = ++g_mark_seq;
  g_stage_log[seq & 255] = (stage_log_t){seq, id, REG(0xe0001004)};
  if ((REG(0xe0000e80) & 1) && (REG(0xe0000e00) & 2)) {
    if (REG(0xe0000004) & 1)
      REG(0xe0000004) = 0xa5000000 | ((seq & 65535) << 8) | id;
    else
      g_mark_dropped++;
  }
}
NOINLINE void irq_work(void) {
  uint32_t a = g_irq_count;
  for (unsigned i = 0; i < 11; i++)
    a = (a * 33) ^ (a >> 3) ^ i;
  g_checksum ^= a;
}
void SysTick_Handler(void) {
  g_tick++;
  g_irq_count++;
  irq_work();
  if (g_tick % 100 == 0)
    REG(0xe000ed04) = 1u << 28;
}
void PendSV_Handler(void) {
  g_pendsv_count++;
  g_checksum ^= (g_pendsv_count << 7);
}
NOINLINE void idle_phase(void) { __asm volatile("wfi"); }
NOINLINE void never_path(void) {
  g_checksum ^= 0xdeadcafe;
  for (volatile unsigned i = 0; i < 6000; i++) {
  };
}
NOINLINE void execute_phase(uint32_t id) {
  trace_phase(id);
  uint32_t start = g_tick;
  do {
    switch (id) {
    case 1:
      pipeline_scan();
      break;
    case 2:
      pipeline_sort();
      break;
    case 3:
      route_a();
      break;
    case 4:
      route_b();
      break;
    case 5:
      pipeline_pack();
      break;
    case 6:
      pipeline_recursive();
      break;
    case 7:
      pipeline_verify();
      break;
    default:
      idle_phase();
      break;
    }
    if (g_enable_decoy)
      never_path();
  } while ((uint32_t)(g_tick - start) < 35);
}
int main(void) {
  REG(0xe000e014) = 7999;
  REG(0xe000e018) = 0;
  REG(0xe000ed20) = 0xff000000;
  REG(0xe000e010) = 7;
  for (;;) {
    execute_phase(1);
    execute_phase(2);
    execute_phase((g_scenario & 1) ? 4 : 3);
    execute_phase(5);
    execute_phase(6);
    execute_phase(8);
    execute_phase(7);
    g_rounds++;
  }
}
