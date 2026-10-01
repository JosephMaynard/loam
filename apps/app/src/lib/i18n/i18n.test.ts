import { describe, expect, it, beforeEach } from 'vitest';

import { CATALOGS } from './catalogs';
import { en } from './en';
import { APP_LOCALES, LOCALE_NAMES, parseAppLocale, setAppLocale, t } from './index';

const EN_KEYS = Object.keys(en).sort();

function tokensOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

beforeEach(() => setAppLocale('en'));

describe('host app catalogs', () => {
  it('ship every language the web client has, each with its own name', () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(APP_LOCALES.filter((locale) => locale !== 'en').sort());
    for (const locale of APP_LOCALES) {
      expect(LOCALE_NAMES[locale]).toBeTruthy();
    }
  });

  it('cover every English key, with no strays, and the same {tokens}', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      const keys = Object.keys(catalog).sort();
      expect(keys, `${locale} keys`).toEqual(EN_KEYS);
      for (const key of keys) {
        const value = (catalog as Record<string, string>)[key]!;
        expect(tokensOf(value), `${locale} ${key} tokens`).toEqual(tokensOf((en as Record<string, string>)[key]!));
      }
    }
  });

  it('contain no em-dashes (house style)', () => {
    const offenders = [en, ...Object.values(CATALOGS)].flatMap((catalog) =>
      Object.entries(catalog).filter(([, value]) => value.includes('—')).map(([key]) => key),
    );
    expect(offenders).toEqual([]);
  });
});

describe('t()', () => {
  it('uses the active language, falls back to English, and fills tokens', () => {
    expect(t('reset.failed', { error: 'disk full' })).toBe("Couldn't erase: disk full");
    setAppLocale('fr');
    expect(t('reset.failed', { error: 'disque plein' })).toBe("Impossible d'effacer : disque plein");
  });

  it('parses stored values, defaulting to English', () => {
    expect(parseAppLocale('ar')).toBe('ar');
    expect(parseAppLocale('xx')).toBe('en');
    expect(parseAppLocale(null)).toBe('en');
  });
});
