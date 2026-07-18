/**
 * A crisp, centered left-arrow glyph for `.mobile-back` controls (and any equivalent back
 * button). Renders as inline SVG rather than the `←` text character — glyph metrics for `←` vary
 * across fonts/weights and sit off-center inside the 36×36 button; a fixed-viewBox SVG using
 * `currentColor` always centers cleanly and matches the button's text color. Decorative only — the
 * enclosing `<a>`/`<button>` already carries the accessible label/route, so this is `aria-hidden`.
 */
export function BackArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width="20"
    >
      <path d="M20 12H5" />
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
