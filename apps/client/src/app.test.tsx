import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";
import type { Channel, Message, User } from "@loam/schema";
import { IDBFactory } from "fake-indexeddb";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { captureAdminClaimCode, takeAdminClaimCode } from "./lib/admin-link";
import { CONFIRMED_USER_KEY } from "./lib/identity";
import { destroyDatabase, getAllRecords, putRecord, putRecords, resetLocalStoreForTests } from "./lib/local-store";
import { captureJoinKey, resetTransportStateForTests } from "./lib/transport";
import { isWipeTombstoned, setWipeTombstone } from "./lib/wipe";

// App-level boot tests (pre-release review 2026-09-25): mount the real `App` against a stubbed node (fetch +
// WebSocket) and a fresh fake IndexedDB, to check what the boot does with the cache it hydrates.

// Agreed to the member rules, so the app opens on its content rather than the Welcome screen.
const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true, rulesVersion: 1 };
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
  /** `POST /api/admin/claim`: the status to answer (200 = the caller becomes admin). */
  claimStatus?: number;
}

function stubNode(options: NodeOptions = {}) {
  let currentUser = options.currentUser ?? me;
  const bootstrap = {
    joinUrl: "http://node.test/",
    websocketPath: "/ws",
    networkConfig: { transportEncryption: "off", nodeName: "Test node", enableDMs: true, enableReplies: true },
  };
  const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/admin/claim") {
      const status = options.claimStatus ?? 200;
      if (status !== 200) {
        return json({ error: "Invalid admin secret" }, status);
      }
      // Like the real node: the claim sticks, so later reads return the admin record.
      currentUser = { ...currentUser, isAdmin: true, pending: false };
      return json(currentUser);
    }
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
      return json([currentUser.id === me.id ? currentUser : me, troll]);
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

describe("the host terminal's one-time admin link", () => {
  const CODE = "abcdefghijklmnopqrstuv";

  function claims(fetchMock: ReturnType<typeof stubNode>) {
    return fetchMock.mock.calls.filter(([url]) => url === "/api/admin/claim");
  }

  afterEach(() => {
    takeAdminClaimCode();
  });

  it("claims admin with the code once at boot and shows the admin area", async () => {
    window.history.replaceState(null, "", `/#a=${CODE}`);
    captureAdminClaimCode();
    const fetchMock = stubNode({ content: true });
    const root = await boot("/channels");

    expect(claims(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(claims(fetchMock)[0]![1]?.body))).toEqual({ secret: CODE });
    expect(root.textContent).toContain("Admin");
  });

  it("drops a refused code instead of presenting it again", async () => {
    window.history.replaceState(null, "", `/#a=${CODE}`);
    captureAdminClaimCode();
    const fetchMock = stubNode({ claimStatus: 403 });
    await boot("/channels");
    expect(claims(fetchMock)).toHaveLength(1);
    expect(takeAdminClaimCode()).toBeUndefined();
  });

  it("presents the code even in a browser that is already admin, so the server spends it", async () => {
    window.history.replaceState(null, "", `/#a=${CODE}`);
    captureAdminClaimCode();
    const fetchMock = stubNode({ currentUser: { ...me, isAdmin: true } });
    const root = await boot("/channels");
    expect(claims(fetchMock)).toHaveLength(1);
    expect(root.textContent).toContain("Admin");
  });
});

describe("the Welcome screen (member rules)", () => {
  it("greets someone who hasn't agreed yet instead of opening the network", async () => {
    stubNode({ currentUser: { ...me, rulesVersion: undefined } });
    const root = await boot("/channels");
    expect(root.querySelector(".welcome-screen")).not.toBeNull();
    expect(root.querySelector(".welcome-agree")?.textContent).toContain("18");
  });

  it("opens straight onto the network for someone who has agreed", async () => {
    stubNode();
    const root = await boot("/channels");
    expect(root.querySelector(".welcome-screen")).toBeNull();
  });
});

describe("a wiped device rejoining by its join QR", () => {
  const RESUME_AAD = "POST /api/session/resume";

  /**
   * A node pinned to `host`: answers the QR-pinned handshake (or refuses it) and the sealed identity resume
   * the way the real server does, so a boot with a `#k=` can run to the point where the wipe tombstone is
   * lifted. Content requests (tunnelled) never answer: these tests are about the gate, not the roster.
   */
  function stubPinnedNode(host: ReturnType<typeof createTransportIdentity>, options: { handshake?: "ok" | "fail" } = {}) {
    let sessionKey: string | undefined;
    const bootstrap = {
      joinUrl: "http://node.test/",
      websocketPath: "/ws",
      networkConfig: {
        transportEncryption: "required",
        transportPublicKey: host.publicKey,
        nodeName: "Test node",
        enableDMs: true,
        enableReplies: true,
      },
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return json(bootstrap);
      }
      if (url === "/api/transport/handshake") {
        if (options.handshake === "fail") {
          return json({ error: "internal_error" }, 500);
        }
        const { clientEphemeralPublic } = JSON.parse(String(init?.body)) as { clientEphemeralPublic: string };
        const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
        sessionKey = accepted.sessionKey;
        return json({ sessionId: "sess-1", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey });
      }
      if (url === "/api/session/resume" && sessionKey) {
        const { enc } = JSON.parse(String(init?.body)) as { enc: string };
        const envelope = JSON.parse(openTransport(sessionKey, enc, RESUME_AAD) ?? "{}") as { s?: number };
        const reply = { s: envelope.s, m: "POST", p: "/api/session/resume", currentUser: me, token: "token-1" };
        return new Response(JSON.stringify({ enc: sealTransport(sessionKey, JSON.stringify(reply), RESUME_AAD) }), {
          status: 200,
          headers: { "content-type": "application/json", "x-loam-enc": "1" },
        });
      }
      return pending();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function handshakes(fetchMock: ReturnType<typeof stubPinnedNode>) {
    return fetchMock.mock.calls.filter(([url]) => url === "/api/transport/handshake");
  }

  afterEach(() => {
    delete (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey;
  });

  it("with no key at load, boot stays on the wiped screen and never talks to the node", async () => {
    setWipeTombstone();
    const fetchMock = stubPinnedNode(createTransportIdentity());
    const root = await boot("/channels");

    expect(root.textContent).toContain("Device wiped");
    expect(handshakes(fetchMock)).toHaveLength(0);
    expect(isWipeTombstoned()).toBe(true);
  });

  it("a #k= scanned at load lets boot handshake, and the tombstone is lifted once the handshake succeeds", async () => {
    const host = createTransportIdentity();
    setWipeTombstone();
    // As main.tsx does: the fragment is read (and stripped) before the app renders.
    window.history.replaceState(null, "", `/#k=${host.publicKey}`);
    captureJoinKey();
    const fetchMock = stubPinnedNode(host);
    const root = await boot("/channels");

    expect(root.textContent).not.toContain("Device wiped");
    expect(handshakes(fetchMock)).toHaveLength(1);
    await vi.waitFor(() => expect(isWipeTombstoned()).toBe(false));
  });

  it("keeps the tombstone when the handshake fails (a stale QR never lifts the gate by itself)", async () => {
    const host = createTransportIdentity();
    setWipeTombstone();
    window.history.replaceState(null, "", `/#k=${host.publicKey}`);
    captureJoinKey();
    const fetchMock = stubPinnedNode(host, { handshake: "fail" });
    const root = await boot("/channels");

    expect(root.textContent).not.toContain("Device wiped");
    expect(handshakes(fetchMock).length).toBeGreaterThan(0);
    expect(isWipeTombstoned()).toBe(true);
  });

  it("the Android host's injected key counts as a rejoin for its own WebView", async () => {
    const host = createTransportIdentity();
    setWipeTombstone();
    (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey = host.publicKey;
    captureJoinKey();
    const fetchMock = stubPinnedNode(host);
    const root = await boot("/channels");

    expect(root.textContent).not.toContain("Device wiped");
    expect(handshakes(fetchMock)).toHaveLength(1);
    await vi.waitFor(() => expect(isWipeTombstoned()).toBe(false));
  });
});
