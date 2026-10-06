/**
 * Settings: the network's main settings, changed live through the same path the web admin saves through
 * (so the two always agree), a few actions, and what this computer remembers for the next `loam` start.
 * The web app's admin page has the rest.
 */
import { type LoamConfig, type LoamConfigUpdate, type SecurityProfile } from "@loam/schema";

import { type Line, padEnd, text } from "../ansi.js";
import { isChar } from "../keys.js";
import { textField } from "../modal.js";
import { qrBlock } from "../qr.js";
import type { Screen, View } from "../types.js";

type Row = {
  section: string;
  label: string;
  value: string;
  /** Why it can't be changed here, if it can't. */
  locked?: string;
  activate?(view: View): void;
};

const PROFILE_LABELS: Record<SecurityProfile, string> = {
  custom: "Choose each setting",
  open: "Open",
  standard: "Standard",
  hardened: "Hardened",
};

const LIFETIMES: { label: string; ms: number | null }[] = [
  { label: "Never", ms: null },
  { label: "After 1 hour", ms: 3_600_000 },
  { label: "After 24 hours", ms: 86_400_000 },
  { label: "After 7 days", ms: 7 * 86_400_000 },
];

function lifetimeLabel(ms: number | undefined): string {
  return LIFETIMES.find((entry) => entry.ms === (ms ?? null))?.label ?? `After ${Math.round((ms ?? 0) / 60_000)} minutes`;
}

/** Apply a change and say how it went. */
function save(view: View, update: LoamConfigUpdate, done: string): void {
  const result = view.options.host.updateConfig(update);
  view.toast(result.ok ? done : `Not saved: ${result.error}`, result.ok ? "ok" : "error");
}

function choose<T>(
  view: View,
  title: string,
  body: string,
  choices: { label: string; detail?: string; value: T }[],
  current: T,
  apply: (value: T) => void,
): void {
  view.open({
    kind: "choice",
    title,
    body: [body],
    options: choices.map(({ label, detail }) => ({ label, detail })),
    selected: Math.max(0, choices.findIndex((choice) => choice.value === current)),
    onPick: (index) => apply(choices[index]!.value),
  });
}

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

function rows(view: View, config: LoamConfig): Row[] {
  const profile = config.security.profile;
  const byProfile = profile === "custom" ? undefined : `set by the ${PROFILE_LABELS[profile]} profile`;
  const { settings } = view;

  return [
    {
      section: "Network",
      label: "Name",
      value: config.node.name,
      activate(view) {
        view.open({
          kind: "input",
          title: "Network name",
          body: ["Shown to everyone who joins."],
          field: textField(config.node.name, { maxLength: 80 }),
          onSubmit(value) {
            if (!value.trim()) {
              return "The name can't be empty.";
            }
            save(view, { node: { name: value.trim() } }, "Name saved");
            return undefined;
          },
        });
      },
    },
    {
      section: "Network",
      label: "Security profile",
      value: PROFILE_LABELS[profile],
      activate(view) {
        choose(
          view,
          "Security profile",
          "A profile sets who can join, connection encryption, how long messages last and the remote Emergency Reset together.",
          [
            { label: PROFILE_LABELS.custom, detail: "set each one below", value: "custom" as SecurityProfile },
            { label: "Open", detail: "anyone joins, messages kept", value: "open" as SecurityProfile },
            { label: "Standard", detail: "as Open, for everyday use", value: "standard" as SecurityProfile },
            { label: "Hardened", detail: "approval, encrypted only, 1-hour messages", value: "hardened" as SecurityProfile },
          ],
          profile,
          (value) => save(view, { security: { profile: value } }, "Profile saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Who can join",
      value: config.access.joinPolicy === "approval" ? "Approved people only" : "Anyone nearby",
      locked: byProfile,
      activate(view) {
        choose(
          view,
          "Who can join",
          "With approval, newcomers wait until an admin or greeter lets them in. People who scan the join QR on this screen get straight in.",
          [
            { label: "Anyone nearby", value: "open" as const },
            { label: "Approved people only", value: "approval" as const },
          ],
          config.access.joinPolicy,
          (value) => save(view, { access: { joinPolicy: value } }, "Saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Connection encryption",
      value: config.security.transportEncryption === "required" ? "Required" : "When possible",
      locked: byProfile,
      activate(view) {
        choose(
          view,
          "Connection encryption",
          "Everyone who joins by the QR code is encrypted either way. Required also turns away devices that typed the address by hand.",
          [
            { label: "When possible", value: "optional" as const },
            { label: "Required", value: "required" as const },
          ],
          config.security.transportEncryption,
          (value) => save(view, { security: { transportEncryption: value } }, "Saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Delete messages",
      value: lifetimeLabel(config.retention.messageTtlMs),
      locked: byProfile,
      activate(view) {
        choose(
          view,
          "Delete messages",
          "Older messages are deleted from this computer and from everyone's screen.",
          LIFETIMES.map((entry) => ({ label: entry.label, value: entry.ms })),
          config.retention.messageTtlMs ?? null,
          (value) => save(view, { retention: { messageTtlMs: value } }, "Saved"),
        );
      },
    },
    {
      section: "Network",
      label: "Emergency Reset from the web app",
      value: onOff(config.killSwitch.enabled),
      locked: byProfile,
      activate(view) {
        save(view, { killSwitch: { enabled: !config.killSwitch.enabled } }, "Saved");
      },
    },
    {
      section: "Network",
      label: "Show who's online",
      value: onOff(config.features.enablePresence),
      activate(view) {
        save(view, { features: { enablePresence: !config.features.enablePresence } }, "Saved");
      },
    },
    {
      section: "Network",
      label: "Assistant (Ollama)",
      value: config.llm.ollama.enabled ? `On, ${config.llm.ollama.model}` : "Off",
      activate(view) {
        save(view, { llm: { ollama: { enabled: !config.llm.ollama.enabled } } }, "Saved");
      },
    },
    {
      section: "Actions",
      label: "Link another LOAM network",
      value: "Show a link code",
      activate: showLinkCode,
    },
    {
      section: "Actions",
      label: "Emergency Reset",
      value: "Wipe everything now",
      activate: confirmEmergencyReset,
    },
    {
      section: "This computer",
      label: "Port",
      value: `${settings.port ?? view.status.port}${settings.port && settings.port !== view.status.port ? " from next start" : ""}`,
      activate(view) {
        view.open({
          kind: "input",
          title: "Port",
          body: ["Used the next time you start loam (a --port flag still wins). Joiners will need the new QR code."],
          field: textField(String(settings.port ?? view.status.port), { maxLength: 5 }),
          onSubmit(value) {
            const port = Number(value);
            if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
              return "Enter a number from 1 to 65535.";
            }
            view.saveSettings({ ...view.settings, port });
            view.toast(`Port ${port} from the next start`);
            return undefined;
          },
        });
      },
    },
    {
      section: "This computer",
      label: "Kiosk mode",
      value: settings.kiosk ? "Lock now (k)" : "Set a password and lock (k)",
      activate: (view) => view.lockKiosk(),
    },
    {
      section: "This computer",
      label: "Start locked",
      value: settings.kiosk?.startLocked ? "On" : "Off",
      locked: settings.kiosk ? undefined : "set a kiosk password first",
      activate(view) {
        const kiosk = view.settings.kiosk;
        if (kiosk) {
          view.saveSettings({ ...view.settings, kiosk: { ...kiosk, startLocked: !kiosk.startLocked } });
          view.toast(kiosk.startLocked ? "Starts unlocked" : "Starts locked in kiosk mode");
        }
      },
    },
    {
      section: "This computer",
      label: "Forget kiosk password",
      value: settings.kiosk ? "Remove it" : "",
      locked: settings.kiosk ? undefined : "no password set",
      activate(view) {
        view.open({
          kind: "confirm",
          title: "Forget the kiosk password?",
          body: ["You'll set a new one the next time you lock the screen."],
          yes: "forget it",
          onYes() {
            const { kiosk: _removed, ...rest } = view.settings;
            view.saveSettings(rest);
            view.toast("Kiosk password forgotten");
          },
        });
      },
    },
  ];
}

function showLinkCode(view: View): void {
  const { host } = view.options;
  const key = host.transportPublicKey();
  const { code } = host.linkCode();
  const link = `${view.joinUrl()}#${key ? `k=${key}&` : ""}l=${code}`;
  const qr = qrBlock(link);
  view.open({
    kind: "panel",
    title: "Link another LOAM network",
    lines: [
      text("On the other LOAM phone: setup, then Join another LOAM network, and scan this.", { dim: true }),
      text("The two networks then share their public channels both ways. It works once, for 10 minutes.", { dim: true }),
      [],
      ...(qr ? qr.lines : [text(link, { fg: "cyan" })]),
    ],
  });
}

function confirmEmergencyReset(view: View): void {
  view.open({
    kind: "input",
    title: "Emergency Reset",
    body: [
      "Deletes every message, person, channel and file on this network now, and signs everyone out. Settings are kept. This can't be undone.",
      "Type wipe to confirm.",
    ],
    field: textField("", { maxLength: 10 }),
    async onSubmit(value) {
      if (value.trim().toLowerCase() !== "wipe") {
        return "Type wipe to confirm, or press Esc.";
      }
      const result = await view.options.host.emergencyReset();
      view.toast(
        result.complete ? "Emergency Reset done" : "The reset didn't finish. Restart loam to complete it.",
        result.complete ? "ok" : "error",
      );
      return undefined;
    },
  });
}

/** Selectable rows, for tests. */
export function settingsRows(view: View): Row[] {
  return rows(view, view.options.host.config());
}

export const settingsScreen: Screen = {
  id: "settings",
  title: "Settings",
  hints: () => "↑↓ choose · Enter change · ? help",
  render(view, width, height) {
    const list = settingsRows(view);
    const state = view.state.settings;
    state.selected = Math.max(0, Math.min(state.selected, list.length - 1));
    const labelWidth = Math.min(36, Math.max(24, Math.floor(width / 3)));

    const lines: Line[] = [];
    let section = "";
    let selectedLine = 0;
    list.forEach((row, index) => {
      if (row.section !== section) {
        section = row.section;
        if (lines.length) {
          lines.push([]);
        }
        lines.push(text(` ${section}`, { bold: true }));
      }
      const chosen = index === state.selected;
      if (chosen) {
        selectedLine = lines.length;
      }
      lines.push([
        { text: chosen ? " › " : "   ", style: { fg: "cyan" } },
        { text: padEnd(row.label, labelWidth), style: chosen ? { inverse: true } : undefined },
        { text: "  " },
        { text: row.value, style: row.locked ? { dim: true } : { fg: "cyan" } },
        { text: row.locked ? `  (${row.locked})` : "", style: { dim: true } },
      ]);
    });
    lines.push([], text(" The web app's admin page has every other setting.", { dim: true }));

    // Keep the chosen row in view on a short window.
    const start = Math.max(0, Math.min(selectedLine - Math.floor(height / 2), lines.length - height));
    return lines.slice(start, start + height);
  },
  key(view, key) {
    const state = view.state.settings;
    if (key.name === "up") {
      state.selected = Math.max(0, state.selected - 1);
      return true;
    }
    if (key.name === "down") {
      state.selected += 1;
      return true;
    }
    if (key.name === "enter" || isChar(key, " ")) {
      const row = settingsRows(view)[state.selected];
      if (row?.locked) {
        view.toast(`Can't change this: ${row.locked}`, "error");
      } else {
        row?.activate?.(view);
      }
      return true;
    }
    return false;
  },
};
