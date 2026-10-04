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
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { LOCALE_LABELS, errorText, t } from "../i18n";
import { fetchJson, REQUEST_TIMEOUT_MS } from "../lib/api";
import { encryptedFetch } from "../lib/transport";
import { AddSyncPeerControl } from "./AddSyncPeerControl";
import { AdminChannelsPanel } from "./AdminChannelsPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { GettingStartedPanel } from "./GettingStartedPanel";
import { LlmPanel } from "./LlmPanel";
import { MeshPanel } from "./MeshPanel";
import { NodeLinkControl } from "./NodeLinkControl";
import { CardHeader, SwitchRow } from "./ScreenParts";
import { ScreenHeader } from "./ScreenHeader";
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

/** The admin screen's sections, in page order: the in-page nav's anchors and each section's label. */
function adminSections(): [string, string][] {
  return [
    ["network", t("admin.networkEyebrow")],
    ["access", t("people.accessEyebrow")],
    ["features", t("admin.featuresEyebrow")],
    ["channels", t("admin.channelsEyebrow")],
    ["security", t("settings.securityEyebrow")],
    ["sync", t("admin.nav.sync")],
    ["mesh", t("admin.nav.mesh")],
    ["llm", t("admin.llmEyebrow")],
    ["danger", t("admin.safetyEyebrow")],
  ];
}

/** Scroll the admin body to a section (smoothly unless reduced motion is on) and move focus to it. */
function jumpToSection(key: string): void {
  const target = document.getElementById(`admin-${key}`);
  if (!target) {
    return;
  }
  const behavior = (window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches ?? false) ? "smooth" : "auto";
  // Focus first: moving focus during a smooth scroll cancels the scroll in Chrome.
  target.focus({ preventScroll: true });
  // Scroll ONLY the screen's own scroller. `scrollIntoView` walks every scrollable ancestor, and it will
  // scroll the fixed `.app-frame` (overflow: hidden, still programmatically scrollable) if anything ever
  // gives it overflow — which hid the header and Back button on a phone. The sticky nav is cleared with
  // the section's `scroll-margin-top`, which a manual scroll has to honour by hand.
  const scroller = target.closest<HTMLElement>(".screen-body");
  if (!scroller) {
    target.scrollIntoView({ behavior, block: "start" });
    return;
  }
  const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - margin;
  scroller.scrollTo({ top: Math.max(0, top), behavior });
}

/**
 * One admin section: a small label heading and its cards. A section whose cards edit node config is a
 * `<form>` (pass `onSubmit`), so Enter in any of its fields saves the configuration, as it always has.
 */
function AdminSection({
  children,
  id,
  label,
  onSubmit,
}: {
  children: ComponentChildren;
  id: string;
  label: string;
  onSubmit?: () => void;
}) {
  const labelId = `admin-${id}-label`;
  return (
    <section aria-labelledby={labelId} className="admin-section" id={`admin-${id}`} tabIndex={-1}>
      <h2 className="section-label" id={labelId}>
        {label}
      </h2>
      {onSubmit ? (
        <form
          className="admin-section-body"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {children}
          {/* Implicit submission (Enter in a field) is ignored by browsers when a form has more than one
              text field and no submit button; the sticky "Save node config" bar sits outside every form.
              `hidden` (display: none) rather than .sr-only: an absolutely positioned control here used the
              fixed .app-frame as its containing block and gave it scrollable overflow. */}
          <button hidden tabIndex={-1} type="submit" />
        </form>
      ) : (
        <div className="admin-section-body">{children}</div>
      )}
    </section>
  );
}

/**
 * Admin-only configuration area: edits node feature flags, identity permissions, LLM settings, and
 * the admin bootstrap strategy via the /api/admin/config endpoints. Client gating is cosmetic —
 * the server enforces admin on every request.
 */
export function AdminView({
  currentUser,
  joinUrl,
  onChannelRemoved,
  onChannelUpsert,
  onWiped,
}: {
  currentUser: User;
  joinUrl?: string;
  /** Purge a permanently deleted channel from app state + IndexedDB (the WS `channelRemoved` does
   * the same for other clients; calling it directly makes the deleting admin's own purge immediate
   * and socket-independent). */
  onChannelRemoved: (channelId: string) => void;
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
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string>();
  // Peer URLs the server had when this form last loaded or saved. A node can link itself while the form is
  // open (a "Link a node" code), and the form must take that peer in, or its next save would drop it.
  const knownPeerUrls = useRef(new Set<string>());

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
          knownPeerUrls.current = new Set(parsed.data.sync.peers.map((peer) => peer.url));
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

      knownPeerUrls.current = new Set(parsed.data.sync.peers.map((peer) => peer.url));
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

  /** Trigger the Emergency Reset once its alertdialog is confirmed, with whatever the admin typed there. */
  async function fireKillSwitch(wipeConfirmText: string): Promise<void> {
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
        <ScreenHeader title={t("people.notAuthorizedTitle")} />
        <div className="screen-body">
          <div className="screen-column">
            <p className="empty-note">{t("admin.notAuthorizedNote")}</p>
          </div>
        </div>
      </section>
    );
  }

  const submitConfig = () => void save();
  const profileLocked = !!adminConfig && adminConfig.security.profile !== "custom";
  const channelsSection = (
    <AdminSection id="channels" label={t("admin.channelsEyebrow")}>
      <AdminChannelsPanel currentUser={currentUser} onChannelRemoved={onChannelRemoved} onChannelUpsert={onChannelUpsert} />
    </AdminSection>
  );

  return (
    <section className="settings-view admin-view">
      <ScreenHeader title={t("admin.title")} />
      <div className="screen-body">
        {adminConfig ? (
          <nav aria-label={t("admin.nav.label")} className="admin-nav">
            <div className="admin-nav-inner">
              {adminSections().map(([key, label]) => (
                <a
                  className={key === "danger" ? "admin-nav-link is-danger" : "admin-nav-link"}
                  href={`#admin-${key}`}
                  key={key}
                  onClick={(event) => {
                    event.preventDefault();
                    jumpToSection(key);
                  }}
                >
                  {label}
                </a>
              ))}
            </div>
          </nav>
        ) : null}
        <div className="screen-column">
          {loadError ? <p className="notice notice-danger">{loadError}</p> : null}
          {!adminConfig && !loadError ? <p className="form-note">{t("admin.loading")}</p> : null}
          {adminConfig ? (
            <>
              <GettingStartedPanel />

              <AdminSection id="network" label={t("admin.networkEyebrow")} onSubmit={submitConfig}>
                <div className="card">
                  <CardHeader level={3} title={t("admin.identityHeading")} />
                  <label className="field">
                    <span className="field-label">{t("admin.networkName")}</span>
                    <input
                      className="input"
                      disabled={saving}
                      maxLength={80}
                      onInput={(event) =>
                        setAdminConfig((previous) =>
                          previous ? { ...previous, node: { ...previous.node, name: event.currentTarget.value } } : previous,
                        )
                      }
                      value={adminConfig.node.name}
                    />
                    <span className="field-hint">{t("admin.networkNameNote")}</span>
                  </label>
                  <label className="field">
                    <span className="field-label">{t("admin.language")}</span>
                    <select
                      className="select"
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
                    <span className="field-hint">{t("admin.languageNote")}</span>
                  </label>
                </div>
              </AdminSection>

              <AdminSection id="access" label={t("people.accessEyebrow")} onSubmit={submitConfig}>
                <div className="card">
                  <CardHeader level={3} title={t("admin.bootstrapHeading")} />
                  <label className="field">
                    <span className="field-label">{t("admin.strategy")}</span>
                    <select
                      className="select"
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
                    <span className="field-hint">{t("admin.bootstrapNote")}</span>
                  </label>
                  {adminConfig.admin.bootstrap === "passphrase" ? (
                    <label className="field">
                      <span className="field-label">{t("admin.newPassphrase")}</span>
                      <input
                        autoComplete="off"
                        className="input"
                        disabled={saving}
                        maxLength={256}
                        onInput={(event) => setPassphrase(event.currentTarget.value)}
                        type="password"
                        value={passphrase}
                      />
                    </label>
                  ) : null}
                </div>
              </AdminSection>

              <AdminSection id="features" label={t("admin.featuresEyebrow")} onSubmit={submitConfig}>
                <div className="card">
                  <CardHeader level={3} title={t("admin.messagingHeading")} />
                  <div className="switch-list">
                    {featureFlagLabels().map(([key, label]) => (
                      <SwitchRow
                        checked={adminConfig.features[key]}
                        disabled={saving}
                        key={key}
                        label={label}
                        onChange={(checked) => setFeature(key, checked)}
                      />
                    ))}
                  </div>
                </div>
                <div className="card">
                  <CardHeader level={3} title={t("admin.profilesHeading")} />
                  <div className="switch-list">
                    {identityLabels().map(([key, label]) => (
                      <SwitchRow
                        checked={adminConfig.identity[key]}
                        disabled={saving}
                        key={key}
                        label={label}
                        onChange={(checked) => setIdentity(key, checked)}
                      />
                    ))}
                  </div>
                </div>
              </AdminSection>

              {channelsSection}

              <AdminSection id="security" label={t("settings.securityEyebrow")} onSubmit={submitConfig}>
                <div className="card">
                  <CardHeader level={3} title={t("admin.profileHeading")} />
                  <label className="field">
                    <span className="field-label">{t("admin.posture")}</span>
                    <select
                      className="select"
                      disabled={saving}
                      onInput={(event) => setSecurityProfile(SecurityProfileSchema.parse(event.currentTarget.value))}
                      value={adminConfig.security.profile}
                    >
                      {SecurityProfileSchema.options.map((profile) => (
                        <option key={profile} value={profile}>
                          {securityProfileLabels()[profile].title}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">{securityProfileLabels()[adminConfig.security.profile].summary}</span>
                  </label>
                  <label className="field">
                    <span className="field-label">{t("admin.whoCanJoin")}</span>
                    <select
                      className="select"
                      disabled={saving || profileLocked}
                      onInput={(event) => setJoinPolicy(JoinPolicySchema.parse(event.currentTarget.value))}
                      value={adminConfig.access.joinPolicy}
                    >
                      <option value="open">{t("admin.joinOpen")}</option>
                      <option value="approval">{t("admin.joinApproval")}</option>
                    </select>
                  </label>
                  {profileLocked ? (
                    <p className="notice">
                      {t("admin.axesManaged", {
                        profile: securityProfileLabels()[adminConfig.security.profile].title,
                        custom: securityProfileLabels().custom.title,
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="card">
                  <CardHeader level={3} title={t("admin.retentionHeading")} />
                  <label className="field">
                    <span className="field-label">{t("admin.retentionLabel")}</span>
                    <input
                      className="input input-narrow"
                      disabled={saving || profileLocked}
                      inputMode="numeric"
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
                    <span className="field-hint">{t("admin.retentionNote")}</span>
                  </label>
                </div>
              </AdminSection>

              <AdminSection id="sync" label={t("admin.nav.sync")} onSubmit={submitConfig}>
                <div className="card">
                  <CardHeader level={3} title={t("admin.syncHeading")} />
                  <SwitchRow
                    checked={adminConfig.sync.enabled}
                    description={t("admin.syncNote")}
                    disabled={saving}
                    label={t("admin.syncEnable")}
                    onChange={(checked) =>
                      setAdminConfig((previous) =>
                        previous ? { ...previous, sync: { ...previous.sync, enabled: checked } } : previous,
                      )
                    }
                  />
                  {adminConfig.sync.enabled ? (
                    <div className="field">
                      <label className="field-label" for="admin-sync-token">
                        {t("admin.syncTokenLabel")}
                      </label>
                      <div className="inline-field">
                        <input
                          autoComplete="off"
                          className="input mono-field"
                          disabled={saving}
                          id="admin-sync-token"
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
                          className="btn btn-secondary"
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
                      <span className="field-hint">{t("admin.syncTokenNote")}</span>
                    </div>
                  ) : null}
                  <NodeLinkControl joinUrl={joinUrl} />
                  {adminConfig.sync.peers.length ? (
                    <ul className="list">
                      {adminConfig.sync.peers.map((peer) => (
                        <li className="list-row sync-peer" key={peer.url}>
                          <div className="row-text row-text-first">
                            <strong className="row-title">{peer.label ?? peer.url}</strong>
                            {peer.label ? <span className="row-meta">{peer.url}</span> : null}
                            {peer.transportKey ? (
                              <span className="row-meta peer-key-pinned">🔒 {t("admin.peerKeyPinned")}</span>
                            ) : null}
                          </div>
                          <button
                            className="btn btn-secondary btn-sm"
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
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="empty-note">{t("admin.noPeers")}</p>
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
                  <SyncStatusPanel
                    onReport={(report) => {
                      // Peers the server gained since this form loaded were linked with a code: take them in
                      // (and the sync switch linking turned on), keeping every other unsaved edit.
                      const linked = report.peers.filter((peer) => !knownPeerUrls.current.has(peer.url));
                      if (!linked.length) {
                        return;
                      }
                      for (const peer of linked) {
                        knownPeerUrls.current.add(peer.url);
                      }
                      setAdminConfig((previous) =>
                        previous
                          ? {
                              ...previous,
                              sync: {
                                ...previous.sync,
                                enabled: previous.sync.enabled || report.enabled,
                                peers: [
                                  ...previous.sync.peers,
                                  ...linked
                                    .filter((peer) => !previous.sync.peers.some((entry) => entry.url === peer.url))
                                    .map(({ url, label, transportKey }) => ({
                                      url,
                                      ...(label ? { label } : {}),
                                      ...(transportKey ? { transportKey } : {}),
                                    })),
                                ],
                              },
                            }
                          : previous,
                      );
                    }}
                  />
                </div>
              </AdminSection>

              <AdminSection id="mesh" label={t("admin.nav.mesh")} onSubmit={submitConfig}>
                <MeshPanel mesh={adminConfig.mesh} onChange={setMesh} saving={saving} />
              </AdminSection>

              <AdminSection id="llm" label={t("admin.llmEyebrow")} onSubmit={submitConfig}>
                <LlmPanel
                  onDevice={adminConfig.llm.onDevice}
                  ollama={adminConfig.llm.ollama}
                  onOllamaChange={setOllama}
                  onOnDeviceChange={setOnDevice}
                  saving={saving}
                />
              </AdminSection>

              <AdminSection id="danger" label={t("admin.safetyEyebrow")} onSubmit={submitConfig}>
                <div className="card card-danger">
                  <CardHeader level={3} title={t("admin.killSwitchHeading")} />
                  <div className="switch-list">
                    <SwitchRow
                      checked={adminConfig.killSwitch.enabled}
                      disabled={saving || profileLocked}
                      label={t("admin.killSwitchEnable")}
                      onChange={(checked) => setKillSwitch({ enabled: checked })}
                    />
                    <SwitchRow
                      checked={adminConfig.killSwitch.requireConfirmation}
                      disabled={saving || !adminConfig.killSwitch.enabled}
                      label={t("admin.killSwitchRequireConfirm")}
                      onChange={(checked) => setKillSwitch({ requireConfirmation: checked })}
                    />
                  </div>
                  <label className="field">
                    <span className="field-label">{t("admin.panicToken")}</span>
                    <input
                      autoComplete="off"
                      className="input"
                      disabled={saving || !adminConfig.killSwitch.enabled}
                      maxLength={256}
                      onInput={(event) => setPanicToken(event.currentTarget.value)}
                      type="password"
                      value={panicToken}
                    />
                  </label>
                  {adminConfig.killSwitch.enabled ? (
                    <div className="danger-zone">
                      <p>{t("admin.killSwitchWarning")}</p>
                      <div className="card-actions">
                        <button
                          className="btn btn-danger"
                          disabled={firing}
                          onClick={() => {
                            setFireError(undefined);
                            setConfirmingWipe(true);
                          }}
                          type="button"
                        >
                          {firing ? t("settings.wiping") : t("admin.wipeNow")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </AdminSection>

              {/* One Save for every config section above (the channels section acts immediately). Sticky
                  so it stays in reach on a long page; its status line reports the last save. */}
              <div className="save-bar">
                <p aria-live="polite" className={saveError ? "save-bar-status form-error" : "save-bar-status form-note"}>
                  {saveError ?? (saved ? t("admin.saved") : "")}
                </p>
                <button className="btn btn-primary" disabled={saving} onClick={submitConfig} type="button">
                  {saving ? t("common.saving") : t("admin.saveConfig")}
                </button>
              </div>
            </>
          ) : (
            channelsSection
          )}
        </div>
      </div>
      {confirmingWipe && adminConfig ? (
        <ConfirmDialog
          busy={firing}
          busyLabel={t("settings.wiping")}
          confirmLabel={t("admin.wipeNow")}
          confirmWord={adminConfig.killSwitch.requireConfirmation ? "wipe" : undefined}
          confirmWordAfter={t("admin.killSwitchConfirmAfter")}
          confirmWordBefore={t("admin.killSwitchConfirmBefore")}
          error={fireError}
          onCancel={() => setConfirmingWipe(false)}
          onConfirm={(typed) => void fireKillSwitch(typed)}
          title={t("admin.killSwitchHeading")}
        >
          <p>{t("admin.killSwitchWarning")}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
