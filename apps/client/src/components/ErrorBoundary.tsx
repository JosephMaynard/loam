import { Component, type ComponentChildren } from "preact";

import { t } from "../i18n";

interface ErrorBoundaryState {
  error?: unknown;
}

/**
 * Top-level render-error boundary (pre-release review 2026-09-25). Without one, any exception thrown
 * while rendering (a malformed route used to be enough) unmounted the whole tree and left a blank white
 * page with no way back but a manual reload. This shows a recoverable error screen instead: "Go to
 * channels" resets the route to the channel list and remounts the app; "Reload" is the heavier fallback.
 * It sits OUTSIDE the router so a remount re-reads the (reset) location.
 */
export class ErrorBoundary extends Component<{ children: ComponentChildren }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error ?? new Error("Unknown render error") };
  }

  componentDidCatch(error: unknown): void {
    console.error("LOAM hit a render error", error);
  }

  private goHome = (): void => {
    window.history.replaceState(window.history.state, "", "/channels");
    this.setState({ error: undefined });
  };

  render() {
    if (this.state.error === undefined) {
      return this.props.children;
    }

    return (
      <main className="wiped-screen" role="alert">
        <div>
          <p className="brand-title">LOAM</p>
          <h1>{t("app.crashTitle")}</h1>
          <p>{t("app.crashBody")}</p>
          <div className="profile-actions crash-actions">
            <button onClick={this.goHome} type="button">
              {t("app.crashHome")}
            </button>
            <button className="ghost-button" onClick={() => window.location.reload()} type="button">
              {t("app.crashReload")}
            </button>
          </div>
        </div>
      </main>
    );
  }
}
