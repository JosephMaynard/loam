import { gfMul, gfPow } from "./gf256.js";

const generatorCache = new Map<number, Uint8Array>();

export function rsGeneratorPoly(ecCount: number): Uint8Array {
  const cached = generatorCache.get(ecCount);
  if (cached) {
    return cached.slice();
  }

  let poly = Uint8Array.from([1]);

  for (let degree = 0; degree < ecCount; degree += 1) {
    const next = new Uint8Array(poly.length + 1);

    for (let i = 0; i < poly.length; i += 1) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], gfPow(degree));
    }

    poly = next;
  }

  generatorCache.set(ecCount, poly.slice());
  return poly.slice();
}

export function rsEncodeBlock(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = rsGeneratorPoly(ecCount);
  const remainder = new Uint8Array(ecCount);

  for (const dataByte of data) {
    const factor = dataByte ^ remainder[0];

    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;

    for (let i = 0; i < ecCount; i += 1) {
      remainder[i] ^= gfMul(generator[i + 1], factor);
    }
  }

  return remainder;
}

export function interleaveBlocks(
  blocks: {
    data: Uint8Array;
    ecc: Uint8Array;
  }[],
): Uint8Array {
  const interleaved: number[] = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.data.length));
  const maxEccLength = Math.max(...blocks.map((block) => block.ecc.length));

  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) {
        interleaved.push(block.data[i]);
      }
    }
  }

  for (let i = 0; i < maxEccLength; i += 1) {
    for (const block of blocks) {
      if (i < block.ecc.length) {
        interleaved.push(block.ecc[i]);
      }
    }
  }

  return Uint8Array.from(interleaved);
}
