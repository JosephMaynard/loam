import { LocaleSchema, type Locale } from "@loam/schema";
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

  it("every server error code has a matching error.<code> catalog key", () => {
    // Snapshot of apps/server/src/app.ts ERROR_CODES values. The server exports ALL_ERROR_CODES for
    // cross-checking; keep this list in sync. A code missing here means that server error would fall
    // back to English on every locale instead of localizing.
    const SERVER_ERROR_CODES = [
      "admin_required", "admin_claim_disabled", "admin_user_edit_disabled", "promote_requires_active",
      "attachment_not_found", "attachment_too_large", "attachment_type_mismatch", "attachments_disabled",
      "avatar_not_found", "avatar_too_large", "avatar_type_mismatch", "roles_admin_immutable",
      "reaction_not_allowed", "channel_not_found", "channel_posting_disabled", "channel_create_disabled",
      "confirmation_required", "dms_disabled", "sync_requires_peer", "greeter_required", "invalid_admin_claim",
      "invalid_admin_secret", "invalid_attachment_upload", "invalid_avatar_upload", "invalid_channel_create",
      "invalid_channel_update", "invalid_config_update", "invalid_config_values", "invalid_kill_switch",
      "invalid_member_request", "invalid_message_edit", "invalid_message_request", "invalid_moderation_request",
      "invalid_request", "invalid_roles_update", "invalid_sync_request", "invalid_token", "invalid_user_update",
      "message_not_found", "moderator_required", "not_found", "deny_requires_pending", "admin_humans_only",
      "member_list_private_only", "channel_change_forbidden", "member_invite_forbidden", "member_remove_forbidden",
      "parent_wrong_channel", "parent_not_found", "private_channels_disabled", "search_query_required",
      "reactions_disabled", "reaction_not_editable", "recipient_not_found", "replies_disabled", "target_not_found",
      "user_removed", "not_channel_member", "owner_not_removable", "kill_switch_disabled", "passphrase_required",
      "message_streaming", "session_invalid", "thread_has_replies", "too_many_attempts", "too_many_claim_attempts",
      "message_create_failed", "websocket_unauthenticated", "unknown_attachment", "user_avatar_upload_disabled",
      "user_not_found", "user_profile_edit_disabled", "delete_own_only", "edit_own_only", "deny_forbidden",
      "moderate_forbidden", "removed_from_node", "awaiting_approval", "channel_archived",
      "channel_replies_disabled", "channel_owner_post_only", "channel_admins_post_only",
      "channel_transfer_forbidden",
    ];

    for (const code of SERVER_ERROR_CODES) {
      expect(`error.${code}` in en, `en catalog has error.${code}`).toBe(true);
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
