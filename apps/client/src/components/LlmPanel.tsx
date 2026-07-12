import type { LoamConfig } from "@loam/schema";

import { t } from "../i18n";

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
    <div className="profile-panel">
      <div>
        <p className="eyebrow">{t("admin.llmEyebrow")}</p>
        <h2>{t("admin.llmHeading")}</h2>
      </div>
      <label className="admin-toggle">
        <input
          checked={ollama.enabled}
          disabled={saving}
          onInput={(event) => onOllamaChange({ enabled: event.currentTarget.checked })}
          type="checkbox"
        />
        {t("admin.llmEnable")}
      </label>
      <label>
        {t("admin.llmBaseUrl")}
        <input
          disabled={saving}
          onInput={(event) => onOllamaChange({ baseUrl: event.currentTarget.value })}
          value={ollama.baseUrl}
        />
      </label>
      <label>
        {t("admin.llmModel")}
        <input
          disabled={saving}
          onInput={(event) => onOllamaChange({ model: event.currentTarget.value })}
          value={ollama.model}
        />
      </label>
      <label>
        {t("admin.llmBotName")}
        <input
          disabled={saving}
          maxLength={80}
          onInput={(event) => onOllamaChange({ botDisplayName: event.currentTarget.value })}
          value={ollama.botDisplayName}
        />
      </label>
      <label>
        {t("admin.llmSystemPrompt")}
        <textarea
          disabled={saving}
          onInput={(event) => onOllamaChange({ systemPrompt: event.currentTarget.value || undefined })}
          rows={3}
          value={ollama.systemPrompt ?? ""}
        />
      </label>
      <label className="admin-toggle">
        <input
          checked={onDevice.enabled}
          disabled={saving}
          onInput={(event) => onOnDeviceChange({ enabled: event.currentTarget.checked })}
          type="checkbox"
        />
        {t("admin.llmOnDeviceEnable")}
      </label>
      <label>
        {t("admin.llmOnDeviceModel")}
        <input
          disabled={saving || !onDevice.enabled}
          maxLength={120}
          onInput={(event) => onOnDeviceChange({ model: event.currentTarget.value || undefined })}
          value={onDevice.model ?? ""}
        />
      </label>
      <p className="form-note">{t("admin.llmOnDeviceNote")}</p>
    </div>
  );
}
