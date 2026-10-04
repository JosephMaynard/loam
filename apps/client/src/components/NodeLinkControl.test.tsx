import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  hostKey: { key: "HOSTKEY" as string | undefined, suppressed: false },
  fetch: vi.fn(),
}));

vi.mock("../lib/transport", () => ({
  encryptedFetch: transport.fetch,
  inviteQrHostKey: () => transport.hostKey,
  joinQrUrl: (joinUrl: string, key?: string) => (key ? `${joinUrl}#k=${key}` : joinUrl),
}));

const qr = vi.hoisted(() => ({ encoded: [] as string[] }));
vi.mock("../lib/qr", () => ({
  safeQrSvg: (url: string) => {
    qr.encoded.push(url);
    return "<svg></svg>";
  },
}));

const { NodeLinkControl } = await import("./NodeLinkControl");

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  transport.hostKey = { key: "HOSTKEY", suppressed: false };
  transport.fetch.mockReset();
  transport.fetch.mockResolvedValue(
    new Response(JSON.stringify({ code: "ABCDEFGHIJKLMNOP", expiresAt: 1_700_000_600_000 }), { status: 200 }),
  );
  qr.encoded.length = 0;
});

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("NodeLinkControl", () => {
  it("renders nothing without a join URL", () => {
    expect(mount(<NodeLinkControl />).querySelector("button")).toBeNull();
  });

  it("asks the node for a code and shows it only as a QR: join URL, verified key, code", async () => {
    const host = mount(<NodeLinkControl joinUrl="http://192.168.0.10:3000" />);
    await act(async () => {
      host.querySelector("button")?.click();
      await flush();
    });

    expect(transport.fetch).toHaveBeenCalledWith("POST", "/api/admin/sync/link-code");
    expect(qr.encoded.at(-1)).toBe("http://192.168.0.10:3000#k=HOSTKEY&l=ABCDEFGHIJKLMNOP");
    expect(host.querySelector(".invite-qr svg")).not.toBeNull();
    expect(host.textContent).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("won't show a code from a device that can't vouch for the network's key", () => {
    transport.hostKey = { key: undefined, suppressed: false };
    const host = mount(<NodeLinkControl joinUrl="http://192.168.0.10:3000" />);
    expect((host.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("didn't join by scanning");
  });
});
