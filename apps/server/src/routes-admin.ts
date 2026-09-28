// Admin: claim, config read/patch, kill switch, and the unauthenticated panic token. Extracted verbatim
// from app.ts (2026-09-04 split) over the shared AppContext.
import { AdminClaimRequestSchema, KillSwitchRequestSchema, type LoamConfig, LoamConfigUpdateSchema, PanicRequestSchema, UserSchema } from "@loam/schema";
import { readFileSync } from "node:fs";

import type { AppContext } from "./app-context.js";
import { mergeConfig } from "./config.js";
import { errorBody } from "./errors.js";
import { makeAdminSetupCode } from "./identity.js";
import { timingSafeEqualStrings, verifySecret } from "./secrets.js";

/**
 * Keep config.json authoritative for the launcher-owned `llm.onDevice` block. When config.json carries it,
 * the load ignores the DB row's copy (see `withoutLauncherOwnedKeys`), so an admin edit of `llm.onDevice`
 * saved only to the DB would be silently undone at the next boot. Such an edit is written through to
 * config.json instead (the launcher's own read-modify-write format: every other key is preserved), durably.
 *
 * @returns `"skipped"` when the edit doesn't change `llm.onDevice` or config.json doesn't carry it (the DB
 *   row then holds it as for any other key), `"written"` on a durable write, `"failed"` otherwise.
 */
function writeThroughLauncherOwnedOnDevice(ctx: AppContext, previous: LoamConfig, next: LoamConfig): "skipped" | "written" | "failed" {
  if (JSON.stringify(previous.llm.onDevice) === JSON.stringify(next.llm.onDevice)) {
    return "skipped";
  }

  let file: unknown;
  try {
    file = JSON.parse(readFileSync(ctx.configPath, "utf8"));
  } catch (error) {
    // Absent file → nothing owns the key. An unreadable one failed (or will fail) the boot, so it can't be
    // the source of the running config's `llm.onDevice` either.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "skipped";
    }
    ctx.server.log.error(error, "Could not read config.json to save llm.onDevice");
    return "failed";
  }

  const llm = file && typeof file === "object" ? (file as { llm?: unknown }).llm : undefined;
  if (!llm || typeof llm !== "object" || (llm as { onDevice?: unknown }).onDevice === undefined) {
    return "skipped";
  }

  (llm as { onDevice: unknown }).onDevice = next.llm.onDevice;
  return ctx.lifecycle.durableWriteFileSync(ctx.configPath, JSON.stringify(file, null, 2)) ? "written" : "failed";
}

/** Register the admin routes: claim, config get/patch, kill switch, panic token. */
export function registerAdminRoutes(ctx: AppContext): void {
  ctx.server.post(
    "/api/admin/claim",
    // `allowList: () => false` so internal tunnel re-dispatches count too: route configs otherwise inherit
    // the global limiter's tunnel exemption, which would lift this cap for any client using the tunnel
    // (the same reason `semanticRateLimit` exists — see transport-server.ts).
    { config: { rateLimit: { max: 10, timeWindow: "1 minute", allowList: () => false } } },
    async (request, reply) => {
    const body = AdminClaimRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid admin claim request"));
    }

    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (currentUser.isAdmin) {
      return currentUser;
    }

    const strategy = ctx.effectiveAdminBootstrap();
    const hostToken = ctx.options.hostToken;

    // `hostDevice` is claimable only when a launcher actually minted a token this boot — a desktop node
    // merely CONFIGURED with the strategy has nothing to claim against, so it answers like `none` and never
    // touches the attempt limiter (round-2 review).
    if (
      (strategy !== "setupCode" && strategy !== "passphrase" && strategy !== "hostDevice") ||
      (strategy === "hostDevice" && !hostToken)
    ) {
      return reply.code(403).send(errorBody("Admin claiming is not enabled on this LOAM node"));
    }

    // Persist first, then mirror onto the live record and broadcast (the house mutator order), and clear
    // `pending`: under `access.joinPolicy: "approval"` the claimer's session was created pending, and an
    // admin still marked pending is locked out of every participation-gated route — including the
    // approval queue — so a fresh approval-policy node would have no one able to let anyone in.
    const promote = () => {
      const next = UserSchema.parse({ ...currentUser, isAdmin: true, pending: false });
      ctx.store.upsertUser(next);
      Object.assign(currentUser, next);
      ctx.broadcast({ type: "userUpserted", user: currentUser });
      return currentUser;
    };

    // `hostDevice` (review 2026-09-04): the secret is the launcher's per-boot host token, which only the
    // host's own WebView receives — never a config value, never advertised, never persisted. A CORRECT
    // token is honoured BEFORE the per-IP attempt limiter (round-2 review): the host's own claim arrives from
    // loopback, a bucket every co-located Android app can also hit, and a 256-bit random token cannot be
    // brute-forced, so exempting a match costs nothing — while a wrong guess still counts against the bucket.
    if (strategy === "hostDevice" && hostToken && timingSafeEqualStrings(body.data.secret, hostToken)) {
      return promote();
    }

    // Key on the caller's IP: a session-id key could be reset by simply omitting the cookie.
    if (ctx.attemptRateLimited(ctx.claimAttempts, request.ip)) {
      return reply.code(429).send(errorBody("Too many claim attempts; try again later"));
    }

    const expected = strategy === "setupCode" ? ctx.adminSetupCode : strategy === "passphrase" ? ctx.appConfig.admin.passphrase : undefined;
    const secretMatches =
      !!expected &&
      (strategy === "setupCode" ? timingSafeEqualStrings(body.data.secret, expected) : verifySecret(body.data.secret, expected));

    if (!secretMatches) {
      return reply.code(403).send(errorBody("Invalid admin secret"));
    }

    if (strategy === "setupCode") {
      ctx.adminSetupCode = undefined;
    }

    return promote();
  });

  ctx.server.get("/api/admin/config", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    return ctx.redactedConfig();
  });

  ctx.server.post("/api/admin/kill-switch", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    if (!ctx.appConfig.killSwitch.enabled) {
      return reply.code(403).send(errorBody("The kill switch is not enabled on this LOAM node"));
    }

    const body = KillSwitchRequestSchema.safeParse(request.body ?? {});

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid kill-switch request"));
    }

    if (ctx.appConfig.killSwitch.requireConfirmation && body.data.confirm !== "wipe") {
      return reply.code(400).send(errorBody('Confirmation required: send { "confirm": "wipe" }'));
    }

    // P1-1 (Sol round 8): reflect the wipe RESULT — never report success on an INCOMPLETE wipe (deletion
    // incomplete/unverifiable → the node is 503-locked and the wipe is retried on the next boot).
    const result = await ctx.executeKillSwitch();
    if (!result.complete) {
      return reply
        .code(503)
        .send(errorBody("The emergency wipe could not be completed; the node is locked down — reopen it to retry."));
    }
    return { ok: true };
  });

  // Unauthenticated panic trigger: fires the kill switch with a pre-shared token so a wipe can be
  // set off fast (bookmark/NFC/second device) without navigating the admin UI. 404s unless a token
  // is configured, so the route stays indistinguishable from absent on ordinary nodes.
  ctx.server.post(
    "/api/panic",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          // Count internal tunnel re-dispatches too (see the claim route above).
          allowList: () => false,
          // Answer 404 (not the default 429) when the route limit trips, so a rate-limited prober
          // sees the same "not found" as every other failure path here — no 429 to reveal the route.
          errorResponseBuilder: () => {
            const error = new Error("Not found") as Error & { statusCode: number };
            error.statusCode = 404;
            return error;
          },
        },
      },
    },
    async (request, reply) => {
    // Every non-success answers 404 — identical to an unconfigured node — so a prober can't tell a
    // panic-armed node from a plain one (only someone holding the token learns otherwise, and that
    // fires the wipe). The rate limiter still blocks brute force; it just doesn't reveal itself.
    if (!ctx.appConfig.killSwitch.enabled || !ctx.appConfig.killSwitch.panicToken) {
      return reply.code(404).send(errorBody("Not found"));
    }

    const body = PanicRequestSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(404).send(errorBody("Not found"));
    }

    if (ctx.attemptRateLimited(ctx.panicAttempts, request.ip)) {
      return reply.code(404).send(errorBody("Not found"));
    }

    if (!verifySecret(body.data.token, ctx.appConfig.killSwitch.panicToken)) {
      return reply.code(404).send(errorBody("Not found"));
    }

    // P1-1 (Sol round 8): the token holder proved it, so an incomplete wipe is reported honestly (503),
    // not as a false `{ ok: true }`. Only genuine probing (bad/absent token, above) stays a uniform 404.
    const result = await ctx.executeKillSwitch();
    if (!result.complete) {
      return reply
        .code(503)
        .send(errorBody("The emergency wipe could not be completed; the node is locked down — reopen it to retry."));
    }
    return { ok: true };
  });

  ctx.server.patch("/api/admin/config", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    if (!currentUser.isAdmin) {
      return reply.code(403).send(errorBody("Admin access required"));
    }

    const body = LoamConfigUpdateSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send(errorBody("Invalid config update request"));
    }

    let next: LoamConfig;

    try {
      next = mergeConfig(ctx.appConfig, body.data);
    } catch {
      return reply.code(400).send(errorBody("Invalid config values"));
    }

    // Passphrase bootstrap without a passphrase would advertise a claim flow that can never
    // succeed (and clearing the passphrase while the mode is active would lock admins out).
    if (next.admin.bootstrap === "passphrase" && !next.admin.passphrase) {
      return reply.code(400).send(errorBody("The passphrase bootstrap strategy requires a passphrase"));
    }

    // Validate the assistant bot BEFORE persisting: a botId naming an existing person would otherwise turn
    // them into a bot (demoting an admin past the no-demote rule), and a bot record that fails validation
    // would 500 here and then fail the next boot.
    if (ctx.llm.botConfigError(next)) {
      return reply.code(400).send(errorBody("Invalid config values"));
    }

    // Before anything is applied: a launcher-owned `llm.onDevice` edit that can't reach config.json would be
    // reverted at the next boot, so refuse the whole save rather than half-apply it.
    if (writeThroughLauncherOwnedOnDevice(ctx, ctx.appConfig, next) === "failed") {
      return reply.code(500).send(errorBody("Internal server error"));
    }

    const switchedToSetupCode = next.admin.bootstrap === "setupCode" && ctx.appConfig.admin.bootstrap !== "setupCode";
    const switchedAwayFromSetupCode =
      ctx.appConfig.admin.bootstrap === "setupCode" && next.admin.bootstrap !== "setupCode";
    ctx.appConfig = next;
    // `appConfig` is always the operator's real intent (Developer Mode never mutates it — the plaintext
    // override is a read-time projection via `effectiveTransportEncryption()`), so the persisted config can
    // never carry a dev-forced `"off"` into a later non-dev run of this data dir.
    ctx.store.setConfigValue("config", JSON.stringify(ctx.appConfig));
    // Drop live sync-status for peers an admin just removed, so sync.peerSyncStatus can't accrete entries
    // for peers that no longer exist (docs/15 #9).
    const activePeerUrls = new Set(ctx.appConfig.sync.peers.map((peer) => peer.url));
    for (const url of [...ctx.sync.peerSyncStatus.keys()]) {
      if (!activePeerUrls.has(url)) {
        ctx.sync.peerSyncStatus.delete(url);
      }
    }
    // Same cleanup for queued missing-attachment retries (F2, docs/15 A6): a removed peer's work items
    // would otherwise sit in the table until `sync.retryMissingAttachments`' own defensive check happened to
    // run — drop them immediately so a peer the operator just removed is never contacted again.
    for (const record of ctx.store.loadMissingAttachments()) {
      if (!activePeerUrls.has(record.peerUrl)) {
        ctx.store.clearMissingAttachment(record.messageId, record.attachmentId);
      }
    }
    // Drop every cached puller-side transport session (docs/08): a peer's URL, pinned transportKey, or
    // the sync token may have just changed, so an entry established under the old config could be stale
    // or pinned to a now-wrong key. They re-handshake lazily on the next sync tick.
    ctx.sync.peerTransportSessions.clear();
    // Offers refused under the old config (replies or public channels off, a smaller body cap, relaying off…)
    // may be acceptable now: fetch them again at the next round rather than after the refusal expires.
    ctx.sync.forgetRefusedOffers();
    // Switching INTO setupCode bootstrap at runtime must mint a code — otherwise the claim flow is
    // enabled but no code was ever generated, so `allowAdminClaim` stays false and no one can claim
    // (docs/15 #8). Only on the transition (not every PATCH while already in setupCode), so a code
    // consumed by an earlier claim isn't silently re-minted. `/api/admin/claim` grants admin against
    // a valid code regardless of existing admins, so this is the intended "let someone claim" lever.
    if (ctx.effectiveAdminBootstrap() === "hostDevice" && next.admin.bootstrap !== "hostDevice") {
      // This host device pins the effective strategy to `hostDevice` (its launcher's per-boot token — see
      // `effectiveAdminBootstrap`). The PATCH is persisted as the operator's intent (it applies the moment
      // this data dir runs without a host token), but minting/advertising a setup code or passphrase claim
      // here would announce a claim path that can never succeed on this device (round-2 review).
      ctx.server.log.warn(
        `admin.bootstrap "${next.admin.bootstrap}" saved, but this host device enforces "hostDevice" — the setting takes effect only where no host token is minted`,
      );
    } else if (switchedToSetupCode && ctx.adminSetupCode === undefined) {
      ctx.adminSetupCode = makeAdminSetupCode();
      ctx.server.log.info(`Admin setup code (single use): ${ctx.adminSetupCode}`);
    } else if (switchedAwayFromSetupCode) {
      // Leaving setupCode invalidates the outstanding code immediately, so a later switch back mints a
      // fresh one (and a code minted for a now-abandoned mode can't be claimed later).
      ctx.adminSetupCode = undefined;
    }
    ctx.llm.ensureBotUser();
    // Enabling mesh mints + publishes identity keys for existing local users so they're reachable.
    ctx.mesh.ensureAllMeshIdentities();
    ctx.broadcast({ type: "configUpdated", networkConfig: ctx.currentNetworkConfig() });
    // If presence was just enabled, connected clients need the current roster to light up.
    ctx.broadcastPresence();
    return ctx.redactedConfig();
  });
}
