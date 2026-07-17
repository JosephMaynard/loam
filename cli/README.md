# loamnet

Run a local, off-grid [LOAM](https://github.com/JosephMaynard/loam) messaging node from your terminal. One command starts a server and an installable web app (a PWA); anyone on the same network scans the printed QR code to join. No internet, no accounts, no cloud.

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

From a phone or laptop on the same Wi-Fi or hotspot, scan the QR code it prints (or open the printed URL). That device joins the node instantly. Requires Node.js 22.13 or newer.

## Options

```
loam [options]

  --port <n>        Port to listen on (default 3000, or $PORT)
  --data-dir <dir>  Where to store the SQLite database and avatars
                    (default $XDG_DATA_HOME/loam or ~/.loam)
  --encrypt [key]   Encrypt the database at rest with SQLCipher. Pass a value to
                    use it as a passphrase, or leave it bare for an ephemeral
                    RAM-only key that is discarded on restart. Needs the optional
                    native driver, which installs automatically when it can build.
  -h, --help        Show help
```

The default database driver is Node's built in `node:sqlite`, so a plain node needs no native build step. Encryption at rest (`--encrypt`) is the one feature that pulls in the optional native SQLCipher driver.

## What you get

- Channels, threaded replies, direct messages, reactions, and image attachments.
- An installable PWA that keeps working offline against its local cache.
- Optional database encryption at rest.
- A node that never reaches the internet: all traffic stays on the local network.

## Hosting from a phone

`loamnet` runs the node on a laptop, a Raspberry Pi, or any machine with Node 22.13+. To host directly from an Android phone, including its own Wi-Fi hotspot, use the LOAM Android host app in the [project repository](https://github.com/JosephMaynard/loam).

## Links

- Source, documentation, and issues: https://github.com/JosephMaynard/loam
- License: AGPL-3.0-only

Copyright Magic Zebra Ltd.
