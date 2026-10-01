import { describe, expect, it } from 'vitest';

import { linkCodeUrl, requestLinkCode } from './link-code';

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
      for (const handler of listeners.get('loam-link-code-result') ?? []) {
        handler(payload);
      }
    },
  };
}

describe('requestLinkCode', () => {
  it('resolves with the matching answer, and refuses a malformed code', async () => {
    const bridge = fakeChannel();
    const pending = requestLinkCode(bridge.channel);
    const { requestId } = bridge.posts[0]!.payload;
    expect(bridge.posts[0]!.name).toBe('loam-link-code');
    bridge.answer({ requestId: 'other', ok: true, code: 'X'.repeat(16), expiresAt: 1 });
    bridge.answer({ requestId, ok: true, code: 'ABCDEFGHIJKLMNOP', expiresAt: 42 });
    expect(await pending).toEqual({ ok: true, code: 'ABCDEFGHIJKLMNOP', expiresAt: 42 });

    const second = fakeChannel();
    const refused = requestLinkCode(second.channel);
    second.answer({ requestId: second.posts[0]!.payload.requestId, ok: true, code: 'short', expiresAt: 42 });
    expect(await refused).toMatchObject({ ok: false });
  });
});

describe('linkCodeUrl', () => {
  it('adds the code after the key, dropping any invite code', () => {
    expect(linkCodeUrl('http://10.0.0.1:3000/#k=KEY&i=INVITE', 'CODE')).toBe('http://10.0.0.1:3000/#k=KEY&l=CODE');
  });

  it('refuses a URL without a key', () => {
    expect(linkCodeUrl('http://10.0.0.1:3000/', 'CODE')).toBeUndefined();
    expect(linkCodeUrl(undefined, 'CODE')).toBeUndefined();
  });
});
