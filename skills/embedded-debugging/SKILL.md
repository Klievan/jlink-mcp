---
name: embedded-debugging
description: Debug embedded firmware on real hardware through the jlink-mcp server — crashes, hangs, peripheral misconfiguration, silent devices. Covers loading ELF symbols for source-level backtraces, supplying an SVD for named peripheral fields, and the halt/read/resume discipline. Use whenever debugging a microcontroller over a J-Link, OpenOCD, or Black Magic probe.
---

# Embedded debugging over a debug probe

You are talking to a physical microcontroller through a debug probe. It is
slower, more stateful, and far less forgiving than a process on your machine.

The single rule that matters: **the device is the source of truth, and it is
cheap to ask it.** Nearly every wrong answer in this domain comes from
reasoning about what the hardware "should" be doing instead of reading it.

## Before you debug anything: two files that change everything

Most sessions are needlessly blind because these were never supplied. Check
`get_config` at the start and ask for whichever is missing.

### The ELF gives you names

Without it you do not merely lose names — you lose the stack. Measured on an
nRF52840, the same halted target, one `gdb_load` apart:

```
# no symbols
#0  0x00000048 in ?? ()

# after gdb_load
#0  0x00000048 in rtt_puts (s=s@entry=0x520 "] <") at src/fixture.c:124
#1  0x000001c2 in log_line (level=0x59b "inf", module=0x54a "hil_fixture",
                            msg=0x58d "fixture ready") at src/fixture.c:158
#2  0x000002fa in main () at src/fixture.c:282
```

One anonymous frame becomes three named ones with arguments and line numbers.
GDB cannot unwind past the top frame without the debug info, so "the caller"
is not a question you can even ask until the ELF is loaded.

```
gdb_load { elfFile: "build/zephyr/zephyr.elf" }     # symbols only, does not touch flash
```

This does **not** reprogram the device — it loads symbols into GDB, and it
works whether or not the target is running, because GDB answers it from its
own symbol table without touching the probe. Pass `flash: true` only when you
actually intend to program it. Load the ELF that
matches the firmware currently on the target; a stale ELF gives confidently
wrong function names, which is worse than `??`.

Once loaded: `gdb_backtrace`, and `gdb_command` for `info locals`,
`print myStruct`, `x/16xw &buffer`, and turning a faulting address into a line:

```
info line *0x2a4
Line 91 of "src/fixture.c" starts at address 0x2a4 <main> and ends at 0x2a8 <main+4>.
```

### The SVD gives you meanings

Without it, a peripheral read is a hex word you have to decode by hand against
a 2000-page reference manual. With it, `read_peripheral` and `decode_register`
split the value into named fields with their enumerated meanings — `ENABLE = 4
(Enabled)` instead of `0x00000004`.

Set `SVD_PATH` (standalone) or `jlinkMcp.svdPath` (VSCode) to a CMSIS-SVD file
for the exact part. Vendors publish them; they are also in CMSIS device family
packs and the `cmsis-svd` collection. `list_peripherals` tells you immediately
whether one is loaded.

### While you are there: `JLINK_RTT_ADDR`

Set it to your firmware's `_SEGGER_RTT` symbol. The probe locates the RTT
control block by scanning RAM and never reports the address back, so without
this RTT cannot be recovered after a reset or a flash — and a stream that
stopped being collected looks exactly like a device that has gone quiet.

## Do not guess a part number

`set_device` needs J-Link's exact name for the chip, and a wrong one fails in
a way that looks like broken hardware rather than a typo. J-Link knows the
list — around 9800 parts — so ask it:

```
search_devices { query: "stm32f407" }
search_devices { query: "nordic" }        # by manufacturer
search_devices { query: "cortex-m33" }    # by core
```

Results carry flash and RAM sizes, which is what separates the variants that
differ by nothing else — an `STM32F407IE` from an `STM32F407IG`. Pass the name
back to `set_device` exactly as written.

## The halt rule

**Reading a running target is impossible, not slow.** The GDB server is a
synchronous remote: while the target runs it stops reading commands, and reads
are refused rather than queued.

So every inspection is: halt → read → resume. If a read comes back refused,
that is not a flaky probe, it is you asking at the wrong moment.

Two traps:

- **A core spinning in its fault handler counts as "running."** It will refuse
  reads exactly like healthy firmware. Halt first, then read — this is why
  `diagnose_crash` halts before it reads anything.
- **You cannot hold a core halted while RTT is being collected.** The probe
  collects RTT in stop mode by default: it halts the core, reads the buffer,
  and starts it again. A core "stopped at the reset vector" will not stay
  there. Disconnect RTT if the target genuinely has to stay put.

## Verify, do not infer

Embedded systems punish assumption. For every belief you form, there is a way
to ask the hardware, and it takes one tool call. Some worked examples:

| Belief | How to actually check it |
|---|---|
| "The core is running" | Halt, read a counter, resume, halt, read again. Moving is running. Same PC twice is not proof of a hang — it may be a delay loop. |
| "The reset worked" | Reset, **resume**, then read a `.bss` variable that only climbs. A halting reset stops *before* startup zeroes `.bss`, so checking without resuming proves nothing. |
| "The device stopped logging" | Read the RTT control block. `WrOff` is the target's write pointer, `RdOff` the host's. `WrOff` moving while `RdOff` sits still means the firmware is fine and the probe stopped collecting. |
| "It's hung" | Check for armed breakpoints. A stale FPB comparator raises a debug event that, with no debugger attached, escalates to HardFault — indistinguishable from a hang. `clear_breakpoints` and re-run. |
| "That register is 0" | Confirm the read succeeded. A refused read and a genuine zero look identical once the value reaches you. |
| "The firmware on the device is the one I built" | Read the vector table or a known constant and compare against your build. Flashing can silently not have happened. |

When two channels disagree, that is information, not noise: if `read_registers`
and `probe_command { commands: ["halt","regs"] }` report different PCs, the core
was moving between the two reads.

## Workflows

### A crash
```
diagnose_crash                    # halts, decodes CFSR/HFSR/DFSR, unwinds the frame
gdb_backtrace                     # needs the ELF, or this is addresses only
gdb_command { command: "info line *0x<faulting PC>" }
rtt_search { level: "err" }       # what the device said before it died
```
`diagnose_crash` reporting no faults is only meaningful if the read succeeded.
It says so explicitly when it could not read — that is not a clean bill of health.

### A hang, or "it does nothing"
```
snapshot                          # registers + faults + stack + RTT in one call
```
Take it twice, a second apart, and compare the PC. Then rule out, in order:
armed breakpoints (`clear_breakpoints`), a fault handler loop (PC inside your
`HardFault_Handler`), and a genuine wait (PC in a delay or a semaphore).

### A peripheral behaving oddly
```
list_peripherals { filter: "uart" }
read_peripheral { peripheral: "UARTE0" }
decode_register { peripheral: "UARTE0", register: "ENABLE" }
```
Compare what the registers say against what the code intended to write. The
gap between the two is usually the bug — a clock left off, a pin not routed, a
peripheral enabled before it was configured.

### A device that boots and then goes silent
Distinguish three cases before theorising: the firmware stopped, the probe
stopped collecting, or the log level filters it. Check the RTT pointers, check
the PC, then check `rtt_search` without a level filter.

## Session hygiene

- `start_debug_session` is one call for GDB server + RTT + boot log. Prefer it
  over assembling the pieces.
- **A probe serves one client at a time.** If something reports the probe busy,
  another GDB server or a stray JLinkExe has it — that is a real constraint,
  not a transient error to retry blindly.
- Clear breakpoints before you leave. A comparator left armed outlives your
  session and will fault the *next* firmware that happens to execute that
  address, which is a genuinely horrible bug to inherit.
- Tools report failure in their reply text. Read it. A tool that says
  "Reset failed: ..." has not reset anything, whatever you do next.
