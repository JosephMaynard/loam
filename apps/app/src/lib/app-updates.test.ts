import { describe, expect, it, vi } from 'vitest';

import { checkGitHubRelease, GITHUB_LATEST_RELEASE_API, isNewerVersion, parseVersion } from './app-updates';

/** A fetch that answers once with `body` (as JSON) and `status`, recording what it was asked. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

describe('parseVersion', () => {
  it('reads plain and v-prefixed versions', () => {
    expect(parseVersion('0.5.0')).toEqual([0, 5, 0]);
    expect(parseVersion('v1.12.3')).toEqual([1, 12, 3]);
  });

  it('refuses suffixes, extra parts and junk', () => {
    for (const text of ['v0.6.0-rc.1', '0.6', '0.6.0.1', 'latest', '', 'v0.6.0<script>']) {
      expect(parseVersion(text)).toBeNull();
    }
  });
});

describe('isNewerVersion', () => {
  it('compares major, then minor, then patch', () => {
    expect(isNewerVersion([0, 6, 0], [0, 5, 9])).toBe(true);
    expect(isNewerVersion([1, 0, 0], [0, 99, 99])).toBe(true);
    expect(isNewerVersion([0, 5, 1], [0, 5, 0])).toBe(true);
    expect(isNewerVersion([0, 5, 0], [0, 5, 0])).toBe(false);
    expect(isNewerVersion([0, 4, 9], [0, 5, 0])).toBe(false);
  });
});

describe('checkGitHubRelease', () => {
  it('reports a newer release by its version number', async () => {
    const fetchImpl = fakeFetch({ tag_name: 'v0.6.0', body: 'release notes are never read' });
    expect(await checkGitHubRelease('0.5.0', fetchImpl)).toEqual({ kind: 'available', version: '0.6.0' });
  });

  it('reports the same or an older release as current', async () => {
    expect(await checkGitHubRelease('0.5.0', fakeFetch({ tag_name: 'v0.5.0' }))).toEqual({ kind: 'current' });
    expect(await checkGitHubRelease('0.5.0', fakeFetch({ tag_name: 'v0.4.2' }))).toEqual({ kind: 'current' });
  });

  it('asks only the latest-release endpoint, without cookies', async () => {
    const fetchImpl = fakeFetch({ tag_name: 'v0.5.0' });
    await checkGitHubRelease('0.5.0', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GITHUB_LATEST_RELEASE_API);
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
  });

  it('fails quietly on an error status, an odd reply, a thrown fetch or a bad current version', async () => {
    expect(await checkGitHubRelease('0.5.0', fakeFetch({ message: 'rate limited' }, 403))).toEqual({ kind: 'failed' });
    expect(await checkGitHubRelease('0.5.0', fakeFetch({ tag_name: 'nightly' }))).toEqual({ kind: 'failed' });
    expect(await checkGitHubRelease('0.5.0', fakeFetch(['not', 'an', 'object']))).toEqual({ kind: 'failed' });
    const offline = vi.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await checkGitHubRelease('0.5.0', offline)).toEqual({ kind: 'failed' });
    expect(await checkGitHubRelease('?', fakeFetch({ tag_name: 'v0.6.0' }))).toEqual({ kind: 'failed' });
  });

  it('gives up after the timeout', async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    expect(await checkGitHubRelease('0.5.0', hanging, 10)).toEqual({ kind: 'failed' });
  });
});
