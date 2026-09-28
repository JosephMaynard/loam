import { wifiPayload } from '@loam/qr';
import { StyleSheet } from 'react-native';

import { QRCode } from './qr-code';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import type { HostMode } from '@/lib/host-mode';

/** Live host state, supplied by the embedded server + hotspot native module (initiative 4). */
export type HotspotInfo = {
  ssid: string;
  password: string;
};

export type HostState = {
  /**
   * How joiners reach this host (docs/04 "Hosting modes"): `hotspot` — the phone's own LocalOnlyHotspot,
   * the two-step flow; `wifi` — the Wi-Fi network the phone is already on, one URL QR.
   */
  mode: HostMode;
  /** Wi-Fi mode: `starting` until the Wi-Fi state is first read, `running` with an address to advertise,
   * `stopped` while the phone is on no Wi-Fi network. */
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
  /**
   * Why Step 2 has no URL while the hotspot is up: its (randomly assigned) address is still being looked
   * for, or couldn't be told apart from the phone's other networks — then Step 2 shows the manual route
   * (the joiner's Wi-Fi "Gateway" address) instead of a QR to a guess.
   */
  hotspotAddress?: 'searching' | 'unknown';
  /** Every address the host currently holds that could be the hotspot's, `interface address` each, for
   * the manual fallback. */
  detected?: string[];
  /** Devices connected to LOAM from off this phone right now — the proof the join path works. */
  connectedClients?: number;
  /** The transport `#k=` fragment, appended to the manual-route URL so a hardened node still admits it. */
  manualFragment?: string;
  /** Wi-Fi mode: the network's name, only when Android lets the app read it without a permission prompt. */
  wifiNetwork?: string;
};

/** "1 phone connected" / "3 phones connected". */
export function connectedLabel(count: number): string {
  return `${count} ${count === 1 ? 'phone' : 'phones'} connected`;
}

/**
 * The line under the status pill: the live count whenever anyone is connected (shared-WiFi joiners count
 * even while the hotspot is down), a "none yet" while the host is running so the operator knows the count
 * is live, nothing before the host is up.
 */
export function connectedLine(state: Pick<HostState, 'status' | 'connectedClients'>): string | undefined {
  const count = state.connectedClients ?? 0;
  if (count > 0) {
    return connectedLabel(count);
  }
  return state.status === 'running' ? 'No phones connected yet' : undefined;
}

const STATUS_LABEL: Record<HostMode, Record<HostState['status'], string>> = {
  hotspot: {
    starting: 'Starting host…',
    running: 'Host running',
    stopped: 'Host stopped',
  },
  wifi: {
    starting: 'Starting host…',
    running: 'Hosting on Wi-Fi',
    stopped: 'Not on Wi-Fi',
  },
};

/**
 * The LOAM host screen: join status plus, per mode, the settled two-step QR flow (hotspot: step 1
 * connects a phone to the hotspot, step 2 opens LOAM) or a single URL QR (Wi-Fi: everyone already on the
 * phone's network opens LOAM directly) — docs/04.
 *
 * Purely presentational: it renders whatever `state` it is given. The QR codes are real; the values
 * behind them arrive from the hotspot module and embedded server as those land.
 */
export function HostPanel({ state }: { state: HostState }) {
  const line = connectedLine(state);
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title" style={styles.title}>
        LOAM host
      </ThemedText>
      <ThemedView
        type={state.status === 'running' ? 'backgroundSelected' : 'backgroundElement'}
        style={styles.statusPill}>
        <ThemedText type="small">{STATUS_LABEL[state.mode][state.status]}</ThemedText>
      </ThemedView>
      {line ? (
        <ThemedText type="smallBold" style={styles.connected}>
          {line}
        </ThemedText>
      ) : null}
      {state.mode === 'wifi' ? <WifiJoin state={state} /> : <HotspotJoin state={state} />}
    </ThemedView>
  );
}

/** "If that doesn't load, this host is also at: …" — only when there is somewhere else to try. */
function AlsoAt({ addresses }: { addresses?: string[] }) {
  if (!addresses || addresses.length === 0) {
    return null;
  }
  return (
    <ThemedText type="small" themeColor="textSecondary" style={styles.manual}>
      If that doesn&apos;t load, this host is also at: {addresses.join(', ')}
    </ThemedText>
  );
}

/** Wi-Fi mode: one card with the URL QR for everyone on the phone's current Wi-Fi network. No location
 * rationale here — this mode never asks for location permission. */
function WifiJoin({ state }: { state: HostState }) {
  return (
    <ThemedView type="backgroundElement" style={styles.step}>
      <ThemedText type="subtitle">Join on this Wi-Fi</ThemedText>
      {state.serverUrl ? (
        <>
          {state.wifiNetwork ? (
            <ThemedText type="smallBold" style={styles.manual}>
              Network: {state.wifiNetwork}
            </ThemedText>
          ) : null}
          <ThemedText type="small" themeColor="textSecondary" style={styles.manual}>
            Connect to {state.wifiNetwork ? 'that network' : 'the Wi-Fi network this phone is on'}, then scan
            this to open LOAM (or type the address).
          </ThemedText>
          <QRCode value={state.serverUrl} />
          <ThemedText type="code" style={styles.manual}>
            {state.serverUrl}
          </ThemedText>
          <AlsoAt addresses={state.addresses} />
        </>
      ) : state.status === 'starting' ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.pending}>
          Checking this phone&apos;s Wi-Fi connection…
        </ThemedText>
      ) : (
        <>
          <ThemedText type="small" themeColor="textSecondary" style={[styles.manual, styles.pending]}>
            Connect this phone to a Wi-Fi network first. The join code appears here once it is connected.
          </ThemedText>
          <AlsoAt addresses={state.addresses} />
        </>
      )}
      <ThemedText type="small" themeColor="textSecondary" style={styles.manual}>
        Guest, hotel, café and campus Wi-Fi often keep devices from reaching each other. If nobody can
        connect, switch to Hotspot.
      </ThemedText>
    </ThemedView>
  );
}

/** Hotspot mode: the location rationale, Step 1 (join the hotspot) and Step 2 (open LOAM). */
function HotspotJoin({ state }: { state: HostState }) {
  const wifi = state.hotspot ? wifiPayload(state.hotspot.ssid, state.hotspot.password) : undefined;

  return (
    <>
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
            {/* Level M: an SSID + escaped passphrase can exceed level H's version-6 ceiling (docs/15 #10). */}
            <QRCode value={wifi} ecLevel="M" />
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
            <AlsoAt addresses={state.addresses} />
          </>
        ) : state.hotspotAddress === 'searching' ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.pending}>
            Finding the hotspot&apos;s address…
          </ThemedText>
        ) : state.hotspotAddress === 'unknown' ? (
          <>
            <ThemedText type="small" themeColor="textSecondary" style={styles.manual}>
              Couldn&apos;t work out which address the hotspot is using. On the joining phone, open the
              Wi-Fi details for {state.hotspot?.ssid ?? 'this hotspot'}, find the Gateway (or Router)
              address, and open http://that-address:3000{state.manualFragment ?? ''} in the browser.
            </ThemedText>
            {state.detected && state.detected.length > 0 ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.manual}>
                This host&apos;s addresses: {state.detected.join(' · ')}
              </ThemedText>
            ) : null}
          </>
        ) : (
          <ThemedText type="small" themeColor="textSecondary" style={styles.pending}>
            Waiting for the server address…
          </ThemedText>
        )}
      </ThemedView>
    </>
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
  connected: {
    textAlign: 'center',
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
