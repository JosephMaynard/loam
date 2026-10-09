# LOAM roadmap

> **Status: current (9 October 2026, version 0.6.0).** What LOAM does today, what comes next, and what is
> being considered. Nothing below the "Next" section has a date. The detailed list of open work is
> [docs/25](25-backlog.md); settled and open design choices are in [decisions.md](decisions.md).

LOAM is local communication for crowded or disrupted places: one host runs a network, people nearby
join it from a browser, and nothing needs the internet ([MISSION.md](../MISSION.md)). The roadmap
follows the project's order of priorities: no setup, privacy, then coping with poor connections.
Features that would weaken one of those come last or not at all.

## Built today

- **Hosting** on an Android phone (its own hotspot, or an existing Wi-Fi network), on a computer or a
  Raspberry Pi (`npx loamnet`, with a full-screen terminal view and a kiosk mode). Phones join by
  scanning a QR code; there are no accounts.
- **Messaging:** public and private channels, threads, direct messages, reactions, pictures and files,
  search, shared locations, and messages that expire after a set time.
- **Moderation:** join approval with rotating invite codes, moderators and greeters, a report queue,
  bans, time-outs, shadow-bans, per-person blocking, and member rules everyone accepts before posting.
- **Privacy and security:** encrypted connections from the join code (and a mode that refuses anything
  else), an encrypted database (SQLCipher), security profiles, and an Emergency Reset that erases the
  network on the host and on every connected phone. [SECURITY.md](../SECURITY.md) states the limits,
  starting with the fact that the host can read everything.
- **Linking networks:** two networks can share their public channels.
- **Fifteen languages**, five of them right to left.
- **An optional assistant:** a small model on the host phone, or a laptop's Ollama model, in direct
  messages.
- **Mesh mail (experimental, off by default):** sealed messages that linked networks carry for each other,
  readable only by the recipient's network.

## Next

The 0.6.0 release and the work around it:

- **Testing on real phones.** Several features are verified in code and CI but not yet on a physical
  device: the encrypted database (keying, changing and wiping it), the on-device model, the host's
  background service, and the Android changes in recent releases. The checklist is
  [docs/21](21-device-verification-checklist.md).
- **Google Play.** The app meets Play's requirements in code; publishing needs the store paperwork and the
  device run above ([docs/30](30-play-store.md)). The APK on GitHub Releases stays available.
- **Tablets, Chromebooks and Android laptops.** The host app supports large screens and keyboards; it needs
  testing on those devices.
- **Windows hosts.** `loamnet` runs on Windows, but how its file writes survive a crash there hasn't been
  checked.
- **Translations.** Fourteen of the fifteen languages were machine-translated and need review by native
  speakers ([docs/13](13-i18n.md) has the translation policy).

## Being designed or considered

None of these are built. Each links to the design or briefing it comes from.

| Idea | Where it stands |
|---|---|
| **Phone-to-phone mesh over Bluetooth and Wi-Fi Aware**, so a message can travel with someone walking between two networks | The radio layer is written but has never run on real radios, and the Bluetooth fallback and battery management are still to do ([docs/16](16-opportunistic-mesh.md), [docs/17](17-mesh-transport-testing.md)). |
| **Delivery receipts for mesh mail** | Designed ([docs/23](23-atproto-p2p-plan.md) §11). |
| **Courier sync**, carrying a network's updates by hand between places | Designed ([docs/19](19-courier-sync.md)). |
| **Encrypting pictures and files on the host**, as the database already is | Not started. Today an Emergency Reset deletes them. |
| **Moderation and deletions that travel between linked networks** | Needs signed messages first; part of the portable identity work below. |
| **Portable identity**: one signed identity that moves between networks | A plan exists and has been through one round of external review; key decisions are open ([docs/22](22-atproto-p2p.md), [docs/23](23-atproto-p2p-plan.md)). |
| **End-to-end encryption** for direct messages and private channels, so the host can't read them | An open decision ([decisions.md](decisions.md) rows 11 and 17). It would turn off search and the assistant for those conversations. |
| **Optional accounts** for networks hosted on the internet | An open decision ([docs/05](05-authentication.md)). The anonymous, account-free default would stay. |
| **Long-range radio (LoRa)**, possibly through Reticulum | Investigated ([docs/28](28-prior-art-reticulum.md)); the sync protocol is what a radio link would carry. |
| **Offline maps** for shared locations | Location messages exist; the map is designed but not built ([docs/10](10-maps-location-sharing.md)). |
| **A smarter assistant**: search over the network's own messages, more model choices | Listed in [docs/06](06-llm.md). |
| **A desktop app** for hosts who don't want a terminal | Feasibility study ([docs/24](24-electron-desktop.md)). |

## What LOAM won't do

- Collect anything: no analytics, crash reports, accounts or cloud service. Messages leave a network only
  when its operator links it to another network or points the assistant at another machine.
- Rush the radio transport or the identity cryptography. Earlier apps in this space were hurt by shipping
  those before they were proven, so they stay experimental until they have been tested on real devices
  and reviewed.

## Asking for something

Open an [issue](https://github.com/MagicZebraLtd/loam/issues) with what you need and where you'd use LOAM,
or email opensource@magiczebra.co.uk. [CONTRIBUTING.md](../CONTRIBUTING.md) explains how to send a change.

## Background documents

The design notes in `docs/` record how each part was planned and built. [ARCHITECTURE.md](../ARCHITECTURE.md)
lists every one with whether it describes shipped behaviour, a plan, an investigation or history.
