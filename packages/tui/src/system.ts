/**
 * What the UI asks of the computer it runs on: open a link in the browser, list the network addresses
 * people could join on. Behind an interface so tests don't open browsers.
 */
import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { networkInterfaces } from "node:os";

export type LanAddress = { name: string; address: string };

export type System = {
  /** Open `url` in the default browser. Resolves false when there's no desktop to open it on, or it failed. */
  openUrl(url: string): Promise<boolean>;
  /** IPv4 addresses on this computer's network interfaces, loopback and link-local excluded. */
  lanAddresses(): LanAddress[];
};

export type OpenCommand = {
  command: string;
  args: (url: string) => string[];
  /**
   * Pass the arguments to the program as they are, unquoted (Windows only). `cmd` reads its own command
   * line, and the `""` it needs would otherwise be re-quoted into `"\"\""` and read as the window title.
   */
  verbatim?: boolean;
};

/** The command that opens a URL on this platform, or undefined when there is none to use. */
export function openCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): OpenCommand | undefined {
  if (platform === "darwin") {
    return { command: "open", args: (url) => [url] };
  }
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty string is its window title. We build the URL ourselves (an address,
    // a port and base64url codes), so its only cmd metacharacter is the fragment's `&`, escaped here.
    return { command: "cmd", args: (url) => ["/c", "start", '""', url.replace(/&/g, "^&")], verbatim: true };
  }
  // Linux and the BSDs: only with a desktop session to show it on (not over plain SSH).
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return undefined;
  }
  return { command: "xdg-open", args: (url) => [url] };
}

/** The part of a child process {@link openUrlWith} uses, so a test can stand one in. */
export type OpenerProcess = Pick<ChildProcess, "once" | "unref">;
export type SpawnOpener = (command: string, args: string[], options: SpawnOptions) => OpenerProcess;

export type OpenUrlOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnOpener;
  /** How long to wait for the opener to exit before taking it to have the browser up itself. */
  timeoutMs?: number;
};

/** Openers hand the URL to the browser and exit at once; one still running after this long is the browser. */
const OPENER_TIMEOUT_MS = 3_000;

/**
 * Open `url` with the platform's opener. True once the opener exits successfully (or is still running after
 * `timeoutMs`: `xdg-open` can run the browser itself when none was open), false when there is no opener,
 * it can't be started, or it exits with an error (no browser to hand the URL to).
 */
export function openUrlWith(url: string, options: OpenUrlOptions = {}): Promise<boolean> {
  const opener = openCommand(options.platform ?? process.platform, options.env ?? process.env);
  if (!opener) {
    return Promise.resolve(false);
  }
  const start = options.spawn ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (opened: boolean) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(opened);
      }
    };
    try {
      const child = start(opener.command, opener.args(url), {
        stdio: "ignore",
        detached: true,
        windowsVerbatimArguments: opener.verbatim === true,
      });
      child.once("error", () => settle(false));
      child.once("exit", (code) => settle(code === 0));
      child.once("spawn", () => child.unref());
      timer = setTimeout(() => settle(true), options.timeoutMs ?? OPENER_TIMEOUT_MS);
      timer.unref();
    } catch {
      settle(false);
    }
  });
}

export function processSystem(): System {
  return {
    openUrl: (url) => openUrlWith(url),
    lanAddresses() {
      const found: LanAddress[] = [];
      for (const [name, entries] of Object.entries(networkInterfaces())) {
        for (const entry of entries ?? []) {
          if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
            found.push({ name, address: entry.address });
          }
        }
      }
      return found;
    },
  };
}
