/*
 * 调试器压力测试靶子 —— 主程序（HPM5301EVKLite · RISC-V RV32，2026-10）
 *
 * 这块固件只干一件事：给调试器页（#dbg）的 **RISC-V/JTAG 通路**提供"取之不尽"的
 * 可停、可走、可看的代码。与 ARM 版（tools/target-firmware/stm32h743_dbgstress）同构，
 * 这样两边的调试行为可以直接对照，也方便用 riscv32-unknown-elf-gdb 做逐地址比对。
 *
 * 三条设计纪律：
 *   ① **变量放 DLM/SBA 可读区**（`.noncacheable.bss`）：HPM5301 没有 D-cache，集中
 *      放置便于探针读写和观察（具体内存口径见 README）；
 *   ② **主循环跑到 MCHTMR 的 10 kHz 节拍上**：断点命中节奏确定、可复现，
 *      不依赖中断（ISR 那条留到需要时再加，见 README 的"还没做"一节）；
 *   ③ 启动一律走 SDK 的 `board_init()`，不自己碰时钟（压测要的是确定性，不是主频）。
 *
 * 12 段流水线：每轮把每一段都跑一遍，`g_stage` 就是"现在在第几段" —— 任何一段下断点
 * 都会每轮必命中，停下来一眼能看出停在哪。
 */
#include <stdint.h>

#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_common.h"
#include "hpm_mchtmr_drv.h"

#include "engine.h"
#include "model.h"

#define TICK_HZ     10000u             /* 主循环节拍（MCHTMR） */
#define STAGE_COUNT 12u

uint32_t engine_frame_stage(void);

/* ---- 非缓存区的观测变量（探针 SBA 直读得到当前值）---- */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_ticks;        /* 主循环节拍计数 */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_loops;        /* 主循环轮数 */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_stage;        /* 当前在第几段（0..11） */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_last_result;  /* 上一段返回值 */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_checksum;     /* 每轮算一次：代码真的在跑 */
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(16) volatile uint32_t g_seq_slot[8];
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_mchtmr_hz;    /* MCHTMR 实测频率 */

/* ---- 异常现场（第一次异常就记下来并停住，比"无限重试出错指令"好查得多）---- */
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_count;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_cause;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_epc;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_trap_mtval;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_fault_trigger;

/** 仅供真机异常诊断测试：写入 g_fault_trigger 后主动执行一条非法指令。 */
__attribute__((noinline, used)) static void inject_illegal_instruction(void)
{
  __asm volatile(".align 2\n"
                 ".global g_illegal_instruction_pc\n"
                 "g_illegal_instruction_pc:\n"
                 ".word 0xffffffff\n" ::: "memory");
}

/** 现场写入完成后停在这里，便于调试器读取 trap CSR 与固件侧备份。 */
__attribute__((noinline, used)) void g_exception_stall(void)
{
  for (;;) { __asm volatile("nop"); }
}

/** 覆盖 SDK 的 weak `exception_handler`：记现场 → 停在原地（现场四个字都能被 SBA 读出来）*/
long exception_handler(long cause, long epc);
long exception_handler(long cause, long epc)
{
  uint32_t mtval = 0u;
  __asm volatile("csrr %0, mtval" : "=r"(mtval));
  g_trap_cause = (uint32_t)cause;
  g_trap_epc   = (uint32_t)epc;
  g_trap_mtval = mtval;
  g_trap_count++;
  g_exception_stall();
  return epc;
}

static uint32_t stage_run(uint32_t s)
{
  switch (s){
    case 0:  return engine_linear(&g_seq_slot[0], g_loops);            /* O0 线性序列（对照靶子） */
    case 1:  return engine_linear_os(&g_seq_slot[0], g_loops ^ 0x5A5A5A5Au);
    case 2:  return engine_deep_chain(g_loops);                        /* 6 层嵌套 */
    case 3:  return engine_rec_fib(10u);                               /* 递归 */
    case 4:  return engine_rec_ack(2u, 3u);                            /* 更深递归 */
    case 5:  return (uint32_t)engine_mutual(g_loops);                  /* 互递归 */
    case 6:  return engine_dispatch(g_loops & 3u, g_loops);            /* 函数指针（jalr） */
    case 7:  return engine_branchy(g_loops);                           /* 分支/循环/switch */
    case 8:  return engine_uses_inline(g_loops);                       /* 内联 */
    case 9:  model_bitfield_touch(g_loops); return g_model.flags.word; /* 位域 */
    case 10: return model_update(g_loops);                             /* 结构体全量更新 */
    default: return engine_frame_stage();                              /* CFI / 递归局部变量检查点 */
  }
}

int main(void)
{
  uint32_t hz, step, next, s;

  board_init();
  board_init_led_pins();

  hz = (uint32_t)clock_get_frequency(clock_mchtmr0);
  g_mchtmr_hz = hz;
  if (hz < 100000u) hz = 24000000u;            /* 时钟没起来时的兜底：按 24 MHz 算 */
  step = hz / TICK_HZ;
  if (!step) step = 1u;
  next = (uint32_t)mchtmr_get_count(HPM_MCHTMR) + step;

  model_init();

  for (;;){
    if (g_fault_trigger){
      g_fault_trigger = 0u;
      inject_illegal_instruction();
    }
    g_loops = g_loops + 1u;
    for (s = 0; s < STAGE_COUNT; s++){
      g_stage = s;                             /* volatile：停下来就能看到"停在第几段" */
      g_last_result = stage_run(s);
    }
    g_checksum = model_checksum() ^ g_seq_slot[7] ^ g_last_result;

    /* 等下一个 10 kHz 节拍：主循环周期固定，断点命中节奏可预期、可复现 */
    while ((int32_t)((uint32_t)mchtmr_get_count(HPM_MCHTMR) - next) < 0){ }
    next += step;
    g_ticks = g_ticks + 1u;
  }
}
