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

## On-device model (Android host) — optional, off by default

As an alternative to reaching a laptop's Ollama, the Android host can run a **small model on the phone
itself** (e.g. Gemma via llama.cpp). It's **optional and off by default** (lots of people dislike AI),
the model is **never shipped** — the operator adds a GGUF file on-device later if their phone can
handle it — and it must never affect crisis messaging, which always works with no model present.

**Config** (`packages/schema`, additive — existing Ollama config is untouched): `llm.onDevice
{ enabled, model?, modelPath?, contextSize? }`. The bot's *identity* (id, display name, system prompt)
is shared from `llm.ollama`, so switching backends keeps the same DM contact. The active backend is
derived server-side: on-device when `onDevice.enabled`, else Ollama when `ollama.enabled`, else none
(`llmEnabled()`, `activeLlmModel()`). Admin UI: a toggle + model-name field under LLM settings.

**Architecture** — reuses the existing streaming flow entirely. Inference does **not** run in the
embedded Node server; it runs in the RN/native layer, so no native dependency is added to
nodejs-mobile (avoiding the SQLCipher-class ABI problem). The path:

```
DM to bot → createAssistantResponse → streamChat → streamOnDeviceChat
  → global.__loamOnDeviceChat  (installed by nodejs-project-template/main.js, before requiring the server)
  → rn-bridge 'loam-llm-request'  → apps/app/src/lib/on-device-llm.ts (registerOnDeviceLlm)
  → runInference → streams 'loam-llm-delta'/'loam-llm-end'/'loam-llm-error' back
  → server emits the same StreamEvent start/delta/end/error as Ollama, persists once
```

On every non-Android host (desktop, Pi, CI) `global.__loamOnDeviceChat` is simply **absent**, so
enabling the on-device backend there yields a clean assistant error, never a crash — messaging is
unaffected. Correlation ids keep concurrent DMs from crossing streams.

**Built and unit-tested now** (no device needed): the server provider abstraction + config +
`enableLLMChat` derivation, the launcher bridge glue (`main.js`), the client admin UI, and the RN
listener (`registerOnDeviceLlm`). Server tests cover the on-device path via a faked
`globalThis.__loamOnDeviceChat` (streaming + the graceful absent-hook error + bot hidden when off).

**The one device-gated step — wiring real inference.** `apps/app/src/lib/on-device-llm.ts`'s
`runInference` is a graceful **stub** ("no model configured"). To make it run a model, on a physical
arm64 phone:

1. `pnpm --filter app add llama.rn expo-document-picker expo-file-system`, add the `llama.rn` Expo
   config plugin to `app.json` (verify the arm64-v8a prebuild against `with-loam-host.js`'s ABI pin).
2. Implement `runInference`: load the GGUF at `llm.onDevice.modelPath`, run a streaming completion
   built from `messages`, forward each token to `onDelta`, then `onEnd` (errors → `onError`).
3. Add a model-file picker (SAF via `expo-document-picker`) to the host UI that copies the GGUF into
   app-private storage and PATCHes `llm.onDevice.modelPath`; gate the offer on `Device.totalMemory`.

This step is deliberately left unbuilt: it **cannot be built or verified without a physical arm64
phone and a GGUF model**, and adding an unverified native dependency (`llama.rn`) to the committed
build would jeopardize the working APK. Everything up to the inference call is wired and tested.

Runtime choice: **`llama.rn`** (llama.cpp, GGUF) over MediaPipe LLM Inference (less mature RN bindings)
and over `node-llama-cpp` inside nodejs-mobile (a non-starter — an N-API addon cross-compiled for the
Node 18 / ABI-108 android-arm64 runtime, the same class of problem the on-device DB encryption is
still blocked on). GGUF is also the format users are most likely to find, and it's added later, not
shipped.

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
