import { t } from "../i18n";
import { IconBack } from "./icons";
import { NavLink } from "./NavLink";

/**
 * The icon-only "back to the list" link the phone layout shows at the start of every screen header
 * (hidden by CSS from tablet width up, where the sidebar is always on screen). The chevron is decorative,
 * so the link carries its own translated accessible name — without it a screen reader announced an
 * unlabeled link.
 */
export function MobileBackLink({ href = "/channels" }: { href?: string }) {
  return (
    <NavLink active={false} ariaLabel={t("common.back")} className="mobile-back" href={href}>
      <IconBack />
    </NavLink>
  );
}
