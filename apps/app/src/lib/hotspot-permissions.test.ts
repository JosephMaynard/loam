import { describe, expect, it } from 'vitest';

import {
  LOCATION_PERMISSION_MAX_SDK,
  NEARBY_WIFI_DEVICES_API_LEVEL,
  androidApiLevel,
  hotspotAsksForLocation,
  hotspotPermissionsToRequest,
  hotspotStartPermitted,
  type HotspotPermission,
} from './hotspot-permissions';

const granted = (...names: HotspotPermission[]): ReadonlySet<HotspotPermission> => new Set(names);

describe('hotspotPermissionsToRequest', () => {
  it('asks for fine and coarse location together below API 33', () => {
    for (const apiLevel of [0, 24, 29, 30, 31, 32]) {
      expect(hotspotPermissionsToRequest(apiLevel), `API ${apiLevel}`).toEqual([
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
      ]);
    }
  });

  it('asks for NEARBY_WIFI_DEVICES alone from API 33, never location', () => {
    expect(NEARBY_WIFI_DEVICES_API_LEVEL).toBe(33);
    for (const apiLevel of [33, 34, 35, 36]) {
      expect(hotspotPermissionsToRequest(apiLevel), `API ${apiLevel}`).toEqual(['NEARBY_WIFI_DEVICES']);
    }
  });

  it('stops asking for location exactly where the manifest caps it', () => {
    expect(LOCATION_PERMISSION_MAX_SDK).toBe(32);
    expect(hotspotPermissionsToRequest(LOCATION_PERMISSION_MAX_SDK)).toContain('ACCESS_FINE_LOCATION');
    expect(hotspotPermissionsToRequest(LOCATION_PERMISSION_MAX_SDK + 1)).not.toContain('ACCESS_FINE_LOCATION');
    expect(hotspotPermissionsToRequest(LOCATION_PERMISSION_MAX_SDK + 1)).not.toContain('ACCESS_COARSE_LOCATION');
  });

  it('treats an unknown API level as pre-33', () => {
    expect(hotspotPermissionsToRequest(0)).toEqual(hotspotPermissionsToRequest(32));
    expect(androidApiLevel('13')).toBe(0);
    expect(androidApiLevel(undefined)).toBe(0);
    expect(androidApiLevel(35)).toBe(35);
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

  it('from API 33 NEARBY_WIFI_DEVICES decides', () => {
    for (const apiLevel of [33, 34, 35]) {
      expect(hotspotStartPermitted(apiLevel, granted('NEARBY_WIFI_DEVICES'))).toBe(true);
      expect(hotspotStartPermitted(apiLevel, granted('ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'))).toBe(false);
      expect(hotspotStartPermitted(apiLevel, granted())).toBe(false);
    }
  });

  it('is satisfiable by exactly what the request asks for on every level', () => {
    for (const apiLevel of [0, 24, 30, 31, 32, 33, 35]) {
      expect(hotspotStartPermitted(apiLevel, granted(...hotspotPermissionsToRequest(apiLevel))), `API ${apiLevel}`).toBe(true);
    }
  });

  it('never passes on a grant the flow would not have asked for', () => {
    // A granted NEARBY_WIFI_DEVICES is impossible below API 33 (the permission does not exist there), and
    // the rule must not lean on it: fine location is still what counts.
    expect(hotspotStartPermitted(32, granted('NEARBY_WIFI_DEVICES'))).toBe(false);
  });
});

describe('hotspotAsksForLocation', () => {
  it('matches the request, so the rationale and the denial message name the right dialog', () => {
    for (const apiLevel of [0, 24, 31, 32, 33, 35]) {
      expect(hotspotAsksForLocation(apiLevel), `API ${apiLevel}`).toBe(
        hotspotPermissionsToRequest(apiLevel).includes('ACCESS_FINE_LOCATION'),
      );
    }
  });
});
