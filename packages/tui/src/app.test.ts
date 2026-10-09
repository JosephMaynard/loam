import type { HostApi, HostStatus, HostUser, LoamConfig, LoamConfigUpdate } from "@loam/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { plain } from "./ansi.js";
import { createTui, HOST_ACK_VERSION, type Tui } from "./app.js";
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
  let minted = 0;
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
    resets: 0,
    resetting: false,
  };
  const host = {
    status: vi.fn(() => ({ ...status, nodeName: config.node.name })),
    /** Test hook: make the node look like a reset started (and, unless `finished` is false, ended). */
    reset(finished = true) {
      status.resets += 1;
      status.resetting = !finished;
    },
    /** Test hook: the reset that was running ends. */
    finishReset() {
      status.resetting = false;
    },
    /** Test hook: point joiners somewhere. */
    setJoinHostDirect(value: string) {
      status.joinHost = value;
    },
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
    adminClaimCode: vi.fn((): { code: string; expiresAt: number } | null => ({ code: `code${String(++minted).padStart(18, "0")}`, expiresAt: 0 })),
    revokeAdminClaimCode: vi.fn(),
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

/** Escape on its own counts once nothing else follows it for a moment (keys.ts). */
async function pressEscape(tui: Tui): Promise<void> {
  await tui.input("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 80));
}
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
    now?: () => number;
    failSaves?: boolean;
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
    // The host note is acknowledged unless a test is about it (see "the host note").
    settings: { hostAck: HOST_ACK_VERSION, ...options.settings },
    saveSettings: (next) => {
      if (options.failSaves) {
        throw new Error("ENOSPC: no space left on device");
      }
      saved.push(next);
    },
    writeFile: (path, contents) => writes.push({ path, contents }),
    startLocked: options.startLocked,
    quit,
    now: options.now,
  });
  tuis.push(tui);
  tui.start();
  const screenText = () => tui.frame().map(plain).join("\n");
  return { tui, host, terminal, log, system, saved, writes, quit, screenText };
}

describe("the host note", () => {
  it("shows once on a first start, and Enter records that the host understood", async () => {
    const { tui, screenText, saved } = setup({ settings: { hostAck: undefined } });
    expect(screenText()).toContain("You run this network");
    expect(screenText()).toContain("report it to the police");
    await tui.input("\r");
    expect(tui.modal).toBeUndefined();
    expect(saved.at(-1)).toMatchObject({ hostAck: HOST_ACK_VERSION });
  });

  it("shows after unlocking a first start that opened locked", async () => {
    const passwordHash = hashKioskPassword("abcd");
    const { tui, screenText } = setup({
      settings: { hostAck: undefined, kiosk: { passwordHash, startLocked: true } },
      startLocked: true,
    });
    expect(screenText()).not.toContain("You run this network");
    await tui.input("\r");
    await tui.input("abcd\r");
    expect(tui.locked).toBe(false);
    expect(screenText()).toContain("You run this network");
  });

  it("stays away once acknowledged", () => {
    const { screenText } = setup();
    expect(screenText()).not.toContain("You run this network");
  });
});

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

  it("opens the browser as admin with a one-time code, and shows a phone QR only when asked", async () => {
    const qrRows = (screen: string) => screen.split("\n").filter((line) => line.includes("│") && /[█▀▄]/.test(line)).length;
    const { tui, system, host, screenText } = setup();
    await tui.input("o");
    expect(system.openUrl).toHaveBeenCalledWith(`http://localhost:3000#k=${KEY}&a=code000000000000000001`);
    expect(host.adminClaimCode).toHaveBeenCalledTimes(1);
    expect(screenText()).toContain("signed in as admin");
    expect(qrRows(screenText())).toBe(0);

    await tui.input("p");
    expect(host.adminClaimCode).toHaveBeenCalledTimes(2);
    expect(screenText()).toContain("Anyone who scans this becomes an admin");
    expect(qrRows(screenText())).toBeGreaterThanOrEqual(18);

    await pressEscape(tui);
    expect(tui.modal).toBeUndefined();
    expect(host.revokeAdminClaimCode).toHaveBeenCalledWith("code000000000000000002");
  });

  it("puts the phone's link on the join address, and shows it in full when the QR won't fit", async () => {
    const qrRows = (screen: string) => screen.split("\n").filter((line) => line.includes("│") && /[█▀▄]/.test(line)).length;
    const cramped = setup({ terminal: fakeTerminal(70, 26) });
    vi.mocked(cramped.system.openUrl).mockResolvedValue(false);
    await cramped.tui.input("o");
    await cramped.tui.input("p");
    const screen = cramped.screenText();
    expect(qrRows(screen)).toBe(0);
    expect(screen).toContain("Couldn't open a browser");
    expect(screen).toContain("Make the window bigger to show this as a QR code.");
    // Both links, broken across lines but never cut short.
    const joined = screen.split("\n").map((line) => line.replace(/^.*│ /, "").replace(/ *│.*$/, "")).join("");
    expect(joined).toContain(`http://localhost:3000#k=${KEY}&a=code000000000000000001`);
    expect(joined).toContain(`http://192.168.8.159:3000#k=${KEY}&a=code000000000000000002`);
  });

  it("never draws the admin dialog over a screen locked meanwhile", async () => {
    let finishOpening: (opened: boolean) => void = () => {};
    const { tui, system, host, screenText } = setup({
      settings: { kiosk: { passwordHash: hashKioskPassword("abcd"), startLocked: false } },
    });
    vi.mocked(system.openUrl).mockImplementation(() => new Promise((resolve) => (finishOpening = resolve)));
    const opening = tui.input("o");
    await tui.input("k");
    finishOpening(true);
    await opening;
    expect(tui.locked).toBe(true);
    expect(tui.modal).toBeUndefined();
    expect(screenText()).not.toContain("Open as admin");
    expect(host.adminClaimCode).toHaveBeenCalledTimes(1);
  });

  it("encodes the node key and the invite in the join QR", () => {
    const host = fakeHost();
    host.invite.mockReturnValue({ code: "invitecode_0123456789a", expiresAt: 0 } as never);
    expect(setup({ host }).tui.joinLink).toBe(`http://192.168.8.159:3000#k=${KEY}&i=invitecode_0123456789a`);
    expect(setup().tui.joinLink).toBe(`http://192.168.8.159:3000#k=${KEY}`);
  });

  it("pins the join address and remembers it", async () => {
    const { tui, host, saved, screenText } = setup();
    await tui.input("a");
    expect(screenText()).toContain("utun3");
    await tui.input("\x1b[B\x1b[B\r");
    expect(host.setJoinHost).toHaveBeenCalledWith("10.8.0.2");
    expect(saved.at(-1)).toEqual({ hostAck: HOST_ACK_VERSION, joinHost: "10.8.0.2" });
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

describe("kiosk mode, the edges", () => {
  const passwordHash = hashKioskPassword("abcd");

  it("does nothing but offer to unlock while locked", async () => {
    const { tui, host, screenText } = setup({ settings: { kiosk: { passwordHash, startLocked: true } }, startLocked: true });
    await tui.input("2");
    expect(tui.screen).toBe("join");
    expect(tui.modal).toBeUndefined();
    await tui.input("4o");
    expect(host.updateConfig).not.toHaveBeenCalled();
    expect(host.adminClaimCode).not.toHaveBeenCalled();
    expect(screenText()).toContain("Locked. Press Enter to unlock.");
  });

  it("slows down guessing through the unlock dialog", async () => {
    let now = 1_000_000;
    const { tui, screenText } = setup({
      settings: { kiosk: { passwordHash, startLocked: true } },
      startLocked: true,
      now: () => now,
    });
    await tui.input("\r");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tui.input("nope\r");
      await tui.input("\x7f".repeat(4));
    }
    await tui.input("abcd\r");
    expect(screenText()).toContain("Too many wrong passwords. Try again in 2 s.");
    expect(tui.locked).toBe(true);
    now += 2_000;
    await tui.input("\r");
    expect(tui.locked).toBe(false);
  });

  it("starts locked with no password saved, and stays locked until one is chosen", async () => {
    const { tui, saved, screenText } = setup({ startLocked: true });
    expect(tui.locked).toBe(true);
    expect(screenText()).toContain("Choose a password");
    await pressEscape(tui);
    expect(tui.locked).toBe(true);
    await tui.input("2");
    expect(tui.screen).toBe("join");
    await tui.input("\r");
    expect(screenText()).toContain("Choose a password");
    await tui.input("wxyz\r");
    await tui.input("wxyz\r");
    expect(saved.at(-1)?.kiosk?.passwordHash).toMatch(/^scrypt:/);
    expect(saved.at(-1)?.kiosk?.startLocked).toBe(false);
    expect(tui.locked).toBe(true);
  });
});

describe("robustness", () => {
  it("shows a screen that fails to draw instead of stopping, and keeps taking keys", async () => {
    const host = fakeHost();
    host.users.mockImplementation(() => {
      throw new Error("store closed");
    });
    const { tui, screenText } = setup({ host });
    await tui.input("3");
    expect(screenText()).toContain("Couldn't draw this screen: store closed");
    await tui.input("1");
    expect(tui.screen).toBe("join");
  });

  it("treats pasted text as text: into a field, and never as keys", async () => {
    const { tui, host, quit, screenText } = setup();
    await tui.input("\x1b[200~qy\x1b[201~");
    expect(tui.modal).toBeUndefined();
    expect(quit).not.toHaveBeenCalled();

    await tui.input("4\r");
    await tui.input("\x7f".repeat(20) + "\x1b[200~Village\nhall\x1b[201~\r");
    expect(host.updateConfig).toHaveBeenCalledWith({ node: { name: "Villagehall" } });
    expect(screenText()).toContain("Name saved");
  });

  it("does nothing in a window too small to show what it would do", async () => {
    const { tui, quit } = setup({ terminal: fakeTerminal(30, 10) });
    await tui.input("qy");
    expect(tui.modal).toBeUndefined();
    expect(quit).not.toHaveBeenCalled();
  });

  it("forgets its log after an Emergency Reset from anywhere", async () => {
    const host = fakeHost();
    const { tui, log, screenText } = setup({ host });
    log.note("info", "192.168.8.20 joined earlier");
    host.reset();
    await tui.input("2");
    expect(log.entries()).toEqual([]);
    expect(screenText()).toContain("Emergency Reset");
    expect(screenText()).not.toContain("joined earlier");
  });
});

describe("People, with names anyone can copy", () => {
  it("flags a shared name and shows enough to tell the two apart", async () => {
    const users: HostUser[] = [
      { id: "user.aaaaaa111111", displayName: "amber.oak.heron", isAdmin: false, online: true, pending: false, banned: false, createdAt: 1 },
      { id: "user.bbbbbb222222", displayName: "Amber.Oak.Heron", isAdmin: false, online: false, pending: false, banned: false, createdAt: 2 },
    ];
    const { tui, screenText } = setup({ host: fakeHost({ users }) });
    await tui.input("3");
    expect(screenText()).toContain("…111111");
    expect(screenText()).toContain("…222222");
    expect(screenText().match(/same name as someone else/g)).toHaveLength(2);
    await tui.input("m");
    expect(screenText()).toContain("Id ending …111111");
    expect(screenText()).toContain("Someone else uses this name too");
  });
});

describe("Settings, row by row", () => {
  async function openRow(tui: Tui, index: number): Promise<void> {
    // The screen remembers the chosen row: start from the top.
    await tui.input("4" + "\x1b[A".repeat(20));
    for (let step = 0; step < index; step += 1) {
      await tui.input("\x1b[B");
    }
    await tui.input("\r");
  }

  it("sends who can join and how long messages last as the schema expects", async () => {
    const { tui, host } = setup();
    await openRow(tui, 2);
    await tui.input("\x1b[B\r");
    expect(host.updateConfig).toHaveBeenLastCalledWith({ access: { joinPolicy: "approval" } });
    await openRow(tui, 4);
    await tui.input("\x1b[B\x1b[B\r");
    expect(host.updateConfig).toHaveBeenLastCalledWith({ retention: { messageTtlMs: 86_400_000 } });
  });

  it("keeps a message lifetime set elsewhere on offer and chosen", async () => {
    const host = fakeHost();
    host.config().retention.messageTtlMs = 30 * 60_000;
    const { tui, screenText } = setup({ host });
    await openRow(tui, 4);
    expect(screenText()).toContain("› After 30 minutes");
    await tui.input("\r");
    expect(host.updateConfig).toHaveBeenLastCalledWith({ retention: { messageTtlMs: 1_800_000 } });
  });

  it("only saves a port that can exist, and forgets the kiosk password when asked", async () => {
    const { tui, saved, screenText } = setup({
      settings: { kiosk: { passwordHash: hashKioskPassword("abcd"), startLocked: false } },
    });
    await openRow(tui, 10);
    await tui.input("\x7f".repeat(5) + "70000\r");
    expect(screenText()).toContain("Enter a number from 1 to 65535.");
    await tui.input("\x7f".repeat(5) + "3005\r");
    expect(saved.at(-1)?.port).toBe(3005);

    await openRow(tui, 12);
    expect(saved.at(-1)?.kiosk?.startLocked).toBe(true);
    await openRow(tui, 13);
    await tui.input("y");
    expect(saved.at(-1)?.kiosk).toBeUndefined();
  });
});

describe("the diagnostics file", () => {
  it("leaves out addresses of every form, hosts, folders and ids, but keeps times", async () => {
    const { tui, log, writes } = setup();
    log.note("error", "Peer fe80::1ff:fe23:4567:890a%en0 and [2001:db8::1]:3000 refused at 12:34:56");
    log.note("warn", "Sync from http://pi.local:3000 failed; rm /home/ada/.loam/attachments/att_0123abcd.webp");
    log.note("warn", "GET /api/dms/user.1a2b3c4d answered 404");
    await tui.input("5w");
    const contents = writes[0]!.contents;
    expect(contents).not.toMatch(/fe80|2001:db8|pi\.local|\/home\/ada|att_0123|user\.1a2b/);
    expect(contents).toContain("12:34:56");
    expect(contents).toContain("/api/dms/<id>");
  });
});

describe("findings from the second review", () => {
  it("doesn't announce a reset that hasn't finished, and says when one is stuck", async () => {
    const host = fakeHost();
    const { tui, log, screenText } = setup({ host });
    log.note("info", "from before");
    host.reset(false);
    await tui.input("2");
    expect(log.entries()).toHaveLength(1);
    expect(screenText()).toContain("RESETTING (if this stays, restart loam)");
    expect(screenText()).not.toContain("everything from before is gone");

    host.finishReset();
    await tui.input("2");
    expect(log.entries()).toEqual([]);
    expect(screenText()).toContain("everything from before is gone");
    expect(screenText()).not.toContain("RESETTING");
  });

  it("reports a startup setting that couldn't be written, and doesn't pretend it was", async () => {
    const { tui, screenText } = setup({ failSaves: true });
    await tui.input("4" + "\x1b[B".repeat(10) + "\r");
    await tui.input("\x7f".repeat(5) + "3005\r");
    expect(screenText()).toContain("Not saved: couldn't write cli.json (ENOSPC: no space left on device)");
    expect(screenText()).not.toContain("Port 3005 from the next start");
    expect(screenText()).toMatch(/Port\s+3000/);

    await tui.input("k");
    await tui.input("abcd\r");
    await tui.input("abcd\r");
    expect(tui.locked).toBe(false);
    expect(screenText()).toContain("kiosk mode isn't on");
  });

  it("keeps the QR on the kiosk screen in an 80x24 window", () => {
    const { tui, screenText } = setup({
      terminal: fakeTerminal(80, 24),
      settings: { kiosk: { passwordHash: hashKioskPassword("abcd"), startLocked: true } },
      startLocked: true,
    });
    expect(tui.locked).toBe(true);
    const screen = screenText();
    expect(screen.split("\n").filter((line) => /[█▀▄]/.test(line)).length).toBeGreaterThanOrEqual(18);
    expect(screen).toContain("Scan to join");
    expect(screen).toContain("http://192.168.8.159:3000");
  });

  it("hands out the whole link, key included, when the address is too long for a QR", () => {
    const host = fakeHost();
    host.setJoinHostDirect("a-very-long-host-name-that-will-not-fit.example.internal.network.local");
    const { screenText } = setup({ host });
    const screen = screenText();
    expect(screen).toContain("Share this whole link instead");
    const joined = screen.split("\n").map((line) => line.trim()).join("");
    expect(joined).toContain(`.local:3000#k=${KEY}`);
  });
});
