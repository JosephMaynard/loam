import type { LoamConfig } from "@loam/schema";

import { t } from "../i18n";
import { CardHeader, SwitchRow } from "./ScreenParts";

type OllamaConfig = LoamConfig["llm"]["ollama"];
type OnDeviceConfig = LoamConfig["llm"]["onDevice"];

/**
 * Admin LLM settings panel: the Ollama connection (enable, base URL, model, bot name, system prompt)
 * plus the on-device model toggle. Presentational — the current `ollama`/`onDevice` config and
 * `saving` flag come in via props, and edits funnel through `onOllamaChange` / `onOnDeviceChange` with
 * a partial update (mirroring AdminView's `setOllama` / `setOnDevice`), so it holds no state itself.
 */
export function LlmPanel({
  ollama,
  onDevice,
  saving,
  onOllamaChange,
  onOnDeviceChange,
}: {
  ollama: OllamaConfig;
  onDevice: OnDeviceConfig;
  saving: boolean;
  onOllamaChange: (update: Partial<OllamaConfig>) => void;
  onOnDeviceChange: (update: Partial<OnDeviceConfig>) => void;
}) {
  return (
    <div className="card">
      <CardHeader level={3} title={t("admin.llmHeading")} />
      <SwitchRow
        checked={ollama.enabled}
        disabled={saving}
        label={t("admin.llmEnable")}
        onChange={(enabled) => onOllamaChange({ enabled })}
      />
      <label className="field">
        <span className="field-label">{t("admin.llmBaseUrl")}</span>
        <input
          className="input"
          disabled={saving}
          onInput={(event) => onOllamaChange({ baseUrl: event.currentTarget.value })}
          value={ollama.baseUrl}
        />
      </label>
      <label className="field">
        <span className="field-label">{t("admin.llmModel")}</span>
        <input
          className="input"
          disabled={saving}
          onInput={(event) => onOllamaChange({ model: event.currentTarget.value })}
          value={ollama.model}
        />
      </label>
      <label className="field">
        <span className="field-label">{t("admin.llmBotName")}</span>
        <input
          className="input"
          disabled={saving}
          maxLength={80}
          onInput={(event) => onOllamaChange({ botDisplayName: event.currentTarget.value })}
          value={ollama.botDisplayName}
        />
      </label>
      <label className="field">
        <span className="field-label">{t("admin.llmSystemPrompt")}</span>
        <textarea
          className="textarea"
          disabled={saving}
          onInput={(event) => onOllamaChange({ systemPrompt: event.currentTarget.value || undefined })}
          rows={3}
          value={ollama.systemPrompt ?? ""}
        />
      </label>
      <div className="card-section">
        <SwitchRow
          checked={onDevice.enabled}
          description={t("admin.llmOnDeviceNote")}
          disabled={saving}
          label={t("admin.llmOnDeviceEnable")}
          onChange={(enabled) => onOnDeviceChange({ enabled })}
        />
        <label className="field">
          <span className="field-label">{t("admin.llmOnDeviceModel")}</span>
          <input
            className="input"
            disabled={saving || !onDevice.enabled}
            maxLength={120}
            onInput={(event) => onOnDeviceChange({ model: event.currentTarget.value || undefined })}
            value={onDevice.model ?? ""}
          />
        </label>
      </div>
    </div>
  );
}
