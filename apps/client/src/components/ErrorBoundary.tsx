import { Component, type ComponentChildren } from "preact";

import loamMark from "../assets/loam.svg";
import { t } from "../i18n";

interface ErrorBoundaryState {
  error?: unknown;
}

/**
 * Top-level render-error boundary. Without one, any exception thrown while rendering would unmount the
 * whole tree and leave a blank white page with no way back but a manual reload. This shows a recoverable
 * error screen instead: "Go to channels" resets the route to the channel list and remounts the app; "Reload" is the heavier fallback.
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
      <main className="gate-screen wiped-screen" role="alert">
        <div className="gate-card">
          <img alt="LOAM" className="gate-mark" src={loamMark} />
          <h1>{t("app.crashTitle")}</h1>
          <p>{t("app.crashBody")}</p>
          <div className="dialog-actions">
            <button className="btn btn-primary" onClick={this.goHome} type="button">
              {t("app.crashHome")}
            </button>
            <button className="btn btn-secondary" onClick={() => window.location.reload()} type="button">
              {t("app.crashReload")}
            </button>
          </div>
        </div>
      </main>
    );
  }
}
