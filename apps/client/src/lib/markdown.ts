import DOMPurify from "dompurify";
import snarkdown from "snarkdown";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeLink(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Images only ever need to load from a normal http(s) URL. Unlike links,
 * there is no legitimate `mailto:`/`data:` use case here, so — belt and
 * braces alongside DOMPurify's own scheme filtering — restrict `<img src>`
 * to `http:`/`https:` and drop anything else (control-char/whitespace/case
 * obfuscated schemes, `data:`, `vbscript:`, etc. all fail the same way).
 */
function isSafeImageSrc(src: string): boolean {
  try {
    const url = new URL(src, window.location.origin);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function renderMarkdown(markdown: string): string {
  const html = snarkdown(escapeHtml(markdown));
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(html);

  for (const link of Array.from(template.content.querySelectorAll("a"))) {
    const href = link.getAttribute("href") ?? "";

    if (!isSafeLink(href)) {
      link.removeAttribute("href");
      continue;
    }

    link.setAttribute("rel", "noreferrer");
    link.setAttribute("target", "_blank");
  }

  for (const img of Array.from(template.content.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";

    if (!isSafeImageSrc(src)) {
      img.removeAttribute("src");
    }
  }

  return template.innerHTML;
}

/**
 * Bounded cache of sanitized message HTML, keyed on `(id, editedAt, body)`. The whole `messages`
 * array is replaced on every socket event / stream delta, so without a cache every visible message
 * is re-run through snarkdown + DOMPurify on each delta. The body is part of the key so a streaming
 * message (same id, growing body) always re-renders, while every other visible row hits the cache.
 * FIFO eviction (delete-oldest) keeps it from growing without bound.
 */
const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_LIMIT = 500;

/**
 * Cached wrapper around {@link renderMarkdown} for message bodies. Returns byte-identical HTML to a
 * direct `renderMarkdown(body)` call; the cache is invalidated whenever the body or `editedAt`
 * changes (a distinct key), so edits and streaming updates never show stale HTML.
 *
 * @param id - The message id (stable identity for the row).
 * @param body - The text to render (already resolved, e.g. via `bodyFor`).
 * @param editedAt - The message's edit timestamp, if any; part of the cache key.
 * @returns Sanitized, link-hardened HTML.
 */
export function renderMarkdownCached(id: string, body: string, editedAt?: number): string {
  const key = `${id}\n${editedAt ?? ""}\n${body}`;
  const cached = markdownCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const html = renderMarkdown(body);
  markdownCache.set(key, html);

  if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value;

    if (oldest !== undefined) {
      markdownCache.delete(oldest);
    }
  }

  return html;
}
