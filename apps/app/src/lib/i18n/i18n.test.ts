import { LocaleSchema } from '@loam/schema';
import { describe, expect, it, beforeEach } from 'vitest';

import { CATALOGS } from './catalogs';
import { en } from './en';
import { APP_LOCALES, LOCALE_NAMES, RLM, isRtlLocale, parseAppLocale, rtlTextAlign, setAppLocale, t } from './index';

const EN_KEYS = Object.keys(en).sort();

function tokensOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

beforeEach(() => setAppLocale('en'));

describe('host app catalogs', () => {
  it('offer exactly the web client\'s languages (written out, since the app can\'t import the schema)', () => {
    expect([...APP_LOCALES]).toEqual([...LocaleSchema.options]);
  });

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

  it('starts every right-to-left string with an RLM and isolates the values it fills in', () => {
    for (const locale of ['ar', 'fa', 'ur', 'prs', 'ps'] as const) {
      setAppLocale(locale);
      expect(isRtlLocale(locale)).toBe(true);
      // Strings that begin with "LOAM" or a placeholder are the ones Android laid out left to right.
      expect(t('host.title').startsWith(RLM), `${locale} host.title`).toBe(true);
      const filled = t('model.deleted', { name: 'Gemma 3 1B' });
      expect(filled.startsWith(RLM), `${locale} model.deleted`).toBe(true);
      expect(filled).toContain('⁨Gemma 3 1B⁩');
      // A nested t() and a number stay inside their own isolates; the outer string still leads with the RLM.
      const nested = t('reset.failed', { error: t('hostError.status', { status: 503 }) });
      expect(nested.startsWith(RLM)).toBe(true);
      expect(nested).toContain('⁨503⁩');
      expect(nested.match(/⁨/g)?.length).toBe(nested.match(/⁩/g)?.length);
    }
  });

  it('leaves left-to-right languages and English fallbacks untouched', () => {
    for (const locale of ['en', 'fr', 'my', 'bn'] as const) {
      setAppLocale(locale);
      expect(isRtlLocale(locale)).toBe(false);
      expect(t('model.deleted', { name: 'X' })).not.toMatch(/[‏⁨⁩]/);
    }
    // Every RTL catalog is complete (see above), so the only fallback is a key the catalog lacks: simulate one.
    setAppLocale('ar');
    const registered = (CATALOGS.ar as Record<string, string>)['host.title'];
    try {
      delete (CATALOGS.ar as Record<string, string>)['host.title'];
      expect(t('host.title')).toBe(en['host.title']);
    } finally {
      (CATALOGS.ar as Record<string, string>)['host.title'] = registered!;
    }
  });

  it('aligns unaligned native text right in right-to-left languages, keeping an explicit centre', () => {
    for (const locale of ['ar', 'fa', 'ur', 'prs', 'ps'] as const) {
      expect(rtlTextAlign(locale, undefined)).toBe('right');
      expect(rtlTextAlign(locale, 'auto')).toBe('right');
      expect(rtlTextAlign(locale, 'left')).toBe('right');
      expect(rtlTextAlign(locale, 'center')).toBeUndefined();
      expect(rtlTextAlign(locale, 'right')).toBeUndefined();
    }
    for (const locale of ['en', 'fr', 'my'] as const) {
      expect(rtlTextAlign(locale, undefined)).toBeUndefined();
    }
  });

  it('parses stored values, defaulting to English', () => {
    expect(parseAppLocale('ar')).toBe('ar');
    expect(parseAppLocale('xx')).toBe('en');
    expect(parseAppLocale(null)).toBe('en');
  });
});
