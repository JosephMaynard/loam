// Tests for plain mode's log output (cli/bin/plain-log.js). Run with `node --test` (root `pnpm test`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PLAIN_MIN_LEVEL, createPlainLogPrinter, formatPlainLogLine, levelLabel } from "../bin/plain-log.js";

const base = { pid: 4242, hostname: "ada-laptop", time: 1760000000000 };
const json = (fields) => JSON.stringify({ ...base, ...fields });

describe("formatPlainLogLine", () => {
  it("prints a warning or error as [level] message, without the hostname or pid", () => {
    assert.equal(formatPlainLogLine(json({ level: 40, msg: "Sync from http://pi.local:3000 failed" })), "[warn] Sync from http://pi.local:3000 failed");
    assert.equal(formatPlainLogLine(json({ level: 50, msg: "boot", err: { message: "ENOSPC" } })), "[error] boot: ENOSPC");
    assert.equal(formatPlainLogLine(json({ level: 50, err: { message: "ENOSPC" } })), "[error] ENOSPC");
    assert.equal(formatPlainLogLine(json({ level: 60, msg: "out of memory" })), "[fatal] out of memory");
    const shown = formatPlainLogLine(json({ level: 40, msg: "careful" }));
    assert.ok(!shown.includes("ada-laptop") && !shown.includes("4242"));
  });

  it("keeps everything below a warning off the console unless verbose", () => {
    assert.equal(PLAIN_MIN_LEVEL, 40);
    assert.equal(formatPlainLogLine(json({ level: 30, msg: "Server listening at http://0.0.0.0:3000" })), undefined);
    assert.equal(formatPlainLogLine(json({ level: 20, msg: "debug detail" })), undefined);
    assert.equal(formatPlainLogLine(json({ level: 30, msg: "incoming request", reqId: "req-1", req: { method: "GET", url: "/api/health" } })), undefined);
    assert.equal(formatPlainLogLine(json({ level: 30, msg: "Server listening" }), { verbose: true }), "[info] Server listening");
  });

  it("shows requests as one readable line each when verbose", () => {
    const incoming = json({ level: 30, msg: "incoming request", reqId: "req-1", req: { method: "GET", url: "/api/health", remoteAddress: "192.168.8.20" } });
    const completed = json({ level: 30, msg: "request completed", reqId: "req-1", res: { statusCode: 200 }, responseTime: 3.4 });
    assert.equal(formatPlainLogLine(incoming, { verbose: true }), "[info] GET /api/health from 192.168.8.20 (req-1)");
    assert.equal(formatPlainLogLine(completed, { verbose: true }), "[info] 200 in 3 ms (req-1)");
  });

  it("never lets a control character or bidi override through", () => {
    assert.equal(formatPlainLogLine(json({ level: 40, msg: "path \u001b[2J\u009b\u202ehidden\ttab" })), "[warn] path [2Jhidden tab");
    assert.equal(formatPlainLogLine("plain \u0007text\n"), "plain text");
  });

  it("prints a line that isn't JSON as it is, and shows the fields of a record without a message", () => {
    assert.equal(formatPlainLogLine("(node) ExperimentalWarning: SQLite is an experimental feature"), "(node) ExperimentalWarning: SQLite is an experimental feature");
    assert.equal(formatPlainLogLine("   "), undefined);
    assert.equal(formatPlainLogLine("[1,2]"), "[1,2]");
    assert.equal(formatPlainLogLine(json({ level: 40, quarantined: 3 })), '[warn] {"quarantined":3}');
  });

  it("names every pino level", () => {
    assert.deepEqual([10, 20, 30, 40, 50, 60, 70, 5].map(levelLabel), ["trace", "debug", "info", "warn", "error", "fatal", "fatal", "trace"]);
  });
});

describe("createPlainLogPrinter", () => {
  it("prints kept lines one at a time, joining a line split across chunks", () => {
    const out = [];
    const printer = createPlainLogPrinter((text) => out.push(text));
    const warning = json({ level: 40, msg: "first" });
    const info = json({ level: 30, msg: "quiet" });
    const second = json({ level: 50, msg: "second" });
    printer.write(`${warning}\n${info}\n${second.slice(0, 10)}`);
    assert.deepEqual(out, ["[warn] first\n"]);
    printer.write(`${second.slice(10)}\n`);
    assert.deepEqual(out, ["[warn] first\n", "[error] second\n"]);
  });

  it("passes verbose through", () => {
    const out = [];
    const printer = createPlainLogPrinter((text) => out.push(text), { verbose: true });
    printer.write(`${json({ level: 30, msg: "shown" })}\n`);
    assert.deepEqual(out, ["[info] shown\n"]);
  });
});
