import { describe, expect, it } from "vitest";
import {
  ChannelSchema,
  LoamConfigSchema,
  LoamConfigUpdateSchema,
  MessageCreateRequestSchema,
  MessageSchema,
  NetworkConfigSchema,
  securityProfilePreset,
  StreamEventSchema,
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
        enablePresence: true,
        enableLLMChat: false,
        enableLLMStreaming: false,
        allowUserDisplayNameEdit: false,
        allowUserAvatarEdit: false,
        allowUserAvatarUpload: false,
        allowAdminClaim: false,
        joinPolicy: "open",
        securityProfile: "standard",
      }),
    ).not.toThrow();
  });

  it("validates the node configuration and partial updates", () => {
    expect(() =>
      LoamConfigSchema.parse({
        node: { name: "Test Net" },
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
        },
        admin: { bootstrap: "firstUser" },
        killSwitch: { enabled: false, requireConfirmation: true },
        retention: {},
        security: { profile: "standard" },
        access: { joinPolicy: "open" },
        sync: { enabled: false, peers: [], intervalMs: 30_000 },
      }),
    ).not.toThrow();

    expect(() =>
      LoamConfigUpdateSchema.parse({
        features: { enableReplies: false },
        admin: { bootstrap: "passphrase", passphrase: "" },
      }),
    ).not.toThrow();

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
    expect(hardened).toEqual({ joinPolicy: "approval", messageTtlMs: 3_600_000, killSwitchEnabled: true });

    // open/standard share today's enforced settings; only hardened tightens them.
    for (const profile of ["open", "standard"] as const) {
      expect(securityProfilePreset(profile)).toEqual({
        joinPolicy: "open",
        messageTtlMs: null,
        killSwitchEnabled: false,
      });
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
});
