import type { Channel, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// The sidebar renders NavLinks, so mounts are wrapped in a LocationProvider.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(<LocationProvider>{element}</LocationProvider>, container);
  mounted.push(container);
  return container;
}

/** Let Preact flush its batched state update (it re-renders on a microtask, not synchronously). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

const currentUser: User = {
  id: "user.me",
  displayName: "Me",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

const peer: User = {
  id: "user.peer",
  displayName: "Ada",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

const generalChannel: Channel = {
  id: "channel.general",
  name: "general",
  visibility: "public",
  createdAt: 1,
} as Channel;

const privateChannel: Channel = {
  id: "channel.secret",
  name: "secret",
  visibility: "private",
  createdAt: 1,
} as Channel;

/** Baseline props that most tests reuse; individual tests override what they exercise. */
function baseProps() {
  return {
    canCreateChannel: false,
    canCreatePrivateChannel: false,
    channels: [generalChannel, privateChannel],
    connection: "live" as const,
    currentUser,
    onCreateChannel: async () => true,
    onlineUserIds: new Set<string>(),
    showMesh: false,
    unreadByConversation: new Map<string, number>(),
    users: [currentUser, peer],
  };
}

describe("Sidebar", () => {
  it("lists channels (with a lock glyph for private ones) and DM peers, excluding the current user", () => {
    const host = mount(<Sidebar {...baseProps()} />);

    const channelLinks = Array.from(host.querySelectorAll('a[href^="/channel/"]'));
    expect(channelLinks.map((link) => link.querySelector(".nav-label")?.textContent)).toEqual(["general", "secret"]);
    // The private channel shows the lock glyph.
    expect(host.textContent).toContain("🔒");

    const dmLinks = Array.from(host.querySelectorAll('a[href^="/dm/"]'));
    expect(dmLinks).toHaveLength(1);
    expect(dmLinks[0]?.textContent).toContain("Ada");
  });

  it("shows the admin link only for admins", () => {
    const withoutAdmin = mount(<Sidebar {...baseProps()} />);
    expect(withoutAdmin.querySelector('a[href="/admin"]')).toBeNull();

    const withAdmin = mount(<Sidebar {...baseProps()} currentUser={{ ...currentUser, isAdmin: true }} />);
    expect(withAdmin.querySelector('a[href="/admin"]')).not.toBeNull();
  });

  it("shows the mesh link only when mesh mail is enabled", () => {
    expect(mount(<Sidebar {...baseProps()} />).querySelector('a[href="/mesh"]')).toBeNull();
    expect(mount(<Sidebar {...baseProps()} showMesh />).querySelector('a[href="/mesh"]')).not.toBeNull();
  });

  it("reflects the connection status in the status pill", () => {
    const host = mount(<Sidebar {...baseProps()} connection="offline" />);
    expect(host.querySelector(".status-pill")?.className).toContain("status-offline");
  });

  it("reveals the new-channel form only when channel creation is allowed", async () => {
    const withoutCreate = mount(<Sidebar {...baseProps()} />);
    expect(withoutCreate.querySelector(".new-channel-toggle")).toBeNull();

    const withCreate = mount(<Sidebar {...baseProps()} canCreateChannel />);
    const toggle = withCreate.querySelector(".new-channel-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();

    expect(withCreate.querySelector(".new-channel-form")).toBeNull();
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(withCreate.querySelector(".new-channel-form")).not.toBeNull();
  });
});
