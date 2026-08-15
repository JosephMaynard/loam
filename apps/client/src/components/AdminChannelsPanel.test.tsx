import type { Channel, User } from "@loam/schema";
import type { VNode } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminChannelsPanel } from "./AdminChannelsPanel";

// The panel fetches its channel list on mount through the transport passthrough, which (with no
// transport session) calls the global fetch. Stubbing fetch lets the real request/parse path run
// against a controlled response — the pattern used in ChannelMembersPanel.test.tsx.

const mounted: HTMLDivElement[] = [];
let channels: Channel[] = [];

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

const admin: User = {
  id: "user.admin",
  displayName: "Ada Admin",
  type: "human",
  isAdmin: true,
  createdAt: 1,
  ephemeral: true,
};

const general: Channel = {
  id: "channel.general",
  name: "general",
  visibility: "public",
  allowPosting: "everyone",
  allowReplies: true,
  discoverable: true,
  createdAt: 1,
} as Channel;

const archived: Channel = {
  id: "channel.old",
  name: "old",
  visibility: "public",
  allowPosting: "admins",
  allowReplies: true,
  discoverable: true,
  archived: true,
  createdAt: 1,
} as Channel;

beforeEach(() => {
  channels = [general, archived];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(channels), { status: 200 })),
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

describe("AdminChannelsPanel", () => {
  it("renders the fetched channels, marking archived ones", async () => {
    const host = mount(<AdminChannelsPanel currentUser={admin} onChannelUpsert={() => {}} />);
    await flush();

    const rows = Array.from(host.querySelectorAll(".admin-channel"));
    expect(rows).toHaveLength(2);
    expect(host.querySelector(".admin-channel.archived")).not.toBeNull();
    // Channel names live in each row's editable input value, not a text node.
    const names = Array.from(host.querySelectorAll(".admin-channel input")).map(
      (input) => (input as HTMLInputElement).value,
    );
    expect(names).toEqual(["general", "old"]);
  });

  it("deletes a channel only after the confirm, removing its row on success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ deletedChannelId: "channel.general" }), { status: 200 });
      }
      return new Response(JSON.stringify(channels), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);

    const host = mount(<AdminChannelsPanel currentUser={admin} onChannelUpsert={() => {}} />);
    await flush();

    const generalRow = Array.from(host.querySelectorAll(".admin-channel")).find((row) =>
      (row.querySelector("input") as HTMLInputElement).value === "general",
    ) as HTMLElement;
    const deleteButton = Array.from(generalRow.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    ) as HTMLButtonElement;
    expect(deleteButton).not.toBeUndefined();
    // The destructive control names its channel for assistive tech.
    expect(deleteButton.getAttribute("aria-label")).toContain("general");

    // Cancelled confirm: no DELETE leaves the client, the row stays.
    act(() => deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    expect(host.querySelectorAll(".admin-channel")).toHaveLength(2);

    // Accepted confirm: the DELETE goes to the right channel id and the row disappears.
    confirmMock.mockReturnValue(true);
    act(() => deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    const deleteCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
    expect(String(deleteCall?.[0])).toContain("/api/channels/channel.general");
    expect(host.querySelectorAll(".admin-channel")).toHaveLength(1);
  });

  it("surfaces a delete failure inline and re-enables the row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return new Response(JSON.stringify({ error: "This channel has messages from other people" }), { status: 403 });
        }
        return new Response(JSON.stringify(channels), { status: 200 });
      }),
    );
    vi.stubGlobal("confirm", vi.fn(() => true));

    const host = mount(<AdminChannelsPanel currentUser={admin} onChannelUpsert={() => {}} />);
    await flush();

    const generalRow = Array.from(host.querySelectorAll(".admin-channel")).find((row) =>
      (row.querySelector("input") as HTMLInputElement).value === "general",
    ) as HTMLElement;
    const deleteButton = Array.from(generalRow.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    ) as HTMLButtonElement;
    act(() => deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();

    expect(host.querySelectorAll(".admin-channel")).toHaveLength(2);
    expect(generalRow.querySelector(".form-error")?.textContent).toContain("other people");
    expect(deleteButton.disabled).toBe(false);
  });

  it("keeps the create button disabled until a name is entered", async () => {
    const host = mount(<AdminChannelsPanel currentUser={admin} onChannelUpsert={() => {}} />);
    await flush();

    const submit = host.querySelector("form button[type=submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const nameInput = host.querySelector("form input") as HTMLInputElement;
    act(() => {
      nameInput.value = "random";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
  });
});
