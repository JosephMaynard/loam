// RN-side glue for the optional on-device LLM (docs/06). Flow: when the operator enables
// `llm.onDevice`, the embedded Node server calls `global.__loamOnDeviceChat` (installed in
// `nodejs-project-template/main.js`), which posts a `loam-llm-request` over the rn-bridge channel.
// This module answers those requests by running a small model in the RN/native layer and streaming
// tokens back as `loam-llm-delta` / `loam-llm-end` / `loam-llm-error`, which the server turns into
// the same `StreamEvent`s the laptop-Ollama path uses. Nothing else in the LLM path changes.
//
// IMPORTANT — the actual inference engine is intentionally NOT wired here. `runInference` is a
// graceful stub that reports "no model configured", so enabling the backend on a device without a
// model is a harmless no-op error, never a crash, and crisis messaging is never affected. Turning it
// into a real model (e.g. Gemma) is the one step that cannot be built or verified without a physical
// arm64 phone and a GGUF file, so it's left as a single, clearly-marked seam — see docs/06,
// "Wiring on-device inference": add `llama.rn`, load the GGUF at the configured `modelPath`, run a
// streaming completion, and forward each token to `onDelta`, then `onEnd`.

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type LlmRequest = { id?: unknown; messages?: unknown };

/** The subset of the nodejs-mobile bridge channel this module uses (kept loose so it stays decoupled). */
interface BridgeChannel {
  addListener(name: string, handler: (payload: LlmRequest) => void): void;
  removeListener(name: string, handler: (payload: LlmRequest) => void): void;
  post(name: string, payload: unknown): void;
}

interface InferenceCallbacks {
  onDelta: (text: string) => void;
  onEnd: () => void;
  onError: (message: string) => void;
}

/**
 * Run the on-device model over `messages`, streaming reply text through the callbacks.
 *
 * STUB — replace the body with a real `llama.rn` (or MediaPipe LLM Inference) call: load the GGUF at
 * the operator-configured `modelPath`, run a streaming completion built from `messages`, forward each
 * token via `onDelta`, then call `onEnd`; report load/inference failures via `onError`. Until then
 * this reports "no model configured", which surfaces to the user as a graceful assistant error.
 */
async function runInference(messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  void messages;
  callbacks.onError(
    'No on-device model is configured. Add a model file and wire llama.rn on the Android host (see docs/06).',
  );
}

/**
 * Wire the on-device LLM request/response bridge onto the nodejs-mobile channel. Safe to call on any
 * platform — if no on-device requests ever arrive (backend disabled, or non-Android), it does
 * nothing. Returns a cleanup that removes the listener.
 */
export function registerOnDeviceLlm(channel: BridgeChannel): () => void {
  const onRequest = (payload: LlmRequest): void => {
    const id = payload?.id;

    if (id === undefined || id === null) {
      return;
    }

    const messages: ChatMessage[] = Array.isArray(payload?.messages) ? (payload.messages as ChatMessage[]) : [];

    void runInference(messages, {
      onDelta: (text) => channel.post('loam-llm-delta', { id, text }),
      onEnd: () => channel.post('loam-llm-end', { id }),
      onError: (message) => channel.post('loam-llm-error', { id, error: message }),
    }).catch((error: unknown) => {
      channel.post('loam-llm-error', { id, error: error instanceof Error ? error.message : String(error) });
    });
  };

  channel.addListener('loam-llm-request', onRequest);
  return () => channel.removeListener('loam-llm-request', onRequest);
}
