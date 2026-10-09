import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An in-memory cache folder whose write can be held open, so an Emergency Reset can land mid-save. The
 * reset must win: no file left behind and nothing handed to the share sheet.
 */
const files = new Set<string>();
let releaseWrite: (() => void) | undefined;

vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  deleteAsync: vi.fn(async (path: string) => {
    for (const file of [...files]) {
      if (file.startsWith(path)) files.delete(file);
    }
  }),
  makeDirectoryAsync: vi.fn(async () => undefined),
  writeAsStringAsync: vi.fn(
    (path: string) =>
      new Promise<void>((resolve) => {
        releaseWrite = () => {
          files.add(path);
          resolve();
        };
      }),
  ),
}));
const shareAsync = vi.fn(async () => undefined);
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync }));

const { clearSharedFiles, shareReceivedFile } = await import('./save-file');

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  files.clear();
  shareAsync.mockClear();
});

describe('sharing a file across an Emergency Reset', () => {
  it('shares a file normally', async () => {
    const saving = shareReceivedFile({ name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    await flush();
    releaseWrite?.();
    await saving;
    expect(shareAsync).toHaveBeenCalledTimes(1);
    expect([...files]).toEqual(['file:///cache/loam-shared/notes.txt']);
  });

  it('leaves nothing behind when the reset lands while the file is being written', async () => {
    const saving = shareReceivedFile({ name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    await flush();
    await clearSharedFiles(); // the reset: folder emptied while the write is still open
    releaseWrite?.(); // the write then completes, recreating the file
    await saving;
    expect(files.size).toBe(0);
    expect(shareAsync).not.toHaveBeenCalled();
  });

  it('shares two quick taps one after the other, each its own file', async () => {
    let releaseShare: (() => void) | undefined;
    shareAsync.mockImplementationOnce(() => new Promise<undefined>((resolve) => (releaseShare = () => resolve(undefined))));
    const first = shareReceivedFile({ name: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    await flush();
    releaseWrite?.();
    await flush();
    expect(shareAsync).toHaveBeenLastCalledWith('file:///cache/loam-shared/a.txt', expect.anything());

    // The second tap waits for the first share sheet, so it can't empty the folder under it.
    releaseWrite = undefined;
    const second = shareReceivedFile({ name: 'b.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    await flush();
    expect(releaseWrite).toBeUndefined();
    expect([...files]).toEqual(['file:///cache/loam-shared/a.txt']);

    releaseShare?.();
    await first;
    await flush();
    releaseWrite?.();
    await second;
    expect(shareAsync).toHaveBeenCalledTimes(2);
    expect(shareAsync).toHaveBeenLastCalledWith('file:///cache/loam-shared/b.txt', expect.anything());
  });

  it('drops a share still waiting its turn when a reset lands', async () => {
    let releaseShare: (() => void) | undefined;
    shareAsync.mockImplementationOnce(() => new Promise<undefined>((resolve) => (releaseShare = () => resolve(undefined))));
    const first = shareReceivedFile({ name: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    await flush();
    releaseWrite?.();
    await flush();
    const waiting = shareReceivedFile({ name: 'b.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    await clearSharedFiles();
    releaseShare?.();
    await first;
    await waiting;
    expect(shareAsync).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(0);
  });
});
