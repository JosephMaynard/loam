import path from "node:path";
import { defineConfig } from "vitest/config";

// Node environment: the modules under test (src/lib/*) are pure RN logic — SecureStore/crypto/
// file-system/bridge-backed — not rendered components, so jsdom isn't needed (unlike
// apps/client's harness). The `@` alias mirrors tsconfig.json's `"@/*": ["./src/*"]` path mapping
// so tests can import the same way app code does. Native Expo modules (expo-secure-store,
// expo-crypto, expo-file-system) are never actually loaded — tests replace them via `vi.mock`
// with the in-memory fakes in `src/test-utils/mocks.ts` before importing the module under test.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
