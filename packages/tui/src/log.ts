/**
 * The server's log, kept for the Activity and Debug screens. Pino writes one JSON object per line; a request
 * appears twice ("incoming request", then "request completed" with the status and time, linked by `reqId`),
 * and the pair becomes one entry. Everything else (warnings, errors, the odd plain line) is a message entry.
 *
 * Held in memory only, capped, and never written anywhere: it is for the operator to watch, not a record.
 * Request URLs arrive without their query strings (the server strips them), and requests inside the
 * encrypted tunnel are not logged at all, so most of what a joined device does shows as one
 * `POST /api/transport/tunnel`. That is deliberate (docs/08).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type RequestEntry = {
  kind: "request";
  time: number;
  method: string;
  url: string;
  status: number;
  ms: number;
  remote?: string;
};

export type MessageEntry = {
  kind: "message";
  time: number;
  level: LogLevel;
  text: string;
};

export type LogEntry = RequestEntry | MessageEntry;

/** Entries kept; older ones fall off. */
export const LOG_CAPACITY = 1_000;
/** Requests waiting for their "completed" line; a crash mid-request must not grow this forever. */
const MAX_OPEN_REQUESTS = 200;

function levelOf(value: unknown): LogLevel {
  if (typeof value !== "number") {
    return "info";
  }
  if (value >= 50) return "error";
  if (value >= 40) return "warn";
  if (value >= 30) return "info";
  return "debug";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export type LogBook = {
  /** Feed raw log output (one or more lines, possibly a partial last line). */
  write(chunk: string): void;
  /** Add a message that didn't come through the server's logger (a warning, a console line). */
  note(level: LogLevel, text: string): void;
  entries(): readonly LogEntry[];
  /** Bumped on every change, so a screen can tell whether to redraw. */
  version(): number;
  clear(): void;
};

export function createLogBook(now: () => number = Date.now, capacity = LOG_CAPACITY): LogBook {
  let entries: LogEntry[] = [];
  let partial = "";
  let changes = 0;
  const open = new Map<string, { method: string; url: string; remote?: string }>();

  function push(entry: LogEntry): void {
    entries.push(entry);
    if (entries.length > capacity) {
      entries = entries.slice(entries.length - capacity);
    }
    changes += 1;
  }

  function line(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a record");
      }
      record = parsed as Record<string, unknown>;
    } catch {
      push({ kind: "message", time: now(), level: "info", text: trimmed });
      return;
    }

    const time = typeof record.time === "number" ? record.time : now();
    const reqId = str(record.reqId);
    const req = record.req as Record<string, unknown> | undefined;
    const res = record.res as Record<string, unknown> | undefined;

    if (reqId && req && record.msg === "incoming request") {
      if (open.size >= MAX_OPEN_REQUESTS) {
        open.delete(open.keys().next().value!);
      }
      open.set(reqId, { method: str(req.method) ?? "?", url: str(req.url) ?? "?", remote: str(req.remoteAddress) });
      return;
    }

    if (reqId && res && record.msg === "request completed") {
      const started = open.get(reqId);
      open.delete(reqId);
      push({
        kind: "request",
        time,
        method: started?.method ?? "?",
        url: started?.url ?? "?",
        status: typeof res.statusCode === "number" ? res.statusCode : 0,
        ms: typeof record.responseTime === "number" ? record.responseTime : 0,
        remote: started?.remote,
      });
      return;
    }

    const err = record.err as Record<string, unknown> | undefined;
    const message = str(record.msg) ?? "";
    const detail = err ? str(err.message) : undefined;
    push({
      kind: "message",
      time,
      level: levelOf(record.level),
      text: detail && detail !== message ? (message ? `${message}: ${detail}` : detail) : message || trimmed,
    });
  }

  return {
    write(chunk) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const raw of lines) {
        line(raw);
      }
    },
    note(level, text) {
      push({ kind: "message", time: now(), level, text });
    },
    entries: () => entries,
    version: () => changes,
    clear() {
      entries = [];
      open.clear();
      changes += 1;
    },
  };
}
