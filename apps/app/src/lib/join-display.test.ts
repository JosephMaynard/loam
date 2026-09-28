import { describe, expect, it } from 'vitest';

import type { HotspotState } from '@/hooks/use-hotspot';

import { deriveJoinDisplay, parseHostInterfaces, toHostPanelState } from './join-display';

const creds = { ssid: 'AndroidShare_9899', password: 'rwjvn2hsvwjkhyq' };
const homeWifi = ['192.168.86.23'];
const launcher = [
  { name: 'wlan0', address: '192.168.86.23' },
  { name: 'swlan0', address: '10.71.3.140' },
];

function running(extra: Partial<HotspotState> = {}): HotspotState {
  return { phase: 'running', credentials: creds, addressSearch: 'searching', ...extra };
}

describe('deriveJoinDisplay', () => {
  it('advertises the natively discovered hotspot address with the key fragment, and no LAN fallbacks', () => {
    const display = deriveJoinDisplay({
      hotspot: running({
        address: '10.71.3.140',
        addressInterface: 'swlan0',
        candidates: [{ name: 'swlan0', address: '10.71.3.140', upstream: false, preexisting: false }],
        addressSearch: 'settled',
      }),
      addresses: homeWifi,
      interfaces: launcher,
      fragment: '#k=abc',
    });
    expect(display).toEqual({
      serverUrl: 'http://10.71.3.140:3000#k=abc',
      addresses: [],
      detected: ['swlan0 10.71.3.140'],
    });
  });

  it('builds no URL while the native search is still running, even though the launcher knows addresses', () => {
    const display = deriveJoinDisplay({ hotspot: running(), addresses: homeWifi, interfaces: launcher, fragment: '' });
    expect(display.serverUrl).toBeUndefined();
    expect(display.addresses).toEqual([]);
  });

  it('falls back to the launcher list only once the native search settled with nothing at all', () => {
    const display = deriveJoinDisplay({
      hotspot: running({ addressSearch: 'settled', candidates: [] }),
      addresses: homeWifi,
      interfaces: launcher,
      fragment: '',
    });
    expect(display.serverUrl).toBe('http://10.71.3.140:3000');
    expect(display.detected).toEqual(['wlan0 192.168.86.23', 'swlan0 10.71.3.140']);
  });

  it('does not let the launcher list override a native enumeration that found candidates but no sure pick', () => {
    // Native saw the interfaces but nothing cleared the bar (e.g. every address pre-existed): the launcher's
    // weaker view of the same interfaces must not manufacture confidence.
    const display = deriveJoinDisplay({
      hotspot: running({
        addressSearch: 'settled',
        candidates: [{ name: 'wlan0', address: '192.168.86.23', upstream: false, preexisting: true }],
      }),
      addresses: homeWifi,
      interfaces: launcher,
      fragment: '',
    });
    expect(display.serverUrl).toBeUndefined();
    expect(display.detected).toEqual(['wlan0 192.168.86.23']);
  });

  it('never advertises the home-WiFi address as the hotspot (STA+AP)', () => {
    const display = deriveJoinDisplay({
      hotspot: running({ addressSearch: 'settled', candidates: [] }),
      addresses: homeWifi,
      interfaces: [{ name: 'wlan0', address: '192.168.86.23' }],
      fragment: '',
    });
    expect(display.serverUrl).toBeUndefined();
  });

  it('uses the launcher LAN address (with fallbacks) when the hotspot is not running', () => {
    const display = deriveJoinDisplay({
      hotspot: { phase: 'error', error: 'no radio' },
      addresses: homeWifi,
      interfaces: launcher,
      fragment: '#k=abc',
    });
    expect(display.serverUrl).toBe('http://192.168.86.23:3000#k=abc');
    expect(display.addresses).toEqual(homeWifi);
  });
});

describe('toHostPanelState', () => {
  it('reports "searching" then "unknown" while running without a URL, and neither once one exists', () => {
    const display = { serverUrl: undefined, addresses: [], detected: ['wlan0 192.168.86.23'] };
    expect(toHostPanelState(running(), display)).toMatchObject({ status: 'running', hotspotAddress: 'searching' });
    expect(toHostPanelState(running({ addressSearch: 'settled' }), display)).toMatchObject({
      status: 'running',
      hotspotAddress: 'unknown',
      detected: ['wlan0 192.168.86.23'],
    });
    expect(
      toHostPanelState(running({ addressSearch: 'settled' }), { ...display, serverUrl: 'http://10.71.3.140:3000' }),
    ).toMatchObject({ status: 'running', serverUrl: 'http://10.71.3.140:3000', hotspotAddress: undefined });
  });

  it('keeps Step 2 (the LAN URL) when the hotspot failed, and shows starting otherwise', () => {
    const display = { serverUrl: 'http://192.168.86.23:3000', addresses: homeWifi, detected: [] };
    expect(toHostPanelState({ phase: 'error', error: 'denied' }, display)).toEqual({
      status: 'stopped',
      hotspotError: 'denied',
      serverUrl: 'http://192.168.86.23:3000',
      addresses: homeWifi,
    });
    expect(toHostPanelState({ phase: 'starting' }, display)).toEqual({
      status: 'starting',
      serverUrl: 'http://192.168.86.23:3000',
      addresses: homeWifi,
    });
  });
});

describe('parseHostInterfaces', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      parseHostInterfaces([
        { name: 'wlan0', address: '192.168.86.23', extra: true },
        { name: 'x' },
        { address: '10.0.0.1' },
        'wlan0 10.0.0.1',
        null,
      ]),
    ).toEqual([{ name: 'wlan0', address: '192.168.86.23' }]);
    expect(parseHostInterfaces(undefined)).toEqual([]);
    expect(parseHostInterfaces({})).toEqual([]);
  });
});
