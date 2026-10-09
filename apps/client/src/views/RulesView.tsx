import { ScreenHeader } from "../components/ScreenHeader";
import { t } from "../i18n";

/** The rules, in the order the page shows them: a short heading and one plain sentence or two each. */
export const MEMBER_RULES = [
  { title: "rules.kindTitle", body: "rules.kindBody" },
  { title: "rules.childrenTitle", body: "rules.childrenBody" },
  { title: "rules.privacyTitle", body: "rules.privacyBody" },
  { title: "rules.spamTitle", body: "rules.spamBody" },
  { title: "rules.adultsTitle", body: "rules.adultsBody" },
  { title: "rules.helpTitle", body: "rules.helpBody" },
] as const;

/**
 * LOAM's member rules (`MEMBER_RULES_VERSION` in @loam/schema), served by this node at `/rules` so they read
 * with no internet, in the network's language. Linked from the Welcome screen (where people agree to them)
 * and from Settings. They define what's not allowed, as Google Play's UGC policy asks, without legalese.
 */
export function RulesView({ backHref = "/settings", standalone = false }: { backHref?: string; standalone?: boolean }) {
  return (
    <section className="settings-view rules-view">
      <ScreenHeader backHref={backHref} title={t("rules.title")} />
      <div className="screen-body">
        <div className="screen-column member-rules">
          <p className="rules-intro">{t("rules.intro")}</p>
          {MEMBER_RULES.map((rule) => (
            <section key={rule.title}>
              <h2>{t(rule.title)}</h2>
              <p>{t(rule.body)}</p>
            </section>
          ))}
          {/* Opened from the Welcome screen there's no sidebar to leave by, so offer the way back here too. */}
          {standalone ? (
            <a className="btn btn-secondary rules-back" href={backHref}>
              {t("common.back")}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
