/**
 * People: who has joined, who is online, who is waiting. The one thing done from here is making someone an
 * admin (approving them first if they were waiting); everything else about people (approvals, bans,
 * channels) happens in the web app.
 *
 * Anyone can choose any display name, so each row also shows the end of the person's id and when they
 * joined, and a name shared by two people is flagged: copying someone's name mustn't be enough to be
 * promoted in their place.
 */
import type { HostUser } from "@loam/schema";

import { type Line, padEnd, text } from "../ansi.js";
import { isChar } from "../keys.js";
import type { Screen, View } from "../types.js";
import { clock } from "./activity.js";

/** The last characters of an id: enough to tell two people with the same name apart. */
export function shortId(id: string): string {
  return id.slice(-6);
}

/** Display names used by more than one person. */
function sharedNames(users: HostUser[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const user of users) {
    const name = user.displayName.trim().toLowerCase();
    (seen.has(name) ? shared : seen).add(name);
  }
  return shared;
}

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
    const nameWidth = Math.max(16, Math.min(40, width - 50));
    const shared = sharedNames(users);
    users.slice(first, first + room).forEach((user, offset) => {
      const index = first + offset;
      const chosen = index === state.selected;
      lines.push([
        { text: chosen ? " › " : "   ", style: { fg: "cyan" } },
        { text: user.online ? "● " : "○ ", style: { fg: user.online ? "green" : "gray" } },
        { text: padEnd(user.displayName, nameWidth), style: chosen ? { inverse: true } : undefined },
        { text: `  …${shortId(user.id)}  joined ${clock(user.createdAt)}  `, style: { dim: true } },
        ...badges(user),
        ...(shared.has(user.displayName.trim().toLowerCase())
          ? [{ text: "same name as someone else", style: { fg: "yellow" as const } }]
          : []),
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
  const sameName = view.options.host
    .users()
    .filter((other) => other.id !== user.id && other.displayName.trim().toLowerCase() === user.displayName.trim().toLowerCase()).length;
  view.open({
    kind: "confirm",
    title: `Make ${user.displayName} an admin?`,
    body: [
      `Id ending …${shortId(user.id)}, joined at ${clock(user.createdAt)}, ${user.online ? "online now" : "not online"}.`,
      ...(sameName
        ? [
            `${sameName === 1 ? "Someone else uses" : `${sameName} others use`} this name too. To make your own browser or phone admin, use o on the Join screen instead: its link can't pick the wrong person.`,
          ]
        : []),
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
