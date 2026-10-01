import { describe, expect, it } from 'vitest';

import { CODE_CAPTION_HEIGHT, displayCodeSize, EXIT_HEIGHT, HEADING_HEIGHT } from './display-layout';

/** Total height the layout needs for `count` stacked codes of `size`. */
function stackedHeight(count: number, size: number): number {
  return HEADING_HEIGHT + EXIT_HEIGHT + 48 + count * (size + CODE_CAPTION_HEIGHT);
}

describe('displayCodeSize', () => {
  it('fills a portrait phone with one code', () => {
    const { size, sideBySide } = displayCodeSize(1, 390, 800);
    expect(sideBySide).toBe(false);
    expect(size).toBe(342); // width-bound: 390 - 2 × 24
    expect(stackedHeight(1, size)).toBeLessThanOrEqual(800);
  });

  it('stacks two codes in portrait without overflowing', () => {
    const { size, sideBySide } = displayCodeSize(2, 390, 800);
    expect(sideBySide).toBe(false);
    expect(stackedHeight(2, size)).toBeLessThanOrEqual(800);
    expect(size).toBeGreaterThanOrEqual(200);
  });

  it('puts two codes side by side in landscape', () => {
    const { size, sideBySide } = displayCodeSize(2, 800, 390);
    expect(sideBySide).toBe(true);
    expect(2 * size + 3 * 24).toBeLessThanOrEqual(800);
    expect(HEADING_HEIGHT + EXIT_HEIGHT + 48 + size + CODE_CAPTION_HEIGHT).toBeLessThanOrEqual(390 + 1);
  });

  it('never goes below a scannable minimum', () => {
    expect(displayCodeSize(2, 240, 320).size).toBe(120);
  });
});
