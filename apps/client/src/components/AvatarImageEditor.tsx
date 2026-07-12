import { useEffect, useRef, useState } from "preact/hooks";

import { t } from "../i18n";
import { clamp } from "../lib/numbers";

const AVATAR_OUTPUT_SIZE = 256;
const AVATAR_MAX_UPLOAD_BYTES = 128 * 1024;

type AvatarCrop = {
  offsetX: number;
  offsetY: number;
  rotation: number;
  zoom: number;
};

type CanvasPointer = {
  x: number;
  y: number;
};

interface AvatarImageEditorProps {
  disabled: boolean;
  onUpload: (blob: Blob) => Promise<void>;
}

/**
 * Convert a pointer event's client coordinates into canvas coordinates scaled to the avatar output size.
 *
 * @param canvas - The target HTML canvas element.
 * @param event - The pointer event whose `clientX`/`clientY` will be mapped.
 * @returns An object with `x` and `y` coordinates in the canvas coordinate space (0..AVATAR_OUTPUT_SIZE).
 */
function canvasPoint(canvas: HTMLCanvasElement, event: PointerEvent): CanvasPointer {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * AVATAR_OUTPUT_SIZE,
    y: ((event.clientY - rect.top) / rect.height) * AVATAR_OUTPUT_SIZE,
  };
}

/**
 * Compute the Euclidean distance between two canvas pointer coordinates.
 *
 * @param left - The first canvas pointer (with `x` and `y`).
 * @param right - The second canvas pointer (with `x` and `y`).
 * @returns The straight-line distance between `left` and `right` in canvas coordinate units.
 */
function pointerDistance(left: CanvasPointer, right: CanvasPointer): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/**
 * Compute the angle in radians from the `left` point to the `right` point.
 *
 * @param left - The origin point from which the angle is measured
 * @param right - The target point to which the angle is measured
 * @returns The angle in radians measured from the positive X axis to the vector from `left` to `right` (range approximately -π to π)
 */
function pointerAngle(left: CanvasPointer, right: CanvasPointer): number {
  return Math.atan2(right.y - left.y, right.x - left.x);
}

/**
 * Renders the provided image into the given canvas using the specified crop transform.
 *
 * The canvas is cleared and painted with a neutral background, then the image is drawn
 * centered and transformed by `crop.offsetX`, `crop.offsetY` (pixel offsets from center),
 * `crop.rotation` (degrees), and `crop.zoom` (scale multiplier). The image is scaled
 * so its smaller dimension fits the avatar output size before applying `crop.zoom`.
 *
 * @param canvas - Target canvas element sized to `AVATAR_OUTPUT_SIZE`
 * @param image - Source HTMLImageElement to draw (uses `naturalWidth`/`naturalHeight`)
 * @param crop - Crop transform containing:
 *   - `offsetX` and `offsetY`: pixel translations from canvas center
 *   - `rotation`: degrees to rotate the image
 *   - `zoom`: multiplicative scale applied after fitting the image to the output size
 */
function drawAvatarCanvas(canvas: HTMLCanvasElement, image: HTMLImageElement, crop: AvatarCrop): void {
  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  const baseScale = AVATAR_OUTPUT_SIZE / Math.min(image.naturalWidth, image.naturalHeight);
  context.clearRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  context.fillStyle = "#f8fbf6";
  context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  context.save();
  context.translate(AVATAR_OUTPUT_SIZE / 2 + crop.offsetX, AVATAR_OUTPUT_SIZE / 2 + crop.offsetY);
  context.rotate((crop.rotation * Math.PI) / 180);
  context.scale(baseScale * crop.zoom, baseScale * crop.zoom);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  context.restore();
}

/**
 * Create an image Blob from a canvas suitable for avatar upload.
 *
 * Attempts to encode and compress the provided canvas into an image Blob whose size does not exceed AVATAR_MAX_UPLOAD_BYTES; rejects if no acceptable Blob can be produced.
 *
 * @param canvas - The source HTMLCanvasElement to convert
 * @returns A Blob containing the encoded image ready for upload
 */
function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  const formats: { type: "image/webp" | "image/png"; quality?: number }[] = [
    { type: "image/webp", quality: 0.82 },
    { type: "image/webp", quality: 0.72 },
    { type: "image/png" },
  ];

  return new Promise((resolve, reject) => {
    function tryFormat(index: number): void {
      const format = formats[index];

      if (!format) {
        reject(new Error(t("avatarEditor.tooLarge")));
        return;
      }

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            tryFormat(index + 1);
            return;
          }

          if (blob.size <= AVATAR_MAX_UPLOAD_BYTES) {
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
 * Renders an avatar image crop-and-upload editor.
 *
 * Allows selecting an image, interactively panning/zooming/rotating a square crop on a 256px canvas, and uploading a compressed/cropped Blob.
 *
 * @param disabled - When true, user interactions and controls are disabled.
 * @param onUpload - Callback invoked with the cropped image Blob when the user chooses "Use cropped image"; the Blob is compressed and sized to meet upload limits.
 * @returns The avatar editor's JSX element.
 */
export function AvatarImageEditor({ disabled, onUpload }: AvatarImageEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>();
  const pointersRef = useRef(new Map<number, CanvasPointer>());
  const dragRef = useRef<{ point: CanvasPointer; offsetX: number; offsetY: number }>();
  const gestureRef = useRef<{
    angle: number;
    distance: number;
    rotation: number;
    zoom: number;
  }>();
  const objectUrlRef = useRef<string>();
  const loadingImageRef = useRef<HTMLImageElement>();
  const mountedRef = useRef(true);
  const [crop, setCrop] = useState<AvatarCrop>({ offsetX: 0, offsetY: 0, rotation: 0, zoom: 1 });
  const [hasImage, setHasImage] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;

    if (!canvas || !image) {
      return;
    }

    drawAvatarCanvas(canvas, image, crop);
  }, [crop, hasImage]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }

      if (loadingImageRef.current) {
        loadingImageRef.current.onload = null;
        loadingImageRef.current.onerror = null;
        loadingImageRef.current.src = "";
        loadingImageRef.current = undefined;
      }
    };
  }, []);

  function startDrag(event: PointerEvent): void {
    const canvas = canvasRef.current;

    if (!canvas || disabled || !hasImage) {
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, canvasPoint(canvas, event));

    if (pointersRef.current.size === 1) {
      dragRef.current = {
        point: canvasPoint(canvas, event),
        offsetX: crop.offsetX,
        offsetY: crop.offsetY,
      };
      gestureRef.current = undefined;
      return;
    }

    const points = Array.from(pointersRef.current.values());
    const [first, second] = points;

    if (first && second) {
      gestureRef.current = {
        angle: pointerAngle(first, second),
        distance: pointerDistance(first, second),
        rotation: crop.rotation,
        zoom: crop.zoom,
      };
      dragRef.current = undefined;
    }
  }

  function moveDrag(event: PointerEvent): void {
    const canvas = canvasRef.current;

    if (!canvas || disabled || !hasImage || !pointersRef.current.has(event.pointerId)) {
      return;
    }

    const point = canvasPoint(canvas, event);
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2 && gestureRef.current) {
      const points = Array.from(pointersRef.current.values());
      const [first, second] = points;

      if (!first || !second) {
        return;
      }

      const distance = pointerDistance(first, second);
      const angle = pointerAngle(first, second);
      const nextZoom = clamp(gestureRef.current.zoom * (distance / gestureRef.current.distance), 1, 3);
      const nextRotation = gestureRef.current.rotation + ((angle - gestureRef.current.angle) * 180) / Math.PI;
      setCrop((previous) => ({ ...previous, rotation: nextRotation, zoom: nextZoom }));
      return;
    }

    const drag = dragRef.current;

    if (!drag) {
      return;
    }

    setCrop((previous) => ({
      ...previous,
      offsetX: clamp(drag.offsetX + point.x - drag.point.x, -128, 128),
      offsetY: clamp(drag.offsetY + point.y - drag.point.y, -128, 128),
    }));
  }

  function endDrag(event: PointerEvent): void {
    pointersRef.current.delete(event.pointerId);
    dragRef.current = undefined;
    gestureRef.current = undefined;
  }

  async function selectImage(file: File): Promise<void> {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
      setError(t("avatarEditor.invalidType"));
      return;
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = undefined;
    }

    if (loadingImageRef.current) {
      loadingImageRef.current.onload = null;
      loadingImageRef.current.onerror = null;
      loadingImageRef.current.src = "";
      loadingImageRef.current = undefined;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    objectUrlRef.current = url;
    loadingImageRef.current = image;

    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => {
          image.onload = null;
          image.onerror = null;
          resolve();
        };
        image.onerror = () => {
          image.onload = null;
          image.onerror = null;
          reject(new Error(t("avatarEditor.loadError")));
        };
        image.src = url;
      });

      if (!mountedRef.current || objectUrlRef.current !== url) {
        return;
      }

      imageRef.current = image;
      setCrop({ offsetX: 0, offsetY: 0, rotation: 0, zoom: 1 });
      setHasImage(true);
      setError(undefined);
    } catch (nextError) {
      if (mountedRef.current && objectUrlRef.current === url) {
        setError(nextError instanceof Error ? nextError.message : t("avatarEditor.loadError"));
      }
    } finally {
      if (objectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        objectUrlRef.current = undefined;
      }

      if (loadingImageRef.current === image) {
        loadingImageRef.current = undefined;
      }
    }
  }

  async function upload(): Promise<void> {
    const canvas = canvasRef.current;

    if (!canvas || !hasImage) {
      return;
    }

    setUploading(true);
    setError(undefined);

    try {
      const blob = await blobFromCanvas(canvas);
      await onUpload(blob);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("avatarEditor.uploadError"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="avatar-editor">
      <canvas
        aria-label={t("avatarEditor.cropPreview")}
        className="avatar-crop-canvas"
        height={AVATAR_OUTPUT_SIZE}
        onPointerDown={startDrag}
        onPointerCancel={endDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        ref={canvasRef}
        role="img"
        width={AVATAR_OUTPUT_SIZE}
      />
      <input
        accept="image/png,image/jpeg,image/webp,image/*"
        className="sr-only"
        disabled={disabled || uploading}
        onInput={(event) => {
          const file = event.currentTarget.files?.[0];

          if (file) {
            void selectImage(file);
          }
        }}
        ref={fileInputRef}
        type="file"
      />
      <div className="avatar-editor-controls">
        <button disabled={disabled || uploading} onClick={() => fileInputRef.current?.click()} type="button">
          {t("avatarEditor.chooseImage")}
        </button>
        <button disabled={disabled || uploading || !hasImage} onClick={() => void upload()} type="button">
          {uploading ? t("avatarEditor.uploading") : t("avatarEditor.useCropped")}
        </button>
      </div>
      <label>
        {t("avatarEditor.zoom")}
        <input
          disabled={disabled || uploading || !hasImage}
          max="3"
          min="1"
          onInput={(event) => setCrop((previous) => ({ ...previous, zoom: Number(event.currentTarget.value) }))}
          step="0.01"
          type="range"
          value={crop.zoom}
        />
      </label>
      <label>
        {t("avatarEditor.rotate")}
        <input
          disabled={disabled || uploading || !hasImage}
          max="180"
          min="-180"
          onInput={(event) => setCrop((previous) => ({ ...previous, rotation: Number(event.currentTarget.value) }))}
          step="1"
          type="range"
          value={crop.rotation}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
