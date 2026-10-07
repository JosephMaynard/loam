import { t } from "../i18n";
import { CardHeader } from "./ScreenParts";

/**
 * Static "getting started" checklist shown at the top of the admin config form. Purely
 * presentational — all copy comes from the active locale, so it takes no props.
 */
export function GettingStartedPanel() {
  return (
    <div className="card getting-started">
      <CardHeader title={t("admin.gettingStartedTitle")} />
      <ol className="getting-started-steps">
        <li><strong>{t("admin.step1Title")}</strong>: {t("admin.step1Body")}</li>
        <li><strong>{t("admin.step2Title")}</strong>: {t("admin.step2Body")}</li>
        <li><strong>{t("admin.step3Title")}</strong>: {t("admin.step3Body")}</li>
        <li><strong>{t("admin.step4Title")}</strong>: {t("admin.step4Body")}</li>
        <li><strong>{t("admin.step5Title")}</strong>: {t("admin.step5Body")}</li>
      </ol>
      <p className="form-note">
        {t("admin.gettingStartedNoteBefore")}{" "}
        <a href="https://github.com/MagicZebraLtd/loam/blob/master/docs/12-operators-guide.md" rel="noreferrer" target="_blank">
          {t("admin.gettingStartedGuideLink")}
        </a>{" "}
        {t("admin.gettingStartedNoteAfter")}
      </p>
    </div>
  );
}
