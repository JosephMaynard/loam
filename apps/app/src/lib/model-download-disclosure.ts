// What the operator is told BEFORE a model download starts (docs/30 H4, pre-release review 2026-09-25).
// Catalog models are 0.8–4.5 GB; a surprise download of that size over mobile data is exactly what Play's
// guidance (and common sense) says must not happen. The app has no network-type API (no expo-network /
// NetInfo dependency), so the Wi-Fi / metered-data warning is shown for EVERY download, not just metered.

export type DownloadDisclosure = { title: string; message: string; confirmLabel: string };

/**
 * The confirmation text for downloading `name`. `sizeLabel` is the human-readable size (e.g. "2.3 GB"),
 * or undefined when it isn't known up front (a custom URL).
 */
export function modelDownloadDisclosure(name: string, sizeLabel: string | undefined): DownloadDisclosure {
  const sizePart = sizeLabel
    ? `This downloads ${sizeLabel}.`
    : "The size of a custom model isn't known until the download starts — models are usually 0.5–5 GB.";
  return {
    title: sizeLabel ? `Download ${name} (${sizeLabel})?` : `Download ${name}?`,
    message:
      `${sizePart} Use Wi-Fi if you can: on mobile data or a metered connection this can use a large part ` +
      'of your data allowance and may cost money. Keep LOAM open until it finishes — leaving the app ' +
      'cancels the download.',
    confirmLabel: 'Download',
  };
}
