// Plain mode's log output (bin/loam.js --plain). The server logs one JSON object per line (pino), each with
// the hostname, pid, time and level: fine for a log shipper, noise next to the join QR and the addresses in a
// terminal. Kept separate so it's testable (cli/test/plain-log.test.mjs).

const LEVELS = [
  [60, "fatal"],
  [50, "error"],
  [40, "warn"],
  [30, "info"],
  [20, "debug"],
  [10, "trace"],
];

/** The lowest level printed without --verbose: warnings and worse. */
export const PLAIN_MIN_LEVEL = 40;

/** pino's numeric level as a word ("warn"). */
export function levelLabel(level) {
  const found = LEVELS.find(([threshold]) => level >= threshold);
  return found ? found[1] : "trace";
}

/**
 * `text` as it may reach a terminal: no control characters (a request path, a client's name or an error
 * message can carry one), none of the bidi controls that reorder what is read; tabs become a space.
 */
function sanitize(text) {
  return String(text)
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function str(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * The line to print for one raw log line, or undefined to print nothing. Without `verbose`, only warnings
 * and errors are printed, as `[warn] message` (`[error] message: detail` when the record carries an error).
 * With it, every line is: a request shows as `[info] GET /api/health from 192.168.8.20 (req-1)` and its
 * completion as `[info] 200 in 3 ms (req-1)`. The hostname, pid and time are dropped: the print-out is read
 * by the person at this computer, now. A line that isn't JSON (not from the logger) is printed as it is.
 */
export function formatPlainLogLine(raw, { verbose = false } = {}) {
  const line = String(raw).trim();
  if (!line) {
    return undefined;
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    record = undefined;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return sanitize(line);
  }
  const level = typeof record.level === "number" ? record.level : 30;
  if (level < PLAIN_MIN_LEVEL && !verbose) {
    return undefined;
  }
  const label = levelLabel(level);
  const message = str(record.msg) ?? "";
  const reqId = str(record.reqId);
  const tag = reqId ? ` (${reqId})` : "";
  const req = record.req && typeof record.req === "object" ? record.req : undefined;
  const res = record.res && typeof record.res === "object" ? record.res : undefined;
  if (req && message === "incoming request") {
    const from = str(req.remoteAddress) ? ` from ${req.remoteAddress}` : "";
    return sanitize(`[${label}] ${str(req.method) ?? "?"} ${str(req.url) ?? "?"}${from}${tag}`);
  }
  if (res && message === "request completed") {
    const status = typeof res.statusCode === "number" ? res.statusCode : "?";
    const ms = typeof record.responseTime === "number" ? ` in ${Math.round(record.responseTime)} ms` : "";
    return sanitize(`[${label}] ${status}${ms}${tag}`);
  }
  const err = record.err && typeof record.err === "object" ? record.err : undefined;
  const detail = err ? str(err.message) : undefined;
  let text = detail && detail !== message ? (message ? `${message}: ${detail}` : detail) : message;
  if (!text) {
    // A record with fields but no message: show the fields, minus the ones about this process.
    const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...rest } = record;
    text = JSON.stringify(rest);
  }
  return sanitize(`[${label}] ${text}${tag}`);
}

/**
 * A log stream for the server (`write(chunk)`) that prints what {@link formatPlainLogLine} keeps through
 * `print`, one line at a time. A chunk may hold several lines or end mid-line; a partial line waits for the
 * rest.
 */
export function createPlainLogPrinter(print, options = {}) {
  let partial = "";
  return {
    write(chunk) {
      const lines = (partial + String(chunk)).split("\n");
      partial = lines.pop() ?? "";
      for (const raw of lines) {
        const shown = formatPlainLogLine(raw, options);
        if (shown !== undefined) {
          print(`${shown}\n`);
        }
      }
    },
  };
}
