import { useEffect, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

import {
  isHotspotSupported,
  startHotspot,
  stopHotspot,
  type HotspotCredentials,
} from '../../modules/loam-hotspot';

/**
 * Lifecycle of the local-only hotspot:
 * - `idle`       — not started yet.
 * - `requesting` — asking for the runtime location/nearby-WiFi permission.
 * - `starting`   — permission granted, waiting on `WifiManager.LocalOnlyHotspot`.
 * - `running`    — up; `credentials` holds the generated SSID + password.
 * - `error`      — couldn't start (permission denied, no WiFi hardware, driver failure); `error`
 *                  holds a human-readable reason. LOAM's Step-2 URL QR is still shown (docs/04).
 */
export type HotspotPhase = 'idle' | 'requesting' | 'starting' | 'running' | 'error';

export type HotspotState = {
  phase: HotspotPhase;
  credentials?: HotspotCredentials;
  error?: string;
};

// Android permits exactly one LocalOnlyHotspot per process, and the host overlay mounts/unmounts as
// it opens and closes. So the hotspot state lives at module scope (survives remounts) and the hook
// subscribes to it — mirroring the single-runtime pattern used for nodejs-mobile in index.tsx.
let sharedState: HotspotState = { phase: 'idle' };
let inFlight = false;
// Bumped on every start and every shutdown. An in-flight start compares its captured value against
// this to detect that it was superseded (by a shutdown or a newer start) and must not publish stale
// state or leave an orphaned reservation running.
let generation = 0;
const listeners = new Set<(state: HotspotState) => void>();

// Guard against a native callback that never fires (some emulators neither resolve nor call
// onFailed): if start hasn't settled by now, treat it as a failure so the UI leaves the "starting"
// spinner and shows the graceful-degradation message + Step-2 QR instead of hanging.
const START_TIMEOUT_MS = 20_000;

/**
 * Race the native start against a timeout. Crucially, if the native start resolves *after* the
 * timeout already fired, the reservation it created is orphaned — release it — so a hotspot is never
 * left running invisibly after we've given up on it.
 */
function startWithTimeout(): Promise<HotspotCredentials> {
  const start = startHotspot();
  let timedOut = false;

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error("The hotspot didn't start in time. This device may not support one."));
    }, START_TIMEOUT_MS);
  });

  // Attach a cleanup handler to the real start; if it wins after the timeout, stop the orphan.
  void start.then(
    () => {
      if (timedOut) {
        stopHotspot();
      }
    },
    () => undefined,
  );

  return Promise.race([start, timeout]);
}

/** Update the shared state and notify every subscribed hook. */
function publish(next: HotspotState): void {
  sharedState = next;
  for (const listener of listeners) {
    listener(sharedState);
  }
}

/**
 * Request the runtime permissions LocalOnlyHotspot needs. ACCESS_FINE_LOCATION is always required;
 * API 33+ also gates it behind NEARBY_WIFI_DEVICES. Resolves true only if every requested
 * permission was granted.
 */
async function requestHotspotPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  const wanted: (keyof typeof PermissionsAndroid.PERMISSIONS)[] = ['ACCESS_FINE_LOCATION'];
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  if (apiLevel >= 33) {
    wanted.push('NEARBY_WIFI_DEVICES');
  }
  const permissions = wanted.map((name) => PermissionsAndroid.PERMISSIONS[name]);
  const result = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every((permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED);
}

/**
 * Start the hotspot once: request permission, then call the native module. Safe to call repeatedly —
 * it no-ops while a start is in flight or already running. Never throws; failures land in the
 * `error` phase so the UI can degrade gracefully.
 */
export async function ensureHotspot(): Promise<void> {
  if (inFlight || sharedState.phase === 'running') {
    return;
  }
  if (!isHotspotSupported()) {
    publish({
      phase: 'error',
      error: 'Hotspot control is only available on the Android host build.',
    });
    return;
  }

  const myGen = ++generation;
  inFlight = true;
  publish({ phase: 'requesting' });
  try {
    const granted = await requestHotspotPermissions();
    if (myGen !== generation) {
      // Superseded during the permission dialog. Nothing native has started yet, so just bail.
      return;
    }
    if (!granted) {
      publish({
        phase: 'error',
        error:
          'Location permission is needed to start the hotspot. LOAM is still reachable to anyone already on this network.',
      });
      return;
    }

    publish({ phase: 'starting' });
    const credentials = await startWithTimeout();
    if (myGen !== generation) {
      // A shutdown (or newer start) landed while we were starting: release the hotspot we just
      // created rather than publishing stale "running" over the newer state.
      stopHotspot();
      return;
    }
    publish({ phase: 'running', credentials });
  } catch (error) {
    if (myGen === generation) {
      publish({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    // Only clear the flag if we're still the current attempt — a newer start owns it otherwise.
    if (myGen === generation) {
      inFlight = false;
    }
  }
}

/** Stop the hotspot and return to idle, invalidating any in-flight start. */
export function shutdownHotspot(): void {
  // Bumping the generation cancels an in-flight start (its late resolve releases its own reservation).
  generation += 1;
  inFlight = false;
  stopHotspot();
  publish({ phase: 'idle' });
}

/** Subscribe a component to the shared hotspot state. */
export function useHotspot(): HotspotState {
  const [state, setState] = useState<HotspotState>(sharedState);
  useEffect(() => {
    listeners.add(setState);
    // Re-sync in case the shared state changed between render and effect.
    setState(sharedState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
