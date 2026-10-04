import { render } from "preact";
import "./global.css";
import { App } from "./app.tsx";
import { captureInviteCode } from "./lib/invite.ts";
import { captureJoinKey } from "./lib/transport.ts";
import { recoverPendingWipe } from "./lib/local-store.ts";
import { installTheme } from "./lib/theme.ts";
import { installViewportSync } from "./lib/viewport.ts";

// If a previous device/node wipe couldn't finish deleting the local database (another tab held it), the
// persistent flag kept the store latched across this reload — retry the deletion now (docs/20). The store
// stays un-hydratable meanwhile, so no wiped data is loaded even if this retry is still deferred.
void recoverPendingWipe();

// Read the join link before anything rewrites the URL: an invite code, then the `#k=` key (the router's
// first redirect drops the fragment). A key from the URL only ever establishes or offers a pin; the Android
// host's own key override comes solely from its native injection (`__loamHostTransportKey`), never a URL.
captureInviteCode();
captureJoinKey();

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
