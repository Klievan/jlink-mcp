# Golden transcripts

Raw, byte-for-byte output from the probe toolchain. The unit tests in
`test/unit/` replay these through the parsers, so a format regression is
caught in milliseconds on any machine — no hardware, no CI runner, no probe.

**These files are inputs. Do not reformat them.** No trailing-whitespace
cleanup, no re-indentation, no editor auto-fixes. Tab characters in the GDB
MI captures and the ESC bytes in the RTT capture are load-bearing — they are
exactly what the parsers must cope with, and "tidying" them silently removes
the coverage.

## Provenance

| File | Source | Status |
|---|---|---|
| `jlink-halt-regs.txt` | `JLinkExe` → `halt; regs` | **provisional** |
| `jlink-mem-fault-regs.txt` | `JLinkExe` → `mem 0xE000ED28, 20` | **provisional** |
| `gdb-info-all-registers.txt` | `arm-none-eabi-gdb` → `info all-registers` | **provisional** |
| `gdb-mi-x20bx-raw.txt` | GDB/MI response to `x/20bx 0xe000ed28` | **provisional** |
| `gdb-mi-session-raw.txt` | GDB/MI startup, `continue`, breakpoint stop | **provisional** |
| `gdb-mi-error-invalid-register.txt` | GDB/MI response to `info registers PC` | **provisional** |
| `rtt-zephyr-stream.txt` | RTT telnet stream, Zephyr logs with ANSI colour | **provisional** |

**Provisional** means the transcript was written from the documented and
observed shape of each tool's output, but has not yet been captured from the
nRF52840-DK on the HIL runner. They are structurally correct — the parsers
genuinely have to handle what is in them — but a real capture may differ in
whitespace, column widths, or firmware-version banner text, and those
differences are exactly the kind of thing that breaks a parser.

Replace each with a real capture as the HIL tier comes up (Phase 1), and
change its status to `captured <date> / <board> / <J-Link version>`. Until
then, treat a passing unit suite as "the parsers handle the format we believe
the tools emit", not as "the parsers handle the format the tools emit".

## Values encoded in these fixtures

The register and memory transcripts are internally consistent and describe one
scenario: an nRF52840 (Cortex-M4F, CPUID `0x410FC241`) stopped in a bus fault
handler after a write to address `0x00000000`.

- `PC = 0x000004B2`, `SP`/`MSP = 0x20002C40`, `PSP = 0`
- `XPSR = 0x61000000` (J-Link, exception number 0) and `0x61000003` (GDB,
  taken inside the handler so `IPSR = 3` = HardFault)
- `CFSR = 0x00008200` → BusFault `PRECISERR` + `BFARVALID`
- `HFSR = 0x40000000` → `FORCED`
- `BFAR = 0x00000000` → the faulting address

The J-Link and GDB register transcripts describe the same machine state on
purpose. `parseRegisters` must produce equivalent output from both, and a test
asserts exactly that — it is the property that broke in the GDB routing work
and the reason this directory exists.
