// React Native wiring for the foreground host service controller (see host-service-controller.ts).
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import { startHostService, type HostServiceLabels } from '../../modules/loam-hotspot';
import { createHostServiceController, type NotificationPermissionResult } from './host-service-controller';
import { t } from './i18n';

/** Ask for POST_NOTIFICATIONS (API 33+). Never throws; a missing constant or a failed prompt is 'unavailable'. */
async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!permission) {
    return 'unavailable';
  }
  try {
    const result = await PermissionsAndroid.request(permission, {
      title: t('notify.title'),
      message: t('notify.body'),
      buttonPositive: t('notify.allow'),
      buttonNegative: t('notify.notNow'),
    });
    return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * The foreground service's notification text in the app's language. Read at every (re)start, so the
 * notification follows the language chosen in setup; the Kotlin side keeps English defaults for a start
 * that carries no labels.
 */
export function hostServiceLabels(): HostServiceLabels {
  return {
    channelName: t('host.title'),
    channelDescription: t('notify.channelDescription'),
    title: t('notify.hostingTitle'),
    text: t('notify.hostingText'),
  };
}

const controller = createHostServiceController({
  apiLevel: Platform.OS === 'android' && typeof Platform.Version === 'number' ? Platform.Version : 0,
  isAppActive: () => AppState.currentState === 'active',
  requestNotificationPermission,
  startService: () => startHostService(hostServiceLabels()),
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
