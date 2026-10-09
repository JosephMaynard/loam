// Tests for the `loam` launcher's argument parsing (cli/bin/args.js). Run with `node --test` (root
// `pnpm test`). Pure, so nothing is started.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { OPTIONS, knownOptions, parseArgs } from "../bin/args.js";

const none = { kiosk: false, plain: false, verbose: false, help: false };

describe("parseArgs", () => {
  it("reads nothing as the defaults", () => {
    assert.deepEqual(parseArgs([]), { flags: none });
  });

  it("takes a value as the next argument or after an equals sign", () => {
    assert.deepEqual(parseArgs(["--port", "4000"]).flags, { ...none, port: "4000" });
    assert.deepEqual(parseArgs(["--port=4000"]).flags, { ...none, port: "4000" });
    assert.deepEqual(parseArgs(["--data-dir", "/tmp/loam"]).flags, { ...none, dataDir: "/tmp/loam" });
    assert.deepEqual(parseArgs(["--data-dir=/tmp/with=equals"]).flags, { ...none, dataDir: "/tmp/with=equals" });
    assert.deepEqual(parseArgs(["--port=4000", "--data-dir", "/tmp/loam", "--plain"]).flags, {
      ...none,
      port: "4000",
      dataDir: "/tmp/loam",
      plain: true,
    });
  });

  it("reads the switches, and -h for --help", () => {
    assert.deepEqual(parseArgs(["--kiosk", "--plain", "--verbose", "--help"]).flags, { kiosk: true, plain: true, verbose: true, help: true });
    assert.deepEqual(parseArgs(["-h"]).flags, { ...none, help: true });
    assert.deepEqual(parseArgs(["--plain", "--plain"]).flags, { ...none, plain: true });
  });

  it("lets --encrypt stand alone, take a value, or take it after an equals sign", () => {
    assert.deepEqual(parseArgs(["--encrypt"]).flags, { ...none, encrypt: true });
    assert.deepEqual(parseArgs(["--encrypt", "--plain"]).flags, { ...none, encrypt: true, plain: true });
    assert.deepEqual(parseArgs(["--encrypt", "ephemeral"]).flags, { ...none, encrypt: "ephemeral" });
    assert.deepEqual(parseArgs(["--encrypt=ephemeral"]).flags, { ...none, encrypt: "ephemeral" });
    assert.deepEqual(parseArgs(["--encrypt", "hunter2", "--port", "4000"]).flags, { ...none, encrypt: "hunter2", port: "4000" });
  });

  it("refuses an option it doesn't know, naming the known ones", () => {
    const { error } = parseArgs(["--prot", "4000"]);
    assert.match(error, /^Unknown option "--prot"\. Known options: --port, --data-dir, --encrypt, --kiosk, --plain, --verbose, --help \(-h\)\./);
    assert.match(parseArgs(["--port=4000", "--encrpyt"]).error, /Unknown option "--encrpyt"/);
    assert.match(parseArgs(["-x"]).error, /Unknown option "-x"/);
    assert.match(parseArgs(["--Port", "4000"]).error, /Unknown option "--Port"/);
  });

  it("refuses a stray argument", () => {
    assert.match(parseArgs(["4000"]).error, /^Unexpected argument "4000"/);
    assert.match(parseArgs(["--port", "4000", "extra"]).error, /^Unexpected argument "extra"/);
    assert.match(parseArgs(["-"]).error, /^Unexpected argument "-"/);
    assert.match(parseArgs(["--encrypt", ""]).error, /^Unexpected argument ""/);
  });

  it("refuses a missing or empty value, and never reads an option as one", () => {
    assert.match(parseArgs(["--port"]).error, /^--port requires a value/);
    assert.match(parseArgs(["--data-dir", "--plain"]).error, /^--data-dir requires a value/);
    assert.match(parseArgs(["--data-dir", "-bad"]).error, /^--data-dir requires a value/);
    assert.match(parseArgs(["--port="]).error, /^--port= needs a value/);
    assert.match(parseArgs(["--encrypt="]).error, /^--encrypt= needs a value/);
    assert.match(parseArgs(["--plain=yes"]).error, /^--plain takes no value/);
    assert.match(parseArgs(["-h=1"]).error, /^--help takes no value/);
  });

  it("refuses a valued option given twice", () => {
    assert.match(parseArgs(["--port", "4000", "--port=4001"]).error, /^--port was given more than once/);
    assert.match(parseArgs(["--encrypt", "--encrypt"]).error, /^--encrypt was given more than once/);
  });
});

describe("the help text", () => {
  it("documents every option the parser knows, in loam.js and the README", () => {
    const help = readFileSync(new URL("../bin/loam.js", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const option of OPTIONS) {
      const listed = new RegExp(`^\\s+(-h, )?${option.name}( |$)`, "m");
      assert.match(help, listed, `${option.name} is missing from loam --help`);
      assert.match(readme, listed, `${option.name} is missing from the README`);
    }
    assert.equal(knownOptions(), "--port, --data-dir, --encrypt, --kiosk, --plain, --verbose, --help (-h)");
  });
});
