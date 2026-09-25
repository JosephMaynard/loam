import { describe, expect, it } from "vitest";
import {
  ChannelSchema,
  DbEncryptionModeSchema,
  IdSchema,
  LoamConfigSchema,
  LoamConfigUpdateSchema,
  MessageCreateRequestSchema,
  MessageEditRequestSchema,
  MessageLocationSchema,
  MessageSchema,
  ModerationUpdateRequestSchema,
  NetworkConfigSchema,
  SearchQuerySchema,
  securityProfilePreset,
  SecurityConfigSchema,
  SERVER_ERROR_CODES,
  StreamEventSchema,
  SyncAttachmentResponseSchema,
  TransportEncryptionSchema,
  UserAvatarSchema,
  UserSchema,
} from "./index.js";

describe("@loam/schema", () => {
  it("validates users", () => {
    expect(() =>
      UserSchema.parse({
        id: "usr_123",
        displayName: "Joseph",
        type: "human",
        isAdmin: false,
        createdAt: 1712850000,
        ephemeral: true,
      }),
    ).not.toThrow();
  });

  it("bounds stored strings so an oversized value can't be persisted or imported", () => {
    const baseUser = { id: "usr_123", type: "human" as const, isAdmin: false, createdAt: 1712850000, ephemeral: true };
    // displayName is capped at 80 (a hostile sync peer can't import a giant name).
    expect(() => UserSchema.parse({ ...baseUser, displayName: "x".repeat(81) })).toThrow();
    expect(() => UserSchema.parse({ ...baseUser, displayName: "x".repeat(80) })).not.toThrow();
    // Avatar palette/face/accessory are short keys, capped at 64 (no megabyte-avatar DoS via PATCH).
    expect(() =>
      UserSchema.parse({ ...baseUser, displayName: "ok", avatar: { face: "x".repeat(65) } }),
    ).toThrow();

    const baseChannel = {
      id: "chn_1",
      visibility: "public" as const,
      allowPosting: "everyone" as const,
      allowReplies: true,
      discoverable: true,
      createdAt: 1712850000,
    };
    expect(() => ChannelSchema.parse({ ...baseChannel, name: "x".repeat(81) })).toThrow();
    expect(() => ChannelSchema.parse({ ...baseChannel, name: "ok", description: "x".repeat(281) })).toThrow();
  });

  it("validates channels", () => {
    expect(() =>
      ChannelSchema.parse({
        id: "chn_usr_123",
        name: "Joseph's Channel",
        ownerUserId: "usr_123",
        visibility: "public",
        allowPosting: "owner",
        allowReplies: true,
        discoverable: true,
        createdAt: 1712850000,
      }),
    ).not.toThrow();
  });

  it("validates network configuration", () => {
    expect(() =>
      NetworkConfigSchema.parse({
        nodeName: "Test Net",
        enablePublicChannels: true,
        enablePrivateChannels: false,
        enableUserChannels: true,
        enableReplies: true,
        enableDMs: false,
        enableReactions: true,
        enableMarkdown: true,
        enableAttachments: true,
        enableLocationSharing: false,
        enablePresence: true,
        enableMesh: false,
        enableLLMChat: false,
        enableLLMStreaming: false,
        allowUserDisplayNameEdit: false,
        allowUserAvatarEdit: false,
        allowUserAvatarUpload: false,
        allowAdminClaim: false,
        joinPolicy: "open",
        securityProfile: "standard",
        transportEncryption: "off",
        dbEncryption: "off",
        locale: "en",
        devMode: false,
      }),
    ).not.toThrow();
  });

  it("rejects an unknown UI locale in network configuration", () => {
    expect(
      NetworkConfigSchema.safeParse({
        nodeName: "Test Net",
        enablePublicChannels: true,
        enablePrivateChannels: false,
        enableUserChannels: true,
        enableReplies: true,
        enableDMs: false,
        enableReactions: true,
        enableMarkdown: true,
        enableAttachments: true,
        enableLocationSharing: false,
        enablePresence: true,
        enableMesh: false,
        enableLLMChat: false,
        enableLLMStreaming: false,
        allowUserDisplayNameEdit: false,
        allowUserAvatarEdit: false,
        allowUserAvatarUpload: false,
        allowAdminClaim: false,
        joinPolicy: "open",
        securityProfile: "standard",
        transportEncryption: "off",
        dbEncryption: "off",
        locale: "xx",
      }).success,
    ).toBe(false);
  });

  it("validates the node configuration and partial updates", () => {
    expect(() =>
      LoamConfigSchema.parse({
        node: { name: "Test Net", locale: "ar" },
        identity: {
          allowUserDisplayNameEdit: true,
          allowUserAvatarEdit: true,
          allowUserAvatarUpload: false,
          allowAdminUserEdit: true,
        },
        features: {
          enablePublicChannels: true,
          enablePrivateChannels: false,
          enableUserChannels: true,
          enableReplies: true,
          enableDMs: true,
          enableReactions: true,
          enableMarkdown: true,
          enableAttachments: true,
          enableLocationSharing: false,
          enablePresence: true,
        },
        llm: {
          ollama: {
            enabled: false,
            baseUrl: "http://localhost:11434",
            model: "gemma4",
            botId: "llm.ollama.gemma4",
            botDisplayName: "Gemma",
          },
          onDevice: { enabled: false },
        },
        admin: { bootstrap: "firstUser" },
        killSwitch: { enabled: false, requireConfirmation: true },
        retention: {},
        security: { profile: "standard", transportEncryption: "optional", dbEncryption: "off" },
        access: { joinPolicy: "open" },
        sync: { enabled: false, peers: [], intervalMs: 30_000 },
        mesh: { enabled: false, relay: false, ttlMs: 259_200_000, hopLimit: 6, maxCarried: 5_000, maxContacts: 1_000 },
      }),
    ).not.toThrow();

    expect(() =>
      LoamConfigUpdateSchema.parse({
        features: { enableReplies: false },
        admin: { bootstrap: "passphrase", passphrase: "" },
        node: { locale: "prs" },
      }),
    ).not.toThrow();

    expect(LoamConfigUpdateSchema.safeParse({ node: { locale: "xx" } }).success).toBe(false);

    expect(LoamConfigUpdateSchema.safeParse({ admin: { bootstrap: "dictator" } }).success).toBe(false);
    expect(LoamConfigUpdateSchema.safeParse({ features: { enableReplies: "yes" } }).success).toBe(false);
  });

  it("validates all message variants through the message union", () => {
    expect(() =>
      MessageSchema.parse({
        id: "msg_1",
        type: "channelPost",
        authorId: "usr_123",
        channelId: "chn_general",
        body: "Hello everyone",
        createdAt: 1712850000,
      }),
    ).not.toThrow();

    expect(() =>
      MessageSchema.parse({
        id: "msg_2",
        type: "channelReply",
        authorId: "usr_456",
        channelId: "chn_general",
        parentMessageId: "msg_1",
        body: "I agree",
        createdAt: 1712850010,
      }),
    ).not.toThrow();

    expect(() =>
      MessageSchema.parse({
        id: "msg_3",
        type: "dm",
        authorId: "usr_123",
        recipientUserId: "usr_456",
        body: "Meet me by the entrance",
        createdAt: 1712850020,
      }),
    ).not.toThrow();

    expect(() =>
      MessageSchema.parse({
        id: "msg_4",
        type: "reaction",
        authorId: "usr_456",
        targetMessageId: "msg_1",
        reaction: "👍",
        createdAt: 1712850030,
      }),
    ).not.toThrow();
  });

  it("rejects message variants missing their variant-specific fields", () => {
    expect(() =>
      MessageSchema.parse({
        id: "msg_1",
        type: "channelPost",
        authorId: "usr_123",
        body: "Hello everyone",
        createdAt: 1712850000,
      }),
    ).toThrow();

    expect(() =>
      MessageSchema.parse({
        id: "msg_2",
        type: "channelPost",
        authorId: "usr_123",
        channelId: "chn_general",
        body: "",
        createdAt: 1712850000,
        meta: {
          streaming: true,
        },
      }),
    ).not.toThrow();

    expect(() =>
      MessageCreateRequestSchema.parse({
        type: "dm",
        recipientUserId: "usr_456",
        body: "   ",
      }),
    ).toThrow();
  });

  it("validates message creation requests", () => {
    expect(() =>
      MessageCreateRequestSchema.parse({
        type: "channelReply",
        channelId: "chn_general",
        parentMessageId: "msg_1",
        body: "Replying",
      }),
    ).not.toThrow();

    expect(() =>
      MessageCreateRequestSchema.parse({
        type: "dm",
        recipientUserId: "usr_456",
        body: "   ",
      }),
    ).toThrow();

    // An image alone is a valid message: an empty/whitespace body passes when attachments are
    // present, and still fails without them.
    const attachment = { id: "att_0123456789abcdef", mimeType: "image/webp" };
    expect(() =>
      MessageCreateRequestSchema.parse({
        type: "channelPost",
        channelId: "chn_general",
        body: "",
        attachments: [attachment],
      }),
    ).not.toThrow();
    expect(() =>
      MessageCreateRequestSchema.parse({
        type: "dm",
        recipientUserId: "usr_456",
        body: "   ",
        attachments: [attachment],
      }),
    ).not.toThrow();
    expect(() =>
      MessageCreateRequestSchema.parse({
        type: "channelPost",
        channelId: "chn_general",
        body: "",
        attachments: [],
      }),
    ).toThrow();
  });

  it("maps security profiles to coherent axis bundles (custom opts out)", () => {
    expect(securityProfilePreset("custom")).toBeNull();

    const hardened = securityProfilePreset("hardened");
    expect(hardened).toEqual({
      joinPolicy: "approval",
      messageTtlMs: 3_600_000,
      killSwitchEnabled: true,
      transportEncryption: "required",
    });

    // Secure by default: open and standard now BOTH encrypt (`optional`) — plaintext (`off`) is no longer
    // any profile's posture (Developer Mode only). They currently differ only in intent; hardened requires it.
    expect(securityProfilePreset("open")).toEqual({
      joinPolicy: "open",
      messageTtlMs: null,
      killSwitchEnabled: false,
      transportEncryption: "optional",
    });
    expect(securityProfilePreset("standard")).toEqual({
      joinPolicy: "open",
      messageTtlMs: null,
      killSwitchEnabled: false,
      transportEncryption: "optional",
    });
  });

  it("accepts every declared dbEncryption mode and rejects unknown ones", () => {
    for (const mode of ["off", "ephemeral", "persistent", "passphrase"] as const) {
      expect(() =>
        SecurityConfigSchema.parse({ profile: "custom", transportEncryption: "optional", dbEncryption: mode }),
      ).not.toThrow();
    }
    expect(DbEncryptionModeSchema.safeParse("hardware").success).toBe(false);
    expect(
      SecurityConfigSchema.safeParse({ profile: "custom", transportEncryption: "optional", dbEncryption: "hardware" })
        .success,
    ).toBe(false);
  });

  it("never accepts a CONFIGURED transportEncryption of 'off' (Developer Mode is the only plaintext path)", () => {
    expect(SecurityConfigSchema.safeParse({ profile: "custom", transportEncryption: "off", dbEncryption: "off" }).success).toBe(
      false,
    );
    expect(LoamConfigUpdateSchema.safeParse({ security: { transportEncryption: "off" } }).success).toBe(false);
    expect(LoamConfigUpdateSchema.safeParse({ security: { transportEncryption: "required" } }).success).toBe(true);
    // The REPORTED posture still carries `off` (Developer Mode's effective value).
    expect(TransportEncryptionSchema.safeParse("off").success).toBe(true);
  });

  it("constrains an avatar imageId to the server-minted avt_<16 hex> file-name format (no traversal)", () => {
    const base = { kind: "image" as const, mimeType: "image/png" as const };
    expect(UserAvatarSchema.safeParse({ ...base, imageId: "avt_0123456789abcdef" }).success).toBe(true);
    for (const imageId of ["../../x", "../attachments/att_0123456789abcdef", "avt_0123456789ABCDEF", "avt_0123", "avt_0123456789abcdef/"]) {
      expect(UserAvatarSchema.safeParse({ ...base, imageId }).success, imageId).toBe(false);
    }
  });

  it("bounds ids, bot ids, bot display names and model labels", () => {
    expect(IdSchema.safeParse("x".repeat(128)).success).toBe(true);
    expect(IdSchema.safeParse("x".repeat(129)).success).toBe(false);

    const ollama = { botId: "llm.ollama.gemma4", botDisplayName: "Gemma", model: "gemma4" };
    const update = (patch: Record<string, unknown>) =>
      LoamConfigUpdateSchema.safeParse({ llm: { ollama: { ...ollama, ...patch } } }).success;
    expect(update({})).toBe(true);
    // A bot id must live in the reserved `llm.` namespace — never a person's `user.` id.
    expect(update({ botId: "user.0123456789abcdef" })).toBe(false);
    expect(update({ botId: `llm.${"x".repeat(61)}` })).toBe(false);
    expect(update({ botDisplayName: "x".repeat(80) })).toBe(true);
    expect(update({ botDisplayName: "x".repeat(81) })).toBe(false);
    expect(update({ model: "m".repeat(121) })).toBe(false);

    const meta = (model: string) =>
      MessageSchema.safeParse({
        id: "llm_1",
        type: "dm",
        authorId: "llm.ollama.gemma4",
        recipientUserId: "user.1",
        body: "",
        createdAt: 1,
        meta: { source: "llm", model },
      }).success;
    expect(meta("m".repeat(120))).toBe(true);
    expect(meta("m".repeat(121))).toBe(false);
  });

  it("accepts a moderator timeout as a duration (timeoutMs) and single-string search params", () => {
    expect(ModerationUpdateRequestSchema.safeParse({ timeoutMs: 3_600_000 }).success).toBe(true);
    expect(ModerationUpdateRequestSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
    expect(ModerationUpdateRequestSchema.safeParse({ timeoutMs: 1.5 }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ q: "hello", limit: "5" }).success).toBe(true);
    expect(SearchQuerySchema.safeParse({ q: ["a", "b"] }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ limit: ["1", "2"] }).success).toBe(false);
  });

  it("keeps dbEncryption out of the security-profile forcing bundle (an independent axis)", () => {
    for (const profile of ["open", "standard", "hardened"] as const) {
      expect(securityProfilePreset(profile)).not.toHaveProperty("dbEncryption");
    }
  });

  it("validates LLM stream events", () => {
    expect(() =>
      StreamEventSchema.parse({
        type: "delta",
        messageId: "msg_ai_1",
        text: "Hello",
      }),
    ).not.toThrow();
  });

  it("keeps SERVER_ERROR_CODES a non-empty, duplicate-free list of snake_case codes", () => {
    expect(SERVER_ERROR_CODES.length).toBeGreaterThan(0);
    expect(new Set(SERVER_ERROR_CODES).size).toBe(SERVER_ERROR_CODES.length);
    for (const code of SERVER_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("schema refinements", () => {
  describe("MessageLocationSchema (label-or-coordinates rule)", () => {
    it("accepts a label alone, coordinates alone, or both together", () => {
      expect(() => MessageLocationSchema.parse({ label: "the north gate" })).not.toThrow();
      expect(() => MessageLocationSchema.parse({ lat: 51.5, lng: -0.12 })).not.toThrow();
      expect(() => MessageLocationSchema.parse({ label: "camp 3", lat: 0, lng: 0 })).not.toThrow();
    });

    it("rejects an empty share and a lone coordinate (one axis is not a location)", () => {
      expect(() => MessageLocationSchema.parse({})).toThrow();
      // A single coordinate without its partner (and no label) can't place anything.
      expect(() => MessageLocationSchema.parse({ lat: 51.5 })).toThrow();
      expect(() => MessageLocationSchema.parse({ lng: -0.12 })).toThrow();
    });

    it("enforces the field bounds (label length, coordinate range)", () => {
      expect(() => MessageLocationSchema.parse({ label: "" })).toThrow();
      expect(() => MessageLocationSchema.parse({ label: "x".repeat(121) })).toThrow();
      expect(() => MessageLocationSchema.parse({ lat: 91, lng: 0 })).toThrow();
      expect(() => MessageLocationSchema.parse({ lat: 0, lng: 181 })).toThrow();
    });
  });

  describe("ModerationUpdateRequestSchema (at-least-one-field rule)", () => {
    it("accepts any request that sets at least one field, including an explicit false", () => {
      expect(() => ModerationUpdateRequestSchema.parse({ banned: true })).not.toThrow();
      // `false` is defined, so it satisfies the rule — the check is `!== undefined`, not truthiness.
      expect(() => ModerationUpdateRequestSchema.parse({ shadowBanned: false })).not.toThrow();
      expect(() => ModerationUpdateRequestSchema.parse({ banned: false, shadowBanned: true })).not.toThrow();
    });

    it("rejects an empty update (nothing to change)", () => {
      expect(() => ModerationUpdateRequestSchema.parse({})).toThrow();
    });
  });

  describe("MessageEditRequestSchema (non-empty body rule)", () => {
    it("accepts a body with visible content up to the 8000-char cap", () => {
      expect(() => MessageEditRequestSchema.parse({ body: "edited" })).not.toThrow();
      expect(() => MessageEditRequestSchema.parse({ body: "x".repeat(8000) })).not.toThrow();
    });

    it("rejects an empty/whitespace body and one past the cap", () => {
      expect(() => MessageEditRequestSchema.parse({ body: "" })).toThrow();
      expect(() => MessageEditRequestSchema.parse({ body: "   \n\t " })).toThrow();
      expect(() => MessageEditRequestSchema.parse({ body: "x".repeat(8001) })).toThrow();
    });
  });

  describe("MessageCreateRequestSchema (non-reaction needs content)", () => {
    it("accepts a location-only post (empty body, no attachments)", () => {
      // The superRefine's location branch: a shared place alone is a valid message.
      expect(() =>
        MessageCreateRequestSchema.parse({
          type: "channelPost",
          channelId: "chn_general",
          body: "",
          location: { label: "the north gate" },
        }),
      ).not.toThrow();
    });

    it("still rejects a post with no body, no attachments, and no location", () => {
      expect(() =>
        MessageCreateRequestSchema.parse({
          type: "channelPost",
          channelId: "chn_general",
          body: "   ",
        }),
      ).toThrow();
    });
  });

  describe("SyncAttachmentResponseSchema.data (standard base64)", () => {
    const ok = (data: string) => SyncAttachmentResponseSchema.safeParse({ data, mimeType: "image/png" }).success;

    it("accepts valid standard base64, padded and unpadded quanta", () => {
      // Real 1×1 PNG (ends with `==`), a `=`-padded value, an unpadded 4-quantum value, and empty.
      expect(ok("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")).toBe(true);
      expect(ok("YWJj")).toBe(true); // "abc"
      expect(ok("YWJjZA==")).toBe(true); // "abcd"
      expect(ok("YWJjZGU=")).toBe(true); // "abcde"
      expect(ok("")).toBe(true);
    });

    it("rejects malformed padding / non-quantum lengths", () => {
      expect(ok("A=")).toBe(false);
      expect(ok("AB=")).toBe(false);
      expect(ok("abcde=")).toBe(false);
      expect(ok("YWJj=")).toBe(false); // padding after a full quantum
      expect(ok("****")).toBe(false); // outside the alphabet
    });

    it("rejects a payload beyond the 1 MiB decoded cap (the largest attachment — a non-image file)", () => {
      // 1398108 is a valid 4-char-quantum length just past the 1398104 cap, so this isolates the max check.
      expect(ok("A".repeat(1_398_108))).toBe(false);
      expect(ok("A".repeat(1_398_104))).toBe(true);
    });
  });
});
