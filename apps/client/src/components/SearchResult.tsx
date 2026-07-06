/**
 * One message-search hit: who wrote it, where it lives, when, and the matching body. Purely
 * presentational — the caller resolves names/labels and handles navigation, so this stays
 * trivially testable.
 */
export function SearchResult({
  authorName,
  body,
  contextLabel,
  onOpen,
  time,
}: {
  authorName: string;
  body: string;
  contextLabel: string;
  onOpen: () => void;
  time: string;
}) {
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
