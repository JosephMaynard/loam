import { t } from "../i18n";

/**
 * Static "getting started" checklist shown at the top of the admin config form. Purely
 * presentational — all copy comes from the active locale, so it takes no props.
 */
export function GettingStartedPanel() {
  return (
    <div className="profile-panel getting-started">
      <div>
        <p className="eyebrow">{t("admin.gettingStartedEyebrow")}</p>
        <h2>{t("admin.gettingStartedTitle")}</h2>
      </div>
      <ol className="getting-started-steps">
        <li><strong>{t("admin.step1Title")}</strong> — {t("admin.step1Body")}</li>
        <li><strong>{t("admin.step2Title")}</strong> — {t("admin.step2Body")}</li>
        <li><strong>{t("admin.step3Title")}</strong> — {t("admin.step3Body")}</li>
        <li><strong>{t("admin.step4Title")}</strong> — {t("admin.step4Body")}</li>
        <li><strong>{t("admin.step5Title")}</strong> — {t("admin.step5Body")}</li>
      </ol>
      <p className="form-note">
        {t("admin.gettingStartedNoteBefore")}{" "}
        <a href="https://github.com/JosephMaynard/loam/blob/master/docs/12-operators-guide.md" rel="noreferrer" target="_blank">
          {t("admin.gettingStartedGuideLink")}
        </a>{" "}
        {t("admin.gettingStartedNoteAfter")}
      </p>
    </div>
  );
}
