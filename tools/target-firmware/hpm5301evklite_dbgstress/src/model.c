/*
 * 调试器压力测试靶子 —— 复杂数据结构层实现（HPM5301EVKLite · RISC-V RV32，2026-10）
 *
 * 与 ARM 版逐条对应（见 stm32h743_dbgstress/src/model.c）。三条设计纪律：
 *   ① `flags_apply()` 既写位域、又写"影子字"，两者按同一套移位规则算出来 ——
 *      调试器解错位就能立刻查出来；
 *   ② 所有对 `g_model` 的写都走 volatile 指针，-Os 不会把写删掉；
 *   ③ 字符串/字节数组**故意留一条没有 NUL 结尾**（tag[8]），看格式化会不会越界读。
 *
 * 变量放在 `.noncacheable.bss`，经 HPM5301 DLM/SBA 可读窗口供调试器观察。
 * HPM5301 没有 D-cache，这里不需要额外的 cache clean。
 */
#include "hpm_common.h"
#include "model.h"

ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(32) volatile model_t g_model;
ATTR_PLACE_AT_NONCACHEABLE_BSS model_t           g_model_plain;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_model_epoch;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_model_bf_seed;

/* const 对照：住 flash，字段值全是常量（读回来的东西必须和源码一模一样） */
const model_t g_model_const = {
  .magic  = 0x434F4E53u,             /* 'CONS' */
  .mode   = MODEL_DONE,
  .flags  = { .word = 0x0000FFFFu, .scratch = -12345, .word2 = 0xFFFFFFFFu },
  .word   = { .raw = 0x40490FDBu },  /* 3.14159274f */
  .nodes  = {
    { .id = 101u, .next = 0, .name = "const-101", .cell = { .ch = 'C', .idx = 101u, .flags = 0x11111111u, .scale = 1.25 } },
    { .id = 102u, .next = 0, .name = "const-102", .cell = { .ch = 'O', .idx = 102u, .flags = 0x22222222u, .scale = 2.5  } },
    { .id = 103u, .next = 0, .name = "const-103", .cell = { .ch = 'N', .idx = 103u, .flags = 0x33333333u, .scale = 3.75 } },
    { .id = 104u, .next = 0, .name = "const-104", .cell = { .ch = 'S', .idx = 104u, .flags = 0x44444444u, .scale = 5.0  } },
  },
  .head   = 0,
  .grid   = {
    { { .ch = 'a', .idx = 1u, .flags = 0x10000001u, .scale = 0.5 }, { .ch = 'b', .idx = 2u, .flags = 0x10000002u, .scale = 1.5 } },
    { { .ch = 'c', .idx = 3u, .flags = 0x10000003u, .scale = 2.5 }, { .ch = 'd', .idx = 4u, .flags = 0x10000004u, .scale = 3.5 } },
    { { .ch = 'e', .idx = 5u, .flags = 0x10000005u, .scale = 4.5 }, { .ch = 'f', .idx = 6u, .flags = 0x10000006u, .scale = 5.5 } },
  },
  .matrix = { { 1.5, 2.25 }, { 3.125, 4.0625 } },
  .label  = "const-model",
  .blob   = { 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x7F, 0x80, 0xFF },
  .delta  = -4096,
  .tag    = { 'C', 'O', 'N', 'S', 'T' },
};

/** 位域 + 影子字：一次算两遍，调试器解错了就能查出来 */
static void flags_apply(volatile flags_t *f, uint32_t w0, uint32_t w1)
{
  f->word = w0;
  f->bits.on     = (uint32_t)((w0 >>  0) & 0x1u);
  f->bits.level  = (uint32_t)((w0 >>  1) & 0x7u);
  f->bits.mode   = (uint32_t)((w0 >>  4) & 0x3u);
  f->bits.parity = (uint32_t)((w0 >>  6) & 0x1u);
  f->bits.rev    = (uint32_t)((w0 >>  7) & 0x1FFu);
  f->bits.spare  = (uint32_t)((w0 >> 16) & 0xFFFFu);

  f->word2 = w1;
  f->sbits.bias = (int32_t)(w1 << 26) >> 26;      /* 低 6 位 + 符号扩展 */
  f->sbits.tag  = (uint32_t)((w1 >>  6) & 0x3FFu);
  f->sbits.rest = (uint32_t)((w1 >> 16) & 0xFFFFu);

  f->scratch = (int32_t)(w0 ^ w1);
}

static void cell_set(volatile cell_t *c, uint32_t i, uint32_t step)
{
  c->ch    = (uint8_t)('A' + (char)((step + i) % 26u));
  c->idx   = (uint16_t)(step * 3u + i);
  c->flags = step ^ (i * 0x01010101u);
  c->scale = (double)i + (double)(step % 97u) / 97.0;
}

void model_init(void)
{
  static const char *const names[4] = { "node-alpha", "node-beta", "node-gamma", "node-delta" };
  uint32_t i;

  g_model.magic = 0x4D4F4445u;                 /* 'MODE' */
  g_model.mode  = MODEL_IDLE;
  g_model.label = "dbg-stress-model";
  g_model.delta = -3;

  for (i = 0; i < 4u; i++){
    volatile node_t *n = &g_model.nodes[i];
    uint32_t k;
    n->id = 1000u + i;
    n->next = (i + 1u < 4u) ? (node_t *)&g_model.nodes[i + 1u] : (node_t *)0;
    for (k = 0; k < sizeof(n->name) - 1u && names[i][k]; k++) n->name[k] = names[i][k];
    n->name[sizeof(n->name) - 1u] = '\0';
    cell_set(&n->cell, i, 0u);
  }
  g_model.head = (node_t *)&g_model.nodes[0];

  for (i = 0; i < 8u; i++) g_model.blob[i] = (uint8_t)(0xA0u + i);
  for (i = 0; i < 8u; i++) g_model.tag[i] = (char)('0' + (char)i);   /* 8 个字符、**没有 NUL** */

  g_model.word.raw = 0x3F800000u;               /* 1.0f */
  flags_apply(&g_model.flags, 0x12345678u, 0x0BADF00Du);
  g_model_bf_seed = 1u;
  g_model_epoch = 0u;

  /* 非 volatile 对照：同一套字段，值固定好认 */
  g_model_plain.magic = 0x504C4149u;            /* 'PLAI' */
  g_model_plain.mode  = MODEL_RUN;
  g_model_plain.label = "plain-model";
  g_model_plain.delta = 1234;
  g_model_plain.head  = (node_t *)0;
  for (i = 0; i < 4u; i++){
    volatile node_t *n = &g_model_plain.nodes[i];
    uint32_t k;
    n->id = 2000u + i;
    n->next = (node_t *)0;
    for (k = 0; k < sizeof(n->name) - 1u; k++) n->name[k] = (char)('p' + (char)i);
    n->name[sizeof(n->name) - 1u] = '\0';
    cell_set(&n->cell, i, 7u);
  }
  flags_apply(&g_model_plain.flags, 0x00FF00FFu, 0xFF00FF00u);
  g_model_plain.word.raw = 0xC0490FDBu;         /* -3.14159274f */
  for (i = 0; i < 8u; i++) g_model_plain.blob[i] = (uint8_t)(0x10u * (i + 1u));
}

uint32_t model_update(uint32_t step)
{
  volatile model_t *m = &g_model;
  uint32_t i;

  g_model_epoch = g_model_epoch + 1u;
  m->magic = 0x4D4F4445u;
  m->mode  = (model_mode_t)(step & 3u);
  m->delta = (int16_t)((step * 31u) & 0xFFFFu);
  m->word.raw = (step << 4) ^ 0x12345678u;
  g_model_bf_seed = step * 2654435761u;
  flags_apply(&m->flags, g_model_bf_seed, (step << 11) ^ 0x0BADF00Du);

  for (i = 0; i < 4u; i++) cell_set(&m->nodes[i].cell, i, step);

  for (i = 0; i < 3u; i++){
    m->grid[i][0].idx   = (uint16_t)(i * 1000u + (step % 1000u));
    m->grid[i][0].scale = (double)i - (double)(step % 17u);
    m->grid[i][1].flags = (step << (i + 1)) ^ 0xA5A5A5A5u;
    m->grid[i][1].scale = (double)(step % 13u) / 13.0;
  }

  m->matrix[0][0] = 1.0 + (double)(step % 1024u) / 1024.0;
  m->matrix[0][1] = (double)(step % 7u) - 3.5;
  m->matrix[1][0] = -(double)(step % 5u) / 4.0;
  m->matrix[1][1] = (double)(step & 0xFFu) * 0.5;

  for (i = 0; i < 8u; i++) m->blob[i] = (uint8_t)(step + i * 7u);

  return m->word.raw;
}

void model_bitfield_touch(uint32_t n)
{
  g_model_bf_seed = n * 2246822519u;
  flags_apply(&g_model.flags, g_model_bf_seed, n * 3266489917u);
}

uint32_t model_checksum(void)
{
  uint32_t sum = 0;
  uint32_t i;

  sum ^= g_model.magic;
  sum += g_model.word.raw;
  sum ^= g_model.flags.word;
  sum += g_model.flags.word2;
  sum += (uint32_t)g_model.delta;
  for (i = 0; i < 4u; i++){
    sum += g_model.nodes[i].id;
    sum += g_model.nodes[i].cell.idx;
    sum += (uint32_t)g_model.nodes[i].cell.scale;
  }
  sum += (uint32_t)(g_model.matrix[0][0] * 1000.0);
  sum ^= g_model_epoch;
  /*
   * 顺手把 const 对照对象读一下 —— 少了这一句 `--gc-sections` 会把 g_model_const 整个丢掉
   * （没人引用它，导出符号不是 GC 的根），调试器里就**根本列不出这个变量**。
   * ⚠️ 必须**经 volatile 指针**读：直接写 `g_model_const.magic` 会被常量折叠掉。
   */
  {
    const volatile model_t *pc = &g_model_const;
    sum += pc->magic;
    sum ^= (uint32_t)pc->delta;
  }
  return sum;
}
