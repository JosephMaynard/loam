import { describe, expect, it } from 'vitest';

import { colorSchemeForClientMessage } from './client-theme';

describe('colorSchemeForClientMessage', () => {
  it('maps the client theme to the native color scheme', () => {
    expect(colorSchemeForClientMessage({ type: 'loam-theme', theme: 'light' })).toBe('light');
    expect(colorSchemeForClientMessage({ type: 'loam-theme', theme: 'dark' })).toBe('dark');
    expect(colorSchemeForClientMessage({ type: 'loam-theme', theme: 'system' })).toBe('unspecified');
  });

  it('ignores other messages and malformed themes', () => {
    for (const message of [
      null,
      'loam-theme',
      { type: 'loam-open-share' },
      { type: 'loam-theme' },
      { type: 'loam-theme', theme: 'blue' },
      { type: 'loam-theme', theme: 1 },
    ]) {
      expect(colorSchemeForClientMessage(message)).toBeUndefined();
    }
  });
});
