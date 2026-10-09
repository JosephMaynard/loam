'use strict';

// Pure gate for "may a DB key be resolved (and boot proceed) on THIS invocation?".
// Split out from main.js into its own dependency-free CJS module — with no `require('rn-bridge')` and
// no top-level side effects — specifically so it can be unit-tested directly (see
// apps/app/src/lib/db-key-gate.test.ts). main.js itself pulls in `rn-bridge` at import time and runs
// `bootWithWipeResume()` as a boot-time side effect the instant it's required, so it can't safely be
// `require()`d from a plain Vitest harness.
//
// EVERY boot/unlock entry point in main.js — the initial boot AND the `loam-db-unlock` retry listener —
// MUST route through `bootWithWipeResume()`, the single caller of `resolveDbEncryptionAndBoot()`, which
// in turn is gated by this function. A direct `resolveDbEncryptionAndBoot()` call would skip the wipe-phase
// check: a Retry/Unlock tap after a `db_encryption_locked` report could then resolve a key and boot a fresh
// (post-wipe) database under the OLD secret the wipe was meant to destroy.
//
// The input is whether a device-KEY-CLEAR is still pending — i.e. the durable
// `.loam-wipe-phase` file (written by the server's kill switch before it hands off to the launcher — see
// `executeKillSwitchBody` in apps/server/src/kill-switch.ts) reads `key-clear-ready`. That phase means every wiped
// artifact is PROVEN gone and the ONLY remaining step is clearing the device key, which was never confirmed
// complete (`db-encryption.ts`'s `clearStoredDbKeys` / main.js's `loam-wipe-complete` handler). Resolving a
// key — let alone booting — while that's true risks encrypting/opening the fresh post-wipe database under
// the very device secret the wipe was meant to destroy. Only a confirmed `loam-wipe-complete` (which
// deletes the phase file) may lift this. NB: a `delete-pending` phase is NOT blocked here — the launcher
// DEFERS to the server's boot-time deletion retry under the old key (main.js's `bootWithWipeResume`), which
// still resolves a key and boots; only `key-clear-ready` blocks the fast path.
//
// @param {boolean} keyClearPending — true when the wipe phase is `key-clear-ready` (device key not yet cleared).
// @returns {boolean} true when it is safe to resolve a key and boot this call.
function mayResolveDbKeyThisBoot(keyClearPending) {
  return keyClearPending !== true;
}

module.exports = { mayResolveDbKeyThisBoot: mayResolveDbKeyThisBoot };
