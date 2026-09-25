// Anonymous identity + session-token primitives and cookie helpers. Extracted from app.ts
// (2026-09-04 split).
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { generateDisplayName } from "@loam/display-name";
import { UserSchema, type OllamaConfig, type User } from "@loam/schema";

/**
 * Create a human user record with a generated display name and creation timestamp.
 *
 * @param id - The unique user identifier
 * @param isAdmin - Whether the user has administrative privileges
 * @param pending - Whether the user is awaiting approval (approval join policy); omitted when false
 * @returns A validated `User` object constructed from the provided values
 */
export function makeUser(id: string, isAdmin = false, pending = false): User {
  return UserSchema.parse({
    id,
    displayName: generateDisplayName(id),
    type: "human",
    isAdmin,
    createdAt: Date.now(),
    ephemeral: false,
    ...(pending ? { pending: true } : {}),
  });
}

/**
 * Create a User record representing the configured Ollama bot.
 *
 * @param config - Ollama integration config containing the bot identifiers and display name
 * @returns A `User` object for the bot with `type: "bot"`, `isAdmin: false`, a patterned avatar seeded from the bot ID, and the current timestamp as `createdAt`
 */
export function makeBotUser(config: OllamaConfig): User {
  return UserSchema.parse({
    id: config.botId,
    displayName: config.botDisplayName,
    avatar: {
      seed: config.botId,
      mode: "pattern",
    },
    type: "bot",
    isAdmin: false,
    createdAt: Date.now(),
    ephemeral: false,
  });
}

/**
 * Create a new user identifier for an anonymous session: `user.<16 hex>` (64 random bits). The old
 * 8-hex (32-bit) form made a birthday collision plausible on a busy long-lived node, and a colliding
 * mint silently inherited the existing user's record (ensureUser returns what it finds). Ids minted
 * earlier keep working — nothing parses the suffix.
 *
 * @param isTaken - Optional predicate; when given, minting retries until it returns false, so a new
 *   identity can never alias an existing user or session (callers pass their user/session lookups)
 * @returns A fresh `user.<16hex>` id
 */
export function makeSessionUserId(isTaken?: (id: string) => boolean): string {
  for (;;) {
    const id = `user.${randomBytes(8).toString("hex")}`;

    if (!isTaken?.(id)) {
      return id;
    }
  }
}

/** A fresh session-cookie bearer token (256 random bits, base64url). */
export function makeSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A fresh 256-bit secure identity token (docs/20) — high-entropy, so a fast hash (not scrypt) is the
 * right at-rest protection. */
export function makeIdentityToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of an identity token, base64url — what's stored/looked-up, never the bearer value. */
export function hashIdentityToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** A fresh one-time admin setup code for the `setupCode` bootstrap. */
export function makeAdminSetupCode(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/** Percent-encode a cookie value so it survives `Set-Cookie` framing. */
export function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

/** Read one named cookie's decoded value from a `Cookie` header, or undefined. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const [rawName, ...rawValue] = cookie.trim().split("=");

    if (rawName !== name) {
      continue;
    }

    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return undefined;
    }
  }

  return undefined;
}
