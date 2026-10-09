#ifndef PIPELINE_H
#define PIPELINE_H
#include <stdint.h>
#define REG(a) (*(volatile uint32_t *)(a))
#define NOINLINE __attribute__((noinline))
extern volatile uint32_t g_tick, g_scenario, g_phase, g_rounds, g_checksum,
    g_mark_seq, g_mark_dropped, g_enable_decoy;
extern volatile uint32_t g_irq_count, g_pendsv_count;
void pipeline_scan(void);
void pipeline_sort(void);
void route_a(void);
void route_b(void);
void pipeline_pack(void);
void pipeline_recursive(void);
void pipeline_verify(void);
void idle_phase(void);
#endif
