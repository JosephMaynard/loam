import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HOTSPOT_ERROR_CODES, hotspotError, hotspotErrorKey } from './hotspot-errors';
import { en } from './i18n/en';

const KOTLIN = readFileSync(
  join(__dirname, '..', '..', 'modules/loam-hotspot/android/src/main/java/expo/modules/loamhotspot/LoamHotspotModule.kt'),
  'utf8',
);

describe('hotspotErrorKey', () => {
  it('maps every code the Kotlin module rejects with to a catalog key', () => {
    const sent = new Set([...KOTLIN.matchAll(/"(ERR_HOTSPOT_[A-Z_]+)"/g)].map((match) => match[1]));
    expect(sent.size).toBeGreaterThan(0);
    for (const code of sent) {
      expect(HOTSPOT_ERROR_CODES, code).toContain(code);
      expect(en[hotspotErrorKey({ code }, 35)], code).toBeTruthy();
    }
  });

  it('never rejects without a code, so no English message can reach the screen', () => {
    const constructions = [...KOTLIN.matchAll(/HotspotException\(([^,]+),/g)].map((match) => match[1].trim());
    expect(constructions.length).toBeGreaterThan(0);
    for (const first of constructions) {
      expect(first).toMatch(/^("ERR_HOTSPOT_[A-Z_]+"|reasonToCode\(reason\)|code: String)$/);
    }
  });

  it('names the permission dialog the running API level shows', () => {
    expect(hotspotErrorKey({ code: 'ERR_HOTSPOT_PERMISSION' }, 32)).toBe('hotspot.permissionDenied');
    expect(hotspotErrorKey({ code: 'ERR_HOTSPOT_PERMISSION' }, 33)).toBe('hotspot.permissionDeniedNearby');
  });

  it('reads anything unknown or uncoded as the generic failure', () => {
    expect(hotspotErrorKey(new Error('Couldn’t start the hotspot: boom'), 35)).toBe('hotspot.errFailed');
    expect(hotspotErrorKey({ code: 'ERR_SOMETHING_ELSE' }, 35)).toBe('hotspot.errFailed');
    expect(hotspotErrorKey('nope', 35)).toBe('hotspot.errFailed');
    expect(hotspotErrorKey(null, 35)).toBe('hotspot.errFailed');
  });

  it('keeps the JS-side timeout its own message', () => {
    expect(hotspotErrorKey(hotspotError('ERR_HOTSPOT_TIMEOUT', 'x'), 35)).toBe('hotspot.startTimeout');
  });
});
