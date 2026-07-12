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

  describe("image src XSS vectors", () => {
    // A dangerous `src` is one that can execute script when the browser loads
    // it as an image: a `javascript:`/`vbscript:` URL (in any case/whitespace
    // obfuscation) that would run on load in legacy engines, or a live
    // `data:` URI. None of these should ever survive in the rendered `src`.
    function assertNoDangerousSrc(html: string): void {
      expect(html).not.toMatch(/src\s*=\s*"javascript:/i);
      expect(html).not.toMatch(/src\s*=\s*"vbscript:/i);
      expect(html).not.toMatch(/src\s*=\s*"data:/i);
      expect(html.toLowerCase()).not.toContain("alert(1)");
    }

    it("drops javascript: image src while keeping the alt text", () => {
      const html = renderMarkdown("![x](javascript:alert(1))");
      assertNoDangerousSrc(html);
      expect(html).toContain("<img");
      expect(html).toContain('alt="x"');
    });

    it("drops obfuscated-case JaVaScRiPt: image src", () => {
      const html = renderMarkdown("![x](JaVaScRiPt:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with a leading tab", () => {
      const html = renderMarkdown("![x](\tjavascript:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with leading whitespace", () => {
      const html = renderMarkdown("![x]( javascript:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops javascript: image src obfuscated with an embedded tab in the scheme", () => {
      const html = renderMarkdown("![x](java\tscript:alert(1))");
      assertNoDangerousSrc(html);
    });

    it("drops vbscript: image src", () => {
      const html = renderMarkdown("![x](vbscript:msgbox(1))");
      assertNoDangerousSrc(html);
    });

    it("drops data: image src (including an SVG payload carrying an onload handler)", () => {
      const html = renderMarkdown(
        "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+)",
      );
      assertNoDangerousSrc(html);
    });

    it("drops data:text/html image src", () => {
      const html = renderMarkdown(
        "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      );
      assertNoDangerousSrc(html);
    });

    it("keeps a safe https image src intact", () => {
      const html = renderMarkdown("![alt text](https://example.com/pic.png)");
      expect(html).toContain('src="https://example.com/pic.png"');
      expect(html).toContain('alt="alt text"');
    });
  });
});
