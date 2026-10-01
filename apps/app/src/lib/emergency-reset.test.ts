import { describe, expect, it, vi } from 'vitest';

import { requestEmergencyReset } from './emergency-reset';

/** A bridge double: records posts, lets the test answer like main.js would. */
function fakeChannel() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const posts: Array<{ name: string; payload: { requestId: string } }> = [];
  return {
    posts,
    channel: {
      addListener(name: string, handler: (payload: unknown) => void) {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);
        return { remove: () => set.delete(handler) };
      },
      removeAllListeners(name: string) {
        listeners.delete(name);
      },
      post(name: string, payload: unknown) {
        posts.push({ name, payload: payload as { requestId: string } });
      },
    },
    answer(payload: unknown) {
      for (const handler of listeners.get('loam-emergency-reset-result') ?? []) {
        handler(payload);
      }
    },
  };
}

describe('requestEmergencyReset', () => {
  it('posts the request and resolves with the matching answer', async () => {
    const bridge = fakeChannel();
    const pending = requestEmergencyReset(bridge.channel);
    const { requestId } = bridge.posts[0]!.payload;
    expect(bridge.posts[0]!.name).toBe('loam-emergency-reset');
    bridge.answer({ requestId: 'someone-else', ok: false, error: 'not mine' });
    bridge.answer({ requestId, ok: true, complete: true });
    await expect(pending).resolves.toEqual({ ok: true, complete: true });
  });

  it('reports an incomplete wipe and a failure as such', async () => {
    const bridge = fakeChannel();
    const incomplete = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[0]!.payload.requestId, ok: true, complete: false });
    await expect(incomplete).resolves.toEqual({ ok: true, complete: false });

    const failed = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[1]!.payload.requestId, ok: false, error: 'not running' });
    await expect(failed).resolves.toEqual({ ok: false, error: 'not running' });
  });

  it('gives up after the timeout instead of hanging', async () => {
    vi.useFakeTimers();
    const bridge = fakeChannel();
    const pending = requestEmergencyReset(bridge.channel, 1000);
    vi.advanceTimersByTime(1000);
    await expect(pending).resolves.toEqual({ ok: false, error: 'The host did not answer in time.' });
    vi.useRealTimers();
  });
});
