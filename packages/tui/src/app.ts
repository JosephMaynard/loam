/**
 * The terminal UI's controller: which screen is showing, the header, tabs and key hints around it, dialogs,
 * notices, kiosk mode, and the refresh loop. Screens draw themselves into the body (screens/*.ts).
 *
 * Layout, top to bottom: a status header, the tabs, the body, and one line of key hints (or a notice). That
 * leaves 21 rows of body in an 80×24 terminal: exactly the join QR's height.
 * Locked in kiosk mode, the whole terminal shows only the join QR and how to unlock.
 */
import type { HostStatus } from "@loam/schema";

import { type Line, lineWidth, text } from "./ansi.js";
import { createKeyReader, isChar, type Key } from "./keys.js";
import { createKioskGuard, hashKioskPassword, KIOSK_PASSWORD_MIN_LENGTH, verifyKioskPassword } from "./kiosk.js";
import { type Modal, modalKey, modalLines, textField } from "./modal.js";
import { activityScreen } from "./screens/activity.js";
import { debugScreen } from "./screens/debug.js";
import { joinScreen, qrFor } from "./screens/join.js";
import { peopleScreen } from "./screens/people.js";
import { settingsScreen } from "./screens/settings.js";
import type { CliSettings } from "./settings.js";
import { createPainter } from "./terminal.js";
import type { Screen, ScreenId, ScreenState, TuiOptions, View } from "./types.js";

export const SCREENS: Screen[] = [joinScreen, activityScreen, peopleScreen, settingsScreen, debugScreen];

/** Smallest terminal the UI draws in; below it, a note asks for a bigger window. */
export const MIN_COLUMNS = 40;
export const MIN_ROWS = 12;

const TOAST_MS = 4_000;
/** How long a lone Escape waits for the rest of a key sequence before it counts as Escape. */
const ESCAPE_WAIT_MS = 40;
const REFRESH_MS = 1_000;
/** How often the Activity screen looks for new log lines. */
const LOG_POLL_MS = 250;

export type Tui = {
  /** Take over the terminal and start the refresh loop. */
  start(): void;
  /** Give the terminal back. */
  stop(): void;
  /** Feed raw input (what the terminal's input listener receives). */
  input(chunk: string): Promise<void>;
  /** The frame as it would be drawn now. */
  frame(): Line[];
  /** Redraw now. */
  redraw(): void;
  readonly screen: ScreenId;
  readonly locked: boolean;
  readonly modal: Modal | undefined;
  /** What the join QR encodes right now. */
  readonly joinLink: string;
};

export function createTui(options: TuiOptions): Tui {
  const now = options.now ?? Date.now;
  const { terminal, host } = options;
  const painter = createPainter(terminal);
  const guard = createKioskGuard(now);

  let screen: Screen = joinScreen;
  let modal: Modal | undefined;
  let toast: { message: string; tone: "ok" | "error"; until: number } | undefined;
  let settings: CliSettings = options.settings;
  let locked = false;
  let status: HostStatus = host.status();
  let timers: ReturnType<typeof setInterval>[] = [];
  let logVersion = options.log.version();
  let running = false;
  let resets = status.resets;
  /** Keys are handled strictly in order, one chunk after another (a dialog step can be async). */
  let queue: Promise<void> = Promise.resolve();
  const reader = createKeyReader();
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  const state: ScreenState = {
    qrHidden: false,
    activity: { errorsOnly: false, scroll: 0 },
    people: { selected: 0 },
    settings: { selected: 0 },
  };

  const view: View = {
    options,
    get status() {
      return status;
    },
    state,
    get settings() {
      return settings;
    },
    now,
    open(next) {
      // Nothing but the unlock and password dialogs may appear over the kiosk lock: a dialog an earlier
      // action was still preparing (the admin QR, say) is dropped once the screen is locked.
      if (locked && !next.whileLocked) {
        if (next.kind === "panel") {
          next.onClose?.();
        }
        return;
      }
      setModal(next);
      redraw();
    },
    toast(message, tone = "ok") {
      toast = { message, tone, until: now() + TOAST_MS };
      redraw();
    },
    redraw: () => redraw(),
    joinUrl: () => `http://${formatHost(status.joinHost)}:${status.port}`,
    joinLink() {
      const key = host.transportPublicKey();
      const invite = host.invite();
      const parts = [key ? `k=${key}` : "", invite ? `i=${invite.code}` : ""].filter(Boolean);
      return `${view.joinUrl()}${parts.length ? `#${parts.join("&")}` : ""}`;
    },
    localUrl: () => `http://localhost:${status.port}`,
    saveSettings(next) {
      settings = next;
      try {
        options.saveSettings(next);
      } catch (error) {
        view.toast(`Couldn't save to cli.json: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
    lockKiosk: () => lockKiosk(),
  };

  /** Replace the open dialog, letting a panel that goes away clean up after itself. */
  function setModal(next: Modal | undefined): void {
    if (modal && modal !== next && modal.kind === "panel") {
      modal.onClose?.();
    }
    modal = next;
  }

  function refreshStatus(): void {
    try {
      status = host.status();
    } catch {
      // Keep the last status (the store may be mid-reset); the next tick tries again.
    }
    if (status.resets !== resets) {
      // An Emergency Reset (from here, the web app or the panic token): drop what this screen kept about
      // the old network, its log of who connected included.
      resets = status.resets;
      options.log.clear();
      state.activity = { errorsOnly: state.activity.errorsOnly, scroll: 0 };
      state.people.selected = 0;
      if (modal && !modal.whileLocked) {
        setModal(undefined);
      }
      toast = { message: "Emergency Reset: everything from before is gone, this screen's log too", tone: "ok", until: now() + TOAST_MS };
    }
  }

  // ---- Drawing ------------------------------------------------------------------------------------------

  function header(width: number): Line {
    const devices = status.clients.length;
    const left: Line = [
      { text: " LOAM ", style: { bold: true, inverse: true } },
      { text: ` ${status.nodeName} `, style: { bold: true } },
    ];
    const right: Line = [
      { text: devices === 1 ? "1 device" : `${devices} devices`, style: { dim: true } },
      { text: " · ", style: { dim: true } },
      status.devMode
        ? { text: "NOT ENCRYPTED (Developer Mode)", style: { fg: "red", bold: true } }
        : { text: status.transportEncryption === "required" ? "encrypted only" : "encrypted", style: { fg: "green" } },
      { text: ` · v${status.version} `, style: { dim: true } },
    ];
    const gap = Math.max(1, width - lineWidth(left) - lineWidth(right));
    return [...left, { text: " ".repeat(gap) }, ...right];
  }

  function tabs(): Line {
    const line: Line = [{ text: " " }];
    SCREENS.forEach((entry, index) => {
      const current = entry === screen;
      line.push({ text: ` ${index + 1} ${entry.title} `, style: current ? { inverse: true, bold: true } : { dim: true } });
      line.push({ text: " " });
    });
    if (status.people.pending) {
      line.push({ text: `  ${status.people.pending} waiting for approval`, style: { fg: "yellow" } });
    }
    return line;
  }

  function footer(): Line {
    if (toast && toast.until > now()) {
      return text(` ${toast.message}`, { fg: toast.tone === "error" ? "red" : "green", bold: true });
    }
    return text(` ${screen.hints(view)}`, { dim: true });
  }

  /** `body` with the open dialog drawn in a box over its middle. */
  function withModal(body: Line[], width: number, height: number): Line[] {
    if (!modal) {
      return body;
    }
    const inner = Math.min(width - 4, Math.max(50, Math.min(76, width - 8)));
    const content = modalLines(modal, inner, height - 2);
    const boxWidth = Math.min(width, Math.max(inner, ...content.map(lineWidth)) + 4);
    // Too tall: cut from the middle, keeping the title and the last lines (the field, its error, the keys).
    const room = Math.max(1, height - 2);
    const tail = Math.min(4, room - 1);
    const shown = content.length <= room ? content : [...content.slice(0, room - tail), ...content.slice(-tail)];
    const left = " ".repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));
    const top = Math.max(0, Math.floor((height - shown.length - 2) / 2));
    const border = (l: string, r: string): Line => [{ text: left }, { text: `${l}${"─".repeat(boxWidth - 2)}${r}`, style: { fg: "cyan" } }];
    const out = body.slice(0, height);
    while (out.length < height) out.push([]);
    out[top] = border("┌", "┐");
    shown.forEach((line, index) => {
      const pad = Math.max(0, boxWidth - 4 - lineWidth(line));
      out[top + 1 + index] = [
        { text: left },
        { text: "│ ", style: { fg: "cyan" } },
        ...line,
        { text: " ".repeat(pad) },
        { text: " │", style: { fg: "cyan" } },
      ];
    });
    if (top + 1 + shown.length < height) {
      out[top + 1 + shown.length] = border("└", "┘");
    }
    return out;
  }

  function kioskFrame(width: number, height: number): Line[] {
    const qr = state.qrHidden ? undefined : qrFor(view.joinLink());
    const lines: Line[] = [];
    const center = (line: Line): Line => [{ text: " ".repeat(Math.max(0, Math.floor((width - lineWidth(line)) / 2))) }, ...line];
    const below: Line[] = [
      text(status.nodeName, { bold: true }),
      text("Scan to join", { fg: "cyan" }),
      text(view.joinUrl(), { dim: true }),
      [],
      text(status.clients.length === 1 ? "1 device connected" : `${status.clients.length} devices connected`, { dim: true }),
    ];
    const fits = qr && qr.width <= width && qr.lines.length + below.length + 3 <= height;
    const block = [...(fits ? [...qr.lines, []] : []), ...below];
    const top = Math.max(0, Math.floor((height - block.length - 2) / 2));
    for (let row = 0; row < top; row += 1) lines.push([]);
    for (const line of block) lines.push(center(line));
    while (lines.length < height - 1) lines.push([]);
    lines.length = height - 1;
    lines.push(
      toast && toast.until > now()
        ? text(` ${toast.message}`, { fg: toast.tone === "error" ? "red" : "green" })
        : text(" Locked. Press Enter to unlock.", { dim: true }),
    );
    return withModal(lines, width, height);
  }

  function frame(): Line[] {
    const width = terminal.columns();
    const height = terminal.rows();
    if (width < MIN_COLUMNS || height < MIN_ROWS) {
      return [text("Make this window bigger to use LOAM.", { fg: "yellow" })];
    }
    if (locked) {
      return kioskFrame(width, height);
    }
    const bodyHeight = height - 3;
    let body: Line[];
    try {
      body = screen.render(view, width, bodyHeight).slice(0, bodyHeight);
    } catch (error) {
      body = [[], text(`  Couldn't draw this screen: ${error instanceof Error ? error.message : String(error)}`, { fg: "red" })];
    }
    while (body.length < bodyHeight) body.push([]);
    return [header(width), tabs(), ...withModal(body, width, bodyHeight), footer()];
  }

  function tooSmall(): boolean {
    return terminal.columns() < MIN_COLUMNS || terminal.rows() < MIN_ROWS;
  }

  /** Draw now. A failure to draw is shown, never thrown: it must not take the network down or stop the keys. */
  function redraw(): void {
    if (!running) {
      return;
    }
    try {
      painter.paint(frame());
    } catch (error) {
      try {
        painter.invalidate();
        painter.paint([text(`Couldn't draw the screen: ${error instanceof Error ? error.message : String(error)}`, { fg: "red" })]);
      } catch {
        // Nothing more to try; the next tick will.
      }
    }
  }

  // ---- Kiosk mode ---------------------------------------------------------------------------------------

  function lock(): void {
    locked = true;
    setModal(undefined);
    // Clear the terminal's scrollback too, where it can be scrolled to from the locked screen.
    terminal.write("\x1b[3J");
    redraw();
  }

  /**
   * Lock now, asking for a password first if none is set. Asked by the operator (`k`), Escape cancels; at a
   * locked start (`--kiosk`), the screen is locked first and stays locked until a password is chosen.
   */
  function lockKiosk(lockedFirst = false): void {
    if (settings.kiosk) {
      lock();
      return;
    }
    if (lockedFirst) {
      locked = true;
      setModal(undefined);
    }
    let first = "";
    view.open({
      whileLocked: true,
      kind: "input",
      title: "Kiosk mode",
      body: [
        "Kiosk mode leaves the join QR on screen and locks everything else until the password is entered, so this computer can be left out for people to join from.",
        "It locks this screen, not the computer: anyone at an unlocked keyboard can still close the window or open another terminal. For a computer left alone, run loam under its own user account.",
        "Choose a password:",
      ],
      field: textField("", { secret: true, maxLength: 128 }),
      onSubmit(value) {
        if ([...value].length < KIOSK_PASSWORD_MIN_LENGTH) {
          return `Use at least ${KIOSK_PASSWORD_MIN_LENGTH} characters.`;
        }
        first = value;
        // Opening the next dialog replaces this one.
        view.open({
          whileLocked: true,
          kind: "input",
          title: "Kiosk mode",
          body: ["Type the password again:"],
          field: textField("", { secret: true, maxLength: 128 }),
          onSubmit(again) {
            if (again !== first) {
              return "The passwords didn't match. Press Esc and start again.";
            }
            view.saveSettings({ ...settings, kiosk: { passwordHash: hashKioskPassword(again), startLocked: false } });
            lock();
            return undefined;
          },
        });
        return undefined;
      },
    });
  }

  function askToUnlock(): void {
    const kiosk = settings.kiosk;
    if (!kiosk) {
      // Locked at start with no password chosen yet: choosing one is the only way on.
      lockKiosk(true);
      return;
    }
    view.open({
      whileLocked: true,
      kind: "input",
      title: "Unlock",
      body: ["Kiosk password:"],
      field: textField("", { secret: true, maxLength: 128 }),
      onSubmit(value) {
        const wait = guard.waitMs();
        if (wait > 0) {
          return `Too many wrong passwords. Try again in ${Math.ceil(wait / 1000)} s.`;
        }
        if (!verifyKioskPassword(value, kiosk.passwordHash)) {
          guard.failed();
          return "That isn't the password.";
        }
        guard.succeeded();
        locked = false;
        return undefined;
      },
    });
  }

  // ---- Keys ---------------------------------------------------------------------------------------------

  function help(): Modal {
    return {
      kind: "panel",
      title: "Keys",
      lines: [
        text("1 to 5, Tab   switch screens"),
        text("?             this help"),
        text("k             lock in kiosk mode"),
        text("q, Ctrl-C     stop LOAM"),
        text("Ctrl-L        redraw the screen"),
        [],
        text("Join          h hide the QR · a join address · o open as admin"),
        text("Activity      e problems only · space pause · ↑↓ scroll · c clear"),
        text("People        ↑↓ choose · m make admin"),
        text("Settings      ↑↓ choose · Enter change"),
        text("Debug         l detailed logging · w write a diagnostics file"),
        [],
        text("Messages, approvals and moderation are in the web app.", { dim: true }),
      ],
    };
  }

  function confirmQuit(): void {
    const devices = status.clients.length;
    view.open({
      kind: "confirm",
      title: "Stop LOAM?",
      body: [
        devices
          ? `${devices === 1 ? "1 device is" : `${devices} devices are`} connected. They lose the network until you start it again.`
          : "Nobody can join until you start it again.",
      ],
      yes: "stop",
      onYes() {
        void options.quit();
      },
    });
  }

  async function handle(key: Key): Promise<void> {
    if (key.name === "ctrl-l") {
      painter.invalidate();
      return;
    }
    // Nothing can be seen in a window this small, so nothing is done either (a "stop?" no one can read).
    if (tooSmall()) {
      return;
    }

    if (modal) {
      const current = modal;
      if (await modalKey(current, key)) {
        if (modal === current) {
          setModal(undefined);
        }
      }
      return;
    }
    // Pasted text only means something in a text field.
    if (key.name === "paste") {
      return;
    }

    if (locked) {
      if (key.name === "enter" || key.name === "ctrl-c" || key.name === "ctrl-d" || isChar(key, "u")) {
        askToUnlock();
      }
      return;
    }

    if (screen.key(view, key)) {
      return;
    }

    const number = key.name === "char" ? Number(key.char) : Number.NaN;
    if (number >= 1 && number <= SCREENS.length) {
      screen = SCREENS[number - 1]!;
    } else if (key.name === "tab" || key.name === "shift-tab") {
      const index = SCREENS.indexOf(screen);
      screen = SCREENS[(index + (key.name === "tab" ? 1 : SCREENS.length - 1)) % SCREENS.length]!;
    } else if (isChar(key, "?")) {
      setModal(help());
    } else if (isChar(key, "k")) {
      lockKiosk();
    } else if (isChar(key, "q") || key.name === "ctrl-c" || key.name === "ctrl-d") {
      confirmQuit();
    }
  }

  async function process(keys: Key[]): Promise<void> {
    for (const key of keys) {
      try {
        await handle(key);
      } catch (error) {
        view.toast(error instanceof Error ? error.message : String(error), "error");
      }
    }
    refreshStatus();
    redraw();
  }

  /** Queue keys; a step that fails never blocks the ones after it. */
  function enqueue(keys: Key[]): Promise<void> {
    queue = queue.then(() => process(keys)).catch(() => undefined);
    return queue;
  }

  function input(chunk: string): Promise<void> {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
    const done = enqueue(reader.feed(chunk));
    if (reader.pending()) {
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        const keys = reader.flush();
        if (keys.length) {
          void enqueue(keys);
        }
      }, ESCAPE_WAIT_MS);
      escapeTimer.unref?.();
    }
    return done;
  }

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      terminal.start();
      terminal.onInput((chunk) => void input(chunk));
      terminal.onResize(() => {
        painter.invalidate();
        redraw();
      });
      timers = [
        setInterval(() => {
          refreshStatus();
          redraw();
        }, REFRESH_MS),
        setInterval(() => {
          const version = options.log.version();
          if (version !== logVersion && screen === activityScreen && !state.activity.frozen) {
            logVersion = version;
            redraw();
          }
        }, LOG_POLL_MS),
      ];
      for (const timer of timers) {
        timer.unref?.();
      }
      if (options.startLocked) {
        lockKiosk(true);
      }
      painter.invalidate();
      redraw();
    },
    stop() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers = [];
      if (escapeTimer) {
        clearTimeout(escapeTimer);
      }
      running = false;
      terminal.stop();
    },
    input,
    frame,
    redraw,
    get screen() {
      return screen.id;
    },
    get locked() {
      return locked;
    },
    get modal() {
      return modal;
    },
    get joinLink() {
      return view.joinLink();
    },
  };
}

/** An IPv6 address in brackets, as a URL needs it. */
function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
