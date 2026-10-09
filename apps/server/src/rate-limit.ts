// Per-IP fixed-window rate limiting for every HTTP route. Replaces `@fastify/rate-limit` (and its
// `ip-address` / `toad-cache` / `@lukeed/ms` dependencies) with the small subset LOAM uses, keeping the
// route-level contract unchanged: a route opts into its own budget with `config.rateLimit`, and every
// other route gets the global one.
//
// Semantics kept from the plugin:
//   - A route's `config.rateLimit` is merged over the global settings and REPLACES the global limiter
//     for that route (they don't stack); each route with its own config counts in its own table, every
//     other route shares the global table.
//   - Fixed window per key: the first request opens a window of `timeWindow`; request `max + 1` inside it
//     is refused until the window ends. The key is the peer IP, with an IPv4-mapped IPv6 address folded to
//     its IPv4 form and any other IPv6 address grouped by its /64 (one host usually owns a whole /64).
//   - The check runs as a route-level `onRequest` hook, so it sees the request after the global
//     `onRequest` hooks (transport decryption etc.) exactly as before.
//   - Each table holds at most `maxEntries` keys, least recently used evicted first.
//
// Deliberate change: no `x-ratelimit-*` headers. Nothing reads them, and they gave routes away — a
// configured route answers with its own `x-ratelimit-limit` while an unknown path sends none, which let a
// prober tell the "indistinguishable from absent" panic route from a missing one. A refusal built by the
// default builder carries only `retry-after`; a route with its own `errorResponseBuilder` gets no header.
import { isIPv4, isIPv6 } from "node:net";

import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import { RATE_LIMITED_CODE } from "./errors.js";

/** Passed to an `errorResponseBuilder` when a request is refused. */
export interface RateLimitExceeded {
  statusCode: 429;
  max: number;
  /** Milliseconds until the key's window ends. */
  ttl: number;
}

/** Limiter settings: the global ones, or a route's `config.rateLimit` merged over them. */
export interface RateLimitOptions {
  /** Requests allowed per key per window. */
  max: number;
  /** Window length: milliseconds, or "<n> second(s)|minute(s)|hour(s)". */
  timeWindow: number | string;
  /** True exempts the request (it isn't counted). */
  allowList?: (request: FastifyRequest) => boolean;
  /** Builds the error thrown for a refused request (default: a 429 naming the wait). */
  errorResponseBuilder?: (request: FastifyRequest, context: RateLimitExceeded) => Error;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** This route's own rate-limit budget, merged over the global settings (see rate-limit.ts). */
    rateLimit?: Partial<RateLimitOptions>;
  }
}

/** Keys each table keeps before evicting the least recently used (the plugin's default). */
const DEFAULT_MAX_ENTRIES = 5000;

const TIME_UNITS_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000 };

/** Parse a window length; throws on anything else so a typo fails at route registration, not silently. */
export function parseTimeWindow(value: number | string): number {
  let ms = Number.NaN;
  if (typeof value === "number") {
    ms = Math.trunc(value);
  } else {
    const match = /^(\d+)\s*(second|minute|hour)s?$/.exec(value.trim());
    if (match) {
      ms = Number(match[1]) * TIME_UNITS_MS[match[2]!]!;
    }
  }
  // Checked after conversion: 0.5 truncates to 0 and "0 seconds" is 0, and a zero-length window would
  // make every request open a fresh window, i.e. never limit anything.
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new Error(`Invalid rate-limit timeWindow: ${JSON.stringify(value)}`);
  }
  return ms;
}

/** The eight 16-bit groups of an IPv6 address (zone id stripped), or undefined if it doesn't parse. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%")[0]!.toLowerCase();
  // A trailing dotted IPv4 (::ffff:1.2.3.4) supplies the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  let tail: number[] = [];
  if (dotted) {
    const bytes = dotted.slice(1, 5).map(Number);
    tail = [(bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!];
    text = text.slice(0, dotted.index);
    if (text.endsWith(":") && !text.endsWith("::")) {
      text = text.slice(0, -1);
    }
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) {
    return undefined;
  }
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

/**
 * The limiter key for a peer address: IPv4 as-is, an IPv4-mapped IPv6 address as its IPv4 form, any other
 * IPv6 address as its /64 prefix (so one host can't dodge the limit by cycling addresses in its subnet).
 */
export function rateLimitKey(ip: string): string {
  return ipv6SubnetKey(ip) ?? addressKey(ip);
}

/** The groups of an IPv6 address that isn't IPv4-mapped, or undefined for anything else. */
function nativeIPv6Groups(ip: string): number[] | undefined {
  if (isIPv4(ip) || !isIPv6(ip.split("%")[0]!)) {
    return undefined;
  }
  const groups = ipv6Groups(ip);
  if (!groups || (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)) {
    return undefined;
  }
  return groups;
}

/**
 * One peer address as a key: IPv4 as-is, an IPv4-mapped IPv6 address as its IPv4 form, any other IPv6
 * address in one canonical spelling (zone id dropped). For the strict per-attempt limiters, which a whole
 * IPv6 LAN (one SLAAC /64) must not share: see {@link ipv6SubnetKey} for their coarser second bound.
 */
export function addressKey(ip: string): string {
  const native = nativeIPv6Groups(ip);
  if (native) {
    return native.map((group) => group.toString(16)).join(":");
  }
  if (isIPv4(ip) || !isIPv6(ip.split("%")[0]!)) {
    return ip.toLowerCase();
  }
  const groups = ipv6Groups(ip);
  return groups ? [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".") : ip.toLowerCase();
}

/** The /64 prefix of an IPv6 address that isn't IPv4-mapped, or undefined (IPv4 has no wider bucket here). */
export function ipv6SubnetKey(ip: string): string | undefined {
  const native = nativeIPv6Groups(ip);
  return native
    ? `${native
        .slice(0, 4)
        .map((group) => group.toString(16))
        .join(":")}::/64`
    : undefined;
}

/** One fixed-window counter table, LRU-bounded (a Map iterates in insertion order; a hit re-inserts). */
export class FixedWindowCounter {
  private readonly windows = new Map<string, { count: number; startedAt: number }>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  /** Count a request for `key`; returns the count inside the current window and the ms left in it. */
  hit(key: string, windowMs: number, now = Date.now()): { count: number; ttl: number } {
    let entry = this.windows.get(key);
    if (entry) {
      this.windows.delete(key);
    }
    if (!entry || entry.startedAt + windowMs <= now) {
      entry = { count: 0, startedAt: now };
    }
    entry.count += 1;
    this.windows.set(key, entry);
    if (this.windows.size > this.maxEntries) {
      this.windows.delete(this.windows.keys().next().value!);
    }
    return { count: entry.count, ttl: entry.startedAt + windowMs - now };
  }

  get size(): number {
    return this.windows.size;
  }
}

/** "retry in 45 seconds" / "retry in 1 minute", as the plugin worded it. */
function describeWait(ttlMs: number): string {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The default refusal: a 429 naming the wait, with the stable `rate_limited` code the client translates
 *  (the message itself is English and server-built, so a client never shows it). */
function defaultErrorResponse(_request: FastifyRequest, context: RateLimitExceeded): Error {
  const error = new Error(`Rate limit exceeded, retry in ${describeWait(context.ttl)}`) as Error & { statusCode: number; code: string };
  error.statusCode = context.statusCode;
  error.code = RATE_LIMITED_CODE;
  return error;
}

/** The `onRequest` hook enforcing one limiter. */
function limiterHook(options: RateLimitOptions, counter: FixedWindowCounter): onRequestAsyncHookHandler {
  const windowMs = parseTimeWindow(options.timeWindow);
  const { max, allowList, errorResponseBuilder } = options;
  if (!Number.isInteger(max) || max < 0) {
    throw new Error(`Invalid rate-limit max: ${max}`);
  }
  return async (request, reply) => {
    if (allowList?.(request)) {
      return;
    }
    const { count, ttl } = counter.hit(rateLimitKey(request.ip), windowMs);
    if (count <= max) {
      return;
    }
    const context: RateLimitExceeded = { statusCode: 429, max, ttl };
    if (errorResponseBuilder) {
      throw errorResponseBuilder(request, context);
    }
    reply.header("retry-after", Math.ceil(ttl / 1000));
    throw defaultErrorResponse(request, context);
  };
}

/**
 * Rate-limit every route registered after this call: routes with `config.rateLimit` get their own table
 * with those settings merged over `globalOptions`, the rest share one table under `globalOptions`.
 */
export function registerRateLimit(server: FastifyInstance, globalOptions: RateLimitOptions): void {
  const globalHook = limiterHook(globalOptions, new FixedWindowCounter());
  server.addHook("onRoute", (routeOptions) => {
    const routeLimit = routeOptions.config?.rateLimit;
    const hook = routeLimit
      ? limiterHook({ ...globalOptions, ...routeLimit }, new FixedWindowCounter())
      : globalHook;
    const existing = routeOptions.onRequest;
    routeOptions.onRequest = existing === undefined ? [hook] : [...(Array.isArray(existing) ? existing : [existing]), hook];
  });
}
