import { render } from "preact";
import "./global.css";
import { App } from "./app.tsx";
import { recoverPendingWipe } from "./lib/local-store.ts";

// If a previous device/node wipe couldn't finish deleting the local database (another tab held it), the
// persistent flag kept the store latched across this reload — retry the deletion now (docs/20). The store
// stays un-hydratable meanwhile, so no wiped data is loaded even if this retry is still deferred.
void recoverPendingWipe();

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}service-worker.js`)
      .catch(() => undefined);
  });
}
