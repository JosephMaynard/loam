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
    ollama: { enabled: false, baseUrl: "http://localhost:11434", model: "llama3", botId: "llm.bot", botDisplayName: "Assistant" },
    onDevice: { enabled: false },
  },
  admin: { bootstrap: "firstUser" },
  killSwitch: { enabled: false, requireConfirmation: true },
  retention: {},
  security: { profile: "custom", transportEncryption: "optional", dbEncryption: "off" },
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

    expect(host.querySelector(".admin-section")).toBeNull();
    expect(host.querySelector(".empty-note")).not.toBeNull();
  });

  it("loads and renders the config sections for an admin", async () => {
    const host = mount(
      <AdminView currentUser={admin} joinUrl="http://192.168.0.10:3000" onChannelUpsert={() => {}} onWiped={async () => {}} />,
    );
    await flush();

    // The network-name field is seeded from the fetched config.
    const nameInput = host.querySelector("#admin-network form input") as HTMLInputElement;
    expect(nameInput.value).toBe("Test Node");
    // One nav pill per section, each pointing at a section that exists.
    const pills = Array.from(host.querySelectorAll<HTMLAnchorElement>(".admin-nav a"));
    expect(pills.length).toBe(9);
    for (const pill of pills) {
      expect(host.querySelector(pill.getAttribute("href")!)).not.toBeNull();
    }
    // The getting-started panel, the embedded channels panel and the save bar are all present.
    expect(host.querySelector(".getting-started")).not.toBeNull();
    expect(host.querySelector("#admin-channels .admin-channel-list, #admin-channels .empty-note")).not.toBeNull();
    expect(host.querySelector(".save-bar button")?.textContent).toBe("Save node config");
    // Feature flags are switches (real checkboxes styled by CSS).
    expect(host.querySelectorAll("#admin-features input.toggle").length).toBeGreaterThan(0);
  });

  it("labels the admin bootstrap strategies in plain words, not config identifiers", async () => {
    const host = mount(<AdminView currentUser={admin} onChannelUpsert={() => {}} onWiped={async () => {}} />);
    await flush();

    const options = Array.from(host.querySelectorAll<HTMLOptionElement>("#admin-access select option"));
    const labels = Object.fromEntries(options.map((option) => [option.value, option.textContent]));
    expect(labels).toEqual({
      firstUser: "First person to join",
      setupCode: "One-time setup code",
      passphrase: "Passphrase",
      hostDevice: "This device (the host)",
      none: "Nobody",
    });
  });

  it("confirms the Emergency Reset in an alertdialog that needs the typed word", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/admin/channels")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/api/admin/kill-switch")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      void init;
      return new Response(JSON.stringify({ ...config, killSwitch: { enabled: true, requireConfirmation: true } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onWiped = vi.fn(async () => {});
    const host = mount(<AdminView currentUser={admin} onChannelUpsert={() => {}} onWiped={onWiped} />);
    await flush();

    const wipeButton = Array.from(host.querySelectorAll<HTMLButtonElement>("#admin-danger button")).find(
      (button) => button.textContent === "Wipe this node now",
    )!;
    wipeButton.click();
    await flush();

    const dialog = host.querySelector('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Wipe this node now",
    )!;
    // Locked until the word is typed; nothing has been sent.
    expect(confirm.disabled).toBe(true);
    const field = dialog.querySelector("input") as HTMLInputElement;
    field.value = "wipe";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(confirm.disabled).toBe(false);

    confirm.click();
    await flush();
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/admin/kill-switch"));
    expect(call).not.toBeUndefined();
    expect(String((call?.[1] as RequestInit | undefined)?.body)).toContain('"confirm":"wipe"');
    expect(onWiped).toHaveBeenCalledTimes(1);
  });
});
