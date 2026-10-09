/**
 * A "Link a node" code for the share screen (server `sync-links.ts`): ask the launcher (main.js
 * `loam-link-code`) to mint one through the launcher-only `POST /api/host/link-code`. The host phone needs
 * no admin session for it: whoever holds it owns the network. Never throws: a timeout, a host that isn't
 * running, or a thrown `post()` all resolve to `{ ok: false, error }`.
 */
import { addOwnListener } from './bridge-listener';
import type { BridgeChannel } from './db-encryption';
import { hostErrorText, hostNoResponseText } from './host-errors';

export type LinkCodeResult = { ok: true; code: string; expiresAt: number } | { ok: false; error: string };

const CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export function requestLinkCode(channel: BridgeChannel, timeoutMs = 10_000): Promise<LinkCodeResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: LinkCodeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeListener();
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as
        | { requestId?: unknown; ok?: unknown; code?: unknown; expiresAt?: unknown; error?: unknown; errorCode?: unknown; status?: unknown }
        | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      if (result.ok === true && typeof result.code === 'string' && CODE_PATTERN.test(result.code) && typeof result.expiresAt === 'number') {
        finish({ ok: true, code: result.code, expiresAt: result.expiresAt });
      } else {
        finish({ ok: false, error: hostErrorText(result) });
      }
    };

    const timer = setTimeout(() => finish({ ok: false, error: hostNoResponseText() }), timeoutMs);
    const removeListener = addOwnListener(channel, 'loam-link-code-result', onResult);
    try {
      channel.post('loam-link-code', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * The link QR: the join URL (with its `#k=` key, which the joining node pins) plus the code. Undefined
 * without a key: the code must only ever travel sealed, and the scanner refuses a link code with no key.
 */
export function linkCodeUrl(joinUrlWithKey: string | undefined, code: string): string | undefined {
  if (!joinUrlWithKey || !/#k=[A-Za-z0-9_-]+/.test(joinUrlWithKey)) {
    return undefined;
  }
  return `${joinUrlWithKey.replace(/&i=[A-Za-z0-9_-]+/, '')}&l=${code}`;
}
