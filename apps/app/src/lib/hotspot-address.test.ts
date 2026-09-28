import { describe, expect, it } from 'vitest';

import {
  CONFIDENT_SCORE,
  describeHotspotCandidate,
  eligibleHotspotCandidates,
  isPrivateIPv4,
  pickHotspotAddress,
  scoreHotspotCandidate,
  type HotspotAddressCandidate,
} from './hotspot-address';

// The Galaxy S25 Ultra case that motivated this (2026-09-28): the host is on home Wi-Fi (wlan0) AND
// serving a LocalOnlyHotspot on Samsung's `swlan0`, whose random address is nowhere near 192.168.49.1.
const homeWifi: HotspotAddressCandidate = {
  name: 'wlan0',
  address: '192.168.86.23',
  prefixLength: 24,
  upstream: true,
  preexisting: true,
};
const samsungAp: HotspotAddressCandidate = {
  name: 'swlan0',
  address: '10.71.3.140',
  prefixLength: 24,
  upstream: false,
  preexisting: false,
};
const cellular: HotspotAddressCandidate = {
  name: 'rmnet_data0',
  address: '100.72.9.4',
  prefixLength: 29,
  upstream: true,
  preexisting: true,
};

describe('pickHotspotAddress', () => {
  it('picks the interface that appeared with the hotspot over the home Wi-Fi the phone is a client of', () => {
    const pick = pickHotspotAddress([homeWifi, samsungAp, cellular]);
    expect(pick?.candidate).toBe(samsungAp);
    expect(pick?.alternatives).toEqual([]);
  });

  it('never returns 192.168.49.1 or any guess when nothing was enumerated', () => {
    expect(pickHotspotAddress([])).toBeUndefined();
  });

  it('refuses the home Wi-Fi address when it is the only thing visible (the STA+AP bug must not come back)', () => {
    expect(pickHotspotAddress([homeWifi])).toBeUndefined();
    // Even without the upstream flag (launcher-enumerated), a pre-existing wlan0 is not trusted.
    expect(pickHotspotAddress([{ name: 'wlan0', address: '192.168.86.23', preexisting: true }])).toBeUndefined();
  });

  it('trusts a SoftAP-named interface even when the pre-start snapshot is unknown (launcher data)', () => {
    const pick = pickHotspotAddress([
      { name: 'wlan0', address: '192.168.86.23' },
      { name: 'swlan0', address: '192.168.203.117' },
    ]);
    expect(pick?.candidate.address).toBe('192.168.203.117');
    expect(pick?.alternatives.map((c) => c.address)).toEqual(['192.168.86.23']);
  });

  it('trusts a new address on a plainly named interface (a single-radio phone flips wlan0 into AP mode)', () => {
    const pick = pickHotspotAddress([{ name: 'wlan0', address: '172.20.15.9', upstream: false, preexisting: false }]);
    expect(pick?.candidate.address).toBe('172.20.15.9');
  });

  it('does not trust a plainly named, pre-existing-unknown address on its own', () => {
    expect(pickHotspotAddress([{ name: 'wlan0', address: '192.168.4.20' }])).toBeUndefined();
  });

  it('prefers the new address when several interfaces look AP-like', () => {
    const pick = pickHotspotAddress([
      { name: 'ap0', address: '192.168.12.5', upstream: false, preexisting: true },
      { name: 'wlan1', address: '10.9.8.7', upstream: false, preexisting: false },
    ]);
    expect(pick?.candidate.name).toBe('wlan1');
  });

  it('keeps enumeration order on ties', () => {
    const pick = pickHotspotAddress([
      { name: 'ap0', address: '10.1.1.5', upstream: false, preexisting: false },
      { name: 'wlan1', address: '10.2.2.5', upstream: false, preexisting: false },
    ]);
    expect(pick?.candidate.name).toBe('ap0');
    expect(pick?.alternatives.map((c) => c.name)).toEqual(['wlan1']);
  });

  it('accepts a bridged AP (some ROMs put tethering on bridge0)', () => {
    const pick = pickHotspotAddress([{ name: 'bridge0', address: '192.168.50.3', upstream: false, preexisting: false }]);
    expect(pick?.candidate.name).toBe('bridge0');
  });
});

describe('eligibleHotspotCandidates', () => {
  it('drops tunnels, the cellular radio, virtual devices, upstream networks and malformed entries', () => {
    const kept = eligibleHotspotCandidates([
      samsungAp,
      cellular,
      { name: 'tun0', address: '10.8.0.2', upstream: false },
      { name: 'clat4', address: '192.0.0.4' },
      { name: 'v4-rmnet_data0', address: '192.0.0.4' },
      { name: 'wlan1', address: '10.5.5.5', upstream: true },
      { name: 'docker0', address: '172.17.0.1' },
      { name: 'wlan9', address: '' },
      { name: '', address: '10.0.0.5' } as HotspotAddressCandidate,
    ]);
    expect(kept).toEqual([samsungAp]);
  });
});

describe('scoreHotspotCandidate', () => {
  it('clears the confidence bar on either strong signal alone, not on the weak ones', () => {
    expect(scoreHotspotCandidate({ name: 'wlan0', address: '10.0.0.5', preexisting: false })).toBeGreaterThanOrEqual(
      CONFIDENT_SCORE,
    );
    expect(scoreHotspotCandidate({ name: 'swlan0', address: '10.0.0.5' })).toBeGreaterThanOrEqual(CONFIDENT_SCORE);
    expect(scoreHotspotCandidate({ name: 'wlan0', address: '10.0.0.5' })).toBeLessThan(CONFIDENT_SCORE);
    expect(scoreHotspotCandidate({ name: 'swlan0', address: '10.0.0.5', preexisting: true })).toBeLessThan(
      CONFIDENT_SCORE,
    );
  });

  it('treats a non-private address as a mild minus', () => {
    expect(scoreHotspotCandidate({ name: 'swlan0', address: '100.64.0.9' })).toBe(2);
  });
});

describe('isPrivateIPv4', () => {
  it('covers all three RFC 1918 blocks', () => {
    expect(isPrivateIPv4('10.71.3.140')).toBe(true);
    expect(isPrivateIPv4('172.31.9.9')).toBe(true);
    expect(isPrivateIPv4('192.168.203.117')).toBe(true);
    expect(isPrivateIPv4('100.64.0.1')).toBe(false);
    expect(isPrivateIPv4('192.169.0.1')).toBe(false);
  });
});

describe('describeHotspotCandidate', () => {
  it('formats interface then address', () => {
    expect(describeHotspotCandidate(samsungAp)).toBe('swlan0 10.71.3.140');
  });
});
