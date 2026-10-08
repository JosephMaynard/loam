# 12. Operator's guide: running a LOAM network

> **Audience: the host,** the person who runs LOAM so everyone nearby can talk. This walks through
> choosing a device, starting a network, letting people in, shaping and moderating it, linking it to
> other networks, and erasing it in a hurry. The deeper docs are linked as you go: [02](02-kill-switch.md)
> Emergency reset, [04](04-android-host-app.md) the Android app, [08](08-transport-security.md) transport
> encryption, [09](09-security-profiles.md) security profiles, [11](11-node-sync.md) linking networks.

LOAM has no accounts. The host device runs the whole network; nothing it holds leaves the local
network unless you link it to another LOAM network.

## 1. Choosing a host

| Host | How | Good for |
|---|---|---|
| **Android phone** | the LOAM app ([latest release](https://github.com/MagicZebraLtd/loam/releases/latest)) | Anywhere: the phone makes its own Wi-Fi, so no router or internet is needed. |
| **Mac, Linux or Windows computer** | `npx loamnet` | A laptop already on a Wi-Fi network, or one sharing its own hotspot. |
| **Raspberry Pi** (or any always-on box) | `npx loamnet` | A fixed spot that stays up; a good partner for a phone network to link with. |

iPhones can join any network but can't host one: iOS doesn't let an app start a hotspot, and pauses apps
in the background. A Mac can host with `npx loamnet`.

## 2. Starting a network

### On an Android phone

Install the APK and open LOAM. Setup asks four things:

1. **Language.** For the app and for the network: everyone who joins sees LOAM in it. An admin can
   change it later in the admin area.
2. **Kind of network:**
   - **Community:** anyone nearby can join, people choose a name and photo, messages are kept, and the
     database is encrypted with a key held in the phone's keystore, so it survives a restart.
   - **Private and short-lived:** random names and pictures, messages gone after an hour by default (a
     channel can be set to keep them longer), each person approved before they can join, encrypted
     connections only, and nobody can see who's online. The database key exists only while LOAM runs:
     once LOAM closes or the phone restarts, the network is gone for good (pictures and files are
     deleted the next time LOAM starts).
   - **Choose every setting myself:** standard settings, opening the admin area so you can set
     everything. Stored encrypted unless you turn that off.
3. **Name.** What people see when they join (blank means "LOAM").
4. **How people connect:**
   - **Hotspot:** the phone makes its own Wi-Fi. Works with no router and no internet. Android asks for
     Nearby devices and location permission to start it (LOAM never reads your location).
   - **Wi-Fi:** everyone on the Wi-Fi the phone is already on. No hotspot, no extra permission. Guest,
     hotel and campus Wi-Fi often stop devices reaching each other; if nobody can connect, use Hotspot.
   - **Join another LOAM network:** this phone becomes a second node of a network that's already
     running (see [§6](#6-linking-networks)).

The host phone is the network's admin automatically: the app hands its own screen a one-off token that
nobody on the network can see. The next time you open LOAM it offers **Continue** with the same network,
or **Start a new network**, which erases the old one (press and hold to confirm). A Private network that
has ended just shows setup again.

**The host menu** (top right) has **Invite people** (the join codes), **Encryption**, **AI assistant**,
**Network rules**, **Privacy policy**, **About LOAM** (version, website, email) and, last and in red,
**Emergency reset**.

### On a computer or Raspberry Pi

```bash
npx loamnet                 # or: npm install -g loamnet && loam
```

In a terminal it opens a full-screen view that keeps the join QR on screen, with **Activity**, **People**,
**Settings** and **Debug** screens a number key away (`?` lists the keys). **Press `o` to become admin:**
your browser opens LOAM already signed in as admin, through a link that works once, for 10 minutes; press
`p` in that dialog for a QR that makes a phone admin instead (it stops working when the dialog closes). Nobody becomes admin by opening a new network
first. Your admin identity lives in that browser, so keep using it. **People → m** makes anyone who has
joined an admin too.

**Kiosk mode** (`k`, or start with `--kiosk`) leaves only the join QR, the network's name and the number
of connected devices on screen until a password is entered, for a computer left out for people to join
from. On an approval network its QR lets people straight in. It locks the screen, not the computer, so on a
machine left alone run `exec loam --kiosk` under its own user account. Without a terminal (a service) or
with `--plain`, `loam` prints the address and the QR instead; while nobody is admin, a one-time admin link
is printed (in a terminal) or written to `admin-link.txt` in the data folder (for a service), never to the
log. Useful options (`loam --help` has them all):

| Option | Effect |
|---|---|
| `--port <n>` | Listen on another port (default 3000, or the next free one). |
| `--data-dir <dir>` | Where the data lives (default `$XDG_DATA_HOME/loam` or `~/.loam`). |
| `--encrypt` | Encrypt the database (pictures and files are stored beside it, unencrypted). The passphrase comes from `$LOAM_DB_KEY` or a prompt; `--encrypt ephemeral` uses a key that lives only in memory. |
| `--kiosk` | Start locked in kiosk mode. |
| `--plain` | Print the QR and addresses instead of the full-screen view. `--verbose` adds a line per request. |

The terminal's **Settings** screen changes the main network settings live (the same ones as the web
admin's) and remembers the port, a pinned join address and kiosk mode for the next start, in `cli.json` in
the data folder.

A node run some other way (`pnpm --filter @loam/server start`, for one) uses the **bootstrap** strategy
from the config file or **Admin → Bootstrap**:

| Strategy | How admin is claimed |
|---|---|
| `firstUser` (default) | The first person on a new network. |
| `setupCode` | A one-time code printed in the server log at start-up, entered in **Settings → Admin access**. |
| `passphrase` | A secret from the config, entered the same way. Stored hashed, never in the clear. |
| `none` | Nobody can claim admin. |

(The Android app and `loamnet` use their own `hostDevice` strategy, whatever is configured: admin comes
from the host's own screen.)

## 3. Letting people in

**The code is the whole invitation.** People connect to the same Wi-Fi or hotspot, scan the code, and
LOAM opens in their browser. Nothing to install, no account, and the code carries the network's
encryption key, so their messages are encrypted from the first request. (Pictures and files are
encrypted too only when the network requires encryption: see **Connections** in [§4](#4-shaping-the-network).)

- **From the host phone:** **Invite people** in the host menu shows the codes. On Hotspot there are two, the hotspot's
  Wi-Fi first and then LOAM; on Wi-Fi there's one. The address is printed beside it for anyone who'd
  rather type. **Display mode** shows the codes full screen, as large as the screen allows, keeps the
  screen on and pins LOAM in front; press and hold to leave it. The network keeps running with the
  screen off either way.
- **From inside LOAM:** admins and greeters have **Invite someone** in the sidebar, with the code, a
  **Copy link** button and a note on how to join. It includes the encryption key only when that device
  joined by scanning, so a key can't be passed on second-hand.

**Approval.** On a network that approves newcomers (Private does), people who join wait on a "You're in
the queue" screen until an admin or greeter lets them in from **People and moderation → Pending
joins** (**Approve**, or **Deny**, which bans them). Give someone the **greeter** role so you aren't the
only one at the door. The host phone's code also carries an **invite code** that lets people straight
in. It changes every 10 minutes, so a photo of an old one stops working within 20, and an Emergency
reset retires them all.

## 4. Shaping the network

Everything is in the admin area, **Admin** in the sidebar (`/admin`, "Node configuration"), saved with
one **Save** at the bottom. Changes reach connected phones at once.

**Name.** In **Network**: shown in the sidebar and on the join screen. "Camp 3" or "Riverside Outage"
tells people they're in the right place.

**Profile.** The quickest way to a consistent setup. A named profile sets these together and locks them
until you switch back to **Custom** ([docs/09](09-security-profiles.md)):

| Profile | Who can join | Messages kept | Emergency reset from the admin area | Connections |
|---|---|---|---|---|
| **Open** / **Standard** | anyone | until deleted | off | encrypted for everyone who scans |
| **Hardened** (the Private network) | approved first | 1 hour by default (a channel can keep longer) | on | encrypted only; others refused |
| **Custom** (the default) | your choice | your choice | your choice | your choice |

(Open and Standard currently set the same things.)

**Connections.** **Optional** encrypts the messages of everyone who joins by scanning, but downloads
pictures and files unencrypted, and still lets in a device that typed the address by hand, unencrypted.
**Required** encrypts pictures and files too, refuses those devices, and hides which pages anyone asks
for. There is no "off": only a developer debugging mode (`LOAM_DEV_MODE`, never on a
released app) runs unencrypted, and it shows everyone a red warning ([docs/08](08-transport-security.md)).

**The other settings:**

- **Messaging:** public, private and user-made channels, replies, direct messages, reactions,
  formatting, pictures and files. Turning one off stops it on the server, not just in the app.
- **Identity:** whether people can change their name and picture or upload a photo.
- **Message retention:** delete messages after a set time (blank keeps them).
- **Presence:** shows who's online. It's on by default; **turn it off when that is itself sensitive**,
  because it tells anyone watching who is here right now. The Private network has it off.

**Storage encryption on the host phone** is under **Encryption** in the host menu: **Encrypted
(recommended)** with a keystore-held key, **Encrypted, new key every start**, **Encrypted with a
passphrase** (asked at every start, never stored), or **No encryption (for testing)**, which asks you to
confirm. Encryption applies to a new database, so switching erases what's on the phone.

## 5. Managing people

**People and moderation** (`/people`) is for admins, moderators and greeters:

| Action | Who | Effect |
|---|---|---|
| **Ban / Unban** | admin, moderator | Locks the person out and ends their sessions. |
| **Shadow-ban** | admin, moderator | They can still post, but only they see their new messages. |
| **Timeout** | admin, moderator | Mutes them for up to 7 days, timed on the host's clock. |
| **Remove a message** | admin, moderator | Readers see "removed by a moderator" (with an optional reason); it can't be edited, replied to or reacted to afterwards. |
| **Moderator / Greeter role** | admin | Moderation powers, or letting people in. |
| **Make admin** | admin | Promotes someone to admin. There's no demote: see the end of this guide. |
| **Delete a message** | admin (any), author (their own, if nobody else has replied) | Removes it everywhere; a linked network can't bring it back. |

Admins can't be moderated, and nobody can moderate themselves. Roles never travel to a linked network: a
moderator there is a stranger here.

**Reports.** Anyone can report a message or a person; reports go to the moderators.

**Blocking** is personal, not moderation. Anyone can block someone from their direct message (and unblock
them there or in **Settings → Blocked people**). It stops direct messages both ways, and on the blocker's
phone that person's posts collapse to "Message from a blocked user" (with **Show**) and their reactions
and typing disappear. Nobody else sees the block list, it never leaves the network, and the blocked
person isn't told, though they may work it out. It doesn't replace a report: only moderators can ban,
time out or remove messages.

## 6. Linking networks

Two LOAM networks that can reach each other can share their **public channels** both ways, so separate
hotspots become one conversation. Only messages in open public channels are sent: an archived channel's
messages stay where they are. Direct messages, private channels and anything from a shadow-banned person
never leave either network.

**With a link code** (the usual way). On the network that's already running, show a link code: on the
host phone, **Invite people → Link another LOAM node → Show a link code**; in the admin area,
**Node-to-node sync → Link another node**. On the other phone, during setup choose **Join another LOAM
network** and scan it. That's all: the two networks sync from then on, with nothing to approve. A code
works once, for 10 minutes, so show it only to the phone you mean to link. The plain join code can't link
a network.

**By hand.** In **Admin → Node-to-node sync**, turn sync on and add a peer by its join address, then
**Sync now**. Each side pulls from the other only if it lists the other, so add it on both. A **shared
mesh token** limits sync to networks that know it.

**What phones can do** ([docs/11](11-node-sync.md)): two phones each running a hotspot usually can't see
each other. Linking works when one network can reach the other: a phone on the other's hotspot or Wi-Fi,
or both on the same Wi-Fi. Taking turns works on every phone: join the other network's Wi-Fi for a minute
to catch up, then go back.

Linking shares your public channels with the networks you link, and a linked network keeps what it has
already pulled: an Emergency reset here doesn't reach it.

## 7. Emergency reset

Erasing a network deletes every message, person, picture and file, and tells every phone connected to it
to clear its copy and show a neutral disconnected screen. A phone that was offline clears its copy the
next time it reaches the network.

- **On the host phone:** **Emergency reset** is the last item in the host menu, in red, and also at the
  bottom of **Encryption**. Press and hold for three seconds. When it has finished, LOAM closes
  completely, and next time it opens on setup. If something couldn't be erased, the screen says so and
  stays open: closing LOAM and opening it again finishes the job.
- **From the admin area:** **Emergency Reset**, once enabled there (the Hardened profile enables it).
  The settings survive, so the network starts again empty. Sync settings survive too: if this network is
  linked, the next sync round pulls the linked networks' public channels back in. To keep it empty, turn
  sync off or remove the peers first. On a computer using a fixed passphrase, the shared mesh token isn't
  kept (it's never written to disk unencrypted): set it again before syncing with networks that need it.
- **Without logging in:** set a **panic token** (16 characters or more) in the same panel, and a request
  to `POST /api/panic` with it erases the network, from a bookmark or another device. The token is stored
  hashed, and the address answers "not found" unless a token is set.

**How thorough it is.** With an encrypted database, the files are deleted and the key is replaced (on the
host phone, and on a computer using a key that lives only in memory), so whatever is left on the storage
can't be read. A computer using a fixed passphrase deletes the files but keeps the passphrase. Without
encryption it's an ordinary delete, which can leave traces on flash storage ([docs/02](02-kill-switch.md)).

**Be honest about the limits.** This raises the bar; it doesn't guarantee safety. A host taken while it's
running, with the key in memory, can give up what it holds, and the host can always read every message.
See [`SECURITY.md`](../SECURITY.md).

## Decisions recorded here

- **No "demote admin" button.** Removing an admin means starting a new network (or an Emergency reset),
  not one admin stripping another, so two admins can't race to remove each other. Promote with care.
- **Presence defaults on, off when it matters.** Seeing who's online is useful day to day and sensitive
  when people are at risk, so the Private network turns it off.
- **Linking is between networks, not people.** A linked network's public content is trusted enough to
  import (checked against the schema; private data and moderation never cross), deletes don't travel, and
  linking deliberately shares your public channels with the networks you choose.
- **Pictures behind unguessable addresses.** Profile pictures are served under long random ids with no
  further check, matching the trusted-host model. Message attachments use the same ids but are also
  limited to the people who may read their message: public ones are open (so linked networks can copy
  them), direct-message and private-channel ones are not.
