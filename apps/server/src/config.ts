// LoamConfig defaults, layered merge, and legacy-profile reconciliation. Extracted from app.ts
// (2026-09-04 split).
import { LoamConfigSchema, securityProfilePreset, type LoamConfig, type LoamConfigUpdate } from "@loam/schema";

import { hashSecret, isHashedSecret } from "./secrets.js";

/**
 * Create the default LOAM configuration: conservative identity permissions, all core messaging
 * features on, Ollama disabled, `firstUser` admin bootstrap, and the `standard` security profile.
 */
export function defaultLoamConfig(): LoamConfig {
  return {
    node: {
      name: "LOAM local",
      locale: "en",
    },
    identity: {
      allowUserDisplayNameEdit: false,
      allowUserAvatarEdit: false,
      allowUserAvatarUpload: false,
      allowAdminUserEdit: true,
    },
    features: {
      enablePublicChannels: true,
      enablePrivateChannels: true,
      enableUserChannels: true,
      enableReplies: true,
      enableDMs: true,
      enableReactions: true,
      enableMarkdown: true,
      enableAttachments: true,
      enableLocationSharing: false,
      enablePresence: true,
    },
    llm: {
      ollama: {
        enabled: false,
        baseUrl: "http://localhost:11434",
        model: "gemma4",
        botId: "llm.ollama.gemma4",
        botDisplayName: "Gemma",
      },
      // On-device backend, off by default. Enabling it is a no-op unless the host provides the
      // inference hook (the Android host) AND a model has been added — otherwise a graceful error.
      onDevice: {
        enabled: false,
      },
    },
    admin: {
      bootstrap: "firstUser",
    },
    killSwitch: {
      enabled: false,
      requireConfirmation: true,
    },
    retention: {},
    security: {
      // Default to `custom` (individual axes, no forcing) so a fresh node behaves exactly as its raw
      // defaults and an operator can set join/retention/kill-switch directly without a named profile
      // silently overriding them. Selecting open/standard/hardened opts into the coherent bundle.
      profile: "custom",
      // Secure by default (docs/08): a fresh node encrypts app-layer traffic. `optional` is seamless —
      // clients that joined via the QR (the normal path) get its `#k=` key and encrypt automatically, while
      // plaintext clients (a manually-typed URL, curl, dev) still work — so this closes the "plaintext on
      // the LAN by default" gap with zero UX cost. `off` is no longer an operator-settable posture; the only
      // way to run plaintext is Developer Mode (LOAM_DEV_MODE, dev-only, self-announcing banner).
      transportEncryption: "optional",
      // Off by default so existing unencrypted deployments are unchanged; the actual DB keying is
      // driven by LOAM_DB_KEY / openStore, wired separately (Android host key handoff). This is the
      // declared/displayed posture, and it is not forced by a security profile (see SecurityConfigSchema).
      dbEncryption: "off",
    },
    access: {
      joinPolicy: "open",
    },
    sync: {
      enabled: false,
      peers: [],
      intervalMs: 30_000,
    },
    // Opportunistic sealed-mailbox mesh, off by default (docs/16). Inert until an operator enables it.
    mesh: {
      enabled: false,
      relay: false,
      ttlMs: 72 * 3_600_000,
      hopLimit: 6,
      maxCarried: 5_000,
      maxContacts: 1_000,
    },
  };
}

/**
 * Checks whether a value is a non-null object that is not an array.
 *
 * @param value - The value to test
 * @returns `true` if `value` is a non-null object and not an array, `false` otherwise.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge a partial config update onto a base config, normalising clearable string fields
 * (empty `systemPrompt`/`passphrase` become unset) and validating the result.
 *
 * @param base - The current full configuration
 * @param update - A validated partial update
 * @returns The merged, schema-validated configuration
 */
export function mergeConfig(base: LoamConfig, update: LoamConfigUpdate): LoamConfig {
  const merged = {
    node: { ...base.node, ...update.node },
    identity: { ...base.identity, ...update.identity },
    features: { ...base.features, ...update.features },
    llm: {
      ollama: { ...base.llm.ollama, ...update.llm?.ollama },
      onDevice: { ...base.llm.onDevice, ...update.llm?.onDevice },
    },
    admin: { ...base.admin, ...update.admin },
    killSwitch: { ...base.killSwitch, ...update.killSwitch },
    retention: { ...base.retention, ...update.retention },
    security: { ...base.security, ...update.security },
    access: { ...base.access, ...update.access },
    sync: { ...base.sync, ...update.sync },
    mesh: { ...base.mesh, ...update.mesh },
  };
  const systemPrompt = merged.llm.ollama.systemPrompt?.trim();
  merged.llm.ollama.systemPrompt = systemPrompt || undefined;

  // Secrets are stored scrypt-hashed, never in the clear; plaintext arriving from a config file or
  // an admin update is hashed here (already-hashed values pass through unchanged).
  const passphrase = merged.admin.passphrase?.trim();
  merged.admin.passphrase = passphrase ? (isHashedSecret(passphrase) ? passphrase : hashSecret(passphrase)) : undefined;
  const panicToken = merged.killSwitch.panicToken?.trim();
  merged.killSwitch.panicToken = panicToken
    ? isHashedSecret(panicToken)
      ? panicToken
      : hashSecret(panicToken)
    : undefined;

  merged.retention.messageTtlMs = merged.retention.messageTtlMs ?? undefined;

  // The sync token is a bearer secret the node must transmit to peers, so it's stored in the clear
  // (not hashed like the passphrase/panic token). An empty string clears it back to open sync.
  const syncToken = merged.sync.token?.trim();
  merged.sync.token = syncToken || undefined;

  // A named security profile (anything but `custom`) is authoritative for the axes it bundles: force
  // them onto the effective config so the profile actually drives behaviour and can't be silently
  // contradicted by a stale or hand-edited individual axis. `custom` leaves the raw axes untouched.
  const preset = securityProfilePreset(merged.security.profile);
  if (preset) {
    merged.access.joinPolicy = preset.joinPolicy;
    merged.retention.messageTtlMs = preset.messageTtlMs ?? undefined;
    merged.killSwitch.enabled = preset.killSwitchEnabled;
    merged.security.transportEncryption = preset.transportEncryption;
  }

  return LoamConfigSchema.parse(merged);
}

/**
 * One-time migration for configs written before the security profile became authoritative. Back then
 * the profile was inert, so an operator could arm the kill switch, set a message TTL, or require
 * approval while the profile sat at its `standard` default. Now a named profile *forces* those axes,
 * which could silently undo such settings — including disarming a kill switch. If a persisted update
 * pins a non-`custom` profile yet also carries a bundled axis that diverges from what the profile
 * would force, we preserve the operator's explicit intent by switching the profile to `custom`.
 *
 * @returns the (possibly rewritten) update and whether it was changed, so the caller can re-persist.
 */
export function reconcileLegacyProfile(update: LoamConfigUpdate): { update: LoamConfigUpdate; changed: boolean } {
  const preset = update.security?.profile ? securityProfilePreset(update.security.profile) : null;
  if (!preset) {
    return { update, changed: false };
  }
  const killSwitchDiverges =
    update.killSwitch?.enabled !== undefined && update.killSwitch.enabled !== preset.killSwitchEnabled;
  const joinDiverges =
    update.access?.joinPolicy !== undefined && update.access.joinPolicy !== preset.joinPolicy;
  const ttl = update.retention?.messageTtlMs;
  const ttlDiverges = ttl !== undefined && (ttl ?? null) !== preset.messageTtlMs;
  const transportDiverges =
    update.security?.transportEncryption !== undefined &&
    update.security.transportEncryption !== preset.transportEncryption;

  if (killSwitchDiverges || joinDiverges || ttlDiverges || transportDiverges) {
    return { update: { ...update, security: { ...update.security, profile: "custom" } }, changed: true };
  }
  return { update, changed: false };
}
