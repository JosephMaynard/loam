// The native screens' text lives in the catalogs (src/lib/i18n), not in the source. This pins that for the
// files that used to carry English literals: no JSX text node, placeholder, accessibility label or Alert
// title written in English, no long English sentence in a quoted string, and none of the phrases that were
// moved into `en.ts` left behind. The Kotlin foreground service keeps English defaults only for a start that
// carries no labels. Heuristic by design (there is no renderer in this harness); the catalogs' own parity
// test covers the translations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { en } from '@/lib/i18n/en';

const APP_ROOT = join(__dirname, '..', '..');

/** The files whose user-facing text moved into the catalogs, with the catalog sections that now hold it. */
const SOURCES: { file: string; sections: string[] }[] = [
  { file: 'src/app/index.tsx', sections: ['boot.', 'common.'] },
  { file: 'src/lib/host-service.ts', sections: ['notify.'] },
  { file: 'src/hooks/use-hotspot.ts', sections: ['hotspot.'] },
  { file: 'src/lib/new-network.ts', sections: ['newNetwork.'] },
  { file: 'src/lib/driver-missing-recovery.ts', sections: ['recovery.'] },
  { file: 'src/components/db-encryption-settings.tsx', sections: ['encryption.'] },
  { file: 'src/components/model-manager.tsx', sections: ['model.'] },
  { file: 'src/lib/model-download-disclosure.ts', sections: ['model.disclosure'] },
];

function read(file: string): string {
  return readFileSync(join(APP_ROOT, file), 'utf8');
}

// The source without its comments (block, line and JSX-wrapped block comments), so prose in comments
// isn't counted.
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** JSX text nodes: literal text between a tag and the next closing tag, or beside a `{expression}`. The `>`
 * must not be an arrow's (`=> word {` is code), which is what the lookbehind rules out. */
function jsxTextNodes(code: string): string[] {
  const nodes: string[] = [];
  for (const pattern of [
    /(?<!=)>\s*([^<>{}]+?)\s*<\//g,
    /(?<!=)>\s*([A-Za-z][^<>{}]*?)\s*\{/g,
    /\}\s*([^<>{}]*?[A-Za-z][^<>{}]*?)\s*<\//g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      const text = match[1].trim();
      if (/[A-Za-z]{2,}/.test(text)) {
        nodes.push(text);
      }
    }
  }
  return nodes;
}

/** Quoted (' or ") string literals that read as an English sentence: a capitalised word then three more. */
function englishSentenceLiterals(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => !line.includes('console.'))
    .flatMap((line) => [...line.matchAll(/(['"])([A-Z][a-z]+(?:\s+[A-Za-z'’]+){3,}[^'"]*)\1/g)].map((match) => match[2]));
}

/** The English catalog values (3+ words) of the given sections, as they must not appear verbatim in code. */
function movedPhrases(sections: string[]): string[] {
  return Object.entries(en)
    .filter(([key]) => sections.some((section) => key.startsWith(section)))
    .map(([, value]) => value.replace(/\{\w+\}/g, '').trim())
    .filter((value) => value.split(/\s+/).length >= 3);
}

describe('native screens take their text from the catalogs', () => {
  for (const { file, sections } of SOURCES) {
    describe(file, () => {
      const source = read(file);
      const code = stripComments(source);

      it.skipIf(!file.endsWith('.tsx'))('has no English JSX text nodes', () => {
        expect(jsxTextNodes(code)).toEqual([]);
      });

      it('has no English placeholder, accessibility label or Alert title literal', () => {
        // A URL example as a placeholder ("https://…/model.gguf") isn't prose.
        expect(code).not.toMatch(/placeholder="(?!https?:)[A-Za-z]/);
        expect(code).not.toMatch(/accessibilityLabel="[A-Za-z]/);
        expect(code).not.toMatch(/Alert\.alert\(\s*['"][A-Za-z]/);
        expect(code).not.toMatch(/\b(?:title|message|buttonPositive|buttonNegative):\s*['"][A-Za-z]/);
      });

      it('has no quoted English sentence left in the code', () => {
        expect(englishSentenceLiterals(code)).toEqual([]);
      });

      it('no longer carries the phrases that moved into the catalog', () => {
        const leftovers = movedPhrases(sections).filter((phrase) => code.includes(phrase));
        expect(leftovers).toEqual([]);
      });

      it('reads its text through t()', () => {
        expect(source).toMatch(/\bt\('(?:[a-zA-Z]+)\.[A-Za-z0-9]+'/);
      });
    });
  }

  it('the foreground service notification takes its text from the start intent, with English only as the default', () => {
    const kotlin = read('modules/loam-hotspot/android/src/main/java/expo/modules/loamhotspot/LoamHostService.kt');
    expect(kotlin).toMatch(/setContentTitle\(labels\.title\)/);
    expect(kotlin).toMatch(/setContentText\(labels\.text\)/);
    expect(kotlin).toMatch(/NotificationChannel\(CHANNEL_ID, labels\.channelName,/);
    expect(kotlin).not.toMatch(/setContentTitle\("/);
    expect(kotlin).not.toMatch(/setContentText\("/);
    // The English defaults match the catalog, so a start with no labels reads the same as an English one.
    expect(kotlin).toContain(`title = "${en['notify.hostingTitle']}"`);
    expect(kotlin).toContain(`text = "${en['notify.hostingText']}"`);
    expect(kotlin).toContain(`channelName = "${en['host.title']}"`);
    expect(kotlin).toContain(`channelDescription = "${en['notify.channelDescription']}"`);
    // And the small icon is the module's own monochrome drawable, not the adaptive launcher icon.
    expect(kotlin).toMatch(/setSmallIcon\(R\.drawable\.loam_host_notification\)/);
    expect(kotlin).not.toMatch(/setSmallIcon\(applicationInfo\.icon\)/);
    expect(read('modules/loam-hotspot/android/src/main/res/drawable/loam_host_notification.xml')).toMatch(/<vector[\s\S]*android:width="24dp"/);
  });

  it('the JS side hands the service every label the catalog has for it', () => {
    const hostService = read('src/lib/host-service.ts');
    for (const key of ['host.title', 'notify.channelDescription', 'notify.hostingTitle', 'notify.hostingText']) {
      expect(hostService).toContain(`t('${key}')`);
    }
    expect(hostService).toMatch(/startHostService\(hostServiceLabels\(\)\)/);
  });
});
