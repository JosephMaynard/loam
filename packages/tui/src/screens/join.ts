/**
 * Join (the home screen): the join QR, kept on screen, with the addresses beside it. From here the operator
 * hides the QR, picks which network address to advertise, and opens LOAM in the browser as admin.
 */
import { type Line, text } from "../ansi.js";
import { isChar } from "../keys.js";
import { wrap } from "../modal.js";
import { qrBlock, type QrBlock } from "../qr.js";
import type { Screen, View } from "../types.js";

/** The last QR drawn, by the text it encodes: re-encoding every second would be wasted work. */
let cached: { value: string; block: QrBlock | undefined } | undefined;

export function qrFor(value: string): QrBlock | undefined {
  if (cached?.value !== value) {
    cached = { value, block: qrBlock(value) };
  }
  return cached.block;
}

/** What sits beside (or under) the QR. */
function infoLines(view: View, width: number): Line[] {
  const { status } = view;
  const lines: Line[] = [
    text("Join from a phone or laptop on this network", { dim: true }),
    text(view.joinUrl(), { bold: true, fg: "cyan" }),
    [],
    text("On this computer", { dim: true }),
    text(view.localUrl(), { fg: "cyan" }),
    [],
  ];
  const paragraphs: { value: string; style?: Line[number]["style"] }[] = [];
  if (status.transportEncryption !== "off") {
    paragraphs.push({ value: "Scan to join: the code carries this network's key, so the join is protected." });
  }
  if (view.options.host.invite()) {
    paragraphs.push({
      value: "The code also lets people in without waiting for approval. It changes every 10 minutes.",
      style: { fg: "yellow" },
    });
  }
  if (status.people.admins === 0) {
    paragraphs.push({ value: "Nobody is admin yet. Press o to open LOAM in your browser as admin.", style: { fg: "yellow" } });
  }
  for (const { value, style } of paragraphs) {
    lines.push(...wrap(value, width).map((line) => text(line, style)), []);
  }
  const devices = status.clients.length;
  lines.push(text(devices === 1 ? "1 other device connected" : `${devices} other devices connected`, { dim: true }));
  return lines;
}

export const joinScreen: Screen = {
  id: "join",
  title: "Join",
  hints: (view) =>
    `h ${view.state.qrHidden ? "show" : "hide"} QR · a join address · o open as admin · ? help · q quit`,
  render(view, width, height) {
    const qr = view.state.qrHidden ? undefined : qrFor(view.joinLink());
    const gap = 4;
    const sideWidth = qr ? width - qr.width - gap - 2 : 0;

    // Beside the QR when there's room for both, under it when only the height allows, else just the text.
    if (qr && sideWidth >= 30 && height >= qr.lines.length) {
      const info = infoLines(view, sideWidth);
      const rows = Math.max(qr.lines.length, info.length);
      const top = Math.max(0, Math.floor((height - rows) / 2));
      const lines: Line[] = Array.from({ length: top }, () => []);
      for (let row = 0; row < rows; row += 1) {
        const left = qr.lines[row] ?? text(" ".repeat(qr.width));
        lines.push([{ text: "  " }, ...left, { text: " ".repeat(gap) }, ...(info[row] ?? [])]);
      }
      return lines;
    }

    const info = infoLines(view, Math.max(20, width - 4)).map((line) => [{ text: "  " }, ...line]);
    if (qr && width >= qr.width + 2 && height >= qr.lines.length + info.length + 1) {
      return [...qr.lines.map((line) => [{ text: "  " }, ...line]), [], ...info];
    }

    const note = view.state.qrHidden
      ? "The QR code is hidden. Press h to show it."
      : qr
        ? "Make this window a little bigger to show the QR code (or press k: kiosk mode uses the whole window)."
        : "This join address is too long for a QR code. Share the link instead.";
    return [[], text(`  ${note}`, { fg: "yellow" }), [], ...info];
  },
  key(view, key) {
    if (isChar(key, "h")) {
      view.state.qrHidden = !view.state.qrHidden;
      return true;
    }
    if (isChar(key, "a")) {
      pickJoinAddress(view);
      return true;
    }
    if (isChar(key, "o")) {
      void openAsAdmin(view);
      return true;
    }
    return false;
  },
};

/** Choose which of this computer's addresses joiners are told to use. */
export function pickJoinAddress(view: View): void {
  const addresses = view.options.system.lanAddresses();
  const pinned = view.settings.joinHost;
  const options = [
    { label: "Automatic", detail: "the best address LOAM can find" },
    ...addresses.map((entry) => ({ label: entry.address, detail: entry.name })),
  ];
  const current = pinned ? addresses.findIndex((entry) => entry.address === pinned) + 1 : 0;
  view.open({
    kind: "choice",
    title: "Join address",
    body: [
      "The address in the QR code and the join link. Pick the network people will be on, if this computer has more than one (Wi-Fi, Ethernet, a VPN).",
    ],
    options,
    selected: Math.max(0, current),
    onPick(index) {
      const address = index === 0 ? undefined : addresses[index - 1]?.address;
      view.options.host.setJoinHost(address);
      view.saveSettings({ ...view.settings, joinHost: address });
      view.toast(address ? `Joiners now use ${address}` : "Join address is picked automatically");
    },
  });
}

/** Open LOAM in this computer's browser, already admin; offer a QR for a phone too. */
export async function openAsAdmin(view: View): Promise<void> {
  const { host, system } = view.options;
  const key = host.transportPublicKey();
  const fragment = (code: string) => `#${key ? `k=${key}&` : ""}a=${code}`;
  const local = `${view.localUrl()}${fragment(host.adminClaimCode().code)}`;
  const opened = await system.openUrl(local);

  const phoneLink = `${view.joinUrl()}${fragment(host.adminClaimCode().code)}`;
  const qr = qrFor(phoneLink);
  const lines: Line[] = [
    ...(opened
      ? [text("LOAM is opening in your browser, signed in as admin.", { fg: "green" })]
      : [
          text("Couldn't open a browser on this computer.", { fg: "yellow" }),
          text("Open this on this computer instead:", { dim: true }),
          text(local, { fg: "cyan" }),
        ]),
    [],
    text("To make a phone admin instead, scan this with it.", { dim: true }),
    text("Each link works once, for 10 minutes.", { dim: true }),
    [],
    ...(qr ? qr.lines : [text(phoneLink, { fg: "cyan" })]),
  ];
  view.open({ kind: "panel", title: "Open as admin", lines });
}

