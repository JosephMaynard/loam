import { describe, expect, it } from 'vitest';

import { hostJoinDisplay, isPrivate10or172, joinUrl, preferredLanAddress } from './join-url';

describe('joinUrl', () => {
  it('targets the discovered hotspot address when the hotspot is running, never a reported LAN address', () => {
    // The STA+AP concurrency case: the host is ALSO on home WiFi (192.168.86.23), which the launcher
    // enumerates, but a joiner on the hotspot cannot reach it. Must use the hotspot's own address.
    expect(joinUrl({ addresses: ['192.168.86.23'], hotspotRunning: true, hotspotAddress: '10.71.3.140' })).toBe(
      'http://10.71.3.140:3000',
    );
  });

  it('builds no URL while the hotspot is running but its address is not known yet (no 192.168.49.1 guess)', () => {
    // Android assigns the hotspot a random address per start; a fixed guess sent joiners to a Wi-Fi Direct
    // address (ERR_ADDRESS_UNREACHABLE on the Galaxy S25 Ultra, 2026-09-28).
    expect(joinUrl({ addresses: ['192.168.86.23'], hotspotRunning: true })).toBeUndefined();
    expect(joinUrl({ addresses: [], hotspotRunning: true })).toBeUndefined();
  });

  it('uses the reported LAN address when the hotspot is NOT running (shared WiFi / Pi / laptop)', () => {
    expect(joinUrl({ addresses: ['192.168.86.23'], hotspotRunning: false })).toBe('http://192.168.86.23:3000');
  });

  it('ignores a stale hotspot address once the hotspot is down', () => {
    expect(joinUrl({ addresses: ['192.168.86.23'], hotspotRunning: false, hotspotAddress: '10.71.3.140' })).toBe(
      'http://192.168.86.23:3000',
    );
  });

  it('builds no URL off the hotspot with no reported address', () => {
    expect(joinUrl({ addresses: [], hotspotRunning: false })).toBeUndefined();
  });

  it('preserves the transport #k= fragment', () => {
    expect(joinUrl({ addresses: [], hotspotRunning: true, hotspotAddress: '10.71.3.140', fragment: '#k=abc123' })).toBe(
      'http://10.71.3.140:3000#k=abc123',
    );
    expect(joinUrl({ addresses: ['10.0.0.5'], hotspotRunning: false, fragment: '#k=xyz' })).toBe(
      'http://10.0.0.5:3000#k=xyz',
    );
  });
});

describe('preferredLanAddress', () => {
  it('prefers a 192.168.* address, then 10/172 private, then anything', () => {
    expect(preferredLanAddress(['10.0.0.5', '192.168.1.10'])).toBe('192.168.1.10');
    expect(preferredLanAddress(['169.254.1.1', '172.16.0.9'])).toBe('172.16.0.9');
    expect(preferredLanAddress(['169.254.1.1'])).toBe('169.254.1.1');
    expect(preferredLanAddress([])).toBeUndefined();
  });

  it('falls back to the first address even if it is public (last resort so a QR renders)', () => {
    expect(preferredLanAddress(['8.8.8.8', '1.1.1.1'])).toBe('8.8.8.8');
  });
});

describe('isPrivate10or172', () => {
  it('accepts 10.0.0.0/8 and the 172.16.0.0/12 block', () => {
    expect(isPrivate10or172('10.0.0.5')).toBe(true);
    expect(isPrivate10or172('172.16.0.0')).toBe(true);
    expect(isPrivate10or172('172.31.255.255')).toBe(true);
  });

  it('rejects addresses just outside 172.16/12 and non-private ranges', () => {
    expect(isPrivate10or172('172.15.0.1')).toBe(false);
    expect(isPrivate10or172('172.32.0.1')).toBe(false);
    expect(isPrivate10or172('192.168.1.1')).toBe(false);
    expect(isPrivate10or172('8.8.8.8')).toBe(false);
  });
});

describe('hostJoinDisplay', () => {
  it('drops the LAN "also at" addresses when the hotspot is running (they are on the wrong network)', () => {
    expect(
      hostJoinDisplay({ addresses: ['192.168.86.23', '10.0.0.9'], hotspotRunning: true, hotspotAddress: '10.71.3.140' }),
    ).toEqual({ serverUrl: 'http://10.71.3.140:3000', addresses: [] });
  });

  it('shows no URL and no fallbacks while the hotspot address is still unknown', () => {
    expect(hostJoinDisplay({ addresses: ['192.168.86.23'], hotspotRunning: true })).toEqual({
      serverUrl: undefined,
      addresses: [],
    });
  });

  it('keeps the reported addresses as fallbacks when off the hotspot', () => {
    expect(hostJoinDisplay({ addresses: ['192.168.86.23'], hotspotRunning: false })).toEqual({
      serverUrl: 'http://192.168.86.23:3000',
      addresses: ['192.168.86.23'],
    });
  });
});
