import { ChannelSchema, type Channel, type ChannelPostingPolicy, type User } from "@loam/schema";
import { useCallback, useEffect, useState } from "preact/hooks";

import { t } from "../i18n";
import { deleteChannelRequest, fetchJson, requestChannel } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { CardHeader, SwitchRow } from "./ScreenParts";

/**
 * Admin-only channel management: create public channels; rename, archive/restore (read-only-but-
 * available), or permanently delete existing ones. Fetches its own full list from
 * `/api/admin/channels` (which includes private channels the admin isn't a member of — they manage
 * without reading). The server is the enforcer.
 */
export function AdminChannelsPanel({
  currentUser,
  onChannelRemoved,
  onChannelUpsert,
}: {
  currentUser: User;
  /** App-level purge for a deleted channel (state + IndexedDB) — not just this panel's list. */
  onChannelRemoved?: (channelId: string) => void;
  onChannelUpsert: (channels: Channel[]) => void;
}) {
  const [adminChannels, setAdminChannels] = useState<Channel[]>([]);
  const [listError, setListError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allowPosting, setAllowPosting] = useState<ChannelPostingPolicy>("everyone");
  const [allowReplies, setAllowReplies] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  /** Upsert a channel into the local admin list (preserving order) and the sidebar in one step. */
  const applyChannel = useCallback(
    (channel: Channel) => {
      setAdminChannels((previous) => {
        const next = new Map(previous.map((entry) => [entry.id, entry]));
        next.set(channel.id, channel);
        return Array.from(next.values());
      });
      onChannelUpsert([channel]);
    },
    [onChannelUpsert],
  );

  /** Drop a deleted channel from the admin list AND purge it from app state/IndexedDB directly —
   * the targeted `channelRemoved` event does the same, but calling the app purge here makes this
   * client's cleanup immediate even if its socket happens to be down. */
  const removeChannelRow = useCallback(
    (channelId: string) => {
      setAdminChannels((previous) => previous.filter((entry) => entry.id !== channelId));
      onChannelRemoved?.(channelId);
    },
    [onChannelRemoved],
  );

  useEffect(() => {
    if (!currentUser.isAdmin) {
      return;
    }

    let active = true;

    fetchJson<unknown>("/api/admin/channels")
      .then((payload) => {
        if (!active) {
          return;
        }

        // Validate the WHOLE list, don't silently drop invalid entries: a channel that fails the schema
        // is contract drift the admin should see (a dropped row reads as "the channel is gone"), so
        // surface the error and leave the list un-loaded rather than showing a quietly-truncated set.
        const list: Channel[] = [];
        if (!Array.isArray(payload)) {
          setListError(t("admin.channelsLoadError"));
          return;
        }
        for (const item of payload) {
          const parsed = ChannelSchema.safeParse(item);
          if (!parsed.success) {
            setListError(t("admin.channelsLoadError"));
            return;
          }
          list.push(parsed.data);
        }
        setAdminChannels(list);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) {
          setListError(error instanceof Error ? error.message : t("admin.channelsLoadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [currentUser.isAdmin]);

  async function create(): Promise<void> {
    if (!name.trim()) {
      return;
    }

    setCreating(true);
    setCreateError(undefined);

    try {
      const channel = await requestChannel("POST", "/api/channels", {
        name: name.trim(),
        description: description.trim() || undefined,
        ...(isPrivate ? { visibility: "private" } : {}),
        allowPosting,
        allowReplies,
      });
      applyChannel(channel);
      setName("");
      setDescription("");
      setAllowPosting("everyone");
      setAllowReplies(true);
      setIsPrivate(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("admin.channelCreateError"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <CardHeader level={3} title={t("admin.createChannelHeading")} />
        <label className="field">
          <span className="field-label">{t("admin.channelName")}</span>
          <input
            className="input"
            disabled={creating}
            maxLength={80}
            onInput={(event) => setName(event.currentTarget.value)}
            placeholder={t("admin.channelNamePlaceholder")}
            value={name}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("admin.channelDescription")}</span>
          <input
            className="input"
            disabled={creating}
            maxLength={280}
            onInput={(event) => setDescription(event.currentTarget.value)}
            value={description}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("admin.whoCanPost")}</span>
          <select
            className="select"
            disabled={creating}
            onInput={(event) => setAllowPosting(event.currentTarget.value === "admins" ? "admins" : "everyone")}
            value={allowPosting}
          >
            <option value="everyone">{t("admin.postEveryone")}</option>
            <option value="admins">{t("admin.postAdmins")}</option>
          </select>
        </label>
        <div className="switch-list">
          <SwitchRow checked={allowReplies} disabled={creating} label={t("admin.allowReplies")} onChange={setAllowReplies} />
          <SwitchRow checked={isPrivate} disabled={creating} label={t("admin.channelPrivate")} onChange={setIsPrivate} />
        </div>
        {createError ? <p className="form-error">{createError}</p> : null}
        <div className="card-actions">
          <button className="btn btn-primary" disabled={creating || !name.trim()} type="submit">
            {creating ? t("admin.creating") : t("admin.createChannel")}
          </button>
        </div>
      </form>
      <div className="card">
        <CardHeader level={3} title={t("admin.existingChannels")} />
        {listError ? <p className="notice notice-danger">{listError}</p> : null}
        {!loaded && !listError ? <p className="form-note">{t("admin.channelsLoading")}</p> : null}
        {loaded && adminChannels.length === 0 ? <p className="empty-note">{t("admin.channelsEmpty")}</p> : null}
        {adminChannels.length > 0 ? (
          <ul className="list admin-channel-list">
            {adminChannels.map((channel) => (
              <AdminChannelRow channel={channel} key={channel.id} onApply={applyChannel} onRemove={removeChannelRow} />
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

/**
 * One row in the admin channel list: rename the channel, archive/restore it (read-only-but-
 * available), or permanently delete it (gone for good — confirmed first). Holds its own draft
 * name so editing one channel never disturbs another.
 */
function AdminChannelRow({
  channel,
  onApply,
  onRemove,
}: {
  channel: Channel;
  onApply: (channel: Channel) => void;
  onRemove: (channelId: string) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string>();

  const trimmedName = name.trim();
  const renameDisabled = busy || !trimmedName || trimmedName === channel.name;

  async function patch(update: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      const updated = await requestChannel("PATCH", `/api/channels/${channel.id}`, update);
      onApply(updated);
      setName(updated.name);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("admin.channelUpdateError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={channel.archived ? "admin-channel archived" : "admin-channel"}>
      <div className="admin-channel-name">
        <input
          aria-label={t("admin.channelNameAria", { name: channel.name })}
          className="input"
          disabled={busy}
          maxLength={80}
          onInput={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <button
          className="btn btn-secondary"
          disabled={renameDisabled}
          onClick={() => void patch({ name: trimmedName })}
          type="button"
        >
          {t("admin.rename")}
        </button>
      </div>
      <span className="row-meta admin-channel-meta">
        {channel.allowPosting === "admins" ? t("admin.metaAdminsPost") : t("admin.metaOpenPosting")}
        {channel.visibility === "private" ? ` · ${t("admin.metaPrivate")}` : ""}
        {channel.pinned ? ` · ${t("admin.metaPinned")}` : ""}
        {channel.archived ? ` · ${t("admin.metaArchived")}` : ""}
      </span>
      <div className="admin-channel-actions">
        <label className="admin-channel-ttl">
          <span>{t("admin.channelRetentionLabel")}</span>
          <select
            className="select select-sm"
            disabled={busy}
            onInput={(event) =>
              void patch({
                messageTtlMs: event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
              })
            }
            value={channel.messageTtlMs ?? ""}
          >
            <option value="">{t("admin.retention.default")}</option>
            <option value={3_600_000}>{t("admin.retention.1h")}</option>
            <option value={86_400_000}>{t("admin.retention.1d")}</option>
            <option value={604_800_000}>{t("admin.retention.7d")}</option>
          </select>
        </label>
        <div className="row-actions">
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void patch({ pinned: !channel.pinned })}
            type="button"
          >
            {channel.pinned ? t("admin.unpin") : t("admin.pin")}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void patch({ archived: !channel.archived })}
            type="button"
          >
            {channel.archived ? t("admin.restore") : t("admin.archive")}
          </button>
          <button
            aria-label={t("admin.deleteChannelAria", { name: channel.name })}
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            type="button"
          >
            {t("admin.deleteChannel")}
          </button>
        </div>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {confirmingDelete ? (
        <ConfirmDialog
          confirmLabel={t("admin.deleteChannel")}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void remove();
          }}
          title={t("admin.deleteChannelAria", { name: channel.name })}
        >
          <p>{t("admin.deleteChannelConfirm", { name: channel.name })}</p>
        </ConfirmDialog>
      ) : null}
    </li>
  );

  /** Permanently delete this channel (its alertdialog has been confirmed) — unlike archive, there is no undo. */
  async function remove(): Promise<void> {
    setBusy(true);
    setError(undefined);

    try {
      await deleteChannelRequest(channel.id);
      onRemove(channel.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t("admin.channelUpdateError"));
    } finally {
      // Symmetric with `patch()`: on success the row unmounts anyway, and a no-op state set on an
      // unmounted component is harmless — while a future kept-mounted row won't wedge as busy.
      setBusy(false);
    }
  }
}
