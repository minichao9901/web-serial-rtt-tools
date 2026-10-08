#include "pipeline.h"
extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;
void Reset_Handler(void);
void SysTick_Handler(void);
void PendSV_Handler(void);
int main(void);
void Default_Handler(void) {
  for (;;) {
  }
}
__attribute__((section(".isr_vector"), used)) const void *vectors[76] = {
    [0] = &_estack,        [1] = Reset_Handler,    [2] = Default_Handler,
    [3] = Default_Handler, [4] = Default_Handler,  [5] = Default_Handler,
    [6] = Default_Handler, [11] = Default_Handler, [12] = Default_Handler,
    [14] = PendSV_Handler, [15] = SysTick_Handler};
void Reset_Handler(void) {
  uint32_t *s = &_sidata;
  for (uint32_t *p = &_sdata; p < &_edata;)
    *p++ = *s++;
  for (uint32_t *p = &_sbss; p < &_ebss;)
    *p++ = 0;
  REG(0xe000ed08) = 0x08000000;
  main();
  for (;;) {
  }
}
