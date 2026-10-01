import { useId, useState } from "preact/hooks";

import { t } from "../i18n";
import { THEME_PREFERENCES, type ThemePreference, readThemePreference, setThemePreference } from "../lib/theme";
import { CardHeader } from "./ScreenParts";

/** The translated name of each theme choice. */
function themeLabel(preference: ThemePreference): string {
  return preference === "light"
    ? t("settings.themeLight")
    : preference === "dark"
      ? t("settings.themeDark")
      : t("settings.themeSystem");
}

/**
 * Settings card for the colour theme: System (follow the device), Light or Dark, as three radio tiles
 * that each preview their palette. The choice applies at once and is remembered in this browser only.
 */
export function AppearancePanel() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const groupName = useId();
  const titleId = useId();

  function choose(next: ThemePreference): void {
    setPreference(next);
    setThemePreference(next);
  }

  return (
    <div className="card appearance-card">
      <CardHeader description={t("settings.themeNote")} title={t("settings.appearanceTitle")} titleId={titleId} />
      <fieldset aria-labelledby={titleId} className="field theme-field">
        <div className="choice-row">
          {THEME_PREFERENCES.map((option) => (
            <label className="choice-tile" key={option}>
              <input
                checked={preference === option}
                className="choice-input"
                name={groupName}
                onInput={() => choose(option)}
                type="radio"
                value={option}
              />
              <span aria-hidden="true" className="choice-frame" />
              <span aria-hidden="true" className={`theme-swatch theme-swatch-${option}`}>
                <span className="theme-swatch-bubble theme-swatch-theirs" />
                <span className="theme-swatch-bubble theme-swatch-mine" />
              </span>
              <span className="choice-label">{themeLabel(option)}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
