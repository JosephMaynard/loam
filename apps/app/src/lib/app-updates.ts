/**
 * Finding out whether a newer LOAM exists, without LOAM phoning home.
 *
 * - The Google Play build asks the Play Store app on the phone (modules/loam-updates), once per launch.
 * - The GitHub build asks GitHub, and only when someone taps "Check for updates". The request carries no
 *   LOAM data: GitHub sees the phone's IP address and that it asked for LOAM's latest release.
 *
 * Neither downloads or installs anything: they say a version exists and open the store or releases page.
 * Pure helpers; the screen is components/update-notice.tsx.
 */

/** GitHub's "latest release" endpoint for LOAM. Drafts and pre-releases are never "latest". */
export const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/MagicZebraLtd/loam/releases/latest';
/** Where the GitHub build sends people to download a newer APK. */
export const GITHUB_RELEASES_PAGE = 'https://github.com/MagicZebraLtd/loam/releases/latest';
/** LOAM's Play listing: the Play Store app first, the website if no store app handles `market://`. */
export const PLAY_STORE_URL = 'market://details?id=com.loamnet.host';
export const PLAY_STORE_WEB_URL = 'https://play.google.com/store/apps/details?id=com.loamnet.host';

/** Give up on GitHub after this long, so a dead connection doesn't leave the button spinning. */
export const GITHUB_CHECK_TIMEOUT_MS = 10_000;

export type Version = readonly [number, number, number];

/** `0.5.0` or `v0.5.0` → `[0, 5, 0]`. Anything else (a suffix, extra parts, junk) → null. Pure. */
export function parseVersion(text: string): Version | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a later version than `current`. Pure. */
export function isNewerVersion(candidate: Version, current: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) {
      return candidate[i]! > current[i]!;
    }
  }
  return false;
}

/** A pre-release suffix: `-beta.N` sorts before `-rc.N`, and both before the final release. */
export type PreRelease = { readonly channel: 'beta' | 'rc'; readonly number: number };

/** The version of the installed build: X.Y.Z, plus the pre-release a release-candidate build carries. */
export type InstalledVersion = { readonly version: Version; readonly preRelease: PreRelease | null };

/**
 * `0.6.0`, `v0.6.0`, `0.6.0-rc.1` or `v0.6.0-beta.2` → its parts. The suffixes are exactly the ones a
 * release tag may carry (scripts/check-versions.mjs); anything else → null. Pure.
 */
export function parseInstalledVersion(text: string): InstalledVersion | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(rc|beta)\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const version: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
  const channel = match[4] as PreRelease['channel'] | undefined;
  return { version, preRelease: channel ? { channel, number: Number(match[5]) } : null };
}

/** `{ [0, 6, 0], rc 1 }` → `0.6.0-rc.1`, the way the opening screen shows it. Pure. */
export function formatInstalledVersion(installed: InstalledVersion): string {
  const core = installed.version.join('.');
  return installed.preRelease ? `${core}-${installed.preRelease.channel}.${installed.preRelease.number}` : core;
}

/**
 * The installed build's version as text: the release tag baked in at build time when there is a valid one
 * (it names an RC, which app.json's bare X.Y.Z can't), else app.json's version. Pure.
 */
export function installedVersionText(releaseTag: string, appVersion: string): string {
  const fromTag = parseInstalledVersion(releaseTag);
  return fromTag ? formatInstalledVersion(fromTag) : appVersion;
}

/**
 * Order two installed versions: negative when `a` is older, positive when newer, 0 when equal. X.Y.Z
 * first, then beta < rc < final, then the pre-release number. Pure.
 */
export function compareInstalledVersions(a: InstalledVersion, b: InstalledVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.version[i] !== b.version[i]) {
      return a.version[i]! - b.version[i]!;
    }
  }
  const rank = (pre: PreRelease | null): number => (pre === null ? 2 : pre.channel === 'rc' ? 1 : 0);
  if (rank(a.preRelease) !== rank(b.preRelease)) {
    return rank(a.preRelease) - rank(b.preRelease);
  }
  return (a.preRelease?.number ?? 0) - (b.preRelease?.number ?? 0);
}

export type GitHubCheckResult =
  | { kind: 'available'; version: string }
  | { kind: 'current' }
  | { kind: 'failed' };

/**
 * Ask GitHub for LOAM's latest release and compare it with `currentVersion`, the installed build's version
 * (installedVersionText: `0.6.0`, or `0.6.0-rc.1` for a release candidate, which the final 0.6.0
 * replaces). Only the release's tag is read, and only as a strict `vX.Y.Z` (GitHub never calls a
 * pre-release "latest"); nothing from the reply is shown except that version number. No cookies, no LOAM
 * data in the request. Never throws: offline, a timeout or an odd reply is `failed`.
 */
export async function checkGitHubRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = GITHUB_CHECK_TIMEOUT_MS,
): Promise<GitHubCheckResult> {
  const current = parseInstalledVersion(currentVersion);
  if (!current) {
    return { kind: 'failed' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_API, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { kind: 'failed' };
    }
    const body: unknown = await response.json();
    const tag = body && typeof body === 'object' ? (body as { tag_name?: unknown }).tag_name : undefined;
    const latest = typeof tag === 'string' ? parseVersion(tag) : null;
    if (!latest) {
      return { kind: 'failed' };
    }
    return compareInstalledVersions({ version: latest, preRelease: null }, current) > 0
      ? { kind: 'available', version: latest.join('.') }
      : { kind: 'current' };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
