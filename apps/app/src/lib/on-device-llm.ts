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

import { initLlama, type LlamaContext } from 'llama.rn';

import { loadModelManagerState } from './model-manager-store';

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

// The llama.rn context for the currently-loaded model, kept module-level so we load the (large) GGUF
// once and reuse it across DMs, only reloading when the operator switches the active model.
let loadedContext: LlamaContext | null = null;
let loadedModelPath: string | null = null;
// A llama.cpp context can't run concurrent completions; serialize DMs through a promise chain.
let inferenceChain: Promise<void> = Promise.resolve();

/** The active downloaded model's local filesystem path (from the model manager), or null if none is
 * selected. Strips the `file://` scheme expo-file-system uses — llama.rn wants a bare path. */
async function activeModelPath(): Promise<string | null> {
  const state = await loadModelManagerState();
  if (!state.activeId) {
    return null;
  }
  const model = state.downloaded.find((entry) => entry.id === state.activeId);
  if (!model || typeof model.uri !== 'string' || model.uri.length === 0) {
    return null;
  }
  return model.uri.replace(/^file:\/\//, '');
}

/** Load (or reuse) the llama.rn context for `modelPath`, releasing a previously-loaded different model
 * first. Offloads to the GPU/DSP where available (OpenCL/Hexagon are wired via the llama.rn Expo
 * plugin); llama.cpp falls back to CPU when no accelerator is present. */
async function ensureContext(modelPath: string): Promise<LlamaContext> {
  if (loadedContext && loadedModelPath === modelPath) {
    return loadedContext;
  }
  if (loadedContext) {
    try {
      await loadedContext.release();
    } catch {
      // best-effort — releasing a stale context should never block loading the new one
    }
    loadedContext = null;
    loadedModelPath = null;
  }
  const context = await initLlama({ model: modelPath, n_ctx: 4096, n_gpu_layers: 99 });
  loadedContext = context;
  loadedModelPath = modelPath;
  return context;
}

/**
 * Run the on-device model over `messages`, streaming reply text through the callbacks. Loads the
 * operator's active GGUF (from the model manager) via llama.rn, reusing the context across calls, and
 * serializes concurrent DMs (one llama.cpp context can't run parallel completions). Any failure — no
 * active model, a load error, an inference error — is reported via `onError`; this never throws, so a
 * missing/broken model degrades to a graceful assistant error and never affects crisis messaging.
 */
async function runInference(messages: ChatMessage[], callbacks: InferenceCallbacks): Promise<void> {
  const run = inferenceChain.then(async () => {
    try {
      const modelPath = await activeModelPath();
      if (!modelPath) {
        callbacks.onError('No on-device model is selected. Download and activate one from the AI model manager.');
        return;
      }
      const context = await ensureContext(modelPath);
      await context.completion(
        {
          messages,
          n_predict: 512,
          // Gemma's turn terminator (+ the generic end token); llama.rn stops on any match.
          stop: ['<end_of_turn>', '<eos>'],
        },
        (data) => {
          const token = data?.token;
          if (typeof token === 'string' && token.length > 0) {
            callbacks.onDelta(token);
          }
        },
      );
      callbacks.onEnd();
    } catch (error) {
      callbacks.onError(error instanceof Error ? error.message : String(error));
    }
  });
  // Keep the chain alive regardless of this run's outcome so the next DM still queues behind it.
  inferenceChain = run.catch(() => undefined);
  return run;
}

/**
 * Wire the on-device LLM request/response bridge onto the nodejs-mobile channel. Safe to call on any
 * platform — if no on-device requests ever arrive (backend disabled, or non-Android), it does
 * nothing. Returns a cleanup that removes the listener.
 */
const CHAT_ROLES = new Set(['system', 'user', 'assistant']);

/** Validate a single message from the bridge (defensive — each entry's role + content, not just the
 * array container) so a malformed payload can never reach the model. */
function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    CHAT_ROLES.has((value as { role?: unknown }).role as string) &&
    typeof (value as { content?: unknown }).content === 'string'
  );
}

export function registerOnDeviceLlm(channel: BridgeChannel): () => void {
  const onRequest = (payload: LlmRequest): void => {
    const id = payload?.id;

    if (id === undefined || id === null) {
      return;
    }

    const messages: ChatMessage[] = (Array.isArray(payload?.messages) ? payload.messages : []).filter(isChatMessage);

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
