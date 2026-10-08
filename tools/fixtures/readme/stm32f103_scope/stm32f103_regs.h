/* STM32F103 最小寄存器定义（只列本测试固件用到的，避免引入 CMSIS/标准外设库） */
#ifndef STM32F103_REGS_H
#define STM32F103_REGS_H

#include <stdint.h>

#define REG32(a)  (*(volatile uint32_t *)(a))

/* ---- RCC ---- */
#define RCC_CR        REG32(0x40021000)
#define RCC_CFGR      REG32(0x40021004)
#define RCC_APB1ENR   REG32(0x4002101C)
#define RCC_APB2ENR   REG32(0x40021018)
#define RCC_APB2ENR_AFIOEN    (1u << 0)
#define RCC_APB2ENR_IOPAEN    (1u << 2)
#define RCC_APB2ENR_IOPBEN    (1u << 3)
#define RCC_APB2ENR_IOPCEN    (1u << 4)
#define RCC_APB2ENR_USART1EN  (1u << 14)

/* ---- GPIOA / GPIOC ---- */
#define GPIOA_CRL     REG32(0x40010800)
#define GPIOA_CRH     REG32(0x40010804)
#define GPIOA_IDR     REG32(0x40010808)
#define GPIOA_ODR     REG32(0x4001080C)
#define GPIOA_BSRR    REG32(0x40010810)
#define GPIOA_BRR     REG32(0x40010814)

#define GPIOC_CRL     REG32(0x40011000)
#define GPIOC_CRH     REG32(0x40011004)
#define GPIOC_IDR     REG32(0x40011008)
#define GPIOC_ODR     REG32(0x4001100C)
#define GPIOC_BSRR    REG32(0x40011010)
#define GPIOC_BRR     REG32(0x40011014)

/* ---- USART1 (PA9 = TX, PA10 = RX) ---- */
#define USART1_SR     REG32(0x40013800)
#define USART1_DR     REG32(0x40013804)
#define USART1_BRR    REG32(0x40013808)
#define USART1_CR1    REG32(0x4001380C)
#define USART_SR_RXNE (1u << 5)
#define USART_SR_TXE  (1u << 7)
#define USART_SR_TC   (1u << 6)
#define USART_CR1_RE  (1u << 2)
#define USART_CR1_TE  (1u << 3)
#define USART_CR1_UE  (1u << 13)

/* ---- Cortex-M3 内核外设 ---- */
#define SYST_CSR      REG32(0xE000E010)
#define SYST_RVR      REG32(0xE000E014)
#define SYST_CVR      REG32(0xE000E018)
#define SCB_AIRCR     REG32(0xE000ED0C)
#define SCB_CPUID     REG32(0xE000ED00)

/* ---- 调试/芯片信息 ---- */
#define DBGMCU_IDCODE REG32(0xE0042000)
#define FLASH_SIZE_REG REG32(0x1FFFF7E0)     /* 低 16 位 = flash 容量(KB) */

static inline void nvic_system_reset(void){
  SCB_AIRCR = 0x05FA0004u;                   /* VECTKEY | SYSRESETREQ */
  for (;;) { }
}

#endif
