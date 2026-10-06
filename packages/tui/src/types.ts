import type { HostApi, HostStatus } from "@loam/schema";

import type { Line } from "./ansi.js";
import type { Key } from "./keys.js";
import type { LogBook, LogEntry } from "./log.js";
import type { Modal } from "./modal.js";
import type { CliSettings } from "./settings.js";
import type { System } from "./system.js";
import type { Terminal } from "./terminal.js";

/** Facts about the launch that the server doesn't know, for the Debug screen. */
export type LaunchInfo = {
  dataDir: string;
  nodeVersion: string;
  platform: string;
  /** "node:sqlite", or "SQLCipher" for an encrypted database. */
  databaseDriver: string;
};

export type TuiOptions = {
  host: HostApi;
  log: LogBook;
  terminal: Terminal;
  system: System;
  launch: LaunchInfo;
  /** The saved startup settings (cli.json), and how to save new ones. */
  settings: CliSettings;
  saveSettings(next: CliSettings): void;
  /** Write a file (the diagnostics report); a parameter so tests write nowhere. */
  writeFile(path: string, contents: string): void;
  /** Start locked in kiosk mode (`--kiosk`, or "start locked" saved in cli.json). */
  startLocked?: boolean;
  /** Stop the node and exit. */
  quit(): void | Promise<void>;
  now?: () => number;
};

export type ScreenId = "join" | "activity" | "people" | "settings" | "debug";

/** Per-screen UI state that survives switching screens. */
export type ScreenState = {
  qrHidden: boolean;
  /** `frozen` holds what was on screen when the list was paused. `scroll` counts rows up from the newest. */
  activity: { errorsOnly: boolean; frozen?: readonly LogEntry[]; scroll: number };
  people: { selected: number };
  settings: { selected: number };
};

/** What a screen sees and can do. */
export type View = {
  options: TuiOptions;
  status: HostStatus;
  state: ScreenState;
  settings: CliSettings;
  now(): number;
  open(modal: Modal): void;
  toast(message: string, tone?: "ok" | "error"): void;
  redraw(): void;
  /** `http://<join address>:<port>`. */
  joinUrl(): string;
  /** What the join QR encodes: the join URL with the node key, and the invite on an approval-only node. */
  joinLink(): string;
  /** `http://localhost:<port>`. */
  localUrl(): string;
  /** Save the startup settings; false (and an error shown) when they couldn't be written. */
  saveSettings(next: CliSettings): boolean;
  lockKiosk(): void;
};

export type Screen = {
  id: ScreenId;
  title: string;
  /** The key hints shown on the bottom row. */
  hints(view: View): string;
  render(view: View, width: number, height: number): Line[];
  /** Handle a key; return false to let the global keys (screens, help, quit) have it. */
  key(view: View, key: Key): boolean;
};
