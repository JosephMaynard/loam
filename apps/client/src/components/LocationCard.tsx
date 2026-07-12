import type { MessageLocation } from "@loam/schema";

import { t } from "../i18n";

/**
 * Compact card rendering a shared location (docs/10) below a message body: a pin, the human label
 * (or the coordinates when there is no label), the coordinates alongside the label when both are
 * present, and — only when `lat`/`lng` are both present — a `geo:` link that opens the OS maps app.
 * `geo:` works without internet, unlike a web map URL, matching LOAM's off-grid design. Plain text
 * throughout (Preact escapes it automatically) — never render the label as HTML.
 */
export function LocationCard({ location }: { location: MessageLocation }) {
  const hasCoords = location.lat !== undefined && location.lng !== undefined;
  const coordsText = hasCoords
    ? t("location.coordinates", { lat: location.lat!.toFixed(5), lng: location.lng!.toFixed(5) })
    : undefined;
  const primary = location.label ?? coordsText ?? "";

  return (
    <div className="location-card">
      <span aria-hidden="true" className="location-pin">
        📍
      </span>
      <div className="location-details">
        <span className="location-label">{primary}</span>
        {location.label && coordsText ? <span className="location-coords">{coordsText}</span> : null}
        {hasCoords ? (
          <a className="location-open-maps" href={`geo:${location.lat},${location.lng}`}>
            {t("location.openInMaps")}
          </a>
        ) : null}
      </div>
    </div>
  );
}
