import type { Message, NetworkConfig, User } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { parseMessageResponse, parseRoute, parseSocketEvent } from "./protocol";

const message: Message = {
  id: "msg_1",
  type: "channelPost",
  channelId: "general",
  authorId: "user.1",
  body: "hello",
  createdAt: 1_704_067_200_000,
};

const user: User = {
  id: "user.1",
  displayName: "Ada",
  type: "human",
  isAdmin: false,
  createdAt: 1_704_067_200_000,
  ephemeral: false,
};

const networkConfig: NetworkConfig = {
  enablePublicChannels: true,
  enablePrivateChannels: false,
  enableUserChannels: true,
  enableReplies: true,
  enableDMs: true,
  enableReactions: true,
  enableMarkdown: true,
  enableLLMChat: false,
  enableLLMStreaming: false,
  allowUserDisplayNameEdit: false,
  allowUserAvatarEdit: false,
  allowUserAvatarUpload: false,
  allowAdminClaim: false,
};

function frame(value: unknown): string {
  return JSON.stringify(value);
}

describe("parseRoute", () => {
  it("maps the static screens", () => {
    expect(parseRoute("/")).toEqual({ screen: "channels" });
    expect(parseRoute("/channels")).toEqual({ screen: "channels" });
    expect(parseRoute("/settings")).toEqual({ screen: "settings" });
    expect(parseRoute("/admin")).toEqual({ screen: "admin" });
  });

  it("parses a channel route", () => {
    expect(parseRoute("/channel/general")).toEqual({
      screen: "channels",
      conversation: { kind: "channel", id: "general" },
    });
  });

  it("parses a channel thread route", () => {
    expect(parseRoute("/channel/general/thread/msg_9")).toEqual({
      screen: "channels",
      conversation: { kind: "channel", id: "general", threadId: "msg_9" },
    });
  });

  it("parses a DM route and decodes the id", () => {
    expect(parseRoute("/dm/user.1")).toEqual({
      screen: "channels",
      conversation: { kind: "dm", id: "user.1" },
    });
    expect(parseRoute("/channel/a%2Fb")).toEqual({
      screen: "channels",
      conversation: { kind: "channel", id: "a/b" },
    });
  });

  it("falls back to channels for unknown paths", () => {
    expect(parseRoute("/nonsense/path")).toEqual({ screen: "channels" });
  });
});

describe("parseSocketEvent", () => {
  it("returns undefined for non-JSON, missing type, and unknown type", () => {
    expect(parseSocketEvent("not json{")).toBeUndefined();
    expect(parseSocketEvent(frame({ noType: true }))).toBeUndefined();
    expect(parseSocketEvent(frame({ type: "somethingElse" }))).toBeUndefined();
  });

  it("parses messageCreated / messageUpdated and rejects invalid messages", () => {
    expect(parseSocketEvent(frame({ type: "messageCreated", message }))).toEqual({
      type: "messageCreated",
      message,
    });
    expect(parseSocketEvent(frame({ type: "messageUpdated", message }))).toEqual({
      type: "messageUpdated",
      message,
    });
    expect(parseSocketEvent(frame({ type: "messageCreated", message: { id: "x" } }))).toBeUndefined();
  });

  it("parses messageDeleted only with a string id", () => {
    expect(parseSocketEvent(frame({ type: "messageDeleted", messageId: "msg_1" }))).toEqual({
      type: "messageDeleted",
      messageId: "msg_1",
    });
    expect(parseSocketEvent(frame({ type: "messageDeleted", messageId: 5 }))).toBeUndefined();
  });

  it("parses userUpserted and rejects an invalid user", () => {
    expect(parseSocketEvent(frame({ type: "userUpserted", user }))).toEqual({ type: "userUpserted", user });
    expect(parseSocketEvent(frame({ type: "userUpserted", user: { id: "x" } }))).toBeUndefined();
  });

  it("parses configUpdated and rejects an invalid networkConfig", () => {
    expect(parseSocketEvent(frame({ type: "configUpdated", networkConfig }))).toEqual({
      type: "configUpdated",
      networkConfig,
    });
    expect(parseSocketEvent(frame({ type: "configUpdated", networkConfig: {} }))).toBeUndefined();
  });

  it("parses the wipe event", () => {
    expect(parseSocketEvent(frame({ type: "wipe" }))).toEqual({ type: "wipe" });
  });

  it("wraps LLM stream events", () => {
    expect(parseSocketEvent(frame({ type: "start", messageId: "llm_1" }))).toEqual({
      type: "stream",
      event: { type: "start", messageId: "llm_1" },
    });
    expect(parseSocketEvent(frame({ type: "delta", messageId: "llm_1", text: "hi" }))).toEqual({
      type: "stream",
      event: { type: "delta", messageId: "llm_1", text: "hi" },
    });
    expect(parseSocketEvent(frame({ type: "end", messageId: "llm_1" }))).toEqual({
      type: "stream",
      event: { type: "end", messageId: "llm_1" },
    });
    // A stream shape that fails the schema (delta without text) is rejected.
    expect(parseSocketEvent(frame({ type: "delta", messageId: "llm_1" }))).toBeUndefined();
  });
});

describe("parseMessageResponse", () => {
  it("parses a created message", () => {
    expect(parseMessageResponse({ message })).toEqual({ message });
  });

  it("parses a deleted-message id", () => {
    expect(parseMessageResponse({ deletedMessageId: "react_1" })).toEqual({ deletedMessageId: "react_1" });
  });

  it("rejects an invalid message and a non-string deletedMessageId", () => {
    expect(parseMessageResponse({ message: { id: "x" } })).toBeUndefined();
    expect(parseMessageResponse({ deletedMessageId: 7 })).toBeUndefined();
  });

  it("returns undefined for empty / non-object payloads", () => {
    expect(parseMessageResponse({})).toBeUndefined();
    expect(parseMessageResponse(null)).toBeUndefined();
    expect(parseMessageResponse("nope")).toBeUndefined();
  });
});
