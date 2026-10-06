// Public JS surface of the local `loam-updates` Expo module: which store this build is for, and the Play
// build's update check. The GitHub release check is plain JS (src/lib/app-updates.ts).
import LoamUpdatesModule from './src/LoamUpdatesModule';

export type Distribution = 'play' | 'github';

/** The store this build is for. A missing module (iOS, web, tests) counts as `github`: nothing to ask. */
export function distribution(): Distribution {
  return LoamUpdatesModule?.distribution() === 'play' ? 'play' : 'github';
}

/** Whether Google Play has a newer LOAM (Play build only). Resolves false on any failure or offline. */
export async function checkStoreUpdate(): Promise<boolean> {
  if (!LoamUpdatesModule) {
    return false;
  }
  try {
    return (await LoamUpdatesModule.checkStoreUpdate()).available === true;
  } catch {
    return false;
  }
}
