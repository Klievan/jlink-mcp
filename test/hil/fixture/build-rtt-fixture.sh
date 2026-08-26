#!/usr/bin/env bash
# Build the RTT fixture and export the symbol addresses the HIL suite asserts
# against. Run from anywhere; writes into this script's directory.
#
# The .hex, .elf and symbols.json are all committed. CI does not build this —
# an ARM toolchain in the hardware job is one more thing that can differ
# between runs, and the point of a fixture is that it does not.
set -euo pipefail
cd "$(dirname "$0")"

CC=${CC:-arm-none-eabi-gcc}
OBJCOPY=${OBJCOPY:-arm-none-eabi-objcopy}
NM=${NM:-arm-none-eabi-nm}

"$CC" -mcpu=cortex-m4 -mthumb -Os -g3 -std=c11 \
  -ffreestanding -nostdlib -nostartfiles \
  -ffunction-sections -fdata-sections -Wl,--gc-sections \
  -Wall -Wextra -Werror \
  -T src/nrf52840.ld -o rtt-fixture.elf src/fixture.c

"$OBJCOPY" -O ihex rtt-fixture.elf rtt-fixture.hex

# Export the addresses tests need. Committed so the suite never has to parse an
# ELF at runtime, and so a symbol that moves shows up as a reviewable diff.
"$NM" rtt-fixture.elf | awk '
  BEGIN { print "{" }
  {
    name = $3
    if (name ~ /^(test_counter|test_seq|test_marker|test_depth|test_marker_fn|lvl1|lvl2|lvl3|main|Reset_Handler|Fault_Handler|_SEGGER_RTT)$/) {
      if (seen[name]++) next
      if (n++) printf ",\n"
      printf "  \"%s\": \"0x%s\"", name, $1
    }
  }
  END { print "\n}" }
' > symbols.json

echo "built rtt-fixture.elf / .hex"
size_dec=$(arm-none-eabi-size rtt-fixture.elf | awk 'NR==2 {print $1+$2}')
echo "flash bytes: $size_dec"
