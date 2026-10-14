/* STM32H7B0 startup: vector table, FPU enable, .data/.bss init, then main.
 *
 * Cortex-M7 与 M3 的差别只有一处必须处理：**浮点单元**。本工程用
 * `-mfpu=fpv5-d16 -mfloat-abi=hard`（H7 的 FPU 是双精度），所以进 main 之前必须
 * ① 在 CPACR 里放行 CP10/CP11，② 把 FPU 上下文交给硬件（FPCCR 的 ASPEN/LSPEN）。
 * 否则编译器一旦生成 FPU 指令就会 UsageFault —— 而且现场看着像"复位后一动不动"。
 *
 * ⚠️ 另外注意 .data/.bss 在 **AXI SRAM(0x24000000)**（见 ld 脚本）：探针走 AHB-AP
 *    读不到 DTCM，被采样的变量必须放在 AXI —— 所以拷贝循环是在给 AXI 写数，
 *    上电即可写（AXI SRAM 不需要单独开时钟，RCC_AHB3ENR 里根本没有它的使能位）。
 */
#include <stdint.h>

extern uint32_t _estack;
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss;

int main(void);
void SysTick_Handler(void);

void Reset_Handler(void);
void Default_Handler(void);

void NMI_Handler(void)         __attribute__((weak, alias("Default_Handler")));
void HardFault_Handler(void)   __attribute__((weak, alias("Default_Handler")));
void MemManage_Handler(void)   __attribute__((weak, alias("Default_Handler")));
void BusFault_Handler(void)    __attribute__((weak, alias("Default_Handler")));
void UsageFault_Handler(void)  __attribute__((weak, alias("Default_Handler")));
void SVC_Handler(void)         __attribute__((weak, alias("Default_Handler")));
void DebugMon_Handler(void)    __attribute__((weak, alias("Default_Handler")));
void PendSV_Handler(void)      __attribute__((weak, alias("Default_Handler")));
void SysTick_Handler(void)     __attribute__((weak, alias("Default_Handler")));

/* H7 的外部中断在 0x40 之后；本工程一个都不开，所以向量表到 SysTick 为止就够。 */
__attribute__((section(".isr_vector"), used))
void (*const g_vectors[])(void) = {
  (void (*)(void))&_estack,       /* 0x00 初始栈顶（DTCM 顶，探针读不到栈也无所谓） */
  Reset_Handler,                  /* 0x04 */
  NMI_Handler,                    /* 0x08 */
  HardFault_Handler,              /* 0x0C */
  MemManage_Handler,              /* 0x10 */
  BusFault_Handler,               /* 0x14 */
  UsageFault_Handler,             /* 0x18 */
  0, 0, 0, 0,                     /* 保留 */
  SVC_Handler,                    /* 0x2C */
  DebugMon_Handler,               /* 0x30 */
  0,                              /* 保留 */
  PendSV_Handler,                 /* 0x38 */
  SysTick_Handler,                /* 0x3C */
};

void Reset_Handler(void){
  /* ① 先把 FPU 放行 —— 后面任何一行 C 代码都可能被编译成 FPU 指令 */
  *(volatile uint32_t *)0xE000ED88u |= (0xFu << 20);   /* CPACR: CP10/CP11 全访问 */
  __asm__ volatile("dsb");
  __asm__ volatile("isb");
  *(volatile uint32_t *)0xE000EF34u |= (1u << 31) | (1u << 30);  /* FPCCR: ASPEN | LSPEN */

  /* ② .data 从 flash 拷到 AXI SRAM、.bss 清零 */
  uint32_t *src = &_sidata, *dst = &_sdata;
  while (dst < &_edata) { *dst++ = *src++; }
  for (dst = &_sbss; dst < &_ebss; ) { *dst++ = 0; }

  main();
  for (;;) { }
}

void Default_Handler(void){
  for (;;) { }                    /* 留在这里等调试器接住 */
}
