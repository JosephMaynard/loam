import { BitBuffer } from "./bit-buffer.js";
import { chooseVersion, getVersionInfo } from "./capacity.js";
import { placeFormatInfo } from "./format-info.js";
import { applyBestMask } from "./mask.js";
import { buildMatrix, flattenMatrix } from "./matrix.js";
import { interleaveBlocks, rsEncodeBlock } from "./reed-solomon.js";
import type { EncodeOptions, QRErrorCorrectionLevel, QRMatrix, QRVersion } from "./types.js";

type EncodedDetails = {
  matrix: QRMatrix;
  maskId: number;
};

function buildDataCodewords(
  inputBytes: Uint8Array,
  version: QRVersion,
  ecLevel: QRErrorCorrectionLevel,
): Uint8Array {
  const { dataCodewords } = getVersionInfo(version, ecLevel);
  const buffer = new BitBuffer();
  const totalDataBits = dataCodewords * 8;

  buffer.write(0b0100, 4);
  buffer.write(inputBytes.length, 8);
  buffer.writeBytes(inputBytes);

  if (buffer.length > totalDataBits) {
    throw new Error(
      `Input is too large for QR version ${version}-${ecLevel} (${inputBytes.length} UTF-8 bytes)`,
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

function splitIntoBlocks(version: QRVersion, ecLevel: QRErrorCorrectionLevel, dataCodewords: Uint8Array) {
  const versionInfo = getVersionInfo(version, ecLevel);
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let offset = 0;

  for (const group of versionInfo.blocks) {
    for (let i = 0; i < group.count; i += 1) {
      const data = dataCodewords.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;

      blocks.push({
        data,
        ecc: rsEncodeBlock(data, group.ecCodewordsPerBlock ?? versionInfo.ecCodewordsPerBlock),
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
  const ecLevel = options.ecLevel ?? "H";
  const inputBytes = new TextEncoder().encode(input);
  const version = options.version ?? chooseVersion(inputBytes.length, ecLevel);
  const versionInfo = getVersionInfo(version, ecLevel);

  if (inputBytes.length > versionInfo.byteCapacity) {
    throw new Error(
      `Input is ${inputBytes.length} bytes in UTF-8, which exceeds QR version ${version}-${ecLevel} capacity (${versionInfo.byteCapacity} bytes)`,
    );
  }

  const dataCodewords = buildDataCodewords(inputBytes, version, ecLevel);
  const blocks = splitIntoBlocks(version, ecLevel, dataCodewords);
  const interleaved = interleaveBlocks(blocks);
  const matrixWithData = buildMatrix(version, codewordsToBits(interleaved));
  const { masked, maskId } = applyBestMask(matrixWithData);

  placeFormatInfo(masked, maskId, ecLevel);

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
