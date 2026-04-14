import { render } from "preact";
import "./global.css";
import { App } from "./app.tsx";

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
  });
}
