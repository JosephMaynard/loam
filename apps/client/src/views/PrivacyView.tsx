import { ScreenHeader } from "../components/ScreenHeader";
import { t } from "../i18n";
import { inlineParts, PRIVACY_POLICY, PRIVACY_POLICY_UPDATED } from "../lib/privacy-policy";

/** A policy string with its `**strong**` and `` `code` `` runs, as elements (never HTML). */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.style === "strong" ? (
          <strong key={index}>{part.text}</strong>
        ) : part.style === "code" ? (
          <code key={index}>{part.text}</code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * The privacy policy, served by this node at `/privacy` (lib/privacy-policy.ts): readable with no internet
 * and without leaving LOAM. Linked from Settings and from the Android host's menu.
 */
export function PrivacyView() {
  return (
    <section className="settings-view privacy-view">
      <ScreenHeader backHref="/settings" title={t("settings.privacyPolicy")} />
      <div className="screen-body">
        <div className="screen-column privacy-policy" lang="en">
          <p className="screen-footnote">Last updated {PRIVACY_POLICY_UPDATED}</p>
          {PRIVACY_POLICY.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              {section.blocks.map((block, index) =>
                block.kind === "p" ? (
                  <p key={index}>
                    <Inline text={block.text} />
                  </p>
                ) : (
                  <ul key={index}>
                    {block.items.map((item) => (
                      <li key={item}>
                        <Inline text={item} />
                      </li>
                    ))}
                  </ul>
                ),
              )}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
