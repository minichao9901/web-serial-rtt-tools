/* F103ZE Cortex-M3 fault acceptance fixture. No external pin writes.
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
 REG(0xe000ed08)=0x08000000;
 __asm volatile("dsb;isb");
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
 volatile uint32_t *a=(uint32_t *)0x20020000;
 __asm volatile(".global fault_bus_pc\nfault_bus_pc: ldr %0,[%1]":"=r"(x):"r"(a):"memory");return x;
}
__attribute__((noinline)) uint32_t fault_unaligned(uint32_t x){
 volatile uint32_t *a=(uint32_t *)0x20000001;
 __asm volatile(".global fault_unaligned_pc\nfault_unaligned_pc: ldr %0,[%1]":"=r"(x):"r"(a):"memory");return x;
}
__attribute__((noinline)) uint32_t fault_mid(uint32_t mode){
 uint32_t x;
 if(mode==2)x=fault_div(42);else if(mode==3)x=fault_bus(42);
 else if(mode==5)x=fault_unaligned(42);else x=fault_udf(42);
 g_result=x;return x+mode;
}
/* Non-tail calls preserve the real call chain. */
__attribute__((noinline)) uint32_t fault_outer(uint32_t mode){uint32_t x=fault_mid(mode);g_result=x;return x+1;}
__attribute__((naked,noinline)) void enter_psp(uint32_t mode,uint32_t *top){
 __asm volatile("msr psp,r1\nmovs r2,#2\nmsr control,r2\nisb\nbl fault_outer\nb .");
}
int main(void){
 /* Disabled configurable faults must escalate to HardFault. */
 REG(0xe000ed24)&=~(7u<<16);REG(0xe000ed14)|=1u<<9;
 for(;;){
  g_heartbeat++;
  uint32_t mode=g_fault_request;if(!mode)continue;
  if(mode==2)REG(0xe000ed14)|=1u<<4;
  if(mode==5)REG(0xe000ed14)|=1u<<3; /* UNALIGN_TRP */
  if(mode==4)enter_psp(mode,g_psp_stack+256);
  else if(mode==7)enter_psp(mode,g_psp_stack+255); /* force 4-byte PSP alignment */
  else g_result=fault_outer(mode);
 }
}
