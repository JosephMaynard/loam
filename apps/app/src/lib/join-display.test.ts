import { describe, expect, it } from 'vitest';

import type { HotspotState } from '@/hooks/use-hotspot';

import { deriveJoinDisplay, parseHostClients, parseHostInterfaces, toHostPanelState } from './join-display';

const creds = { ssid: 'AndroidShare_9899', password: 'rwjvn2hsvwjkhyq' };
const homeWifi = ['192.168.86.23'];

function running(extra: Partial<HotspotState> = {}): HotspotState {
  return { phase: 'running', credentials: creds, addressSearch: 'searching', ...extra };
}

describe('deriveJoinDisplay', () => {
  it('advertises the discovered hotspot address with the key fragment, no LAN fallbacks, and the joiner count', () => {
    const display = deriveJoinDisplay({
      hotspot: running({
        address: '10.71.3.140',
        addressInterface: 'swlan0',
        candidates: [{ name: 'swlan0', address: '10.71.3.140', upstream: false, preexisting: false }],
        addressSearch: 'settled',
      }),
      addresses: homeWifi,
      connectedClients: ['10.71.3.5', '10.71.3.5', '10.71.3.9'],
      fragment: '#k=abc',
    });
    expect(display).toEqual({
      serverUrl: 'http://10.71.3.140:3000#k=abc',
      addresses: [],
      detected: ['swlan0 10.71.3.140'],
      connectedClients: 2,
      fragment: '#k=abc',
    });
  });

  it('builds no URL while the search is still running, even though the launcher knows addresses', () => {
    const display = deriveJoinDisplay({ hotspot: running(), addresses: homeWifi, connectedClients: [], fragment: '' });
    expect(display.serverUrl).toBeUndefined();
    expect(display.addresses).toEqual([]);
  });

  it('never advertises the home-WiFi address as the hotspot (STA+AP)', () => {
    const display = deriveJoinDisplay({
      hotspot: running({ addressSearch: 'settled', candidates: [] }),
      addresses: homeWifi,
      connectedClients: [],
      fragment: '',
    });
    expect(display.serverUrl).toBeUndefined();
  });

  it('uses the launcher LAN address (with fallbacks) when the hotspot is not running', () => {
    const display = deriveJoinDisplay({
      hotspot: { phase: 'error', error: 'no radio' },
      addresses: homeWifi,
      connectedClients: ['192.168.86.40'],
      fragment: '#k=abc',
    });
    expect(display.serverUrl).toBe('http://192.168.86.23:3000#k=abc');
    expect(display.addresses).toEqual(homeWifi);
    expect(display.connectedClients).toBe(1);
  });
});

describe('toHostPanelState', () => {
  const base = { addresses: [], detected: ['wlan0 192.168.86.23'], connectedClients: 0, fragment: '#k=abc' };

  it('reports "searching" then "unknown" while running without a URL, and neither once one exists', () => {
    const display = { ...base, serverUrl: undefined };
    expect(toHostPanelState(running(), display)).toMatchObject({ mode: 'hotspot', status: 'running', hotspotAddress: 'searching' });
    expect(toHostPanelState(running({ addressSearch: 'settled' }), display)).toMatchObject({
      status: 'running',
      hotspotAddress: 'unknown',
      detected: ['wlan0 192.168.86.23'],
      manualFragment: '#k=abc',
    });
    expect(
      toHostPanelState(running({ addressSearch: 'settled' }), { ...display, serverUrl: 'http://10.71.3.140:3000', connectedClients: 1 }),
    ).toMatchObject({ status: 'running', serverUrl: 'http://10.71.3.140:3000', hotspotAddress: undefined, connectedClients: 1 });
  });

  it('keeps Step 2 (the LAN URL) when the hotspot failed, and shows starting otherwise', () => {
    const display = { ...base, serverUrl: 'http://192.168.86.23:3000', addresses: homeWifi, detected: [] };
    expect(toHostPanelState({ phase: 'error', error: 'denied' }, display)).toEqual({
      mode: 'hotspot',
      status: 'stopped',
      hotspotError: 'denied',
      serverUrl: 'http://192.168.86.23:3000',
      addresses: homeWifi,
      connectedClients: 0,
    });
    expect(toHostPanelState({ phase: 'starting' }, display)).toEqual({
      mode: 'hotspot',
      status: 'starting',
      serverUrl: 'http://192.168.86.23:3000',
      addresses: homeWifi,
      connectedClients: 0,
    });
  });
});

describe('parseHostInterfaces', () => {
  it('keeps well-formed entries (with a sane prefix) and drops the rest', () => {
    expect(
      parseHostInterfaces([
        { name: 'wlan0', address: '192.168.86.23', prefixLength: 24, extra: true },
        { name: 'swlan0', address: '10.80.217.150', prefixLength: '24' },
        { name: 'ap0', address: '10.1.1.1', prefixLength: 40 },
        { name: 'x' },
        { address: '10.0.0.1' },
        'wlan0 10.0.0.1',
        null,
      ]),
    ).toEqual([
      { name: 'wlan0', address: '192.168.86.23', prefixLength: 24 },
      { name: 'swlan0', address: '10.80.217.150' },
      { name: 'ap0', address: '10.1.1.1' },
    ]);
    expect(parseHostInterfaces(undefined)).toEqual([]);
    expect(parseHostInterfaces({})).toEqual([]);
  });
});

describe('parseHostClients', () => {
  it('returns the strings of an array and undefined for a tick the launcher could not ask', () => {
    expect(parseHostClients(['10.80.217.5', 7, '', '10.80.217.9'])).toEqual(['10.80.217.5', '10.80.217.9']);
    expect(parseHostClients(null)).toBeUndefined();
    expect(parseHostClients(undefined)).toBeUndefined();
  });
});
