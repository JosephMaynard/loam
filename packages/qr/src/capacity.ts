import type { QRVersion } from "./types";

export type QRBlockGroup = {
  count: number;
  dataCodewords: number;
  ecCodewordsPerBlock?: number;
};

export type QRVersionInfo = {
  size: number;
  byteCapacityH: number;
  dataCodewords: number;
  ecCodewordsPerBlock: number;
  blocks: readonly QRBlockGroup[];
  alignmentCenters: readonly number[];
};

export const QR_VERSION_INFO: Record<QRVersion, QRVersionInfo> = {
  4: {
    size: 33,
    byteCapacityH: 34,
    dataCodewords: 36,
    ecCodewordsPerBlock: 16,
    blocks: [{ count: 4, dataCodewords: 9 }],
    alignmentCenters: [6, 26],
  },
  5: {
    size: 37,
    byteCapacityH: 44,
    dataCodewords: 46,
    ecCodewordsPerBlock: 22,
    blocks: [
      { count: 2, dataCodewords: 11 },
      { count: 2, dataCodewords: 12 },
    ],
    alignmentCenters: [6, 30],
  },
  6: {
    size: 41,
    byteCapacityH: 58,
    dataCodewords: 60,
    ecCodewordsPerBlock: 28,
    blocks: [{ count: 4, dataCodewords: 15 }],
    alignmentCenters: [6, 34],
  },
};

export function getVersionInfo(version: QRVersion): QRVersionInfo {
  return QR_VERSION_INFO[version];
}

export function chooseVersion(byteLength: number): QRVersion {
  if (byteLength <= QR_VERSION_INFO[4].byteCapacityH) {
    return 4;
  }

  if (byteLength <= QR_VERSION_INFO[5].byteCapacityH) {
    return 5;
  }

  if (byteLength <= QR_VERSION_INFO[6].byteCapacityH) {
    return 6;
  }

  throw new Error(
    `Input is ${byteLength} bytes in UTF-8, which exceeds QR version 6-H capacity (${QR_VERSION_INFO[6].byteCapacityH} bytes)`,
  );
}
