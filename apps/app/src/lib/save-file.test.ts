import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-sharing', () => ({}));

const { parseSaveFileMessage, safeFileName } = await import('./save-file');

describe('safeFileName', () => {
  it('keeps an ordinary name and drops any path', () => {
    expect(safeFileName('Site map (v2).pdf')).toBe('Site map (v2).pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a\\b\\notes.txt')).toBe('notes.txt');
  });

  it('never yields an empty, hidden or oversized name', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('.profile')).toBe('profile');
    expect(safeFileName(`${'x'.repeat(300)}.txt`)).toHaveLength(100);
    expect(safeFileName('a<b>|c?.txt')).toBe('a_b__c_.txt');
  });
});

describe('parseSaveFileMessage', () => {
  const good = { type: 'loam-save-file', name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' };

  it('accepts a well-formed request', () => {
    expect(parseSaveFileMessage(good)).toEqual({ name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
  });

  it('refuses other messages, unknown types, non-base64 and oversized data', () => {
    expect(parseSaveFileMessage({ ...good, type: 'loam-theme' })).toBeUndefined();
    expect(parseSaveFileMessage({ ...good, mimeType: 'application/x-msdownload' })).toBeUndefined();
    expect(parseSaveFileMessage({ ...good, data: 'not base64!' })).toBeUndefined();
    expect(parseSaveFileMessage({ ...good, data: 'A'.repeat(1_500_000) })).toBeUndefined();
    expect(parseSaveFileMessage('loam-save-file')).toBeUndefined();
  });
});
