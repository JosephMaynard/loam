import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

import { encodeQR, renderQRToTerminal } from "@loam/qr";

const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? "3000", 10);
const serverPort = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const joinHost = process.env.LOAM_JOIN_HOST ?? localIPv4();
const joinUrl = `http://${joinHost}:${clientPort}`;
const children: ReturnType<typeof spawn>[] = [];
/** How long to wait for the server to come up and report its transport key before printing a keyless QR. */
const KEY_WAIT_MS = 15_000;

function localIPv4(): string {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "localhost";
}

function start(name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn("pnpm", args, {
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.push(child);

  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(prefixLines(name, chunk.toString()));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(prefixLines(name, chunk.toString()));
  });
  child.on("error", (error) => {
    process.stderr.write(prefixLines(name, `Failed to start child process: ${String(error)}\n`));
    stopAll();
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") {
      return;
    }

    stopAll();
    process.exit(code ?? 1);
  });
}

function prefixLines(prefix: string, text: string): string {
  return text
    .split("\n")
    .map((line, index, lines) => {
      if (!line && index === lines.length - 1) {
        return "";
      }

      return `${prefix} ${line}`;
    })
    .join("\n");
}

function stopAll(): void {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

/**
 * The transport public key the server advertises, read from the public, cookie-free `/api/bootstrap` once
 * the server answers (polled until `deadlineMs` passes). Undefined when it never answered in time, or
 * answered without a key (Developer Mode turns transport encryption off).
 */
async function fetchTransportKey(deadlineMs: number): Promise<string | undefined> {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${probeHost}:${serverPort}/api/bootstrap`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = (await response.json()) as { networkConfig?: { transportPublicKey?: unknown } };
        const key = body.networkConfig?.transportPublicKey;
        return typeof key === "string" && key ? key : undefined;
      }
    } catch {
      // Not listening yet (tsx is still compiling), or a slow answer: try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

/**
 * Print the join QR once the server is up, so it carries the node's key as `#k=<key>` (docs/08) and a
 * scanned join is encrypted and MITM-resistant, as `loam` and the Android host print it. The URL alone is
 * printed first, so there is something to type while the server boots.
 */
async function printJoinQr(): Promise<void> {
  const key = await fetchTransportKey(KEY_WAIT_MS);
  const link = key ? `${joinUrl}#k=${key}` : joinUrl;
  // Black on white on a colour terminal (bare blocks invert on a dark theme, which scanners refuse).
  const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  let out = `\nScan to join: ${link}\n`;
  try {
    out += `${renderQRToTerminal(encodeQR(link), { quietZone: 2, colour })}\n`;
  } catch {
    out += "(The join link is too long for a QR code; share the link above instead.)\n";
  }
  if (!key) {
    out += "(The server reported no transport key, so this QR joins without one. Scan the key from the server's own output instead, if it prints one.)\n";
  }
  // One write, so the children's prefixed lines can't land inside the code.
  process.stdout.write(`${out}\n`);
}

console.log("");
console.log("LOAM local dev");
console.log(`Open on this laptop: http://localhost:${clientPort}`);
console.log(`Open on your phone:  ${joinUrl}`);
console.log("(The join QR prints once the server is up, with its encryption key.)");
console.log("");

start("[server]", ["--filter", "@loam/server", "dev"], {
  ...process.env,
  HOST: host,
  PORT: String(serverPort),
  CLIENT_PORT: String(clientPort),
  LOAM_JOIN_HOST: joinHost,
});
start("[client]", ["--filter", "client", "exec", "vite", "--host", host, "--port", String(clientPort)], {
  ...process.env,
  HOST: host,
  CLIENT_PORT: String(clientPort),
  LOAM_API_PORT: String(serverPort),
});

void printJoinQr();
