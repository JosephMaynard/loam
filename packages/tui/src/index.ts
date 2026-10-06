/**
 * @loam/tui: the `loamnet` terminal UI. The CLI starts the server, then hands it here through the
 * in-process host API (`LoamApp.host`, @loam/schema `HostApi`). No dependencies beyond the workspace: a
 * small renderer over the terminal's alternate screen, raw keys and ANSI styles.
 */
export { createTui, MIN_COLUMNS, MIN_ROWS, SCREENS, type Tui } from "./app.js";
export { clean, plain, renderLine, textWidth, type Line } from "./ansi.js";
export { parseKeys, type Key } from "./keys.js";
export { createKioskGuard, hashKioskPassword, verifyKioskPassword } from "./kiosk.js";
export { createLogBook, type LogBook, type LogEntry } from "./log.js";
export { qrBlock } from "./qr.js";
export { cliSettingsPath, parseCliSettings, readCliSettings, writeCliSettings, type CliSettings } from "./settings.js";
export { openCommand, processSystem, type System } from "./system.js";
export { createPainter, processTerminal, type Terminal } from "./terminal.js";
export type { LaunchInfo, TuiOptions } from "./types.js";
