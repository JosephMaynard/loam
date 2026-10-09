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
import { awaitWithin } from '@/lib/await-within';
import {
  eligibleHotspotCandidates,
  mergeHotspotCandidates,
  pickHotspotAddress,
  type HostInterface,
} from '@/lib/hotspot-address';
import { t } from '@/lib/i18n';

/**
 * Lifecycle of the local-only hotspot:
 * - `idle`       — not started yet.
 * - `requesting` — asking for the runtime location/nearby-WiFi permission.
 * - `starting`   — permission granted, waiting on `WifiManager.LocalOnlyHotspot`.
 * - `running`    — up; `credentials` holds the generated SSID + password, and the address fields below
 *                  fill in as the hotspot's (randomly assigned) address is found.
 * - `error`      — couldn't start (permission denied or unanswered, no WiFi hardware, driver failure);
 *                  `error` holds a human-readable reason. LOAM's Step-2 URL QR is still shown (docs/04).
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
  /** True once a connected joiner's address proved `address` is the interface serving the hotspot. */
  addressConfirmed?: boolean;
};

// --- Second source + proof, fed by the host screen (index.tsx) from the launcher's `loam-hostinfo` ------
// The launcher's own interface enumeration (a different code path to the same kernel data) and the peer
// addresses of the devices currently connected to the server. Module-scoped like the hotspot state, so a
// remount never loses them.
let latestLauncherInterfaces: HostInterface[] = [];
let launcherInterfacesReceived = false;
// The launcher's list as it stood just before the CURRENT hotspot start — the launcher-side twin of the
// native module's pre-start snapshot. `undefined` when no list had arrived by then (then a launcher-only
// candidate can't be called "new", so it never gets that score).
let launcherSnapshot: string[] | undefined;
let latestClients: string[] = [];
// The native module's last candidate list, so a launcher/client update can re-run the pick at once.
let lastNativeCandidates: HotspotAddressCandidate[] = [];

/** The launcher reported its interfaces (every ~5 s and on request). Re-picks immediately while running. */
export function noteLauncherInterfaces(interfaces: HostInterface[]): void {
  latestLauncherInterfaces = interfaces;
  launcherInterfacesReceived = true;
  repickAddress();
}

/** The launcher reported who is connected from off this phone. Re-picks immediately while running. */
export function noteConnectedClients(clients: string[]): void {
  latestClients = clients;
  repickAddress();
}

/** Re-run the address decision over everything known now, without touching the probe schedule. */
function repickAddress(): void {
  if (sharedState.phase !== 'running') {
    return;
  }
  decideAddress(sharedState.addressSearch === 'settled');
}

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
      reject(new Error(t('hotspot.startTimeout')));
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

// How long to wait for the permission dialog's answer. Android can dismiss a runtime-permission request
// without ever resolving it (another permission dialog opened over it, the activity recreated under it);
// unbounded, that would keep `inFlight` set and the phase at `requesting` for the rest of the process, so
// every later `ensureHotspot` would no-op. Generous, since the operator may be reading the dialog.
const PERMISSION_TIMEOUT_MS = 60_000;

/** The permission dialog's outcome; `timeout` when no answer came back within `PERMISSION_TIMEOUT_MS`. */
type PermissionOutcome = 'granted' | 'denied' | 'timeout';

/**
 * Request the runtime permissions LocalOnlyHotspot needs. ACCESS_FINE_LOCATION is always required;
 * API 33+ also gates it behind NEARBY_WIFI_DEVICES. `granted` only if every requested permission was.
 */
async function requestHotspotPermissions(): Promise<PermissionOutcome> {
  if (Platform.OS !== 'android') {
    return 'denied';
  }
  const wanted: (keyof typeof PermissionsAndroid.PERMISSIONS)[] = ['ACCESS_FINE_LOCATION'];
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  if (apiLevel >= 33) {
    wanted.push('NEARBY_WIFI_DEVICES');
  }
  const permissions = wanted.map((name) => PermissionsAndroid.PERMISSIONS[name]);
  const answer = await awaitWithin(PermissionsAndroid.requestMultiple(permissions), PERMISSION_TIMEOUT_MS);
  if (answer.timedOut) {
    return 'timeout';
  }
  return permissions.every((permission) => answer.value[permission] === PermissionsAndroid.RESULTS.GRANTED)
    ? 'granted'
    : 'denied';
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
    publish({ phase: 'error', error: t('hotspot.unsupported') });
    return;
  }
  subscribeToSystemStops();

  const myGen = ++generation;
  inFlight = true;
  publish({ phase: 'requesting' });
  try {
    const permission = await requestHotspotPermissions();
    if (myGen !== generation) {
      // Superseded during the permission dialog. Nothing native has started yet, so just bail.
      return;
    }
    if (permission !== 'granted') {
      // A timed-out request leaves nothing in flight (`finally` below clears the guard): reopening the
      // screen calls `ensureHotspot` again, which asks again, and an answer given meanwhile is just granted.
      publish({
        phase: 'error',
        error: permission === 'timeout' ? t('hotspot.permissionTimeout') : t('hotspot.permissionDenied'),
      });
      return;
    }

    publish({ phase: 'starting' });
    // Twin of the native pre-start snapshot: what the launcher saw before the hotspot existed.
    launcherSnapshot = launcherInterfacesReceived ? latestLauncherInterfaces.map((entry) => entry.address) : undefined;
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
const ADDRESS_PROBE_AT_MS = [0, 500, 1000, 2000, 3000, 5000, 8000, 12000, 16000, 20000];
// After the burst, keep re-checking for as long as the hotspot runs — briskly for the first minute (an
// address that only turned up late), then slowly (an address the stack reassigns without stopping the
// hotspot). Cheap: one interface enumeration per tick.
const ADDRESS_RECHECK_EARLY_MS = 5_000;
const ADDRESS_RECHECK_EARLY_UNTIL_MS = 60_000;
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
  lastNativeCandidates = [];
  for (;;) {
    const inBurst = probe < ADDRESS_PROBE_AT_MS.length;
    const dueAt = inBurst
      ? ADDRESS_PROBE_AT_MS[probe]
      : elapsed + (elapsed < ADDRESS_RECHECK_EARLY_UNTIL_MS ? ADDRESS_RECHECK_EARLY_MS : ADDRESS_RECHECK_INTERVAL_MS);
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
    lastNativeCandidates = raw;
    probe += 1;
    if (decideAddress(probe >= ADDRESS_PROBE_AT_MS.length)) {
      // Found: the burst is over whatever probe this was; only the re-check continues.
      probe = ADDRESS_PROBE_AT_MS.length;
    }
  }
}

/**
 * The address decision over everything known now — the native candidates, the launcher's list (with its
 * own pre-start snapshot) and the connected joiners — published into the running state. Returns whether
 * an address was chosen.
 */
function decideAddress(settled: boolean): boolean {
  const merged = mergeHotspotCandidates(lastNativeCandidates, latestLauncherInterfaces, launcherSnapshot);
  const pick = pickHotspotAddress(merged, { clientAddresses: latestClients });
  publishAddress({
    address: pick?.candidate.address,
    addressInterface: pick?.candidate.name,
    candidates: eligibleHotspotCandidates(merged),
    addressSearch: settled || pick ? 'settled' : 'searching',
    addressConfirmed: pick?.confirmed ?? false,
  });
  return pick !== undefined;
}

/** Merge address findings into the running state, publishing only on a real change (re-renders cost). */
function publishAddress(
  next: Pick<HotspotState, 'address' | 'addressInterface' | 'candidates' | 'addressSearch' | 'addressConfirmed'>,
): void {
  const current = sharedState;
  if (current.phase !== 'running') {
    return;
  }
  const unchanged =
    current.address === next.address &&
    current.addressInterface === next.addressInterface &&
    current.addressSearch === next.addressSearch &&
    current.addressConfirmed === next.addressConfirmed &&
    JSON.stringify(current.candidates ?? []) === JSON.stringify(next.candidates ?? []);
  if (unchanged) {
    return;
  }
  if (current.address !== next.address || current.addressConfirmed !== next.addressConfirmed) {
    // One line in logcat (ReactNativeJS) per decision change — the evidence a bug report from another
    // phone needs. Addresses are the host's own; nothing about joiners is logged.
    console.log(
      `[loam-hotspot] address ${next.address ?? 'unknown'} on ${next.addressInterface ?? '-'}` +
        `${next.addressConfirmed ? ' (confirmed by a joiner)' : ''}; candidates: ` +
        (next.candidates ?? []).map((candidate) => `${candidate.name} ${candidate.address}`).join(', '),
    );
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
    publish({ phase: 'error', error: t('hotspot.systemStopped') });
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
