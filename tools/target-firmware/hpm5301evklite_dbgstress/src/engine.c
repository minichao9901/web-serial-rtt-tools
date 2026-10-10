/* 调试器压力测试靶子 —— 控制流/调用链层实现（HPM5301EVKLite · RISC-V RV32，2026-10） */
#include "engine.h"

/* ---------------------------------------------------------------- 叶子 */

uint32_t engine_leaf(uint32_t a, uint32_t b)
{
  uint32_t t = a * 3u;
  t += b ^ 0xA5A5A5A5u;
  return t;
}

/* ---------------------------------------------------------------- 线性语句序列 */

/*
 * `optimize("O0")` 是**故意**的：一语句一条指令、行号与地址一一对应，
 * 拿它跟 gdb 的 `next` 逐步比对（压测里的"对照靶子"）。
 * `slot` 是 volatile：每一句写内存都真的发出去，不会被优化合并。
 */
__attribute__((noinline, optimize("O0")))
uint32_t engine_linear(volatile uint32_t *slot, uint32_t seed)
{
  uint32_t a = seed + 1u;              /* ①  */
  slot[0] = a;                         /* ②  */
  a += 0x11111111u;                    /* ③  */
  slot[1] = a;                         /* ④  */
  a ^= 0x00FF00FFu;                    /* ⑤  */
  slot[2] = a;                         /* ⑥  */
  a = engine_leaf(a, 3u);              /* ⑦  调用：n 应越过、si 应进入、fin 应回到 ⑧ */
  slot[3] = a;                         /* ⑧  */
  a = (a << 3) | (a >> 29);            /* ⑨  */
  slot[4] = a;                         /* ⑩  */
  a += slot[1];                        /* ⑪  */
  slot[5] = a;                         /* ⑫  */
  a = engine_leaf(a, 5u);              /* ⑬  第二个调用 */
  slot[6] = a;                         /* ⑭  */
  a -= 0x1234u;                        /* ⑮  */
  slot[7] = a;                         /* ⑯  */
  return a;                            /* ⑰  */
}

/* 同样的语句、默认 `-Os` —— 真实工程的样子（可能被折叠/重排） */
__attribute__((noinline))
uint32_t engine_linear_os(volatile uint32_t *slot, uint32_t seed)
{
  uint32_t a = seed + 1u;
  slot[0] = a;
  a += 0x11111111u;
  slot[1] = a;
  a ^= 0x00FF00FFu;
  slot[2] = a;
  a = engine_leaf(a, 3u);
  slot[3] = a;
  a = (a << 3) | (a >> 29);
  slot[4] = a;
  a += slot[1];
  slot[5] = a;
  a = engine_leaf(a, 5u);
  slot[6] = a;
  a -= 0x1234u;
  slot[7] = a;
  return a;
}

/* ---------------------------------------------------------------- 6 层嵌套调用 */

/* l5/l1 是 static（.symtab 里的局部 FUNC）：测「按符号下断点」认不认 static 函数。
 * `noinline` 必需：-Os 会把 static 函数内联掉、连符号都不剩。 */
__attribute__((noinline))
static uint32_t deep_l5(uint32_t v)
{
  uint32_t t = v ^ 0x0F0F0F0Fu;
  uint32_t r = engine_leaf(t, 5u);
  return r + 5u;                       /* 调用后再加工 → 不是尾调用，栈帧真的存在 */
}

uint32_t engine_deep_l4(uint32_t v)
{
  uint32_t t = v + 0x1111u;
  uint32_t r = deep_l5(t);
  return r ^ 0x00FF00FFu;
}

uint32_t engine_deep_l3(uint32_t v)
{
  uint32_t t = v * 3u;
  uint32_t r = engine_deep_l4(t);
  return r - 7u;
}

uint32_t engine_deep_l2(uint32_t v)
{
  uint32_t t = v ^ 0x5A5Au;
  uint32_t r = engine_deep_l3(t);
  return r + 0x1234u;
}

__attribute__((noinline))
static uint32_t deep_l1(uint32_t v)
{
  uint32_t t = (v << 1) | 1u;
  uint32_t r = engine_deep_l2(t);
  return r ^ 0xDEADBEEFu;
}

uint32_t engine_deep_chain(uint32_t seed)
{
  uint32_t r = deep_l1(seed);
  return r + 1u;
}

/* ---------------------------------------------------------------- 递归 */

uint32_t engine_rec_fib(uint32_t n)
{
  if (n < 2u) return n;
  return engine_rec_fib(n - 1u) + engine_rec_fib(n - 2u);
}

uint32_t engine_rec_ack(uint32_t m, uint32_t n)
{
  if (m == 0u) return n + 1u;
  if (n == 0u) return engine_rec_ack(m - 1u, 1u);
  return engine_rec_ack(m - 1u, engine_rec_ack(m, n - 1u));
}

/* 互递归：两个函数交替调用（单步跳出时会跨函数来回跳） */
static int is_odd(int n);
static int is_even(int n)
{
  if (n == 0) return 1;
  return is_odd(n - 1);
}
static int is_odd(int n)
{
  if (n == 0) return 0;
  return is_even(n - 1);
}

int engine_mutual(uint32_t n)
{
  int r = is_even((int)(n & 15u));
  return r;
}

/* ---------------------------------------------------------------- 间接调用 */

static uint32_t fn_add(uint32_t x){ return x + 0x1111u; }
static uint32_t fn_xor(uint32_t x){ return x ^ 0x00FF00FFu; }
static uint32_t fn_mul(uint32_t x){ return x * 2654435761u; }
static uint32_t fn_rol(uint32_t x){ return (x << 7) | (x >> 25); }

typedef uint32_t (*engine_fn_t)(uint32_t);
static const engine_fn_t s_dispatch[4] = { fn_add, fn_xor, fn_mul, fn_rol };

/* 函数指针表：RISC-V 上是 `jalr`（间接调用）—— 单步进入要认得它 */
uint32_t engine_dispatch(uint32_t which, uint32_t x)
{
  engine_fn_t f = s_dispatch[which & 3u];
  uint32_t r = f(x);
  return r ^ (which << 8);
}

/* ---------------------------------------------------------------- 分支与循环 */

uint32_t engine_branchy(uint32_t n)
{
  uint32_t acc = 0;
  uint32_t i;

  for (i = 0; i < 6u; i++){
    if ((n + i) & 1u){
      acc += i * 3u;
    } else if (((n + i) % 3u) == 0u){
      acc ^= (i << 4);
    } else {
      acc -= i;
    }
    switch (i & 3u){
      case 0: acc += 1u; break;
      case 1: acc += 2u; break;
      case 2: acc += 4u; break;
      default: acc += 8u; break;
    }
  }
  return acc;
}

/* ---------------------------------------------------------------- 内联 */

uint32_t engine_uses_inline(uint32_t v)
{
  uint32_t a = engine_inline_double(v);        /* 内联展开：没有独立的"进入"目标 */
  uint32_t b = engine_inline_double(a);
  return a + b + 3u;
}
