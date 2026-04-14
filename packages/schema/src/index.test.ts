import { describe, expect, it } from "vitest";
import {
  ChannelSchema,
  MessageSchema,
  NetworkConfigSchema,
  StreamEventSchema,
  UserSchema,
} from "./index";

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
        enablePublicChannels: true,
        enablePrivateChannels: false,
        enableUserChannels: true,
        enableReplies: true,
        enableDMs: false,
        enableReactions: true,
        enableMarkdown: true,
        enableLLMStreaming: false,
      }),
    ).not.toThrow();
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
