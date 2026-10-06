/**
 * Startup settings the terminal UI saves for the next `loam` run: `cli.json` in the data folder. Only what
 * a launch needs before the server exists (the port), what the operator chose on screen (the join address,
 * kiosk mode), and nothing secret in the clear: the kiosk password is kept as a scrypt hash. Flags and
 * environment variables still win over it.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type KioskSettings = {
  /** `scrypt:<salt>:<hash>` (kiosk.ts). */
  passwordHash: string;
  /** Start locked: a restart (a reboot, a crash) comes back in kiosk mode. */
  startLocked: boolean;
};

export type CliSettings = {
  port?: number;
  /** A pinned join address; absent means "pick automatically". */
  joinHost?: string;
  kiosk?: KioskSettings;
};

export const CLI_SETTINGS_FILE = "cli.json";

export function cliSettingsPath(dataDir: string): string {
  return join(dataDir, CLI_SETTINGS_FILE);
}

/** Keep only well-formed fields: the file is edited by hand sometimes, and a bad value must not stop a launch. */
export function parseCliSettings(raw: unknown): CliSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const value = raw as Record<string, unknown>;
  const settings: CliSettings = {};
  if (typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535) {
    settings.port = value.port;
  }
  if (typeof value.joinHost === "string" && /^[A-Za-z0-9.:[\]-]{1,253}$/.test(value.joinHost)) {
    settings.joinHost = value.joinHost;
  }
  const kiosk = value.kiosk as Record<string, unknown> | undefined;
  if (kiosk && typeof kiosk.passwordHash === "string" && kiosk.passwordHash.startsWith("scrypt:")) {
    settings.kiosk = { passwordHash: kiosk.passwordHash, startLocked: kiosk.startLocked === true };
  }
  return settings;
}

/** The saved settings, or none when the file is missing or unreadable. */
export function readCliSettings(dataDir: string): CliSettings {
  try {
    return parseCliSettings(JSON.parse(readFileSync(cliSettingsPath(dataDir), "utf8")));
  } catch {
    return {};
  }
}

/** Save the settings: written beside the file and renamed over it, so a crash never leaves half a file. */
export function writeCliSettings(dataDir: string, settings: CliSettings): void {
  const path = cliSettingsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  // A leftover temporary file would keep its old permissions (`mode` only applies to a new file).
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(parseCliSettings(settings), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
