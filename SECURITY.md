# Security Policy

## Supported Versions

LOAM is an actively developed project and security fixes are applied to the latest released version.

At the moment, only the most recent release is considered supported for security issues.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected security vulnerabilities.

If you believe you have found a security issue in LOAM, please report it privately by emailing:

**magicaltrailsapp@gmail.com**

Please include as much detail as you can, for example:

- a description of the issue
- steps to reproduce it
- the version, commit, or branch of LOAM affected
- the impact you believe it may have
- any proof of concept, logs, screenshots, or configuration details that would help reproduce it safely

You can encrypt your report if needed. If you want to use encrypted email, mention that in your initial message and we can arrange a suitable method.

## What to Expect

I will aim to:

- acknowledge receipt of your report within **5 working days**
- assess and triage the report as quickly as possible
- keep you informed of the outcome where practical
- coordinate a fix and release before public disclosure where appropriate

## Scope

This policy covers security issues in:

- the LOAM web application
- the LOAM server
- shared LOAM packages in this repository
- authentication, identity, messaging, syncing, storage, and network communication code
- the official project repository and published packages, if any

It does not cover:

- vulnerabilities in third-party dependencies outside LOAM’s own code, unless LOAM uses them in an unsafe way
- general usage questions or feature requests
- issues in unofficial forks, deployments, devices, or infrastructure not maintained by the LOAM project
- reports about insecure local networks, routers, browsers, operating systems, or hardware that are not caused by LOAM itself

## Disclosure

Please allow reasonable time for investigation and remediation before making any public disclosure.

## Good-faith safe harbor

Security research conducted in good faith is welcome and authorized, provided it is **non-disruptive**
and directed only at a LOAM node or instance you control. This authorization does not extend to
accessing data that isn't yours, denial-of-service testing, or any other destructive activity — those
remain out of scope regardless of intent. Report any issue you find privately, before any public
disclosure.

To the extent it is within our legal authority, we will not pursue, or support, legal action against
researchers who follow this policy in good faith — even where a report turns out to describe intended
behaviour rather than a bug. We cannot waive the rights of third parties (for example, the operator of
a LOAM instance you don't control), so this commitment reaches only as far as our own authority to
grant it.

LOAM is maintained by a small volunteer team, not a paid bug-bounty programme with contractual SLAs, so
response times vary with maintainer availability. If a report is accepted as a genuine security issue,
I will credit the reporter in release notes or documentation, unless they ask to remain anonymous.

## Threat model & accepted limitations

LOAM's threat models span disaster-relief openness to protest-mode hostile environments, and the
**server host is trusted** (it can read all plaintext). The following are deliberate, documented
trade-offs — not open bugs:

- **Plain HTTP on the LAN** (`http://<lan-ip>`, no TLS/CA on a local hotspot). Not a browser secure
  context, so WebCrypto and service workers are unavailable. App-layer transport encryption is
  planned in [docs/08](docs/08-transport-security.md).
- **No end-to-end encryption** — the server processes plaintext (search, LLM, audience filtering).
  Optional E2EE is a future initiative ([docs/07](docs/07-more-features.md)).
- **No peer authentication in node-to-node sync v1** — only public content is exposed and imports
  are defensive ([docs/11](docs/11-node-sync.md)); a shared-token handshake is the follow-up.
- **On-device Android database is unencrypted** ([docs/04](docs/04-android-host-app.md)); OS backup
  is disabled so it can't be extracted via `adb backup`, but at-rest encryption is the deeper fix.
- **Logical delete is not secure flash erasure** without encryption ([docs/02](docs/02-kill-switch.md)).

## Review history

### 2026-07-06 — full pre-launch review

An adversarial review covered every server route, the WebSocket audience filter, the DAL, the client
markdown/XSS path and all HTML sinks, the QR/avatar generators, and the Android host.

**Fixed:** Android host admin lockout (the readiness probe consumed the `firstUser` admin grant —
added a no-identity `GET /api/health`); banned/pending users can no longer edit their profile or
upload avatars; human-submitted message/reaction bodies are length-capped; the session cookie is
`Secure` based on real TLS (not `NODE_ENV`, which broke sessions on the http LAN); a strict CSP +
`nosniff` are served; Android OS backup disabled; QR rendering degrades gracefully instead of
throwing.

**Deferred (tracked):** unbounded anonymous user creation by a LAN participant who withholds their
cookie (a behavioural fix — defer persisting a user until first participation — held back to avoid
destabilising identity semantics right before handoff; the `/api/health` fix removed the accidental
Android self-DoS contributor); release APK is debug-signed (needs a real release keystore, a manual
release-engineering step); sync author-id namespacing (belongs with sync peer-auth).

**Found clean:** the SQL layer (prepared statements; escaped SQLCipher pragma), the markdown
sanitizer and every `dangerouslySetInnerHTML` sink, the QR/avatar SVG generators, server
authorization/audience filtering, sync export scoping + defensive imports + resource caps, secret
handling (scrypt + constant-time + redaction), attachment path/traversal handling, and the Android
native surface. Dependencies are reputable and pinned.
