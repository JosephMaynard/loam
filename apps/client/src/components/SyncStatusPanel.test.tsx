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
});
