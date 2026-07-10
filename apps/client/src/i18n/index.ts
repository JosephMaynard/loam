/**
 * Tiny hand-rolled i18n runtime — no library (offline + tiny-bundle constraints). The admin selects
 * one locale for the whole node (`node.locale`); the client sets it once via `setActiveLocale` and
 * every `t()` call reads a module-level active locale. `en` is the guaranteed fallback: an unknown
 * key or locale, or a locale missing a key, resolves to English, so nothing renders blank.
 */
import { LocaleSchema, type Locale } from "@loam/schema";

import type { PluralMessage } from "./en";
import { ar } from "./ar";
import { bn } from "./bn";
import { en, type Catalog, type CatalogKey } from "./en";
import { es } from "./es";
import { fa } from "./fa";
import { fr } from "./fr";
import { my } from "./my";
import { prs } from "./prs";
import { ps } from "./ps";
import { pt } from "./pt";
import { ru } from "./ru";
import { sw } from "./sw";
import { tr } from "./tr";
import { uk } from "./uk";
import { ur } from "./ur";

/** All shipped catalogs, keyed by locale. Every value is a full `Catalog` (enforced at compile time). */
export const CATALOGS: Record<Locale, Catalog> = {
  en,
  es,
  fr,
  ar,
  fa,
  pt,
  uk,
  ru,
  tr,
  my,
  ur,
  prs,
  ps,
  sw,
  bn,
};

/** Locales whose script is right-to-left; the document direction flips for these. */
export const RTL_LOCALES = new Set<Locale>(["ar", "fa", "ur", "prs", "ps"]);

/** Endonyms (each language in its own name), shown in the admin language picker regardless of the
 * currently active UI language, so any operator recognises their own tongue. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  ar: "العربية",
  fa: "فارسی",
  pt: "Português",
  uk: "Українська",
  ru: "Русский",
  tr: "Türkçe",
  my: "မြန်မာ",
  ur: "اردو",
  prs: "دری",
  ps: "پښتو",
  sw: "Kiswahili",
  bn: "বাংলা",
};

/**
 * A few enum tags aren't CLDR locales `Intl` resolves natively — notably Dari (`prs`). Map those to
 * a locale `Intl.PluralRules`/`Intl.DateTimeFormat` understand. `document.documentElement.lang`
 * still receives the raw enum tag (all are valid BCP-47).
 */
const ICU_LOCALE: Partial<Record<Locale, string>> = { prs: "fa-AF" };

/** The locale to hand to `Intl` APIs for a given catalog locale. */
export function icuLocale(locale: Locale): string {
  return ICU_LOCALE[locale] ?? locale;
}

let activeLocale: Locale = "en";
let pluralRules = new Intl.PluralRules(icuLocale("en"));

/** Set the node-wide UI locale. Called from `LoamApp` before children render (no stale-language flash). */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
  pluralRules = new Intl.PluralRules(icuLocale(locale));
}

/** The currently active UI locale. */
export function getActiveLocale(): Locale {
  return activeLocale;
}

/** Validate an untrusted locale value (e.g. from config), falling back to `en`. */
export function resolveLocale(value: string | undefined): Locale {
  const parsed = LocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : "en";
}

/**
 * Translate a catalog key into the active locale, interpolating `{token}` params. When the key maps
 * to a plural object, pass a numeric `n` param — the CLDR category is selected via `Intl.PluralRules`
 * (falling back to `other`). Missing keys/values fall back to English.
 */
export function t(key: CatalogKey, params?: Record<string, string | number>): string {
  // Cast to the value union so the plural branch stays live even when the catalog currently holds
  // only string-valued keys (otherwise TS narrows `entry` to `string` and the else-branch to `never`).
  const entry = (CATALOGS[activeLocale][key] ?? en[key]) as string | PluralMessage;
  let template: string;

  if (typeof entry === "string") {
    template = entry;
  } else {
    const n = typeof params?.n === "number" ? params.n : 0;
    template = entry[pluralRules.select(n)] ?? entry.other;
  }

  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_match, token: string) =>
    token in params ? String(params[token]) : `{${token}}`,
  );
}

/**
 * Localize a server error response `{ error?, code? }`. When the payload carries a known `code`, the
 * matching `error.<code>` catalog entry is returned in the active locale; otherwise the server's
 * English `error` string is used (forward-compatible with a mixed-version mesh where a peer may send
 * a code this client doesn't ship yet), falling back to `fallback` when there is no `error` field.
 */
export function errorText(payload: unknown, fallback = ""): string {
  const record = payload && typeof payload === "object" ? (payload as { error?: unknown; code?: unknown }) : {};
  const error = typeof record.error === "string" ? record.error : fallback;
  const code = typeof record.code === "string" ? record.code : undefined;

  if (code) {
    const key = `error.${code}` as CatalogKey;
    if (key in en) {
      return t(key);
    }
  }

  return error;
}
