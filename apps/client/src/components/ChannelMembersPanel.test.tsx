import type { Channel, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelMembersPanel } from "./ChannelMembersPanel";

// The panel fetches its roster on mount through the transport passthrough, which (with no transport
// session) calls the global fetch. Stubbing fetch — the pattern used in transport.test.ts — lets the
// real request/parse path run against a controlled response without touching the network.

const mounted: HTMLDivElement[] = [];
let roster: User[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

/**
 * Let Preact run its mount effect (scheduled after paint, so it needs a real timer tick, not just a
 * microtask), resolve the stubbed fetch, and flush the batched re-render.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const owner: User = {
  id: "user.owner",
  displayName: "Olive Owner",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

const member: User = {
  id: "user.member",
  displayName: "Manny Member",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

const outsider: User = {
  id: "user.outsider",
  displayName: "Wanda Outsider",
  type: "human",
  isAdmin: false,
  createdAt: 1,
  ephemeral: true,
};

const channel: Channel = {
  id: "channel.secret",
  name: "secret",
  visibility: "private",
  ownerUserId: owner.id,
  memberUserIds: [owner.id, member.id],
  createdAt: 1,
} as Channel;

beforeEach(() => {
  roster = [owner, member];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(roster), { status: 200 })),
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

describe("ChannelMembersPanel", () => {
  it("renders the fetched roster, marking the owner", async () => {
    const host = mount(
      <ChannelMembersPanel
        channel={channel}
        currentUser={owner}
        onChannelUpsert={() => {}}
        onLeftChannel={() => {}}
        users={[owner, member, outsider]}
      />,
    );
    await flush();

    const rows = Array.from(host.querySelectorAll(".moderation-row"));
    expect(rows).toHaveLength(2);
    expect(host.textContent).toContain("Olive Owner");
    expect(host.textContent).toContain("Manny Member");
  });

  it("shows the invite form (with only non-members invitable) to the owner", async () => {
    const host = mount(
      <ChannelMembersPanel
        channel={channel}
        currentUser={owner}
        onChannelUpsert={() => {}}
        onLeftChannel={() => {}}
        users={[owner, member, outsider]}
      />,
    );
    await flush();

    const form = host.querySelector(".member-invite-form");
    expect(form).not.toBeNull();
    // The owner and existing member are excluded; only the outsider is invitable.
    const options = Array.from(form?.querySelectorAll("option") ?? []).map((option) => option.textContent);
    expect(options).toContain("Wanda Outsider");
    expect(options).not.toContain("Olive Owner");
    expect(options).not.toContain("Manny Member");
  });

  it("offers no management controls to a non-owner, non-admin member", async () => {
    const host = mount(
      <ChannelMembersPanel
        channel={channel}
        currentUser={member}
        onChannelUpsert={() => {}}
        onLeftChannel={() => {}}
        users={[owner, member, outsider]}
      />,
    );
    await flush();

    expect(host.querySelector(".member-invite-form")).toBeNull();
    expect(host.querySelector(".moderation-actions")).toBeNull();
    // A non-owner member can still leave.
    expect(host.querySelector(".danger-button")?.textContent).toContain("Leave");
  });
});
