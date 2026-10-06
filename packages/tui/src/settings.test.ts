import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cliSettingsPath, parseCliSettings, readCliSettings, writeCliSettings } from "./settings.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loam-tui-settings-"));
  dirs.push(dir);
  return dir;
}

describe("cli.json", () => {
  it("keeps only well-formed fields", () => {
    expect(
      parseCliSettings({
        port: 70000,
        joinHost: "bad host;rm",
        kiosk: { passwordHash: "plain", startLocked: true },
        extra: 1,
      }),
    ).toEqual({});
    expect(
      parseCliSettings({ port: 3005, joinHost: "192.168.1.5", kiosk: { passwordHash: "scrypt:a:b", startLocked: "yes" } }),
    ).toEqual({ port: 3005, joinHost: "192.168.1.5", kiosk: { passwordHash: "scrypt:a:b", startLocked: false } });
    expect(parseCliSettings([])).toEqual({});
  });

  it("round-trips through the file, readable only by its owner", () => {
    const dir = tempDir();
    expect(readCliSettings(dir)).toEqual({});
    writeCliSettings(dir, { port: 3001, kiosk: { passwordHash: "scrypt:a:b", startLocked: true } });
    expect(readCliSettings(dir)).toEqual({ port: 3001, kiosk: { passwordHash: "scrypt:a:b", startLocked: true } });
    if (process.platform !== "win32") {
      expect(statSync(cliSettingsPath(dir)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(cliSettingsPath(dir), "utf8").endsWith("\n")).toBe(true);
  });

  it("treats an unreadable file as no settings", () => {
    const dir = tempDir();
    writeFileSync(cliSettingsPath(dir), "{broken");
    expect(readCliSettings(dir)).toEqual({});
  });
});
