import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { openCommand, type OpenerProcess, openUrlWith, type SpawnOpener } from "./system.js";

const url = "http://localhost:3000/#k=key&a=code";

describe("openCommand", () => {
  it("uses the platform's opener", () => {
    expect(openCommand("darwin", {})?.command).toBe("open");
    expect(openCommand("darwin", {})?.args(url)).toEqual([url]);
    expect(openCommand("darwin", {})?.verbatim).toBeUndefined();
    expect(openCommand("linux", { DISPLAY: ":0" })?.command).toBe("xdg-open");
    expect(openCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })?.command).toBe("xdg-open");
  });

  it("hands cmd its arguments verbatim on Windows, with the fragment's & escaped", () => {
    const windows = openCommand("win32", {});
    expect(windows?.command).toBe("cmd");
    expect(windows?.args(url)).toEqual(["/c", "start", '""', "http://localhost:3000/#k=key^&a=code"]);
    expect(windows?.verbatim).toBe(true);
  });

  it("has nothing to open with on a Linux box without a desktop (over SSH)", () => {
    expect(openCommand("linux", {})).toBeUndefined();
  });
});

/** A stand-in child process the test drives, plus what it was started with. */
function fakeOpener() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() }) as unknown as OpenerProcess & EventEmitter;
  const calls: { command: string; args: string[]; options: Parameters<SpawnOpener>[2] }[] = [];
  const spawn: SpawnOpener = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { child, calls, spawn };
}

describe("openUrlWith", () => {
  it("is true once the opener exits cleanly", async () => {
    const { child, calls, spawn } = fakeOpener();
    const opening = openUrlWith(url, { platform: "darwin", env: {}, spawn });
    expect(calls).toEqual([{ command: "open", args: [url], options: { stdio: "ignore", detached: true, windowsVerbatimArguments: false } }]);
    child.emit("spawn");
    expect(child.unref).toHaveBeenCalled();
    child.emit("exit", 0, null);
    await expect(opening).resolves.toBe(true);
  });

  it("is false when the opener exits with an error, or can't be started", async () => {
    const failing = fakeOpener();
    const opening = openUrlWith(url, { platform: "linux", env: { DISPLAY: ":0" }, spawn: failing.spawn });
    failing.child.emit("spawn");
    failing.child.emit("exit", 3, null);
    await expect(opening).resolves.toBe(false);

    const missing = fakeOpener();
    const absent = openUrlWith(url, { platform: "darwin", env: {}, spawn: missing.spawn });
    missing.child.emit("error", new Error("ENOENT"));
    await expect(absent).resolves.toBe(false);

    const throwing: SpawnOpener = () => {
      throw new Error("EACCES");
    };
    await expect(openUrlWith(url, { platform: "darwin", env: {}, spawn: throwing })).resolves.toBe(false);
  });

  it("takes an opener still running after the timeout to be the browser itself", async () => {
    const { child, spawn } = fakeOpener();
    const opening = openUrlWith(url, { platform: "linux", env: { DISPLAY: ":0" }, spawn, timeoutMs: 5 });
    child.emit("spawn");
    await expect(opening).resolves.toBe(true);
    // A late error changes nothing.
    child.emit("exit", 1, null);
    await expect(opening).resolves.toBe(true);
  });

  it("passes the arguments verbatim on Windows and is false without a desktop", async () => {
    const { child, calls, spawn } = fakeOpener();
    const opening = openUrlWith(url, { platform: "win32", env: {}, spawn });
    expect(calls[0]?.command).toBe("cmd");
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(true);
    child.emit("exit", 0, null);
    await expect(opening).resolves.toBe(true);
    await expect(openUrlWith(url, { platform: "linux", env: {}, spawn })).resolves.toBe(false);
  });
});
