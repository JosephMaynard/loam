// Tests the launcher's new-network step (nodejs-project-template/new-network.js) against a real folder.
// main.js itself can't be required here (it pulls in rn-bridge at import time); this helper is the seam.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyNewNetwork } = require('../../nodejs-project-template/new-network.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A data folder holding a previous network. */
function previousNetwork(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loam-launcher-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'loam.db'), 'old network');
  writeFileSync(path.join(dir, 'config.json'), '{"access":{"joinPolicy":"open"}}');
  writeFileSync(path.join(dir, '.loam-db-mode-hint'), 'persistent');
  return dir;
}

const operation = { id: 'op-0123456789ab', config: { security: { profile: 'hardened' } } };

describe('applyNewNetwork', () => {
  it('empties the folder, writes the configuration and records the operation', () => {
    const dir = previousNetwork();
    expect(applyNewNetwork(realFs, path, dir, operation)).toBe('applied');
    expect(readdirSync(dir).sort()).toEqual(['.loam-setup-applied', 'config.json']);
    expect(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual(operation.config);
  });

  it('never empties the folder twice for the same operation', () => {
    const dir = previousNetwork();
    applyNewNetwork(realFs, path, dir, operation);
    writeFileSync(path.join(dir, 'loam.db'), 'the new network, already running');
    expect(applyNewNetwork(realFs, path, dir, operation)).toBe('already');
    expect(readFileSync(path.join(dir, 'loam.db'), 'utf8')).toBe('the new network, already running');
    // A different, later operation is a new network again.
    expect(applyNewNetwork(realFs, path, dir, { ...operation, id: 'op-fedcba987654' })).toBe('applied');
    expect(readdirSync(dir)).not.toContain('loam.db');
  });

  it('fails (so the launcher stays locked) when the configuration cannot be written durably', () => {
    const dir = previousNetwork();
    const failingWrites = {
      ...realFs,
      // The config write's contents fsync fails: nothing may be reported as set up.
      fsyncSync: (fd: number) => {
        throw Object.assign(new Error(`EIO on ${fd}`), { code: 'EIO' });
      },
    };
    expect(applyNewNetwork(failingWrites, path, dir, operation)).toBe('failed');
    expect(readdirSync(dir)).not.toContain('.loam-setup-applied');
  });

  it('fails when the previous network cannot be fully erased', () => {
    const dir = previousNetwork();
    const stubbornDelete = { ...realFs, rmSync: () => undefined };
    expect(applyNewNetwork(stubbornDelete, path, dir, operation)).toBe('failed');
    expect(readFileSync(path.join(dir, 'config.json'), 'utf8')).toContain('open');
  });

  it('refuses a malformed operation', () => {
    const dir = previousNetwork();
    for (const bad of [undefined, { id: 'short', config: {} }, { id: 'op-0123456789ab', config: [] }]) {
      expect(applyNewNetwork(realFs, path, dir, bad)).toBe('failed');
    }
    expect(readdirSync(dir)).toContain('loam.db');
  });
});
