import type { ComponentChildren } from "preact";

import { t } from "../i18n";
import { IconBack } from "./icons";
import { Menu, type MenuItem } from "./Menu";
import { MobileBackLink } from "./MobileBackLink";

export interface ScreenHeaderProps {
  /** The screen's title. One line; it ellipsizes rather than wrapping or being pushed out by actions. */
  title: ComponentChildren;
  /** A quieter second line (channel topic, "online", a count…). One line, ellipsized. */
  subtitle?: ComponentChildren;
  /**
   * Where the phone-layout back control goes: a route (default `/channels`, the Home list), or `false` for
   * no back control. Hidden from tablet width up by CSS, where the sidebar is always visible.
   */
  backHref?: string | false;
  /** Use a button instead of a link for "back" (e.g. closing the thread panel). Overrides `backHref`. */
  onBack?: () => void;
  /** Keep the back control visible at every width (e.g. a full-screen thread on a tablet). */
  alwaysShowBack?: boolean;
  /** A node before the title: an avatar (`size="sm"`/`"md"`) or a channel glyph. */
  leading?: ComponentChildren;
  /** Trailing icon buttons (`.btn.btn-icon.btn-ghost`). Keep it to one or two; put the rest in `menuItems`. */
  actions?: ComponentChildren;
  /** Overflow actions, shown behind a kebab `Menu` at the trailing edge. */
  menuItems?: MenuItem[];
  /** Accessible name for the overflow menu trigger (required with `menuItems`). */
  menuLabel?: string;
  /** Heading level of the title (default 1; the thread panel beside a conversation uses 2). */
  headingLevel?: 1 | 2;
  /** Id for the title element (e.g. for `aria-labelledby` on the screen's section). */
  titleId?: string;
  className?: string;
}

/**
 * The 56px bar at the top of every screen: [back] [leading] title/subtitle … [actions] [⋮].
 *
 * The title block is the only flexible column (`min-width: 0`, ellipsis), and actions never shrink, so a
 * long name can't push the buttons off screen and the buttons can't squeeze the title to nothing — the
 * "title truncated by two ghost buttons" problem. Secondary actions belong in `menuItems`.
 */
export function ScreenHeader({
  actions,
  alwaysShowBack = false,
  backHref = "/channels",
  className,
  headingLevel = 1,
  leading,
  menuItems,
  menuLabel,
  onBack,
  subtitle,
  title,
  titleId,
}: ScreenHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const classes = ["screen-header", alwaysShowBack ? "show-back" : undefined, className].filter(Boolean).join(" ");

  return (
    <header className={classes}>
      {onBack ? (
        <button aria-label={t("common.back")} className="mobile-back" onClick={onBack} type="button">
          <IconBack />
        </button>
      ) : backHref !== false ? (
        <MobileBackLink href={backHref} />
      ) : null}
      {leading ? <div className="screen-header-leading">{leading}</div> : null}
      <div className="screen-header-text">
        <Heading className="screen-title" id={titleId}>
          {title}
        </Heading>
        {subtitle ? <p className="screen-subtitle">{subtitle}</p> : null}
      </div>
      {actions || menuItems?.length ? (
        <div className="screen-header-actions">
          {actions}
          {menuItems?.length ? <Menu items={menuItems} label={menuLabel ?? ""} /> : null}
        </div>
      ) : null}
    </header>
  );
}
