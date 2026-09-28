import type { ComponentChildren } from "preact";

/**
 * LOAM's one icon set: small inline SVGs on a 24×24 viewBox, 2px round strokes in `currentColor`, so an
 * icon always takes its button's text colour and centres exactly (a text glyph like `←` or `×` sits
 * off-centre and changes shape with the font). No icon font, no sprite: each icon is a few hundred bytes
 * and tree-shakes away when unused.
 *
 * Every icon is decorative (`aria-hidden`); the enclosing button or link carries the accessible name.
 * Directional icons (back, chevron-right, send, reply) carry `icon-flip-rtl`, which mirrors them in
 * right-to-left layouts (see components.css).
 */

export interface IconProps {
  /** Rendered width/height in px (default 20). */
  size?: number;
  className?: string;
}

/** The shared SVG wrapper every icon renders through. */
function Svg({
  children,
  className,
  flipRtl = false,
  size = 20,
}: IconProps & { children: ComponentChildren; flipRtl?: boolean }) {
  const classes = ["icon", flipRtl ? "icon-flip-rtl" : undefined, className].filter(Boolean).join(" ");
  return (
    <svg
      aria-hidden="true"
      class={classes}
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

/** Back (chevron pointing to the inline start). */
export function IconBack(props: IconProps) {
  return (
    <Svg {...props} flipRtl>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  );
}

/** Close / dismiss (×). */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </Svg>
  );
}

/** Send (paper plane). */
export function IconSend(props: IconProps) {
  return (
    <Svg {...props} flipRtl>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </Svg>
  );
}

/** Attach (paperclip). */
export function IconAttach(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Svg>
  );
}

/** More actions (vertical kebab). */
export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Svg>
  );
}

/** Reply (curved arrow back). */
export function IconReply(props: IconProps) {
  return (
    <Svg {...props} flipRtl>
      <path d="M9 17l-5-5 5-5" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </Svg>
  );
}

/** React (smiley). */
export function IconSmile(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01" />
      <path d="M15 9h.01" />
    </Svg>
  );
}

/** Edit (pencil). */
export function IconEdit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </Svg>
  );
}

/** Delete (trash can). */
export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Svg>
  );
}

/** Report (flag). */
export function IconFlag(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" />
    </Svg>
  );
}

/** Search (magnifier). */
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  );
}

/** Settings (gear). */
export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

/** Public channel (hash). */
export function IconHash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3L8 21" />
      <path d="M16 3l-2 18" />
    </Svg>
  );
}

/** Private channel (padlock). */
export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="11" rx="2" width="16" x="4" y="11" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}

/** People (two heads). */
export function IconUsers(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

/** Done / selected (tick). */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  );
}

/** Add (plus). */
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

/** Go forward / disclosure (chevron pointing to the inline end). */
export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props} flipRtl>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  );
}

/** Share the network (Wi-Fi waves) — the invite / hotspot entry. */
export function IconWifi(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <path d="M12 20h.01" />
    </Svg>
  );
}

/** Mesh mail (envelope). */
export function IconMail(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="16" rx="2" width="20" x="2" y="4" />
      <path d="M22 6l-10 7L2 6" />
    </Svg>
  );
}

/** Admin (shield). */
export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  );
}

/** Share location (map pin). */
export function IconMapPin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </Svg>
  );
}

/** Copy (two overlapping sheets). */
export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect height="13" rx="2" width="13" x="9" y="9" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

/** Arrow pointing down (the "new messages" pill). */
export function IconArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </Svg>
  );
}
