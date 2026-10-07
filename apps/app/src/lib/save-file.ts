/**
 * Saving a received file on the host phone. In the host's own WebView every attachment arrives through the
 * encrypted tunnel as a `blob:` URL, which Android's DownloadManager can't fetch, so a plain download link
 * does nothing there. Instead the client posts the file's bytes (`{"type":"loam-save-file", name, mimeType,
 * data}`, base64, attachments are 1 MiB at most) and the host hands them to Android's share sheet, where the
 * person picks where it goes (Files, Drive, another app). Nothing is saved unless they tap the file.
 *
 * The copy handed to the share sheet sits in a cache folder of its own, emptied before each new file, at
 * launch, and on an Emergency Reset, so a file never outlives the network on this phone by more than that.
 */
import { AttachmentMimeTypeSchema } from '@loam/schema';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/** The largest attachment the server accepts (1 MiB), as base64 (4/3 of it, plus padding). */
const MAX_BASE64_LENGTH = Math.ceil((1024 * 1024 * 4) / 3) + 4;

export type SaveFileRequest = { name: string; mimeType: string; data: string };

/**
 * A safe file name: the last path segment only, unusual characters replaced, at most 100 characters, never
 * empty or a dot name. Pure.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').trim().slice(0, 100);
  return cleaned || 'file';
}

/**
 * The save request in a client message, or undefined when it isn't a well-formed `loam-save-file` (wrong
 * type, an unknown file type, data that isn't base64 or is larger than any attachment). Pure.
 */
export function parseSaveFileMessage(message: unknown): SaveFileRequest | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const { type, name, mimeType, data } = message as Record<string, unknown>;
  if (type !== 'loam-save-file' || typeof name !== 'string' || typeof data !== 'string') {
    return undefined;
  }
  if (!AttachmentMimeTypeSchema.safeParse(mimeType).success) {
    return undefined;
  }
  if (data.length === 0 || data.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    return undefined;
  }
  return { name: safeFileName(name), mimeType: mimeType as string, data };
}

/** The cache folder the share sheet reads from. */
function sharedDir(): string | undefined {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}loam-shared/` : undefined;
}

/** Remove every file handed to the share sheet. Best effort. */
export async function clearSharedFiles(): Promise<void> {
  const dir = sharedDir();
  if (dir) {
    await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => undefined);
  }
}

/** Write the file to the share folder (emptied first) and open Android's share sheet for it. */
export async function shareReceivedFile(request: SaveFileRequest): Promise<void> {
  const dir = sharedDir();
  if (!dir || !(await Sharing.isAvailableAsync())) {
    return;
  }
  await clearSharedFiles();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = `${dir}${request.name}`;
  await FileSystem.writeAsStringAsync(uri, request.data, { encoding: FileSystem.EncodingType.Base64 });
  await Sharing.shareAsync(uri, { mimeType: request.mimeType, dialogTitle: request.name });
}
