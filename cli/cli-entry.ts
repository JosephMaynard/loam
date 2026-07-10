// esbuild entry for the `loamnet` package bundle (see scripts/build-cli.mjs). Re-exports exactly what
// bin/loam.js needs from the workspace, so the whole node — server + QR helper — is one self-contained
// ESM file. `startEmbeddedServer` is fully env-driven; `firstLanIPv4` derives the LAN join host; the
// QR helpers render the join URL to the terminal (the same @loam/qr used by the repo's dev launcher).
export { firstLanIPv4, startEmbeddedServer } from "../apps/server/src/embedded.js";
export { encodeQR, renderQRToTerminal } from "@loam/qr";
