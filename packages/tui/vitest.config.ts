import { defineConfig } from "vitest/config";

// The kiosk tests hash passwords with scrypt at the real cost (N = 2^17, a few hundred ms each); on a loaded
// machine, as when every workspace suite runs at once, that can pass vitest's 5 s default.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
