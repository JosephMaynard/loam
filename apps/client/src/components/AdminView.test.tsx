import type { LoamConfig, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminView } from "./AdminView";

// AdminView fetches its config on mount through the transport passthrough, which (with no transport
// session) calls the global fetch. Stubbing fetch lets the real request/parse path run against a
// controlled response — the pattern used in ChannelMembersPanel.test.tsx. The AdminChannelsPanel it
// embeds also fetches on mount, so the stub answers both admin GETs.

const mounted: HTMLDivElement[] = [];

const config: LoamConfig = {
  node: { name: "Test Node", locale: "en" },
  identity: {
    allowUserDisplayNameEdit: true,
    allowUserAvatarEdit: true,
    allowUserAvatarUpload: true,
    allowAdminUserEdit: true,
  },
  features: {
    enablePublicChannels: true,
    enablePrivateChannels: true,
    enableUserChannels: true,
    enableReplies: true,
    enableDMs: true,
    enableReactions: true,
    enableMarkdown: true,
    enableAttachments: true,
    enableLocationSharing: true,
    enablePresence: true,
  },
  llm: {
    ollama: { enabled: false, baseUrl: "http://localhost:11434", model: "llama3", botId: "user.bot", botDisplayName: "Assistant" },
    onDevice: { enabled: false },
  },
  admin: { bootstrap: "firstUser" },
  killSwitch: { enabled: false, requireConfirmation: true },
  retention: {},
  security: { profile: "custom", transportEncryption: "off" },
  access: { joinPolicy: "open" },
  sync: { enabled: false, peers: [], intervalMs: 60_000 },
  mesh: { enabled: false, relay: false, ttlMs: 86_400_000, hopLimit: 8, maxCarried: 1000, maxContacts: 500 },
} as LoamConfig;

const admin: User = {
  id: "user.admin",
  displayName: "Ada Admin",
  type: "human",
  isAdmin: true,
  createdAt: 1,
  ephemeral: true,
};

const member: User = { ...admin, id: "user.member", displayName: "Manny Member", isAdmin: false };

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/channels")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify(config), { status: 200 });
    }),
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

describe("AdminView", () => {
  it("shows a not-authorized note (and no config form) to a non-admin", () => {
    const host = mount(
      <AdminView currentUser={member} onChannelUpsert={() => {}} onWiped={async () => {}} />,
    );

    expect(host.querySelector("form.settings-grid")).toBeNull();
    expect(host.querySelector(".form-note")).not.toBeNull();
  });

  it("loads and renders the config form for an admin", async () => {
    const host = mount(
      <AdminView currentUser={admin} joinUrl="http://192.168.0.10:3000" onChannelUpsert={() => {}} onWiped={async () => {}} />,
    );
    await flush();

    const form = host.querySelector("form.settings-grid");
    expect(form).not.toBeNull();
    // The network-name field is seeded from the fetched config.
    const nameInput = form?.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("Test Node");
    // The getting-started panel and the embedded channels panel are both present.
    expect(host.querySelector(".getting-started")).not.toBeNull();
    expect(host.querySelector(".admin-channel-list, .form-note")).not.toBeNull();
  });
});
