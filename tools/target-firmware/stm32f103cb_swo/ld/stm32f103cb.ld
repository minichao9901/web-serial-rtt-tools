/* STM32F103CB: 128 KB Flash / 20 KB SRAM. */
ENTRY(Reset_Handler)

MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 128K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 20K
}

_estack = ORIGIN(RAM) + LENGTH(RAM);

SECTIONS
{
  .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
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
  } > RAM AT> FLASH
  .bss : {
    . = ALIGN(4);
    _sbss = .;
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
  } > RAM
  . = ALIGN(8);
  _end = .;
  PROVIDE(end = .);
  ASSERT(_ebss <= ORIGIN(RAM) + LENGTH(RAM), "F103CB SRAM overflow")
}
