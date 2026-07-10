/**
 * Tiny hand-rolled i18n runtime — no library (offline + tiny-bundle constraints). The admin selects
 * one locale for the whole node (`node.locale`); the client sets it once via `setActiveLocale` and
 * every `t()` call reads a module-level active locale. `en` is the guaranteed fallback: an unknown
 * key or locale, or a locale missing a key, resolves to English, so nothing renders blank.
 */
import { LocaleSchema, type Locale } from "@loam/schema";

import { en, type Catalog, type CatalogKey, type PluralMessage } from "./en";

/**
 * Lazy catalog loaders. Only `en` is bundled statically (the guaranteed fallback + the `Catalog`
 * type); every other language is a **dynamic import** so Vite code-splits it into its own chunk and
 * a joiner only ever downloads the one language the node actually uses. Keeping all 15 languages
 * therefore costs the base bundle almost nothing. Each catalog file exports a const named for its
 * locale (`export const es = …`), so the loader picks that named export off the module.
 */
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<Catalog>> = {
  es: () => import("./es").then((m) => m.es),
  fr: () => import("./fr").then((m) => m.fr),
  ar: () => import("./ar").then((m) => m.ar),
  fa: () => import("./fa").then((m) => m.fa),
  pt: () => import("./pt").then((m) => m.pt),
  uk: () => import("./uk").then((m) => m.uk),
  ru: () => import("./ru").then((m) => m.ru),
  tr: () => import("./tr").then((m) => m.tr),
  my: () => import("./my").then((m) => m.my),
  ur: () => import("./ur").then((m) => m.ur),
  prs: () => import("./prs").then((m) => m.prs),
  ps: () => import("./ps").then((m) => m.ps),
  sw: () => import("./sw").then((m) => m.sw),
  bn: () => import("./bn").then((m) => m.bn),
};

/** Catalogs resolved so far. `en` is always present; others populate as `loadLocale` completes. */
const loaded: Partial<Record<Locale, Catalog>> = { en };

/**
 * Fetch (once) the catalog for a locale, so `t()` can render it. `en` and already-loaded locales
 * resolve immediately. Until this resolves, `t()` returns English for that locale — the caller
 * re-renders on completion (see `LoamApp`). Errors are swallowed: a failed chunk load just leaves
 * the UI in English rather than crashing.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (loaded[locale]) {
    return;
  }

  const loader = LOADERS[locale as Exclude<Locale, "en">];

  if (!loader) {
    return;
  }

  try {
    loaded[locale] = await loader();
  } catch {
    // Chunk fetch failed (offline / eviction) — stay on the English fallback.
  }
}

/** Whether a locale's catalog is loaded and ready for synchronous `t()` rendering. */
export function isLocaleLoaded(locale: Locale): boolean {
  return !!loaded[locale];
}

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
  // The active catalog if it has loaded, else English (loads are async; the app re-renders on
  // completion). Cast to the value union so the plural branch stays live even when the catalog
  // currently holds only string-valued keys (otherwise TS narrows to `string` and the else to `never`).
  const catalog = loaded[activeLocale] ?? en;
  const entry = (catalog[key] ?? en[key]) as string | PluralMessage;
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
