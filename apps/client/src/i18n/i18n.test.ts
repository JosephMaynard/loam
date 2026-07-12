import { LocaleSchema, SERVER_ERROR_CODES, type Locale } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { ar } from "./ar";
import { bn } from "./bn";
import { en, type Catalog, type PluralMessage } from "./en";
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
import { errorText, icuLocale, loadLocale, resolveLocale, setActiveLocale, t } from "./index";

// The shipped bundle lazy-loads catalogs (only `en` is static); the completeness tests need them all
// synchronously, so the *test* imports every catalog directly (the test bundle isn't shipped).
const ALL_CATALOGS: Record<Locale, Catalog> = {
  en, es, fr, ar, fa, pt, uk, ru, tr, my, ur, prs, ps, sw, bn,
};

const LOCALES = LocaleSchema.options as readonly Locale[];
const EN_KEYS = Object.keys(en).sort();

/** Extract `{token}` placeholder names from a template string. */
function tokensOf(template: string): Set<string> {
  return new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
}

/** True when an en value is a plural object rather than a plain string. */
function isPlural(value: unknown): value is PluralMessage {
  return typeof value === "object" && value !== null;
}

describe("i18n catalogs", () => {
  it("every locale has exactly en's key set (completeness)", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(ALL_CATALOGS[locale]).sort(), `locale ${locale}`).toEqual(EN_KEYS);
    }
  });

  it("plural values cover exactly the CLDR categories for their locale", () => {
    const pluralKeys = EN_KEYS.filter((key) => isPlural((en as Record<string, unknown>)[key]));
    expect(pluralKeys.length).toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const categories = new Intl.PluralRules(icuLocale(locale)).resolvedOptions().pluralCategories.slice().sort();

      for (const key of pluralKeys) {
        const value = (ALL_CATALOGS[locale] as Record<string, unknown>)[key];
        expect(isPlural(value), `${locale} ${key} is a plural object`).toBe(true);
        const plural = value as PluralMessage;
        expect(Object.keys(plural).sort(), `${locale} ${key} categories`).toEqual(categories);
        expect(typeof plural.other, `${locale} ${key} has a string 'other'`).toBe("string");
      }
    }
  });

  it("plain-string keys preserve exactly en's token set (no dropped or stray tokens)", () => {
    // For non-plural keys the translation must carry the same {tokens} as en — a subset check alone
    // would miss a translator dropping a required token (rendering a value silently blank). Plural
    // forms are exempt: some CLDR categories legitimately omit {n} (e.g. Arabic zero/one/two).
    const plainKeys = EN_KEYS.filter((key) => !isPlural((en as Record<string, unknown>)[key]));

    for (const locale of LOCALES) {
      for (const key of plainKeys) {
        const enSet = [...tokensOf(en[key as keyof typeof en] as string)].sort();
        const value = (ALL_CATALOGS[locale] as Record<string, string>)[key];
        expect([...tokensOf(value)].sort(), `${locale} ${key} token set`).toEqual(enSet);
      }
    }
  });

  it("placeholder tokens per key are a subset of en's tokens", () => {
    const enTokens = (key: string): Set<string> => {
      const value = (en as Record<string, unknown>)[key];
      if (typeof value === "string") {
        return tokensOf(value);
      }
      const set = new Set<string>();
      for (const form of Object.values(value as PluralMessage)) {
        for (const token of tokensOf(form)) {
          set.add(token);
        }
      }
      return set;
    };

    for (const locale of LOCALES) {
      for (const key of EN_KEYS) {
        const allowed = enTokens(key);
        const value = (ALL_CATALOGS[locale] as Record<string, unknown>)[key];
        const forms = typeof value === "string" ? [value] : Object.values(value as PluralMessage);
        for (const form of forms) {
          for (const token of tokensOf(form)) {
            expect(allowed.has(token), `${locale} ${key} uses stray token {${token}}`).toBe(true);
          }
        }
      }
    }
  });

  it("every catalog covers exactly the canonical SERVER_ERROR_CODES (@loam/schema) — no dropped or stray codes", () => {
    // SERVER_ERROR_CODES is the single source of truth (also relied on by the server: its
    // ERROR_CODES map is typed against it, so a new code can't be introduced there without also
    // appearing here). A code missing an `error.<code>` key would fall back to English on every
    // locale instead of localizing; a stray `error.*` key with no matching code is dead weight
    // that can mask a rename. Checking both directions catches either drift.
    const expectedKeys = SERVER_ERROR_CODES.map((code) => `error.${code}`).sort();

    for (const locale of LOCALES) {
      const catalog = ALL_CATALOGS[locale] as Record<string, unknown>;
      const actualErrorKeys = Object.keys(catalog)
        .filter((key) => key.startsWith("error."))
        .sort();
      expect(actualErrorKeys, `locale ${locale} error.* keys`).toEqual(expectedKeys);
    }
  });
});

describe("t()", () => {
  it("interpolates positional tokens", () => {
    setActiveLocale("en");
    expect(t("conversation.composerLabel", { name: "general" })).toBe("Message general");
  });

  it("selects the right plural form per locale", async () => {
    await loadLocale("ar");
    setActiveLocale("ar"); // Arabic: 3 → 'few'
    expect(t("message.replyCount", { n: 3 })).toContain("3");
    await loadLocale("ru");
    setActiveLocale("ru"); // Russian: 2 → 'few'
    expect(t("message.replyCount", { n: 2 })).toContain("2");
    await loadLocale("my");
    setActiveLocale("my"); // Burmese: only 'other'
    expect(t("message.replyCount", { n: 5 })).toContain("5");
    setActiveLocale("en");
  });

  it("falls back to en for an unknown locale value", () => {
    expect(resolveLocale("xx")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("ar")).toBe("ar");
  });
});

describe("errorText()", () => {
  it("localizes a known code and falls back to the server message for unknown codes", async () => {
    await loadLocale("es");
    setActiveLocale("es");
    expect(errorText({ error: "Channel does not exist", code: "channel_not_found" })).toBe(
      ALL_CATALOGS.es["error.channel_not_found"],
    );
    // Unknown code (e.g. a newer peer) → the server's English string.
    expect(errorText({ error: "Something new", code: "brand_new_code" })).toBe("Something new");
    // No code → the server's error string; no payload → the fallback.
    expect(errorText({ error: "Plain error" })).toBe("Plain error");
    expect(errorText(undefined, "fallback")).toBe("fallback");
    setActiveLocale("en");
  });
});
