import { describe, expect, it, vi } from 'vitest';

import {
  checkGitHubRelease,
  compareInstalledVersions,
  formatInstalledVersion,
  GITHUB_LATEST_RELEASE_API,
  installedVersionText,
  isNewerVersion,
  parseInstalledVersion,
  parseVersion,
} from './app-updates';

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

describe('parseInstalledVersion', () => {
  it('reads a final version and the rc / beta pre-releases a release tag may carry', () => {
    expect(parseInstalledVersion('0.6.0')).toEqual({ version: [0, 6, 0], preRelease: null });
    expect(parseInstalledVersion('v0.6.0-rc.1')).toEqual({ version: [0, 6, 0], preRelease: { channel: 'rc', number: 1 } });
    expect(parseInstalledVersion('0.6.0-beta.12')).toEqual({ version: [0, 6, 0], preRelease: { channel: 'beta', number: 12 } });
  });

  it('refuses any other suffix and junk', () => {
    for (const text of ['0.6.0-alpha.1', '0.6.0-rc', '0.6.0-rc.1.2', '0.6.0+build.7', '0.6', '', 'v0.6.0-rc.1<b>']) {
      expect(parseInstalledVersion(text)).toBeNull();
    }
  });

  it('formats back to the text the opening screen shows', () => {
    expect(formatInstalledVersion(parseInstalledVersion('v0.6.0-rc.1')!)).toBe('0.6.0-rc.1');
    expect(formatInstalledVersion(parseInstalledVersion('v0.6.0')!)).toBe('0.6.0');
  });
});

describe('compareInstalledVersions', () => {
  /** Shorthand: compare two version texts. */
  function compare(a: string, b: string): number {
    return Math.sign(compareInstalledVersions(parseInstalledVersion(a)!, parseInstalledVersion(b)!));
  }

  it('orders beta < rc < final within one X.Y.Z, then by the pre-release number', () => {
    expect(compare('0.6.0-beta.9', '0.6.0-rc.1')).toBe(-1);
    expect(compare('0.6.0-rc.1', '0.6.0')).toBe(-1);
    expect(compare('0.6.0-beta.1', '0.6.0')).toBe(-1);
    expect(compare('0.6.0-rc.2', '0.6.0-rc.1')).toBe(1);
    expect(compare('0.6.0-rc.10', '0.6.0-rc.9')).toBe(1);
    expect(compare('0.6.0-rc.1', '0.6.0-rc.1')).toBe(0);
    expect(compare('0.6.0', '0.6.0')).toBe(0);
  });

  it('puts X.Y.Z ahead of any pre-release', () => {
    expect(compare('0.6.0-beta.1', '0.5.9')).toBe(1);
    expect(compare('0.5.9', '0.6.0-rc.1')).toBe(-1);
  });
});

describe('installedVersionText', () => {
  it('prefers a valid release tag, so a release candidate shows as one', () => {
    expect(installedVersionText('v0.6.0-rc.1', '0.6.0')).toBe('0.6.0-rc.1');
    expect(installedVersionText('v0.6.0', '0.6.0')).toBe('0.6.0');
  });

  it("falls back to app.json's version without a tag or with an odd one", () => {
    expect(installedVersionText('', '0.6.0')).toBe('0.6.0');
    expect(installedVersionText('nightly', '0.6.0')).toBe('0.6.0');
  });
});

describe('checkGitHubRelease', () => {
  it('offers the final release to someone on its release candidate or beta', async () => {
    expect(await checkGitHubRelease('0.6.0-rc.1', fakeFetch({ tag_name: 'v0.6.0' }))).toEqual({ kind: 'available', version: '0.6.0' });
    expect(await checkGitHubRelease('0.6.0-beta.3', fakeFetch({ tag_name: 'v0.6.0' }))).toEqual({ kind: 'available', version: '0.6.0' });
    expect(await checkGitHubRelease('0.5.0-rc.2', fakeFetch({ tag_name: 'v0.6.0' }))).toEqual({ kind: 'available', version: '0.6.0' });
  });

  it('treats a release candidate of a newer version as current', async () => {
    expect(await checkGitHubRelease('0.6.0-rc.1', fakeFetch({ tag_name: 'v0.5.0' }))).toEqual({ kind: 'current' });
  });

  it('still reads the latest tag strictly: a pre-release tag from GitHub is an odd reply', async () => {
    expect(await checkGitHubRelease('0.5.0', fakeFetch({ tag_name: 'v0.6.0-rc.1' }))).toEqual({ kind: 'failed' });
  });

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
