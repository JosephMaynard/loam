import { useEffect } from "preact/hooks";

import { t } from "../i18n";

/** How long a transient (action) error stays up before dismissing itself. */
export const ERROR_BANNER_AUTO_DISMISS_MS = 8_000;

export interface ErrorBannerProps {
  message: string;
  /**
   * A one-off action failure (a send, edit, delete, a history load) that dismisses itself; a
   * connectivity error (the node is unreachable) stays until the next successful boot pass or the user
   * dismisses it.
   */
  transient: boolean;
  onDismiss: () => void;
}

/**
 * The app-level error notice (pre-release review 2026-09-25). It used to be a fixed box over the
 * bottom-right corner — exactly where the composer's send button sits — that nothing could dismiss.
 * Now it sits at the top of the viewport (clear of the composer on every layout, inside the safe area),
 * has a dismiss button, and transient errors clear themselves. `role="alert"` so it's announced.
 * Callers key it per error occurrence so a repeat of the same message restarts the timer.
 */
export function ErrorBanner({ message, transient, onDismiss }: ErrorBannerProps) {
  useEffect(() => {
    if (!transient) {
      return;
    }
    const timer = window.setTimeout(onDismiss, ERROR_BANNER_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, transient]);

  return (
    <div className="connection-error" role="alert">
      <p>{message}</p>
      <button aria-label={t("common.dismiss")} className="close-button" onClick={onDismiss} type="button">
        ×
      </button>
    </div>
  );
}
