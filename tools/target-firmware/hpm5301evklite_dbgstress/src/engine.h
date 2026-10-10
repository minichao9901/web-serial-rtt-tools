/*
 * 调试器压力测试靶子 —— 控制流/调用链层（HPM5301EVKLite · RISC-V RV32，2026-10）
 *
 * 与 ARM 版（tools/target-firmware/stm32h743_dbgstress/src/engine.c）**同构**：
 * 同一套函数形状、同一套语句顺序，这样两边的调试器行为可以直接对照，
 * 也方便拿 riscv32-unknown-elf-gdb 做"逐地址比对"。
 *
 * 覆盖的调试语义：
 *   · engine_linear()    —— `optimize("O0")` 的线性语句序列（一语句一指令），单步对照靶子
 *   · engine_linear_os() —— 同样语句、默认 -Os
 *   · engine_deep_chain()—— 6 层嵌套（每层"调用后再加工"，不构成尾调用）
 *   · 递归 / 互递归 / 函数指针表（RISC-V 上是 `jalr`）/ 分支 switch / 内联函数
 */
#ifndef ENGINE_H
#define ENGINE_H

#include <stdint.h>

uint32_t engine_leaf(uint32_t a, uint32_t b);

uint32_t engine_linear(volatile uint32_t *slot, uint32_t seed);
uint32_t engine_linear_os(volatile uint32_t *slot, uint32_t seed);

uint32_t engine_deep_chain(uint32_t seed);

uint32_t engine_rec_fib(uint32_t n);
uint32_t engine_rec_ack(uint32_t m, uint32_t n);
int      engine_mutual(uint32_t n);

uint32_t engine_dispatch(uint32_t which, uint32_t x);
uint32_t engine_branchy(uint32_t n);

/* 内联：**没有独立地址**，`b engine_inline_double` 应该明确说"下不到" */
static inline uint32_t engine_inline_double(uint32_t v){ return v * 2u + 1u; }
uint32_t engine_uses_inline(uint32_t v);

#endif /* ENGINE_H */
