import { useEffect, useState } from "preact/hooks";

import { apiUrl, encryptedImageUrl, isTunnelActive } from "./transport";

/**
 * Resolve an image path to a render-ready `src` (docs/08). In the default (non-tunnel) case this is
 * just the same-origin URL, returned synchronously so there's no flash. When the tunnel is active
 * (`required` mode) the raw endpoint won't serve a direct `<img>` GET, so the bytes are fetched through
 * the tunnel and a `blob:` URL is swapped in once ready — `undefined` until then, so nothing renders a
 * broken image. `undefined` in → `undefined` out.
 *
 * @param path - The server-relative image path (e.g. `/api/avatars/<id>.webp`), or `undefined`.
 * @returns The `src` to use, or `undefined` while a tunnelled image is still resolving.
 */
export function useEncryptedImage(path: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() =>
    path === undefined ? undefined : isTunnelActive() ? undefined : apiUrl(path),
  );

  useEffect(() => {
    if (path === undefined) {
      setSrc(undefined);
      return;
    }

    if (!isTunnelActive()) {
      setSrc(apiUrl(path));
      return;
    }

    let active = true;
    setSrc(undefined);
    void encryptedImageUrl(path).then((resolved) => {
      if (active) {
        setSrc(resolved);
      }
    });

    return () => {
      active = false;
    };
  }, [path]);

  return src;
}
