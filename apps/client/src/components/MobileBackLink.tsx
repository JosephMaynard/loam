import { t } from "../i18n";
import { BackArrowIcon } from "./BackArrowIcon";
import { NavLink } from "./NavLink";

/**
 * The icon-only "back to the list" link the mobile layout shows in every screen header. The arrow is
 * decorative (`aria-hidden`), so the link carries its own translated accessible name — without it a
 * screen reader announced an unlabeled link.
 */
export function MobileBackLink({ href = "/channels" }: { href?: string }) {
  return (
    <NavLink active={false} ariaLabel={t("common.back")} className="mobile-back" href={href}>
      <BackArrowIcon />
    </NavLink>
  );
}
