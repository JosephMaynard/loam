import {
  AdminBootstrapStrategySchema,
  JoinPolicySchema,
  LoamConfigSchema,
  LocaleSchema,
  securityProfilePreset,
  SecurityProfileSchema,
  type Channel,
  type FeatureFlags,
  type IdentityConfig,
  type JoinPolicy,
  type LoamConfig,
  type SecurityProfile,
  type User,
} from "@loam/schema";
import { useEffect, useState } from "preact/hooks";

import { LOCALE_LABELS, errorText, t } from "../i18n";
import { fetchJson, REQUEST_TIMEOUT_MS } from "../lib/api";
import { encryptedFetch } from "../lib/transport";
import { AddSyncPeerControl } from "./AddSyncPeerControl";
import { AdminChannelsPanel } from "./AdminChannelsPanel";
import { GettingStartedPanel } from "./GettingStartedPanel";
import { LlmPanel } from "./LlmPanel";
import { MeshPanel } from "./MeshPanel";
import { NavLink } from "./NavLink";
import { NodeLinkControl } from "./NodeLinkControl";
import { SyncStatusPanel } from "./SyncStatusPanel";

/** Feature-flag toggle labels, resolved against the active locale at render time. */
function featureFlagLabels(): [keyof FeatureFlags, string][] {
  return [
    ["enablePublicChannels", t("admin.flagPublicChannels")],
    ["enablePrivateChannels", t("admin.flagPrivateChannels")],
    ["enableUserChannels", t("admin.flagUserChannels")],
    ["enableReplies", t("admin.flagReplies")],
    ["enableDMs", t("admin.flagDMs")],
    ["enableReactions", t("admin.flagReactions")],
    ["enableMarkdown", t("admin.flagMarkdown")],
    ["enableAttachments", t("admin.flagAttachments")],
    ["enablePresence", t("admin.flagPresence")],
    ["enableLocationSharing", t("admin.flagLocationSharing")],
  ];
}

/** Identity-permission toggle labels, resolved against the active locale at render time. */
function identityLabels(): [keyof IdentityConfig, string][] {
  return [
    ["allowUserDisplayNameEdit", t("admin.identityDisplayName")],
    ["allowUserAvatarEdit", t("admin.identityAvatarEdit")],
    ["allowUserAvatarUpload", t("admin.identityAvatarUpload")],
    ["allowAdminUserEdit", t("admin.identityAdminEdit")],
  ];
}

/**
 * Human-facing summary of what each security profile enforces, resolved against the active locale at
 * render time. A named profile bundles the access, retention, and kill-switch axes (docs/09);
 * `custom` unlocks them for individual editing. Only the axes LOAM enforces today are described —
 * transport encryption / E2EE are future, which is why `open` and `standard` currently apply the
 * same settings.
 */
function securityProfileLabels(): Record<SecurityProfile, { title: string; summary: string }> {
  return {
    open: { title: t("admin.profileOpenTitle"), summary: t("admin.profileOpenSummary") },
    standard: { title: t("admin.profileStandardTitle"), summary: t("admin.profileStandardSummary") },
    hardened: { title: t("admin.profileHardenedTitle"), summary: t("admin.profileHardenedSummary") },
    custom: { title: t("admin.profileCustomTitle"), summary: t("admin.profileCustomSummary") },
  };
}

/**
 * Admin-only configuration area: edits node feature flags, identity permissions, LLM settings, and
 * the admin bootstrap strategy via the /api/admin/config endpoints. Client gating is cosmetic —
 * the server enforces admin on every request.
 */
export function AdminView({
  currentUser,
  joinUrl,
  onChannelUpsert,
  onWiped,
}: {
  currentUser: User;
  joinUrl?: string;
  onChannelUpsert: (channels: Channel[]) => void;
  onWiped: () => Promise<void>;
}) {
  const [adminConfig, setAdminConfig] = useState<LoamConfig>();
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [passphrase, setPassphrase] = useState("");
  const [panicToken, setPanicToken] = useState("");
  const [wipeConfirmText, setWipeConfirmText] = useState("");
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string>();

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }

    let active = true;

    fetchJson<unknown>("/api/admin/config")
      .then((payload) => {
        if (!active) {
          return;
        }

        const parsed = LoamConfigSchema.safeParse(payload);

        if (parsed.success) {
          setAdminConfig(parsed.data);
        } else {
          setLoadError(t("admin.configInvalid"));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(error instanceof Error ? error.message : t("admin.configLoadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [currentUser.isAdmin]);

  async function save(): Promise<void> {
    if (!adminConfig) {
      return;
    }

    setSaving(true);
    setSaved(false);
    setSaveError(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const update = {
        node: adminConfig.node,
        identity: adminConfig.identity,
        features: adminConfig.features,
        llm: { ollama: adminConfig.llm.ollama, onDevice: adminConfig.llm.onDevice },
        admin: {
          bootstrap: adminConfig.admin.bootstrap,
          ...(passphrase.trim() ? { passphrase: passphrase.trim() } : {}),
        },
        killSwitch: {
          enabled: adminConfig.killSwitch.enabled,
          requireConfirmation: adminConfig.killSwitch.requireConfirmation,
          ...(panicToken.trim() ? { panicToken: panicToken.trim() } : {}),
        },
        retention: { messageTtlMs: adminConfig.retention.messageTtlMs ?? null },
        security: adminConfig.security,
        access: adminConfig.access,
        sync: adminConfig.sync,
        mesh: adminConfig.mesh,
      };
      const response = await encryptedFetch("PATCH", "/api/admin/config", update, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        const message = errorText(payload, t("admin.configUpdateFailed", { status: response.status }));
        throw new Error(message);
      }

      const parsed = LoamConfigSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error(t("admin.configUnrecognised"));
      }

      setAdminConfig(parsed.data);
      setPassphrase("");
      setPanicToken("");
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("admin.configSaveError"));
    } finally {
      window.clearTimeout(timeout);
      setSaving(false);
    }
  }

  function setFeature(key: keyof FeatureFlags, value: boolean): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, features: { ...previous.features, [key]: value } } : previous,
    );
  }

  function setIdentity(key: keyof IdentityConfig, value: boolean): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, identity: { ...previous.identity, [key]: value } } : previous,
    );
  }

  function setOllama(update: Partial<LoamConfig["llm"]["ollama"]>): void {
    setAdminConfig((previous) =>
      previous
        ? { ...previous, llm: { ...previous.llm, ollama: { ...previous.llm.ollama, ...update } } }
        : previous,
    );
  }

  function setOnDevice(update: Partial<LoamConfig["llm"]["onDevice"]>): void {
    setAdminConfig((previous) =>
      previous
        ? { ...previous, llm: { ...previous.llm, onDevice: { ...previous.llm.onDevice, ...update } } }
        : previous,
    );
  }

  function setKillSwitch(update: Partial<LoamConfig["killSwitch"]>): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, killSwitch: { ...previous.killSwitch, ...update } } : previous,
    );
  }

  function setMesh(update: Partial<LoamConfig["mesh"]>): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, mesh: { ...previous.mesh, ...update } } : previous,
    );
  }

  /**
   * Switch the security profile. A named profile (open/standard/hardened) is a coherent bundle, so
   * we mirror the server by applying its access/retention/kill-switch axes locally — the form then
   * shows exactly what will be enforced. `custom` unlocks those axes for individual editing.
   */
  function setSecurityProfile(profile: SecurityProfile): void {
    setAdminConfig((previous) => {
      if (!previous) {
        return previous;
      }
      const preset = securityProfilePreset(profile);
      if (!preset) {
        return { ...previous, security: { ...previous.security, profile } };
      }
      return {
        ...previous,
        security: { ...previous.security, profile },
        access: { ...previous.access, joinPolicy: preset.joinPolicy },
        retention: { messageTtlMs: preset.messageTtlMs ?? undefined },
        killSwitch: { ...previous.killSwitch, enabled: preset.killSwitchEnabled },
      };
    });
  }

  function setJoinPolicy(joinPolicy: JoinPolicy): void {
    setAdminConfig((previous) =>
      previous ? { ...previous, access: { ...previous.access, joinPolicy } } : previous,
    );
  }

  async function fireKillSwitch(): Promise<void> {
    setFiring(true);
    setFireError(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // The server independently requires { confirm: "wipe" } when requireConfirmation is on, so
      // pass through what the admin actually typed rather than asserting it.
      const body = adminConfig?.killSwitch.requireConfirmation
        ? { confirm: wipeConfirmText.trim() }
        : {};
      const response = await encryptedFetch("POST", "/api/admin/kill-switch", body, {
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        const message = errorText(payload, t("admin.killSwitchFailed", { status: response.status }));
        throw new Error(message);
      }

      // The server also broadcasts a wipe event, but purge directly on HTTP success too so the
      // admin's own browser is cleaned even if its socket is closed (purging twice is harmless).
      await onWiped();
    } catch (error) {
      setFireError(error instanceof Error ? error.message : t("admin.killSwitchError"));
      setFiring(false);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  if (!currentUser.isAdmin) {
    return (
      <section className="settings-view">
        <header className="conversation-header">
          <NavLink active={false} className="mobile-back" href="/channels">
            ←
          </NavLink>
          <div>
            <p className="eyebrow">{t("admin.eyebrow")}</p>
            <h1>{t("people.notAuthorizedTitle")}</h1>
          </div>
        </header>
        <p className="form-note">{t("admin.notAuthorizedNote")}</p>
      </section>
    );
  }

  return (
    <section className="settings-view">
      <header className="conversation-header">
        <NavLink active={false} className="mobile-back" href="/channels">
          ←
        </NavLink>
        <div>
          <p className="eyebrow">{t("admin.eyebrow")}</p>
          <h1>{t("admin.title")}</h1>
        </div>
      </header>
      {loadError ? <p className="form-error">{loadError}</p> : null}
      {!adminConfig && !loadError ? <p className="form-note">{t("admin.loading")}</p> : null}
      {adminConfig ? (
        <form
          className="settings-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <GettingStartedPanel />
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.networkEyebrow")}</p>
              <h2>{t("admin.identityHeading")}</h2>
            </div>
            <label>
              {t("admin.networkName")}
              <input
                disabled={saving}
                maxLength={80}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous ? { ...previous, node: { ...previous.node, name: event.currentTarget.value } } : previous,
                  )
                }
                value={adminConfig.node.name}
              />
            </label>
            <p className="form-note">{t("admin.networkNameNote")}</p>
            <label>
              {t("admin.language")}
              <select
                disabled={saving}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous
                      ? { ...previous, node: { ...previous.node, locale: LocaleSchema.parse(event.currentTarget.value) } }
                      : previous,
                  )
                }
                value={adminConfig.node.locale}
              >
                {LocaleSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {LOCALE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-note">{t("admin.languageNote")}</p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("settings.securityEyebrow")}</p>
              <h2>{t("admin.profileHeading")}</h2>
            </div>
            <label>
              {t("admin.posture")}
              <select
                disabled={saving}
                onInput={(event) =>
                  setSecurityProfile(SecurityProfileSchema.parse(event.currentTarget.value))
                }
                value={adminConfig.security.profile}
              >
                {SecurityProfileSchema.options.map((profile) => (
                  <option key={profile} value={profile}>
                    {securityProfileLabels()[profile].title}
                  </option>
                ))}
              </select>
            </label>
            <p className="form-note">{securityProfileLabels()[adminConfig.security.profile].summary}</p>
            <label>
              {t("admin.whoCanJoin")}
              <select
                disabled={saving || adminConfig.security.profile !== "custom"}
                onInput={(event) => setJoinPolicy(JoinPolicySchema.parse(event.currentTarget.value))}
                value={adminConfig.access.joinPolicy}
              >
                <option value="open">{t("admin.joinOpen")}</option>
                <option value="approval">{t("admin.joinApproval")}</option>
              </select>
            </label>
            {adminConfig.security.profile !== "custom" ? (
              <p className="form-note">
                {t("admin.axesManaged", {
                  profile: securityProfileLabels()[adminConfig.security.profile].title,
                  custom: securityProfileLabels().custom.title,
                })}
              </p>
            ) : null}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.featuresEyebrow")}</p>
              <h2>{t("admin.messagingHeading")}</h2>
            </div>
            {featureFlagLabels().map(([key, label]) => (
              <label className="admin-toggle" key={key}>
                <input
                  checked={adminConfig.features[key]}
                  disabled={saving}
                  onInput={(event) => setFeature(key, event.currentTarget.checked)}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.identityEyebrow")}</p>
              <h2>{t("admin.profilesHeading")}</h2>
            </div>
            {identityLabels().map(([key, label]) => (
              <label className="admin-toggle" key={key}>
                <input
                  checked={adminConfig.identity[key]}
                  disabled={saving}
                  onInput={(event) => setIdentity(key, event.currentTarget.checked)}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
          <LlmPanel
            onDevice={adminConfig.llm.onDevice}
            ollama={adminConfig.llm.ollama}
            onOllamaChange={setOllama}
            onOnDeviceChange={setOnDevice}
            saving={saving}
          />
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.privacyEyebrow")}</p>
              <h2>{t("admin.retentionHeading")}</h2>
            </div>
            <label>
              {t("admin.retentionLabel")}
              <input
                disabled={saving || adminConfig.security.profile !== "custom"}
                min={1}
                onInput={(event) => {
                  const minutes = Number.parseInt(event.currentTarget.value, 10);
                  setAdminConfig((previous) =>
                    previous
                      ? {
                          ...previous,
                          retention: {
                            messageTtlMs:
                              Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined,
                          },
                        }
                      : previous,
                  );
                }}
                type="number"
                value={
                  adminConfig.retention.messageTtlMs
                    ? String(Math.round(adminConfig.retention.messageTtlMs / 60_000))
                    : ""
                }
              />
            </label>
            <p className="form-note">{t("admin.retentionNote")}</p>
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.safetyEyebrow")}</p>
              <h2>{t("admin.killSwitchHeading")}</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.killSwitch.enabled}
                disabled={saving || adminConfig.security.profile !== "custom"}
                onInput={(event) => setKillSwitch({ enabled: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.killSwitchEnable")}
            </label>
            <label className="admin-toggle">
              <input
                checked={adminConfig.killSwitch.requireConfirmation}
                disabled={saving || !adminConfig.killSwitch.enabled}
                onInput={(event) => setKillSwitch({ requireConfirmation: event.currentTarget.checked })}
                type="checkbox"
              />
              {t("admin.killSwitchRequireConfirm")}
            </label>
            <label>
              {t("admin.panicToken")}
              <input
                autoComplete="off"
                disabled={saving || !adminConfig.killSwitch.enabled}
                maxLength={256}
                onInput={(event) => setPanicToken(event.currentTarget.value)}
                type="password"
                value={panicToken}
              />
            </label>
            {adminConfig.killSwitch.enabled ? (
              <div className="danger-zone">
                <p className="form-note">{t("admin.killSwitchWarning")}</p>
                {adminConfig.killSwitch.requireConfirmation ? (
                  <label>
                    {t("admin.killSwitchConfirmBefore")} <strong>wipe</strong> {t("admin.killSwitchConfirmAfter")}
                    <input
                      autoComplete="off"
                      disabled={firing}
                      onInput={(event) => setWipeConfirmText(event.currentTarget.value)}
                      value={wipeConfirmText}
                    />
                  </label>
                ) : null}
                <div className="profile-actions">
                  <button
                    className="danger-button"
                    disabled={
                      firing ||
                      (adminConfig.killSwitch.requireConfirmation && wipeConfirmText.trim() !== "wipe")
                    }
                    onClick={() => void fireKillSwitch()}
                    type="button"
                  >
                    {firing ? t("settings.wiping") : t("admin.wipeNow")}
                  </button>
                </div>
                {fireError ? <p className="form-error">{fireError}</p> : null}
              </div>
            ) : null}
          </div>
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.networkEyebrow")}</p>
              <h2>{t("admin.syncHeading")}</h2>
            </div>
            <label className="admin-toggle">
              <input
                checked={adminConfig.sync.enabled}
                disabled={saving}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous
                      ? { ...previous, sync: { ...previous.sync, enabled: event.currentTarget.checked } }
                      : previous,
                  )
                }
                type="checkbox"
              />
              {t("admin.syncEnable")}
            </label>
            <p className="form-note">{t("admin.syncNote")}</p>
            {adminConfig.sync.enabled ? (
              <label>
                {t("admin.syncTokenLabel")}
                <div className="sync-token-row">
                  <input
                    autoComplete="off"
                    disabled={saving}
                    maxLength={256}
                    onInput={(event) =>
                      setAdminConfig((previous) =>
                        // Keep the raw value, including "" — an empty string is the explicit "clear the
                        // token" signal the server understands. Mapping "" → undefined would be dropped
                        // by JSON.stringify, so a cleared field would never reach the server and the old
                        // token would silently persist.
                        previous
                          ? { ...previous, sync: { ...previous.sync, token: event.currentTarget.value } }
                          : previous,
                      )
                    }
                    placeholder={t("admin.syncTokenPlaceholder")}
                    type="text"
                    value={adminConfig.sync.token ?? ""}
                  />
                  <button
                    className="ghost-button"
                    disabled={saving}
                    onClick={() => {
                      const bytes = crypto.getRandomValues(new Uint8Array(16));
                      const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
                      setAdminConfig((previous) =>
                        previous ? { ...previous, sync: { ...previous.sync, token } } : previous,
                      );
                    }}
                    type="button"
                  >
                    {t("admin.syncTokenGenerate")}
                  </button>
                </div>
              </label>
            ) : null}
            {adminConfig.sync.enabled ? <p className="form-note">{t("admin.syncTokenNote")}</p> : null}
            {adminConfig.sync.enabled ? <NodeLinkControl joinUrl={joinUrl} /> : null}
            {adminConfig.sync.peers.length ? (
              <ul className="moderation-list">
                {adminConfig.sync.peers.map((peer) => (
                  <li className="moderation-row sync-peer" key={peer.url}>
                    <div className="moderation-name">
                      <strong>{peer.label ?? peer.url}</strong>
                      {peer.label ? <span>{peer.url}</span> : null}
                    </div>
                    <div className="moderation-actions">
                      <button
                        className="danger-button"
                        disabled={saving}
                        onClick={() =>
                          setAdminConfig((previous) =>
                            previous
                              ? {
                                  ...previous,
                                  sync: {
                                    ...previous.sync,
                                    peers: previous.sync.peers.filter((entry) => entry.url !== peer.url),
                                  },
                                }
                              : previous,
                          )
                        }
                        type="button"
                      >
                        {t("common.remove")}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="form-note">{t("admin.noPeers")}</p>
            )}
            <AddSyncPeerControl
              disabled={saving || adminConfig.sync.peers.length >= 16}
              onAdd={(peer) =>
                setAdminConfig((previous) =>
                  previous && !previous.sync.peers.some((entry) => entry.url === peer.url)
                    ? { ...previous, sync: { ...previous.sync, peers: [...previous.sync.peers, peer] } }
                    : previous,
                )
              }
            />
            <p className="form-note">{t("admin.peerChangesNote")}</p>
            <SyncStatusPanel />
          </div>
          <MeshPanel mesh={adminConfig.mesh} onChange={setMesh} saving={saving} />
          <div className="profile-panel">
            <div>
              <p className="eyebrow">{t("admin.bootstrapEyebrow")}</p>
              <h2>{t("admin.bootstrapHeading")}</h2>
            </div>
            <label>
              {t("admin.strategy")}
              <select
                disabled={saving}
                onInput={(event) =>
                  setAdminConfig((previous) =>
                    previous
                      ? {
                          ...previous,
                          admin: {
                            ...previous.admin,
                            bootstrap: AdminBootstrapStrategySchema.parse(event.currentTarget.value),
                          },
                        }
                      : previous,
                  )
                }
                value={adminConfig.admin.bootstrap}
              >
                {AdminBootstrapStrategySchema.options.map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {strategy}
                  </option>
                ))}
              </select>
            </label>
            {adminConfig.admin.bootstrap === "passphrase" ? (
              <label>
                {t("admin.newPassphrase")}
                <input
                  autoComplete="off"
                  disabled={saving}
                  maxLength={256}
                  onInput={(event) => setPassphrase(event.currentTarget.value)}
                  type="password"
                  value={passphrase}
                />
              </label>
            ) : null}
            <p className="form-note">{t("admin.bootstrapNote")}</p>
            <div className="profile-actions">
              <button disabled={saving} type="submit">
                {saving ? t("common.saving") : t("admin.saveConfig")}
              </button>
            </div>
            {saved ? <p className="form-note">{t("admin.saved")}</p> : null}
            {saveError ? <p className="form-error">{saveError}</p> : null}
          </div>
        </form>
      ) : null}
      <AdminChannelsPanel currentUser={currentUser} onChannelUpsert={onChannelUpsert} />
    </section>
  );
}
