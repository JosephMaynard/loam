import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOST_MODE,
  deriveWifiJoinDisplay,
  parseHostMode,
  pickWifiAddress,
  toWifiPanelState,
  type WifiStationInfo,
} from './host-mode';

const home: WifiStationInfo = { connected: true, address: '192.168.86.23', ssid: 'Kitchen' };

describe('parseHostMode', () => {
  it('keeps the two known modes and defaults everything else to hotspot', () => {
    expect(parseHostMode('hotspot')).toBe('hotspot');
    expect(parseHostMode('wifi')).toBe('wifi');
    expect(DEFAULT_HOST_MODE).toBe('hotspot');
    for (const raw of [null, undefined, '', 'WIFI', 'lora', 7, {}]) {
      expect(parseHostMode(raw)).toBe('hotspot');
    }
  });
});

describe('pickWifiAddress', () => {
  it('prefers the native station address over everything the launcher reports', () => {
    expect(
      pickWifiAddress({
        station: home,
        interfaces: [{ name: 'wlan0', address: '10.0.0.5' }],
        addresses: ['10.0.0.5'],
      }),
    ).toBe('192.168.86.23');
  });

  it('falls back to a private wlanN interface (lowest unit first) when the station read is empty', () => {
    expect(
      pickWifiAddress({
        station: { connected: true, address: null },
        interfaces: [
          { name: 'rmnet_data0', address: '10.44.1.9' },
          { name: 'wlan1', address: '192.168.1.50' },
          { name: 'wlan0', address: '192.168.86.23' },
        ],
        addresses: ['10.44.1.9', '192.168.1.50', '192.168.86.23'],
      }),
    ).toBe('192.168.86.23');
  });

  it('ignores a wlan interface with a public or unusable address', () => {
    expect(
      pickWifiAddress({
        station: undefined,
        interfaces: [
          { name: 'wlan0', address: '169.254.10.2' },
          { name: 'wlan1', address: '8.8.8.8' },
        ],
        addresses: [],
      }),
    ).toBeUndefined();
  });

  it('then takes the preferred private LAN address, never one on a cellular interface', () => {
    expect(
      pickWifiAddress({
        // Connected per Android, but the DHCP read came back empty (some ROMs): fall through to the launcher.
        station: { connected: true },
        interfaces: [
          { name: 'rmnet_data0', address: '10.44.1.9' },
          { name: 'eth0', address: '172.20.0.4' },
        ],
        addresses: ['10.44.1.9', '172.20.0.4'],
      }),
    ).toBe('172.20.0.4');
  });

  it('advertises nothing when Android says Wi-Fi is off, whatever else the phone holds (VPN, tether, stale AP)', () => {
    expect(
      pickWifiAddress({
        station: { connected: false },
        interfaces: [
          { name: 'ipsec1', address: '10.8.0.2' },
          { name: 'wlan1', address: '192.168.43.1' },
          { name: 'eth0', address: '172.20.0.4' },
        ],
        addresses: ['10.8.0.2', '192.168.43.1', '172.20.0.4'],
      }),
    ).toBeUndefined();
  });

  it('never advertises the platform IKEv2 VPN tunnel (ipsec<N>) even before the native read', () => {
    expect(
      pickWifiAddress({
        station: undefined,
        interfaces: [{ name: 'ipsec0', address: '10.8.0.2' }],
        addresses: ['10.8.0.2'],
      }),
    ).toBeUndefined();
  });

  it('returns nothing on mobile data alone (Wi-Fi off), including carrier-grade NAT addresses', () => {
    expect(
      pickWifiAddress({
        station: { connected: false },
        interfaces: [
          { name: 'rmnet_data0', address: '10.44.1.9' },
          { name: 'rmnet_data1', address: '100.72.3.4' },
        ],
        addresses: ['10.44.1.9', '100.72.3.4'],
      }),
    ).toBeUndefined();
    expect(pickWifiAddress({ station: undefined, interfaces: [], addresses: [] })).toBeUndefined();
  });

  it('rejects a malformed or unspecified station address', () => {
    for (const address of ['0.0.0.0', '999.1.1.1', 'wlan0', '127.0.0.1']) {
      expect(pickWifiAddress({ station: { connected: true, address }, interfaces: [], addresses: [] })).toBeUndefined();
    }
  });
});

describe('deriveWifiJoinDisplay', () => {
  it('builds the URL with the key fragment, lists the other LAN addresses and counts distinct joiners', () => {
    expect(
      deriveWifiJoinDisplay({
        station: home,
        interfaces: [
          { name: 'wlan0', address: '192.168.86.23' },
          { name: 'rmnet_data0', address: '10.44.1.9' },
          { name: 'eth0', address: '172.20.0.4' },
        ],
        addresses: ['192.168.86.23', '10.44.1.9', '172.20.0.4', '172.20.0.4'],
        connectedClients: ['192.168.86.40', '192.168.86.40', '192.168.86.41'],
        fragment: '#k=abc',
      }),
    ).toEqual({
      serverUrl: 'http://192.168.86.23:3000#k=abc',
      addresses: ['172.20.0.4'],
      ssid: 'Kitchen',
      connectedClients: 2,
      checked: true,
    });
  });

  it('has no URL before the first read or off Wi-Fi, and drops a missing SSID', () => {
    const before = deriveWifiJoinDisplay({ station: undefined, interfaces: [], addresses: [], connectedClients: [], fragment: '' });
    expect(before).toMatchObject({ serverUrl: undefined, checked: false, ssid: undefined });
    const offline = deriveWifiJoinDisplay({
      station: { connected: false, ssid: '' },
      interfaces: [],
      addresses: [],
      connectedClients: [],
      fragment: '',
    });
    expect(offline).toMatchObject({ serverUrl: undefined, checked: true, ssid: undefined });
  });
});

describe('toWifiPanelState', () => {
  const base = { addresses: [], connectedClients: 0 };

  it('is starting before the first read, stopped off Wi-Fi, running with an address', () => {
    expect(toWifiPanelState({ ...base, serverUrl: undefined, ssid: undefined, checked: false })).toEqual({
      mode: 'wifi',
      status: 'starting',
      serverUrl: undefined,
      addresses: [],
      connectedClients: 0,
    });
    expect(toWifiPanelState({ ...base, serverUrl: undefined, ssid: undefined, checked: true })).toMatchObject({
      mode: 'wifi',
      status: 'stopped',
    });
    expect(
      toWifiPanelState({ ...base, serverUrl: 'http://192.168.86.23:3000', ssid: 'Kitchen', checked: true, connectedClients: 3 }),
    ).toEqual({
      mode: 'wifi',
      status: 'running',
      serverUrl: 'http://192.168.86.23:3000',
      addresses: [],
      connectedClients: 3,
      wifiNetwork: 'Kitchen',
    });
  });
});
