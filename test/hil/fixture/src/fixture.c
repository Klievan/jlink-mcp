/*
 * HIL fixture firmware for the nRF52840-DK.
 *
 * Purpose-built to be *predictable*, not to be a realistic application. Every
 * value a test asserts against is either fixed at compile time or derived from
 * a symbol the build exports.
 *
 * What it provides:
 *   - A SEGGER RTT control block with one up and one down channel, so the RTT
 *     tools have something to read and something to send to.
 *   - Zephyr-format log lines at every level from two distinct modules, with a
 *     gapless sequence number so a dropped line is detectable rather than
 *     merely suspected.
 *   - A command interface on the down channel, so crashes happen on demand
 *     instead of the suite waiting for one.
 *   - A nested call chain with real symbols, so backtraces have an expected
 *     shape.
 *
 * Freestanding: no libc, no startup files, no .data (everything lives in .bss
 * and is initialised in code). That keeps the image small enough to reason
 * about and removes the toolchain's runtime from the set of things that can
 * differ between builds.
 */

#include <stdint.h>

#define RAM_END 0x20040000u

/* ── SEGGER RTT control block ──────────────────────────────────────
 * Layout is fixed by SEGGER: J-Link locates it by scanning RAM for the ID
 * string. The ID is written at runtime rather than stored as an initialised
 * constant, so a half-booted target cannot be mistaken for a ready one.
 */
typedef struct {
    const char *sName;
    char *pBuffer;
    uint32_t SizeOfBuffer;
    uint32_t WrOff; /* up: target writes. down: host writes. */
    uint32_t RdOff; /* up: host writes.   down: target writes. */
    uint32_t Flags;
} rtt_buffer_t;

typedef struct {
    char acID[16];
    int32_t MaxNumUpBuffers;
    int32_t MaxNumDownBuffers;
    rtt_buffer_t aUp[1];
    rtt_buffer_t aDown[1];
} rtt_cb_t;

#define UP_SIZE 2048
#define DOWN_SIZE 64

volatile rtt_cb_t _SEGGER_RTT;
static char up_buf[UP_SIZE];
static char down_buf[DOWN_SIZE];
static const char rtt_name[] = "Terminal";

/* ── Test-visible state ────────────────────────────────────────────
 * Named deliberately: the suite reads these by symbol, so renaming one breaks
 * a test rather than silently changing what is measured.
 */
volatile uint32_t test_counter;   /* free-running; proves the core executes */
volatile uint32_t test_seq;       /* log sequence number; gaps mean drops */
volatile uint32_t test_marker;    /* set by test_marker_fn */
volatile uint32_t test_depth;     /* call depth reached by the lvl chain */

static void rtt_init(void)
{
    _SEGGER_RTT.MaxNumUpBuffers = 1;
    _SEGGER_RTT.MaxNumDownBuffers = 1;
    _SEGGER_RTT.aUp[0].sName = rtt_name;
    _SEGGER_RTT.aUp[0].pBuffer = up_buf;
    _SEGGER_RTT.aUp[0].SizeOfBuffer = UP_SIZE;
    _SEGGER_RTT.aUp[0].WrOff = 0;
    _SEGGER_RTT.aUp[0].RdOff = 0;
    _SEGGER_RTT.aUp[0].Flags = 0; /* skip on overflow — a drop is visible as a sequence gap */
    _SEGGER_RTT.aDown[0].sName = rtt_name;
    _SEGGER_RTT.aDown[0].pBuffer = down_buf;
    _SEGGER_RTT.aDown[0].SizeOfBuffer = DOWN_SIZE;
    _SEGGER_RTT.aDown[0].WrOff = 0;
    _SEGGER_RTT.aDown[0].RdOff = 0;
    _SEGGER_RTT.aDown[0].Flags = 0;

    /* ID last: J-Link scans for this, so it must not appear until the rest of
     * the block is valid. */
    static const char id[] = "SEGGER RTT";
    for (int i = 0; i < 16; i++) _SEGGER_RTT.acID[i] = 0;
    for (int i = 0; id[i]; i++) _SEGGER_RTT.acID[i] = id[i];
}

static void rtt_putc(char c)
{
    uint32_t wr = _SEGGER_RTT.aUp[0].WrOff;
    uint32_t next = (wr + 1) % UP_SIZE;
    if (next == _SEGGER_RTT.aUp[0].RdOff) return; /* full: drop, leaving a gap */
    up_buf[wr] = c;
    _SEGGER_RTT.aUp[0].WrOff = next;
}

static void rtt_puts(const char *s)
{
    while (*s) rtt_putc(*s++);
}

static void put_u32(uint32_t v)
{
    char tmp[10];
    int n = 0;
    if (!v) { rtt_putc('0'); return; }
    while (v) { tmp[n++] = (char)('0' + (v % 10)); v /= 10; }
    while (n) rtt_putc(tmp[--n]);
}

static void put_pad2(uint32_t v) { rtt_putc((char)('0' + (v / 10) % 10)); rtt_putc((char)('0' + v % 10)); }
static void put_pad3(uint32_t v) { rtt_putc((char)('0' + (v / 100) % 10)); put_pad2(v); }

/*
 * Emit one Zephyr-format line:
 *   [00:00:01.000,244] <inf> module: message seq=N
 *
 * The timestamp is synthesised from the sequence number rather than a real
 * clock. A test asserting on log *format* should not also depend on timer
 * configuration, and a deterministic timestamp means the same input produces
 * the same transcript every run — which is what makes these captures usable
 * as golden fixtures.
 */
static void log_line(const char *level, const char *module, const char *msg)
{
    uint32_t s = test_seq;
    rtt_putc('[');
    put_pad2(s / 3600); rtt_putc(':');
    put_pad2((s / 60) % 60); rtt_putc(':');
    put_pad2(s % 60); rtt_putc('.');
    put_pad3((s * 7) % 1000); rtt_putc(',');
    put_pad3((s * 13) % 1000);
    rtt_puts("] <");
    rtt_puts(level);
    rtt_puts("> ");
    rtt_puts(module);
    rtt_puts(": ");
    rtt_puts(msg);
    rtt_puts(" seq=");
    put_u32(s);
    rtt_putc('\n');
    test_seq = s + 1;
}

/* ── Nested call chain, for backtrace shape ───────────────────────
 * noinline so the frames actually exist at -O1; the whole point is that a
 * backtrace can see them.
 */
__attribute__((noinline)) static void lvl3(void) { test_depth = 3; test_marker = 0xC0FFEE03; }
__attribute__((noinline)) static void lvl2(void) { test_depth = 2; lvl3(); }
__attribute__((noinline)) static void lvl1(void) { test_depth = 1; lvl2(); }

/* Breakpoint target. Deliberately trivial and never inlined. */
__attribute__((noinline)) void test_marker_fn(void)
{
    test_marker = 0xDEADBEEF;
    lvl1();
}

/* ── Fault injection ──────────────────────────────────────────────
 * Each produces a *different* CFSR, so decodeFaultRegisters has something
 * specific to be right or wrong about.
 */
static void crash_nullderef(void)
{
    log_line("err", "hil_fixture", "injected fault: nullderef");
    *(volatile uint32_t *)0x00000000 = 0x1; /* write to flash -> BusFault, BFAR=0 */
    __asm__ volatile("dsb");
}

static void crash_unaligned(void)
{
    log_line("err", "hil_fixture", "injected fault: unaligned");
    /* CCR.UNALIGN_TRP so an unaligned access traps rather than being fixed up */
    *(volatile uint32_t *)0xE000ED14 |= (1u << 3);
    __asm__ volatile("dsb");
    volatile uint32_t *p = (volatile uint32_t *)0x20001001;
    *p = 0x1; /* UsageFault: UNALIGNED */
}

static void crash_undefined(void)
{
    log_line("err", "hil_fixture", "injected fault: undefined instruction");
    __asm__ volatile(".hword 0xDEAD"); /* UsageFault: UNDEFINSTR */
}

static void crash_badaddr(void)
{
    log_line("err", "hil_fixture", "injected fault: unmapped read");
    volatile uint32_t v = *(volatile uint32_t *)0xF0000000;
    (void)v; /* BusFault on an unmapped region */
}

/* ── Down-channel command interface ───────────────────────────────
 * Lets the suite drive the target instead of waiting on it. Commands are
 * newline-terminated.
 */
static int str_eq(const char *a, const char *b)
{
    while (*a && *b) { if (*a++ != *b++) return 0; }
    return *a == *b;
}

static void handle_command(char *cmd)
{
    if (str_eq(cmd, "crash:nullderef")) { crash_nullderef(); return; }
    if (str_eq(cmd, "crash:unaligned")) { crash_unaligned(); return; }
    if (str_eq(cmd, "crash:undefined")) { crash_undefined(); return; }
    if (str_eq(cmd, "crash:badaddr")) { crash_badaddr(); return; }
    if (str_eq(cmd, "marker")) { test_marker_fn(); log_line("inf", "hil_fixture", "marker called"); return; }
    if (str_eq(cmd, "counter?")) {
        rtt_puts("[00:00:00.000,000] <inf> hil_fixture: counter=");
        put_u32(test_counter);
        rtt_putc('\n');
        return;
    }
    if (cmd[0] == 'e' && cmd[1] == 'c' && cmd[2] == 'h' && cmd[3] == 'o' && cmd[4] == ':') {
        log_line("inf", "hil_fixture", cmd + 5);
        return;
    }
    if (str_eq(cmd, "burst")) {
        /* Enough lines to exercise buffering and reveal drops as seq gaps. */
        for (int i = 0; i < 100; i++) log_line("dbg", "burst", "burst line");
        return;
    }
    log_line("wrn", "hil_fixture", "unknown command");
}

static void poll_down_channel(void)
{
    static char line[DOWN_SIZE];
    static uint32_t len;

    while (_SEGGER_RTT.aDown[0].RdOff != _SEGGER_RTT.aDown[0].WrOff) {
        char c = down_buf[_SEGGER_RTT.aDown[0].RdOff];
        _SEGGER_RTT.aDown[0].RdOff = (_SEGGER_RTT.aDown[0].RdOff + 1) % DOWN_SIZE;
        if (c == '\n' || c == '\r') {
            if (len) { line[len] = 0; handle_command(line); len = 0; }
        } else if (len < sizeof(line) - 1) {
            line[len++] = c;
        }
    }
}

int main(void)
{
    rtt_init();
    log_line("inf", "hil_fixture", "fixture ready");
    log_line("dbg", "sensor_drv", "sample raw=0x0410 scaled=1040");
    log_line("wrn", "sensor_drv", "sample out of range, clamping");

    for (;;) {
        test_counter++;
        poll_down_channel();
        if ((test_counter & 0x0007FFFF) == 0) {
            log_line("inf", "hil_fixture", "heartbeat");
        }
    }
}

/* ── Startup ──────────────────────────────────────────────────────
 * Zero .bss and call main. No .data section exists (checked by the build), so
 * there is nothing to copy from flash.
 */
extern uint32_t _sbss, _ebss;

void Reset_Handler(void)
{
    for (uint32_t *p = &_sbss; p < &_ebss; p++) *p = 0;
    main();
    for (;;) { }
}

/* Every fault lands here. A tight self-branch, so a halted target's PC lands
 * inside a known two-byte window and the suite can say "it faulted" without
 * ambiguity. */
void Fault_Handler(void)
{
    for (;;) { }
}

__attribute__((section(".vectors"), used))
void (*const vector_table[])(void) = {
    (void (*)(void))RAM_END,  /* initial MSP */
    Reset_Handler,
    Fault_Handler, /* NMI */
    Fault_Handler, /* HardFault */
    Fault_Handler, /* MemManage */
    Fault_Handler, /* BusFault */
    Fault_Handler, /* UsageFault */
};
