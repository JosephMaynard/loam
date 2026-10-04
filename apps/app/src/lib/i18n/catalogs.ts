/**
 * Registers every shipped language with the i18n core. The native app bundles them all (unlike the web
 * client, nothing here is downloaded per joiner); each is small.
 */
import { registerCatalog } from './index';
import { ar } from './ar';
import { bn } from './bn';
import { es } from './es';
import { fa } from './fa';
import { fr } from './fr';
import { my } from './my';
import { prs } from './prs';
import { ps } from './ps';
import { pt } from './pt';
import { ru } from './ru';
import { sw } from './sw';
import { tr } from './tr';
import { uk } from './uk';
import { ur } from './ur';

export const CATALOGS = { es, fr, ar, fa, pt, uk, ru, tr, my, ur, prs, ps, sw, bn } as const;

for (const [locale, catalog] of Object.entries(CATALOGS)) {
  registerCatalog(locale as keyof typeof CATALOGS, catalog);
}
