// React Native wiring for the foreground host service controller (see host-service-controller.ts).
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import { startHostService } from '../../modules/loam-hotspot';
import { createHostServiceController, type NotificationPermissionResult } from './host-service-controller';

/** Ask for POST_NOTIFICATIONS (API 33+). Never throws; a missing constant or a failed prompt is 'unavailable'. */
async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) {
    return 'unavailable';
  }
  try {
    const result = await PermissionsAndroid.request(permission, {
      title: 'Show the hosting notification?',
      message:
        'While LOAM hosts, Android shows a “LOAM is hosting” notification so you can see it is running and ' +
        'return to it. Hosting works either way.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

const controller = createHostServiceController({
  apiLevel: Platform.OS === 'android' && typeof Platform.Version === 'number' ? Platform.Version : 0,
  isAppActive: () => AppState.currentState === 'active',
  requestNotificationPermission,
  startService: startHostService,
});

/** (Re)start the foreground host service — idempotent, never rejects. See host-service-controller.ts. */
export function ensureHostService(options?: { prompt?: boolean }): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return Promise.resolve(false);
  }
  return controller.ensure(options);
}

/** Whether the operator declined the hosting notification (the FGS still runs; its notice is hidden). */
export function hostingNotificationDenied(): boolean {
  return controller.notificationPermission() === 'denied';
}
