/**
 * Join (the home screen): the join QR, kept on screen, with the addresses beside it. From here the operator
 * hides the QR, picks which network address to advertise, and opens LOAM in the browser as admin.
 */
import { type Line, type Style, text } from "../ansi.js";
import { isChar } from "../keys.js";
import { breakLink, wrap } from "../modal.js";
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
    ...paragraph("Join from a phone or laptop on this network", width, { dim: true }),
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

    if (!view.state.qrHidden && !qr) {
      // Too long to encode: hand out the whole link, key (and invite) included, or a joiner would lose the
      // protection the QR gives, and couldn't join a network that requires it at all.
      return [
        [],
        text("  This join address is too long for a QR code. Share this whole link instead:", { fg: "yellow" }),
        ...breakLink(view.joinLink(), Math.max(20, width - 4)).map((piece) => text(`  ${piece}`, { fg: "cyan" })),
        [],
        ...info,
      ];
    }
    const note = view.state.qrHidden
      ? "The QR code is hidden. Press h to show it."
      : "Make this window a little bigger to show the QR code (or press k: kiosk mode uses the whole window).";
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
      // In use now either way; only remembering it for the next start can fail.
      const remembered = view.saveSettings({ ...view.settings, joinHost: address });
      if (remembered) {
        view.toast(address ? `Joiners now use ${address}` : "Join address is picked automatically");
      }
    },
  });
}

/**
 * Open LOAM in this computer's browser, already admin. A phone can be made admin instead, but only on a
 * second, deliberate key: its QR is drawn on the same screen strangers scan to join, so it isn't shown
 * unasked, it says what it does, and its code is retired as soon as the dialog closes.
 */
export async function openAsAdmin(view: View): Promise<void> {
  const { host, system } = view.options;
  const key = host.transportPublicKey();
  const fragment = (code: string) => `#${key ? `k=${key}&` : ""}a=${code}`;
  const localCode = host.adminClaimCode();
  if (!localCode) {
    view.toast("This node can't hand out admin links (it was started without a host token).", "error");
    return;
  }
  const local = `${view.localUrl()}${fragment(localCode.code)}`;
  const opened = await system.openUrl(local);

  let phone: { code: string; link: string; qr: QrBlock | undefined } | undefined;
  view.open({
    kind: "panel",
    title: "Open as admin",
    get footer() {
      return phone ? "Esc to close (the phone's code stops working)" : "p make a phone admin instead · Esc to close";
    },
    lines: (width, height) => {
      const intro = opened
        ? paragraph("LOAM is opening in your browser, signed in as admin. The link works once, for 10 minutes.", width, { fg: "green" })
        : [
            ...paragraph("Couldn't open a browser on this computer. Open this on this computer instead (it works once, for 10 minutes):", width, { fg: "yellow" }),
            ...breakLink(local, width).map((piece) => text(piece, { fg: "cyan" })),
          ];
      if (!phone) {
        return [...intro, [], ...paragraph("Or press p to show a QR code that makes a phone admin.", width, { dim: true })];
      }
      return withQrIfItFits(
        [
          ...intro,
          [],
          ...paragraph(
            "Anyone who scans this becomes an admin, and an admin can't be removed. It works once, and stops working when you close this.",
            width,
            { fg: "yellow", bold: true },
          ),
        ],
        phone.qr,
        phone.link,
        width,
        height,
      );
    },
    onKey(pressed) {
      if (phone || !isChar(pressed, "p")) {
        return false;
      }
      const code = host.adminClaimCode();
      if (code) {
        const link = `${view.joinUrl()}${fragment(code.code)}`;
        phone = { code: code.code, link, qr: qrBlock(link) };
      }
      return true;
    },
    onClose() {
      if (phone) {
        host.revokeAdminClaimCode(phone.code);
      }
    },
  });
}

/** `value` word-wrapped to `width`, one style throughout. */
export function paragraph(value: string, width: number, style?: Style): Line[] {
  return wrap(value, width).map((line) => text(line, style));
}

/** `before`, then the QR when it fits whole in the room left, else the link as text. */
export function withQrIfItFits(before: Line[], qr: QrBlock | undefined, link: string, width: number, height: number): Line[] {
  if (qr && qr.width <= width && before.length + 1 + qr.lines.length <= height) {
    return [...before, [], ...qr.lines];
  }
  return [
    ...before,
    [],
    ...breakLink(link, width).map((piece) => text(piece, { fg: "cyan" })),
    ...paragraph("Make the window bigger to show this as a QR code.", width, { dim: true }),
  ];
}

