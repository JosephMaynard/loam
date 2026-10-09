import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { awaitWithin } from './await-within';

/** A promise the test answers by hand, standing in for a permission dialog. */
function dialog<T>(): { pending: Promise<T>; answer: (value: T) => void; fail: (error: unknown) => void } {
  let answer!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const pending = new Promise<T>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { pending, answer, fail };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('awaitWithin', () => {
  it('passes an answer given before the deadline through, and disarms the timer', async () => {
    const { pending, answer } = dialog<string>();
    const result = awaitWithin(pending, 60_000);
    vi.advanceTimersByTime(59_999);
    answer('granted');
    await expect(result).resolves.toEqual({ timedOut: false, value: 'granted' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a timeout when no answer comes, and ignores one that arrives late', async () => {
    const { pending, answer } = dialog<string>();
    const result = awaitWithin(pending, 60_000);
    vi.advanceTimersByTime(60_000);
    await expect(result).resolves.toEqual({ timedOut: true });
    answer('granted');
    await expect(result).resolves.toEqual({ timedOut: true });
  });

  it('passes a rejection before the deadline through, and disarms the timer', async () => {
    const { pending, fail } = dialog<string>();
    const result = awaitWithin(pending, 60_000);
    fail(new Error('no foreground activity'));
    await expect(result).rejects.toThrow('no foreground activity');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows a rejection that arrives after the deadline', async () => {
    // Vitest fails the run on an unhandled rejection, so reaching the end is the assertion.
    const { pending, fail } = dialog<string>();
    const result = awaitWithin(pending, 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(result).resolves.toEqual({ timedOut: true });
    fail(new Error('late'));
    await Promise.resolve();
  });
});
