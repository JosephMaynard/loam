import { t } from "../i18n";

/**
 * Small unread-count pill shown at the trailing edge of a channel/DM nav link. Renders nothing when
 * there is nothing unread; caps the label at 99+. `dot` marks something new whose count isn't known yet
 * (a DM the inbox reports but this device hasn't loaded) as a plain dot.
 */
export function UnreadBadge({ count, dot = false }: { count: number; dot?: boolean }) {
  if (count <= 0) {
    return dot ? <span aria-label={t("unreadBadge.new")} className="unread-badge unread-dot" role="img" /> : null;
  }

  return (
    <span aria-label={t("unreadBadge.label", { n: count })} className="unread-badge">
      {count > 99 ? "99+" : count}
    </span>
  );
}
