import { describe, expect, it } from 'vitest';

import {
  CONFIDENT_SCORE,
  describeHotspotCandidate,
  eligibleHotspotCandidates,
  isPrivateIPv4,
  mergeHotspotCandidates,
  pickHotspotAddress,
  scoreHotspotCandidate,
  subnetContains,
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

describe('pickHotspotAddress — client confirmation', () => {
  it('a connected joiner inside a candidate subnet confirms it, even over a higher-scoring rival', () => {
    const pick = pickHotspotAddress(
      [
        { name: 'wlan1', address: '10.9.8.7', prefixLength: 24, upstream: false, preexisting: false },
        { name: 'bridge0', address: '192.168.50.3', prefixLength: 24, upstream: false, preexisting: true },
      ],
      { clientAddresses: ['192.168.50.77'] },
    );
    expect(pick?.candidate.name).toBe('bridge0');
    expect(pick?.confirmed).toBe(true);
  });

  it('confirmation never promotes an upstream interface (a laptop on the home Wi-Fi is not a hotspot joiner)', () => {
    const pick = pickHotspotAddress([homeWifi, samsungAp], { clientAddresses: ['192.168.86.42'] });
    expect(pick?.candidate).toBe(samsungAp);
    expect(pick?.confirmed).toBe(false);
  });

  it('accepts a low-scoring candidate once a joiner has come through it', () => {
    const only: HotspotAddressCandidate = { name: 'wlan0', address: '192.168.4.20', prefixLength: 24 };
    expect(pickHotspotAddress([only])).toBeUndefined();
    expect(pickHotspotAddress([only], { clientAddresses: ['192.168.4.21'] })?.confirmed).toBe(true);
    expect(pickHotspotAddress([only], { clientAddresses: ['192.168.5.21'] })).toBeUndefined();
  });
});

describe('pickHotspotAddress — sole hinted leftover', () => {
  it('takes the one private candidate left after the phone’s own networks were positively ruled out', () => {
    // Odd OEM name, snapshot unavailable, but the native upstream check ran and cleared it.
    const pick = pickHotspotAddress([homeWifi, { name: 'wifi0_ap9', address: '172.30.1.9', upstream: false }]);
    expect(pick?.candidate.address).toBe('172.30.1.9');
  });

  it('does not apply without the native upstream hint, nor to a pre-existing or non-private address', () => {
    expect(pickHotspotAddress([{ name: 'wifi0_ap9', address: '172.30.1.9' }])).toBeUndefined();
    expect(pickHotspotAddress([{ name: 'wifi0_ap9', address: '172.30.1.9', upstream: false, preexisting: true }])).toBeUndefined();
    expect(pickHotspotAddress([{ name: 'wifi0_ap9', address: '100.64.1.9', upstream: false }])).toBeUndefined();
  });

  it('does not apply when more than one eligible candidate is left', () => {
    expect(
      pickHotspotAddress([
        { name: 'wifi0_ap9', address: '172.30.1.9', upstream: false },
        { name: 'eth0', address: '10.4.4.4', upstream: false },
      ]),
    ).toBeUndefined();
  });
});

describe('eligibleHotspotCandidates — other sharing paths are never the hotspot', () => {
  it('drops USB tethering, Bluetooth tethering and Wi-Fi Direct interfaces', () => {
    expect(
      eligibleHotspotCandidates([
        { name: 'rndis0', address: '192.168.42.129', upstream: false, preexisting: false },
        { name: 'usb0', address: '192.168.42.130', upstream: false, preexisting: false },
        { name: 'ncm0', address: '192.168.42.131', upstream: false, preexisting: false },
        { name: 'bt-pan', address: '192.168.44.1', upstream: false, preexisting: false },
        { name: 'p2p-wlan0-0', address: '192.168.49.1', upstream: false, preexisting: false },
        samsungAp,
      ]),
    ).toEqual([samsungAp]);
  });
});

describe('mergeHotspotCandidates', () => {
  it('keeps native hints, adds launcher-only pairs judged against the launcher snapshot', () => {
    const merged = mergeHotspotCandidates(
      [samsungAp],
      [
        { name: 'wlan0', address: '192.168.86.23', prefixLength: 24 },
        { name: 'swlan0', address: '10.71.3.140', prefixLength: 24 },
      ],
      ['192.168.86.23'],
    );
    expect(merged).toEqual([
      samsungAp,
      { name: 'wlan0', address: '192.168.86.23', prefixLength: 24, preexisting: true },
    ]);
  });

  it('fills a missing native pre-existing hint from the snapshot, and a missing prefix from the launcher', () => {
    const merged = mergeHotspotCandidates(
      [{ name: 'swlan0', address: '10.71.3.140', upstream: false, preexisting: null }],
      [{ name: 'swlan0', address: '10.71.3.140', prefixLength: 24 }],
      ['192.168.86.23'],
    );
    expect(merged).toEqual([{ name: 'swlan0', address: '10.71.3.140', upstream: false, preexisting: false, prefixLength: 24 }]);
  });

  it('leaves pre-existing unknown when no launcher snapshot was taken (never fakes "new")', () => {
    const merged = mergeHotspotCandidates([], [{ name: 'wlan0', address: '192.168.86.23' }], undefined);
    expect(merged).toEqual([{ name: 'wlan0', address: '192.168.86.23', preexisting: null }]);
    expect(pickHotspotAddress(merged)).toBeUndefined();
  });
});

describe('subnetContains', () => {
  it('uses the candidate prefix, defaulting to /24', () => {
    const c: HotspotAddressCandidate = { name: 'swlan0', address: '10.80.217.150' };
    expect(subnetContains(c, '10.80.217.5')).toBe(true);
    expect(subnetContains(c, '10.80.218.5')).toBe(false);
    expect(subnetContains({ ...c, prefixLength: 16 }, '10.80.218.5')).toBe(true);
    expect(subnetContains(c, 'fe80::1')).toBe(false);
    expect(subnetContains({ ...c, prefixLength: 0 }, '10.80.217.5')).toBe(false);
  });
});
