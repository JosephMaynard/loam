import { describe, expect, it, vi } from 'vitest';

import { closeAfterReset, requestEmergencyReset, resetOutcome } from './emergency-reset';

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
    bridge.answer({ requestId, ok: true, complete: true, keyClear: true, journaled: true });
    await expect(pending).resolves.toEqual({ ok: true, complete: true, keyClear: true, journaled: true });
  });

  it('reports an incomplete wipe and a failure as such', async () => {
    const bridge = fakeChannel();
    const incomplete = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[0]!.payload.requestId, ok: true, complete: false, journaled: true });
    await expect(incomplete).resolves.toEqual({ ok: true, complete: false, keyClear: false, journaled: true });

    const failed = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[1]!.payload.requestId, ok: false, error: 'not running' });
    await expect(failed).resolves.toEqual({ ok: false, error: 'not running' });
  });

  it('carries an unjournaled incomplete wipe through, and reads a missing flag as journaled', async () => {
    const bridge = fakeChannel();
    const unrecorded = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[0]!.payload.requestId, ok: true, complete: false, journaled: false });
    await expect(unrecorded).resolves.toEqual({ ok: true, complete: false, keyClear: false, journaled: false });

    // A launcher answer without the field keeps today's reopen-to-finish screen.
    const older = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[1]!.payload.requestId, ok: true, complete: false });
    await expect(older).resolves.toEqual({ ok: true, complete: false, keyClear: false, journaled: true });
  });

  it('gives up after the timeout instead of hanging', async () => {
    vi.useFakeTimers();
    const bridge = fakeChannel();
    const pending = requestEmergencyReset(bridge.channel, 1000);
    vi.advanceTimersByTime(1000);
    await expect(pending).resolves.toEqual({ ok: false, error: 'The host did not answer in time.' });
    vi.useRealTimers();
  });

  it('closes LOAM only once everything is erased, and never on an incomplete erase', () => {
    // Review 2026-10-03 #3: the screen used to close the app on any `ok`, including `complete: false`.
    expect(resetOutcome({ ok: true, complete: true, keyClear: false, journaled: true })).toBe('close');
    expect(resetOutcome({ ok: true, complete: true, keyClear: true, journaled: true })).toBe('key-clear');
    expect(resetOutcome({ ok: true, complete: false, keyClear: false, journaled: true })).toBe('incomplete');
    expect(resetOutcome({ ok: true, complete: false, keyClear: true, journaled: true })).toBe('incomplete');
    expect(resetOutcome({ ok: false, error: 'not running' })).toBe('failed');
  });

  it('asks for the reset again, rather than promising a reopen finishes it, when the wipe was not journaled', () => {
    expect(resetOutcome({ ok: true, complete: false, keyClear: false, journaled: false })).toBe('unrecorded');
    expect(resetOutcome({ ok: true, complete: false, keyClear: true, journaled: false })).toBe('unrecorded');
    // A finished wipe needs no journal: whether one was written doesn't change closing.
    expect(resetOutcome({ ok: true, complete: true, keyClear: false, journaled: false })).toBe('close');
    expect(resetOutcome({ ok: true, complete: true, keyClear: true, journaled: false })).toBe('key-clear');
  });
});

describe('closeAfterReset', () => {
  it('closes LOAM only once the shared-file cache is cleared', async () => {
    // Review 2026-10-09 (Android P3): the host-menu reset used to close straight away, leaving the last
    // shared file in the cache until the next launch.
    const order: string[] = [];
    let release!: () => void;
    const clear = () =>
      new Promise<void>((resolve) => {
        release = () => {
          order.push('clear');
          resolve();
        };
      });
    const pending = closeAfterReset(clear, () => order.push('close'));
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await pending;
    expect(order).toEqual(['clear', 'close']);
  });

  it('still closes LOAM when the clear fails', async () => {
    const close = vi.fn();
    await closeAfterReset(() => Promise.reject(new Error('cache gone')), close);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
