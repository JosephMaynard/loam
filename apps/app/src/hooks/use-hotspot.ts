import { useSyncExternalStore } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

import {
  addHotspotStoppedListener,
  isHotspotSupported,
  readHotspotAddressCandidates,
  startHotspot,
  stopHotspot,
  type HotspotAddressCandidate,
  type HotspotCredentials,
} from '../../modules/loam-hotspot';
import { eligibleHotspotCandidates, pickHotspotAddress } from '@/lib/hotspot-address';

/**
 * Lifecycle of the local-only hotspot:
 * - `idle`       — not started yet.
 * - `requesting` — asking for the runtime location/nearby-WiFi permission.
 * - `starting`   — permission granted, waiting on `WifiManager.LocalOnlyHotspot`.
 * - `running`    — up; `credentials` holds the generated SSID + password, and the address fields below
 *                  fill in as the hotspot's (randomly assigned) address is found.
 * - `error`      — couldn't start (permission denied, no WiFi hardware, driver failure); `error`
 *                  holds a human-readable reason. LOAM's Step-2 URL QR is still shown (docs/04).
 */
export type HotspotPhase = 'idle' | 'requesting' | 'starting' | 'running' | 'error';

/** `searching` during the burst of probes right after the hotspot comes up; `settled` once that burst is
 * over (found or not — a slow re-check keeps running while the hotspot is up). */
export type HotspotAddressSearch = 'searching' | 'settled';

export type HotspotState = {
  phase: HotspotPhase;
  credentials?: HotspotCredentials;
  error?: string;
  /** The hotspot's own address once found (`running` only) — what the Step-2 join URL must use. */
  address?: string;
  /** The interface `address` sits on (diagnostics). */
  addressInterface?: string;
  /** Every address the host holds that could be the hotspot's, for the manual fallback when none is sure. */
  candidates?: HotspotAddressCandidate[];
  addressSearch?: HotspotAddressSearch;
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
const listeners = new Set<() => void>();

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
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("The hotspot didn't start in time. This device may not support one."));
    }, START_TIMEOUT_MS);
  });

  // Attach a cleanup handler to the real start; if it wins after the timeout, stop the orphan.
  // Either way, clear the timer once start settles so it isn't left armed for ~20s after success.
  void start.then(
    () => {
      clearTimeout(timer);
      if (timedOut) {
        stopHotspot();
      }
    },
    () => {
      clearTimeout(timer);
    },
  );

  return Promise.race([start, timeout]);
}

/** Update the shared state and notify every subscribed hook. */
function publish(next: HotspotState): void {
  sharedState = next;
  for (const listener of listeners) {
    listener();
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
  subscribeToSystemStops();

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
    publish({ phase: 'running', credentials, addressSearch: 'searching' });
    void trackHotspotAddress(myGen);
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

// When to probe for the hotspot's address after it reports `running`, in ms since then. The SoftAP
// interface gets its (random) address from the tethering service a moment AFTER onStarted, so the first
// probes usually miss; the burst covers a slow OEM stack without the operator staring at a blank Step 2.
const ADDRESS_PROBE_AT_MS = [0, 500, 1000, 2000, 3000, 5000, 8000, 12000];
// After the burst, re-check at this cadence for as long as the hotspot runs: cheap, and it catches an
// address the stack reassigns without stopping the hotspot (or one that only turned up late).
const ADDRESS_RECHECK_INTERVAL_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find (and keep finding) the hotspot's own address for the start identified by `myGen`: probe the
 * native candidate list on the burst schedule, then slowly, publishing `address`/`candidates` into the
 * running state whenever they change. Exits as soon as the start is superseded (a shutdown, a newer
 * start, a system stop that moved the phase off `running`). Never throws — the native read resolves
 * `[]` on failure, which surfaces as "couldn't detect" rather than an error.
 */
async function trackHotspotAddress(myGen: number): Promise<void> {
  let probe = 0;
  let elapsed = 0;
  for (;;) {
    const inBurst = probe < ADDRESS_PROBE_AT_MS.length;
    const dueAt = inBurst ? ADDRESS_PROBE_AT_MS[probe] : elapsed + ADDRESS_RECHECK_INTERVAL_MS;
    if (dueAt > elapsed) {
      await sleep(dueAt - elapsed);
      elapsed = dueAt;
    }
    if (myGen !== generation || sharedState.phase !== 'running') {
      return;
    }
    const raw = await readHotspotAddressCandidates();
    if (myGen !== generation || sharedState.phase !== 'running') {
      return;
    }
    probe += 1;
    const pick = pickHotspotAddress(raw);
    if (pick) {
      // Found: the burst is over whatever probe this was; only the slow re-check continues.
      probe = ADDRESS_PROBE_AT_MS.length;
    }
    publishAddress({
      address: pick?.candidate.address,
      addressInterface: pick?.candidate.name,
      candidates: eligibleHotspotCandidates(raw),
      addressSearch: probe >= ADDRESS_PROBE_AT_MS.length ? 'settled' : 'searching',
    });
  }
}

/** Merge address findings into the running state, publishing only on a real change (re-renders cost). */
function publishAddress(next: Pick<HotspotState, 'address' | 'addressInterface' | 'candidates' | 'addressSearch'>): void {
  const current = sharedState;
  if (current.phase !== 'running') {
    return;
  }
  const unchanged =
    current.address === next.address &&
    current.addressInterface === next.addressInterface &&
    current.addressSearch === next.addressSearch &&
    JSON.stringify(current.candidates ?? []) === JSON.stringify(next.candidates ?? []);
  if (unchanged) {
    return;
  }
  publish({ ...current, ...next });
}

// Whether the native "the system stopped the hotspot" listener is installed (once per process — the
// hotspot store is module-scoped, so the subscription is too).
let systemStopSubscribed = false;

/**
 * Reflect a SYSTEM-initiated hotspot stop (review 2026-09-04): Android tears a LocalOnlyHotspot down
 * when the user enables the phone's own tethering (Android permits one or the other), toggles Wi-Fi, or
 * an OEM power policy fires. Previously nothing reached JS, so the phase stayed `running` forever — the
 * share screen kept showing the dead SSID/password QR and the hotspot-gateway join URL, and
 * `ensureHotspot` no-op'd on every reopen. Now the phase becomes an `error` with the reason: the panel
 * shows the LAN join addresses again, and reopening the share screen (which calls `ensureHotspot`, which
 * retries from `error`) starts a fresh hotspot. Deliberately NOT an automatic restart — the stop is
 * usually the operator's own doing (tethering), and fighting it would loop.
 */
function subscribeToSystemStops(): void {
  if (systemStopSubscribed) {
    return;
  }
  systemStopSubscribed = true;
  addHotspotStoppedListener(() => {
    // The native side only reports a stop for the LIVE reservation, and a live reservation only exists in
    // the `running` phase (`ensureHotspot` no-ops while running, so no start is in flight then). Anything
    // else — an explicit `shutdownHotspot` already published `idle`, or a stop that raced a newer start —
    // is ignored; the in-flight start's own generation logic owns that reservation.
    if (sharedState.phase !== 'running') {
      return;
    }
    publish({
      phase: 'error',
      error:
        'The system stopped the hotspot (turning on the phone’s own hotspot/tethering or toggling Wi-Fi does this). ' +
        'Close and reopen this screen to start it again. LOAM is still reachable on any network the phone is on.',
    });
  });
}

/** Stop the hotspot and return to idle, invalidating any in-flight start. */
export function shutdownHotspot(): void {
  // Bumping the generation cancels an in-flight start (its late resolve releases its own reservation).
  generation += 1;
  inFlight = false;
  stopHotspot();
  publish({ phase: 'idle' });
}

/** Subscribe a React tree to the shared hotspot store. */
function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** Subscribe a component to the shared hotspot state (concurrent-safe external store). */
export function useHotspot(): HotspotState {
  return useSyncExternalStore(subscribe, () => sharedState);
}
