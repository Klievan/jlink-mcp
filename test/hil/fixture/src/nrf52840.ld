/* nRF52840: 1 MB flash at 0, 256 KB RAM at 0x20000000. */
MEMORY
{
  FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 1024K
  RAM  (rwx) : ORIGIN = 0x20000000, LENGTH = 256K
}

ENTRY(Reset_Handler)

SECTIONS
{
  .text : {
    KEEP(*(.vectors))
    *(.text*)
    *(.rodata*)
  } > FLASH

  .bss (NOLOAD) : {
    _sbss = .;
    *(.bss*)
    *(COMMON)
    _ebss = .;
  } > RAM

  /* No .data. Everything initialised lives in .bss and is set in code, so the
   * startup path stays trivial and there is nothing to copy from flash. The
   * build asserts this rather than trusting it. */
  .data : { *(.data*) } > RAM
  ASSERT(SIZEOF(.data) == 0, "unexpected .data section: startup does not copy it")

  /DISCARD/ : { *(.ARM.exidx*) *(.comment) }
}
