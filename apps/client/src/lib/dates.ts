/**
 * Day bucketing for message-history separators. Timestamps are grouped by *local* calendar day,
 * so the divider matches what the person reading would call "today".
 */
import { getActiveLocale, icuLocale } from "../i18n";

/** The BCP-47 locale to hand `Intl`, matching the admin-selected node UI language (not the browser),
 * so dates read in the same language as the rest of the chrome. */
function intlLocale(): string {
  return icuLocale(getActiveLocale());
}

/**
 * Per-locale caches for the divider formatters. `dayLabel` runs for every day separator in the
 * history and both `Intl` constructors are comparatively expensive, so each formatter is built once
 * per locale and reused. The absolute-date formatter is additionally keyed on whether the year is
 * shown, since that toggles a formatter option.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** The cached "Today"/"Yesterday" relative formatter for a locale, built on first use. */
function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = relativeFormatters.get(locale);

  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormatters.set(locale, formatter);
  }

  return formatter;
}

/** The cached absolute-day formatter for a locale, with the year shown only when `withYear`. */
function dateFormatter(locale: string, withYear: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${withYear ? "y" : ""}`;
  let formatter = dateFormatters.get(key);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });
    dateFormatters.set(key, formatter);
  }

  return formatter;
}

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

  // "Today"/"Yesterday" via Intl.RelativeTimeFormat, in the node's UI language so the divider matches
  // the rest of the localized chrome (not the viewer's browser language).
  const locale = intlLocale();
  const relative = relativeFormatter(locale);

  if (key === dayKey(now)) {
    return capitalize(relative.format(0, "day"), locale);
  }

  // "Yesterday" via a calendar-day step (setDate handles month/DST boundaries) rather than
  // subtracting a fixed 24h, which would misfire near local midnight on 23h/25h DST days.
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) {
    return capitalize(relative.format(-1, "day"), locale);
  }

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return dateFormatter(locale, !sameYear).format(date);
}

/** Uppercase the first character, so a divider reads "Today" not "today" at the start of a row.
 * The locale drives casing rules (e.g. Turkish dotted/dotless I) so it matches the active UI language. */
function capitalize(value: string, locale: string): string {
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
}
