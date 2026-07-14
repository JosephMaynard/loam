import { ChannelSchema, type Channel, type ChannelPostingPolicy, type User } from "@loam/schema";
import { useCallback, useEffect, useState } from "preact/hooks";

import { t } from "../i18n";
import { fetchJson, requestChannel } from "../lib/api";

/**
 * Admin-only channel management: create public channels and rename/archive existing ones. Channels
 * are created public + discoverable (private channels need a membership model that does not exist
 * yet). Fetches its own full list from `/api/admin/channels` so archived channels remain visible
 * and restorable here even though they are hidden from the sidebar. The server is the enforcer.
 */
export function AdminChannelsPanel({
  currentUser,
  onChannelUpsert,
}: {
  currentUser: User;
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
    <div className="settings-grid">
      <div className="profile-panel">
        <div>
          <p className="eyebrow">{t("admin.channelsEyebrow")}</p>
          <h2>{t("admin.createChannelHeading")}</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label>
            {t("admin.channelName")}
            <input
              disabled={creating}
              maxLength={80}
              onInput={(event) => setName(event.currentTarget.value)}
              placeholder={t("admin.channelNamePlaceholder")}
              value={name}
            />
          </label>
          <label>
            {t("admin.channelDescription")}
            <input
              disabled={creating}
              maxLength={280}
              onInput={(event) => setDescription(event.currentTarget.value)}
              value={description}
            />
          </label>
          <label>
            {t("admin.whoCanPost")}
            <select
              disabled={creating}
              onInput={(event) =>
                setAllowPosting(event.currentTarget.value === "admins" ? "admins" : "everyone")
              }
              value={allowPosting}
            >
              <option value="everyone">{t("admin.postEveryone")}</option>
              <option value="admins">{t("admin.postAdmins")}</option>
            </select>
          </label>
          <label className="admin-toggle">
            <input
              checked={allowReplies}
              disabled={creating}
              onInput={(event) => setAllowReplies(event.currentTarget.checked)}
              type="checkbox"
            />
            {t("admin.allowReplies")}
          </label>
          <label className="admin-toggle">
            <input
              checked={isPrivate}
              disabled={creating}
              onInput={(event) => setIsPrivate(event.currentTarget.checked)}
              type="checkbox"
            />
            {t("admin.channelPrivate")}
          </label>
          <div className="profile-actions">
            <button disabled={creating || !name.trim()} type="submit">
              {creating ? t("admin.creating") : t("admin.createChannel")}
            </button>
          </div>
          {createError ? <p className="form-error">{createError}</p> : null}
        </form>
      </div>
      <div className="profile-panel">
        <div>
          <p className="eyebrow">{t("admin.channelsEyebrow")}</p>
          <h2>{t("admin.existingChannels")}</h2>
        </div>
        {listError ? <p className="form-error">{listError}</p> : null}
        {!loaded && !listError ? <p className="form-note">{t("admin.channelsLoading")}</p> : null}
        {loaded && adminChannels.length === 0 ? (
          <p className="form-note">{t("admin.channelsEmpty")}</p>
        ) : null}
        {adminChannels.length > 0 ? (
          <ul className="admin-channel-list">
            {adminChannels.map((channel) => (
              <AdminChannelRow channel={channel} key={channel.id} onApply={applyChannel} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One row in the admin channel list: rename the channel or archive/restore it. Holds its own draft
 * name so editing one channel never disturbs another.
 */
function AdminChannelRow({
  channel,
  onApply,
}: {
  channel: Channel;
  onApply: (channel: Channel) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [busy, setBusy] = useState(false);
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
      <div className="admin-channel-main">
        <input
          aria-label={t("admin.channelNameAria", { name: channel.name })}
          disabled={busy}
          maxLength={80}
          onInput={(event) => setName(event.currentTarget.value)}
          value={name}
        />
        <span className="admin-channel-meta">
          {channel.allowPosting === "admins" ? t("admin.metaAdminsPost") : t("admin.metaOpenPosting")}
          {channel.visibility === "private" ? ` · ${t("admin.metaPrivate")}` : ""}
          {channel.archived ? ` · ${t("admin.metaArchived")}` : ""}
        </span>
      </div>
      <div className="admin-channel-actions">
        <button disabled={renameDisabled} onClick={() => void patch({ name: trimmedName })} type="button">
          {t("admin.rename")}
        </button>
        <button
          className={channel.archived ? undefined : "danger-button"}
          disabled={busy}
          onClick={() => void patch({ archived: !channel.archived })}
          type="button"
        >
          {channel.archived ? t("admin.restore") : t("admin.archive")}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </li>
  );
}
