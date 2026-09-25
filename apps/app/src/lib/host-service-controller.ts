// Keeps the foreground host service (LoamHostService — notification + partial wake lock) running while
// the app hosts. Pure (dependencies injected) so it's unit-testable without React Native; the RN wiring
// lives in host-service.ts.
//
// WHY RE-START REPEATEDLY (pre-release review 2026-09-25): the service used to be started exactly once, on
// the launcher's `ready`. Cold start takes ~80 s, and on API 31+ `startForegroundService` from the
// background throws ForegroundServiceStartNotAllowedException — caught and logged natively, so an operator
// who switched away during boot got no service and no wake lock, and Android froze the host once the
// screen went off. Starting is idempotent on the native side (a second start just re-posts the same
// notification; the wake lock is guarded), so callers invoke `ensure()` on every moment the app is
// certainly in the foreground: ready, AppState → active, the share overlay opening, the hotspot starting.
//
// POST_NOTIFICATIONS (API 33+) is a runtime permission. Without it the FGS still runs, but its "LOAM is
// hosting" notification is hidden from the shade. It is requested once per process, only while the app is
// active (a prompt needs a foreground activity), and BEFORE the first start. Denial never blocks hosting.

export type NotificationPermissionResult = 'granted' | 'denied' | 'unavailable';

export type HostServiceDeps = {
  /** Android API level (0 when unknown / not Android). */
  apiLevel: number;
  /** Whether the app is in the foreground right now (AppState 'active'). */
  isAppActive: () => boolean;
  /** Ask for POST_NOTIFICATIONS; must never throw. */
  requestNotificationPermission: () => Promise<NotificationPermissionResult>;
  /** Start (or re-start) the native foreground service. Returns false when the platform refused. */
  startService: () => boolean;
};

export type HostServiceController = {
  /** Start the service if possible (idempotent; safe to call often). Resolves with whether the native
   * start call succeeded. Never rejects. `prompt: false` skips the one-time notification prompt — for a
   * moment where another permission dialog (the hotspot's) may be about to show. */
  ensure: (options?: { prompt?: boolean }) => Promise<boolean>;
  /** The POST_NOTIFICATIONS outcome, once asked (undefined before the first prompt). */
  notificationPermission: () => NotificationPermissionResult | undefined;
};

/** Build a controller over injected platform dependencies. */
export function createHostServiceController(deps: HostServiceDeps): HostServiceController {
  let permission: NotificationPermissionResult | undefined;
  let permissionRequest: Promise<void> | undefined;

  async function askForNotificationsOnce(): Promise<void> {
    if (permission !== undefined || deps.apiLevel < 33 || !deps.isAppActive()) {
      return;
    }
    if (!permissionRequest) {
      permissionRequest = deps
        .requestNotificationPermission()
        .then((result) => {
          permission = result;
        })
        .catch(() => {
          permission = 'unavailable';
        })
        .finally(() => {
          permissionRequest = undefined;
        });
    }
    await permissionRequest;
  }

  async function ensure(options?: { prompt?: boolean }): Promise<boolean> {
    if (options?.prompt !== false) {
      await askForNotificationsOnce();
    }
    if (deps.apiLevel >= 31 && !deps.isAppActive()) {
      // Starting from the background is exactly what API 31+ refuses; the next AppState → active retries.
      return false;
    }
    try {
      return deps.startService();
    } catch {
      return false;
    }
  }

  return { ensure, notificationPermission: () => permission };
}
