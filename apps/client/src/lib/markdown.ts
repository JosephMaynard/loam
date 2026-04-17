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

  return template.innerHTML;
}
