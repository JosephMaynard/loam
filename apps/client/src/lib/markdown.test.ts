import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders basic markdown to HTML", () => {
    const html = renderMarkdown("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("strips script tags", () => {
    const html = renderMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("alert(1)</script");
  });

  it("escapes raw HTML so an injected element never becomes live", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    // The tag is escaped to inert text, not rendered as an <img> with a live handler.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("drops javascript: links but keeps the link text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("hardens safe http(s) links with rel and target", () => {
    const html = renderMarkdown("[loam](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("allows mailto links", () => {
    const html = renderMarkdown("[mail](mailto:a@example.com)");
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("removes the href from unsupported schemes like data: while keeping the anchor", () => {
    const html = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain("<a");
    expect(html).not.toMatch(/href="data:/i);
  });

  it("escapes raw HTML entities so angle brackets are not interpreted", () => {
    const html = renderMarkdown("1 < 2 && 3 > 2");
    expect(html).not.toContain("<2");
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
  });
});
