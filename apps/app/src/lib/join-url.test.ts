import { describe, expect, it } from 'vitest';

import { HOTSPOT_GATEWAY, joinUrl, preferredLanAddress } from './join-url';

describe('joinUrl', () => {
  it('targets the hotspot gateway when the hotspot is running, even if a LAN address is reported', () => {
    // The STA+AP concurrency bug: the host is ALSO on home WiFi (192.168.86.23), which the launcher
    // enumerates, but a joiner on the hotspot cannot reach it. Must use the gateway.
    expect(joinUrl({ addresses: ['192.168.86.23'], hotspotRunning: true })).toBe(
      `http://${HOTSPOT_GATEWAY}:3000`,
    );
  });

  it('uses the gateway when the hotspot is running and nothing was reported', () => {
    expect(joinUrl({ addresses: [], hotspotRunning: true })).toBe(`http://${HOTSPOT_GATEWAY}:3000`);
  });

  it('uses the reported LAN address when the hotspot is NOT running (shared WiFi / Pi / laptop)', () => {
    expect(joinUrl({ addresses: ['192.168.86.23'], hotspotRunning: false })).toBe(
      'http://192.168.86.23:3000',
    );
  });

  it('falls back to the gateway when off the hotspot with no reported address (QR still renders)', () => {
    expect(joinUrl({ addresses: [], hotspotRunning: false })).toBe(`http://${HOTSPOT_GATEWAY}:3000`);
  });

  it('preserves the transport #k= fragment', () => {
    expect(joinUrl({ addresses: [], hotspotRunning: true, fragment: '#k=abc123' })).toBe(
      `http://${HOTSPOT_GATEWAY}:3000#k=abc123`,
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
});
