/*
 * 调试器压力测试靶子 —— 复杂数据结构层（HPM5301EVKLite · RISC-V RV32，2026-10）
 *
 * 与 ARM 版（stm32h743_dbgstress/src/model.h）同构，每一处都对应一个真实的 DWARF 特性：
 * 嵌套结构体 / 二维数组 / 联合体 / 位域（含 6 位**有符号**位域）/ char[]（一条故意没有 NUL 结尾）
 * / 不可打印字节数组 / 指针链表 / const 限定对象（住 flash）。
 *
 * 位域组旁边有 `word`/`word2` 两个"**影子字**"：位域就是按同一套位移规则从它们切出来的，
 * 于是"调试器解出来的位域 == 影子字的对应位段"这条对账可以自动做。
 *
 * ⚠️ 定义（.c）里带上 `ATTR_PLACE_AT_NONCACHEABLE_BSS`：探针走 **SBA** 读内存、
 *    使用 HPM5301 DLM/SBA 可读窗口；该芯片没有 D-cache。
 */
#ifndef MODEL_H
#define MODEL_H

#include <stdint.h>

typedef enum {
  MODEL_IDLE  = 0,
  MODEL_RUN   = 1,
  MODEL_FAULT = 2,
  MODEL_DONE  = 3
} model_mode_t;

/* 最小单元：故意留出 padding 空洞（1+pad+2+4+8） */
typedef struct {
  uint8_t  ch;
  uint16_t idx;
  uint32_t flags;
  double   scale;
} cell_t;

/* 位域组：word/word2 是"手工复算的影子字"，测试用它反查每一位解得对不对 */
typedef struct {
  uint32_t word;                     /* 影子：bits 就是从它切出来的 */
  struct {
    uint32_t on     : 1;             /* bit0      */
    uint32_t level  : 3;             /* bit1..3   */
    uint32_t mode   : 2;             /* bit4..5   */
    uint32_t parity : 1;             /* bit6      */
    uint32_t rev    : 9;             /* bit7..15  */
    uint32_t spare  : 16;            /* bit16..31 */
  } bits;
  int32_t  scratch;                  /* 普通成员（把两个位域组隔到不同存储单元） */
  struct {
    int32_t  bias : 6;               /* **有符号位域**：负数要能解出 -32..31 */
    uint32_t tag  : 10;
    uint32_t rest : 16;
  } sbits;
  uint32_t word2;                    /* 影子：sbits 从它切出来 */
} flags_t;

typedef struct node_s {
  uint32_t       id;
  struct node_s *next;               /* 链表：最后一个指向 0 */
  char           name[12];           /* C 字符串 */
  cell_t         cell;               /* 结构体套结构体 */
} node_t;

/* 联合体：同一段内存的四种看法 */
typedef union {
  uint32_t raw;
  struct { uint16_t lo; uint16_t hi; } halves;
  float    as_f32;
  uint8_t  bytes[4];
} word_u;

typedef struct {
  uint32_t     magic;
  model_mode_t mode;
  flags_t      flags;
  word_u       word;
  node_t       nodes[4];             /* 结构体数组 */
  node_t      *head;                 /* 指向 nodes[0]，再顺着 next 走 */
  cell_t       grid[3][2];           /* 二维结构体数组 */
  double       matrix[2][2];         /* f64 矩阵 */
  const char  *label;                /* 指向 .rodata 里的字符串 */
  uint8_t      blob[8];              /* 不可打印字节：应退回 hex */
  int16_t      delta;                /* 有符号窄整型 */
  char         tag[8];               /* 短字符串（**故意没有 NUL 结尾** → 格式化要能兜住） */
} model_t;

extern volatile model_t  g_model;        /* 主对象：监视窗口展开的那一棵 */
extern model_t           g_model_plain;  /* 非 volatile 对照（同一套字段） */
extern const model_t     g_model_const;  /* const 限定对照（住 .rodata / flash） */
extern volatile uint32_t g_model_epoch;  /* 每次 update 自增：看"内存是不是活的" */
extern volatile uint32_t g_model_bf_seed;

void     model_init(void);
uint32_t model_update(uint32_t step);
void     model_bitfield_touch(uint32_t n);
uint32_t model_checksum(void);

#endif /* MODEL_H */
