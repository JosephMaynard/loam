import { describe, expect, it } from "vitest";

import { dayKey, dayLabel } from "./dates";

// A fixed reference "now": 2026-07-06 14:30 local time.
const NOW = new Date(2026, 6, 6, 14, 30).getTime();

describe("dayKey", () => {
  it("groups timestamps by local calendar day", () => {
    const morning = new Date(2026, 6, 6, 0, 5).getTime();
    const night = new Date(2026, 6, 6, 23, 55).getTime();
    const nextDay = new Date(2026, 6, 7, 0, 5).getTime();

    expect(dayKey(morning)).toBe(dayKey(night));
    expect(dayKey(night)).not.toBe(dayKey(nextDay));
  });
});

describe("dayLabel", () => {
  it("labels the current day Today and the previous day Yesterday", () => {
    expect(dayLabel(new Date(2026, 6, 6, 1, 0).getTime(), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 6, 5, 23, 0).getTime(), NOW)).toBe("Yesterday");
  });

  it("formats older days with weekday and date, adding the year only across years", () => {
    const sameYear = dayLabel(new Date(2026, 5, 1).getTime(), NOW);
    expect(sameYear).not.toBe("Today");
    expect(sameYear).toContain("1");
    expect(sameYear).not.toContain("2026");

    const otherYear = dayLabel(new Date(2025, 11, 31).getTime(), NOW);
    expect(otherYear).toContain("2025");
  });
});
