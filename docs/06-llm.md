# 06 — LLM support: improvements

## Current state (what exists)

All in `apps/server/src/llm.ts`, gated on `llm.ollama.enabled` (or `llm.onDevice.enabled`, below):

- **One provider, one model**: `streamOllamaChat()` POSTs to Ollama `/api/chat` with `stream: true`, a
  5-minute abort timeout, parses newline-delimited JSON deltas.
- **DM-only bot**: `createAssistantResponse()` fires when a user DMs the configured bot user (`type: "bot"`).
  There is no channel participation and no `@mention` support.
- **Bot identity is bounded**: `llm.ollama.botId` must be an `llm.*` id (`BotIdSchema`, ≤64 chars) and
  may not name an existing non-bot user — so pointing it at a person can't turn them (or an admin) into a
  bot. `PATCH /api/admin/config` validates this before persisting (`botConfigError`, 400); at boot an
  invalid persisted value is logged and the assistant is skipped (`ensureBotUser` is non-fatal).
  `botDisplayName` ≤80 (the user-record bound), `model` ≤120 (`LLM_MODEL_MAX_LENGTH`, also the
  `meta.model` cap).
- **Unbounded context**: `llmMessagesForUser()` maps the **entire** DM history to chat messages every
  turn (+ optional system prompt), now **capped to the most-recent `MAX_LLM_CONTEXT_MESSAGES` (40)** so a
  long chat no longer grows the request every turn or overflows the model's context window; a token budget
  + summarization is still the fuller follow-up.
- ~~**Streaming is bandwidth-inefficient**~~ **(FIXED)**: streaming now uses the **`StreamEvent`** union
  (`start`/`delta`/`end`/`error`) — each delta carries only the *new* text to the DM participants, and the
  final body is persisted + broadcast **once** at `end` (a single `messageUpdated`, so non-streaming
  clients still converge). The old O(n²) per-token rebroadcast of the entire growing body is gone. See
  `broadcastStreamEvent` in `realtime.ts`; covered by `apps/server/src/llm.test.ts`.
- **Concurrency is bounded**: at most **one reply per user and two node-wide**
  (`MAX_CONCURRENT_ASSISTANT_REPLIES`). `POST /api/messages` checks this *before* creating the DM and
  answers **429 `assistant_busy`**, so a refused request leaves no unanswered message.
- **Streams stop when their message goes away**: the writer checks before every write and stops if a
  moderator removes the reply, it is deleted, or an Emergency Reset lands mid-stream (so a late delta can't
  restore removed content). A placeholder a crash/restart left with `meta.streaming: true` is
  **finalized at load** (`finalizeInterruptedStreams`: partial text kept, or a neutral "interrupted" body),
  so it no longer sits un-reapable and un-deletable.
- **Still missing**: user-initiated cancellation and a per-user rate limit/queue beyond the bound above.

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

**Who owns `llm.onDevice`.** The launcher's model manager (`loam-model-set-active` in
`nodejs-project-template/main.js`) writes the whole `llm.onDevice` block into `config.json`. Because
the DB config layer (written in full by every admin save) sits above `config.json`, **`config.json` is
authoritative for `llm.onDevice` whenever it carries that block** — the DB layer's copy is dropped
(`withoutLauncherOwnedKeys`), so an admin save can't freeze the launcher's later activate/deactivate.
A desktop/Pi node whose `config.json` never mentions `llm.onDevice` keeps the admin's persisted value.

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

**The one device-gated step — wiring real inference. _DONE._** `apps/app/src/lib/on-device-llm.ts`
fully wires `llama.rn` (model download with on-device SHA-256 verification, load, streaming
inference), verified on a physical Galaxy S21 Ultra (Android 15, 2026-08-04 device session:
download → verify → activate → coherent DM reply, CPU backend honestly reported — see docs/21).
Ongoing re-verification of new builds remains part of the docs/21 device checklist. The original
build plan is kept below for the record:

1. `pnpm --filter app add llama.rn expo-document-picker expo-file-system`, add the `llama.rn` Expo
   config plugin to `app.json` (verify the arm64-v8a prebuild against `with-loam-host.js`'s ABI pin).
2. Implement `runInference`: load the GGUF at `llm.onDevice.modelPath`, run a streaming completion
   built from `messages`, forward each token to `onDelta`, then `onEnd` (errors → `onError`).
3. Add a model-file picker (SAF via `expo-document-picker`) to the host UI that copies the GGUF into
   app-private storage and PATCHes `llm.onDevice.modelPath`; gate the offer on `Device.totalMemory`.

_(Historical caveat, since resolved: this step was deliberately held back until a physical arm64
phone and a GGUF model were available — that verification has now happened, see above.)_

Runtime choice: **`llama.rn`** (llama.cpp, GGUF) over MediaPipe LLM Inference (less mature RN bindings)
and over `node-llama-cpp` inside nodejs-mobile (a non-starter — an N-API addon cross-compiled for the
Node 18 / ABI-108 android-arm64 runtime, the same class of problem the on-device DB encryption had to
solve with a cross-compiled, vendored prebuild). GGUF is also the format users are most likely to find, and it's added later, not
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
4. **Cancellation + limits.** Let a user stop a generation (abort the fetch); add a queue and a per-user
   rate limit on top of the concurrency bound (1 per user / 2 node-wide, done) so a Pi isn't overwhelmed.
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
- **Quick wins:** ~~wire `StreamEvent`~~ (done), ~~bound context length~~ (done, 40 messages),
  ~~a concurrency cap~~ (done); user cancellation remains.
- **Bigger bets:** provider abstraction, channel/@mention participation, and local RAG (the most
  differentiated feature for an off-grid information-sharing app).
