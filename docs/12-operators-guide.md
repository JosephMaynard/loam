# 12 — Operator's guide (running a LOAM node)

> **Audience: the host.** The one person who runs LOAM on a device so everyone nearby can talk. This
> is the end-to-end walkthrough — choose a device, become admin, shape the network, invite people,
> moderate, mesh with other nodes, and lock it down in an emergency. It ties together the deeper docs
> ([02](02-kill-switch.md) kill switch, [04](04-android-host-app.md) Android host, [09](09-security-profiles.md)
> security profiles, [11](11-node-sync.md) node sync); reach for those when you want the full story.

LOAM has **no accounts and no setup wizard**. You start a server, the first person to open it becomes
the admin, and everything else is configured live from the in-app admin area. Nothing leaves the local
network.

## 1. Choosing a host

Any device that can run the server and offer a network the others can reach works. Three shapes:

| Host | Command | Good for |
|---|---|---|
| **Laptop / desktop** | `pnpm build && pnpm --filter @loam/server start` | Quick setup where a laptop is already on the LAN or hotspot. |
| **Raspberry Pi** (or any always-on Linux box) | same as above | A fixed-site node that stays up; pairs well with node-to-node sync. |
| **Android phone** | `pnpm --filter app apk` → install → **Share · Host** | Truly off-grid: the phone runs the embedded server *and* raises its own WiFi hotspot. |

**Laptop / Pi.** After `pnpm build`, `pnpm --filter @loam/server start` serves the built client and the
API from **one origin**, defaulting to **`PORT=3000`**. People join by pointing a browser at
`http://<this-device-lan-ip>:3000`. The device must offer a network the others share — join them to the
same router, or run a hotspot on the host. (In dev, `pnpm dev` splits the client onto `:3000` and the
server onto `:3001` and prints a join QR to the terminal — handy for testing, not how you run it for
real.)

**Android phone.** `pnpm --filter app apk` builds `apps/app/loam-host.apk`; `adb install -r` it onto the
phone, launch **LOAM**, and tap **Share · Host**. The app brings up a local-only WiFi hotspot, runs the
server on the phone, and shows the join QR. See [docs/04](04-android-host-app.md) for the full build and
join flow. Note: on-device database encryption isn't available on Android yet — the phone stores its DB
unencrypted (docs/04).

**Environment variables** (laptop/Pi; the Android host sets its own):

| Var | Effect |
|---|---|
| `PORT` | Port the server listens on (default `3000` in production). |
| `HOST` / `LOAM_JOIN_HOST` | Bind address / the host used in the printed join URL. |
| `LOAM_DATA_DIR` | Where the `.loam/` data dir (DB + avatars) lives. |
| `LOAM_CONFIG_FILE` | Path to a JSON config file to seed defaults (otherwise `.loam/config.json`). |
| `LOAM_DB_KEY` | **Encryption at rest.** Unset = plain SQLite. A passphrase = SQLCipher (AES-256), same passphrase needed on every start. `ephemeral` = a random in-memory key that never touches disk. See §7. |

## 2. First run — becoming admin

By default the node uses the **`firstUser`** admin bootstrap: **the first person to open the app on a
fresh node becomes the admin.** So open the app yourself, first, before you hand the QR around. That's
it — no password. Your admin identity is the server session cookie in that browser; keep that browser/
device.

Once you're admin, the **admin area lives at `/admin`** ("Node configuration"), reachable from
**Settings → Admin tools → Open the admin area**. People management is a separate view at `/people`
("People and moderation").

If you'd rather not rely on "whoever opens it first," change the bootstrap strategy in the config file
or in **Admin → Bootstrap**:

| Strategy | How admin is claimed |
|---|---|
| `firstUser` (default) | First session on a fresh node is admin automatically. |
| `setupCode` | A one-time code is logged to the server console at startup; enter it in **Settings → Admin access**. |
| `passphrase` | A reusable secret from config; same **Settings → Admin access** box. |
| `none` | No in-app claiming; nobody becomes admin. |
| `hostDevice` | Reserved for the Android host. |

`setupCode`/`passphrase` are exchanged via **Settings → Admin access → "Setup code or passphrase" →
Unlock admin**. Claiming is rate-limited and the secret is constant-time compared; a stored passphrase
is scrypt-hashed, never kept in the clear.

## 3. Naming and shaping your network

Everything below is edited in **Admin → Node configuration** and saved with one **Save** at the bottom;
changes broadcast live to connected clients (`configUpdated`).

**Name it.** In the **Network** panel, set the node name (config key `node.name`, default `LOAM local`).
It's shown to everyone in the client sidebar and on the join screen — call it "Camp 3 Mesh" or
"Riverside Outage" so joiners know they're in the right place.

**Pick a security posture.** The **Profile** panel is the fastest way to get a coherent configuration.
A named profile is *authoritative* — it forces its bundled axes and locks those individual controls
until you switch back to **Custom** (docs/09):

| Profile | Who can join | Retention | Kill switch |
|---|---|---|---|
| **Open** | anyone, immediately | kept forever | off |
| **Standard** | anyone with the link | kept forever | off |
| **Hardened** | approval required | messages expire after **1 hour** | **armed** |
| **Custom** *(default)* | set each axis yourself | set yourself | set yourself |

Open and Standard apply the **same enforced settings today** — the axes that would separate them
(transport encryption, invite tokens) aren't built yet, so they differ only in intent. `custom` is the
default so a fresh node never has its raw settings silently overridden.

**The individual axes** (editable under Custom, or forced by a profile):

- **Messaging features** — toggle public/private/user channels, replies, DMs, reactions, markdown,
  image attachments. These are enforced server-side, not just hidden.
- **Identity permissions** — whether users may edit their display name/avatar or upload avatar images,
  and whether admins may edit other users.
- **Message retention** — delete messages after N minutes (blank = keep forever). Expired messages are
  reaped from the node and connected clients roughly every 30s. The proactive companion to the kill
  switch.
- **Kill switch + panic token** — see §7.
- **Presence** — the `enablePresence` flag (default **on**) shows a dot next to members who are
  currently connected. **Turn it off for high-risk deployments** — presence reveals who is online right
  now, which is exactly the metadata a hostile observer wants. Hardened operators should disable it.

## 4. Inviting people

**The join QR is the whole invite.** Greeters and admins get an **Invite someone** control in the
sidebar that expands the node's join URL as a QR plus the URL text; the same URL appears under
**Settings → Join this LOAM node**. Anyone already on the LAN/hotspot scans it (or types the URL) and
the PWA opens — no install, no account. WiFi credentials themselves are shared out-of-band (or by the
Android hotspot); the QR only carries the URL.

**Join policy** decides what happens next:

- **Open** — the joiner participates immediately.
- **Approval** — the joiner lands in a "You're in the queue" holding screen until a greeter or admin
  approves them. Pending people can't read or post.

Under approval, **Admin/greeter → People and moderation → Pending joins** lists everyone waiting, with
**Approve** (let them in) and **Deny** (bans them and drops their session). Delegate this by granting the
**greeter** role (§5) so you're not the only one letting people in.

## 5. Managing people

**People and moderation** (`/people`) is open to admins, moderators, and greeters. The moderator roster
(`GET /api/moderation/users`) lists every human — including banned and shadow-banned people so you can
reverse it — with per-person controls:

| Action | Who can do it | Effect |
|---|---|---|
| **Ban / Unban** | admin, moderator | Locks the person out entirely and tears down their sessions. |
| **Shadow-ban** | admin, moderator | They can still post, but their new messages are broadcast only back to themselves. Quietly defuses a spammer. |
| **Moderator / Greeter role** | admin only | Grant moderation powers or greeter (approve-joins) powers. |
| **Make admin** | admin only | Promote a member to a full admin. |
| **Delete a message** | admin (any message); author (their own, if no one else has replied) | Removes it from the node and every client; a tombstone stops sync re-importing it. |

Admins and yourself can't be moderated (no self-ban, no banning another admin). Roles and moderation
state are stripped from any profile that arrives over sync — a peer's moderator is a stranger here.

**On promoting admins:** there is **deliberately no "demote admin" button.** Admin is a trust ceiling,
not a dial — removing an admin is done by re-bootstrapping the node (or firing the kill switch and
starting fresh), *not* by one admin stripping another. This avoids mutual-demotion wars where two
admins race to remove each other. Promote carefully.

## 6. Linking nodes into a mesh

Two LOAM nodes that can reach each other can **sync their public channels** so separate hotspots
converge into one conversation. It's off by default; turn it on in **Admin → Node-to-node sync**.

**Pairing.** The panel shows **this** node's link address as a QR + copy button ("Link another node") —
it's the *same* URL as the join QR. To pair, take a peer's link address (scan its QR or paste its URL,
`http://192.168.0.10:3000`) into **Add peer**, save, and hit **Sync now**. Two nodes that each list the
other converge in both directions.

**What syncs, and what never does:**

- **Syncs:** posts, replies, and reactions in **public, non-archived** channels, plus the author
  profiles needed to render them (stripped of admin/role/moderation state).
- **Never leaves a node:** DMs, private channels and their member lists, in-flight LLM streams, and
  messages by shadow-banned authors.
- **Tombstones:** a deletion here is remembered so a peer that still holds the message can't hand it
  back. But **deletes don't propagate** — each operator moderates their own node, and a peer keeps
  whatever it already pulled. A kill switch wipes *this* node only.

**The phone reality** (see [docs/11](11-node-sync.md) for the full table):

- **Sequential "courier" sync always works.** Pause your hotspot, join the other node's WiFi, let the
  pull loop catch up, resume. Works on every phone; your own clients drop for a minute.
- **Simultaneous hotspot + join** (host and connect at once) is **device-dependent** — many newer
  Android phones manage it, budget/older hardware may not.
- **No cellular peer-to-peer.** Two phones on mobile data can't reach each other without an internet
  relay, which is against LOAM's off-grid design. Not planned.

Enabling sync exposes this node's public content to anyone who can reach it while it's on — an explicit
operator choice. There's no peer authentication yet, so hardened deployments should leave it off or pair
it with approval joins. Depth and limits are in [docs/11](11-node-sync.md).

## 7. Emergency posture

For the protest / surveillance threat model, layer these — and be honest that they raise the bar rather
than guarantee safety (a host seized while powered on, with the key in RAM, is still the weak case).

**Encryption at rest** (`LOAM_DB_KEY`, laptop/Pi only for now):

- **unset** — plain SQLite on disk.
- **a passphrase** — SQLCipher (AES-256); the same passphrase is required on every start.
- **`ephemeral`** — a random key generated in memory, **never written to disk**. Data is readable only
  while the process runs; a reboot loses the key forever.

**Kill switch** (**Admin → Kill switch**, or armed automatically by the Hardened profile). Firing it:

1. deletes all messages, users, sessions, and avatars on the node,
2. remotely **purges every connected client** (IndexedDB, localStorage, service-worker caches) and drops
   them to a neutral "Disconnected" screen,
3. re-seeds defaults so the node is usable again. **Node config survives**, so the switch can fire again.

With encryption on, the wipe is *cryptographic*: it closes the store, deletes the DB files, and (in
`ephemeral` mode) rotates to a fresh key, so bytes still physically on flash become unreadable. Without
encryption it's a logical `DELETE` — recoverable pages may remain on flash (docs/02).

**Panic token.** Set a token (≥16 chars) in the kill-switch panel to enable an unauthenticated
`POST /api/panic` — fire the wipe from a bookmark or second device without logging into the admin UI
during a raid. The token is scrypt-hashed, so a seized config doesn't reveal it; the endpoint 404s
entirely unless a token is configured. Require typed confirmation (default on) for team use; leave it off
for the one-tap raid case.

**What survives a wipe, and what peers keep.** A kill switch wipes *your* node and *its* connected
clients — not other people's phones that have since disconnected, and **not peer nodes**. If you enabled
sync, a peer keeps every public message it already pulled. That is the point of a mesh, and worth knowing
before you both enable sync *and* rely on the kill switch.

## Decisions recorded here

- **No "demote admin" button.** Admin removal is intentionally out of the moderation UI — it happens via
  re-bootstrap or the kill switch. Rationale: prevent mutual-demotion wars between admins. Promote with
  care; there is no undo short of re-bootstrapping.
- **Presence defaults on, disable when hardened.** The online-dot (`enablePresence`) is on by default for
  ordinary use, but it leaks who is currently connected — high-risk operators should turn it off.
- **Sync trust model is node-level and pull-only.** A peer's public content is trusted enough to import
  (schema-validated, private data and moderation state never cross); there's no peer authentication yet,
  deletes don't propagate, and enabling sync deliberately exposes this node's public content to anyone
  who can reach it.
- **Unguessable-URL model for images.** Avatar images (`/api/avatars/…`) are served behind long random
  ids with no per-request authorization — anyone on the LAN who has the id can fetch one, consistent with
  the public, trusted-host model. Message **attachments** (`/api/attachments/…`) use the same random-id
  scheme but are additionally *audience-gated to their owning message*: attachments on public messages are
  anonymously fetchable (so peer nodes can copy them), while DM / private-channel attachments are served
  only to people who may read that message.
