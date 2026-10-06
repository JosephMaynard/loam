import { describe, expect, it } from "vitest";

import { createLogBook } from "./log.js";

const incoming = (id: string, url: string) =>
  JSON.stringify({ level: 30, time: 1, reqId: id, req: { method: "GET", url, remoteAddress: "192.168.1.20" }, msg: "incoming request" });
const completed = (id: string, status: number) =>
  JSON.stringify({ level: 30, time: 2, reqId: id, res: { statusCode: status }, responseTime: 3.5, msg: "request completed" });

describe("createLogBook", () => {
  it("joins a request's two lines into one entry, across chunk boundaries", () => {
    const log = createLogBook(() => 0);
    const text = `${incoming("req-1", "/api/config")}\n${completed("req-1", 200)}\n`;
    log.write(text.slice(0, 40));
    expect(log.entries()).toEqual([]);
    log.write(text.slice(40));
    expect(log.entries()).toEqual([
      { kind: "request", time: 2, method: "GET", url: "/api/config", status: 200, ms: 3.5, remote: "192.168.1.20" },
    ]);
  });

  it("keeps messages with their level, and an error's detail", () => {
    const log = createLogBook(() => 5);
    log.write(`${JSON.stringify({ level: 40, time: 7, msg: "Slow peer" })}\n`);
    log.write(`${JSON.stringify({ level: 50, time: 8, msg: "Sync failed", err: { message: "ECONNREFUSED" } })}\n`);
    log.write("not json\n");
    log.note("warn", "From a warning");
    expect(log.entries()).toEqual([
      { kind: "message", time: 7, level: "warn", text: "Slow peer" },
      { kind: "message", time: 8, level: "error", text: "Sync failed: ECONNREFUSED" },
      { kind: "message", time: 5, level: "info", text: "not json" },
      { kind: "message", time: 5, level: "warn", text: "From a warning" },
    ]);
  });

  it("keeps only the newest entries and counts changes", () => {
    const log = createLogBook(() => 0, 3);
    for (let index = 0; index < 5; index += 1) {
      log.note("info", `n${index}`);
    }
    expect(log.entries().map((entry) => (entry.kind === "message" ? entry.text : ""))).toEqual(["n2", "n3", "n4"]);
    expect(log.version()).toBe(5);
    log.clear();
    expect(log.entries()).toEqual([]);
    expect(log.version()).toBe(6);
  });
});
