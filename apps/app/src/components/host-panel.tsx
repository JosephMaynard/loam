import { wifiPayload } from '@loam/qr';
import { StyleSheet } from 'react-native';

import { QRCode } from './qr-code';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';

/** Live host state, supplied by the embedded server + hotspot native module (initiative 4). */
export type HotspotInfo = {
  ssid: string;
  password: string;
};

export type HostState = {
  status: 'starting' | 'running' | 'stopped';
  /** Hotspot credentials from `WifiManager.LocalOnlyHotspot` — absent until the module reports them. */
  hotspot?: HotspotInfo;
  /**
   * A human-readable reason the hotspot couldn't start (permission denied, no WiFi hardware on an
   * emulator, a driver failure). When set, Step 1 shows this instead of the "waiting" hint — Step 2
   * still renders so LOAM stays reachable over any existing LAN (docs/04 graceful degradation).
   */
  hotspotError?: string;
  /** The LAN URL where the served client is reachable once the hotspot is up. */
  serverUrl?: string;
  /** All detected host IPv4 addresses, listed under Step 2 so a joiner can try another if needed. */
  addresses?: string[];
};

const STATUS_LABEL: Record<HostState['status'], string> = {
  starting: 'Starting host…',
  running: 'Host running',
  stopped: 'Host stopped',
};

/**
 * The LOAM host screen: shows join status and the settled two-step QR flow —
 * step 1 connects a phone to the hotspot, step 2 opens LOAM once connected (docs/04).
 *
 * Purely presentational: it renders whatever `state` it is given. The QR codes are real; the values
 * behind them arrive from the hotspot module and embedded server as those land.
 */
export function HostPanel({ state }: { state: HostState }) {
  const wifi = state.hotspot ? wifiPayload(state.hotspot.ssid, state.hotspot.password) : undefined;

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title" style={styles.title}>
        LOAM host
      </ThemedText>
      <ThemedView
        type={state.status === 'running' ? 'backgroundSelected' : 'backgroundElement'}
        style={styles.statusPill}>
        <ThemedText type="small">{STATUS_LABEL[state.status]}</ThemedText>
      </ThemedView>

      <ThemedText type="small" themeColor="textSecondary" style={styles.rationale}>
        Android requires location permission to create a WiFi hotspot. LOAM never uses, requests, or
        stores your location — it only turns the hotspot on.
      </ThemedText>

      <ThemedView type="backgroundElement" style={styles.step}>
        <ThemedText type="subtitle">Step 1 · Join the WiFi</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Scan with the phone camera to connect to this host&apos;s hotspot. Keep LOAM open, and
          don&apos;t switch on your phone&apos;s own WiFi hotspot — it replaces this one.
        </ThemedText>
        {wifi ? (
          <>
            <QRCode value={wifi} />
            <ThemedText type="code" style={styles.manual}>
              {state.hotspot?.ssid} · {state.hotspot?.password}
            </ThemedText>
          </>
        ) : state.hotspotError ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.pending}>
            {state.hotspotError}
          </ThemedText>
        ) : (
          <ThemedText type="small" themeColor="textSecondary" style={styles.pending}>
            Waiting for the hotspot… (starts with the host)
          </ThemedText>
        )}
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.step}>
        <ThemedText type="subtitle">Step 2 · Open LOAM</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Once connected, scan this to open the app (or type the address).
        </ThemedText>
        {state.serverUrl ? (
          <>
            <QRCode value={state.serverUrl} />
            <ThemedText type="code" style={styles.manual}>
              {state.serverUrl}
            </ThemedText>
            {state.addresses && state.addresses.length > 0 ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.manual}>
                If that doesn&apos;t load, this host is also at: {state.addresses.join(', ')}
              </ThemedText>
            ) : null}
          </>
        ) : (
          <ThemedText type="small" themeColor="textSecondary" style={styles.pending}>
            Waiting for the server address…
          </ThemedText>
        )}
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
    gap: Spacing.three,
    alignItems: 'center',
  },
  title: {
    textAlign: 'center',
  },
  rationale: {
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
  statusPill: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  step: {
    alignSelf: 'stretch',
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Spacing.four,
    alignItems: 'center',
  },
  manual: {
    textAlign: 'center',
  },
  pending: {
    paddingVertical: Spacing.four,
  },
});
