import { render } from "preact";
import "./global.css";
import { App } from "./app.tsx";

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}service-worker.js`)
      .catch(() => undefined);
  });
}
