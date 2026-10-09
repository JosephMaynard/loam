import type { NetworkConfig, User, UserUpdateRequest } from "@loam/schema";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useMemo, useState } from "preact/hooks";

import { Avatar } from "../components/Avatar";
import { AppearancePanel } from "../components/AppearancePanel";
import { AvatarImageEditor } from "../components/AvatarImageEditor";
import { BlockedUsersPanel } from "../components/BlockedUsersPanel";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NavLink } from "../components/NavLink";
import { CardHeader } from "../components/ScreenParts";
import { ScreenHeader } from "../components/ScreenHeader";
import { t } from "../i18n";
import { CONTACT_EMAIL, WEBSITE } from "../lib/contact";
import { safeQrSvg } from "../lib/qr";
import { fingerprint, getHostKeyMismatch, inviteQrHostKey, isSessionQrVerified, joinQrUrl } from "../lib/transport";

/** The slice of the app's node config the settings screen reads (the join URL, version and flags). */
export type SettingsConfig = {
  /** The node's build version, shown in the join footer. Absent on very old nodes. */
  version?: string;
  joinUrl: string;
  networkConfig: NetworkConfig;
};

const AVATAR_MODES = ["face", "initial", "pattern"] as const;
type AvatarModeChoice = (typeof AVATAR_MODES)[number];
/** LOAM's public privacy policy, linked from Settings (docs/30 B2). */

/** The translated name of each generated-avatar style (the choice tiles' captions). */
function avatarModeLabel(mode: AvatarModeChoice): string {
  return mode === "face" ? t("settings.avatarFace") : mode === "initial" ? t("settings.avatarInitial") : t("settings.avatarPattern");
}

/**
 * Let a long generated name ("southern.ridge.spider") wrap after its dots rather than mid-word: each dot is
 * followed by a `<wbr>` break opportunity.
 */
function withDotBreaks(name: string): ComponentChildren {
  const parts = name.split(".");
  return parts.map((part, index) => (index < parts.length - 1 ? [part, ".", <wbr key={index} />] : part));
}

/**
 * Renders the settings screen for the current user: identity (avatar preview, name, generated-avatar
 * style, image upload), the colour theme, the join QR, admin access, blocked people, the privacy link and — under the
 * hardened profile — the device wipe. One centred column of cards.
 *
 * The UI respects node feature flags from `config.networkConfig`: it enables or disables
 * display name editing, avatar style editing, and image uploads accordingly. Saving the
 * profile will invoke `onUpdateCurrentUser` with any changed display name or generated
 * avatar settings. Image avatar uploads produced by the crop editor are forwarded to
 * `onUploadAvatarImage`.
 *
 * @param onUpdateCurrentUser - Called with a `UserUpdateRequest` when the user saves profile changes.
 * @param onUploadAvatarImage - Called with the cropped avatar `Blob` when the user uploads an image avatar.
 */
export function SettingsView({
  blockedUserIds,
  config,
  currentUser,
  onClaimAdmin,
  onSetBlocked,
  onUpdateCurrentUser,
  onUploadAvatarImage,
  onWipeDevice,
  usersById,
}: {
  blockedUserIds: ReadonlySet<string>;
  config?: SettingsConfig;
  currentUser: User;
  onClaimAdmin: (secret: string) => Promise<void>;
  onSetBlocked: (userId: string, blocked: boolean) => Promise<void>;
  onUpdateCurrentUser: (request: UserUpdateRequest) => Promise<void>;
  onUploadAvatarImage: (blob: Blob) => Promise<void>;
  onWipeDevice: () => Promise<void>;
  usersById: Map<string, User>;
}) {
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [avatarKind, setAvatarKind] = useState(currentUser.avatar?.kind === "image" ? "image" : "generated");
  const [avatarSeed, setAvatarSeed] = useState(currentUser.avatar?.seed ?? currentUser.id);
  const [avatarMode, setAvatarMode] = useState(currentUser.avatar?.mode ?? "face");
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const avatarChoiceName = useId();
  const allowDisplayNameEdit = config?.networkConfig.allowUserDisplayNameEdit ?? false;
  const allowAvatarEdit = config?.networkConfig.allowUserAvatarEdit ?? false;
  const allowAvatarUpload = config?.networkConfig.allowUserAvatarUpload ?? false;
  // Encode the host's transport public key into the join QR (docs/08) so a scanner learns it
  // out-of-band → MITM-resistant handshake. The displayed URL text below stays plain. Only a key THIS
  // client verified from its own scanned QR is vouched for — never the one the unauthenticated bootstrap
  // advertised — and the QR is withheld when those two disagree (see `inviteQrHostKey`).
  const inviteQr = config ? inviteQrHostKey() : undefined;
  const qrSvg = useMemo(
    () =>
      config?.joinUrl && !inviteQr?.suppressed ? safeQrSvg(joinQrUrl(config.joinUrl, inviteQr?.key), "#203f34") : "",
    [config?.joinUrl, inviteQr?.key, inviteQr?.suppressed],
  );
  const previewUser: User = {
    ...currentUser,
    displayName,
    avatar:
      avatarKind === "image"
        ? currentUser.avatar
        : {
            kind: "generated",
            seed: avatarSeed,
            mode: avatarMode,
          },
  };

  useEffect(() => {
    setDisplayName(currentUser.displayName);
    setAvatarKind(currentUser.avatar?.kind === "image" ? "image" : "generated");
    setAvatarSeed(currentUser.avatar?.seed ?? currentUser.id);
    setAvatarMode(currentUser.avatar?.mode ?? "face");
  }, [
    currentUser.avatar?.imageId,
    currentUser.avatar?.kind,
    currentUser.avatar?.mode,
    currentUser.avatar?.seed,
    currentUser.displayName,
    currentUser.id,
  ]);

  async function saveProfile(): Promise<void> {
    const update: UserUpdateRequest = {};

    if (allowDisplayNameEdit) {
      update.displayName = displayName.trim();
    }

    if (allowAvatarEdit && avatarKind !== "image") {
      update.avatar = {
        kind: "generated",
        seed: avatarSeed.trim() || currentUser.id,
        mode: avatarMode,
      };
    }

    if (!update.displayName && !update.avatar) {
      return;
    }

    setSaving(true);
    setProfileError(undefined);

    try {
      await onUpdateCurrentUser(update);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : t("settings.profileError"));
    } finally {
      setSaving(false);
    }
  }

  function randomizeAvatar(): void {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    setAvatarKind("generated");
    setAvatarSeed(`avatar.${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  }

  // The identity summary is always shown so a user sees who they are; the editing controls render only
  // when the node allows them — a section that would be entirely disabled is hidden, not greyed out.
  const identitySummary = (
    <div className="identity-summary">
      <Avatar avatar={previewUser.avatar} id={currentUser.id} size="xl" />
      <div className="identity-text">
        <p className="identity-caption">{t("settings.thisBrowser")}</p>
        <h2 className="identity-name" dir="auto">
          {withDotBreaks(displayName)}
        </h2>
      </div>
    </div>
  );

  return (
    <section className="settings-view">
      <ScreenHeader title={t("settings.title")} />
      <div className="screen-body">
        <div className="screen-column">
          {allowDisplayNameEdit || allowAvatarEdit ? (
            <form
              aria-label={t("settings.profileTitle")}
              className="card identity-card"
              onSubmit={(event) => {
                event.preventDefault();
                void saveProfile();
              }}
            >
              {identitySummary}
              {allowDisplayNameEdit ? (
                <label className="field">
                  <span className="field-label">{t("settings.displayName")}</span>
                  <input
                    className="input"
                    dir="auto"
                    disabled={saving}
                    maxLength={80}
                    onInput={(event) => setDisplayName(event.currentTarget.value)}
                    value={displayName}
                  />
                </label>
              ) : null}
              {allowAvatarEdit ? (
                <fieldset className="field avatar-style-field" disabled={saving || avatarKind === "image"}>
                  <legend className="field-label">{t("settings.avatarStyle")}</legend>
                  <div className="choice-row">
                    {AVATAR_MODES.map((mode) => (
                      <label className="choice-tile" key={mode}>
                        <input
                          checked={avatarMode === mode}
                          className="choice-input"
                          name={avatarChoiceName}
                          onInput={() => {
                            setAvatarKind("generated");
                            setAvatarMode(mode);
                          }}
                          type="radio"
                          value={mode}
                        />
                        <span aria-hidden="true" className="choice-frame" />
                        <Avatar avatar={{ kind: "generated", seed: avatarSeed, mode }} id={currentUser.id} size="lg" />
                        <span className="choice-label">{avatarModeLabel(mode)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {profileError ? <p className="form-error">{profileError}</p> : null}
              <div className="card-actions">
                {allowAvatarEdit ? (
                  <button className="btn btn-secondary" disabled={saving} onClick={randomizeAvatar} type="button">
                    {t("settings.newAvatar")}
                  </button>
                ) : null}
                <button className="btn btn-primary" disabled={saving} type="submit">
                  {saving ? t("common.saving") : t("settings.saveProfile")}
                </button>
              </div>
              {allowAvatarEdit && allowAvatarUpload ? (
                <div className="card-section">
                  <h3 className="card-subtitle">{t("settings.cropUpload")}</h3>
                  <AvatarImageEditor disabled={saving} onUpload={onUploadAvatarImage} />
                </div>
              ) : null}
            </form>
          ) : (
            <div className="card identity-card">{identitySummary}</div>
          )}

          <AppearancePanel />

          <div className="card join-card">
            <CardHeader title={t("settings.joinTitle")} />
            {inviteQr?.suppressed ? (
              <p className="notice notice-danger">{t("invite.qrKeyMismatch")}</p>
            ) : (
              <div aria-hidden="true" className="qr-tile" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            )}
            {inviteQr && !inviteQr.suppressed && !inviteQr.key && config?.networkConfig.transportPublicKey ? (
              <p className="form-note">{t("invite.qrNoKeyNote")}</p>
            ) : null}
            <p className="join-url">{config?.joinUrl ?? window.location.origin}</p>
            {/* Transport encryption (docs/08): only shown once a session is actually live — `fingerprint()`
                returns undefined off-mode or before the handshake completes. A QR-verified session (the
                host key came from a scanned join QR, out-of-band) is MITM-resistant; a session keyed only
                from the server's advertised config key is not — an attacker on the LAN could have supplied
                that key — so the two are surfaced distinctly rather than both reading as "Encrypted". */}
            {fingerprint() ? (
              <p className="transport-fingerprint">
                {isSessionQrVerified()
                  ? t("settings.transportVerifiedLine", { fingerprint: fingerprint() ?? "" })
                  : t("settings.transportUnverifiedLine", { fingerprint: fingerprint() ?? "" })}
              </p>
            ) : null}
            {fingerprint() && !isSessionQrVerified() ? (
              <p className="form-note">{t("settings.transportUnverifiedHint")}</p>
            ) : null}
            {getHostKeyMismatch() ? <p className="form-error">{t("settings.transportKeyMismatch")}</p> : null}
            {/* Product name + version — the node's build, not this browser's cache. Deliberately no
                translatable label word so it stays i18n-neutral. */}
            <p className="node-version">LOAM v{config?.version ?? "…"}</p>
          </div>

          <AdminAccessPanel
            allowAdminClaim={config?.networkConfig.allowAdminClaim ?? false}
            currentUser={currentUser}
            onClaimAdmin={onClaimAdmin}
          />
          <BlockedUsersPanel blockedUserIds={blockedUserIds} onSetBlocked={onSetBlocked} usersById={usersById} />
          {config?.networkConfig.securityProfile === "hardened" ? <DeviceWipePanel onWipeDevice={onWipeDevice} /> : null}
          {/* The privacy policy is served by this node (/privacy, lib/privacy-policy.ts): it reads with no
              internet and never sends anyone to another website. */}
          <p className="screen-footnote privacy-policy-link">
            <a href="/rules">{t("settings.rules")}</a>
            {" · "}
            <a href="/privacy">{t("settings.privacyPolicy")}</a>
          </p>
          {/* No telemetry, so a report is the only way a problem reaches us. Plain text, not links: the
              network may have no internet, and Settings never sends anyone off the node. */}
          <p className="screen-footnote report-problems">
            {t("settings.reportProblems")}
            <br />
            <span dir="ltr">{WEBSITE}</span>
            <br />
            <span dir="ltr">{CONTACT_EMAIL}</span>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Local ("wipe this device") kill switch, shown only under the hardened security profile. Erases
 * this browser's local copy after an alertdialog with a typed confirmation; it does not touch the node or
 * other devices (that is the admin kill switch). Reuses the app's `purgeLocalData` flow.
 */
function DeviceWipePanel({ onWipeDevice }: { onWipeDevice: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function wipe(): Promise<void> {
    setWiping(true);

    try {
      await onWipeDevice();
    } finally {
      setWiping(false);
    }
  }

  return (
    <div className="card card-danger">
      <CardHeader description={t("settings.wipeBody")} title={t("settings.wipeTitle")} />
      <div className="card-actions">
        <button className="btn btn-danger" disabled={wiping} onClick={() => setConfirming(true)} type="button">
          {wiping ? t("settings.wiping") : t("settings.wipeTitle")}
        </button>
      </div>
      {confirming ? (
        <ConfirmDialog
          busy={wiping}
          busyLabel={t("settings.wiping")}
          confirmLabel={t("settings.wipeTitle")}
          confirmWord="wipe"
          confirmWordAfter={t("settings.wipeConfirmAfter")}
          confirmWordBefore={t("settings.wipeConfirmBefore")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void wipe()}
          title={t("settings.wipeTitle")}
        >
          <p>{t("settings.wipeBody")}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * Settings card granting entry to the admin area: a link for admins, a secret claim form when the
 * node's bootstrap strategy allows claiming, or an explanatory note otherwise.
 */
function AdminAccessPanel({
  allowAdminClaim,
  currentUser,
  onClaimAdmin,
}: {
  allowAdminClaim: boolean;
  currentUser: User;
  onClaimAdmin: (secret: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string>();

  async function claim(): Promise<void> {
    setClaiming(true);
    setClaimError(undefined);

    try {
      await onClaimAdmin(secret.trim());
      setSecret("");
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : t("settings.claimError"));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="card">
      <CardHeader title={currentUser.isAdmin ? t("settings.adminTools") : t("settings.adminAccess")} />
      {currentUser.isAdmin ? (
        <div className="card-actions card-actions-start">
          <NavLink active={false} className="btn btn-primary admin-open-link" href="/admin">
            {t("settings.openAdmin")}
          </NavLink>
        </div>
      ) : allowAdminClaim ? (
        <form
          className="card-form"
          onSubmit={(event) => {
            event.preventDefault();
            void claim();
          }}
        >
          <label className={claimError ? "field has-error" : "field"}>
            <span className="field-label">{t("settings.claimLabel")}</span>
            <input
              autoComplete="off"
              className="input"
              disabled={claiming}
              onInput={(event) => setSecret(event.currentTarget.value)}
              type="password"
              value={secret}
            />
            {claimError ? <span className="field-error">{claimError}</span> : null}
          </label>
          <div className="card-actions">
            <button className="btn btn-primary" disabled={claiming || !secret.trim()} type="submit">
              {claiming ? t("settings.checking") : t("settings.unlockAdmin")}
            </button>
          </div>
        </form>
      ) : (
        <p className="form-note">{t("settings.claimDisabled")}</p>
      )}
    </div>
  );
}
