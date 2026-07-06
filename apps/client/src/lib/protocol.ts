import {
  ChannelSchema,
  MessageSchema,
  NetworkConfigSchema,
  StreamEventSchema,
  UserSchema,
  type Channel,
  type Message,
  type NetworkConfig,
  type StreamEvent,
  type User,
} from "@loam/schema";

export const DEFAULT_CHANNEL_ID = "general";

export type Conversation =
  | {
      kind: "channel";
      id: string;
      threadId?: string;
    }
  | {
      kind: "dm";
      id: string;
    };

export type RouteState =
  | {
      screen: "channels";
      conversation?: Conversation;
    }
  | {
      screen: "settings";
    }
  | {
      screen: "admin";
    }
  | {
      screen: "people";
    }
  | {
      screen: "search";
    };

export type MessageResponse = {
  message?: Message;
  deletedMessageId?: string;
};

export type SocketEvent =
  | {
      type: "messageCreated";
      message: Message;
    }
  | {
      type: "messageUpdated";
      message: Message;
    }
  | {
      type: "messageDeleted";
      messageId: string;
    }
  | {
      type: "userUpserted";
      user: User;
    }
  | {
      type: "channelUpserted";
      channel: Channel;
    }
  | {
      type: "channelRemoved";
      channelId: string;
    }
  | {
      type: "configUpdated";
      networkConfig: NetworkConfig;
    }
  | {
      type: "wipe";
    }
  | {
      type: "stream";
      event: StreamEvent;
    };

/**
 * Maps a client path to a `RouteState`. Unknown paths fall back to the channels screen.
 *
 * @param path - The location path (e.g. `/channel/general/thread/abc`, `/dm/user.1`, `/admin`)
 * @returns The parsed route state
 */
export function parseRoute(path: string): RouteState {
  if (path === "/" || path === "/channels") {
    return { screen: "channels" };
  }

  if (path === "/settings") {
    return { screen: "settings" };
  }

  if (path === "/admin") {
    return { screen: "admin" };
  }

  if (path === "/people") {
    return { screen: "people" };
  }

  if (path === "/search") {
    return { screen: "search" };
  }

  const channelThread = path.match(/^\/channel\/([^/]+)\/thread\/([^/]+)$/);

  if (channelThread) {
    return {
      screen: "channels",
      conversation: {
        kind: "channel",
        id: decodeURIComponent(channelThread[1] ?? DEFAULT_CHANNEL_ID),
        threadId: decodeURIComponent(channelThread[2] ?? ""),
      },
    };
  }

  const channel = path.match(/^\/channel\/([^/]+)$/);

  if (channel) {
    return {
      screen: "channels",
      conversation: {
        kind: "channel",
        id: decodeURIComponent(channel[1] ?? DEFAULT_CHANNEL_ID),
      },
    };
  }

  const dm = path.match(/^\/dm\/([^/]+)$/);

  if (dm) {
    return {
      screen: "channels",
      conversation: {
        kind: "dm",
        id: decodeURIComponent(dm[1] ?? ""),
      },
    };
  }

  return { screen: "channels" };
}

/**
 * Parses a raw websocket message payload into a validated SocketEvent.
 *
 * Accepts any input (commonly a JSON string), attempts to JSON-parse it, and validates the resulting object.
 * Supported event types: `messageCreated`, `messageUpdated`, `messageDeleted`, `userUpserted`,
 * `channelUpserted`, `configUpdated`, `wipe`, and the LLM stream events (`start`/`delta`/`end`/`error`,
 * wrapped as `{ type: "stream", event }`).
 * `messageCreated` and `messageUpdated` require a valid `message` that passes `MessageSchema`.
 * `messageDeleted` requires a string `messageId`.
 * `userUpserted` requires a valid `user` that passes `UserSchema`.
 * `channelUpserted` requires a valid `channel` that passes `ChannelSchema`.
 * `configUpdated` requires a valid `networkConfig`; stream events must pass `StreamEventSchema`.
 *
 * @param data - The raw websocket payload to parse (typically a JSON string)
 * @returns A validated `SocketEvent` when the payload is recognized and passes schema validation, `undefined` otherwise.
 */
export function parseSocketEvent(data: unknown): SocketEvent | undefined {
  let payload: unknown;

  try {
    payload = JSON.parse(String(data));
  } catch (error) {
    console.warn("Ignoring invalid websocket payload.", error);
    return undefined;
  }

  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return undefined;
  }

  const candidate = payload as {
    type: unknown;
    message?: unknown;
    messageId?: unknown;
    user?: unknown;
    channel?: unknown;
    channelId?: unknown;
    networkConfig?: unknown;
  };

  if (candidate.type === "messageCreated") {
    const message = MessageSchema.safeParse(candidate.message);
    return message.success ? { type: "messageCreated", message: message.data } : undefined;
  }

  if (candidate.type === "messageUpdated") {
    const message = MessageSchema.safeParse(candidate.message);
    return message.success ? { type: "messageUpdated", message: message.data } : undefined;
  }

  if (candidate.type === "messageDeleted") {
    return typeof candidate.messageId === "string"
      ? { type: "messageDeleted", messageId: candidate.messageId }
      : undefined;
  }

  if (candidate.type === "userUpserted") {
    const user = UserSchema.safeParse(candidate.user);
    return user.success ? { type: "userUpserted", user: user.data } : undefined;
  }

  if (candidate.type === "channelUpserted") {
    const channel = ChannelSchema.safeParse(candidate.channel);
    return channel.success ? { type: "channelUpserted", channel: channel.data } : undefined;
  }

  if (candidate.type === "channelRemoved") {
    return typeof candidate.channelId === "string"
      ? { type: "channelRemoved", channelId: candidate.channelId }
      : undefined;
  }

  if (candidate.type === "configUpdated") {
    const networkConfig = NetworkConfigSchema.safeParse(candidate.networkConfig);
    return networkConfig.success ? { type: "configUpdated", networkConfig: networkConfig.data } : undefined;
  }

  if (candidate.type === "wipe") {
    return { type: "wipe" };
  }

  if (
    candidate.type === "start" ||
    candidate.type === "delta" ||
    candidate.type === "end" ||
    candidate.type === "error"
  ) {
    const stream = StreamEventSchema.safeParse(payload);
    return stream.success ? { type: "stream", event: stream.data } : undefined;
  }

  return undefined;
}

/**
 * Validates a `POST /api/messages` response body into a `MessageResponse`.
 *
 * @param payload - The parsed JSON response
 * @returns `{ message }` and/or `{ deletedMessageId }` when valid, or `undefined` for an unrecognised/invalid shape
 */
export function parseMessageResponse(payload: unknown): MessageResponse | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as { message?: unknown; deletedMessageId?: unknown };
  const result: MessageResponse = {};

  if (candidate.message !== undefined) {
    const message = MessageSchema.safeParse(candidate.message);

    if (!message.success) {
      return undefined;
    }

    result.message = message.data;
  }

  if (candidate.deletedMessageId !== undefined) {
    if (typeof candidate.deletedMessageId !== "string") {
      return undefined;
    }

    result.deletedMessageId = candidate.deletedMessageId;
  }

  return result.message || result.deletedMessageId ? result : undefined;
}
