import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HOST_ERROR_CODES, hostErrorText, hostNoResponseText } from './host-errors';
import { setAppLocale } from './i18n';
import './i18n/catalogs';
import { en } from './i18n/en';
import { fr } from './i18n/fr';

const MAIN_JS = readFileSync(join(__dirname, '..', '..', 'nodejs-project-template/main.js'), 'utf8');

afterEach(() => setAppLocale('en'));

describe('hostErrorText', () => {
  it('knows every errorCode the launcher sends', () => {
    const sent = new Set([...MAIN_JS.matchAll(/errorCode(?:: |\s*=\s*|.*\? )'([a-z_]+)'/g)].map((match) => match[1]));
    for (const match of MAIN_JS.matchAll(/'(start_fresh_[a-z_]+)'/g)) {
      sent.add(match[1]);
    }
    expect(sent.size).toBeGreaterThan(5);
    for (const code of sent) {
      expect(HOST_ERROR_CODES, code).toContain(code);
    }
  });

  it('shows the catalog text for a known code, in the active language', () => {
    expect(hostErrorText({ errorCode: 'unlock_in_progress', error: 'An unlock retry is already in progress.' })).toBe(
      en['hostError.unlockInProgress'],
    );
    setAppLocale('fr');
    expect(hostErrorText({ errorCode: 'host_status', status: 503 })).toContain('503');
    expect(hostErrorText({ errorCode: 'unlock_in_progress' })).toContain(fr['hostError.unlockInProgress']);
    expect(hostNoResponseText()).toContain(fr['hostError.noResponse']);
  });

  it('falls back to the raw detail, then to "unknown error"', () => {
    expect(hostErrorText({ error: 'EACCES: permission denied' })).toBe('EACCES: permission denied');
    expect(hostErrorText({ errorCode: 'something_new', error: 'detail' })).toBe('detail');
    expect(hostErrorText({})).toBe(en['common.unknownError']);
    expect(hostErrorText(undefined)).toBe(en['common.unknownError']);
  });
});
