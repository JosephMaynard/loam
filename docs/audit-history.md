# Audit history

LOAM's security-sensitive code has been through several rounds of review. Code comments used to carry
the ticket ids those reviews produced ("round 8 P1-2", "RF6-b", "PR #122"); they now state only the
invariant the fix enforces. This page records which reviews happened and what kinds of problems they
found, so the history isn't lost. For what changed in each release, see `CHANGELOG.md`.

## The reviews

- **Four-area code review** (server, client, packages and Android, tests). Its deferred backlog is
  `docs/15-review-follow-ups.md`.
- **External cryptography and robustness review**, about twelve numbered rounds through August and
  September 2026 (the numbered "rounds" some docs mention). It covered transport
  encryption and session binding (docs/18, docs/20), on-device database encryption, the Emergency Reset
  (kill switch) and its launcher handoff, and the on-device model manager.
- **Internal review of 2026-09-04**, done alongside the split of the server into modules (PR #122).
- **Pre-release review of 2026-09-25** (PR #130): thirteen numbered items plus follow-ups, mostly sync
  and mesh hardening.
- **Release review of 2026-10-09** of the whole 0.6.0 tree (PR #153).
- **Automated pull-request review** (CodeRabbit) on the larger PRs, which mostly found durability and
  concurrency edge cases.

## What they found, by class

- **Silent plaintext.** A transient failure (a mode read error, a missing or stale mode hint, a missing
  SQLCipher driver, a failed keyed open, a forged 401 or failed handshake on the client) could fall back
  to an unencrypted database or connection. Every one of these now fails closed: the launcher locks, the
  server refuses, the client keeps its pinned key.
- **Emergency Reset durability.** A crash, power loss or thrown error partway through a wipe could leave
  the node locked in memory only, with the next boot serving the old data. The fix is the durable wipe
  journal (`.loam-wipe-phase`, intent plus config), fsync of files and their parent directories,
  deletion proved by `ENOENT`, a 503 gate raised before any await on every wipe path, a single-flight
  kill switch, and a boot-time resume that finishes an interrupted wipe before serving.
- **Key handling.** The passphrase key moved from `SHA256(passphrase)` to `SHA256(passphrase:deviceSecret)`
  with an in-place rekey migration and a crash-safe backup. The passphrase is no longer stored. A fixed
  key is rotated only through the acknowledged launcher handoff, never through the WebView's
  unauthenticated wipe notice.
- **Concurrency.** In-process boot retries reusing stale state, overlapping picker taps, Forget racing a
  key request, two model loads at once. Fixed with fresh boot state per attempt, request-id correlation,
  locks and single-flight guards.
- **Authorization and information leaks.** Feature and channel lockdowns bypassed through edits,
  reactions or deletes; moderator timeouts not covering profile edits; launcher-only routes reachable from
  loopback alone (they now need the per-boot host token); private-channel existence leaked by
  different 404s; `roles` and shadow-ban state on public user records.
- **Sync and mesh.** Importing more users than the accepted authors; reserved `mesh.*` and `llm.*` ids
  accepted from peers; sealed pulls that told a carrier where a recipient lives; the sync token sent on a
  plaintext pull; replay of sealed mail under a fresh id; unbounded peer responses.
- **Model manager data safety.** A read error treated as "nothing downloaded" so cleanup deleted every
  model; non-crash-safe state saves; rollbacks undoing newer choices; deletes reported as done with the
  file still present; custom download links able to reach the embedded server.

## Still open

The items each review deferred are tracked in `docs/15-review-follow-ups.md`, `docs/25-backlog.md` and
`docs/21-device-verification-checklist.md` (the on-device checks that need real hardware).
