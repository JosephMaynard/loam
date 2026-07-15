import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({ networkInterfaces: vi.fn() }));

import { networkInterfaces } from "node:os";

import { resolveLanIPv4 } from "./net.js";

type Iface = { address: string; family: "IPv4" | "IPv6"; internal: boolean };

function mockInterfaces(map: Record<string, Iface[]>): void {
  vi.mocked(networkInterfaces).mockReturnValue(map as unknown as ReturnType<typeof networkInterfaces>);
}

function ipv4(address: string, internal = false): Iface {
  return { address, family: "IPv4", internal };
}

describe("resolveLanIPv4 (F3)", () => {
  afterEach(() => {
    vi.mocked(networkInterfaces).mockReset();
  });

  it("falls back to localhost when no non-internal IPv4 interface exists", () => {
    mockInterfaces({ lo: [ipv4("127.0.0.1", true)] });
    expect(resolveLanIPv4()).toBe("localhost");
  });

  it("excludes VPN/tunnel interfaces (tun/utun/tailscale/wg/ppp) even when nothing else is available", () => {
    mockInterfaces({
      utun3: [ipv4("100.64.0.5")],
      tailscale0: [ipv4("100.101.102.103")],
      wg0: [ipv4("10.6.0.2")],
      "ppp0": [ipv4("10.64.64.64")],
      tun0: [ipv4("10.8.0.5")],
    });
    expect(resolveLanIPv4()).toBe("localhost");
  });

  it("prefers the hotspot gateway range (192.168.49.*) over any other private address", () => {
    mockInterfaces({
      eth0: [ipv4("10.0.0.5")],
      wlan1: [ipv4("192.168.1.20")],
      "ap0": [ipv4("192.168.49.1")],
    });
    expect(resolveLanIPv4()).toBe("192.168.49.1");
  });

  it("prefers 192.168.*/10./172.16-31.* over a public or otherwise-unclassified address, in that order", () => {
    mockInterfaces({ eth0: [ipv4("203.0.113.9")], wlan0: [ipv4("192.168.1.20")] });
    expect(resolveLanIPv4()).toBe("192.168.1.20");

    mockInterfaces({ eth0: [ipv4("203.0.113.9")], wlan0: [ipv4("172.20.5.5")] });
    expect(resolveLanIPv4()).toBe("172.20.5.5");

    mockInterfaces({ eth0: [ipv4("203.0.113.9")] });
    expect(resolveLanIPv4()).toBe("203.0.113.9");
  });

  it("ignores a VPN interface even when it's the only thing offering a private-LAN-shaped address", () => {
    mockInterfaces({
      tailscale0: [ipv4("192.168.49.7")], // shaped like a hotspot gateway, but on a tunnel iface
      eth0: [ipv4("203.0.113.9")],
    });
    expect(resolveLanIPv4()).toBe("203.0.113.9");
  });
});
