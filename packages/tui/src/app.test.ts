import type { HostApi, HostStatus, HostUser, LoamConfig, LoamConfigUpdate } from "@loam/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { plain } from "./ansi.js";
import { createTui, type Tui } from "./app.js";
import { hashKioskPassword } from "./kiosk.js";
import { createLogBook } from "./log.js";
import type { CliSettings } from "./settings.js";
import type { System } from "./system.js";
import type { Terminal } from "./terminal.js";

const KEY = "hostkey_0123456789abcdefghijklmnopqrstuvwxy";

/** A host with just enough behind it for the screens. */
function fakeHost(overrides: Partial<{ users: HostUser[]; profile: LoamConfig["security"]["profile"] }> = {}) {
  const config = {
    node: { name: "Field kitchen", locale: "en" },
    security: { profile: overrides.profile ?? "custom", transportEncryption: "optional", dbEncryption: "off" },
    access: { joinPolicy: "open" },
    retention: {},
    killSwitch: { enabled: false, requireConfirmation: true },
    features: { enablePresence: true },
    llm: { ollama: { enabled: false, model: "llama3.2" } },
  } as unknown as LoamConfig;
  const users: HostUser[] = overrides.users ?? [];
  const status: HostStatus = {
    nodeName: "Field kitchen",
    version: "0.6.0",
    joinHost: "192.168.8.159",
    port: 3000,
    transportEncryption: "optional",
    dbEncryption: "off",
    securityProfile: config.security.profile,
    joinPolicy: "open",
    devMode: false,
    clients: ["192.168.8.20"],
    people: { total: users.length, online: 0, pending: 0, admins: users.filter((user) => user.isAdmin).length },
    quarantined: 0,
    logLevel: "info",
  };
  const host = {
    status: vi.fn(() => ({ ...status, nodeName: config.node.name })),
    config: vi.fn(() => config),
    updateConfig: vi.fn((update: LoamConfigUpdate) => {
      if (update.node?.name) {
        config.node.name = update.node.name;
      }
      return { ok: true as const, value: config };
    }),
    users: vi.fn(() => users),
    makeAdmin: vi.fn((id: string) => {
      const user = users.find((entry) => entry.id === id)!;
      user.isAdmin = true;
      return { ok: true as const, value: user };
    }),
    adminClaimCode: vi.fn(() => ({ code: "abcdefghijklmnopqrstuv", expiresAt: 0 })),
    linkCode: vi.fn(() => ({ code: "linkcode12345678", expiresAt: 0 })),
    invite: vi.fn(() => null),
    setJoinHost: vi.fn((value: string | undefined) => {
      status.joinHost = value ?? "192.168.8.159";
    }),
    setLogLevel: vi.fn(),
    transportPublicKey: vi.fn(() => KEY),
    emergencyReset: vi.fn(async () => ({ complete: true })),
  } satisfies HostApi;
  return host;
}

function fakeTerminal(columns = 120, rows = 40): Terminal & { output: string } {
  const terminal = {
    output: "",
    color: true,
    columns: () => columns,
    rows: () => rows,
    write(value: string) {
      terminal.output += value;
    },
    onInput() {},
    onResize() {},
    start() {},
    stop() {},
  };
  return terminal;
}

const tuis: Tui[] = [];
afterEach(() => {
  for (const tui of tuis.splice(0)) {
    tui.stop();
  }
});

function setup(
  options: {
    host?: ReturnType<typeof fakeHost>;
    terminal?: ReturnType<typeof fakeTerminal>;
    settings?: CliSettings;
    startLocked?: boolean;
  } = {},
) {
  const host = options.host ?? fakeHost();
  const terminal = options.terminal ?? fakeTerminal();
  const log = createLogBook(() => 0);
  const system: System = {
    openUrl: vi.fn(async () => true),
    lanAddresses: () => [
      { name: "en0", address: "192.168.8.159" },
      { name: "utun3", address: "10.8.0.2" },
    ],
  };
  const saved: CliSettings[] = [];
  const writes: { path: string; contents: string }[] = [];
  const quit = vi.fn();
  const tui = createTui({
    host,
    log,
    terminal,
    system,
    launch: { dataDir: "/home/ada/.loam", nodeVersion: "v24.15.0", platform: "darwin arm64", databaseDriver: "node:sqlite" },
    settings: options.settings ?? {},
    saveSettings: (next) => saved.push(next),
    writeFile: (path, contents) => writes.push({ path, contents }),
    startLocked: options.startLocked,
    quit,
  });
  tuis.push(tui);
  tui.start();
  const screenText = () => tui.frame().map(plain).join("\n");
  return { tui, host, terminal, log, system, saved, writes, quit, screenText };
}

describe("the Join screen", () => {
  it("keeps the QR on screen beside the join address", () => {
    const { screenText } = setup();
    const screen = screenText();
    expect(screen).toContain("LOAM  Field kitchen");
    expect(screen).toContain("1 device");
    expect(screen).toContain("http://192.168.8.159:3000");
    expect(screen).toContain("http://localhost:3000");
    expect(screen).toMatch(/[█▀▄]{10}/);
    expect(screen).toContain("Nobody is admin yet");
  });

  it("puts the key and the invite in the QR link, and hides it on h", async () => {
    const host = fakeHost();
    host.invite.mockReturnValue({ code: "invitecode_0123456789a", expiresAt: 0 } as never);
    const { tui, screenText } = setup({ host });
    expect(screenText()).toContain("without waiting for approval");
    await tui.input("h");
    expect(screenText()).toContain("The QR code is hidden");
    expect(screenText()).not.toMatch(/[█▀▄]{10}/);
  });

  it("falls back to text in a small window, and asks for a bigger one when it's tiny", () => {
    expect(setup({ terminal: fakeTerminal(60, 20) }).screenText()).toContain("Make this window a little bigger to show the QR code");
    expect(setup({ terminal: fakeTerminal(30, 10) }).screenText()).toBe("Make this window bigger to use LOAM.");
  });

  it("opens the browser as admin with a one-time code, and offers a QR for a phone", async () => {
    const { tui, system, host, screenText } = setup();
    await tui.input("o");
    expect(system.openUrl).toHaveBeenCalledWith(`http://localhost:3000#k=${KEY}&a=abcdefghijklmnopqrstuv`);
    expect(host.adminClaimCode).toHaveBeenCalledTimes(2);
    expect(screenText()).toContain("signed in as admin");
    await tui.input("\x1b");
    expect(tui.modal).toBeUndefined();
  });

  it("pins the join address and remembers it", async () => {
    const { tui, host, saved, screenText } = setup();
    await tui.input("a");
    expect(screenText()).toContain("utun3");
    await tui.input("\x1b[B\x1b[B\r");
    expect(host.setJoinHost).toHaveBeenCalledWith("10.8.0.2");
    expect(saved.at(-1)).toEqual({ joinHost: "10.8.0.2" });
    expect(screenText()).toContain("http://10.8.0.2:3000");
  });
});

describe("moving around", () => {
  it("switches screens by number and Tab, and shows help", async () => {
    const { tui, screenText } = setup();
    await tui.input("2");
    expect(tui.screen).toBe("activity");
    await tui.input("\t");
    expect(tui.screen).toBe("people");
    await tui.input("\x1b[Z\x1b[Z");
    expect(tui.screen).toBe("join");
    await tui.input("?");
    expect(screenText()).toContain("switch screens");
  });

  it("asks before stopping, and stops on yes", async () => {
    const { tui, quit, screenText } = setup();
    await tui.input("q");
    expect(screenText()).toContain("Stop LOAM?");
    expect(screenText()).toContain("1 device is connected");
    await tui.input("n");
    expect(quit).not.toHaveBeenCalled();
    await tui.input("\x03y");
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe("the Activity screen", () => {
  it("lists requests and problems, and filters to problems", async () => {
    const { tui, log, screenText } = setup();
    log.write(
      `${JSON.stringify({ level: 30, time: 1, reqId: "r1", req: { method: "GET", url: "/api/config" }, msg: "incoming request" })}\n` +
        `${JSON.stringify({ level: 30, time: 2, reqId: "r1", res: { statusCode: 200 }, responseTime: 4, msg: "request completed" })}\n` +
        `${JSON.stringify({ level: 50, time: 3, msg: "Sync failed" })}\n`,
    );
    await tui.input("2");
    expect(screenText()).toContain("/api/config");
    expect(screenText()).toContain("Sync failed");
    await tui.input("e");
    expect(screenText()).not.toContain("/api/config");
    expect(screenText()).toContain("Sync failed");
  });
});

describe("the People screen", () => {
  it("makes the chosen person an admin after asking", async () => {
    const users: HostUser[] = [
      { id: "user.a", displayName: "amber.oak.heron", isAdmin: false, online: true, pending: false, banned: false, createdAt: 1 },
      { id: "user.b", displayName: "quiet.iron.fox", isAdmin: false, online: false, pending: true, banned: false, createdAt: 2 },
    ];
    const host = fakeHost({ users });
    const { tui, screenText } = setup({ host });
    await tui.input("3");
    expect(screenText()).toContain("amber.oak.heron");
    await tui.input("\x1b[Bm");
    expect(screenText()).toContain("Make quiet.iron.fox an admin?");
    expect(screenText()).toContain("lets them in too");
    await tui.input("y");
    expect(host.makeAdmin).toHaveBeenCalledWith("user.b");
    expect(screenText()).toContain("quiet.iron.fox is now an admin");
  });

  it("never passes a name's control characters to the terminal", async () => {
    const users: HostUser[] = [
      { id: "user.x", displayName: "evil\x1b]0;owned\x07\x1b[2J", isAdmin: false, online: false, pending: false, banned: false, createdAt: 1 },
    ];
    const { tui, terminal } = setup({ host: fakeHost({ users }) });
    await tui.input("3");
    expect(terminal.output).toContain("evil]0;owned[2J");
    expect(terminal.output).not.toContain("\x1b]0;");
    expect(terminal.output).not.toContain("\x07");
  });
});

describe("the Settings screen", () => {
  it("renames the network through the host", async () => {
    const { tui, host, screenText } = setup();
    await tui.input("4");
    expect(screenText()).toContain("Field kitchen");
    await tui.input("\r");
    expect(screenText()).toContain("Network name");
    await tui.input("\x7f".repeat(20) + "Library\r");
    expect(host.updateConfig).toHaveBeenCalledWith({ node: { name: "Library" } });
    expect(screenText()).toContain("Name saved");
  });

  it("won't change what a named profile sets", async () => {
    const { tui, host, screenText } = setup({ host: fakeHost({ profile: "hardened" }) });
    await tui.input("4\x1b[B\x1b[B");
    expect(screenText()).toContain("set by the Hardened profile");
    await tui.input("\r");
    expect(host.updateConfig).not.toHaveBeenCalled();
    expect(screenText()).toContain("Can't change this");
  });

  it("wipes only after wipe is typed", async () => {
    const { tui, host, screenText } = setup();
    await tui.input("4");
    for (let index = 0; index < 9; index += 1) {
      await tui.input("\x1b[B");
    }
    await tui.input("\r");
    expect(screenText()).toContain("Type wipe to confirm");
    await tui.input("nope\r");
    expect(host.emergencyReset).not.toHaveBeenCalled();
    await tui.input("\x7f\x7f\x7f\x7fwipe\r");
    expect(host.emergencyReset).toHaveBeenCalledTimes(1);
    expect(screenText()).toContain("Emergency Reset done");
  });
});

describe("the Debug screen", () => {
  it("writes a diagnostics file without addresses or names", async () => {
    const { tui, log, writes } = setup();
    log.note("error", "Peer 192.168.8.44 refused the connection");
    await tui.input("5w");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toMatch(/^\/home\/ada\/\.loam\/loam-diagnostics-.+\.txt$/);
    expect(writes[0]!.contents).toContain("Peer <address> refused the connection");
    expect(writes[0]!.contents).not.toContain("192.168");
    expect(writes[0]!.contents).not.toContain("/home/ada");
  });
});

describe("kiosk mode", () => {
  it("sets a password, locks to the join QR, and ignores everything but unlocking", async () => {
    const { tui, saved, quit, screenText } = setup();
    await tui.input("k");
    expect(screenText()).toContain("locks this screen, not the computer");
    await tui.input("abc\r");
    expect(screenText()).toContain("at least 4 characters");
    await tui.input("d\r");
    await tui.input("abcd\r");
    expect(tui.locked).toBe(true);
    expect(saved.at(-1)?.kiosk?.passwordHash).toMatch(/^scrypt:/);
    expect(screenText()).toContain("Locked. Press Enter to unlock.");
    expect(screenText()).toContain("Scan to join");
    expect(screenText()).not.toContain("Activity");

    await tui.input("q2");
    expect(quit).not.toHaveBeenCalled();
    expect(tui.screen).toBe("join");

    await tui.input("\x03");
    await tui.input("wrong\r");
    expect(screenText()).toContain("That isn't the password.");
    expect(tui.locked).toBe(true);
    await tui.input("\x7f".repeat(5) + "abcd\r");
    expect(tui.locked).toBe(false);
  });

  it("starts locked with a saved password", () => {
    const passwordHash = hashKioskPassword("letmein");
    const { tui } = setup({ settings: { kiosk: { passwordHash, startLocked: true } }, startLocked: true });
    expect(tui.locked).toBe(true);
  });
});
