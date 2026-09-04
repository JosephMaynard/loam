// Admin: claim, config read/patch, kill switch, and the unauthenticated panic token. Extracted verbatim
// from app.ts (2026-09-04 split) over the shared AppContext.
import { AdminClaimRequestSchema, KillSwitchRequestSchema, type LoamConfig, LoamConfigUpdateSchema, PanicRequestSchema } from "@loam/schema";
import type { AppContext } from "./app-context.js";
import { mergeConfig } from "./config.js";
import { errorBody } from "./errors.js";
import { makeAdminSetupCode } from "./identity.js";
import { timingSafeEqualStrings, verifySecret } from "./secrets.js";

export function registerAdminRoutes(ctx: AppContext): void {
  ctx.server.post(
    "/api/admin/claim",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
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

    if (strategy !== "setupCode" && strategy !== "passphrase" && strategy !== "hostDevice") {
      return reply.code(403).send(errorBody("Admin claiming is not enabled on this LOAM node"));
    }

    // Key on the caller's IP: a session-id key could be reset by simply omitting the cookie.
    if (ctx.attemptRateLimited(ctx.claimAttempts, request.ip)) {
      return reply.code(429).send(errorBody("Too many claim attempts; try again later"));
    }

    // `hostDevice` (review 2026-09-04): the secret is the launcher's per-boot host token, which only the
    // host's own WebView receives — never a config value, never advertised, never persisted.
    const expected =
      strategy === "setupCode" ? ctx.adminSetupCode : strategy === "hostDevice" ? ctx.options.hostToken : ctx.appConfig.admin.passphrase;
    const secretMatches =
      !!expected &&
      (strategy === "setupCode" || strategy === "hostDevice"
        ? timingSafeEqualStrings(body.data.secret, expected)
        : verifySecret(body.data.secret, expected));

    if (!secretMatches) {
      return reply.code(403).send(errorBody("Invalid admin secret"));
    }

    if (strategy === "setupCode") {
      ctx.adminSetupCode = undefined;
    }

    currentUser.isAdmin = true;
    ctx.store.upsertUser(currentUser);
    ctx.broadcast({ type: "userUpserted", user: currentUser });
    return currentUser;
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
    // Switching INTO setupCode bootstrap at runtime must mint a code — otherwise the claim flow is
    // enabled but no code was ever generated, so `allowAdminClaim` stays false and no one can claim
    // (docs/15 #8). Only on the transition (not every PATCH while already in setupCode), so a code
    // consumed by an earlier claim isn't silently re-minted. `/api/admin/claim` grants admin against
    // a valid code regardless of existing admins, so this is the intended "let someone claim" lever.
    if (switchedToSetupCode && ctx.adminSetupCode === undefined) {
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
