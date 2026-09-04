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
 * Create a new user identifier for an anonymous session.
 *
 * @returns A string of the form `user.<8hex>` where the suffix is the first 8 hexadecimal characters of a UUID with dashes removed.
 */
export function makeSessionUserId(): string {
  return `user.${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

export function makeSessionToken(): string {
  return randomUUID();
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

export function makeAdminSetupCode(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

export function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

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
