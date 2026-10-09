import type { User } from "@loam/schema";
import { render } from "preact";
import { LocationProvider } from "preact-iso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetRememberedSearch, SearchView } from "./SearchView";

// The search term stays out of the address: a deep link's term is replaced before its request goes out,
// a submitted search never touches the address, and the screen remembers the term in memory instead.

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const someoneElse: User = { ...me, id: "user.else" };

const mounted: HTMLDivElement[] = [];
/** Each search request the stubbed fetch saw, with what the address bar showed at that moment. */
let requests: { path: string; address: string }[] = [];

function mount(user = me): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(
    <LocationProvider>
      <SearchView blockedUserIds={new Set()} channels={[]} currentUser={user} usersById={new Map()} />
    </LocationProvider>,
    container,
  );
  mounted.push(container);
  return container;
}

function unmountAll(): void {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
}

/** Let effects run, the stubbed fetch resolve, and Preact re-render. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function address(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** Type `term` and submit the form, letting Preact render the typed value in between as it would for a person. */
async function submit(host: ParentNode, term: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("input[type=search]")!;
  input.value = term;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

beforeEach(() => {
  requests = [];
  forgetRememberedSearch();
  window.history.replaceState(null, "", "/search");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push({ path: url.slice(url.indexOf("/api/")), address: address() });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  unmountAll();
  window.history.replaceState(null, "", "/");
});

describe("SearchView", () => {
  it("runs a deep-linked search once, with the term off the address before the request", async () => {
    window.history.replaceState(null, "", "/search?q=secret%20plans");
    const host = mount();
    await flush();

    expect(requests).toEqual([{ path: "/api/search?q=secret%20plans", address: "/search" }]);
    expect(address()).toBe("/search");
    expect(host.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("secret plans");
    expect(host.querySelector(".empty-note")?.textContent).toBe("No messages matched.");
  });

  it("never puts a submitted search in the address", async () => {
    const host = mount();
    await flush();
    expect(requests).toEqual([]);

    await submit(host, "meeting point");

    expect(requests).toEqual([{ path: "/api/search?q=meeting%20point", address: "/search" }]);
    expect(address()).toBe("/search");
  });

  it("shows the same search again when the same person comes back to the screen, and no one else's", async () => {
    await submit(mount(), "meeting point");
    unmountAll();

    const again = mount();
    await flush();
    expect(again.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("meeting point");
    expect(requests.map((request) => request.path)).toEqual(["/api/search?q=meeting%20point", "/api/search?q=meeting%20point"]);
    unmountAll();

    const other = mount(someoneElse);
    await flush();
    expect(other.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("");
    expect(requests).toHaveLength(2);
  });
});
