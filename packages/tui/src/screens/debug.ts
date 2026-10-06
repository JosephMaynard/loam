/**
 * Debug: what this node is running on and how it is set up, recent problems, a switch for detailed logging,
 * and a diagnostics file to attach to a bug report. The file leaves out names, messages, keys and network
 * addresses.
 */
import { join } from "node:path";

import { type Line, padEnd, text } from "../ansi.js";
import { isChar } from "../keys.js";
import type { LogEntry } from "../log.js";
import type { Screen, View } from "../types.js";
import { clock, isProblem } from "./activity.js";

const ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;

/** `text` with IPv4 and IPv6 addresses replaced. */
export function withoutAddresses(value: string): string {
  return value.replace(ADDRESS, "<address>");
}

function facts(view: View): [string, string][] {
  const { status, options } = view;
  const { launch } = options;
  return [
    ["LOAM", status.version],
    ["Node.js", launch.nodeVersion],
    ["System", launch.platform],
    ["Data folder", launch.dataDir],
    ["Database", `${launch.databaseDriver}, ${status.dbEncryption === "off" ? "not encrypted" : `encrypted (${status.dbEncryption})`}`],
    ["Connections", status.transportEncryption === "off" ? "NOT encrypted (Developer Mode)" : `encrypted (${status.transportEncryption})`],
    ["Security profile", status.securityProfile],
    ["Who can join", status.joinPolicy],
    ["People", `${status.people.total} (${status.people.online} online, ${status.people.pending} waiting, ${status.people.admins} admins)`],
    ["Devices connected", String(status.clients.length)],
    ["Rows set aside", status.quarantined ? `${status.quarantined} (no longer valid; see the startup warning)` : "none"],
    ["Detailed logging", status.logLevel === "debug" ? "on" : "off"],
  ];
}

function recentProblems(view: View, count: number): LogEntry[] {
  return view.options.log.entries().filter(isProblem).slice(-count);
}

function problemText(entry: LogEntry): string {
  return entry.kind === "request" ? `${entry.method} ${entry.url} answered ${entry.status}` : entry.text;
}

/** The diagnostics report: no names, messages, keys or addresses. */
export function diagnostics(view: View): string {
  const lines = ["LOAM diagnostics", `Written ${new Date(view.now()).toISOString()}`, ""];
  for (const [label, value] of facts(view)) {
    if (label === "Data folder") {
      continue;
    }
    lines.push(`${label}: ${value}`);
  }
  lines.push("", "Recent problems:");
  const problems = recentProblems(view, 50);
  if (!problems.length) {
    lines.push("  none");
  }
  for (const entry of problems) {
    lines.push(`  ${new Date(entry.time).toISOString()} ${withoutAddresses(problemText(entry))}`);
  }
  return `${lines.join("\n")}\n`;
}

export const debugScreen: Screen = {
  id: "debug",
  title: "Debug",
  hints: (view) => `l detailed logging ${view.status.logLevel === "debug" ? "off" : "on"} · w write diagnostics file · ? help`,
  render(view, _width, height) {
    const lines: Line[] = [];
    for (const [label, value] of facts(view)) {
      lines.push([
        { text: ` ${padEnd(label, 20)}`, style: { dim: true } },
        { text: value, style: label === "Connections" && view.status.devMode ? { fg: "red", bold: true } : undefined },
      ]);
    }
    if (view.status.clients.length) {
      lines.push([{ text: ` ${padEnd("Device addresses", 20)}`, style: { dim: true } }, { text: view.status.clients.join(", ") }]);
    }
    lines.push([], text(" Recent problems", { bold: true }));
    const room = Math.max(1, height - lines.length);
    const problems = recentProblems(view, room);
    if (!problems.length) {
      lines.push(text(" None.", { dim: true }));
    }
    for (const entry of problems) {
      lines.push([
        { text: ` ${clock(entry.time)}  `, style: { dim: true } },
        { text: problemText(entry), style: { fg: entry.kind === "message" && entry.level === "error" ? "red" : "yellow" } },
      ]);
    }
    return lines.slice(0, Math.max(height, 0));
  },
  key(view, key) {
    if (isChar(key, "l")) {
      const next = view.status.logLevel === "debug" ? "info" : "debug";
      view.options.host.setLogLevel(next);
      view.toast(next === "debug" ? "Detailed logging on" : "Detailed logging off");
      return true;
    }
    if (isChar(key, "w")) {
      const stamp = new Date(view.now()).toISOString().replace(/[:.]/g, "-");
      const path = join(view.options.launch.dataDir, `loam-diagnostics-${stamp}.txt`);
      try {
        view.options.writeFile(path, diagnostics(view));
        view.toast(`Written to ${path}`);
      } catch (error) {
        view.toast(`Couldn't write the file: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return true;
    }
    return false;
  },
};
