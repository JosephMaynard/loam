/**
 * What the UI asks of the computer it runs on: open a link in the browser, list the network addresses
 * people could join on. Behind an interface so tests don't open browsers.
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

export type LanAddress = { name: string; address: string };

export type System = {
  /** Open `url` in the default browser. Resolves false when there's no desktop to open it on. */
  openUrl(url: string): Promise<boolean>;
  /** IPv4 addresses on this computer's network interfaces, loopback and link-local excluded. */
  lanAddresses(): LanAddress[];
};

/** The command that opens a URL on this platform, or undefined when there is none to use. */
export function openCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: (url: string) => string[] } | undefined {
  if (platform === "darwin") {
    return { command: "open", args: (url) => [url] };
  }
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty string is its window title. We build the URL ourselves (an address,
    // a port and base64url codes), so its only cmd metacharacter is the fragment's `&`, escaped here.
    return { command: "cmd", args: (url) => ["/c", "start", '""', url.replace(/&/g, "^&")] };
  }
  // Linux and the BSDs: only with a desktop session to show it on (not over plain SSH).
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return undefined;
  }
  return { command: "xdg-open", args: (url) => [url] };
}

export function processSystem(): System {
  return {
    openUrl(url) {
      const opener = openCommand(process.platform, process.env);
      if (!opener) {
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        try {
          const child = spawn(opener.command, opener.args(url), { stdio: "ignore", detached: true });
          child.once("error", () => resolve(false));
          child.once("spawn", () => {
            child.unref();
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
    },
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
