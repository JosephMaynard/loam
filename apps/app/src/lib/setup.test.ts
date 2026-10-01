import { LoamConfigUpdateSchema, securityProfilePreset } from '@loam/schema';
import { describe, expect, it } from 'vitest';

import { cleanNodeName, hasContinuableNetwork, parseSetupRecord, presetConfig, presetDbMode } from './setup';

describe('presetConfig', () => {
  it('writes a valid config update for every preset', () => {
    for (const preset of ['private', 'community', 'custom'] as const) {
      const config = presetConfig(preset, ' Riverside ', 'fr');
      expect(LoamConfigUpdateSchema.safeParse(config).success, preset).toBe(true);
      expect(config.node).toEqual({ name: 'Riverside', locale: 'fr' });
    }
  });

  it('makes Private anonymous, short-lived, approval-only and encrypted-only', () => {
    const config = presetConfig('private', 'x', 'en') as {
      security: { profile: 'hardened' };
      identity: Record<string, boolean>;
      features: { enablePresence: boolean };
    };
    expect(config.security.profile).toBe('hardened');
    expect(securityProfilePreset('hardened')).toMatchObject({
      joinPolicy: 'approval',
      messageTtlMs: 3_600_000,
      killSwitchEnabled: true,
      transportEncryption: 'required',
    });
    expect(Object.values(config.identity).every((allowed) => !allowed)).toBe(true);
    expect(config.features.enablePresence).toBe(false);
    expect(presetDbMode('private')).toBe('ephemeral');
  });

  it('makes Community named, lasting and open', () => {
    const config = presetConfig('community', 'x', 'en') as {
      security: { profile: 'standard' };
      identity: Record<string, boolean>;
      features: { enablePresence: boolean };
    };
    expect(securityProfilePreset(config.security.profile)).toMatchObject({ joinPolicy: 'open', messageTtlMs: null });
    expect(Object.values(config.identity).every(Boolean)).toBe(true);
    expect(config.features.enablePresence).toBe(true);
    expect(presetDbMode('community')).toBe('persistent');
  });

  it('leaves everything but name and language alone for Custom', () => {
    expect(Object.keys(presetConfig('custom', 'x', 'en'))).toEqual(['node']);
    expect(presetDbMode('custom')).toBeUndefined();
  });
});

describe('joining another network', () => {
  it('adds the scanned node as an enabled, pinned sync peer, for any preset', () => {
    for (const preset of ['private', 'community', 'custom'] as const) {
      const peer = { url: 'http://10.0.0.5:3000', transportKey: 'abc', linkCode: 'ABCDEFGHIJKLMNOP' };
      const config = presetConfig(preset, 'Hilltop', 'en', peer);
      expect(LoamConfigUpdateSchema.safeParse(config).success, preset).toBe(true);
      expect(config.sync).toEqual({ enabled: true, peers: [peer] });
    }
    expect(presetConfig('community', 'x', 'en').sync).toBeUndefined();
  });

  it('never brings back a remembered peer (its link code is single-use)', () => {
    const stored = {
      preset: 'community',
      nodeName: 'Hilltop',
      connection: 'join',
      peer: { url: 'http://10.0.0.5:3000', transportKey: 'abc', linkCode: 'ABCDEFGHIJKLMNOP' },
    };
    expect(parseSetupRecord(JSON.stringify(stored))).toEqual({ preset: 'community', nodeName: 'Hilltop', connection: 'join' });
  });
});

describe('cleanNodeName', () => {
  it('trims, defaults a blank name, and caps the length', () => {
    expect(cleanNodeName('  Camp  ')).toBe('Camp');
    expect(cleanNodeName('   ')).toBe('LOAM');
    expect(cleanNodeName('x'.repeat(100))).toHaveLength(80);
  });
});

describe('parseSetupRecord', () => {
  it('reads a valid record and rejects anything else', () => {
    expect(parseSetupRecord(JSON.stringify({ preset: 'community', nodeName: 'Camp', connection: 'hotspot' }))).toEqual({
      preset: 'community',
      nodeName: 'Camp',
      connection: 'hotspot',
    });
    for (const bad of [null, '', 'not json', JSON.stringify({ preset: 'party', nodeName: 'x', connection: 'wifi' })]) {
      expect(parseSetupRecord(bad)).toBeUndefined();
    }
  });
});

describe('hasContinuableNetwork', () => {
  it('needs a database that was not ephemeral', () => {
    expect(hasContinuableNetwork({ database: true, ephemeralMarker: false })).toBe(true);
    expect(hasContinuableNetwork({ database: true, ephemeralMarker: true })).toBe(false);
    expect(hasContinuableNetwork({ database: false, ephemeralMarker: false })).toBe(false);
  });
});
