/**
 * Localized, i18n-runtime-dependent formatting for a single message: its time label and its display
 * body (with the streaming placeholder). Split out of `app.tsx` so message components can render
 * without reaching back into the app module.
 */
import type { Message } from "@loam/schema";

import { getActiveLocale, icuLocale, t } from "../i18n";

/**
 * Per-locale cache of the hours-and-minutes time formatter. Building an `Intl.DateTimeFormat` is
 * comparatively expensive and `displayTime` is called once per rendered message row (hundreds of
 * times per render, many times a second while an LLM reply streams), so the formatter is built once
 * per active locale and reused. Keyed on the resolved ICU locale string.
 */
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Format a numeric timestamp into a localized hours-and-minutes time string.
 *
 * @param timestamp - Milliseconds since the UNIX epoch
 * @returns The time formatted as hours and minutes according to the current locale (e.g., "09:05")
 */
export function displayTime(timestamp: number): string {
  // Node UI locale (via icuLocale), so times read in the same language as the rest of the chrome.
  const locale = icuLocale(getActiveLocale());
  let formatter = timeFormatters.get(locale);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
    timeFormatters.set(locale, formatter);
  }

  return formatter.format(timestamp);
}

/**
 * Get the display text for a message, substituting a streaming placeholder when appropriate.
 *
 * @param message - The message to extract text from; may be any Message variant.
 * @returns The message `body` if present and non-empty, the localized "thinking" placeholder when `body` is empty and `message.meta?.streaming` is true, or an empty string when no body is available.
 */
export function bodyFor(message: Message): string {
  if (!("body" in message)) {
    return "";
  }

  return message.body || (message.meta?.streaming ? t("composer.thinking") : "");
}
