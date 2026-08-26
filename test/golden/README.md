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
| `jlink-halt-regs.txt` | `JLinkExe` -> `halt; regs` | **captured** 2026-08-26, nRF52840-DK, J-Link V9.70 |
| `jlink-mem-dump.txt` | `JLinkExe` -> `mem 0x100, 20` | **captured** 2026-08-26, nRF52840-DK, J-Link V9.70 |
| `gdb-info-all-registers-raw.txt` | GDB/MI -> `info all-registers` | **captured** 2026-08-26, gdb 15.1 via J-Link GDB Server V9.70 |
| `gdb-mi-x20bx-raw.txt` | GDB/MI -> `x/20bx 0xe000ed28` | **captured** 2026-08-26, same session |
| `jlink-mem-fault-regs.txt` | `JLinkExe` -> `mem 0xE000ED28, 14` | **synthetic** — see below |
| `gdb-mi-session-raw.txt` | GDB/MI startup, `continue`, breakpoint stop | **synthetic** |
| `gdb-mi-error-invalid-register.txt` | GDB/MI -> `info registers PC` | **synthetic** |
| `rtt-zephyr-stream.txt` | RTT telnet stream, Zephyr logs with ANSI colour | **synthetic** |

Captured files came off the DK through the HIL tier, which runs with
`JLINK_MCP_LOG_RAW=1` so the run log carries the exact bytes the parsers
consume. `promote.js` extracts them. They are raw pre-parse text: the GDB
register capture is unprocessed MI, and the register tests pipe it through the
real `cleanMI` themselves, because that is the pipeline production runs.

The captured ones are worth more than they look. Promoting them immediately
found a regression the hand-written fixtures could not: MI result records
carry the command token (`17^done`, not `^done`), so `cleanMI` was leaking a
stray record into every GDB-routed tool's output and had stopped recognising
`^running` altogether. No hand-written fixture had a token in it.

### The synthetic ones, and why they stay

`jlink-mem-fault-regs.txt` encodes a bus fault at address 0 — `CFSR=0x00008200`
(PRECISERR + BFARVALID), `HFSR=0x40000000` (FORCED), `BFAR=0x00000000`. The HIL
fixture firmware is a silent spin loop with no way to trigger a fault on
demand, so this scenario cannot be captured yet. It is the only coverage
`decodeFaultRegisters` and `readFaultRegisters` have, so it stays until Phase 2
adds crash triggers to the fixture; then it gets captured like the rest.

The RTT and GDB-session fixtures are synthetic for the same reason — no
firmware emitting logs, and no symbol-loaded breakpoint session yet.

**Synthetic means the shape is believed, not observed.** Every parser bug this
project has shipped came from believing a format rather than checking it.

## Values encoded in these fixtures

The captured register and memory transcripts describe an nRF52840 (Cortex-M4F,
CPUID `0x410FC241`) halted inside the HIL fixture's spin loop:

- `PC = 0x00000044` (the loop head), `SP`/`MSP = 0x20010000`, `PSP = 0`
- `R0 = 0x20000000` — the RAM word the loop increments
- `IPSR = 0` — thread mode, no exception

The J-Link and GDB register captures are the same machine state read through
different channels, so `parseRegisters` must produce equivalent output from
both — the property that broke when CPU control was routed through GDB, and
the reason this directory exists.

They were taken moments apart, so `R1` (the fixture's counter) and `XPSR`
(whose flags its arithmetic sets) legitimately differ. `APSR` differs in kind,
not just value: J-Link prints the decoded flag string `Nzcvq`, GDB prints a
number. Only registers the fixture does not touch are compared.
