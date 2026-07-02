# 06 — LLM support: improvements

## Current state (what exists)

All in `apps/server/src/server.ts`, gated on `llm.ollama.enabled`:

- **One provider, one model**: `streamOllamaChat()` POSTs to Ollama `/api/chat` with `stream: true`, a
  5-minute abort timeout, parses newline-delimited JSON deltas.
- **DM-only bot**: `createOllamaResponse()` fires when a user DMs the configured bot user (`type: "bot"`).
  There is no channel participation and no `@mention` support.
- **Unbounded context**: `llmMessagesForUser()` maps the **entire** DM history to chat messages every
  turn (+ optional system prompt). No token budget, windowing, or summarization — long chats will slow
  down and eventually exceed the model's context.
- **Streaming is bandwidth-inefficient**: each delta calls `updateMessage()` → `broadcast({ type:
  "messageUpdated", message })`, re-sending the **entire growing body** every token. That's O(n²) bytes
  over the wire — a real problem on the low-bandwidth links LOAM targets. Meanwhile the schema already
  defines a proper **`StreamEvent`** union (`start`/`delta`/`end`/`error`) that is **tested but never
  used** — the intended incremental protocol was scaffolded and left unwired.
- **No cancellation, no concurrency limits, no rate limiting**: every inbound DM to the bot spawns a
  generation; nothing caps how many run at once (rough on a Raspberry Pi).

## Improvements to investigate (roughly ordered)

1. **Provider abstraction.** Extract a `ChatProvider` interface (`streamChat(messages, opts)`), then
   implement it for: Ollama (`/api/chat`), any **OpenAI-compatible** endpoint (llama.cpp server, LM
   Studio, vLLM — and Ollama's own `/v1/chat/completions`), and cloud APIs (Anthropic/OpenAI) for the
   internet-hosted `authenticated` mode. Standardizing on the OpenAI-compatible shape covers most local
   backends with one client. Config: `llm.provider` + per-provider settings.
2. **Fix the streaming protocol.** Wire the existing `StreamEvent` schema over the WebSocket: emit
   `start` once, `delta` with only the new text per token, `end`/`error` to finish. Client appends deltas
   locally. Removes the O(n²) rebroadcast and matches what the schema already anticipates. Persist the
   final body once at `end` (fewer DB writes than per-token).
3. **Context management.** Bound the history sent to the model (last N turns / token budget), with
   optional rolling **summarization** of older turns. Prevents slowdowns and context overflow.
4. **Cancellation + limits.** Let a user stop a generation (abort the fetch); cap concurrent generations
   and add a per-user rate limit and a queue so a Pi isn't overwhelmed.
5. **Channel participation / `@mention`.** Let the bot answer in channels when mentioned, not just DMs —
   a big fit for LOAM as an *information-sharing* app ("ask the assistant in #general"). Mind audience
   scoping so the bot can't leak other users' private data.
6. **RAG over local content — the standout off-grid feature.** Ground answers in local channels /
   announcements / uploaded docs so the assistant can answer "where's the meeting point?" from
   `#announcements` with no internet. Use local embeddings (Ollama `/api/embeddings`) + a vector store
   — **`sqlite-vec`** fits the SQLite direction ([01](01-sqlite-migration.md)), or a simple cosine over
   stored vectors to start. This also unlocks **semantic message search** (see [07](07-more-features.md)).
7. **Multiple models / bots.** Let admins ([03](03-admin-ui.md)) register several bots (each a
   `type:"bot"` User) with their own model, persona/system prompt, and temperature; users pick which to
   talk to.
8. **Tool use / function calling** (advanced). Ollama and OpenAI-compatible backends support tools; could
   let the assistant take structured actions (post to a channel, look up local info). Gate carefully.
9. **Safety.** Message bodies are untrusted input — harden against prompt injection (especially in
   channel/RAG mode), cap output length, and never let the bot bypass DM/channel audience rules.
10. **Backend health surfacing.** Report whether the LLM backend is reachable; the current error path
    appends an "LLM error" note — extend to a clear status in the UI.

## Interactions
- **[01 SQLite]** enables `sqlite-vec` for RAG/embeddings and cleaner message storage.
- **[03 Admin UI]** is where model/provider/persona config and enable/disable live (today it's text-file
  only).
- **[05 Auth]** the `authenticated`/website mode is where cloud LLM providers (with API keys) make sense;
  off-grid stays local-only.

## Quick wins vs. bigger bets
- **Quick wins:** wire `StreamEvent` (fixes the O(n²) bandwidth bug), bound context length, add
  cancellation + a concurrency cap.
- **Bigger bets:** provider abstraction, channel/@mention participation, and local RAG (the most
  differentiated feature for an off-grid information-sharing app).
