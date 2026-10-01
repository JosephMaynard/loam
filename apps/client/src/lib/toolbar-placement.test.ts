import { describe, expect, it } from "vitest";

import { type Box, placeToolbar } from "./toolbar-placement";

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height };
}

const toolbar = { width: 190, height: 36 };
const wide = box(0, 0, 1200, 800);

describe("placeToolbar", () => {
  it("puts it beside someone else's message, after the bubble", () => {
    const bubble = box(60, 100, 300, 40);
    expect(placeToolbar({ bubble, bounds: wide, mine: false, rtl: false, toolbar })).toEqual({ left: 364, top: 100 });
  });

  it("puts it before your own message", () => {
    const bubble = box(800, 100, 300, 40);
    expect(placeToolbar({ bubble, bounds: wide, mine: true, rtl: false, toolbar })).toEqual({ left: 606, top: 100 });
  });

  it("mirrors in RTL", () => {
    const bubble = box(800, 100, 300, 40);
    expect(placeToolbar({ bubble, bounds: wide, mine: false, rtl: true, toolbar }).left).toBe(606);
  });

  it("falls back to over the top-end corner when there is no room beside", () => {
    const narrow = box(0, 0, 360, 800);
    const bubble = box(50, 100, 290, 40);
    expect(placeToolbar({ bubble, bounds: narrow, mine: false, rtl: false, toolbar })).toEqual({ left: 146, top: 68 });
  });

  it("lifts above the author's name rather than covering it", () => {
    const narrow = box(0, 0, 360, 800);
    const bubble = box(50, 100, 160, 40);
    const name = box(60, 80, 140, 18);
    // Over the corner would sit on the name (a short bubble): go above the name row instead.
    expect(placeToolbar({ bubble, bounds: narrow, mine: false, name, rtl: false, toolbar })).toEqual({ left: 16, top: 40 });
  });

  it("goes under the bubble when the list's top edge leaves no room above (review 2026-10-01)", () => {
    // A thread parent right under the panel header: above-the-name would be clipped by the scroller.
    const narrow = box(0, 85, 360, 700);
    const bubble = box(50, 120, 160, 40);
    const name = box(60, 100, 140, 18);
    const placed = placeToolbar({ bubble, bounds: narrow, mine: false, name, rtl: false, toolbar });
    expect(placed).toEqual({ left: 16, top: 156 });
    expect(placed.top).toBeGreaterThanOrEqual(85);
  });

  it("goes under when even the plain corner position would be clipped at the top", () => {
    const bounds = box(0, 100, 360, 700);
    const bubble = box(50, 110, 290, 40);
    expect(placeToolbar({ bubble, bounds, mine: false, rtl: false, toolbar })).toEqual({ left: 146, top: 146 });
  });

  it("never leaves the bounds", () => {
    const narrow = box(0, 0, 200, 800);
    const bubble = box(20, 100, 60, 40);
    const { left } = placeToolbar({ bubble, bounds: narrow, mine: false, rtl: false, toolbar });
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + toolbar.width).toBeLessThanOrEqual(200);
  });
});
