import type { AvatarImageMimeType, MessageAttachment } from "@loam/schema";

/** Longest edge an attachment is downscaled to before upload (like the avatar editor's 256px). */
export const ATTACHMENT_MAX_DIMENSION = 1280;
/** The server rejects attachment binaries larger than this. */
export const ATTACHMENT_MAX_BYTES = 256 * 1024;
/** Most images a message may carry (mirrors the schema cap). */
export const ATTACHMENT_MAX_COUNT = 4;

/**
 * Scale a width/height pair to fit within `max` on its longest edge, preserving aspect ratio and
 * never upscaling.
 */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The canonical file extension an attachment is served under (mirrors the server's mapping). */
export function attachmentExtension(mimeType: AvatarImageMimeType): string {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  return "webp";
}

/** Server path an attachment's image is served from. */
export function attachmentPath(attachment: MessageAttachment): string {
  return `/api/attachments/${attachment.id}.${attachmentExtension(attachment.mimeType)}`;
}

export type PreparedAttachment = {
  blob: Blob;
  width: number;
  height: number;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load image."));
    image.src = url;
  });
}

/** Try webp at descending qualities, then png, until the encoded blob fits the upload cap. */
function encodeUnderLimit(canvas: HTMLCanvasElement): Promise<Blob> {
  const formats: { type: "image/webp" | "image/png"; quality?: number }[] = [
    { type: "image/webp", quality: 0.82 },
    { type: "image/webp", quality: 0.72 },
    { type: "image/webp", quality: 0.6 },
    { type: "image/png" },
  ];

  return new Promise((resolve, reject) => {
    function tryFormat(index: number): void {
      const format = formats[index];

      if (!format) {
        reject(new Error("Image is too large even after resizing."));
        return;
      }

      canvas.toBlob(
        (blob) => {
          if (blob && blob.size <= ATTACHMENT_MAX_BYTES) {
            resolve(blob);
            return;
          }

          tryFormat(index + 1);
        },
        format.type,
        format.quality,
      );
    }

    tryFormat(0);
  });
}

/**
 * Downscale an image file on-device — like the avatar editor, the original never leaves the
 * browser. Longest edge capped at {@link ATTACHMENT_MAX_DIMENSION}, re-encoded to webp (png
 * fallback) under the server's {@link ATTACHMENT_MAX_BYTES} cap.
 */
export async function prepareImageAttachment(file: File): Promise<PreparedAttachment> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }

  const url = URL.createObjectURL(file);

  try {
    const image = await loadImage(url);
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight, ATTACHMENT_MAX_DIMENSION);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to process the image.");
    }

    context.drawImage(image, 0, 0, width, height);
    const blob = await encodeUnderLimit(canvas);
    return { blob, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
