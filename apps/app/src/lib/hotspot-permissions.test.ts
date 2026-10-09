import { describe, expect, it } from 'vitest';

import {
  NEARBY_WIFI_DEVICES_API_LEVEL,
  hotspotPermissionsToRequest,
  hotspotStartPermitted,
  type HotspotPermission,
} from './hotspot-permissions';

const granted = (...names: HotspotPermission[]): ReadonlySet<HotspotPermission> => new Set(names);

describe('hotspotPermissionsToRequest', () => {
  it('asks for fine and coarse location together on every API level', () => {
    for (const apiLevel of [0, 24, 29, 30, 31, 32, 33, 34, 35, 36]) {
      const wanted = hotspotPermissionsToRequest(apiLevel);
      expect(wanted, `API ${apiLevel}`).toContain('ACCESS_FINE_LOCATION');
      expect(wanted, `API ${apiLevel}`).toContain('ACCESS_COARSE_LOCATION');
      expect(new Set(wanted).size, `API ${apiLevel}`).toBe(wanted.length);
    }
  });

  it('adds NEARBY_WIFI_DEVICES from API 33 only', () => {
    expect(NEARBY_WIFI_DEVICES_API_LEVEL).toBe(33);
    expect(hotspotPermissionsToRequest(32)).toEqual(['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']);
    expect(hotspotPermissionsToRequest(33)).toEqual([
      'ACCESS_FINE_LOCATION',
      'ACCESS_COARSE_LOCATION',
      'NEARBY_WIFI_DEVICES',
    ]);
    expect(hotspotPermissionsToRequest(35)).toContain('NEARBY_WIFI_DEVICES');
  });

  it('treats an unknown API level as pre-33', () => {
    expect(hotspotPermissionsToRequest(0)).toEqual(hotspotPermissionsToRequest(32));
  });
});

describe('hotspotStartPermitted', () => {
  it('below API 33 needs fine location; approximate-only is a denial', () => {
    for (const apiLevel of [0, 29, 31, 32]) {
      expect(hotspotStartPermitted(apiLevel, granted('ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'))).toBe(true);
      expect(hotspotStartPermitted(apiLevel, granted('ACCESS_FINE_LOCATION'))).toBe(true);
      expect(hotspotStartPermitted(apiLevel, granted('ACCESS_COARSE_LOCATION'))).toBe(false);
      expect(hotspotStartPermitted(apiLevel, granted())).toBe(false);
    }
  });

  it('from API 33 NEARBY_WIFI_DEVICES decides and the location answer does not', () => {
    for (const apiLevel of [33, 34, 35]) {
      expect(hotspotStartPermitted(apiLevel, granted('NEARBY_WIFI_DEVICES'))).toBe(true);
      expect(hotspotStartPermitted(apiLevel, granted('NEARBY_WIFI_DEVICES', 'ACCESS_COARSE_LOCATION'))).toBe(true);
      expect(
        hotspotStartPermitted(apiLevel, granted('NEARBY_WIFI_DEVICES', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION')),
      ).toBe(true);
      expect(hotspotStartPermitted(apiLevel, granted('ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'))).toBe(false);
      expect(hotspotStartPermitted(apiLevel, granted())).toBe(false);
    }
  });

  it('never passes on a grant the flow would not have asked for', () => {
    // A granted NEARBY_WIFI_DEVICES is impossible below API 33 (the permission does not exist there), and
    // the rule must not lean on it: fine location is still what counts.
    expect(hotspotStartPermitted(32, granted('NEARBY_WIFI_DEVICES'))).toBe(false);
  });
});
