/* H743 fault acceptance fixture. No external pin writes. D-cache stays disabled.
 * Request modes from the debugger; zero means an ordinary running program. */
#include <stdint.h>
#define REG(a) (*(volatile uint32_t *)(a))
volatile uint32_t g_fault_request, g_fault_seen, g_heartbeat, g_result;
__attribute__((aligned(8))) uint32_t g_psp_stack[256];
extern uint32_t _estack,_sidata,_sdata,_edata,_sbss,_ebss;
int main(void);
void Reset_Handler(void);
void HardFault_Handler(void);
void Default_Handler(void){for(;;)__asm volatile("nop");}
__attribute__((section(".isr_vector"),used)) void (*const vectors[])(void)={
 (void (*)(void))&_estack,Reset_Handler,Default_Handler,HardFault_Handler,
 Default_Handler,Default_Handler,Default_Handler,0,0,0,0,Default_Handler,
 Default_Handler,0,Default_Handler,Default_Handler};
void Reset_Handler(void){
 REG(0xe000ed08)=0x08000000;REG(0xe000ed88)|=0xfu<<20;
 __asm volatile("dsb;isb");REG(0xe000ef34)|=(1u<<31)|(1u<<30);
 uint32_t *s=&_sidata;for(uint32_t *d=&_sdata;d<&_edata;)*d++=*s++;
 for(uint32_t *d=&_sbss;d<&_ebss;)*d++=0;
 main();for(;;){}
}
__attribute__((noinline,optimize("O0"))) void fault_handler_body(void){
 g_fault_seen++;for(;;)__asm volatile("nop");
}
/* An ordinary prologue deliberately saves EXC_RETURN. Tests with vector catch
 * disabled stop in fault_handler_body and must unwind to the original frame. */
__attribute__((noinline,optimize("O0"))) void HardFault_Handler(void){
 fault_handler_body();g_fault_seen++;
}
__attribute__((noinline)) uint32_t fault_udf(uint32_t x){
 __asm volatile(".global fault_udf_pc\nfault_udf_pc: udf #0" ::: "memory");return x+1;
}
__attribute__((noinline)) uint32_t fault_div(uint32_t x){
 uint32_t zero=0;
 __asm volatile(".global fault_div_pc\nfault_div_pc: sdiv %0,%1,%2":"=r"(x):"r"(x),"r"(zero));return x;
}
__attribute__((noinline)) uint32_t fault_bus(uint32_t x){
 volatile uint32_t *a=(uint32_t *)0x60000000;
 __asm volatile(".global fault_bus_pc\nfault_bus_pc: ldr %0,[%1]":"=r"(x):"r"(a):"memory");return x;
}
__attribute__((noinline)) uint32_t fault_mpu(uint32_t x){
 volatile uint32_t *a=(uint32_t *)0x2407c000;
 __asm volatile(".global fault_mpu_pc\nfault_mpu_pc: ldr %0,[%1]":"=r"(x):"r"(a):"memory");return x;
}
__attribute__((noinline)) uint32_t fault_mid(uint32_t mode){
 uint32_t x;
 if(mode==2)x=fault_div(42);else if(mode==3)x=fault_bus(42);
 else if(mode==6)x=fault_mpu(42);else x=fault_udf(42);
 g_result=x;return x+mode;
}
/* Non-tail calls preserve the real call chain. */
__attribute__((noinline)) uint32_t fault_outer(uint32_t mode){uint32_t x=fault_mid(mode);g_result=x;return x+1;}
__attribute__((naked,noinline)) void enter_psp(uint32_t mode,uint32_t *top){
 __asm volatile("msr psp,r1\nmovs r2,#2\nmsr control,r2\nisb\nbl fault_outer\nb .");
}
__attribute__((naked,noinline)) void enter_psp_fp(uint32_t mode,uint32_t *top){
 __asm volatile("msr psp,r1\nmovs r2,#2\nmsr control,r2\nisb\nvmov.f32 s0,#1.0\nvadd.f32 s1,s0,s0\nbl fault_outer\nb .");
}
int main(void){
 /* Disabled configurable faults must escalate to HardFault. */
 REG(0xe000ed24)&=~(7u<<16);REG(0xe000ed14)|=1u<<9;
 for(;;){
  g_heartbeat++;
  uint32_t mode=g_fault_request;if(!mode)continue;
  if(mode==2)REG(0xe000ed14)|=1u<<4;
  if(mode==6){
   /* 32-byte MPU no-access region inside otherwise accessible AXI SRAM. */
   REG(0xe000ed94)=0;REG(0xe000ed98)=7;REG(0xe000ed9c)=0x2407c000;
   REG(0xe000eda0)=(4u<<1)|1u;REG(0xe000ed94)=5;__asm volatile("dsb;isb");
  }
  if(mode==4)enter_psp(mode,g_psp_stack+256);
  else if(mode==5)enter_psp_fp(mode,g_psp_stack+256);
  else g_result=fault_outer(mode);
 }
}
