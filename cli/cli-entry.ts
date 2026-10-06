// esbuild entry for the `loamnet` package bundle (see scripts/build-cli.mjs). Re-exports exactly what
// bin/loam.js needs from the workspace, so the whole node — server, QR helper and terminal UI — is one
// self-contained ESM file. `startEmbeddedServer` is env-driven (plus a log stream and host token);
// `firstLanIPv4` derives the LAN join host; the QR helpers print the join URL in plain mode; @loam/tui is the
// full-screen terminal UI and its saved settings (cli.json).
export { firstLanIPv4, startEmbeddedServer } from "../apps/server/src/embedded.js";
export { encodeQR, renderQRToTerminal } from "@loam/qr";
export {
  createLogBook,
  createTui,
  processSystem,
  processTerminal,
  readCliSettings,
  writeCliSettings,
} from "@loam/tui";
