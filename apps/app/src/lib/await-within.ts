/**
 * Wait for a promise at most `timeoutMs`. Built for a system dialog whose answer may never come back:
 * Android can dismiss a runtime-permission request without resolving it (a second permission dialog opened
 * over it, the activity recreated under it), and a caller that awaits the bare promise then hangs for the
 * rest of the process with its in-flight guard set. Pure: the timer is cleared the moment `pending`
 * settles, an answer that arrives after the deadline is ignored (never an unhandled rejection), and a
 * rejection before the deadline passes through as a rejection, so the caller's own error path still runs.
 */
export type AwaitWithinResult<T> = { timedOut: false; value: T } | { timedOut: true };

export function awaitWithin<T>(pending: Promise<T>, timeoutMs: number): Promise<AwaitWithinResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    pending.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
