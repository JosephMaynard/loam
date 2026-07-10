/**
 * Day bucketing for message-history separators. Timestamps are grouped by *local* calendar day,
 * so the divider matches what the person reading would call "today".
 */

/** A stable key identifying the local calendar day of a timestamp (e.g. "2026-7-6"). */
export function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * A human label for a timestamp's local day: "Today", "Yesterday", or a locale-formatted date
 * (weekday + day + month, with the year only when it differs from the current one).
 *
 * @param timestamp - Milliseconds since the UNIX epoch.
 * @param now - The reference "current time" (injectable for tests; defaults to Date.now()).
 */
export function dayLabel(timestamp: number, now = Date.now()): string {
  const key = dayKey(timestamp);

  // "Today"/"Yesterday" via Intl.RelativeTimeFormat so they localize with the browser rather than
  // hardcoding English — the rest of the app leans on Intl for the same reason.
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (key === dayKey(now)) {
    return capitalize(relative.format(0, "day"));
  }

  if (key === dayKey(now - 24 * 60 * 60 * 1000)) {
    return capitalize(relative.format(-1, "day"));
  }

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

/** Uppercase the first character, so a divider reads "Today" not "today" at the start of a row. */
function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}
