const FIELD_SIZE = 256;
const PRIMITIVE_POLY = 0x11d;

const exp = new Uint8Array(FIELD_SIZE * 2);
const log = new Uint8Array(FIELD_SIZE);

let x = 1;
for (let i = 0; i < FIELD_SIZE - 1; i += 1) {
  exp[i] = x;
  log[x] = i;

  x <<= 1;
  if ((x & FIELD_SIZE) !== 0) {
    x ^= PRIMITIVE_POLY;
  }
}

for (let i = FIELD_SIZE - 1; i < exp.length; i += 1) {
  exp[i] = exp[i - (FIELD_SIZE - 1)];
}

export const GF_EXP = exp;
export const GF_LOG = log;

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }

  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Cannot divide by zero in GF(256)");
  }

  if (a === 0) {
    return 0;
  }

  let exponent = GF_LOG[a] - GF_LOG[b];
  if (exponent < 0) {
    exponent += 255;
  }

  return GF_EXP[exponent];
}

export function gfPow(exponent: number): number {
  const normalized = ((exponent % 255) + 255) % 255;
  return GF_EXP[normalized];
}
