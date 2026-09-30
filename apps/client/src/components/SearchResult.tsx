import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

import { t } from "../i18n";

/** How much text to keep before the first match when a long body is trimmed to show it. */
const LEAD_CHARS = 40;

/**
 * The body with every case-insensitive occurrence of `query` wrapped in `<mark>`. A long body whose first
 * match sits past the preview's reach starts shortly before it (with "…"), so the hit is actually visible
 * in the clamped preview.
 */
export function highlightMatches(body: string, query: string | undefined): ComponentChildren {
  const needle = query?.trim().toLowerCase();
  if (!needle) {
    return body;
  }
  let text = body;
  const first = text.toLowerCase().indexOf(needle);
  if (first > LEAD_CHARS * 2) {
    const start = text.lastIndexOf(" ", first - LEAD_CHARS);
    text = `…${text.slice(start > 0 ? start : first - LEAD_CHARS)}`;
  }
  const parts: ComponentChildren[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + needle.length)) {
    if (index > from) {
      parts.push(text.slice(from, index));
    }
    parts.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    from = index + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * One message-search hit: who wrote it, where it lives, when, and the matching body (plain text, the
 * search terms highlighted). Purely
 * presentational — the caller resolves names/labels and handles navigation, so this stays
 * trivially testable.
 *
 * A hit written by someone the user blocked (`hiddenAsBlocked`) collapses to the same placeholder a channel
 * shows (docs/30 B3): no author, body or link until the user chooses Show.
 */
export function SearchResult({
  authorName,
  body,
  contextLabel,
  hiddenAsBlocked = false,
  onOpen,
  query,
  time,
}: {
  authorName: string;
  body: string;
  contextLabel: string;
  hiddenAsBlocked?: boolean;
  onOpen: () => void;
  /** The search terms, highlighted in the body. */
  query?: string;
  time: string;
}) {
  const [revealed, setRevealed] = useState(false);

  if (hiddenAsBlocked && !revealed) {
    return (
      <li className="search-result search-result-blocked">
        <span className="search-result-body" dir="auto">
          <em>{t("block.hiddenMessage")}</em>{" "}
          <button className="link-button" onClick={() => setRevealed(true)} type="button">
            {t("block.show")}
          </button>
        </span>
      </li>
    );
  }

  return (
    <li className="search-result">
      <button className="search-result-button" onClick={onOpen} type="button">
        <span className="search-result-meta">
          <strong className="search-result-author" dir="auto">
            {authorName}
          </strong>
          <span className="search-result-context" dir="auto">
            {contextLabel}
          </span>
          <time className="search-result-time">{time}</time>
        </span>
        <span className="search-result-body" dir="auto">
          {highlightMatches(body, query)}
        </span>
      </button>
    </li>
  );
}
