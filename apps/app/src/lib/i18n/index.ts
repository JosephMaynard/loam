/**
 * The Android host's own interface language: one active locale, `t()` with `{token}` substitution, and an
 * observable store so screens re-render when the choice changes. English is the fallback for a missing
 * key or locale. Pure (no React, no storage): `src/hooks/use-app-locale.ts` persists the choice and wires
 * it to React. The same 15 languages as the web client.
 */
import { en, type AppCatalog, type AppCatalogKey } from './en';

export type { AppCatalogKey } from './en';

/**
 * Every language the app offers: the web client's `LocaleSchema` list, written out here because the app
 * must not import `@loam/schema` (its zod graph breaks Metro's release bundle; see index.tsx). A test
 * checks the two lists stay identical.
 */
export const APP_LOCALES = ['en', 'es', 'fr', 'ar', 'fa', 'pt', 'uk', 'ru', 'tr', 'my', 'ur', 'prs', 'ps', 'sw', 'bn'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

/** Languages written right to left. */
export const RTL_LOCALES: ReadonlySet<AppLocale> = new Set<AppLocale>(['ar', 'fa', 'ur', 'prs', 'ps']);

/** Each language's own name for itself, for the language picker. */
export const LOCALE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  ar: 'العربية',
  fa: 'فارسی',
  pt: 'Português',
  uk: 'Українська',
  ru: 'Русский',
  tr: 'Türkçe',
  my: 'မြန်မာ',
  ur: 'اردو',
  prs: 'دری',
  ps: 'پښتو',
  sw: 'Kiswahili',
  bn: 'বাংলা',
};

const catalogs: Partial<Record<AppLocale, Partial<AppCatalog>>> = { en };

/** Register a language's strings (the catalogs module does this for every shipped language). */
export function registerCatalog(locale: AppLocale, catalog: Partial<AppCatalog>): void {
  catalogs[locale] = catalog;
}

let active: AppLocale = 'en';
const listeners = new Set<() => void>();

/** Parse a stored value; anything unknown means English. */
export function parseAppLocale(value: unknown): AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value) ? (value as AppLocale) : 'en';
}

export function getAppLocale(): AppLocale {
  return active;
}

/** Switch language now; every subscriber re-renders. */
export function setAppLocale(locale: AppLocale): void {
  if (locale === active) {
    return;
  }
  active = locale;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAppLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Bidi controls for right-to-left text. Android lays a paragraph out in the direction of its first strong
// character, so an Arabic, Persian, Urdu, Dari or Pashto string that starts with "LOAM", a placeholder or a
// number would be laid out left to right, its clauses in the wrong order and aligned to the wrong side.
// RN's `writingDirection` style is iOS-only, so the direction travels in the text itself.
/** U+200F RIGHT-TO-LEFT MARK: a zero-width strong RTL character that fixes the paragraph direction. */
export const RLM = '‏';
/** U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE: lay a substituted value (a name, an English
 * error detail, a URL) out on its own, so its direction can't reorder the sentence around it. */
const FSI = '⁨';
const PDI = '⁩';

/** Whether `locale` is written right to left. */
export function isRtlLocale(locale: AppLocale): boolean {
  return RTL_LOCALES.has(locale);
}

/**
 * The text alignment a native Text should get in `locale` when its own style sets `textAlign` to
 * `current`. React Native on Android aligns `auto` text to the left whatever the paragraph direction, so in
 * a right-to-left language unaligned (or left-aligned) text is aligned right; an explicit `center` or
 * `right` is kept. Undefined means "leave the style alone".
 */
export function rtlTextAlign(locale: AppLocale, current: unknown): 'right' | undefined {
  return isRtlLocale(locale) && (current === undefined || current === 'auto' || current === 'left') ? 'right' : undefined;
}

/**
 * The string for `key` in the active language (English when missing), with `{name}` tokens filled in. In a
 * right-to-left language the result starts with an RLM and every substituted value is isolated, so the
 * paragraph reads right to left whatever it starts with, nested `t()` results and joined strings included.
 * An English fallback is left as it is.
 */
export function t(key: AppCatalogKey, vars?: Record<string, string | number>): string {
  const own = catalogs[active]?.[key];
  const rtl = own !== undefined && isRtlLocale(active);
  const template = own ?? en[key];
  const filled = vars
    ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? (rtl ? `${FSI}${String(vars[name])}${PDI}` : String(vars[name])) : match,
      )
    : template;
  return rtl ? `${RLM}${filled}` : filled;
}
