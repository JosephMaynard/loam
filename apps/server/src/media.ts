// Avatar/attachment file naming, size caps, and magic-byte checks. Extracted from app.ts
// (2026-09-04 split).
import { randomUUID } from "node:crypto";

import type { AvatarImageMimeType, MessageAttachment } from "@loam/schema";

/**
 * Generates a new unique avatar image identifier.
 *
 * @returns A string in the form `avt_<16-hex-chars>` suitable for use as an avatar image filename base
 */
export function newAvatarImageId(): string {
  return `avt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function newAttachmentId(): string {
  return `att_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Filename an attachment is stored (and served) under: `att_<16hex>.<ext>`. */
/** Whether an attachment MIME is one of the inline-renderable image types (vs a download-only file). */
export function isImageAttachmentMime(mimeType: string | undefined): mimeType is AvatarImageMimeType {
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp";
}

/**
 * Sanitise a user-supplied attachment filename before it goes into a `Content-Disposition` header (and the
 * client's escaped display): strip path separators, quotes, and control chars (header-injection / traversal
 * vectors), bound the length, and fall back to `file` if nothing usable remains.
 */
export function sanitizeAttachmentName(name: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (name ?? "").replace(/["\\/\u0000-\u001f]/g, "_").trim().slice(0, 255);
  return cleaned || "file";
}

export function attachmentFileName(attachment: { id: string; mimeType?: MessageAttachment["mimeType"] }): string {
  // Images keep their real extension (served inline). Non-image files are stored under a generic `.bin` so
  // the on-disk name can never carry an executable/renderable extension, and they're served octet-stream.
  return isImageAttachmentMime(attachment.mimeType)
    ? `${attachment.id}.${avatarImageExtension(attachment.mimeType)}`
    : `${attachment.id}.bin`;
}

/**
 * Parses an attachment filename (`att_<16hex>.<ext>`) into its id + kind. For an image, the MIME is derived
 * from the extension (safe to serve inline). For a `.bin` file, no MIME is derived — it is always served as
 * `application/octet-stream` + `Content-Disposition: attachment`, so a mislabelled upload can't be rendered.
 */
export function parseAttachmentFileName(
  value: string,
): { id: string; isImage: boolean; mimeType?: AvatarImageMimeType } | undefined {
  const match = value.match(/^(att_[a-f0-9]{16})\.(png|jpg|webp|bin)$/);

  if (!match) {
    return undefined;
  }

  const extension = match[2];

  if (extension === "bin") {
    return { id: match[1] ?? "", isImage: false };
  }

  const mimeType =
    extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "image/webp";

  return { id: match[1] ?? "", isImage: true, mimeType };
}

export const attachmentMaxBytes = 256 * 1024; // image cap (images are downscaled client-side first)

/**
 * Whether fetched attachment bytes are an acceptable copy: an image must be within the image cap AND match
 * its declared type's magic bytes (it's served inline); a non-image file must be within the (larger) file
 * cap — its MIME is already allowlisted by the schema and it's served octet-stream, so no signature check is
 * meaningful. Shared by the sync import + retry paths so both agree.
 */
export function isAcceptableAttachmentBytes(bytes: Buffer, mimeType: MessageAttachment["mimeType"]): boolean {
  if (bytes.length === 0) {
    return false;
  }
  if (isImageAttachmentMime(mimeType)) {
    return bytes.length <= attachmentMaxBytes && avatarImageHasExpectedSignature(bytes, mimeType);
  }
  return bytes.length <= attachmentFileMaxBytes;
}

export const attachmentFileMaxBytes = 1024 * 1024; // non-image file cap (no downscale) — modest for an off-grid LAN

// Retry policy for a missing-attachment work item (docs/15 A6, F1). `retryMissingAttachments` runs on
// the 30s reaper tick, but it must NOT actually contact the peer on every tick — that burned through
// `attempts` in ~10 minutes with no backoff, making `missingAttachmentMaxAgeMs` (a days-scale bound)
// dead: it could never be reached before attempts exhausted first. Instead, `attempts` only drives a
// growing backoff (`missingAttachmentBackoffMs`) between actual fetch attempts, and the age bound
// below is the sole thing that governs giving up — deliberately generous, so a peer flapping in and
// out over several hours or even days still converges.
export const missingAttachmentMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

export const missingAttachmentRetryBaseMs = 60_000; // first backoff step: 1 minute

export const missingAttachmentRetryMaxIntervalMs = 6 * 3_600_000; // cap: retry at most every 6 hours

// SF3, docs/15: without a per-pass cap, a node with many stuck records could have each one consume up
// to the full 10s peer-fetch timeout in a single pass, so a handful of unreachable records already
// outlasts the 30s reaper tick on its own. Capping how many work items one pass even LOOKS at bounds
// that worst case regardless of how many records are queued; the rest are simply due again on the next
// tick (each record's own backoff still governs whether that next look actually contacts a peer).
export const missingAttachmentMaxRecordsPerPass = 25;

/**
 * Exponential backoff (capped) between retry attempts for one missing-attachment work item, keyed on
 * its current `attempts` count. `attempts` 0 → 1 minute, doubling each attempt, capped at 6 hours —
 * so a persistently-unreachable peer settles into a sane cadence instead of being hammered every 30s,
 * while a briefly-flapping one still converges within a few ticks.
 */
export function missingAttachmentBackoffMs(attempts: number): number {
  return Math.min(missingAttachmentRetryBaseMs * 2 ** attempts, missingAttachmentRetryMaxIntervalMs);
}

/**
 * Map an avatar image MIME type to its canonical file extension.
 *
 * @param mimeType - The avatar image MIME type
 * @returns The corresponding file extension: `png` for `image/png`, `jpg` for `image/jpeg`, otherwise `webp`
 */
export function avatarImageExtension(mimeType: AvatarImageMimeType): string {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  return "webp";
}

/**
 * Parses an avatar filename into its image ID and MIME type.
 *
 * @param value - Avatar filename expected in the form `avt_<16-hex>.<ext>` where `<ext>` is `png`, `jpg`, or `webp`
 * @returns An object with `imageId` and `mimeType` when `value` matches the expected pattern, `undefined` otherwise
 */
export function parseAvatarImageId(value: string): { imageId: string; mimeType: AvatarImageMimeType } | undefined {
  const match = value.match(/^(avt_[a-f0-9]{16})\.(png|jpg|webp)$/);

  if (!match) {
    return undefined;
  }

  const extension = match[2];
  const mimeType =
    extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "image/webp";

  return {
    imageId: match[1] ?? "",
    mimeType,
  };
}

/**
 * Checks that a binary image buffer matches the expected file signature for the provided MIME type.
 *
 * Supports `image/png`, `image/jpeg`, and `image/webp`.
 *
 * @param buffer - The image file data to inspect
 * @param mimeType - The expected MIME type of the image
 * @returns `true` if the buffer's file signature matches the expected MIME type, `false` otherwise
 */
export function avatarImageHasExpectedSignature(buffer: Buffer, mimeType: AvatarImageMimeType): boolean {
  if (mimeType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (mimeType === "image/jpeg") {
    return (
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9
    );
  }

  return buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}
