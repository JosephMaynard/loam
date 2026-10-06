// The in-process host API (`LoamApp.host`): what a launcher on the host machine, the `loamnet` terminal UI,
// uses to show and run the node. Never reachable over the network: whoever runs the node's process already
// owns its data, so these calls take no session, like the Android host's Emergency Reset. Every change goes
// through the same function the matching admin route uses, so the two can't drift.
import {
  type HostApi,
  type HostLogLevel,
  type HostStatus,
  type HostUser,
  LoamConfigUpdateSchema,
  type User,
} from "@loam/schema";

import type { AppContext } from "./app-context.js";
import { localInterfaceAddresses, remoteClientAddresses } from "./net.js";
import { applyConfigUpdate } from "./routes-admin.js";
import { promoteUser } from "./routes-users.js";

/** What `createHostApi` needs from `buildApp` beyond the context. */
export type HostApiHooks = {
  setJoinHost(host: string | undefined): void;
  emergencyReset(): Promise<{ complete: boolean }>;
};

/** The People screen's view of a user. */
function hostUser(user: User, online: ReadonlySet<string>): HostUser {
  return {
    id: user.id,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    online: online.has(user.id),
    pending: user.pending === true,
    banned: user.banned === true,
    createdAt: user.createdAt,
  };
}

/** People only: no bots, no system users, no mesh senders. */
function isPerson(ctx: AppContext, user: User): boolean {
  return user.type === "human" && !ctx.isMeshSentinelUser(user.id);
}

export function createHostApi(ctx: AppContext, hooks: HostApiHooks): HostApi {
  function people(): User[] {
    return ctx.data.users.filter((user) => isPerson(ctx, user));
  }

  return {
    status(): HostStatus {
      const config = ctx.currentNetworkConfig();
      const online = new Set(ctx.onlineUserIds());
      const everyone = people();
      const quarantine = ctx.quarantine;
      return {
        nodeName: ctx.appConfig.node.name,
        version: ctx.options.version ?? "dev",
        joinHost: ctx.currentJoinHost(),
        port: ctx.clientPort,
        transportEncryption: ctx.effectiveTransportEncryption(),
        dbEncryption: config.dbEncryption ?? "off",
        securityProfile: ctx.appConfig.security.profile,
        joinPolicy: ctx.appConfig.access.joinPolicy,
        devMode: ctx.devMode,
        clients: remoteClientAddresses(
          [...ctx.sockets].map((session) => session.remoteAddress),
          localInterfaceAddresses(),
        ),
        people: {
          total: everyone.filter((user) => !user.pending && !user.banned).length,
          online: everyone.filter((user) => online.has(user.id)).length,
          pending: everyone.filter((user) => user.pending && !user.banned).length,
          admins: everyone.filter((user) => user.isAdmin).length,
        },
        quarantined: quarantine.users.size + quarantine.channels.size + quarantine.messages.size,
        logLevel: ctx.server.log.level === "debug" ? "debug" : "info",
      };
    },
    config() {
      return ctx.redactedConfig();
    },
    updateConfig(update) {
      // The caller is trusted, but a terminal form can still build a bad value: parse it as the route does.
      const parsed = LoamConfigUpdateSchema.safeParse(update);
      if (!parsed.success) {
        return { ok: false, error: "Invalid config update request" };
      }
      const result = applyConfigUpdate(ctx, parsed.data);
      return result.ok ? { ok: true, value: ctx.redactedConfig() } : { ok: false, error: result.error };
    },
    users() {
      const online = new Set(ctx.onlineUserIds());
      return people()
        .map((user) => hostUser(user, online))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    makeAdmin(userId) {
      const result = promoteUser(ctx, userId, { approve: true });
      return result.ok
        ? { ok: true, value: hostUser(result.user, new Set(ctx.onlineUserIds())) }
        : { ok: false, error: result.error };
    },
    adminClaimCode() {
      return ctx.adminClaimCodes.mint();
    },
    linkCode() {
      return ctx.linkCodes.mint();
    },
    invite() {
      return ctx.appConfig.access.joinPolicy === "approval" ? ctx.invites.current() : null;
    },
    setJoinHost(host) {
      hooks.setJoinHost(host?.trim() || undefined);
    },
    setLogLevel(level: HostLogLevel) {
      ctx.server.log.level = level;
    },
    transportPublicKey() {
      return ctx.effectiveTransportEncryption() === "off" ? undefined : ctx.ensureTransportIdentity().publicKey;
    },
    emergencyReset() {
      return hooks.emergencyReset();
    },
  };
}
