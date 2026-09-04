// Message id minting + channel-membership predicate. Extracted from app.ts (2026-09-04 split).
import { randomUUID } from "node:crypto";

import type { Message } from "@loam/schema";

export function isChannelMessage(message: Message, channelId: string): boolean {
  return (
    (message.type === "channelPost" || message.type === "channelReply") &&
    message.channelId === channelId
  );
}

export function newMessageId(prefix = "msg"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}
