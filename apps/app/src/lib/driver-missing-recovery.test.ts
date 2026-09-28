// The driver-missing lock screen's actions (src/app/index.tsx → driver-missing-recovery.ts): Retry re-probes,
// and "Start without encryption" does NOTHING until its confirmation is accepted, then commits mode 'off' and
// retries. The Alert is a mock whose buttons the tests press.
import { describe, expect, it, vi } from "vitest";

import { cryptoMock, secureStoreMock } from "@/test-utils/mocks";

import type { DbEncryptionMode } from "./db-encryption";
import {
  confirmStartUnencrypted,
  retryKeyResolution,
  startUnencryptedConfirmation,
  switchEncryptionOffAndRetry,
} from "./driver-missing-recovery";
import type { ShowAlertButton } from "./show-alert";

// db-encryption.ts (behind applyDbModeChange) imports these native modules; vi.mock is hoisted above the
// imports, so the in-memory fakes are in place before it loads.
vi.mock("expo-secure-store", () => secureStoreMock);
vi.mock("expo-crypto", () => cryptoMock);

/** A mock `Alert.alert` recording each dialog, with a helper to press a button by label. */
function mockAlert() {
  const dialogs: { title: string; message?: string; buttons: ShowAlertButton[] }[] = [];
  const showAlert = vi.fn((title: string, message?: string, buttons?: ShowAlertButton[]) => {
    dialogs.push({ title, message, buttons: buttons ?? [] });
  });
  const press = (label: string) => {
    const button = dialogs.at(-1)?.buttons.find((candidate) => candidate.text === label);
    if (!button) throw new Error(`no "${label}" button`);
    button.onPress?.();
  };
  return { showAlert, dialogs, press };
}

/** In-memory mode store + bridge fakes for the switch-off transaction. */
function fakeDeps(initial: DbEncryptionMode, opts: { writeFails?: boolean; unlockFails?: boolean } = {}) {
  let mode: DbEncryptionMode = initial;
  const calls: string[] = [];
  return {
    get mode() {
      return mode;
    },
    calls,
    readMode: vi.fn(async () => mode),
    writeMode: vi.fn(async (next: DbEncryptionMode) => {
      calls.push(`mode:${next}`);
      if (opts.writeFails) return { ok: false, error: "keystore error" };
      mode = next;
      return { ok: true };
    }),
    writeHint: vi.fn(async (next: DbEncryptionMode) => {
      calls.push(`hint:${next}`);
      return { ok: true };
    }),
    requestUnlock: vi.fn(async () => {
      calls.push("unlock");
      return opts.unlockFails ? { ok: false, error: "timed out" } : { ok: true };
    }),
  };
}

describe("driver-missing lock: Retry", () => {
  it("re-asserts the hint for the known mode, then asks the launcher to retry", async () => {
    const deps = fakeDeps("persistent");
    const result = await retryKeyResolution({ lockedMode: "persistent", writeHint: deps.writeHint, requestUnlock: deps.requestUnlock });
    expect(result).toEqual({ ok: true });
    expect(deps.calls).toEqual(["hint:persistent", "unlock"]);
    expect(deps.writeMode).not.toHaveBeenCalled();
  });

  it("skips the hint when the mode couldn't be read, and passes a failure through", async () => {
    const deps = fakeDeps("persistent", { unlockFails: true });
    const result = await retryKeyResolution({ lockedMode: undefined, writeHint: deps.writeHint, requestUnlock: deps.requestUnlock });
    expect(result).toEqual({ ok: false, error: "timed out" });
    expect(deps.calls).toEqual(["unlock"]);
  });
});

describe("driver-missing lock: Start without encryption", () => {
  it("does nothing until confirmed, then commits mode 'off' and retries", async () => {
    const deps = fakeDeps("persistent");
    const alert = mockAlert();
    let switched: Promise<unknown> | undefined;
    confirmStartUnencrypted(alert.showAlert, "persistent", () => {
      switched = switchEncryptionOffAndRetry(deps);
    });

    expect(alert.showAlert).toHaveBeenCalledTimes(1);
    expect(alert.dialogs[0].title).toBe("Start without encryption?");
    expect(deps.calls).toEqual([]);

    alert.press("Switch encryption off");
    await expect(switched).resolves.toEqual({ ok: true });
    expect(deps.mode).toBe("off");
    expect(deps.calls).toEqual(["mode:off", "hint:off", "unlock"]);
  });

  it("Cancel leaves the encrypted mode alone", () => {
    const deps = fakeDeps("passphrase");
    const alert = mockAlert();
    const onConfirm = vi.fn(() => void switchEncryptionOffAndRetry(deps));
    confirmStartUnencrypted(alert.showAlert, "passphrase", onConfirm);
    alert.press("Cancel");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(deps.calls).toEqual([]);
    expect(deps.mode).toBe("passphrase");
    // The destructive choice is marked as such.
    expect(alert.dialogs[0].buttons.find((button) => button.text === "Switch encryption off")?.style).toBe("destructive");
  });

  it("doesn't retry when mode 'off' couldn't be committed, and reports which step failed", async () => {
    const failedWrite = fakeDeps("persistent", { writeFails: true });
    await expect(switchEncryptionOffAndRetry(failedWrite)).resolves.toEqual({ ok: false, failed: "mode", error: "keystore error" });
    expect(failedWrite.requestUnlock).not.toHaveBeenCalled();

    const failedRetry = fakeDeps("persistent", { unlockFails: true });
    await expect(switchEncryptionOffAndRetry(failedRetry)).resolves.toEqual({ ok: false, failed: "retry", error: "timed out" });
    expect(failedRetry.mode).toBe("off");
  });
});

describe("driver-missing lock: confirmation copy", () => {
  it("ephemeral: says the previous database is already gone, never that it stays on disk", () => {
    const { message } = startUnencryptedConfirmation("ephemeral");
    expect(message).toMatch(/UNENCRYPTED/);
    expect(message).toMatch(/already gone/);
    expect(message).not.toMatch(/stays on disk|preserve/);
  });

  it("persistent/passphrase: the encrypted database stays on disk and can be preserved", () => {
    for (const mode of ["persistent", "passphrase"] as const) {
      const { message } = startUnencryptedConfirmation(mode);
      expect(message).toMatch(/stays on disk/);
      expect(message).toMatch(/preserve/);
      expect(message).not.toMatch(/already gone/);
    }
  });

  it("unknown mode: covers both cases", () => {
    const { message } = startUnencryptedConfirmation(undefined);
    expect(message).toMatch(/ephemeral/);
    expect(message).toMatch(/stays on disk/);
  });
});
