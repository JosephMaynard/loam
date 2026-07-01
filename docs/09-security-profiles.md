# 09 — Security profiles (making it all optional without the complexity)

## The tension

LOAM needs to span a wide range, from **fully open** (a disaster zone: displaced people, no cell
coverage, anyone should just join and talk — encryption and invites only get in the way) to **locked
down** (a protest under surveillance: invite-only, encrypted, ephemeral, kill switch). The owner wants
all of it **configurable**. The risk: exposing every security feature as an independent toggle creates a
combinatorial mess no one can test or reason about.

## The answer: presets, not a toggle matrix

Define a **small set of named security profiles** that each set a *coherent bundle* of the underlying
options. Advanced users can still override individual axes (`profile: "custom"`), but the default UX is
"pick a profile." You then **test the 3 profiles end-to-end** instead of the 2ⁿ combinations. This is
what keeps "make it all optional" from becoming "too complex."

### The underlying axes (what a profile bundles)

| Axis | Values | Doc |
|------|--------|-----|
| Admission | `open` (anyone connects) / `token` (QR invite required) | 08 |
| Transport encryption (Layer 1) | `off` / `on` (QR-bootstrapped session encryption) | 08 |
| Host-key delivery (when encryption on) | `qr` (authenticated) / `tofu` (trust-on-first-use, weaker) | 08 |
| E2EE (Layer 2) | `off` / `dmsAndPrivate` | 07 |
| At-rest encryption | `off` / `on` | 01 |
| Join QR | `none` / `static` / `rotating` (+ `rotateSeconds`) | 08 |
| Retention | keep / `retentionMs` (ephemeral) | 07 |
| Kill switch | `off` / `on` | 02 |
| Identity mode | `anonymous` / `authenticated` | 05 |

### Proposed profiles

| Axis | `open` (disaster relief) | `standard` (default) | `hardened` (high-risk) |
|------|--------------------------|----------------------|------------------------|
| Admission | open — anyone joins | token (QR invite) | token (QR invite) |
| Transport encryption | off (or on+TOFU) | **on** (QR key) | **on** (QR key) |
| E2EE | off | off (host trusted) | **on** for DMs + private channels |
| At-rest encryption | off | on | on |
| Join QR | static (or none) | rotating | rotating, short interval |
| Retention | keep | keep (configurable) | ephemeral (TTL) |
| Kill switch | off | off | on |
| Identity | anonymous | anonymous | anonymous |

Notes: `open` favours access over confidentiality on purpose — no invite, minimal friction, someone can
even type the IP and connect. `standard` matches the trusted-host reality (Layer-1 encryption is nearly
free once bootstrapped, so it's on; E2EE off). `hardened` adds E2EE, ephemerality, and the kill switch
for the protest model. `authenticated` identity (05) is an orthogonal switch for website hosting, not
part of these off-grid profiles.

## Key couplings to respect (why the axes aren't fully independent)

- **Transport encryption ⇒ the client needs the host's public key.** With a QR that's authenticated and
  MITM-resistant (`qr`). Without a QR (someone types the IP), the only option is **TOFU** — protects
  against passive sniffing but not an active MITM on the first connection. So "encryption on + open
  admission" implies the weaker TOFU guarantee; be explicit about that in the UI.
- **Rotating QR ⇒ a visible host screen.** Fine given the owner's "assume a screen is available." For
  headless nodes, fall back to `static` (a printed poster) — and note `scripts/dev.ts` already renders a
  **QR to the terminal**, so even a screenless Pi has a QR channel via the console. Rotation only affects
  *new* joins; already-connected sessions keep their session key/cookie and are undisturbed.
- **E2EE ⇒ no server-side LLM/RAG/search** for those conversations (the server can't read them). That's
  why it's opt-in and scoped to DMs/private channels, not global.
- **Kill switch strength depends on at-rest encryption** (key-discard vs recoverable delete) — see 02.

## Architecture: how to keep optionality from leaking everywhere

Make each layer a **clean boundary that is either active or a pass-through**, so the rest of the app never
branches on security settings:

- **Secure-channel abstraction.** All REST/WS traffic goes through one wrapper. Encryption on → it does
  the handshake + AEAD envelope; off → it's an identity pass-through. The message/user/channel code is
  unchanged either way.
- **Admission middleware.** One place validates the join token (or allows all in `open`). Routes don't
  know about it.
- **Capability negotiation.** The node's active profile is surfaced to clients (extend the existing
  `/api/config` `networkConfig` pattern) plus encoded in the QR, and the client adapts: do the handshake
  iff encryption is on, prompt for a token iff admission is `token`, enable the E2EE UI iff on. One
  conditional path, not scattered flags.
- **Config lives in the admin area** (03), selectable as a profile with an "advanced/custom" override
  that exposes the raw axes.

## Config sketch

```jsonc
"security": {
  "profile": "standard",           // "open" | "standard" | "hardened" | "custom"
  // present only to override a profile, or when profile === "custom":
  "admission": "token",            // "open" | "token"
  "transportEncryption": "on",     // "off" | "on"
  "transportKeyDelivery": "qr",    // "qr" | "tofu"
  "e2ee": "off",                   // "off" | "dmsAndPrivate"
  "atRestEncryption": "on",
  "qr": { "mode": "rotating", "rotateSeconds": 60 },
  "retentionMs": null,
  "killSwitch": { "enabled": false }
}
```

## Complexity verdict

Making it "all optional" is **manageable** if: (1) users choose a **profile**, not individual toggles;
(2) each security layer is an **active-or-passthrough boundary** so the app core stays oblivious; and
(3) the client **negotiates capabilities** from `/api/config` + the QR. Test the three profiles as
whole configurations. The owner's "assume a screen is available" simplifies the `hardened`/`rotating`
paths (show rotating QR, key fingerprints, and admin controls on the host screen); keep a `static`/
console-QR fallback for headless so that assumption isn't load-bearing.

## Decide
- Profile names/defaults (proposed: `open` / `standard` / `hardened`, default `standard`).
- Does `open` mean encryption fully off, or on-with-TOFU? (Access vs. passive-sniff protection.)
- Is E2EE ever a default, or always opt-in even in `hardened`? (Recommend opt-in — it disables LLM/search.)
