// Tests the launcher's new-network step (nodejs-project-template/new-network.js) against a real folder.
// main.js itself can't be required here (it pulls in rn-bridge at import time); this helper is the seam.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyNewNetwork, setupUnfinished } = require('../../nodejs-project-template/new-network.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeDbBootEnv } = require('../../nodejs-project-template/boot-config.js');

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
  // Setup has already written the NEW network's mode here before the launcher runs.
  writeFileSync(path.join(dir, '.loam-db-mode-hint'), 'persistent');
  return dir;
}

const operation = { id: 'op-0123456789ab', config: { security: { profile: 'hardened' } } };

describe('applyNewNetwork', () => {
  it('empties the folder (keeping the new mode hint), writes the configuration and records the operation', () => {
    const dir = previousNetwork();
    expect(applyNewNetwork(realFs, path, dir, operation)).toBe('applied');
    expect(readdirSync(dir).sort()).toEqual(['.loam-db-mode-hint', '.loam-setup-applied', 'config.json']);
    expect(readFileSync(path.join(dir, '.loam-db-mode-hint'), 'utf8')).toBe('persistent');
    expect(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual(operation.config);
    expect(setupUnfinished(realFs, path, dir)).toBe(false);
  });

  it('a setup that fails after erasing stays locked on the next boot, even when the key handoff fails too', () => {
    // Review 2026-10-03 #2: the erase used to take the mode hint with it, so a later locked-error boot saw
    // no hint and no database, read that as a fresh install, and started unencrypted under defaults.
    const dir = previousNetwork();
    let fsyncs = 0;
    const failsAfterErasing = {
      ...realFs,
      // The pending marker and its directory sync succeed; the sync after erasing fails.
      fsyncSync: (fd: number) => {
        fsyncs += 1;
        if (fsyncs > 2) {
          throw Object.assign(new Error(`EIO on ${fd}`), { code: 'EIO' });
        }
        realFs.fsyncSync(fd);
      },
    };
    expect(applyNewNetwork(failsAfterErasing, path, dir, operation)).toBe('failed');
    expect(readdirSync(dir).sort()).toEqual(['.loam-db-mode-hint', '.loam-setup-pending']);
    expect(setupUnfinished(realFs, path, dir)).toBe(true);
    // Even setupUnfinished aside, the kept hint alone now locks a locked-error boot.
    const retry = computeDbBootEnv(
      { mode: 'locked-error' },
      { hint: { status: 'present', mode: 'persistent' }, dbExists: false, probeEncryptedDriver: () => true },
    );
    expect(retry.outcome).toBe('locked');

    // Retry resends the operation and it applies: setup is finished and the marker is gone.
    expect(applyNewNetwork(realFs, path, dir, operation)).toBe('applied');
    expect(setupUnfinished(realFs, path, dir)).toBe(false);
    expect(readdirSync(dir)).not.toContain('.loam-setup-pending');
  });

  it('reads a folder without a marker, or with one matching the record, as finished', () => {
    const dir = previousNetwork();
    expect(setupUnfinished(realFs, path, dir)).toBe(false);
    writeFileSync(path.join(dir, '.loam-setup-applied'), operation.id);
    writeFileSync(path.join(dir, '.loam-setup-pending'), operation.id);
    expect(setupUnfinished(realFs, path, dir)).toBe(false);
    writeFileSync(path.join(dir, '.loam-setup-pending'), 'op-another-operation');
    expect(setupUnfinished(realFs, path, dir)).toBe(true);
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
    // The marker couldn't be made durable, so nothing was erased.
    expect(readdirSync(dir)).toContain('loam.db');
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
