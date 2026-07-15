// Smoke test for the Vitest harness itself (see apps/app/vitest.config.ts,
// src/test-utils/mocks.ts): proves a real pure-logic module (db-encryption.ts) can be exercised
// end-to-end against the in-memory expo-secure-store/expo-crypto mocks, matching the security
// invariants documented at the top of db-encryption.ts (device secret minted once and reused;
// passphrase-mode key is exactly `SHA256(passphrase + ':' + deviceSecret)`).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cryptoMock, resetCryptoMock, resetSecureStoreMock, secureStoreMock } from "@/test-utils/mocks";

vi.mock("expo-secure-store", () => secureStoreMock);
vi.mock("expo-crypto", () => cryptoMock);

const { resolveDbKey, setStoredPassphrase } = await import("@/lib/db-encryption");

describe("resolveDbKey", () => {
  beforeEach(() => {
    resetSecureStoreMock();
    resetCryptoMock();
  });

  it("persistent mode mints a device secret once and reuses it on later calls", async () => {
    const first = await resolveDbKey("persistent");
    expect(first.mode).toBe("persistent");
    expect(first.key).toBeTruthy();

    const second = await resolveDbKey("persistent");
    expect(second.key).toBe(first.key);
  });

  it("passphrase mode derives SHA256(passphrase + ':' + deviceSecret)", async () => {
    await setStoredPassphrase("hunter2");
    const { key: deviceSecret } = await resolveDbKey("persistent");
    expect(deviceSecret).toBeTruthy();

    const { key } = await resolveDbKey("passphrase");
    const expected = createHash("sha256").update(`hunter2:${deviceSecret}`, "utf8").digest("hex");
    expect(key).toBe(expected);
  });

  it("passphrase mode resolves with no key when no passphrase has been stored", async () => {
    const { key } = await resolveDbKey("passphrase");
    expect(key).toBeUndefined();
  });
});
