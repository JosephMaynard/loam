import type { SyncStatusReport } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncStatusPanel } from "./SyncStatusPanel";

// The panel fetches its status on mount through the transport passthrough, which (with no transport
// session) calls the global fetch. Stubbing fetch lets the real request/parse path run against a
// controlled response — the pattern used in ChannelMembersPanel.test.tsx.

const mounted: HTMLDivElement[] = [];
let report: SyncStatusReport = { enabled: true, intervalMs: 60_000, peers: [] };

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

/** Let Preact run its mount effect (a real timer tick), resolve the stubbed fetch, and re-render. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  report = { enabled: true, intervalMs: 60_000, peers: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(report), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("SyncStatusPanel", () => {
  it("renders nothing when there are no peers", async () => {
    const host = mount(<SyncStatusPanel />);
    await flush();

    expect(host.querySelector(".sync-status")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("lists each peer's status once the report loads", async () => {
    report = {
      enabled: true,
      intervalMs: 60_000,
      peers: [
        {
          url: "http://192.168.0.10:3000",
          label: "Kitchen Pi",
          status: { lastSuccessAt: 1_700_000_000_000, imported: 3 },
        },
        {
          url: "http://192.168.0.11:3000",
          status: { lastError: "connection refused", imported: 0 },
        },
      ],
    } as SyncStatusReport;

    const host = mount(<SyncStatusPanel />);
    await flush();

    const rows = Array.from(host.querySelectorAll(".sync-peer"));
    expect(rows).toHaveLength(2);
    expect(host.textContent).toContain("Kitchen Pi");
    expect(host.textContent).toContain("http://192.168.0.11:3000");
    expect(host.textContent).toContain("connection refused");
  });

  it("shows networks asking to sync even with no peers, and accepting hands the new peer to the form", async () => {
    const request = { id: "0123456789abcdef", url: "http://192.168.4.20:3000", name: "Riverside", transportKey: "k", requestedAt: 1_700_000_000_000 };
    report = { enabled: false, intervalMs: 60_000, peers: [], linkRequests: [request] };
    const accepted = { enabled: true, intervalMs: 60_000, peers: [{ url: request.url, label: "Riverside", transportKey: "k" }], linkRequests: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/accept")
        ? new Response(JSON.stringify(accepted), { status: 200 })
        : new Response(JSON.stringify(report), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onAccepted = vi.fn();

    const host = mount(<SyncStatusPanel hasToken onAccepted={onAccepted} />);
    await flush();

    expect(host.textContent).toContain("Riverside");
    expect(host.textContent).toContain("shared mesh token");
    const accept = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Accept")!;
    accept.click();
    await flush();

    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(`/api/admin/sync/link-requests/${request.id}/accept`);
    expect(onAccepted).toHaveBeenCalledWith({ url: request.url, label: "Riverside", transportKey: "k" });
    expect(host.querySelector(".sync-link-request")).toBeNull();
    expect(host.querySelectorAll(".sync-peer")).toHaveLength(1);
  });
});
