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

    const rows = Array.from(host.querySelectorAll(".member-row"));
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
    expect(host.querySelector(".member-actions")).toBeNull();
    // A non-owner member can still leave.
    expect(host.querySelector(".members-leave")?.textContent).toContain("Leave");
  });

  it("asks before handing over ownership: cancel sends nothing, confirm POSTs the transfer", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
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
    const callsBefore = fetchMock.mock.calls.length;

    host.querySelector<HTMLButtonElement>(".member-transfer")!.click();
    await tick();
    const dialog = host.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Transfer ownership to this person?");
    alertButton(host, "Cancel").click();
    await tick();
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    host.querySelector<HTMLButtonElement>(".member-transfer")!.click();
    await tick();
    alertButton(host, "Make owner").click();
    await flush();
    const transfer = fetchMock.mock.calls.slice(callsBefore).find(([input]) => String(input).includes("/transfer"));
    expect(transfer).toBeDefined();
    expect(String(transfer![0])).toContain("/api/channels/channel.secret/transfer");
    expect((transfer![1] as RequestInit).method).toBe("POST");
  });

  it("asks before leaving: cancel keeps you in, confirm sends the DELETE and reports the channel left", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const onLeftChannel = vi.fn();
    const host = mount(
      <ChannelMembersPanel
        channel={channel}
        currentUser={member}
        onChannelUpsert={() => {}}
        onLeftChannel={onLeftChannel}
        users={[owner, member, outsider]}
      />,
    );
    await flush();
    const callsBefore = fetchMock.mock.calls.length;

    host.querySelector<HTMLButtonElement>(".members-leave")!.click();
    await tick();
    expect(host.querySelector('[role="alertdialog"]')!.textContent).toContain("Leave this channel?");
    alertButton(host, "Cancel").click();
    await tick();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(onLeftChannel).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>(".members-leave")!.click();
    await tick();
    alertButton(host, "Leave channel").click();
    await flush();
    const removal = fetchMock.mock.calls.slice(callsBefore).find(([input]) => String(input).includes("/members/"));
    expect(String(removal![0])).toContain("/api/channels/channel.secret/members/user.member");
    expect((removal![1] as RequestInit).method).toBe("DELETE");
    expect(onLeftChannel).toHaveBeenCalledWith("channel.secret");
  });
});

/** Let Preact flush one batched state update. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The button with this label inside the open alertdialog. */
function alertButton(host: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(host.querySelector('[role="alertdialog"]')!.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  )!;
}
