// Tests the pure "may a DB key be resolved this boot?" decision extracted from
// nodejs-project-template/main.js into db-key-gate.js (P1-2, Sol round 5). main.js itself can't be
// safely `require()`d from this harness — it pulls in `rn-bridge` (unavailable outside the embedded
// nodejs-mobile runtime) at import time and runs `bootWithWipeResume()` as a boot-time side effect the
// instant it's required — so this dependency-free helper is the unit-testable seam for that gate. See
// the module's own doc comment for the full security rationale (a wipe-pending marker on disk means an
// earlier kill-switch wipe's Keystore key-clear was never confirmed, so no key may be resolved — and no
// boot may proceed — until that's cleared).
//
// COVERAGE NOTE: this only tests the pure decision function. The actual WIRING in main.js — that EVERY
// boot/unlock entry point (the initial boot, and the `loam-db-unlock` retry listener) routes through
// `bootWithWipeResume()` (which calls this gate) rather than `resolveDbEncryptionAndBoot()` directly —
// is NOT covered by an automated test, since main.js can't be loaded in this harness (see above). That
// wiring was verified by inspection (`git diff` on nodejs-project-template/main.js) and `node --check`
// (syntax only). A real-device/emulator smoke test of a Retry tap during a resumed wipe is the only way
// to exercise the full path end-to-end.
import { describe, expect, it } from "vitest";

import { mayResolveDbKeyThisBoot } from "../../nodejs-project-template/db-key-gate.js";

describe("mayResolveDbKeyThisBoot", () => {
  it("refuses to resolve a key when a wipe-pending marker exists", () => {
    expect(mayResolveDbKeyThisBoot(true)).toBe(false);
  });

  it("allows resolving a key when no wipe-pending marker exists", () => {
    expect(mayResolveDbKeyThisBoot(false)).toBe(true);
  });
});
