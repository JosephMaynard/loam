import type { QRErrorCorrectionLevel, QRVersion } from "./types.js";

export type QRBlockGroup = {
  count: number;
  dataCodewords: number;
  ecCodewordsPerBlock?: number;
};

/** Capacity/block-structure fields that vary by error correction level (docs/15 #10). */
type QRLevelInfo = {
  /**
   * Max UTF-8 byte-mode payload for this version+level: `dataCodewords - 2`, i.e. the largest byte
   * length whose 4-bit mode indicator + 8-bit length header + payload still leaves room for the
   * (up to 4-bit) terminator within `dataCodewords * 8` bits — see `buildDataCodewords` in
   * `encode.ts`.
   */
  byteCapacity: number;
  dataCodewords: number;
  ecCodewordsPerBlock: number;
  blocks: readonly QRBlockGroup[];
};

/** Fields that depend only on version (module grid layout), shared by every error correction level. */
type QRVersionShape = {
  size: number;
  alignmentCenters: readonly number[];
  levels: Record<QRErrorCorrectionLevel, QRLevelInfo>;
};

export type QRVersionInfo = QRLevelInfo & {
  size: number;
  alignmentCenters: readonly number[];
};

/**
 * Per-version, per-level capacity and Reed-Solomon block structure (ISO/IEC 18004 tables). Only
 * versions 4-6 and levels H/M are populated — the sizes LOAM actually uses (small join-link and
 * WiFi QRs). Every level for a given version shares the same total codeword count (data + EC
 * across all blocks): version 4 = 100, version 5 = 134, version 6 = 172 — a useful cross-check when
 * adding another level or version.
 */
const QR_VERSIONS: Record<QRVersion, QRVersionShape> = {
  4: {
    size: 33,
    alignmentCenters: [6, 26],
    levels: {
      H: { byteCapacity: 34, dataCodewords: 36, ecCodewordsPerBlock: 16, blocks: [{ count: 4, dataCodewords: 9 }] },
      M: { byteCapacity: 62, dataCodewords: 64, ecCodewordsPerBlock: 18, blocks: [{ count: 2, dataCodewords: 32 }] },
    },
  },
  5: {
    size: 37,
    alignmentCenters: [6, 30],
    levels: {
      H: {
        byteCapacity: 44,
        dataCodewords: 46,
        ecCodewordsPerBlock: 22,
        blocks: [
          { count: 2, dataCodewords: 11 },
          { count: 2, dataCodewords: 12 },
        ],
      },
      M: { byteCapacity: 84, dataCodewords: 86, ecCodewordsPerBlock: 24, blocks: [{ count: 2, dataCodewords: 43 }] },
    },
  },
  6: {
    size: 41,
    alignmentCenters: [6, 34],
    levels: {
      H: { byteCapacity: 58, dataCodewords: 60, ecCodewordsPerBlock: 28, blocks: [{ count: 4, dataCodewords: 15 }] },
      M: { byteCapacity: 106, dataCodewords: 108, ecCodewordsPerBlock: 16, blocks: [{ count: 4, dataCodewords: 27 }] },
    },
  },
};

/**
 * Resolve the size/alignment (version-only) and capacity/block-structure (level-specific) fields
 * for one version+level pair.
 *
 * @param version - QR version (4-6)
 * @param ecLevel - Error correction level; defaults to `"H"` (unchanged behaviour for existing callers)
 */
export function getVersionInfo(version: QRVersion, ecLevel: QRErrorCorrectionLevel = "H"): QRVersionInfo {
  const shape = QR_VERSIONS[version];
  return { size: shape.size, alignmentCenters: shape.alignmentCenters, ...shape.levels[ecLevel] };
}

/**
 * Pick the smallest version (4-6) whose byte-mode capacity at `ecLevel` fits `byteLength`.
 *
 * @param byteLength - UTF-8 byte length of the payload to encode
 * @param ecLevel - Error correction level; defaults to `"H"` (unchanged behaviour for existing callers)
 */
export function chooseVersion(byteLength: number, ecLevel: QRErrorCorrectionLevel = "H"): QRVersion {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new Error(`Byte length must be a non-negative integer, received ${byteLength}`);
  }

  for (const version of [4, 5, 6] as const) {
    if (byteLength <= QR_VERSIONS[version].levels[ecLevel].byteCapacity) {
      return version;
    }
  }

  throw new Error(
    `Input is ${byteLength} bytes in UTF-8, which exceeds QR version 6-${ecLevel} capacity (${QR_VERSIONS[6].levels[ecLevel].byteCapacity} bytes)`,
  );
}
