import { render } from "preact";
import "./global.css";
import { App } from "./app.tsx";

render(<App />, document.getElementById("app")!);
