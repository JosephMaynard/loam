// Tests for the `loam` passphrase prompt's line buffer (cli/bin/line-buffer.js). Run with `node --test`
// (root `pnpm test`). Not shipped: package.json `files` lists only dist, bin and client.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLineBuffer } from "../bin/line-buffer.js";

/** Push chunks, then drain every completed line. */
function lines(...chunks) {
  const buffer = createLineBuffer();
  for (const chunk of chunks) {
    buffer.push(chunk);
  }
  const out = [];
  for (let line = buffer.next(); line !== undefined; line = buffer.next()) {
    out.push(line);
  }
  return out;
}

describe("createLineBuffer", () => {
  it("keeps every line of a pasted multi-line chunk (passphrase + confirmation)", () => {
    assert.deepEqual(lines("pass\npass\n"), ["pass", "pass"]);
    assert.deepEqual(lines("pass\rpass\r"), ["pass", "pass"]);
  });

  it("treats \\r\\n as one line break, even split across chunks", () => {
    assert.deepEqual(lines("a\r\nb\r\n"), ["a", "b"]);
    assert.deepEqual(lines("a\r", "\nb\r"), ["a", "b"]);
  });

  it("keeps an empty line (an empty answer is meaningful to the prompt)", () => {
    assert.deepEqual(lines("\r"), [""]);
    assert.deepEqual(lines("\r\r"), ["", ""]);
  });

  it("assembles a line typed across chunks and holds a partial line back", () => {
    const buffer = createLineBuffer();
    buffer.push("se");
    assert.equal(buffer.next(), undefined);
    buffer.push("cret\rnext");
    assert.equal(buffer.next(), "secret");
    assert.equal(buffer.next(), undefined);
  });

  it("handles backspace, Ctrl-D and ignores other control characters", () => {
    assert.deepEqual(lines("abx\u007fc\u0004"), ["abc"]);
    assert.deepEqual(lines("ab\bc\u0001\r"), ["ac"]);
  });

  it("reports Ctrl-C as an interrupt", () => {
    const buffer = createLineBuffer();
    assert.equal(buffer.push("pa\u0003ss"), "interrupt");
    assert.equal(buffer.push("pass"), undefined);
  });
});
