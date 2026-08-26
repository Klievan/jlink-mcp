import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RTTClient, stripAnsi, parseZephyrLog, isRttHeader } from "../../src/rtt/rtt-client";
import { golden } from "../helpers";

describe("stripAnsi", () => {
  test("removes SGR colour sequences", () => {
    assert.equal(stripAnsi("\x1b[1;32mgreen\x1b[0m"), "green");
  });

  test("removes cursor and erase sequences", () => {
    assert.equal(stripAnsi("\x1b[2Ktext\x1b[1A"), "text");
  });

  test("leaves plain text untouched", () => {
    assert.equal(stripAnsi("plain [text] with brackets"), "plain [text] with brackets");
  });

  test("leaves a Zephyr timestamp intact", () => {
    const line = "[00:00:01.000,488] <inf> hil_fixture: heartbeat seq=1";
    assert.equal(stripAnsi(line), line);
  });
});

describe("parseZephyrLog", () => {
  test("splits timestamp, level, module and message", () => {
    const p = parseZephyrLog("[00:00:01.000,488] <inf> hil_fixture: heartbeat seq=1");
    assert.equal(p.deviceTime, "00:00:01.000,488");
    assert.equal(p.level, "inf");
    assert.equal(p.module, "hil_fixture");
    assert.equal(p.message, "heartbeat seq=1");
  });

  test("handles module names with underscores", () => {
    assert.equal(parseZephyrLog("[00:00:00.000,244] <dbg> sensor_drv: x").module, "sensor_drv");
  });

  test("splits on the module colon, keeping later colons in the message", () => {
    const p = parseZephyrLog("[00:00:02.501,200] <err> os:   BFAR Address: 0x00000000");
    assert.equal(p.module, "os");
    // Zephyr indents continuation lines; the leading run is absorbed as part
    // of the module/message separator, the colon inside the text is not.
    assert.equal(p.message, "BFAR Address: 0x00000000");
  });

  test("falls back gracefully on a non-Zephyr line", () => {
    const p = parseZephyrLog("*** Booting Zephyr OS build v3.5.0-rc1 ***");
    assert.equal(p.level, null);
    assert.equal(p.module, null);
    assert.equal(p.message, "*** Booting Zephyr OS build v3.5.0-rc1 ***");
  });
});

describe("isRttHeader", () => {
  test("recognizes the SEGGER banner", () => {
    assert.ok(isRttHeader("SEGGER J-Link V7.94e - Real time terminal output"));
    assert.ok(isRttHeader("Process: JLinkGDBServerCLExe"));
  });

  test("does not swallow application output", () => {
    assert.ok(!isRttHeader("[00:00:01.000,488] <inf> hil_fixture: heartbeat seq=1"));
    assert.ok(!isRttHeader("*** Booting Zephyr OS build v3.5.0-rc1 ***"));
  });
});

describe("RTTClient.ingest — full pipeline over a golden stream", () => {
  function feed(chunks: string[]): RTTClient {
    const c = new RTTClient();
    for (const chunk of chunks) c.ingest(chunk);
    return c;
  }

  const stream = golden("rtt-zephyr-stream.txt");

  test("drops the SEGGER banner, keeps application output", () => {
    const lines = feed([stream]).getLines(100);
    assert.ok(!lines.some((l) => l.includes("SEGGER J-Link")));
    assert.ok(!lines.some((l) => l.includes("Process: JLink")));
    assert.ok(lines.some((l) => l.includes("Booting Zephyr OS")));
  });

  test("strips every escape byte from the buffered lines", () => {
    const lines = feed([stream]).getLines(100);
    for (const line of lines) {
      assert.ok(!line.includes("\x1b"), `ANSI escape survived: ${JSON.stringify(line)}`);
    }
  });

  test("parses levels and modules out of the coloured stream", () => {
    const c = feed([stream]);
    assert.equal(c.search({ level: "err" }).length, 4);
    assert.equal(c.search({ level: "wrn" }).length, 1);
    assert.equal(c.search({ module: "sensor_drv" }).length, 2);
  });

  test("regex search matches message content", () => {
    const hits = feed([stream]).search({ pattern: "seq=\\d+" });
    assert.equal(hits.length, 2);
  });

  test("an invalid regex degrades to substring search instead of throwing", () => {
    const hits = feed([stream]).search({ pattern: "hil_fixture[" });
    assert.equal(hits.length, 0);
  });

  test("reassembles lines split across chunk boundaries", () => {
    // A TCP read can land anywhere, including mid-escape-sequence. Feeding
    // the same stream one byte at a time must produce an identical buffer.
    const whole = feed([stream]).getLines(100);
    const byByte = feed(stream.split("")).getLines(100);
    assert.deepEqual(byByte, whole);
  });

  test("holds an incomplete trailing line until its newline arrives", () => {
    const c = new RTTClient();
    c.ingest("[00:00:03.000,000] <inf> hil_fixture: partial");
    assert.equal(c.getLines(10).length, 0, "unterminated line must not be emitted");
    c.ingest(" continued\n");
    const lines = c.getLines(10);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /partial continued/);
  });

  test("round-trips the canonical format through getLines", () => {
    const c = feed(["[00:00:01.000,488] \x1b[1;32m<inf> hil_fixture: heartbeat seq=1\x1b[0m\n"]);
    assert.equal(c.getLines(1)[0], "[00:00:01.000,488] <inf> hil_fixture: heartbeat seq=1");
  });

  test("clearBuffer empties the search buffer", () => {
    const c = feed([stream]);
    assert.ok(c.getLines(100).length > 0);
    c.clearBuffer();
    assert.equal(c.getLines(100).length, 0);
    assert.equal(c.search({ level: "err" }).length, 0);
  });
});
