import { useState } from "preact/hooks";

import { t } from "../i18n";

/**
 * One message-search hit: who wrote it, where it lives, when, and the matching body. Purely
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
  time,
}: {
  authorName: string;
  body: string;
  contextLabel: string;
  hiddenAsBlocked?: boolean;
  onOpen: () => void;
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
          <strong>{authorName}</strong>
          <span> · {contextLabel}</span>
          <span> · {time}</span>
        </span>
        <span className="search-result-body" dir="auto">
          {body}
        </span>
      </button>
    </li>
  );
}
