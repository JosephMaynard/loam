export class BitBuffer {
  private readonly bits: number[] = [];

  write(value: number, bitCount: number): void {
    if (!Number.isInteger(bitCount) || bitCount < 0 || bitCount > 32) {
      throw new Error(`Bit count must be an integer from 0 to 32, received ${bitCount}`);
    }

    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Bit value must be a non-negative integer, received ${value}`);
    }

    if (bitCount === 32 ? value > 0xffffffff : value >= 2 ** bitCount) {
      throw new Error(`Bit value ${value} does not fit in ${bitCount} bits`);
    }

    for (let shift = bitCount - 1; shift >= 0; shift -= 1) {
      this.bits.push((value >>> shift) & 1);
    }
  }

  writeBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.write(byte, 8);
    }
  }

  padToByte(): void {
    while (this.bits.length % 8 !== 0) {
      this.bits.push(0);
    }
  }

  toBytes(): Uint8Array {
    if (this.bits.length % 8 !== 0) {
      throw new Error("Bit buffer length must be byte-aligned");
    }

    const bytes = new Uint8Array(this.bits.length / 8);

    for (let i = 0; i < this.bits.length; i += 8) {
      let value = 0;

      for (let j = 0; j < 8; j += 1) {
        value = (value << 1) | this.bits[i + j];
      }

      bytes[i / 8] = value;
    }

    return bytes;
  }

  get length(): number {
    return this.bits.length;
  }
}
