import { render } from "preact";
import "./global.css";
import { App } from "./app.tsx";
import { captureInviteCode } from "./lib/invite.ts";
import { recoverPendingWipe } from "./lib/local-store.ts";
import { installTheme } from "./lib/theme.ts";
import { installViewportSync } from "./lib/viewport.ts";

// If a previous device/node wipe couldn't finish deleting the local database (another tab held it), the
// persistent flag kept the store latched across this reload — retry the deletion now (docs/20). The store
// stays un-hydratable meanwhile, so no wiped data is loaded even if this retry is still deferred.
void recoverPendingWipe();

// Take a host-screen invite code out of the join link before the transport reads the `#k=` fragment.
captureInviteCode();

// Pin the saved colour theme (System / Light / Dark, set in Settings) before anything renders.
installTheme();

// Size the fixed app shell to the visible viewport (keyboard-aware) before the first paint.
installViewportSync();

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}service-worker.js`)
      .catch(() => undefined);
  });
}
