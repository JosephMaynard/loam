/**
 * Small unread-count pill shown at the trailing edge of a channel/DM nav link. Renders nothing when
 * there is nothing unread; caps the label at 99+.
 */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }

  return (
    <span aria-label={`${count} unread`} className="unread-badge">
      {count > 99 ? "99+" : count}
    </span>
  );
}
