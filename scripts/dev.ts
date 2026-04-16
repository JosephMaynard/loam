import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

import { encodeQR, renderQRToTerminal } from "@loam/qr";

const clientPort = Number.parseInt(process.env.CLIENT_PORT ?? "3000", 10);
const serverPort = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const joinHost = process.env.LOAM_JOIN_HOST ?? localIPv4();
const joinUrl = `http://${joinHost}:${clientPort}`;
const children: ReturnType<typeof spawn>[] = [];

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

console.log("");
console.log("LOAM local dev");
console.log(`Open on this laptop: http://localhost:${clientPort}`);
console.log(`Open on your phone:  ${joinUrl}`);
console.log("");
console.log(renderQRToTerminal(encodeQR(joinUrl), { quietZone: 2 }));
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
