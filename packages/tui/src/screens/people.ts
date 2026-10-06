/**
 * People: who has joined, who is online, who is waiting. The one thing done from here is making someone an
 * admin (approving them first if they were waiting); everything else about people (approvals, bans,
 * channels) happens in the web app.
 */
import type { HostUser } from "@loam/schema";

import { type Line, padEnd, text } from "../ansi.js";
import { isChar } from "../keys.js";
import type { Screen, View } from "../types.js";

function badges(user: HostUser): Line {
  const line: Line = [];
  if (user.isAdmin) line.push({ text: "admin ", style: { fg: "cyan" } });
  if (user.pending) line.push({ text: "waiting ", style: { fg: "yellow" } });
  if (user.banned) line.push({ text: "banned ", style: { fg: "red" } });
  return line;
}

export const peopleScreen: Screen = {
  id: "people",
  title: "People",
  hints: () => "↑↓ choose · m make admin · ? help",
  render(view, width, height) {
    const users = view.options.host.users();
    const { people } = view.status;
    const lines: Line[] = [
      text(
        ` ${people.total} ${people.total === 1 ? "person" : "people"} · ${people.online} online` +
          (people.pending ? ` · ${people.pending} waiting for approval` : ""),
        { bold: true },
      ),
      text(" Approvals, bans and channels are in the web app. On the Join screen, o opens it as admin.", { dim: true }),
      [],
    ];
    if (!users.length) {
      lines.push(text(" Nobody has joined yet.", { dim: true }));
      return lines;
    }
    const state = view.state.people;
    state.selected = Math.max(0, Math.min(state.selected, users.length - 1));
    const room = Math.max(1, height - lines.length);
    const first = Math.max(0, Math.min(state.selected - Math.floor(room / 2), users.length - room));
    const nameWidth = Math.max(16, Math.min(40, width - 30));
    users.slice(first, first + room).forEach((user, offset) => {
      const index = first + offset;
      const chosen = index === state.selected;
      lines.push([
        { text: chosen ? " › " : "   ", style: { fg: "cyan" } },
        { text: user.online ? "● " : "○ ", style: { fg: user.online ? "green" : "gray" } },
        { text: padEnd(user.displayName, nameWidth), style: chosen ? { inverse: true } : undefined },
        { text: "  " },
        ...badges(user),
      ]);
    });
    return lines;
  },
  key(view, key) {
    const state = view.state.people;
    if (key.name === "up") {
      state.selected = Math.max(0, state.selected - 1);
      return true;
    }
    if (key.name === "down") {
      state.selected += 1;
      return true;
    }
    if (isChar(key, "m")) {
      const user = view.options.host.users()[state.selected];
      if (user) {
        makeAdmin(view, user);
      }
      return true;
    }
    return false;
  },
};

function makeAdmin(view: View, user: HostUser): void {
  if (user.isAdmin && !user.pending) {
    view.toast(`${user.displayName} is already an admin`);
    return;
  }
  view.open({
    kind: "confirm",
    title: `Make ${user.displayName} an admin?`,
    body: [
      ...(user.pending ? ["They are waiting for approval; this lets them in too."] : []),
      "Admins can change every setting, remove people and wipe the network. This can't be undone from LOAM: an admin stays an admin.",
    ],
    yes: "make admin",
    onYes() {
      const result = view.options.host.makeAdmin(user.id);
      view.toast(result.ok ? `${user.displayName} is now an admin` : result.error, result.ok ? "ok" : "error");
    },
  });
}
