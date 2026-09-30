import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FixedWindowCounter, parseTimeWindow, rateLimitKey, registerRateLimit } from "./rate-limit.js";

describe("rateLimitKey", () => {
  it("keeps IPv4 as-is", () => {
    expect(rateLimitKey("192.168.4.20")).toBe("192.168.4.20");
  });

  it("folds IPv4-mapped IPv6 to IPv4, in either spelling", () => {
    expect(rateLimitKey("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(rateLimitKey("::FFFF:7f00:1")).toBe("127.0.0.1");
  });

  it("groups IPv6 by /64, however it is written", () => {
    const key = rateLimitKey("2001:db8:85a3::8a2e:370:7334");
    expect(rateLimitKey("2001:DB8:85A3:0:0:8A2E:370:7334")).toBe(key);
    expect(rateLimitKey("2001:db8:85a3:0:ffff:ffff:ffff:ffff")).toBe(key);
    expect(rateLimitKey("2001:db8:85a3:1::1")).not.toBe(key);
  });

  it("strips an IPv6 zone id", () => {
    expect(rateLimitKey("fe80::1%en0")).toBe(rateLimitKey("fe80::2"));
  });

  it("handles a dotted IPv4 tail on a non-mapped IPv6 address", () => {
    expect(rateLimitKey("64:ff9b::1.2.3.4")).toBe(rateLimitKey("64:ff9b::"));
  });
});

describe("parseTimeWindow", () => {
  it("accepts milliseconds and unit strings", () => {
    expect(parseTimeWindow(1500)).toBe(1500);
    expect(parseTimeWindow("1 minute")).toBe(60_000);
    expect(parseTimeWindow("30 seconds")).toBe(30_000);
    expect(parseTimeWindow("2 hours")).toBe(7_200_000);
  });

  it("rejects anything else rather than guessing", () => {
    expect(() => parseTimeWindow("1 fortnight")).toThrow(/timeWindow/);
    expect(() => parseTimeWindow(0)).toThrow(/timeWindow/);
    expect(() => parseTimeWindow(Number.NaN)).toThrow(/timeWindow/);
  });

  it("rejects values that only become zero after conversion", () => {
    expect(() => parseTimeWindow(0.5)).toThrow(/timeWindow/);
    expect(() => parseTimeWindow("0 seconds")).toThrow(/timeWindow/);
    expect(() => parseTimeWindow(Number.POSITIVE_INFINITY)).toThrow(/timeWindow/);
  });
});

describe("FixedWindowCounter", () => {
  it("counts within a window and starts over when it ends", () => {
    const counter = new FixedWindowCounter();
    expect(counter.hit("a", 1000, 0)).toEqual({ count: 1, ttl: 1000 });
    expect(counter.hit("a", 1000, 400)).toEqual({ count: 2, ttl: 600 });
    expect(counter.hit("b", 1000, 400).count).toBe(1);
    expect(counter.hit("a", 1000, 1000)).toEqual({ count: 1, ttl: 1000 });
  });

  it("evicts the least recently used key past its capacity", () => {
    const counter = new FixedWindowCounter(2);
    counter.hit("a", 1000, 0);
    counter.hit("b", 1000, 0);
    counter.hit("a", 1000, 1); // a is now the most recent
    counter.hit("c", 1000, 2); // evicts b
    expect(counter.size).toBe(2);
    expect(counter.hit("a", 1000, 3).count).toBe(3);
    expect(counter.hit("b", 1000, 3).count).toBe(1);
  });
});

describe("registerRateLimit", () => {
  let server: FastifyInstance;

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  async function build(configure: (server: FastifyInstance) => void): Promise<FastifyInstance> {
    server = Fastify();
    registerRateLimit(server, {
      max: 3,
      timeWindow: "1 minute",
      allowList: (request) => request.headers["x-exempt"] === "1",
    });
    configure(server);
    await server.ready();
    return server;
  }

  async function statuses(url: string, count: number, headers: Record<string, string> = {}, remoteAddress = "10.0.0.1") {
    const codes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      codes.push((await server.inject({ method: "GET", url, headers, remoteAddress })).statusCode);
    }
    return codes;
  }

  it("applies the global budget per IP, shared across routes without their own config", async () => {
    await build((app) => {
      app.get("/a", async () => ({ ok: true }));
      app.get("/b", async () => ({ ok: true }));
    });
    expect(await statuses("/a", 2)).toEqual([200, 200]);
    expect(await statuses("/b", 2)).toEqual([200, 429]);
    expect(await statuses("/a", 1, {}, "10.0.0.2")).toEqual([200]);
  });

  it("answers a refusal with 429, the plugin's message and retry-after, and no x-ratelimit headers", async () => {
    await build((app) => app.get("/a", async () => ({ ok: true })));
    await statuses("/a", 3);
    const refused = await server.inject({ method: "GET", url: "/a", remoteAddress: "10.0.0.1" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ statusCode: 429, message: "Rate limit exceeded, retry in 1 minute" });
    expect(refused.headers["retry-after"]).toBe("60");
    const allowed = await server.inject({ method: "GET", url: "/a", remoteAddress: "10.0.0.9" });
    for (const response of [refused, allowed]) {
      expect(Object.keys(response.headers).filter((name) => name.startsWith("x-ratelimit"))).toEqual([]);
    }
    expect(allowed.headers["retry-after"]).toBeUndefined();
  });

  it("gives a configured route its own budget that replaces the global one", async () => {
    await build((app) => {
      app.get("/tight", { config: { rateLimit: { max: 1 } } }, async () => ({ ok: true }));
      app.get("/other", async () => ({ ok: true }));
    });
    expect(await statuses("/tight", 2)).toEqual([200, 429]);
    // /tight's hits never counted against the global table.
    expect(await statuses("/other", 3)).toEqual([200, 200, 200]);
  });

  it("honours the global allowList, and a route can override it", async () => {
    await build((app) => {
      app.get("/open", async () => ({ ok: true }));
      app.get("/strict", { config: { rateLimit: { max: 1, allowList: () => false } } }, async () => ({ ok: true }));
    });
    expect(await statuses("/open", 5, { "x-exempt": "1" })).toEqual([200, 200, 200, 200, 200]);
    expect(await statuses("/strict", 2, { "x-exempt": "1" })).toEqual([200, 429]);
  });

  it("uses a route's errorResponseBuilder, with no retry-after", async () => {
    await build((app) =>
      app.post(
        "/hidden",
        {
          config: {
            rateLimit: {
              max: 1,
              errorResponseBuilder: () => Object.assign(new Error("Not found"), { statusCode: 404 }),
            },
          },
        },
        async () => ({ ok: true }),
      ),
    );
    await server.inject({ method: "POST", url: "/hidden", remoteAddress: "10.0.0.1" });
    const refused = await server.inject({ method: "POST", url: "/hidden", remoteAddress: "10.0.0.1" });
    expect(refused.statusCode).toBe(404);
    expect(refused.headers["retry-after"]).toBeUndefined();
  });

  it("lets a key back in once its window ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await build((app) => app.get("/a", async () => ({ ok: true })));
    expect(await statuses("/a", 4)).toEqual([200, 200, 200, 429]);
    vi.advanceTimersByTime(60_000);
    expect(await statuses("/a", 1)).toEqual([200]);
  });

  it("counts one IPv6 /64 as one client", async () => {
    await build((app) => app.get("/a", async () => ({ ok: true })));
    const codes: number[] = [];
    for (const host of ["1", "2", "3", "4"]) {
      codes.push((await server.inject({ method: "GET", url: "/a", remoteAddress: `2001:db8:1:2::${host}` })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it("refuses an invalid route config at registration", async () => {
    server = Fastify();
    registerRateLimit(server, { max: 3, timeWindow: "1 minute" });
    expect(() => server.get("/bad", { config: { rateLimit: { timeWindow: "soon" } } }, async () => ({}))).toThrow(
      /timeWindow/,
    );
  });
});
