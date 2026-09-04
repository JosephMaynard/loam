// The Emergency Reset / kill switch: the single-flight wipe, its ephemeral-key rotation vs fixed-key
// launcher handoff, and the in-memory lockdown. Extracted verbatim from app.ts (2026-09-04 split) over
// the shared AppContext.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";

import type { AppContext } from "./app-context.js";
import { reportBootNotice } from "./boot-bridge.js";
import { makeAdminSetupCode } from "./identity.js";
import type { WipePhase } from "./store-lifecycle.js";

/**
 * The result of a kill-switch run (P1-1, Sol round 8) — so the `/api/admin/kill-switch` and `/api/panic`
 * endpoints never report success on an INCOMPLETE wipe. `complete` is false when the wipe could not be
 * finished this run (deletion incomplete/unverifiable → 503-locked, retried on the next boot); `phase`
 * carries the durable wipe phase for a fixed-key launcher handoff.
 */
export type KillSwitchResult = { complete: boolean; phase?: WipePhase };

export function createKillSwitch(ctx: AppContext) {
  /**
   * Execute the kill switch: wipe all persisted and in-memory data (messages, users, channels,
   * sessions, avatar files), signal connected clients to purge their local caches, close their
   * sockets, and re-seed the node's defaults so it comes back factory-fresh. Config (including the
   * kill-switch settings themselves) survives — the wipe destroys data, not settings.
   *
   * Exception (P1-2, docs/15): a `persistent`/`passphrase`-encrypted node has a FIXED key this
   * process can't replace in-process, so it deletes the ciphertext and hands off to the RN launcher
   * to clear the Keystore key and restart instead of recreating the database under the same key —
   * see the branch at the top of {@link executeKillSwitchBody}.
   */
  async function executeKillSwitch(): Promise<KillSwitchResult> {
    // SINGLE-FLIGHT (CodeRabbit round-10): two concurrent callers (the admin kill-switch endpoint + the panic
    // token, or two same-tick requests that both cleared the 503 gate before the first raised it) must NOT
    // each run a wipe — a second `store.close()`/delete/reopen racing the first is destructive. Reuse the
    // in-flight attempt so every concurrent caller observes the SAME single wipe's outcome.
    if (ctx.wipeInFlight) {
      return ctx.wipeInFlight;
    }
    // Invalidate any in-flight sync round up front (before the first await here): a pull that resumes
    // after this point will see the changed generation and bail instead of writing peer data back
    // onto the store we're about to wipe (docs/15 #2). `wipeInProgress` (SF3) additionally blocks a
    // pass that hasn't started yet — cleared in the `finally` below so it can't get stuck set on error.
    ctx.wipeGeneration += 1;
    ctx.wipeInProgress = true;

    const attempt = executeKillSwitchBody().finally(() => {
      ctx.wipeInProgress = false;
      ctx.wipeInFlight = undefined;
    });
    ctx.wipeInFlight = attempt;
    return attempt;
  }

  /** The actual kill-switch work, split out so {@link executeKillSwitch} can guarantee `wipeInProgress`
   *  is cleared via `finally` regardless of how this returns. */
  async function executeKillSwitchBody(): Promise<KillSwitchResult> {
    /** Synchronous in-memory lockdown for an INCOMPLETE wipe: 503-gate on, drop every in-memory mirror,
     *  tell clients to purge, close sockets, then report the distinct incomplete notice. Used by the
     *  no-hook fail-closed paths (a phase-write failure and a deletion failure) so nothing stale is served
     *  while the node is stuck; the fixed-key hook branch does its own equivalent lockdown up front (RF-a). */
    function lockDownAndReportIncomplete(message: string): KillSwitchResult {
      ctx.awaitingWipeRestart = true;
      ctx.data = { users: [], channels: [], messages: [] };
      ctx.attachmentOwners.clear();
      ctx.sessions.clear();
      ctx.identityTokens.clear();
      ctx.claimAttempts.clear();
      ctx.panicAttempts.clear();
      ctx.transportSessions.clear();
      ctx.sync.peerTransportSessions.clear();
      ctx.broadcast({ type: "wipe" });
      for (const { socket } of ctx.sockets) {
        socket.close();
      }
      ctx.sockets.clear();
      for (const pending of [...ctx.pendingSockets]) {
        pending.close();
      }
      ctx.server.log.error(message);
      reportBootNotice(message, "kill_switch_wipe_incomplete");
      return { complete: false };
    }

    // RF-a, extended (Sol round-10 review): raise the 503 lockdown gate SYNCHRONOUSLY, before ANY branch or
    // await, for EVERY wipe path — not just the hooked fixed-key branch. The in-process reopen paths (no-hook
    // fixed-key, ephemeral, plaintext logical) reset the in-memory `data`/`sessions` only in the shared tail,
    // AFTER their first `await rm(...)`; without this a concurrent request landing in that window read the
    // still-populated mirror with a 200 instead of a 503. The gate now covers the whole wipe; it is LIFTED
    // again (`awaitingWipeRestart = false`) only on the in-process SUCCESS return once `loadData()` has
    // repopulated `data` from the fresh empty DB. The hooked fixed-key branch returns with the gate still
    // raised (it hands off to a launcher restart), and every fail-closed path stays 503-locked.
    ctx.awaitingWipeRestart = true;

    // A `persistent`/`passphrase` key is FIXED (Keystore-held on Android, config-held on desktop) —
    // this process has no way to mint a new one. Recreating the encrypted DB in-process (as the
    // ephemeral/off branches below do) would just re-key the fresh database under the SAME key that
    // the wipe is supposed to be discarding, defeating the whole point (P1-2/Sol round 3). Instead:
    // delete the ciphertext, hand off to the RN launcher (which clears the Keystore key and restarts
    // the embedded runtime), and STOP — the store is now closed, so nothing below this branch may
    // touch it again (a fresh key only exists once the NEXT boot resolves one).
    const fixedKeyMode = ctx.options.dbEncryptionMode === "persistent" || ctx.options.dbEncryptionMode === "passphrase";

    if (ctx.dbState.encryptionEnabled && fixedKeyMode) {
      const hook = ctx.lifecycle.wipeRestartHook();

      if (hook) {
        // RF-a (adversarial review, round 5): the synchronous in-memory lockdown MUST run BEFORE this
        // function's FIRST `await`. P1-4 had made `await lifecycle.persistConfigForRestart(appConfig)` the first
        // statement here — which reopened the confidentiality window RF1 closed: during the config-file
        // write the RF1 503-gate (`awaitingWipeRestart`) wasn't set yet, so a concurrent request was
        // served a normal 200 from the still-populated `data`/`sessions` on the kill-switch path. So lock
        // everything down FIRST, synchronously, with NO await — even a request already queued behind this
        // turn of the event loop then sees the 503, not stale content. `appConfig` is deliberately left
        // intact by this block; it's persisted just below, still BEFORE the marker + hook, as P1-4 wants.
        ctx.awaitingWipeRestart = true;
        ctx.data = { users: [], channels: [], messages: [] };
        ctx.attachmentOwners.clear();
        ctx.sessions.clear();
        ctx.identityTokens.clear();
        ctx.claimAttempts.clear();
        ctx.panicAttempts.clear();
        ctx.transportSessions.clear();
        ctx.sync.peerTransportSessions.clear();

        // Notify still-connected clients to purge their local caches BEFORE closing their sockets —
        // closing first would leave the broadcast with no one left to reach.
        ctx.broadcast({ type: "wipe" });

        for (const { socket } of ctx.sockets) {
          socket.close();
        }
        ctx.sockets.clear();
        for (const pending of [...ctx.pendingSockets]) {
          pending.close();
        }

        // P1-4 (Sol round-10): commit the wipe INTENT and the effective CONFIG together, atomically, as the
        // FIRST durable action — the wipe journal `{ phase: "delete-pending", config }`. A SIGKILL after this
        // single write leaves BOTH on disk, so a boot-time resume can restore config.json from the snapshot
        // before it clears the journal; a kill BEFORE it destroys nothing (no journal → wipe forgotten, but
        // nothing lost). This is why config can no longer revert on a crash: it rides with the intent, not in
        // a separate later write. A `false` does NOT abort the wipe (confidentiality-first, Sol round-8 P1-d /
        // round-9 decision): deletion still runs; the only residual is the degraded-FS compound case.
        const sanitized = ctx.lifecycle.sanitizeConfigForRestart(ctx.appConfig);
        const journalWritten = ctx.lifecycle.writeWipeJournal("delete-pending", sanitized);
        if (!journalWritten) {
          ctx.server.log.error(
            "KILL SWITCH NOTICE: could NOT durably write the wipe journal (intent + config) before this fixed-key " +
              "wipe — proceeding with deletion regardless (confidentiality-first), but a crash mid-deletion could " +
              "then forget the wipe and admin config may revert; reopen promptly.",
          );
        }

        // Close the store so its files can be deleted, then delete + PROVE-gone the FULL inventory (DB + media)
        // DURABLY (fail closed on any survivor/unverifiable path). Only after that may the key-clear be signaled.
        ctx.store.close();
        const deletion = ctx.lifecycle.deleteAndVerifyAllWipeArtifactsDurable();
        if (!deletion.ok) {
          // Stay 503-locked at `delete-pending`; the resume re-runs deletion. The journal (with config) is
          // intact, so config is safe regardless.
          const remaining = [...deletion.survivors, ...deletion.errors].join(", ");
          const message =
            `KILL SWITCH NOTICE: some persisted data could not be deleted and VERIFIED gone (${remaining}). ` +
            "The launcher was NOT signaled, to avoid clearing the device key while recoverable ciphertext " +
            "survives. The node is locked down (503); reopen it to retry the wipe.";
          ctx.server.log.error(message);
          reportBootNotice(message, "kill_switch_wipe_incomplete");
          return { complete: false, phase: "delete-pending" };
        }

        // Persist config.json from the snapshot NOW, and gate the launcher handoff on it (P1-4, Sol round-10):
        // the launcher clears the journal after its key-clear, and the fresh server boot then reads config.json
        // (the journal is gone), so config.json MUST be current before we ever signal. If it can't be written,
        // do NOT signal — stay 503-locked at `delete-pending` (the journal retains the config); a resume
        // persists config.json from the journal and re-advances. The DB is already deleted (confidentiality
        // preserved), config is never lost — both invariants hold.
        if (!ctx.lifecycle.persistConfigForRestart(sanitized)) {
          const message =
            "KILL SWITCH NOTICE: the database was deleted and VERIFIED gone, but config.json could NOT be " +
            "durably persisted — refusing to signal the launcher (its key-clear would clear the journal before " +
            "config could be recovered). The node is locked down (503); reopen it — the resume restores config " +
            "from the wipe journal and completes the handoff.";
          ctx.server.log.error(message);
          reportBootNotice(message, "kill_switch_wipe_incomplete");
          return { complete: false, phase: "delete-pending" };
        }

        // Every artifact + media path is PROVEN gone and config.json is current. Advance to `key-clear-ready`
        // DURABLY (carrying the config snapshot), THEN hand off to the launcher.
        const phaseReady = ctx.lifecycle.writeWipeJournal("key-clear-ready", sanitized);
        try {
          hook();
        } catch (error) {
          ctx.server.log.error(error, "Kill switch: failed to signal the RN launcher for the wipe-restart handoff");
        }

        if (phaseReady) {
          ctx.server.log.warn(
            "Kill switch: persistent/passphrase-encrypted database and media deleted and VERIFIED gone; config " +
              "persisted; a device-key-clear-and-restart was REQUESTED from the launcher (durable `key-clear-ready` " +
              "journal written) — the key rotation is only confirmed once the launcher acknowledges it cleared the key.",
          );
          return { complete: true, phase: "key-clear-ready" };
        }

        // Data is unrecoverable, config.json is current, and the launcher was signaled, but the `key-clear-ready`
        // journal could not be written durably. A next boot re-reads the (still-`delete-pending`) journal,
        // re-verifies deletion (idempotent), re-persists config, and re-signals — so recovery converges.
        const noMarkerMessage =
          "KILL SWITCH NOTICE: all data was deleted and VERIFIED gone, config persisted, and a device-key-clear-" +
          "and-restart was REQUESTED, but the durable `key-clear-ready` journal could not be written — if the " +
          "key-clear is interrupted, reopen the node to finish clearing the (now-unused) device key.";
        ctx.server.log.warn(noMarkerMessage);
        reportBootNotice(noMarkerMessage, "kill_switch_wipe_no_marker");
        return { complete: true, phase: "delete-pending" };
      }

      // No launcher hook available (desktop/Pi/CI — not the Android host): there is nowhere to get a NEW key
      // from in-process. Fall through to the durable no-hook fixed-key wipe below (full-inventory delete +
      // durable phase clear + recreate under the SAME key) rather than bricking the wipe entirely; the key
      // cannot be rotated without a launcher (documented limitation, docs/02). (When a hook IS present the
      // block above always returns after the launcher handoff.)
      ctx.server.log.warn(
        "Kill switch: this node uses a fixed (persistent/passphrase) encryption key, but no launcher " +
          "restart hook is installed, so the key cannot be rotated in-process. Performing a full durable " +
          "wipe and recreating the database under the SAME key (documented limitation, docs/02).",
      );
    }

    if (ctx.dbState.encryptionEnabled && fixedKeyMode) {
      // NO-LAUNCHER fixed-key wipe (desktop persistent/passphrase — the hooked Android path returned above):
      // can't rotate a fixed key in-process, so delete + recreate under the SAME key (documented limitation,
      // docs/02). P1-1/P1-4 (Sol round-9): (1) persist config BEFORE the phase so a boot-time resume that
      // deletes the DB still has current config; (2) delete + prove the FULL inventory (DB + media) gone
      // DURABLY while the store is closed; (3) durably CLEAR the phase BEFORE opening the fresh store — fail
      // closed (503) on either — so a resurrected phase can never delete a freshly opened DB (incl. post-wipe
      // data written since a "success" response) and a crash can't forget still-pending media deletion.
      // P1-4 (Sol round-10): journal `{ delete-pending, config }` atomically FIRST (intent + config together).
      // Confidentiality-first: a failed write does NOT abort the wipe.
      const sanitized = ctx.lifecycle.sanitizeConfigForRestart(ctx.appConfig);
      if (!ctx.lifecycle.writeWipeJournal("delete-pending", sanitized)) {
        ctx.server.log.error(
          "Kill switch (no-hook fixed key): could NOT durably write the wipe journal (intent + config) before " +
            "deletion — if deletion also fails, a restart cannot auto-resume; reopen promptly.",
        );
      }
      ctx.store.close();
      // Full inventory (every DB artifact + user media) + proof of absence + parent-dir fsync, fail closed.
      const deletion = ctx.lifecycle.deleteAndVerifyAllWipeArtifactsDurable();
      if (!deletion.ok) {
        const remaining = [...deletion.survivors, ...deletion.errors].join(", ");
        return lockDownAndReportIncomplete(
          `KILL SWITCH NOTICE (no-hook fixed key): could not delete and VERIFY every artifact + media gone durably ` +
            `(${remaining}) — refusing to reopen while recoverable data may remain. The node is locked down (503); ` +
            "restart it to retry the wipe.",
        );
      }
      // Persist config.json from the snapshot BEFORE clearing the journal (P1-4): the journal carries the only
      // durable config copy until config.json lands, so if this fails, do NOT clear (a clear would lose it) —
      // stay 503-locked; the resume restores config.json from the journal and re-clears.
      if (!ctx.lifecycle.persistConfigForRestart(sanitized)) {
        return lockDownAndReportIncomplete(
          "KILL SWITCH NOTICE (no-hook fixed key): the database was deleted, but config.json could NOT be durably " +
            "persisted — refusing to clear the wipe journal (its config snapshot is the only durable copy) or open a " +
            "fresh DB. The node is locked down (503); reopen it — the resume restores config from the journal.",
        );
      }
      // DURABLY clear the journal BEFORE opening the fresh store (P1-1). If the clear can't be made durable, do
      // NOT open a fresh DB: a power-loss-resurrected `delete-pending` would re-wipe it on the next boot. Stay
      // 503-locked; a restart's resume re-runs the (idempotent) deletion and re-clears. (config.json is already
      // current from the step above, so a resume also has config.)
      if (!ctx.lifecycle.clearWipePhase()) {
        return lockDownAndReportIncomplete(
          "KILL SWITCH NOTICE (no-hook fixed key): the full wipe completed but the durable phase clear could not be " +
            "confirmed — refusing to open a fresh database (a resurrected phase would re-wipe it). The node is locked " +
            "down (503); restart it to retry the wipe.",
        );
      }
      ctx.store = ctx.lifecycle.openLoamStore();
      // The wipe destroys data, not settings; the fresh encrypted DB starts with an empty config table, so
      // re-persist the effective config into it (config.json above is the crash-recovery copy).
      ctx.store.setConfigValue("config", JSON.stringify(sanitized));
    } else if (ctx.dbState.encryptionEnabled) {
      // Ephemeral (RAM-only key) OR a legacy keyed node with no declared mode: rotate the RAM key (only when
      // there IS one — never rotate a legacy FIXED key) and recreate. No durable phase: an ephemeral key is
      // regenerated on restart, so any surviving file is unreadable regardless. Media is deleted in the shared
      // tail below. A cryptographic wipe destroys the ciphertext, stronger than a logical DELETE (docs/02).
      ctx.store.close();
      const deletion = ctx.lifecycle.deleteAndVerifyDbArtifacts();
      if (!deletion.ok) {
        const remaining = [...deletion.survivors, ...deletion.errors].join(", ");
        return lockDownAndReportIncomplete(
          `KILL SWITCH NOTICE: the cryptographic wipe could not delete and VERIFY every DB artifact (${remaining}) — ` +
            "refusing to rotate the key / reopen while recoverable ciphertext may remain. The node is locked " +
            "down (503); restart it to retry the wipe.",
        );
      }
      if (ctx.lifecycle.ephemeralDbKey) {
        // Drop the old key by overwriting the reference; a fresh random key encrypts the new DB.
        // (Node strings can't be reliably zeroed in RAM — documented as a known limitation.)
        ctx.dbState.dbKey = randomBytes(32).toString("hex");
      }
      ctx.store = ctx.lifecycle.openLoamStore();
      ctx.store.setConfigValue("config", JSON.stringify(ctx.appConfig));
    } else {
      // Best-effort logical wipe (no encryption): DELETE leaves recoverable pages on flash. See docs.
      ctx.store.wipeAll();
      // P1-2 (Sol round 7): wipeAll keeps the live plaintext DB open (and its config), but stale
      // migration/recovery artifacts from a PRIOR encrypted era — the legacy-key `.premigration` snapshot
      // (still-readable ciphertext!), its sidecars, a leftover `-journal`, and `*.unreadable-<ts>`
      // renames — are NOT part of that open DB and must still be removed. Skip only the three live WAL
      // files the open store owns.
      const liveFiles = new Set([ctx.lifecycle.dbPath, `${ctx.lifecycle.dbPath}-wal`, `${ctx.lifecycle.dbPath}-shm`]);
      for (const file of ctx.lifecycle.dbArtifactPaths()) {
        if (liveFiles.has(file)) {
          continue;
        }
        try {
          rmSync(file, { force: true });
        } catch {
          // Fall through to the existence check — a delete failure is surfaced there, not swallowed here.
        }
        // RF7-c (Sol round 7 adversarial review): verify + WARN on any survivor, consistent with the
        // encrypted paths above. This is a documented non-secure LOGICAL wipe (no fail-closed), but a
        // stale `.premigration` here is still-readable legacy-key ciphertext — a silent failure that left
        // it behind must at least get operator notice rather than vanishing without a trace.
        if (existsSync(file)) {
          ctx.server.log.warn(
            `KILL SWITCH NOTICE: a stale DB artifact could not be deleted during the logical wipe (${file}) — ` +
              "recoverable ciphertext from a prior encrypted era may remain on disk; remove it manually.",
          );
        }
      }
    }

    await rm(ctx.avatarsDir, { recursive: true, force: true });
    await rm(ctx.attachmentsDir, { recursive: true, force: true });
    ctx.attachmentOwners.clear();
    ctx.sessions.clear();
    // Drop every secure identity token (docs/20): the DB rows are gone (wipeAll / encrypted file delete),
    // so clear the in-memory mirror too — no wiped identity can be resumed after an emergency reset.
    ctx.identityTokens.clear();
    ctx.claimAttempts.clear();
    ctx.panicAttempts.clear();

    ctx.broadcast({ type: "wipe" });

    for (const { socket } of ctx.sockets) {
      socket.close();
    }

    ctx.sockets.clear();
    // Close any sockets still mid key-confirmation (docs/20 §7) — they never entered `sockets`, so the
    // loop above misses them; without this a socket could complete its proof after the wipe.
    for (const pending of [...ctx.pendingSockets]) {
      pending.close();
    }

    ctx.data = { users: [], channels: [], messages: [] };
    ctx.loadData();
    // Rotate the transport keypair + drop all live sessions: the old join QR stops working and no
    // captured session key survives the wipe (docs/08). loadData reloaded whatever was persisted
    // (the old key on an unencrypted wipe), so rotate explicitly to guarantee a fresh one on both paths.
    ctx.rotateTransportIdentity();
    // Drop cached puller-side sessions to peers too — RAM hygiene during an emergency wipe (docs/08).
    ctx.sync.peerTransportSessions.clear();

    if (ctx.effectiveAdminBootstrap() === "setupCode") {
      ctx.adminSetupCode = makeAdminSetupCode();
      ctx.server.log.info(`Admin setup code (single use): ${ctx.adminSetupCode}`);
    }

    ctx.server.log.warn("Kill switch executed: all data wiped, defaults re-seeded");
    // These branches (ephemeral rotation, same-key fallback, plaintext logical wipe) complete the wipe
    // in-process and re-seed a usable node — no launcher handoff is pending, so the wipe is complete. The
    // in-memory mirror is now the fresh empty DB (loadData above), so LIFT the 503 gate raised at the top:
    // the node serves again, and no request between here and now saw stale pre-wipe data (Sol round-10 review).
    ctx.awaitingWipeRestart = false;
    return { complete: true };
  }

  return {
    executeKillSwitchBody,
    executeKillSwitch,
  };
}
