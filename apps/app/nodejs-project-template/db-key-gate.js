'use strict';

// Pure gate for "may a DB key be resolved (and boot proceed) on THIS invocation?" (P1-2, Sol round 5).
// Split out from main.js into its own dependency-free CJS module — with no `require('rn-bridge')` and
// no top-level side effects — specifically so it can be unit-tested directly (see
// apps/app/src/lib/db-key-gate.test.ts). main.js itself pulls in `rn-bridge` at import time and runs
// `bootWithWipeResume()` as a boot-time side effect the instant it's required, so it can't safely be
// `require()`d from a plain Vitest harness.
//
// EVERY boot/unlock entry point in main.js — the initial boot AND the `loam-db-unlock` retry listener —
// MUST route through `bootWithWipeResume()`, the single caller of `resolveDbEncryptionAndBoot()`, which
// in turn is gated by this function. Before this fix, `loam-db-unlock`'s handler called
// `resolveDbEncryptionAndBoot()` directly, bypassing the marker check entirely: a Retry/Unlock tap after
// a `db_encryption_locked` boot-timeout report could resolve a key and boot a fresh (post-wipe) database
// under the OLD secret the wipe was meant to destroy, while the wipe-pending marker sat unread on disk.
//
// A wipe-pending marker still on disk (`.loam-wipe-pending`, written by the server's kill switch before
// it hands off to the launcher — see `executeKillSwitchBody` in apps/server/src/app.ts) means an earlier
// wipe's Keystore key-clear was never confirmed complete (`db-encryption.ts`'s `clearStoredDbKeys` /
// main.js's `loam-wipe-complete` handler). Resolving a key — let alone booting — while that's true risks
// encrypting/opening the fresh post-wipe database under the very device secret the wipe was meant to
// destroy. Only a confirmed `loam-wipe-complete` (which deletes the marker) may lift this.
//
// @param {boolean} wipePendingMarkerExists
// @returns {boolean} true when it is safe to resolve a key and boot this call.
function mayResolveDbKeyThisBoot(wipePendingMarkerExists) {
  return wipePendingMarkerExists !== true;
}

module.exports = { mayResolveDbKeyThisBoot: mayResolveDbKeyThisBoot };
