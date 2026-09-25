import type { Channel, Message, User } from "@loam/schema";
import { IDBFactory } from "fake-indexeddb";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { CONFIRMED_USER_KEY } from "./lib/identity";
import { destroyDatabase, getAllRecords, putRecord, putRecords, resetLocalStoreForTests } from "./lib/local-store";
import { resetTransportStateForTests } from "./lib/transport";

// App-level boot tests (pre-release review 2026-09-25): mount the real `App` against a stubbed node (fetch +
// WebSocket) and a fresh fake IndexedDB, to check what the boot does with the cache it hydrates.

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const troll: User = { id: "user.troll", displayName: "Troll", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const general = { id: "general", name: "general", visibility: "public", createdAt: 1 } as Channel;

function post(id: string, authorId: string, body: string): Message {
  return { id, type: "channelPost", channelId: "general", authorId, body, createdAt: 100 } as Message;
}

/** Never settles: keeps a request "in flight" for the whole test. */
function pending(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface NodeOptions {
  /** The identity the node confirms for this browser. */
  currentUser?: User;
  /** `/api/users/me/blocks`: a list, or `"fail"` (500), or `"hang"` (never answers). */
  blocks?: string[] | "fail" | "hang";
  /** Everything else content-shaped (channels, users, messages) never answers unless set here. */
  content?: boolean;
  searchResults?: Message[];
}

function stubNode(options: NodeOptions = {}) {
  const currentUser = options.currentUser ?? me;
  const bootstrap = {
    joinUrl: "http://node.test/",
    websocketPath: "/ws",
    networkConfig: { transportEncryption: "off", nodeName: "Test node", enableDMs: true, enableReplies: true },
  };
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url === "/api/bootstrap") {
      return json(bootstrap);
    }
    if (url === "/api/config") {
      return json({ ...bootstrap, currentUser });
    }
    if (url === "/api/users/me/blocks") {
      if (options.blocks === "fail") {
        return json({ error: "boom" }, 500);
      }
      if (options.blocks === undefined || options.blocks === "hang") {
        return pending();
      }
      return json({ blockedUserIds: options.blocks });
    }
    if (url.startsWith("/api/search")) {
      return json({ results: options.searchResults ?? [] });
    }
    if (!options.content) {
      return pending();
    }
    if (url === "/api/channels") {
      return json([general]);
    }
    if (url === "/api/users") {
      return json([me, troll]);
    }
    return pending();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A WebSocket that never connects (the tests are about the REST boot and the cache). */
class IdleWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let container: HTMLDivElement | undefined;

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function boot(path: string): Promise<HTMLDivElement> {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  render(<App />, container);
  await settle();
  return container;
}

async function seedCache(records: { messages?: Message[]; channels?: Channel[]; blockList?: { userId: string; ids: string[] } }) {
  await putRecords("channels", records.channels ?? [general]);
  await putRecords("messages", records.messages ?? []);
  if (records.blockList) {
    await putRecord("sync", { id: "blockList", userId: records.blockList.userId, blockedUserIds: records.blockList.ids });
  }
  // A fresh page load: drop the seeding connection so the app opens its own.
  resetLocalStoreForTests();
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetLocalStoreForTests();
  resetTransportStateForTests();
  localStorage.clear();
  vi.stubGlobal("WebSocket", IdleWebSocket);
});

afterEach(async () => {
  if (container) {
    render(null, container);
    container.remove();
    container = undefined;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await destroyDatabase().catch(() => undefined);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("identity-change purge at boot", () => {
  it("the first confirmation does NOT purge the cache", async () => {
    await seedCache({ messages: [post("m1", troll.id, "cached hello")] });
    stubNode();

    await boot("/settings");
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe(me.id);
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["m1"]);
  });

  it("the same confirmed identity again does not purge either", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "cached hello")] });
    stubNode();

    await boot("/settings");
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["m1"]);
  });

  it("a DIFFERENT confirmed identity purges the cached content (memory and IndexedDB)", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, "user.previous");
    await seedCache({
      messages: [post("m1", troll.id, "the previous identity's cached post")],
      blockList: { userId: "user.previous", ids: [troll.id] },
    });
    stubNode();

    const host = await boot("/channel/general");
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe(me.id);
    expect(await getAllRecords("messages")).toEqual([]);
    // The cached block list went with it.
    expect((await getAllRecords<{ id: string }>("sync")).map((record) => record.id)).not.toContain("blockList");
    expect(host.textContent).not.toContain("the previous identity's cached post");
  });
});

describe("the cached block list (review 2026-09-25 #4)", () => {
  it("hides a blocked author's cached posts from the first render while the block fetch fails", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({
      messages: [post("m1", troll.id, "nasty cached words")],
      blockList: { userId: me.id, ids: [troll.id] },
    });
    stubNode({ blocks: "fail" });

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("Message from a blocked user");
    expect(host.textContent).not.toContain("nasty cached words");
  });

  it("ignores a cached list that belongs to another identity", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({
      messages: [post("m1", troll.id, "ordinary cached words")],
      blockList: { userId: "user.someone-else", ids: [troll.id] },
    });
    stubNode({ blocks: "hang" });

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("ordinary cached words");
  });

  it("caches the fetched list for the confirmed identity", async () => {
    stubNode({ blocks: [troll.id], content: true });

    await boot("/settings");
    expect(await getAllRecords("sync")).toContainEqual({ id: "blockList", userId: me.id, blockedUserIds: [troll.id] });
  });
});

describe("another tab confirming a different identity (review 2026-09-25 #7)", () => {
  it("drops this tab's in-memory content", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "still on screen")] });
    stubNode();
    // jsdom has no navigation; the reload that follows the purge is just reported and ignored.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("still on screen");

    window.dispatchEvent(new StorageEvent("storage", { key: CONFIRMED_USER_KEY, newValue: "user.new" }));
    await settle();
    expect(host.textContent).not.toContain("still on screen");
  });

  it("ignores a sibling confirming the SAME identity", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "still on screen")] });
    stubNode();

    const host = await boot("/channel/general");
    window.dispatchEvent(new StorageEvent("storage", { key: CONFIRMED_USER_KEY, newValue: me.id }));
    await settle();
    expect(host.textContent).toContain("still on screen");
  });
});

describe("search results from a blocked author (review 2026-09-25 #3)", () => {
  it("collapse to the blocked placeholder", async () => {
    stubNode({ blocks: [troll.id], content: true, searchResults: [post("m1", troll.id, "findable nasty words")] });

    const host = await boot("/search");
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "nasty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(5);
    host.querySelector<HTMLFormElement>(".search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(host.querySelector(".search-results")?.textContent).toContain("Message from a blocked user");
    expect(host.textContent).not.toContain("findable nasty words");
  });
});
