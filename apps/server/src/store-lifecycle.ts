// The SQLite/SQLCipher store lifecycle: opening the database under the resolved key (with the
// passphrase-derivation migration, the unreadable-DB / plaintext-unconverted recovery paths, and the
// operator-confirmed start-fresh marker), the durable wipe journal, and the boot-time resume of an
// interrupted emergency wipe. Extracted verbatim from app.ts (2026-09-04 split) behind an explicit
// dependency object; `buildApp` composes it and owns the live `store` binding.
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { LoamConfigSchema, type LoamConfig } from "@loam/schema";
import type { FastifyBaseLogger } from "fastify";

import { reportBootNotice, reportDbKeyMigrated } from "./boot-bridge.js";
import { openStore, type LoamStore } from "./db.js";
import { DbEncryptionPlaintextUnconvertedError, DbEncryptionUnreadableError, WipeResumeInProgressError } from "./errors.js";
import type { AppOptions } from "./types.js";

/** The live at-rest key state. `dbKey` is the active SQLCipher key (rotated by an ephemeral-mode kill
 * switch); `encryptionEnabled` is whether the store is ACTUALLY open with a key right now — boot can
 * downgrade it when the resolved key doesn't open what's on disk. Mutable by design: `buildApp` and the
 * kill switch read/write it through this one object. */
export type DbKeyState = { dbKey: string | undefined; encryptionEnabled: boolean };

export type StoreLifecycleDeps = {
  dataDir: string;
  avatarsDir: string;
  attachmentsDir: string;
  options: AppOptions;
  log: FastifyBaseLogger;
  /** Path of config.json — where a wipe's config snapshot is persisted for the restart. */
  configPath: string;
  /** Flip the app into the "restart pending after a fixed-key wipe" state (every route 503s). */
  markAwaitingWipeRestart: () => void;
};

/** Outcome of an artifact deletion pass: `ok` only when every path is PROVEN gone. */
export type DeletionResult = { ok: boolean; survivors: string[]; errors: string[] };
/** The two durable phases of a fixed-key emergency wipe (see `writeWipeJournal`). */
export type WipePhase = "delete-pending" | "key-clear-ready";
/** The on-disk wipe journal: the phase plus the effective config snapshot committed with it. */
export type WipeJournal = { phase: WipePhase; config?: LoamConfig; configInvalid?: boolean; corrupt?: boolean };

export function createStoreLifecycle(deps: StoreLifecycleDeps) {
  const { dataDir, avatarsDir, attachmentsDir, configPath, options, log } = deps;

  const dbPath = join(dataDir, "loam.db");
  const ephemeralDbKey = options.ephemeralDbKey ?? false;
  // The active encryption key. Ephemeral mode generates a random RAM-only key (never persisted);
  // the kill switch rotates it (see executeKillSwitch). A provided key is reused across wipes.
  const state: DbKeyState = {
    dbKey: ephemeralDbKey ? randomBytes(32).toString("hex") : options.dbEncryptionKey,
    encryptionEnabled: false,
  };
  // Whether the store is ACTUALLY open with a key right now. Starts as "a key was resolved", but
  // `openInitialStore` below can downgrade it to `false` (case 2) if that key turns out not to open
  // what's on disk. `currentNetworkConfig()` reports THIS — not the merely-configured
  // `appConfig.security.dbEncryption` — so the wire never claims encryption that isn't active (F5).
  state.encryptionEnabled = state.dbKey !== undefined;

  const openLoamStore = (): LoamStore =>
    openStore(dbPath, { encryptionKey: state.dbKey, driver: options.dbDriver });

  /**
   * EVERY on-disk artifact of the SQLite/SQLCipher database (P1-2, Sol round 7) — the single source of
   * truth for exhaustive kill-switch deletion. Deleting only the three live files (`loam.db`/`-wal`/
   * `-shm`) is a crypto-wipe hole: it leaves the DELETE-mode rollback `-journal`, the rekey-migration
   * `.premigration` snapshot (+ its `.tmp`/`-wal`/`-shm`/`-journal` and the legacy multi-file
   * `-wal.premigration`/`-shm.premigration` sidecars), and the timestamped `*.unreadable-<ts>` recovery
   * renames. CRITICALLY, `.premigration` is copied BEFORE the rekey (see `openInitialStore`), so it is
   * encrypted under the LEGACY `SHA256(passphrase)` derivation (no discardable device secret) — clearing
   * the device secret does NOT cryptographically erase it; anyone with the passphrase could still open it.
   * Only physically deleting it satisfies the "wipe all persisted data" + cryptographic-wipe guarantees.
   * Returns the STATIC absolute paths plus the globbed recovery renames enumerated from the data dir,
   * AND whether that enumeration FAILED (P1-2, Sol round 8): an unreadable data dir (EACCES/EIO) is NOT
   * proof no `*.unreadable-*` survivor exists, so a `readdirSync` failure surfaces as `enumerationError`
   * rather than being swallowed into an empty enumeration — the secure-wipe callers treat that as an error
   * that BLOCKS completion. Callers delete + PROVE-gone each path before declaring the wipe complete.
   */
  function dbArtifactInventory(): { paths: string[]; enumerationError?: string } {
    const paths = [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      `${dbPath}-journal`,
      `${dbPath}.premigration`,
      `${dbPath}.premigration.tmp`,
      `${dbPath}.premigration-wal`,
      `${dbPath}.premigration-shm`,
      `${dbPath}.premigration-journal`,
      `${dbPath}-wal.premigration`,
      `${dbPath}-shm.premigration`,
    ];
    // The marker-gated fresh-start recovery renames unopenable files aside as `<name>.unreadable-<ts>`
    // (openInitialStore case 3, timestamp+random suffix). Those are still-readable ciphertext under a
    // possibly-legacy key, so a wipe must remove them too — enumerate them by prefix from the data dir.
    const base = basename(dbPath);
    try {
      for (const entry of readdirSync(dataDir)) {
        if (entry.startsWith(base) && entry.includes(".unreadable-")) {
          paths.push(join(dataDir, entry));
        }
      }
    } catch (error) {
      // P1-2 (Sol round 8): "can't enumerate" is NOT "nothing to enumerate" — a `*.unreadable-*` survivor
      // could be present and unseen. Surface it so `deleteAndVerifyDbArtifacts` fails closed instead of
      // reporting a false-clean wipe.
      return { paths, enumerationError: `readdir ${dataDir}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { paths };
  }

  /** The static + globbed artifact path list (the plaintext/best-effort logical wipe wants the list alone;
   *  the secure paths use {@link dbArtifactInventory} so an enumeration failure blocks completion). */
  function dbArtifactPaths(): string[] {
    return dbArtifactInventory().paths;
  }

  /**
   * Prove a path's absence (P1-2, Sol round 8). `existsSync` returns `false` for MANY stat/access errors,
   * conflating "confirmed absent" with "could-not-determine" — so a wipe that trusts it can report a
   * survivor as gone. `lstatSync` distinguishes them: `ENOENT` is the ONLY confirmed absence; the file
   * still being there is confirmed presence; ANY other error is `"unknown"` (unverifiable — must NOT be
   * treated as absence). `lstat` (not `stat`) so a dangling symlink counts as present, never as absent.
   */
  function provenAbsence(file: string): "absent" | "present" | "unknown" {
    try {
      lstatSync(file);
      return "present";
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unknown";
    }
  }

  /** Structured result of a fail-closed deletion sweep (P1-2, Sol round 8): `ok` is true ONLY when every
   *  path is PROVEN absent (no survivors AND no unverifiable/unknown paths AND no enumeration error). */

  /**
   * Delete every {@link dbArtifactInventory} entry and PROVE each is gone (P1-2, Sol round 8). Best-effort
   * per file (a delete failure is caught, then the path is re-checked via {@link provenAbsence}). Unlike
   * the old `existsSync`-based check, "confirmed absent" is ONLY `ENOENT`: a still-present file → `survivors`,
   * and ANY other stat error (or a failed data-dir enumeration) → `errors` ("could-not-determine", NOT
   * absence). `ok` is false on either, so every encrypted wipe branch can FAIL CLOSED on an unverifiable
   * result rather than continue rotating/reopening while recoverable ciphertext might survive.
   */
  function deleteAndVerifyDbArtifacts(): DeletionResult {
    const inventory = dbArtifactInventory();
    const survivors: string[] = [];
    const errors: string[] = [];
    if (inventory.enumerationError) {
      errors.push(inventory.enumerationError);
    }
    for (const file of inventory.paths) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Fall through to the proven-absence check — an undeletable file is caught there, not here.
      }
      const status = provenAbsence(file);
      if (status === "present") {
        survivors.push(file);
      } else if (status === "unknown") {
        errors.push(file);
      }
    }
    return { ok: survivors.length === 0 && errors.length === 0, survivors, errors };
  }

  /**
   * The FULL secure-wipe deletion set (P1-2, Sol round 8): every DB artifact PLUS the plaintext user-media
   * directories (avatars/attachments), each deleted and PROVEN gone. Used by every fixed-key launcher-handoff
   * gate and by the boot-time wipe-phase resume, so the "verified gone" decision covers the whole inventory
   * (not just the DB files) before the launcher is ever signaled / the phase advances.
   */
  function deleteAndVerifyAllWipeArtifacts(): DeletionResult {
    const db = deleteAndVerifyDbArtifacts();
    const survivors = [...db.survivors];
    const errors = [...db.errors];
    // The media dirs, PLUS any preserve-recovery snapshot directories (`.loam-recovery-<suffix>/`, Sol
    // round-11): those hold an old, still-readable (under the prior key) DB set + avatars + attachments moved
    // aside by a `preserve` start-fresh, so an emergency wipe must remove them too. A `readdir` failure here
    // is surfaced as an error (fail closed) — "can't enumerate" is not "nothing to remove".
    const dirsToRemove = [avatarsDir, attachmentsDir];
    try {
      for (const entry of readdirSync(dataDir)) {
        if (entry.startsWith(".loam-recovery-")) {
          dirsToRemove.push(join(dataDir, entry));
        }
      }
    } catch (error) {
      errors.push(`readdir ${dataDir} (recovery snapshots): ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const dir of dirsToRemove) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Fall through to the proven-absence check.
      }
      const status = provenAbsence(dir);
      if (status === "present") {
        survivors.push(dir);
      } else if (status === "unknown") {
        errors.push(dir);
      }
    }
    return { ok: survivors.length === 0 && errors.length === 0, survivors, errors };
  }

  /**
   * {@link deleteAndVerifyAllWipeArtifacts} PLUS a parent-directory fsync so the deletions are DURABLE across
   * power-loss (P1-1/P1-2, Sol round-9) before the caller opens a fresh DB or reports the wipe done — otherwise
   * a "permanently deleted" result proves only current-namespace absence, not that the unlinks survived a crash.
   * `ok` is true ONLY when every artifact + media path is proven gone AND the directory fsync succeeded (fail
   * closed on either). The single destructive-recovery / no-hook-wipe helper Sol round-9 asked every branch to
   * funnel through, so full-inventory + durable is enforced in one place.
   */
  function deleteAndVerifyAllWipeArtifactsDurable(): DeletionResult {
    const result = deleteAndVerifyAllWipeArtifacts();
    if (!result.ok) {
      return result;
    }
    if (!fsyncDir(dataDir)) {
      return {
        ok: false,
        survivors: result.survivors,
        errors: [...result.errors, `${dataDir} (directory fsync failed — deletions not proven durable)`],
      };
    }
    return result;
  }

  /** Durably record the preserve-recovery ANCHOR (the target snapshot dir name). Returns durability. */
  function writeRecoveryState(recoveryDirName: string): boolean {
    return durableWriteFileSync(recoveryStatePath, recoveryDirName);
  }

  /** Durably remove the preserve-recovery anchor (unlink + parent-dir fsync). Returns proven-gone. */
  function clearRecoveryState(): boolean {
    try {
      rmSync(recoveryStatePath, { force: true });
    } catch (error) {
      log.warn(error, "Preserve recovery: failed to delete the recovery-state anchor");
    }
    if (provenAbsence(recoveryStatePath) !== "absent") {
      return false;
    }
    return fsyncDir(dataDir);
  }

  /**
   * Move (or FINISH moving) the whole unopenable DB set + user media into `recoveryDir`, durably (P1, Sol
   * round-12). Idempotent/resumable: only entries still in the ACTIVE namespace are moved, so a re-run after a
   * crash completes a partial move rather than duplicating it — the DB set therefore always ends up COHERENT
   * (every `loam.db*` file together) in the snapshot. Every source-presence check is ENOENT-only
   * (`provenAbsence`); an UNVERIFIABLE stat aborts (returns false) BEFORE any fresh store could be opened, so a
   * transient EIO can't silently leave media in the active namespace (P1-4). fsyncs BOTH parent directories —
   * a cross-directory rename changes both, so making only the source durable would risk losing the destination
   * link (P1-1). Returns whether the snapshot is now complete AND durable.
   */
  function completePreserveMove(recoveryDir: string): boolean {
    try {
      mkdirSync(recoveryDir, { recursive: true });
    } catch (error) {
      log.error(error, "Preserve recovery: could not create the recovery snapshot directory");
      return false;
    }
    // Media directories first (ENOENT-only; abort on unverifiable).
    for (const [name, dir] of [
      ["avatars", avatarsDir],
      ["attachments", attachmentsDir],
    ] as const) {
      const status = provenAbsence(dir);
      if (status === "present") {
        try {
          renameSync(dir, join(recoveryDir, name));
        } catch (error) {
          if (provenAbsence(dir) !== "absent") {
            log.error(error, `Preserve recovery: could not move ${dir} into the snapshot`);
            return false;
          }
        }
      } else if (status === "unknown") {
        log.error(`Preserve recovery: could not verify ${dir} (unreadable) — aborting before any commit`);
        return false;
      }
    }
    // Every `loam.db*` artifact still in the active dir → into the snapshot.
    const base = basename(dbPath);
    let entries: string[];
    try {
      entries = readdirSync(dataDir);
    } catch (error) {
      log.error(error, "Preserve recovery: could not enumerate the data directory — aborting");
      return false;
    }
    for (const entry of entries) {
      if (!entry.startsWith(base)) {
        continue;
      }
      const from = join(dataDir, entry);
      try {
        renameSync(from, join(recoveryDir, entry));
      } catch (error) {
        if (provenAbsence(from) !== "absent") {
          log.error(error, `Preserve recovery: could not move ${from} into the snapshot`);
          return false;
        }
      }
    }
    // COMPLETENESS verification (CodeRabbit round-12): the ACTIVE namespace must now hold NO `loam.db*` artifact
    // and NO media directory — if one does (a rename silently didn't take, or a stat became unverifiable), the
    // snapshot is INCOMPLETE, so fail closed rather than clear the anchor / open fresh over a partial preserve.
    // Because renames are ATOMIC (a file is never lost — it is either here in the active namespace or already
    // in the snapshot), an empty active namespace PROVES a complete snapshot; that is why no separate per-entry
    // inventory needs to be recorded and re-verified.
    for (const dir of [avatarsDir, attachmentsDir]) {
      if (provenAbsence(dir) !== "absent") {
        log.error(`Preserve recovery: ${dir} still present after the move — snapshot incomplete, failing closed`);
        return false;
      }
    }
    let remaining: string[];
    try {
      remaining = readdirSync(dataDir);
    } catch (error) {
      log.error(error, "Preserve recovery: could not re-verify the data directory is clean — failing closed");
      return false;
    }
    if (remaining.some((entry) => entry.startsWith(base))) {
      log.error("Preserve recovery: a `loam.db*` artifact still remains active after the move — snapshot incomplete");
      return false;
    }
    // Both parents must be durable (cross-directory rename changes both) before we report success.
    return fsyncDir(recoveryDir) && fsyncDir(dataDir);
  }

  /**
   * Boot-time resume of an interrupted preserve recovery (P1, Sol round-12): if the durable anchor is present,
   * FINISH the move into the recorded snapshot and clear the anchor, so `openInitialStore` below never opens a
   * fresh DB over a half-moved (incoherent) set. Runs before the store is opened. Fails closed (throws the
   * recoverable {@link DbEncryptionUnreadableError}) rather than open over an uncertain state.
   */
  function resumePreserveRecovery(): void {
    let recoveryDirName: string;
    try {
      recoveryDirName = readFileSync(recoveryStatePath, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return; // no interrupted preserve recovery
      }
      const message =
        "A preserve-recovery anchor is present but UNREADABLE — a partial recovery snapshot may exist; refusing " +
        "to open the database. The node is locked; resolve the filesystem fault and reopen.";
      log.error(message);
      reportBootNotice(message, "db_encryption_unreadable");
      throw new DbEncryptionUnreadableError(message);
    }
    // Validate the anchor content is a plain `.loam-recovery-<suffix>` basename — NEVER a path with separators
    // or `..` (defense-in-depth: the writer only ever emits `.loam-recovery-${ts}-${hex}`, but a corrupted
    // anchor must not let `join(dataDir, …)` resolve the move target outside the data dir).
    if (!recoveryDirName.startsWith(".loam-recovery-") || recoveryDirName !== basename(recoveryDirName)) {
      const message =
        "A preserve-recovery anchor is present but malformed — refusing to open the database (a partial recovery " +
        "snapshot may exist). The node is locked; resolve it and reopen.";
      log.error(message);
      reportBootNotice(message, "db_encryption_unreadable");
      throw new DbEncryptionUnreadableError(message);
    }
    const recoveryDir = join(dataDir, recoveryDirName);
    if (!completePreserveMove(recoveryDir)) {
      const message =
        "Resuming an interrupted preserve recovery: could not durably complete the move into the recovery " +
        `snapshot ("${recoveryDirName}"). The node is locked; resolve the filesystem fault and reopen.`;
      log.error(message);
      reportBootNotice(message, "db_encryption_unreadable");
      throw new DbEncryptionUnreadableError(message);
    }
    if (!clearRecoveryState()) {
      const message =
        "Resuming an interrupted preserve recovery: completed the move but could not durably clear the anchor. " +
        "The node is locked; resolve the filesystem fault and reopen.";
      log.error(message);
      reportBootNotice(message, "db_encryption_unreadable");
      throw new DbEncryptionUnreadableError(message);
    }
    log.warn(`Resumed and completed an interrupted preserve recovery into "${recoveryDirName}".`);
  }

  // Operator "start fresh" confirmation marker (shared launcher contract, SF2/docs/15): the RN host's
  // explicit start-fresh UI writes this file BEFORE restarting the server; `openInitialStore` below
  // consumes (deletes) it as the ONLY thing allowed to trigger an automatic destructive DB replace.
  // Its mere presence is standing in for an operator's affirmative click — nothing else may substitute
  // for it (Sol's design review: an automatic replace on every unopenable DB is wrong).
  const dbStartFreshMarkerPath = join(dataDir, ".loam-db-start-fresh");

  // Durable ANCHOR for a RESUMABLE preserve recovery (P1, Sol round-12). A `preserve` start-fresh moves the
  // whole unopenable DB set + media into a unique `.loam-recovery-<suffix>/` snapshot. The moves are not one
  // atomic op, so this state file (written BEFORE any move, cleared only after the move is durable) records
  // the target snapshot: a boot-time `resumePreserveRecovery` sees it and FINISHES the move, so a crash can
  // never leave the DB set split across the active namespace and the snapshot, or open a fresh DB over a
  // partial one. Named under the `.loam-recovery-` prefix so a kill switch's snapshot sweep clears it too.
  const recoveryStatePath = join(dataDir, ".loam-recovery-state");

  // Durable wipe PHASE file (P1-1, Sol round 8) — replaces the old single `.loam-wipe-pending` marker,
  // which conflated "deletion still pending" with "safe to clear the key". A shared launcher contract with
  // `apps/app/nodejs-project-template/main.js` (both sides updated together):
  //   - `delete-pending`  → a fixed-key wipe started; artifacts are NOT yet PROVEN gone. The launcher must
  //                         NOT clear the device key — it defers to the SERVER's boot-time retry, which
  //                         re-runs artifact deletion under the still-available OLD key before serving.
  //   - `key-clear-ready` → every artifact + media path is PROVEN absent; ONLY now may the launcher clear
  //                         the device key + restart, then delete the phase file.
  // Written DURABLY (atomic temp+rename) BEFORE deletion, advanced to `key-clear-ready` only after the
  // deletion is verified. Route on the PHASE, never on mere presence — see `executeKillSwitchBody` and the
  // boot-time resume below.
  const wipePhaseMarkerPath = join(dataDir, ".loam-wipe-phase");
  // The PRE-round-8 single marker. A round-7 fail-closed wipe could leave THIS on disk alongside a deletion
  // survivor (e.g. an undeletable legacy-key `.premigration`) while 503-locked, telling the operator to
  // reopen. If a device upgrades to this build before reopening, the new phase machine must still recognise
  // the old marker as an unfinished wipe (P1-1, Sol round-8) rather than forgetting it and serving surviving
  // pre-wipe data. Migrated forward to `.loam-wipe-phase=delete-pending`; both names are cleared together
  // only once the whole wipe protocol completes.
  const legacyWipePendingMarkerPath = join(dataDir, ".loam-wipe-pending");

  /**
   * fsync a directory so a create/rename/unlink INSIDE it is durable across power-loss (the directory
   * entry, not just the file's bytes, must be flushed). Returns whether the fsync succeeded — callers that
   * need genuine durability must fail closed on false, NOT log-and-continue (Sol round-8 P1-5). Some
   * filesystems legitimately reject directory fsync with EINVAL; a caller may choose to tolerate that, but
   * the wipe/config paths here do not (correctness over availability on those platforms).
   */
  function fsyncDir(dir: string): boolean {
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      return true;
    } catch (error) {
      log.error(error, `Durable write: parent-directory fsync failed for ${dir} (a rename/unlink there may not survive power-loss)`);
      return false;
    }
  }

  /**
   * Write `contents` to `filePath` DURABLY and ATOMICALLY (Sol round-8 P1-5 / P2-1). Atomic: a reader sees
   * the old file or the complete new one, never a torn write. Durable: it returns `true` ONLY after EVERY
   * step — staging write, file-bytes fsync, atomic rename, AND parent-directory fsync — succeeded, so a
   * caller may treat the write as power-loss-durable strictly on `true`. A bare `writeFileSync`+`rename` is
   * atomic but NOT durable (the OS may hold the bytes and/or the rename in the page cache); a power-loss
   * before both flushes can lose the whole update — which for the wipe-phase marker means forgetting a wipe,
   * and for config.json means silently disarming an armed kill switch. There is deliberately NO non-durable
   * fallback: a failure returns `false` so the caller fails closed rather than proceeding on an unflushed
   * write it believes is durable. The staged bytes are written by PATH (a single interceptable call); the
   * file fsync then reopens the temp read-only purely to flush it (fsync flushes the inode, reachable via
   * any fd, regardless of that fd's mode).
   */
  function durableWriteFileSync(filePath: string, contents: string): boolean {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, contents, "utf8");
      const fd = openSync(tmpPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, filePath);
    } catch (error) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // ENOENT is the common case (the staging write itself failed) — nothing to clean up.
      }
      log.error(error, `Durable write failed for ${filePath}`);
      return false;
    }
    // The parent-directory fsync is REQUIRED, not best-effort: without it the rename itself can be lost on
    // power-loss (resurrecting stale contents), so a failure here means "not durable" → return false.
    return fsyncDir(dirname(filePath));
  }

  /** The durable wipe JOURNAL (Sol round-10 P1-4): `.loam-wipe-phase` now carries the wipe PHASE *and* a
   *  sanitized snapshot of the effective config, committed together in ONE atomic durable write. A SIGKILL
   *  between "record intent" and "persist config.json" can then no longer either FORGET the wipe or LOSE the
   *  current admin config — a boot-time resume restores config.json from this snapshot before it clears the
   *  journal, so config is durable the instant the intent is. */
  // `configInvalid` distinguishes a genuinely ABSENT config snapshot (legacy wipe / no snapshot → proceed)
  // from one that is PRESENT but fails schema validation. `corrupt` covers a journal we cannot read or parse
  // at all (non-ENOENT read error, malformed JSON, a JSON primitive, or unrecognized non-JSON content) — as
  // opposed to an EXACT legacy plain string. In BOTH the `configInvalid` and `corrupt` cases the resume fails
  // closed (locks WITHOUT clearing/rewriting the journal), so if the journal is the only durable copy of the
  // admin config it is never silently dropped and reverted to defaults (CodeRabbit/Sol round-11/12).

  /** Strip the one plaintext bearer secret (`sync.token`) before it is written to `.loam-wipe-phase` or
   *  config.json — both are plain, unprotected files (scrypt-hashed secrets are safe to persist as-is). */
  function sanitizeConfigForRestart(config: LoamConfig): LoamConfig {
    return { ...config, sync: { ...config.sync, token: undefined } };
  }

  /**
   * Durably write the wipe journal `{ phase, config? }` (Sol round-10 P1-4). Returns whether a genuinely
   * DURABLE write succeeded — `true` only after file + parent-directory fsync (fail closed on `false`). The
   * config snapshot (already sanitized) rides along so a resume can restore config.json from it. `readWipeJournal`
   * fail-safes any ambiguous content to `{delete-pending}`.
   */
  function writeWipeJournal(phase: WipePhase, config?: LoamConfig): boolean {
    const payload = config === undefined ? { phase } : { phase, config };
    return durableWriteFileSync(wipePhaseMarkerPath, JSON.stringify(payload));
  }

  /**
   * Read the durable wipe journal. A confirmed `ENOENT` → check the legacy marker (→ `{delete-pending}` or
   * undefined = no wipe). A well-formed `{ phase, config? }` → that (the config is validated against the
   * schema; an invalid config is DROPPED, never trusted). Legacy pre-round-10 plain-string content
   * (`key-clear-ready`/anything-else) is still recognized. ANY other state (unreadable / malformed) →
   * `{delete-pending}` (fail-safe: an ambiguous-but-present journal means a wipe WAS in progress).
   */
  function readWipeJournal(): WipeJournal | undefined {
    let raw: string;
    try {
      raw = readFileSync(wipePhaseMarkerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        // No NEW journal — but a PRE-round-8 `.loam-wipe-pending` marker may still record an unfinished wipe.
        return migrateLegacyWipeMarkerIfPresent();
      }
      // A non-ENOENT read error (EIO/EACCES): we CANNOT read the journal, so we cannot know whether it holds
      // the only config copy. CORRUPT/unverifiable → the resume locks without clearing it (P1-3, round-12).
      return { phase: "delete-pending", corrupt: true };
    }
    // EXACT legacy plain-string content (pre-round-10, no config snapshot) — the ONLY non-JSON forms accepted.
    const trimmed = raw.trim();
    if (trimmed === "delete-pending") {
      return { phase: "delete-pending" };
    }
    if (trimmed === "key-clear-ready") {
      return { phase: "key-clear-ready" };
    }
    // New JSON journal format (round-10+).
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON and not an exact legacy string → unrecognized/malformed. durableWriteFileSync writes the
      // journal atomically (temp+rename), so this is disk corruption, NOT a torn write. CORRUPT → lock, never
      // treat an ambiguous file as a legacy no-config journal and clear it (P1-3, round-12).
      return { phase: "delete-pending", corrupt: true };
    }
    // JSON must be a `{ phase, config? }` OBJECT. A primitive (null/number/string/boolean) or an array is not
    // a valid journal → CORRUPT (lock), not a legacy no-config journal.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { phase: "delete-pending", corrupt: true };
    }
    const obj = parsed as { phase?: unknown; config?: unknown };
    // Only the two recognized phases are valid. A missing or unrecognized `phase` is a malformed journal →
    // CORRUPT (lock), NOT silently coerced to `delete-pending` (which would clear it, losing config) — CodeRabbit.
    if (obj.phase !== "delete-pending" && obj.phase !== "key-clear-ready") {
      return { phase: "delete-pending", corrupt: true };
    }
    const phase: WipePhase = obj.phase;
    let config: LoamConfig | undefined;
    let configInvalid = false;
    if (obj.config !== undefined) {
      const validated = LoamConfigSchema.safeParse(obj.config);
      if (validated.success) {
        config = validated.data;
      } else {
        // Present but invalid (disk corruption) — the resume fails closed rather than silently dropping it.
        configInvalid = true;
      }
    }
    return { phase, config, configInvalid };
  }

  /**
   * P1-1 (Sol round-8) upgrade path: when there is NO new `.loam-wipe-phase`, a present (or unreadable)
   * legacy `.loam-wipe-pending` marker means a pre-round-8 wipe was still unfinished — treat it as
   * `delete-pending` (NEVER `key-clear-ready`: the old marker cannot prove deletion completed) and MIGRATE it
   * durably to the new journal (no config snapshot exists for a legacy wipe). The legacy marker is NOT removed
   * here — both names are cleared together only once the protocol completes (`clearWipePhase`).
   */
  function migrateLegacyWipeMarkerIfPresent(): WipeJournal | undefined {
    if (provenAbsence(legacyWipePendingMarkerPath) === "absent") {
      return undefined; // no wipe pending under EITHER name — a normal boot
    }
    if (!writeWipeJournal("delete-pending")) {
      log.error(
        "Wipe resume: found a legacy `.loam-wipe-pending` marker but could NOT durably migrate it to " +
          "`.loam-wipe-phase` — treating as delete-pending for this boot; the legacy marker persists so a later boot retries.",
      );
    } else {
      log.warn(
        "Wipe resume: migrated a pre-round-8 `.loam-wipe-pending` marker to `.loam-wipe-phase=delete-pending`; " +
          "deletion will be re-run and verified before any device-key clear.",
      );
    }
    return { phase: "delete-pending" };
  }

  /** Delete the durable wipe-phase file, returning whether it is now PROVEN gone (removed, or confirmed
   *  absent). The ONLY places allowed to call this: the launcher's verified `loam-wipe-complete` handoff
   *  (via main.js, not here) after a `key-clear-ready` wipe, and the desktop/no-hook fallback below where
   *  the key cannot be rotated in-process anyway. A `false` return means the marker may still be on disk,
   *  so the caller must NOT treat the wipe as finished (else the next boot re-reads it and re-wipes). */
  function clearWipePhase(): boolean {
    // Remove BOTH the new phase file AND any migrated-from legacy `.loam-wipe-pending` marker (P1-1): if the
    // legacy name lingered after a migration, leaving it would make the NEXT boot re-recognise it as a
    // pending wipe and re-wipe the fresh DB in a loop. Both must be proven gone for a clean completion.
    for (const path of [wipePhaseMarkerPath, legacyWipePendingMarkerPath]) {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        log.warn(error, `Kill switch: failed to delete ${path} (a later boot re-reads it)`);
      }
      // `rmSync{force:true}` swallows ENOENT, so a throw here is a real removal failure — re-verify absence.
      if (provenAbsence(path) !== "absent") {
        return false;
      }
    }
    // fsync the parent DIRECTORY so the unlinks are durable BEFORE any caller mints a new device key or opens
    // a fresh DB (Sol round-8 P1-5.3): otherwise a power-loss after the unlink but before it reaches stable
    // storage can RESURRECT the phase file as `key-clear-ready`, and the next boot would clear the freshly
    // minted key and strand the new database. A parent-dir fsync failure → report NOT-cleared (fail closed).
    return fsyncDir(dataDir);
  }

  /**
   * Boot-time store open, tolerant of an unopenable DB (F4/SF2, docs/15). A failure here used to reject
   * `buildApp` outright — and because the DB-encryption mode is persisted config, EVERY later boot hit
   * the identical failure, permanently locking the operator out of their own node. The host must always
   * boot (crisis-messaging priority), so this degrades in order instead of throwing straight through:
   *
   *  0. Consume the start-fresh confirmation marker FIRST, before touching anything else (P2-3, Sol
   *     round 3). It's a one-shot, human-confirmed authorization for a SPECIFIC unopenable-DB incident,
   *     so it must be read-and-deleted atomically-in-intent up front, not lazily checked only once
   *     everything else has already failed — the old code left it on disk untouched whenever the
   *     normal open (step 1) or the plaintext fallback (step 2) happened to succeed (e.g. the operator
   *     independently fixed the key), so a stale marker could silently authorize a LATER, UNRELATED
   *     unopenable-DB failure the operator never actually confirmed. If the delete itself fails, fail
   *     CLOSED: treat the marker as NOT confirmed for this boot rather than risk honoring it without
   *     actually consuming it.
   *  1. Open exactly as configured (keyed if a key was resolved, else plaintext).
   *  2. On failure, IF a key was resolved, probe whether the SAME file opens with no key. If it does, the
   *     on-disk DB is genuinely PLAINTEXT while an encrypted mode is configured (P1-4-server, Sol round 8).
   *     The old code SILENTLY served that plaintext file (a confidentiality downgrade). Now it does NOT:
   *       - with a start-fresh confirmation (step 0) → DELETE the plaintext DB (not rename-aside — leaving
   *         readable plaintext would defeat the switch to encryption) and open a FRESH ENCRYPTED database
   *         (`db_encryption_recovered_fresh`);
   *       - without one → report `db_encryption_plaintext_unconverted` and THROW a typed error, LOCKING
   *         (like the unreadable path) so the RN UI can offer the destructive "delete data and start
   *         encrypted" flow. The plaintext-fallback-to-serving is only reached when NO key was resolved
   *         (step 1 already WAS the plaintext open). A ciphertext file with the wrong key falls through to
   *         step 3 (marker-gated recovery), not a raw "file is not a database" throw.
   *  3. Still unopenable: the file is genuinely unreadable with what we have (wrong/lost key, or
   *     ciphertext with no key at all). An automatic destructive "start fresh" is NEVER triggered here
   *     — only an explicit operator confirmation may do that (the design issue with the old behaviour,
   *     which auto-replaced on every unopenable DB and, on a second occurrence, renamed straight onto
   *     the fixed `loam.db.unreadable` name, destroying the first preserved copy — P1-3). So:
   *       - marker was NOT confirmed (step 0) → report `db_encryption_unreadable` and THROW a typed
   *         {@link DbEncryptionUnreadableError}, failing boot NON-destructively (the original files are
   *         untouched) — `embedded-main.ts` recognizes the `.code` and keeps the host runtime alive
   *         (rather than exiting) specifically so the RN launcher bridge can still receive an
   *         operator's subsequent start-fresh confirmation and retry boot in-process (P1-1).
   *       - marker WAS confirmed (step 0) → rename the whole `loam.db`/`-wal`/`-shm` set aside together
   *         under a UNIQUE, collision-proof suffix (timestamp + random bytes, so two successive
   *         recoveries each keep their own preserved copy instead of the second overwriting the first),
   *         open a fresh database, and report `db_encryption_recovered_fresh`.
   *
   * Every report goes over the same RN bridge `embedded-main.ts` uses for fatal boot errors — and NEVER
   * includes the key itself — so the host UI can surface the right action. The real fix for case 2 is a
   * genuine plaintext→encrypted REKEY (SQLCipher `sqlcipher_export` / `PRAGMA rekey`), which is unbuilt;
   * this is a boot-time safety net, not a substitute for it.
   */
  function openInitialStore(): LoamStore {
    // P1 (Sol round-12): FINISH any interrupted preserve recovery FIRST — before consuming the start-fresh
    // marker or opening the store — so a fresh DB is never opened over a half-moved (incoherent) DB set. A
    // no-op when no recovery is pending; throws (locks) on an unverifiable/incomplete resume.
    resumePreserveRecovery();

    const keyWasResolved = state.dbKey !== undefined;

    /**
     * Execute a confirmed start-fresh honoring the operator's INTENT (P1-2, Sol round-9) — the SINGLE place
     * every destructive/preservative start-fresh branch (plaintext-under-encrypted AND ciphertext-wrong-key)
     * funnels through, so the full-inventory + durability rules are enforced once:
     *   - `delete` (deliberate destructive mode change): delete + PROVE-gone the FULL inventory — every DB
     *     artifact AND user media (attachments are message content, avatars are persisted user data) — DURABLY
     *     (dir fsync), fail closed on any survivor/unverifiable path, then open fresh. A renamed-aside copy
     *     would stay recoverable under the retained device secret, so a real, verified, durable delete is
     *     required; "permanently deleted" must mean durable absence, not just current-namespace absence.
     *   - `preserve` (accidental wrong/lost-key lockout): rename the whole DB set aside under a unique suffix
     *     for a possible later attempt, then open fresh. NEVER reaches deletion.
     * A failure after the (already consumed) one-shot marker is recast as the recognized
     * `db_encryption_unreadable` recovery so the runtime stays alive and the operator can re-confirm, rather
     * than a generic `boot_failed` process exit.
     */
    function startFreshWithIntent(intent: "delete" | "preserve"): LoamStore {
      if (intent === "delete") {
        const deletion = deleteAndVerifyAllWipeArtifactsDurable();
        if (!deletion.ok) {
          const remaining = [...deletion.survivors, ...deletion.errors].join(", ");
          const message =
            "Delete-and-start-fresh was confirmed, but the previous data could not be deleted and VERIFIED " +
            `gone durably (${remaining}) — refusing to open a fresh database over recoverable data. Confirm ` +
            "delete-and-start-fresh again to retry.";
          log.error(message);
          reportBootNotice(message, "db_encryption_unreadable");
          throw new DbEncryptionUnreadableError(message);
        }
        try {
          const store = openLoamStore();
          const message =
            "An explicit DELETE start-fresh confirmation was present, so the previous database and all user " +
            "media were deleted and VERIFIED gone (durably) and a fresh database was started.";
          log.warn(message);
          reportBootNotice(message, "db_encryption_recovered_fresh");
          return store;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const message =
            `Delete-and-start-fresh deleted the previous data but then failed opening a fresh database (${detail}). ` +
            "The confirmation was already consumed; the operator can confirm delete-and-start-fresh again to retry.";
          log.error(message);
          reportBootNotice(message, "db_encryption_unreadable");
          throw new DbEncryptionUnreadableError(message);
        }
      }

      // preserve: move the WHOLE snapshot — the DB set AND user media (avatars + attachments) — into a UNIQUE
      // recovery DIRECTORY, RESUMABLY (P1, Sol round-12). Leaving media in the active namespace let the orphan
      // reaper delete it; a dedicated `.loam-recovery-<suffix>/` keeps the snapshot coherent and out of the
      // reaper's path AND the fresh node's active dirs. Because the moves aren't one atomic op, a durable ANCHOR
      // (`.loam-recovery-state`) is written BEFORE any move, so a crash mid-move is FINISHED by
      // `resumePreserveRecovery` on the next boot (the DB set never ends up split across the two directories).
      // `completePreserveMove` uses ENOENT-only presence checks and fsyncs BOTH parent dirs. A kill switch
      // still wipes the snapshot + anchor (both under the `.loam-recovery-` prefix).
      try {
        const preservedSuffix = `${Date.now()}-${randomBytes(3).toString("hex")}`;
        const recoveryDirName = `.loam-recovery-${preservedSuffix}`;
        const recoveryDir = join(dataDir, recoveryDirName);
        // 1. Durable anchor FIRST (before any move) so an interrupted move is resumed, not left split.
        if (!writeRecoveryState(recoveryDirName)) {
          throw new Error("could not durably record the preserve-recovery anchor");
        }
        // 2. Move the whole set into the snapshot, durably (both parents fsynced); resumable + coherent.
        if (!completePreserveMove(recoveryDir)) {
          throw new Error("preserve-recovery move could not be completed durably");
        }
        // 3. A small manifest (informational; recovery does not depend on it).
        try {
          writeFileSync(
            join(recoveryDir, "manifest.json"),
            JSON.stringify({ preservedAt: preservedSuffix, reason: "start-fresh preserve recovery (unopenable DB)" }),
            "utf8",
          );
        } catch (manifestError) {
          log.warn(manifestError, "Preserve recovery: could not write the snapshot manifest (informational only)");
        }
        // 4. Clear the anchor — the snapshot is complete + durable and the active namespace is clean.
        if (!clearRecoveryState()) {
          throw new Error("could not durably clear the preserve-recovery anchor");
        }
        // Open the fresh store BEFORE reporting success (CodeRabbit): a fresh-open failure must surface as the
        // recoverable `db_encryption_unreadable` (via the catch below), not a false `db_encryption_recovered_fresh`.
        const store = openLoamStore();
        const message =
          "An explicit PRESERVE start-fresh confirmation was present, so the previous database and all user media " +
          `were moved into a recovery snapshot ("${recoveryDirName}/") and a fresh database was started.`;
        log.warn(message);
        reportBootNotice(message, "db_encryption_recovered_fresh");
        return store;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message =
          "Start-fresh recovery failed while moving the previous database into the recovery snapshot or opening a " +
          `fresh one (${detail}). The confirmation was already consumed; the operator can confirm start-fresh again ` +
          "to retry (the recovery anchor makes any partial move resume on the next boot).";
        log.error(message);
        reportBootNotice(message, "db_encryption_unreadable");
        throw new DbEncryptionUnreadableError(message);
      }
    }

    // Step 0 (P2-3): consume the marker up front, unconditionally, before any open attempt — see the
    // doc comment above for why this can't wait until both opens have failed.
    let startFreshConfirmed = false;
    // P1-6 (Sol round 8): the marker carries the operator's INTENT. `delete` = a DELIBERATE destructive mode
    // change (the operator chose "Delete & start fresh" in Settings) → the prior DB must be DELETED and PROVEN
    // gone, not renamed aside (a renamed-aside encrypted DB stays recoverable under the retained device
    // secret, so "deleted" would be a lie). Anything else — `preserve`, a legacy timestamp marker, or an
    // unreadable one — = accidental wrong/lost-key LOCKOUT recovery → preserve the old ciphertext aside for a
    // possible later attempt. Default `preserve` (NEVER destroy on an ambiguous/unreadable marker).
    let startFreshIntent: "delete" | "preserve" = "preserve";
    if (existsSync(dbStartFreshMarkerPath)) {
      try {
        if (readFileSync(dbStartFreshMarkerPath, "utf8").trim() === "delete") {
          startFreshIntent = "delete";
        }
      } catch {
        // Unreadable marker → keep the safe `preserve` default (never escalate to destruction on ambiguity).
      }
      try {
        rmSync(dbStartFreshMarkerPath, { force: true });
        startFreshConfirmed = true;
      } catch {
        // Fail closed: an unremovable marker is NOT treated as a valid confirmation this boot. It
        // stays on disk (we couldn't delete it), so a later boot gets another chance at a clean delete
        // — but THIS boot must not skip straight to a destructive replace on the strength of a marker
        // it couldn't actually consume.
        startFreshConfirmed = false;
      }
    }

    // Step 0b (P1-a, Sol round 6): resume an interrupted rekey-migration, CRASH-ATOMICALLY. The migration
    // branch below rekeys the live DB in place (SQLCipher `PRAGMA rekey`), which is NOT crash-atomic — an
    // OS-kill mid-rekey can leave `loam.db` openable under NEITHER the legacy key nor the current one,
    // destroying pre-round-4 passphrase data. To make that recoverable the migration first COMMITS a
    // single-file, checkpoint-folded snapshot of the intact legacy DB to `loam.db.premigration` (copy →
    // `.tmp` → atomic rename), then rekeys, then deletes it on success. A COMMITTED `loam.db.premigration`
    // present HERE is AMBIGUOUS (RF6-b): usually an interrupted rekey (restore it), but possibly a
    // migration that already SUCCEEDED whose backup-cleanup `rmSync` threw — leaving the stale snapshot
    // behind through a serving session whose new data now lives in `loam.db`. The two are disambiguated
    // below by PROBING the live DB under the current key: opens → already migrated, discard the stale
    // backup and preserve the live data; doesn't open → genuine interrupt, restore. Because the snapshot
    // is a SINGLE file, restore is ONE atomic `rename` (RF6-a: after first clearing a FOREIGN `loam.db-wal`/
    // `-shm`/`-journal` — the rekey runs under DELETE journal mode, so an interrupt leaves a `-journal`
    // rollback journal, NOT a `-wal`/`-shm` pair) — no multi-file race, and it can never install a partial
    // backup. A leftover `.premigration.tmp` (a kill before the commit rename) is NOT a committed backup —
    // discard it, never restore from it (the live DB is still intact; the migration just re-runs).
    // Best-effort — a restore failure falls through to the normal open/recovery chain below (no worse than
    // before). The backup holds ciphertext, not the key.
    {
      const committedBackup = `${dbPath}.premigration`;
      const backupTmp = `${dbPath}.premigration.tmp`;
      try {
        // Discard any uncommitted/partial artifacts unconditionally: a stray `.tmp` (killed before the
        // commit rename) and any legacy multi-file `-wal`/`-shm` sidecars a pre-redesign build may have
        // left. None of these is a committed backup, so none is ever restored.
        rmSync(backupTmp, { force: true });
        rmSync(`${dbPath}-wal.premigration`, { force: true });
        rmSync(`${dbPath}-shm.premigration`, { force: true });

        if (existsSync(committedBackup)) {
          // RF6-b (Sol round 6): a committed `.premigration` present here is AMBIGUOUS. Normally it is the
          // intact legacy snapshot left by an INTERRUPTED rekey (restore is correct) — UNLESS a PRIOR
          // migration actually SUCCEEDED and its post-success `rmSync(committedBackup)` cleanup threw
          // (read-only dir, locked file), leaving the stale backup behind through a whole serving session.
          // In THAT case the live `loam.db` holds the migrated data (plus a `-wal` of un-checkpointed
          // messages from the session that just ran), and a BLIND restore would delete that WAL and rename
          // the stale pre-migration snapshot over the live DB — losing data and re-migrating every boot.
          // Disambiguate by PROBING: open the live `loam.db` under the CURRENT key (`state.dbKey`). If it opens,
          // the migration already committed and this backup is stale garbage → delete it (and any sidecars/
          // journal) and leave the live DB and its `-wal`/`-shm` untouched. Only if the live DB does NOT
          // open under the current key is this a genuine interrupted rekey → restore. With no key this boot
          // (plaintext — can't probe an encrypted DB) keep the conservative restore.
          let liveOpensUnderCurrentKey = false;
          if (state.dbKey !== undefined && existsSync(dbPath)) {
            try {
              const probe = openLoamStore();
              probe.close();
              liveOpensUnderCurrentKey = true;
            } catch {
              liveOpensUnderCurrentKey = false;
            }
          }

          if (liveOpensUnderCurrentKey) {
            // The owning migration already SUCCEEDED — the leftover backup is stale. Preserve the serving
            // session's live data (do NOT touch `loam.db`/`-wal`/`-shm`); just delete the stale backup and
            // any of its own sidecars/journal.
            rmSync(committedBackup, { force: true });
            rmSync(`${dbPath}-wal.premigration`, { force: true });
            rmSync(`${dbPath}-shm.premigration`, { force: true });
            rmSync(`${committedBackup}-journal`, { force: true });
            log.warn(
              "Found a leftover pre-migration DB backup whose owning migration already SUCCEEDED (the live " +
                "database opens under the current key) — discarding the stale backup and preserving the live " +
                "database and its WAL rather than restoring the stale snapshot over it (RF6-b).",
            );
          } else {
            // Genuine interrupted rekey (or a plaintext boot that can't probe): restore the intact single-
            // file snapshot. RF6-a: the rekey runs under DELETE journal mode (SQLCipher refuses to rekey
            // under WAL), so an interrupted rekey leaves a `loam.db-journal` ROLLBACK journal — NOT a
            // `-wal`/`-shm` pair. Drop `-wal`/`-shm`/`-journal` first so the restored single self-consistent
            // file can never be paired with a FOREIGN hot journal, then a SINGLE atomic rename installs the
            // snapshot over the live DB. The snapshot folded its own WAL in before it was copied, so the
            // restored `loam.db` opens standalone with no journal of its own. Killed between the rm and the
            // rename? The committed backup is still present, so the next boot repeats this idempotently.
            rmSync(`${dbPath}-wal`, { force: true });
            rmSync(`${dbPath}-shm`, { force: true });
            rmSync(`${dbPath}-journal`, { force: true });
            renameSync(committedBackup, dbPath);
            log.warn(
              "Restored an interrupted DB key-migration from its committed single-file pre-migration backup — " +
                "the legacy-encrypted database is intact again and the migration will be retried this boot.",
            );
          }
        }
      } catch (error) {
        log.error(
          error,
          "Failed to restore the pre-migration DB backup after an interrupted rekey — continuing to the " +
            "normal open/recovery path",
        );
      }
    }

    try {
      const opened = openLoamStore();
      if (keyWasResolved && (options.dbEncryptionMigrateFromKey !== undefined || options.dbEncryptionMode === "passphrase")) {
        // P1-1 (Sol round 5): the current key opened it directly — either this is already migrated, or
        // it's a genuinely fresh install that never needed the legacy key at all. Either way, the
        // launcher offered a legacy key because it hasn't recorded a confirmed migration yet (see
        // db-encryption.ts's passphrase key-version marker) — tell it to stop, so later boots skip this
        // extra key entirely. Since 2026-09-04 the ack is ALSO sent for every successful passphrase-mode
        // open: it is the launcher's "the database opened under this attempt's passphrase" confirmation,
        // which is what retires a pre-change install's stored passphrase and records that a passphrase
        // governs the database — never at read time, where a discarded attempt would lose it.
        reportDbKeyMigrated(options.dbKeyRequestId);
      }
      return opened;
    } catch {
      // Fall through — try the legacy-key migration below, then the plaintext fallback (case 2), or
      // recovery (case 3).
    }

    // P1-1 (Sol round 5): passphrase key-derivation migration. Round 4 changed the passphrase-mode key
    // from `SHA256(passphrase)` to `SHA256(passphrase + ':' + deviceSecret)` — an existing passphrase DB
    // encrypted under the OLD derivation can no longer be opened with `state.dbKey` at all. If the launcher
    // handed us that legacy derivation too (`dbEncryptionMigrateFromKey`, set only when it hasn't
    // recorded a confirmed migration), try opening with IT; on success, `PRAGMA rekey` the database to
    // the current key in place — every later boot then opens directly under `state.dbKey`, and this boot
    // reports the migration back so the launcher stops offering the legacy key. Never logs either key.
    if (keyWasResolved && options.dbEncryptionMigrateFromKey !== undefined) {
      try {
        const legacyStore = openStore(dbPath, {
          encryptionKey: options.dbEncryptionMigrateFromKey,
          driver: options.dbDriver,
        });

        // P1-a (Sol round 6): commit a CRASH-ATOMIC, single-file pre-migration backup BEFORE the in-place
        // `PRAGMA rekey`. `rekey` rewrites pages under the new key in place and is NOT crash-atomic; an
        // OS-kill mid-rekey could leave the DB openable under neither key, permanently losing pre-round-4
        // passphrase data. The backup makes that recoverable — but the backup ITSELF must be crash-atomic,
        // or a kill mid-copy would leave a truncated sidecar that Step 0b then restores OVER the intact live
        // DB. So, crash-atomically:
        //   1. `checkpoint()` (`wal_checkpoint(TRUNCATE)`) folds the WAL into the single `loam.db` file, so
        //      committed transactions still resident in the WAL are NOT lost by the file-level copy below —
        //      and there is nothing left in `-wal`/`-shm` to snapshot. (legacyStore is the sole connection.)
        //   2. Copy that single file to `loam.db.premigration.tmp`.
        //   3. Atomically `rename` (POSIX-atomic) `.tmp` → `loam.db.premigration`. The COMMITTED backup is
        //      ONLY ever the post-rename file: a kill before the rename leaves an ignored `.tmp`, never a
        //      half-written backup Step 0b could restore.
        // On rekey SUCCESS the committed backup is deleted (below); on FAILURE it is left for Step 0b to
        // restore and retry. If the backup can't be committed, do NOT proceed with an unbackable non-atomic
        // rekey — clean up and fall through instead.
        const committedBackup = `${dbPath}.premigration`;
        const backupTmp = `${dbPath}.premigration.tmp`;
        try {
          legacyStore.checkpoint();
          rmSync(backupTmp, { force: true }); // clear any stray tmp from a prior interrupted attempt
          copyFileSync(dbPath, backupTmp);
          renameSync(backupTmp, committedBackup);
        } catch (backupError) {
          rmSync(backupTmp, { force: true });
          rmSync(committedBackup, { force: true });
          legacyStore.close();
          log.error(
            backupError,
            "Could not commit the pre-migration DB backup before rekey — skipping the in-place migration " +
              "this boot rather than risk an unrecoverable interrupted rekey",
          );
          throw backupError;
        }

        try {
          legacyStore.rekey(state.dbKey!);
        } catch (rekeyError) {
          // Leave the committed backup in place — Step 0b on the next boot restores the intact legacy DB
          // and retries. Only the store handle is released here.
          legacyStore.close();
          throw rekeyError;
        }

        // P2-2 (Sol round 7): the rekey is the COMMIT point of the migration. From here `loam.db` is a
        // valid database under the CURRENT key and `legacyStore` is its live, migrated handle — the
        // migration has SUCCEEDED regardless of whether the post-success sidecar cleanup below works. So
        // COMMIT FIRST — flip `state.encryptionEnabled`, report the migration to the launcher, and return the
        // live store — and treat the `.premigration` cleanup as strictly best-effort in its OWN
        // try/catch. Previously that cleanup sat inside the broad outer migration `try`, so a throwing
        // `rmSync` (read-only dir, locked file) jumped to the outer `catch` and fell through as if the
        // legacy key / rekey had FAILED — leaking this already-rekeyed handle and running the plaintext/
        // recovery chain against a DB that is ALREADY valid under the current key. A stale backup left
        // behind is harmless: the next boot's Step-0b probe finds the live DB opens under the current key
        // and discards it (RF6-b). NEVER let a cleanup failure fail this boot.
        state.encryptionEnabled = true;
        const message = "Migrated an existing passphrase-encrypted database to the current key derivation.";
        log.warn(message);
        reportDbKeyMigrated(options.dbKeyRequestId);

        // Best-effort post-commit cleanup: drop the pre-migration backup (and any stray tmp) so a later
        // boot doesn't mistake it for an interrupted migration to resume. RF6-a: also clear any
        // `loam.db-journal` the DELETE-mode rekey may have left — a successful rekey folds WAL back on and
        // SQLCipher deletes its rollback journal on commit, so this is normally a no-op, but removing it
        // defensively guarantees the freshly-rekeyed single file is never left paired with a foreign
        // rollback journal.
        try {
          rmSync(committedBackup, { force: true });
          rmSync(backupTmp, { force: true });
          rmSync(`${dbPath}-journal`, { force: true });
        } catch (cleanupError) {
          log.warn(
            cleanupError,
            "Post-migration cleanup of the pre-migration DB backup failed — the migration itself already " +
              "SUCCEEDED and is committed (the live DB is valid under the current key); the stale backup " +
              "will be discarded by the next boot's Step-0b probe. Continuing this boot with the migrated store.",
          );
        }

        return legacyStore;
      } catch {
        // The legacy key didn't open it either (or the backup/rekey itself failed) — this isn't a stale-
        // derivation DB after all; fall through to the plaintext fallback / recovery chain below. Any
        // `.premigration` sidecars a FAILED rekey left behind are deliberately preserved for Step 0b to
        // resume on the next boot.
      }
    }

    if (keyWasResolved) {
      // P1-4-server (Sol round 8): an encrypted mode is configured (a key was resolved) but the keyed open
      // failed. Probe whether the on-disk DB is actually PLAINTEXT. If it opens with no key, the file is a
      // genuine plaintext SQLite DB under an encrypted mode — the persisted mode/hint say encrypted. The old
      // code SILENTLY served that plaintext file (`state.encryptionEnabled=false`, `db_encryption_open_failed`),
      // a confidentiality downgrade the operator was never told about. Instead LOCK: do NOT serve plaintext.
      let plainStore: LoamStore | undefined;
      try {
        plainStore = openStore(dbPath, { driver: options.dbDriver });
      } catch {
        // Not plaintext either (genuine ciphertext with the wrong key) — fall through to the marker-gated
        // recovery below, exactly as before.
      }

      if (plainStore) {
        // Release the probe handle immediately — we never serve from it on this path.
        plainStore.close();

        if (startFreshConfirmed) {
          // P1-2 (Sol round-9): HONOR THE INTENT even here. The old code deleted the plaintext DB regardless
          // of intent, so a `preserve`/legacy/malformed marker (which defaults to `preserve`) could still
          // authorize destruction — violating the "preserve never deletes" contract. Route through the single
          // intent-aware helper: `delete` deletes + proves the FULL inventory (incl. media) gone durably;
          // `preserve` renames the DB aside. (The plaintext-unconverted recovery button now sends `delete`.)
          return startFreshWithIntent(startFreshIntent);
        }

        // No confirmation → do NOT silently serve plaintext. Report the distinct code and LOCK (typed error,
        // like the unreadable path), so `embedded-main.ts`/main.js keep the runtime alive and the RN UI can
        // offer the destructive "delete data and start encrypted" flow (which writes the start-fresh marker
        // consumed above). NEVER include the key in the message.
        const message =
          "An existing PLAINTEXT database is present but an encrypted mode is configured — refusing to " +
          "serve it unencrypted (a silent downgrade). Confirm 'delete data and start encrypted', or fix the key.";
        log.error(message);
        reportBootNotice(message, "db_encryption_plaintext_unconverted");
        throw new DbEncryptionPlaintextUnconvertedError(message);
      }
    }

    if (!startFreshConfirmed) {
      const message =
        "The database could not be opened (wrong/lost key, or an unreadable file) and no start-fresh " +
        "confirmation is present; boot failed without touching the existing files.";
      log.error(message);
      reportBootNotice(message, "db_encryption_unreadable");
      throw new DbEncryptionUnreadableError(message);
    }

    // The existing DB is genuine ciphertext the current key can't open. Route through the single intent-aware
    // helper (P1-2/P1-6, Sol round-9): `delete` (deliberate mode change) deletes + proves the FULL inventory
    // gone durably (a renamed-aside encrypted DB stays recoverable under the retained device secret, so a real
    // delete is required); `preserve` (accidental lockout) renames the set aside for a later attempt.
    return startFreshWithIntent(startFreshIntent);
  }

  /**
   * Boot-time wipe-phase resume (P1-1, Sol round 8) — runs BEFORE the real store is opened for serving.
   * Routes on the durable PHASE, not mere marker presence:
   *   - `delete-pending`  → an earlier fixed-key wipe never PROVED its artifacts gone (or was killed mid-
   *                         deletion). RE-RUN the full artifact+media deletion under the still-available OLD
   *                         key. On success, advance to `key-clear-ready` and hand off to the launcher to
   *                         clear the device key + restart; on failure, stay `delete-pending` (a later reopen
   *                         retries). Either way, do NOT open/serve the real DB — throw {@link WipeResumeInProgressError}.
   *   - `key-clear-ready` → artifacts already proven gone; the ONLY step left is the launcher's device-key
   *                         clear. In the normal flow main.js does that dance and deletes the phase file
   *                         BEFORE booting the server, so the server never sees this; if it does (defensive),
   *                         re-signal the launcher rather than serve under the un-cleared key.
   * Returns the store to serve from when there is NOTHING to resume (`undefined` phase); otherwise throws.
   */
  function resumeWipePhaseThenOpenStore(): LoamStore {
    const journal = readWipeJournal();
    if (journal === undefined) {
      return openInitialStore();
    }
    // The resume treats `delete-pending` and `key-clear-ready` identically — both re-verify deletion and
    // (re-)advance — so only the config snapshot is read here; the phase is fail-safe either way.
    const { config, configInvalid, corrupt } = journal;

    // Round-11/12 (CodeRabbit/Sol): a journal we cannot trust — either UNREADABLE/unparseable (`corrupt`) or
    // with a PRESENT-but-INVALID config snapshot (`configInvalid`) — must NOT be silently proceeded past. If
    // config.json's live write failed, this journal is the only durable copy of the admin config; clearing or
    // ignoring it would revert the armed kill switch / security profile / retention to defaults. Fail closed:
    // lock WITHOUT clearing/rewriting the journal, so the bytes survive for inspection/repair.
    if (corrupt || configInvalid) {
      const detail = corrupt
        ? "could not be read or parsed (unreadable or malformed — possible disk corruption)"
        : "has a PRESENT but INVALID config snapshot";
      const message =
        `Resuming an interrupted emergency wipe: the wipe journal ${detail}. Refusing to proceed — clearing or ` +
        "ignoring it could lose the admin config. The node is locked; inspect or repair `.loam-wipe-phase` and reopen.";
      log.error(message);
      reportBootNotice(message, "kill_switch_wipe_incomplete");
      throw new WipeResumeInProgressError(message);
    }

    // P1-4 (Sol round-10): RESTORE config.json FROM THE JOURNAL SNAPSHOT FIRST — before any deletion or phase
    // advance, and before the journal is ever cleared. The live wipe committed the effective config INTO the
    // journal atomically with the intent, so even if its live config.json write never landed (or a crash hit
    // before it), the current admin config (armed kill switch, panic token, security profile, retention…) is
    // recovered here rather than reverting to defaults. If we can't persist it yet, do NOT proceed (a later
    // clear would lose the only copy) — stay locked; a later boot retries from the still-intact journal.
    if (config !== undefined && !persistConfigForRestart(config)) {
      const message =
        "Resuming an interrupted emergency wipe: the config snapshot in the wipe journal could NOT be persisted " +
        "to config.json yet — refusing to proceed (a later journal clear would lose the current admin config). " +
        "The node is locked; resolve the filesystem fault and reopen to retry.";
      log.error(message);
      reportBootNotice(message, "kill_switch_wipe_incomplete");
      throw new WipeResumeInProgressError(message);
    }

    const hook = wipeRestartHook();

    // Both phases need the artifacts PROVEN gone (and the deletion made DURABLE — dir fsync) before any
    // device-key clear. For `delete-pending` this is the retry the whole redesign hinges on; for
    // `key-clear-ready` it's a cheap idempotent re-verify. Durable so the deletions can't be lost by a
    // power-loss between here and the key clear (CodeRabbit round-10).
    const deletion = deleteAndVerifyAllWipeArtifactsDurable();

    if (!deletion.ok) {
      // Deletion still incomplete/unverifiable — stay `delete-pending` and do NOT clear the key. Refuse to
      // serve the surviving DB (it may hold pre-wipe data under the old key). A later reopen re-runs this.
      // The downgrade write matters when we ENTERED at `key-clear-ready` (a defensive re-verify that just
      // failed): if the file can't be rewritten to `delete-pending`, it lingers as `key-clear-ready` and the
      // launcher's next-boot gate could clear the key while artifacts survive. We can't force a broken FS to
      // accept the write, but we surface it loudly and stay locked THIS boot regardless (CodeRabbit CRITICAL).
      const downgraded = writeWipeJournal("delete-pending", config);
      const remaining = [...deletion.survivors, ...deletion.errors].join(", ");
      const durability = downgraded
        ? "the durable `delete-pending` phase is recorded, so the next boot re-runs deletion under the old key"
        : "AND the phase file could NOT be rewritten to `delete-pending` — if it entered at `key-clear-ready`, " +
          "reopen the node PROMPTLY so the server re-runs deletion before any launcher key-clear";
      const message =
        "Resuming an interrupted emergency wipe: artifact deletion is still incomplete or unverifiable " +
        `(${remaining}) — ${durability}. The database was NOT opened and the device key was NOT cleared.`;
      log.error(message);
      reportBootNotice(message, "kill_switch_wipe_incomplete");
      throw new WipeResumeInProgressError(message);
    }

    // Every artifact + media path is PROVEN gone. Advance to `key-clear-ready` durably (carrying the config
    // snapshot forward), THEN hand off. A failed write here self-heals: the phase stays `delete-pending`, so a
    // next boot re-enters this resume, re-verifies deletion (idempotent), and re-advances.
    const phaseReady = writeWipeJournal("key-clear-ready", config);

    if (!hook) {
      // Desktop/CI (no launcher): the device key can't be rotated in-process. The wipe already deleted the
      // ciphertext; clear the phase and boot a fresh (same-key) DB — the documented desktop limitation. If the
      // phase file can't be removed, do NOT open a fresh store: the next boot would re-read `key-clear-ready`
      // and re-wipe the fresh DB on every launch. Stay locked (fail-closed) so a persistent FS fault surfaces
      // as a stuck node rather than a silent perpetual-wipe loop (CodeRabbit MAJOR).
      if (!clearWipePhase()) {
        const message =
          "Resuming an interrupted emergency wipe: artifacts are deleted, but the durable wipe-phase file could " +
          "NOT be removed on a node with no launcher hook — refusing to open a fresh database (it would be " +
          "re-wiped on the next boot). The node is locked; resolve the filesystem fault and reopen.";
        log.error(message);
        reportBootNotice(message, "kill_switch_wipe_incomplete");
        throw new WipeResumeInProgressError(message);
      }
      log.warn(
        "Resuming an interrupted emergency wipe: artifacts are deleted, but no launcher hook is installed to " +
          "clear the device key — booting a fresh database under the existing key (documented limitation, docs/02).",
      );
      return openInitialStore();
    }

    deps.markAwaitingWipeRestart();
    let signaled = true;
    try {
      hook();
    } catch (error) {
      signaled = false;
      log.error(error, "Kill switch resume: failed to signal the RN launcher for the wipe-restart handoff");
    }
    // Be honest about what actually happened: if the hook threw, the launcher was NOT signaled this run. The
    // durable `key-clear-ready` phase (when it wrote) still lets a later app restart's main.js re-drive the
    // key-clear on its own gate, so recovery converges either way — but the notice must not claim a signal we
    // didn't send (CodeRabbit MAJOR).
    const phaseNote = phaseReady
      ? "durable `key-clear-ready` phase written"
      : "the `key-clear-ready` phase could NOT be written durably (a later boot re-verifies deletion and retries)";
    const message = signaled
      ? "Resuming an interrupted emergency wipe: every persisted artifact is deleted and VERIFIED gone; a " +
        `device-key-clear-and-restart was REQUESTED from the launcher (${phaseNote}). The database was not opened.`
      : "Resuming an interrupted emergency wipe: every persisted artifact is deleted and VERIFIED gone, but " +
        `signaling the launcher for the key-clear FAILED (${phaseNote}) — restart the app to finish clearing the ` +
        "device key. The database was not opened.";
    log.warn(message);
    reportBootNotice(message, "kill_switch_wipe_resumed");
    throw new WipeResumeInProgressError(message);
  }

  /**
   * The RN launcher's wipe-restart hook (P1-2, docs/15), if installed. `nodejs-project-template/main.js`
   * sets this on `globalThis` before requiring the server bundle, same pattern as `__loamReportBootError`
   * and `__loamOnDeviceChat` — absent on every other host (desktop/Pi/CI), where it's simply undefined.
   * Exposed as a getter rather than an eager call so the caller can decide whether it's even worth
   * writing the durable handoff marker (P1-2b) BEFORE actually signaling.
   */
  function wipeRestartHook(): (() => void) | undefined {
    return (globalThis as { __loamRequestWipeRestart?: () => void }).__loamRequestWipeRestart;
  }

  /**
   * Persist `config` to `configPath` (P1-3/P1-4, Sol rounds 4/5): the fixed-key kill-switch branch below
   * deletes the whole DB — and with it, its `config` table — without ever recreating one in-process; the
   * fresh DB only exists once the NEXT boot resolves a rotated key. Without this, admin-set values (an
   * armed kill switch, the panic token, the security profile, retention, sync/mesh, feature flags…)
   * would silently revert to config.json/defaults on that next boot, DISARMING the kill switch along
   * with everything else. Writes atomically (temp file + rename) so a crash mid-write can never leave
   * `config.json` truncated/corrupt and brick the next boot — `loadAppConfig` fails CLOSED on an
   * unparseable file. Blanks `sync.token`, the one plaintext bearer secret in `LoamConfig`
   * (`admin.passphrase`/`killSwitch.panicToken` are already scrypt-hashed and safe to persist as-is) —
   * `config.json` is a plain, unprotected file, unlike the DB `config` table it would otherwise only
   * ever have lived in.
   *
   * Retries once on failure (a transient fs error shouldn't cost the operator their config) and returns
   * whether it EVENTUALLY succeeded. FULLY SYNCHRONOUS (P1-4, Sol round-9): the caller must persist config
   * BEFORE writing the `delete-pending` phase and before any destruction — config.json must be durable ahead
   * of the phase so that a boot-time resume (which DELETES the DB, and with it the DB `config` table) always
   * has the CURRENT effective config to fall back to on config.json. Being sync (not async) also keeps the
   * whole kill-switch critical section await-free, so there is no interleaving window between the in-memory
   * lockdown and the phase write.
   */
  function persistConfigForRestart(config: LoamConfig): boolean {
    const sanitized: LoamConfig = { ...config, sync: { ...config.sync, token: undefined } };
    const contents = JSON.stringify(sanitized, null, 2);
    // DURABLE write (P2-1, Sol round-8): staging write + file fsync + atomic rename + parent-dir fsync, via
    // `durableWriteFileSync`. A bare writeFile+rename is atomic but NOT power-loss-durable — it could return
    // "success" while a crash then discards the new bytes or the rename, silently reverting admin settings
    // (the armed kill switch, panic token, security profile…) to config.json/defaults after the wipe deletes
    // the DB `config` table. Retries once (a transient fs error shouldn't cost the config).
    if (durableWriteFileSync(configPath, contents)) {
      return true;
    }
    log.error(
      "Kill switch: failed to DURABLY persist config.json ahead of the encrypted wipe (attempt 1 of 2) — retrying once",
    );
    if (durableWriteFileSync(configPath, contents)) {
      return true;
    }
    log.error(
      "Kill switch: failed to DURABLY persist config.json ahead of the encrypted wipe after a retry — giving up " +
        "(the caller proceeds with the wipe regardless and reports a distinct notice)",
    );
    return false;
  }

  return {
    state,
    wipeRestartHook,
    persistConfigForRestart,
    dbPath,
    ephemeralDbKey,
    openLoamStore,
    dbArtifactPaths,
    deleteAndVerifyDbArtifacts,
    deleteAndVerifyAllWipeArtifactsDurable,
    durableWriteFileSync,
    sanitizeConfigForRestart,
    writeWipeJournal,
    clearWipePhase,
    resumeWipePhaseThenOpenStore,
  };
}
