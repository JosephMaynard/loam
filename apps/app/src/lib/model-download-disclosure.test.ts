import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { confirmModelDownload, modelDownloadDisclosure } from "./model-download-disclosure";
import type { ShowAlertButton } from "./show-alert";

describe("modelDownloadDisclosure (docs/30 H4)", () => {
  it("states the size and warns about mobile/metered data for a catalog model", () => {
    const text = modelDownloadDisclosure("Gemma 3 4B", "2.3 GB");
    expect(text.title).toBe("Download Gemma 3 4B (2.3 GB)?");
    expect(text.message).toContain("2.3 GB");
    expect(text.message).toMatch(/Wi-Fi/);
    expect(text.message).toMatch(/mobile data|metered/);
  });

  it("says the size is unknown for a custom URL, and still warns", () => {
    const text = modelDownloadDisclosure("model.gguf", undefined);
    expect(text.title).toBe("Download model.gguf?");
    expect(text.message).toMatch(/isn't known/);
    expect(text.message).toMatch(/metered/);
  });
});

describe("confirmModelDownload: the download starts only after the Alert is accepted", () => {
  /** Show the confirmation against a mock `Alert.alert`; returns its buttons and the start spy. */
  function show(sizeLabel: string | undefined) {
    let buttons: ShowAlertButton[] = [];
    const showAlert = vi.fn((_title: string, _message?: string, shown?: ShowAlertButton[]) => {
      buttons = shown ?? [];
    });
    const start = vi.fn();
    confirmModelDownload(showAlert, "Gemma 3 1B", sizeLabel, start);
    return { showAlert, start, button: (text: string) => buttons.find((candidate) => candidate.text === text) };
  }

  it("shows the disclosure without starting anything", () => {
    const { showAlert, start } = show("0.8 GB");
    expect(showAlert).toHaveBeenCalledWith(
      "Download Gemma 3 1B (0.8 GB)?",
      expect.stringMatching(/metered/),
      expect.any(Array),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("Cancel never starts the download", () => {
    const { start, button } = show(undefined);
    expect(button("Cancel")?.style).toBe("cancel");
    button("Cancel")?.onPress?.();
    expect(start).not.toHaveBeenCalled();
  });

  it("Download starts it exactly once", () => {
    const { start, button } = show("0.8 GB");
    button("Download")?.onPress?.();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("the model manager reaches both download paths only through the confirmation", () => {
    // No renderer in this harness, so pin the wiring in the component source: the catalog download and the
    // custom-URL download are each referenced only as the `start` argument of `confirmThenDownload`, which
    // is `confirmModelDownload(Alert.alert, …)`.
    const source = readFileSync(join(__dirname, "../components/model-manager.tsx"), "utf8");
    expect(source).toMatch(/const confirmThenDownload = [^;]*confirmModelDownload\(Alert\.alert,/);
    const catalogCalls = [...source.matchAll(/handleDownloadCatalogEntry\(/g)].length;
    const catalogConfirmed = [
      ...source.matchAll(/confirmThenDownload\([^;]*?\(\) => void handleDownloadCatalogEntry\(entry\)\)/g),
    ].length;
    expect(catalogConfirmed).toBe(1);
    expect(catalogCalls).toBe(catalogConfirmed);
    const customRefs = [...source.matchAll(/\bhandleAddCustomUrl\b(?!Press)/g)].length;
    // The definition + the one confirmed start.
    expect(source).toMatch(/confirmThenDownload\(prepared\.displayName, undefined, handleAddCustomUrl\)/);
    expect(customRefs).toBe(2);
  });
});
