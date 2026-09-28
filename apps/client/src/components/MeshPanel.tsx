import type { LoamConfig } from "@loam/schema";

import { t } from "../i18n";
import { clamp } from "../lib/numbers";
import { CardHeader, SwitchRow } from "./ScreenParts";

type MeshConfig = LoamConfig["mesh"];

// Opportunistic-mesh (docs/16) `ttlMs` bounds, mirrored from `MeshConfigSchema` in @loam/schema —
// the admin panel edits the value in hours, so these are the ms bounds converted for display/clamp.
const MESH_TTL_MS_MIN = 60_000;
const MESH_TTL_MS_MAX = 7 * 24 * 3_600_000;
const MESH_TTL_HOURS_MIN = MESH_TTL_MS_MIN / 3_600_000;
const MESH_TTL_HOURS_MAX = MESH_TTL_MS_MAX / 3_600_000;

/**
 * Admin opportunistic-mesh (docs/16) settings panel: enable/relay toggles plus the TTL (edited in
 * hours), hop limit, and carried/contact caps. Presentational — the current `mesh` config and
 * `saving` flag come in via props, and every edit funnels through `onChange` with a partial update
 * (mirroring AdminView's `setMesh`), so this component holds no state of its own.
 */
export function MeshPanel({
  mesh,
  saving,
  onChange,
}: {
  mesh: MeshConfig;
  saving: boolean;
  onChange: (update: Partial<MeshConfig>) => void;
}) {
  return (
    <div className="card">
      <CardHeader level={3} title={t("admin.meshHeading")} />
      <div className="switch-list">
        <SwitchRow
          checked={mesh.enabled}
          description={t("admin.meshNote")}
          disabled={saving}
          label={t("admin.meshEnable")}
          onChange={(enabled) => onChange({ enabled })}
        />
        <SwitchRow
          checked={mesh.relay}
          disabled={saving || !mesh.enabled}
          label={t("admin.meshRelay")}
          onChange={(relay) => onChange({ relay })}
        />
      </div>
      <label className="field">
        <span className="field-label">{t("admin.meshLifetimeLabel")}</span>
        <input
          className="input input-narrow"
          disabled={saving || !mesh.enabled}
          max={MESH_TTL_HOURS_MAX}
          min={MESH_TTL_HOURS_MIN}
          onInput={(event) => {
            const hours = Number.parseFloat(event.currentTarget.value);
            if (Number.isFinite(hours)) {
              onChange({
                ttlMs: clamp(Math.round(hours * 3_600_000), MESH_TTL_MS_MIN, MESH_TTL_MS_MAX),
              });
            }
          }}
          step="0.5"
          type="number"
          value={String(Math.round((mesh.ttlMs / 3_600_000) * 100) / 100)}
        />
        <span className="field-hint">{t("admin.meshLifetimeNote")}</span>
      </label>
      <div className="field-grid">
        <label className="field">
          <span className="field-label">{t("admin.meshHopLimitLabel")}</span>
          <input
            className="input"
            disabled={saving || !mesh.enabled}
            max={16}
            min={1}
            onInput={(event) => {
              const hopLimit = Number.parseInt(event.currentTarget.value, 10);
              if (Number.isFinite(hopLimit)) {
                onChange({ hopLimit: clamp(hopLimit, 1, 16) });
              }
            }}
            type="number"
            value={String(mesh.hopLimit)}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("admin.meshMaxCarriedLabel")}</span>
          <input
            className="input"
            disabled={saving || !mesh.enabled}
            max={100_000}
            min={0}
            onInput={(event) => {
              const maxCarried = Number.parseInt(event.currentTarget.value, 10);
              if (Number.isFinite(maxCarried)) {
                onChange({ maxCarried: clamp(maxCarried, 0, 100_000) });
              }
            }}
            type="number"
            value={String(mesh.maxCarried)}
          />
        </label>
        <label className="field">
          <span className="field-label">{t("admin.meshMaxContactsLabel")}</span>
          <input
            className="input"
            disabled={saving || !mesh.enabled}
            max={100_000}
            min={0}
            onInput={(event) => {
              const maxContacts = Number.parseInt(event.currentTarget.value, 10);
              if (Number.isFinite(maxContacts)) {
                onChange({ maxContacts: clamp(maxContacts, 0, 100_000) });
              }
            }}
            type="number"
            value={String(mesh.maxContacts)}
          />
        </label>
      </div>
    </div>
  );
}
