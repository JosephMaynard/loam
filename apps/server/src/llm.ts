// The optional LLM assistant: the bot user, Ollama / on-device streaming, and the DM-driven assistant
// reply. Extracted verbatim from app.ts (2026-09-04 split) behind the shared `Runtime` view.
import { type Message, MessageSchema, type User, UserSchema } from "@loam/schema";
import { isRecord } from "./config.js";
import { MAX_LLM_CONTEXT_MESSAGES } from "./defaults.js";
import { makeBotUser } from "./identity.js";
import { newMessageId } from "./ids.js";
import type { OnDeviceChatHook } from "./types.js";
import type { Runtime } from "./runtime.js";

export function createLlmLayer(rt: Runtime) {
  /** Whether any LLM backend is active — the laptop Ollama connection or the on-device model. The
   * bot DM contact, streaming, and all LLM routes are gated on this, so it stays off unless the
   * operator explicitly enables a backend (both default off). */
  function llmEnabled(): boolean {
    return rt.appConfig.llm.ollama.enabled || rt.appConfig.llm.onDevice.enabled;
  }

  /** The model label shown on assistant replies — the on-device model when that backend is active,
   * else the Ollama model. */
  function activeLlmModel(): string {
    if (rt.appConfig.llm.onDevice.enabled) {
      return rt.appConfig.llm.onDevice.model ?? "on-device";
    }
    return rt.appConfig.llm.ollama.model;
  }

  /**
   * Ensures the assistant bot user exists in the in-memory user rt.store and is up to date. The bot's
   * identity (id, display name) is shared from `llm.ollama` regardless of which backend answers, so
   * switching between the laptop-Ollama and on-device backends keeps the same DM contact.
   *
   * If no LLM backend is enabled, no changes are made.
   *
   * @returns The bot `User` after creation or update, or `undefined` when no backend is enabled.
   */
  function ensureBotUser(): User | undefined {
    if (!llmEnabled()) {
      return undefined;
    }

    const existing = rt.data.users.find((user) => user.id === rt.appConfig.llm.ollama.botId);

    if (existing) {
      const parsedExisting = UserSchema.parse(existing);
      const next = UserSchema.parse({
        ...parsedExisting,
        displayName: rt.appConfig.llm.ollama.botDisplayName,
        type: "bot" as const,
        isAdmin: false,
        avatar: parsedExisting.avatar ?? {
          seed: rt.appConfig.llm.ollama.botId,
          mode: "pattern" as const,
        },
      });

      if (JSON.stringify(parsedExisting) !== JSON.stringify(next)) {
        rt.store.upsertUser(next);
        Object.assign(existing, next);
        rt.broadcast({ type: "userUpserted", user: existing });
      }

      return existing;
    }

    const user = makeBotUser(rt.appConfig.llm.ollama);
    rt.store.upsertUser(user);
    rt.data.users.push(user);
    rt.broadcast({ type: "userUpserted", user });
    return user;
  }

  /**
   * Build a sequence of chat messages for the configured Ollama model from the DM history between a bot and a user.
   */
  function llmMessagesForUser(
    botId: string,
    currentUserId: string,
  ): { role: "system" | "user" | "assistant"; content: string }[] {
    const history = rt.dmMessages(botId, currentUserId).flatMap((message) => {
      if (message.type !== "dm" || !message.body.trim()) {
        return [];
      }

      return [
        {
          role: message.authorId === botId ? ("assistant" as const) : ("user" as const),
          content: message.body,
        },
      ];
    });

    // Bound the context to the most-recent turns: mapping the ENTIRE DM history every turn grows the
    // request each time and eventually overflows the model's context window (the model then errors or
    // silently drops the oldest tokens anyway). Keep the newest `MAX_LLM_CONTEXT_MESSAGES` and always keep
    // the system prompt. A message-count bound (not a token budget) is the same hardcoded-limit style as the
    // 5-minute Ollama timeout below; a token budget + summarisation is the documented fuller version
    // (docs/25 P2). A single pathological message can still be large — that's the follow-up, not this fix.
    const messages = history.slice(-MAX_LLM_CONTEXT_MESSAGES);

    return rt.appConfig.llm.ollama.systemPrompt
      ? [{ role: "system" as const, content: rt.appConfig.llm.ollama.systemPrompt }, ...messages]
      : messages;
  }

  function ollamaUrl(path: string): string {
    return `${rt.appConfig.llm.ollama.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async function* streamOllamaChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

    try {
      const response = await fetch(ollamaUrl("/api/chat"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: rt.appConfig.llm.ollama.model,
          stream: true,
          messages,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();

            if (!trimmed) {
              continue;
            }

            const parsed: unknown = JSON.parse(trimmed);

            if (!isRecord(parsed)) {
              continue;
            }

            if (typeof parsed.error === "string") {
              throw new Error(parsed.error);
            }

            const message = isRecord(parsed.message) ? parsed.message : undefined;
            const content = message && typeof message.content === "string" ? message.content : "";

            if (content) {
              yield content;
            }

            if (parsed.done === true) {
              return;
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Ollama request timed out while streaming.");
        }

        throw error;
      } finally {
        clearTimeout(timeout);
        void reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Ollama request timed out before streaming started.");
      }

      throw error;
    }
  }

  /**
   * Stream a reply from the **on-device** model. Inference doesn't run in this (embedded Node)
   * process — it runs in the Android host's RN/native layer, reachable via a hook the launcher
   * (`nodejs-project-template/main.js`) installs on `globalThis.__loamOnDeviceChat` before requiring
   * the server bundle. On any other host (desktop, Pi, CI) the hook is simply absent, so enabling the
   * on-device backend there yields a clean error rather than a crash — messaging is never affected.
   * The callback-style hook is adapted into the same `AsyncGenerator<string>` shape as Ollama so the
   * assistant flow below is backend-agnostic.
   */
  async function* streamOnDeviceChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    const hook = (globalThis as { __loamOnDeviceChat?: OnDeviceChatHook }).__loamOnDeviceChat;

    if (typeof hook !== "function") {
      throw new Error("The on-device model is not available on this host.");
    }

    const queue: string[] = [];
    let finished = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const signal = () => {
      wake?.();
      wake = undefined;
    };

    // Bound the request like the Ollama path: if the host hook goes silent (a wedged model, a dropped
    // rn-bridge round-trip) the generator would otherwise hang forever. After 5 minutes, fail it.
    const timeout = setTimeout(
      () => {
        if (!finished) {
          failure = new Error("The on-device model timed out.");
          finished = true;
          signal();
        }
      },
      5 * 60 * 1000,
    );

    hook(messages, {
      onDelta: (text) => {
        if (text) {
          queue.push(text);
        }
        signal();
      },
      onEnd: () => {
        finished = true;
        signal();
      },
      onError: (message) => {
        failure = new Error(message || "The on-device model failed.");
        finished = true;
        signal();
      },
    });

    try {
      while (true) {
        if (queue.length) {
          yield queue.shift() as string;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (finished) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Stream from whichever LLM backend is active: the on-device model takes precedence when enabled,
   * otherwise the laptop Ollama connection. */
  function streamChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    return rt.appConfig.llm.onDevice.enabled ? streamOnDeviceChat(messages) : streamOllamaChat(messages);
  }

  /**
   * Triggers an LLM assistant reply to a direct message and streams the assistant's content into a
   * new DM message via StreamEvent deltas, persisting the final body once. Backend-agnostic — the
   * deltas come from `streamChat` (Ollama or the on-device model).
   *
   * @param userMessage - The incoming DM message that may trigger the bot response
   */
  async function createAssistantResponse(userMessage: Message): Promise<void> {
    if (!llmEnabled() || userMessage.type !== "dm") {
      return;
    }

    const bot = rt.data.users.find((user) => user.id === rt.appConfig.llm.ollama.botId);

    if (!bot || userMessage.recipientUserId !== bot.id || userMessage.authorId === bot.id) {
      return;
    }

    const assistantMessage = MessageSchema.parse({
      id: newMessageId("llm"),
      type: "dm",
      authorId: bot.id,
      recipientUserId: userMessage.authorId,
      body: "",
      createdAt: Date.now(),
      meta: {
        source: "llm",
        model: activeLlmModel(),
        markdown: true,
        streaming: true,
      },
    });
    rt.store.insertMessage(assistantMessage);
    rt.data.messages.push(assistantMessage);
    rt.broadcast({ type: "messageCreated", message: assistantMessage });

    const audience = new Set([bot.id, userMessage.authorId]);
    let body = "";
    rt.broadcastStreamEvent(audience, { type: "start", messageId: assistantMessage.id });

    try {
      for await (const delta of streamChat(llmMessagesForUser(bot.id, userMessage.authorId))) {
        body += delta;

        // Keep the in-memory copy current for mid-stream REST reads, but defer persistence and the
        // full-message rt.broadcast to the end — clients follow the incremental delta events instead.
        if ("body" in assistantMessage) {
          assistantMessage.body = body;
        }

        rt.broadcastStreamEvent(audience, { type: "delta", messageId: assistantMessage.id, text: delta });
      }

      rt.updateMessage(assistantMessage, body.trim() || "(No response.)", false);
      rt.broadcastStreamEvent(audience, { type: "end", messageId: assistantMessage.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LLM error.";
      rt.updateMessage(assistantMessage, `${body}\n\nLLM error: ${message}`.trim(), false);
      rt.broadcastStreamEvent(audience, { type: "error", messageId: assistantMessage.id, error: message });
      rt.log.error(error);
    }
  }

  return {
    llmEnabled,
    activeLlmModel,
    ensureBotUser,
    createAssistantResponse,
  };
}
