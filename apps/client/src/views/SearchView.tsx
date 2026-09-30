import type { Channel, Message, User } from "@loam/schema";
import { MessageSchema } from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { useLocation } from "preact-iso";
import { useEffect, useId, useState } from "preact/hooks";

import { IconSearch } from "../components/icons";
import { ScreenHeader } from "../components/ScreenHeader";
import { SearchResult } from "../components/SearchResult";
import { t } from "../i18n";
import { fetchJson } from "../lib/api";
import { markdownToPlainText } from "../lib/markdown";
import { bodyFor, displayTime } from "../lib/message-format";

/**
 * Full-text message search over `GET /api/search`. The server scopes results strictly to what this
 * user may read (public channels, their private channels, their own DMs), so the client just
 * renders whatever comes back. Tapping a result jumps to its conversation (or thread).
 */
export function SearchView({
  blockedUserIds,
  channels,
  currentUser,
  usersById,
}: {
  blockedUserIds: ReadonlySet<string>;
  channels: Channel[];
  currentUser: User;
  usersById: Map<string, User>;
}) {
  const location = useLocation();
  // `/search?q=…` opens with that search run (and each search updates the address, so reload/back work).
  const initialQuery = typeof location.query.q === "string" ? location.query.q : "";
  const [query, setQuery] = useState(initialQuery);
  // The terms of the results on screen (what to highlight), not whatever is being typed now.
  const [searchedFor, setSearchedFor] = useState("");
  const [results, setResults] = useState<Message[]>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const searchInputId = useId();

  async function run(text = query): Promise<void> {
    const trimmed = text.trim();

    if (!trimmed || searching) {
      return;
    }

    setSearching(true);
    setError(undefined);
    if (location.query.q !== trimmed) {
      location.route(`/search?q=${encodeURIComponent(trimmed)}`, true);
    }

    try {
      const payload = await fetchJson<unknown>(`/api/search?q=${encodeURIComponent(trimmed)}`);
      const rawResults =
        payload && typeof payload === "object" && "results" in payload && Array.isArray(payload.results)
          ? (payload.results as unknown[])
          : [];
      setSearchedFor(trimmed);
      setResults(
        rawResults.flatMap((item) => {
          const parsed = MessageSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        }),
      );
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : t("search.error"));
    } finally {
      setSearching(false);
    }
  }

  // Opened as /search?q=…: run it once.
  useEffect(() => {
    if (initialQuery.trim()) {
      void run(initialQuery);
    }
    // Only on arrival; later searches go through the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function contextLabel(message: Message): string {
    if (message.type === "channelPost" || message.type === "channelReply") {
      const channel = channels.find((entry) => entry.id === message.channelId);
      return `${channel?.visibility === "private" ? "🔒" : "#"}${channel?.name ?? message.channelId}`;
    }

    if (message.type === "dm") {
      const peerId = message.authorId === currentUser.id ? message.recipientUserId : message.authorId;
      return t("search.dmWith", { name: usersById.get(peerId)?.displayName ?? generateDisplayName(peerId) });
    }

    return "";
  }

  function routeFor(message: Message): string | undefined {
    if (message.type === "channelPost") {
      return `/channel/${encodeURIComponent(message.channelId)}`;
    }

    if (message.type === "channelReply") {
      return `/channel/${encodeURIComponent(message.channelId)}/thread/${encodeURIComponent(message.parentMessageId)}`;
    }

    if (message.type === "dm") {
      const peerId = message.authorId === currentUser.id ? message.recipientUserId : message.authorId;
      return `/dm/${encodeURIComponent(peerId)}`;
    }

    return undefined;
  }

  return (
    <section className="settings-view">
      <ScreenHeader title={t("search.title")} />
      <div className="screen-body">
        <div className="screen-column">
          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
            role="search"
          >
            <label className="sr-only" for={searchInputId}>
              {t("sidebar.searchMessages")}
            </label>
            <span className="search-field">
              <IconSearch className="search-field-icon" size={18} />
              <input
                className="input search-input"
                dir="auto"
                disabled={searching}
                enterKeyHint="search"
                id={searchInputId}
                maxLength={200}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("search.placeholder")}
                type="search"
                value={query}
              />
            </span>
            <button className="btn btn-primary" disabled={searching || !query.trim()} type="submit">
              {searching ? t("search.searching") : t("search.button")}
            </button>
          </form>
          {error ? <p className="notice notice-danger">{error}</p> : null}
          {!results && !error && !searching ? <p className="empty-note">{t("search.hint")}</p> : null}
          {results && !results.length ? <p className="empty-note">{t("search.noResults")}</p> : null}
          {results?.length ? (
            <ul className="search-results">
              {results.map((message) => {
                const route = routeFor(message);
                const author = usersById.get(message.authorId);
                return (
                  <SearchResult
                    authorName={author?.displayName ?? generateDisplayName(message.authorId)}
                    body={markdownToPlainText(bodyFor(message))}
                    contextLabel={contextLabel(message)}
                    hiddenAsBlocked={message.authorId !== currentUser.id && blockedUserIds.has(message.authorId)}
                    key={message.id}
                    onOpen={() => {
                      if (route) {
                        location.route(route);
                      }
                    }}
                    query={searchedFor}
                    time={displayTime(message.createdAt)}
                  />
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
