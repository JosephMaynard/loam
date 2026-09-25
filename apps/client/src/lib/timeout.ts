import type { User } from "@loam/schema";
import { useEffect, useState } from "preact/hooks";

/** Whether a user is currently under an active (not-yet-expired) moderator timeout. */
export function isTimedOut(user: User): boolean {
  return user.timeoutUntil !== undefined && user.timeoutUntil > Date.now();
}

/**
 * Reactive `isTimedOut`: schedules a single re-render at the exact moment the timeout expires, so a
 * disabled composer re-enables on its own instead of waiting for an unrelated re-render.
 */
export function useIsTimedOut(user: User): boolean {
  const [, force] = useState(0);
  const until = user.timeoutUntil;

  useEffect(() => {
    if (until === undefined || until <= Date.now()) {
      return;
    }
    const id = window.setTimeout(() => force((n) => n + 1), until - Date.now());
    return () => window.clearTimeout(id);
  }, [until]);

  return isTimedOut(user);
}
