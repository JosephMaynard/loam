/**
 * Activity: the server's requests and messages as they happen, newest at the bottom. Pause it (space) to
 * read a line without it moving; End goes back to the newest.
 */
import { type Color, type Line, padEnd, text } from "../ansi.js";
import { isChar } from "../keys.js";
import type { LogEntry } from "../log.js";
import { wrap } from "../modal.js";
import type { Screen, View } from "../types.js";

/** `HH:MM:SS` in local time. */
export function clock(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function statusColor(status: number): Color {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  return "green";
}

/** A request that failed, or a warning or error. */
export function isProblem(entry: LogEntry): boolean {
  return entry.kind === "request" ? entry.status >= 400 : entry.level === "warn" || entry.level === "error";
}

/** One entry as a line. */
export function entryLine(entry: LogEntry, width: number): Line {
  if (entry.kind === "request") {
    const ms = entry.ms < 10 ? entry.ms.toFixed(1) : String(Math.round(entry.ms));
    return [
      { text: `${clock(entry.time)}  `, style: { dim: true } },
      { text: padEnd(entry.method, 7) },
      { text: padEnd(String(entry.status), 5), style: { fg: statusColor(entry.status) } },
      { text: padEnd(`${ms}ms`, 9), style: { dim: true } },
      { text: padEnd(entry.remote ?? "", 17), style: { dim: true } },
      { text: entry.url },
    ];
  }
  const levelStyle: Record<string, { label: string; fg?: Color }> = {
    error: { label: "ERROR", fg: "red" },
    warn: { label: "WARN", fg: "yellow" },
    info: { label: "INFO" },
    debug: { label: "DEBUG" },
  };
  const level = levelStyle[entry.level] ?? { label: entry.level.toUpperCase() };
  return [
    { text: `${clock(entry.time)}  `, style: { dim: true } },
    { text: padEnd(level.label, 7), style: { fg: level.fg, bold: entry.level === "error" } },
    { text: entry.text.slice(0, Math.max(0, width * 4)) },
  ];
}

/** The entries the screen shows, oldest first. */
function shown(view: View): readonly LogEntry[] {
  const all = view.state.activity.frozen ?? view.options.log.entries();
  return view.state.activity.errorsOnly ? all.filter(isProblem) : all;
}

export const activityScreen: Screen = {
  id: "activity",
  title: "Activity",
  hints: (view) =>
    [
      `e ${view.state.activity.errorsOnly ? "show everything" : "problems only"}`,
      `space ${view.state.activity.frozen ? "resume" : "pause"}`,
      "↑↓ scroll",
      "c clear",
      "? help",
    ].join(" · "),
  render(view, width, height) {
    const { activity } = view.state;
    const lines: Line[] = [];
    if (view.status.transportEncryption !== "off") {
      for (const line of wrap(
        "Joined devices send most of what they do inside one encrypted request (POST /api/transport/tunnel), so it isn't listed by path. That is on purpose.",
        width - 2,
      )) {
        lines.push(text(` ${line}`, { dim: true }));
      }
    }
    const flags = [activity.errorsOnly ? "problems only" : "", activity.frozen ? "paused" : ""].filter(Boolean);
    lines.push([
      { text: ` ${padEnd("TIME", 10)}${padEnd("METHOD", 7)}${padEnd("CODE", 5)}${padEnd("TOOK", 9)}${padEnd("DEVICE", 17)}PATH`, style: { dim: true } },
      { text: flags.length ? `   (${flags.join(", ")})` : "", style: { fg: "yellow" } },
    ]);

    const entries = shown(view);
    const room = Math.max(1, height - lines.length);
    if (!entries.length) {
      lines.push(
        text(
          activity.errorsOnly ? " No problems so far." : " Nothing yet. Requests show up here as people use the network.",
          { dim: true },
        ),
      );
      return lines;
    }
    activity.scroll = Math.max(0, Math.min(activity.scroll, entries.length - room));
    const end = entries.length - activity.scroll;
    for (const entry of entries.slice(Math.max(0, end - room), end)) {
      lines.push([{ text: " " }, ...entryLine(entry, width)]);
    }
    return lines;
  },
  key(view, key) {
    const { activity } = view.state;
    const page = 10;
    if (isChar(key, "e")) {
      activity.errorsOnly = !activity.errorsOnly;
      activity.scroll = 0;
    } else if (isChar(key, " ")) {
      activity.frozen = activity.frozen ? undefined : [...view.options.log.entries()];
      activity.scroll = 0;
    } else if (isChar(key, "c")) {
      view.options.log.clear();
      activity.frozen = undefined;
      activity.scroll = 0;
    } else if (key.name === "up") {
      activity.scroll += 1;
    } else if (key.name === "down") {
      activity.scroll = Math.max(0, activity.scroll - 1);
    } else if (key.name === "pageup") {
      activity.scroll += page;
    } else if (key.name === "pagedown") {
      activity.scroll = Math.max(0, activity.scroll - page);
    } else if (key.name === "end") {
      activity.scroll = 0;
    } else if (key.name === "home") {
      activity.scroll = Number.MAX_SAFE_INTEGER;
    } else {
      return false;
    }
    return true;
  },
};
