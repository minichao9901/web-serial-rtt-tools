/* STM32H7B0：128KB flash + **栈在 DTCM** + **被采样的变量在 AXI SRAM**
 *
 * 🚨 内存布局是 H7 上最容易踩的地方：H7 的 RAM 是**散的** ——
 *    DTCM        0x20000000  128KB   内核私有总线、零等待、**不需要开任何时钟**
 *    AXI SRAM    0x24000000    1MB   ← 本固件把 .data/.bss 放这里
 *    AHB SRAM    0x30000000  等      D2/D3 域（不用）
 *
 * 为什么不能只图省事把变量放 DTCM：**H7 的 ITCM/DTCM 是内核私有总线，外部调试器走 AHB-AP
 * 读不到**（../stm32h7b0_rtt_speed/RESULTS.md 与 H743 兄弟例程的 README 都写明）。
 * J-Scope 靶子的全部意义就是"让探针把变量读出来"，所以 .data/.bss 必须落在 AXI SRAM。
 * 证据：`arm-none-eabi-nm build\fw.elf` → 所有 g_* 都是 0x24xxxxxx。
 *
 * 栈留在 DTCM：探针不需要读栈，而 DTCM 零等待、最省事。
 * （AXI SRAM 上电即可写：RCC_AHB3ENR 里根本没有 AXI SRAM 的时钟使能位，不需要开时钟。）
 *
 * flash 长度按 H7B0（value line，128KB）写；换了更大的 H7A3/B3 把 LENGTH 改大即可。
 */
ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 128K
  DTCM  (rwx) : ORIGIN = 0x20000000, LENGTH = 128K     /* 只放栈 */
  AXI   (rwx) : ORIGIN = 0x24000000, LENGTH = 1024K    /* .data/.bss：探针读得到 */
}

_estack = ORIGIN(DTCM) + LENGTH(DTCM);

SECTIONS
{
  .isr_vector : {
    KEEP(*(.isr_vector))
  } > FLASH

  .text : {
    *(.text*)
    *(.rodata*)
    . = ALIGN(4);
    _etext = .;
  } > FLASH

  .ARM.extab : { KEEP(*(.ARM.extab* .gnu.linkonce.armextab.*)) } > FLASH
  .ARM.exidx : {
    __exidx_start = .;
    KEEP(*(.ARM.exidx* .gnu.linkonce.armexidx.*))
    __exidx_end = .;
  } > FLASH

  _sidata = LOADADDR(.data);

  .data : {
    . = ALIGN(4);
    _sdata = .;
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } > AXI AT> FLASH

  .bss : {
    . = ALIGN(4);
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > AXI

  . = ALIGN(8);
  _end = .;
  PROVIDE(end = .);

  /* 明确报错：被采样的数据一旦溢出到别处，说明布局假设已经不成立 */
  ASSERT(_ebss <= ORIGIN(AXI) + LENGTH(AXI), "AXI SRAM overflow")
}
