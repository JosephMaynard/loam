# loamnet

Run a local, off-grid [LOAM](https://github.com/MagicZebraLtd/loam) messaging node from your terminal. One command starts a server and a web app; anyone on the same network scans the printed QR code to join. No internet, no accounts, no cloud.

LOAM is local communication for places where the internet is missing, overloaded, or simply not the right tool: a festival or conference, a boat or campsite, a community space, or a neighbourhood during an outage. The host runs a node; nearby people join over the LAN and can post to channels, reply in threads, send direct messages, react, and share images. Identities are anonymous and ephemeral, and everything stays on your machine and your local network.

## Quick start

```
npx loamnet
```

Or install it and run the `loam` command:

```
npm install -g loamnet
loam
```

From a phone or laptop on the same Wi-Fi or hotspot, scan the QR code (or open the address shown beside it). That device joins the node instantly. Requires Node.js 22.14 or newer (23.6 or newer on the 23 line).

## The terminal screen

In a terminal, `loam` takes over the window (like `top`; your scrollback comes back when it stops) and keeps the join QR on screen. Five screens are a number key away, and `?` lists every key:

1. **Join**: the QR code and the addresses. `o` opens LOAM in your browser as the network's admin (and, if you then press `p`, shows a QR that makes a phone admin), `a` picks which network address to advertise when the computer has more than one, `h` hides the QR.
2. **Activity**: requests and server messages as they happen. `e` shows only problems, space pauses.
3. **People**: who has joined and who is online. `m` makes someone an admin.
4. **Settings**: the network's name, security profile, who can join, encryption, how long messages last, and more, changed live. Also a link code for joining another LOAM network, Emergency Reset, and what to remember for next time (port, kiosk mode).
5. **Debug**: versions, how the node is set up, recent problems, detailed logging, and a diagnostics file to attach to a bug report (it holds no messages or names, and network addresses, hostnames, folder paths and ids are blanked out).

Messages, approvals and moderation happen in the web app.

**Becoming admin.** Nobody becomes admin by being first to open a new network. Press `o` on the Join screen: your browser opens LOAM already signed in as admin, using a link that works once, for 10 minutes. Or make anyone who has joined an admin from the People screen, which shows the end of each person's id and flags names that two people share.

**Kiosk mode.** Press `k` (or start with `--kiosk`) and choose a password: the screen then shows only the join QR, the network's name and how many devices are connected, and every key does nothing but offer the unlock prompt (`q` and Ctrl-C included). Settings can make it start locked every time. On a network that approves newcomers, the kiosk's QR lets people straight in, as the host phone's does. It locks this screen, not the computer: anyone at an unlocked keyboard can still close the window or open another terminal. For a computer left alone, run it as `exec loam --kiosk` (so closing it doesn't leave a shell behind) under its own user account.

**Without a terminal** (a service, or output sent to a file), or with `--plain`, `loam` prints the addresses and the QR code instead. While nobody is admin it keeps a one-time admin link on hand, renewed every 10 minutes: printed in a terminal, otherwise written to `admin-link.txt` in the data folder, readable only by you, and never to the log. Settings chosen on the terminal screen that apply at start-up (the port, the join address, kiosk mode) are kept in `cli.json` in the data folder; flags and environment variables win over them.

## Options

```
loam [options]

  --port <n>        Port to listen on (default $PORT, else 3000 or the next
                    free port after it)
  --data-dir <dir>  Where to store the SQLite database and avatars
                    (default $XDG_DATA_HOME/loam or ~/.loam)
  --encrypt         Encrypt the database at rest with SQLCipher. The passphrase
                    comes from $LOAM_DB_KEY if set; otherwise you are prompted
                    for it (not echoed). For a new database, an empty answer,
                    or no terminal to prompt on, uses an ephemeral RAM-only key
                    that is discarded on exit. An existing database needs its
                    passphrase.
  --encrypt ephemeral
                    Use an ephemeral RAM-only key without prompting.
  --encrypt <pass>  Use <pass> directly. Discouraged: other users can see it in
                    `ps` and it lands in your shell history.
  --kiosk           Start locked in kiosk mode: only the join QR shows until the
                    kiosk password is entered (you choose one if none is saved)
  --plain           Print the join QR and addresses instead of the full-screen
                    view (automatic when there is no terminal)
  --verbose         In plain mode, also print a log line for every request
  -h, --help        Show help
```

For a persistent encrypted node, prefer `LOAM_DB_KEY='your passphrase' loam --encrypt`, or run bare `loam --encrypt` and type the passphrase at the prompt. Encryption needs the optional native driver, which installs with `loamnet` and ships prebuilt for 64-bit Linux, macOS and Windows, so nothing compiles during install. If it isn't available, `loam` stops before starting and prints the fix: on those platforms, reinstall `loamnet` (`npm install -g loamnet`); elsewhere (such as 32-bit Raspberry Pi OS), build the driver in place with `node-gyp`. Installing the driver separately doesn't help, because `loam` loads it from its own package.

The default database driver is Node's built in `node:sqlite`, so a plain node needs no native build step. Encryption at rest (`--encrypt`) is the one feature that pulls in the optional native SQLCipher driver.

## What you get

- Channels, threaded replies, direct messages, reactions, and image attachments.
- A web app that caches what it has seen and reconnects by itself when the network comes back. On a plain-HTTP LAN address browsers do not offer installation or full offline mode; that needs a secure origin.
- Optional database encryption at rest.
- A node that never reaches the internet: all traffic stays on the local network.

## Hosting from a phone

`loamnet` runs the node on a laptop, a Raspberry Pi, or any machine with Node 22.14+ (or 23.6+). To host directly from an Android phone, including its own Wi-Fi hotspot, use the LOAM Android host app in the [project repository](https://github.com/MagicZebraLtd/loam).

## Links

- Source, documentation, and issues: https://github.com/MagicZebraLtd/loam
- License: AGPL-3.0-only

Copyright [Magic Zebra Ltd](https://www.magiczebra.co.uk).
