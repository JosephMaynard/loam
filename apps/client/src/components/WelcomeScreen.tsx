import type { User } from "@loam/schema";
import { useState } from "preact/hooks";

import { t } from "../i18n";
import { ApiError } from "../lib/api";
import { Avatar } from "./Avatar";

type WelcomeScreenProps = {
  /** The network's name, from its config. */
  nodeName: string;
  currentUser: User;
  /** Agree to the member rules (`POST /api/users/me/rules`). Rejects when the node can't be reached. */
  onAgree: () => Promise<void>;
  /** A new random name and avatar (`POST /api/users/me/reroll`). Rejects on failure. */
  onReroll: () => Promise<void>;
};

/**
 * The first thing someone sees on a network: who they are here (a random name and avatar they can swap),
 * the rules in one friendly sentence, and one button. Agreeing is what lets them post (Google Play's UGC
 * policy, enforced by the server too); everything fits on one phone screen so a person in a hurry is in
 * with a single tap. The full rules are a link away at `/rules`.
 */
export function WelcomeScreen({ nodeName, currentUser, onAgree, onReroll }: WelcomeScreenProps) {
  const [busy, setBusy] = useState<"agree" | "reroll">();
  const [error, setError] = useState<string>();
  // The node said this person keeps their name (they posted before the rules existed).
  const [rerollRefused, setRerollRefused] = useState(false);
  // "Try another" is only offered before the first agreement (the server enforces it): after that, a new
  // name would let someone walk away from what they posted.
  const canReroll = currentUser.rulesVersion === undefined && !rerollRefused;

  async function run(action: "agree" | "reroll"): Promise<void> {
    setBusy(action);
    setError(undefined);
    try {
      await (action === "agree" ? onAgree() : onReroll());
    } catch (failure) {
      if (action === "reroll" && failure instanceof ApiError && failure.code === "reroll_not_allowed") {
        setRerollRefused(true);
        return;
      }
      setError(t(action === "agree" ? "welcome.error" : "welcome.rerollError"));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main className="gate-screen welcome-screen">
      <div className="gate-card welcome-card">
        <h1>{t("welcome.title", { network: nodeName })}</h1>
        <div className="welcome-identity">
          <Avatar avatar={currentUser.avatar} id={currentUser.id} size="xl" />
          <span className="welcome-name-label">{t("welcome.nameLabel")}</span>
          <strong className="welcome-name" dir="auto">
            {currentUser.displayName}
          </strong>
          {canReroll ? (
            <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void run("reroll")} type="button">
              {t("welcome.tryAnother")}
            </button>
          ) : null}
        </div>
        {canReroll ? <p className="welcome-note">{t("welcome.anonymous")}</p> : null}
        <p className="welcome-rules">
          {t("welcome.rules")} <a href="/rules">{t("welcome.readRules")}</a>
        </p>
        <button className="btn btn-primary btn-block welcome-agree" disabled={!!busy} onClick={() => void run("agree")} type="button">
          {busy === "agree" ? t("welcome.agreeing") : t("welcome.agree")}
        </button>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
