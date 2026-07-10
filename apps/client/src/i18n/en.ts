/**
 * English UI strings — the source of truth for every LOAM catalog.
 *
 * Every other locale file is typed `Catalog`, so a missing key is a **compile error** (and a
 * completeness test guards against extra/stale keys). Keys are flat and dotted, namespaced by view
 * (`composer.*`, `settings.*`, `admin.*`, `error.*`, …). A value is either a plain string or a
 * plural object keyed by CLDR category — the right form is chosen at render time via
 * `Intl.PluralRules` (see `t()` in `./index.ts`). Positional tokens are written `{token}` and filled
 * from the `params` passed to `t()`.
 */

/** CLDR plural categories. A language supplies only the subset it uses; `other` is always required. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessage = Partial<Record<PluralCategory, string>> & { other: string };

export const en = {
  // Streaming assistant placeholder shown while a reply is still generating.
  "composer.thinking": "Thinking…",
  // Fallback body used in notification toasts for an image-only message.
  "toast.imageFallback": "📷 Image",
};

/**
 * The shape every locale catalog must satisfy: exactly `en`'s keys, with plain strings kept as
 * `string` (any translation) and plural values relaxed to `PluralMessage` (each language brings its
 * own set of CLDR categories). Derived from `en` so `en` stays the single source of truth.
 */
export type Catalog = {
  [K in keyof typeof en]: (typeof en)[K] extends string ? string : PluralMessage;
};
export type CatalogKey = keyof Catalog;
