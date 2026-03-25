import { BitBuffer } from "./bit-buffer";
import { chooseVersion, getVersionInfo } from "./capacity";
import { placeFormatInfo } from "./format-info";
import { applyBestMask } from "./mask";
import { buildMatrix, flattenMatrix } from "./matrix";
import { interleaveBlocks, rsEncodeBlock } from "./reed-solomon";
import type { EncodeOptions, QRMatrix, QRVersion } from "./types";

type EncodedDetails = {
  matrix: QRMatrix;
  maskId: number;
};

function buildDataCodewords(inputBytes: Uint8Array, version: QRVersion): Uint8Array {
  const { dataCodewords } = getVersionInfo(version);
  const buffer = new BitBuffer();
  const totalDataBits = dataCodewords * 8;

  buffer.write(0b0100, 4);
  buffer.write(inputBytes.length, 8);
  buffer.writeBytes(inputBytes);

  if (buffer.length > totalDataBits) {
    throw new Error(
      `Input is too large for QR version ${version}-H (${inputBytes.length} UTF-8 bytes)`,
    );
  }

  const terminatorBits = Math.min(4, totalDataBits - buffer.length);
  buffer.write(0, terminatorBits);
  buffer.padToByte();

  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (buffer.length < totalDataBits) {
    buffer.write(padBytes[padIndex % padBytes.length], 8);
    padIndex += 1;
  }

  return buffer.toBytes();
}

function splitIntoBlocks(version: QRVersion, dataCodewords: Uint8Array) {
  const versionInfo = getVersionInfo(version);
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let offset = 0;

  for (const group of versionInfo.blocks) {
    for (let i = 0; i < group.count; i += 1) {
      const data = dataCodewords.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;

      blocks.push({
        data,
        ecc: rsEncodeBlock(data, versionInfo.ecCodewordsPerBlock),
      });
    }
  }

  return blocks;
}

function codewordsToBits(codewords: Uint8Array): number[] {
  const bits: number[] = [];

  for (const codeword of codewords) {
    for (let shift = 7; shift >= 0; shift -= 1) {
      bits.push((codeword >>> shift) & 1);
    }
  }

  return bits;
}

export function encodeQRDetailed(input: string, options: EncodeOptions = {}): EncodedDetails {
  const inputBytes = new TextEncoder().encode(input);
  const version = options.version ?? chooseVersion(inputBytes.length);
  const versionInfo = getVersionInfo(version);

  if (inputBytes.length > versionInfo.byteCapacityH) {
    throw new Error(
      `Input is ${inputBytes.length} bytes in UTF-8, which exceeds QR version ${version}-H capacity (${versionInfo.byteCapacityH} bytes)`,
    );
  }

  const dataCodewords = buildDataCodewords(inputBytes, version);
  const blocks = splitIntoBlocks(version, dataCodewords);
  const interleaved = interleaveBlocks(blocks);
  const matrixWithData = buildMatrix(version, codewordsToBits(interleaved));
  const { masked, maskId } = applyBestMask(matrixWithData);

  placeFormatInfo(masked, maskId);

  return {
    maskId,
    matrix: {
      version,
      size: versionInfo.size,
      data: flattenMatrix(masked),
    },
  };
}

export function encodeQR(input: string, options?: EncodeOptions): QRMatrix {
  return encodeQRDetailed(input, options).matrix;
}
