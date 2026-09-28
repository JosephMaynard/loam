import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptPendingHostKey,
  clearImageObjectUrls,
  getImageCacheGeneration,
  subscribeImageCacheCleared,
  encryptedFetch,
  encryptedImageUrl,
  ensureSession,
  fingerprint,
  getCachedHostPublicKey,
  getHostKeyMismatch,
  getPendingHostKeyChange,
  getSession,
  inviteQrHostKey,
  isHostKeyPinBroken,
  rejectPendingHostKey,
  releaseImageUrl,
  resetTransportStateForTests,
  retainImageUrl,
  TransportNeedsQrError,
  UnsealedTunnelResponseError,
} from "./transport";
import { useEncryptedImage } from "./use-encrypted-image";

// Pre-release review 2026-09-25: the pinned (tunnel) client's handling of unsealed replies, `#k=` links
// that differ from an existing pin, the invite-QR key source, and the tunnelled-image URL cache.

const PIN_KEY = (): string => `loam.transportHostKey.${window.location.origin}`;
const PIN_BROKEN_KEY = (): string => `loam.transportPinBroken.${window.location.origin}`;

type Host = ReturnType<typeof createTransportIdentity>;
type Inner = { m: string; p: string; body?: unknown };

/** The body `/api/transport/handshake` would send for `host` (runs the real server-side accept). */
function handshakeReply(host: Host, init: RequestInit): { response: Response; sessionKey: string } {
  const { clientEphemeralPublic } = JSON.parse(init.body as string) as { clientEphemeralPublic: string };
  const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
  return {
    sessionKey: accepted.sessionKey,
    response: new Response(
      JSON.stringify({ sessionId: "sess", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }),
      { status: 200 },
    ),
  };
}

/** A fetch stub that only answers handshakes, as `host`. */
function handshakeOnly(host: Host) {
  return vi.fn(async (_url: string, init: RequestInit) => handshakeReply(host, init).response);
}

/**
 * A fake node for a QR-pinned (tunnel) client: answers handshakes as `host`, a sealed identity resume
 * (for the silent re-bind after a re-handshake), and hands every tunnel request to `reply` — which returns
 * either a raw, UNSEALED Response (what an on-path attacker can forge) or a `{ status, json }` the fake node
 * seals exactly as the real one does.
 */
function tunnelNode(host: Host, reply: (inner: Inner, call: number) => Response | { status: number; json: unknown }) {
  let sessionKey: string | undefined;
  let calls = 0;
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/transport/handshake") {
      const handshake = handshakeReply(host, init);
      sessionKey = handshake.sessionKey;
      return handshake.response;
    }
    if (url === "/api/session/resume") {
      const opened = openTransport(sessionKey!, (JSON.parse(init.body as string) as { enc: string }).enc, "POST /api/session/resume");
      const { s } = JSON.parse(opened!) as { s: number };
      const sealed = sealTransport(
        sessionKey!,
        JSON.stringify({ s, m: "POST", p: "/api/session/resume", currentUser: {} }),
        "POST /api/session/resume",
      );
      return new Response(JSON.stringify({ enc: sealed }), { status: 200, headers: { "x-loam-enc": "1" } });
    }
    calls += 1;
    const opened = openTransport(sessionKey!, (JSON.parse(init.body as string) as { enc: string }).enc, "POST /api/transport/tunnel");
    const envelope = JSON.parse(opened!) as { s: number; b: Inner };
    const result = reply(envelope.b, calls);
    if (result instanceof Response) {
      return result;
    }
    const descriptor = JSON.stringify({
      s: envelope.s,
      m: envelope.b.m,
      p: envelope.b.p,
      status: result.status,
      contentType: "application/json",
      bodyB64: btoa(JSON.stringify(result.json)),
    });
    return new Response(JSON.stringify({ enc: sealTransport(sessionKey!, descriptor, "POST /api/transport/tunnel") }), {
      status: 200,
      headers: { "x-loam-enc": "1" },
    });
  });
}

beforeEach(() => {
  resetTransportStateForTests();
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = "";
});

describe("a pinned (tunnel) client never accepts an unsealed reply (finding #2)", () => {
  it("refuses a forged plaintext 200 for GET /api/mesh/identity instead of returning it", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    const forgedCard = { meshId: "mesh.attacker", signPublicKey: "attacker", kxPublicKey: "attacker" };
    vi.stubGlobal(
      "fetch",
      tunnelNode(host, () => new Response(JSON.stringify(forgedCard), { status: 200, headers: { "content-type": "application/json" } })),
    );

    await ensureSession("required", host.publicKey);
    const failure = await encryptedFetch("GET", "/api/mesh/identity").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnsealedTunnelResponseError);
    expect((failure as UnsealedTunnelResponseError).status).toBe(200);
  });

  it("maps an unsealed 503 (node restarting) to an error, not a Response", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    vi.stubGlobal("fetch", tunnelNode(host, () => new Response(JSON.stringify({ error: "restarting" }), { status: 503 })));

    await ensureSession("required", host.publicKey);
    await expect(encryptedFetch("POST", "/api/messages", { body: "hi" })).rejects.toThrow(/restarting/);
  });

  it("an unsealed 401 on a mutation is an error and is never retried (no replay)", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    const node = tunnelNode(host, () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", node);

    await ensureSession("required", host.publicKey);
    await expect(encryptedFetch("POST", "/api/messages", { body: "hi" })).rejects.toBeInstanceOf(UnsealedTunnelResponseError);
    expect(node.mock.calls.filter(([url]) => url === "/api/transport/tunnel")).toHaveLength(1);
  });

  it("keeps the one-shot re-handshake retry for a SAFE request on an unsealed 401, then returns the sealed reply", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    const node = tunnelNode(host, (_inner, call) => (call === 1 ? new Response(null, { status: 401 }) : { status: 200, json: { ok: true } }));
    vi.stubGlobal("fetch", node);

    await ensureSession("required", host.publicKey);
    const response = await encryptedFetch("GET", "/api/channels");
    expect(await response.json()).toEqual({ ok: true });
    expect(node.mock.calls.filter(([url]) => url === "/api/transport/handshake")).toHaveLength(2);
  });
});

describe("a #k= link never silently replaces an existing pin (finding #3)", () => {
  it("a first #k= for this origin pins it (the normal QR join)", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(host));

    await ensureSession("optional", host.publicKey);
    expect(getCachedHostPublicKey()).toBe(host.publicKey);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(window.location.hash).toBe("");
  });

  it("a different #k= (e.g. a link posted in a channel) keeps the pin + broken marker and asks instead", async () => {
    const real = createTransportIdentity();
    const posted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), real.publicKey);
    localStorage.setItem(PIN_BROKEN_KEY(), "1"); // a link must NOT be able to clear this either
    window.location.hash = `#k=${posted.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(real));

    await expect(ensureSession("optional", real.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
    expect(getCachedHostPublicKey()).toBe(real.publicKey);
    expect(isHostKeyPinBroken()).toBe(true);
    expect(window.location.hash).toBe(""); // the fragment is still stripped from the address bar
    // The node still reports `real`, so the posted key is not the node's: shown, but not acceptable.
    expect(getPendingHostKeyChange()).toEqual({
      current: fingerprint(real.publicKey),
      next: fingerprint(posted.publicKey),
      matchesNode: false,
    });
    expect(acceptPendingHostKey()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(real.publicKey);

    rejectPendingHostKey();
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(getCachedHostPublicKey()).toBe(real.publicKey);
  });

  it("with a healthy pin, a posted #k= is dropped silently: no prompt, nothing to accept, live session untouched", async () => {
    const real = createTransportIdentity();
    const posted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), real.publicKey);
    vi.stubGlobal("fetch", handshakeOnly(real));
    await ensureSession("optional", real.publicKey);
    const original = getSession();

    window.location.hash = `#k=${posted.publicKey}`;
    await ensureSession("optional", real.publicKey); // a resync pass on this load
    expect(getSession()).toBe(original);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(acceptPendingHostKey()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(real.publicKey);
    expect(isHostKeyPinBroken()).toBe(false);
    expect(getSession()).toBe(original);

    // Later on the same load the node restarts with a new key: the pin breaks, but the link dropped earlier
    // must not resurface as an offer.
    const rotated = createTransportIdentity();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) =>
        url === "/api/transport/handshake" ? handshakeReply(rotated, init).response : new Response(null, { status: 401 }),
      ),
    );
    await expect(encryptedFetch("GET", "/api/channels")).rejects.toThrow(); // 401 → re-handshake → mismatch
    expect(isHostKeyPinBroken()).toBe(true);
    expect(getPendingHostKeyChange()).toBeUndefined();
  });

  it("with a healthy pin on a fresh load, a posted #k= is dropped after the pin handshakes", async () => {
    const real = createTransportIdentity();
    const posted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), real.publicKey);
    window.location.hash = `#k=${posted.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(real));

    await ensureSession("optional", real.publicKey);
    expect(getSession()?.hostPublicKey).toBe(real.publicKey);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(acceptPendingHostKey()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(real.publicKey);
  });

  it("a posted #k= while the node is merely unreachable (pin not broken) is never offered", async () => {
    const real = createTransportIdentity();
    const posted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), real.publicKey);
    window.location.hash = `#k=${posted.publicKey}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("handshake dropped");
      }),
    );

    await expect(ensureSession("optional", real.publicKey)).rejects.toThrow("handshake dropped");
    expect(isHostKeyPinBroken()).toBe(false);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(acceptPendingHostKey()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(real.publicKey);
  });

  it("a broken pin + the node's real new key in the link → Accept is offered and works", async () => {
    const old = createTransportIdentity();
    const rotated = createTransportIdentity(); // the node restarted with a fresh key
    localStorage.setItem(PIN_KEY(), old.publicKey);
    window.location.hash = `#k=${rotated.publicKey}`; // the user rescanned the host's current QR
    vi.stubGlobal("fetch", handshakeOnly(rotated));

    // The pin's handshake mismatches → broken, and the node's reported key is recorded.
    const failure = await ensureSession("optional", rotated.publicKey).catch((error: unknown) => error);
    expect((failure as TransportNeedsQrError).reason).toBe("changed");
    expect(getPendingHostKeyChange()).toEqual({
      current: fingerprint(old.publicKey),
      next: fingerprint(rotated.publicKey),
      matchesNode: true,
    });

    expect(acceptPendingHostKey()).toBe(true);
    expect(getCachedHostPublicKey()).toBe(rotated.publicKey);
    expect(isHostKeyPinBroken()).toBe(false);
    await ensureSession("optional", rotated.publicKey);
    expect(getSession()?.hostPublicKey).toBe(rotated.publicKey);
  });

  it("a key change noticed mid-session gates, and the rescanned QR is then acceptable", async () => {
    const old = createTransportIdentity();
    const rotated = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    vi.stubGlobal("fetch", handshakeOnly(old));
    await ensureSession("optional", old.publicKey);
    expect(getSession()?.hostPublicKey).toBe(old.publicKey);

    // The node restarts with a new key: the next request's re-handshake contradicts the pin.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) =>
        url === "/api/transport/handshake" ? handshakeReply(rotated, init).response : new Response(null, { status: 401 }),
      ),
    );
    await expect(encryptedFetch("GET", "/api/channels")).rejects.toThrow();
    expect(isHostKeyPinBroken()).toBe(true);

    // The user rescans the host's current QR.
    window.location.hash = `#k=${rotated.publicKey}`;
    await expect(ensureSession("optional", rotated.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
    expect(getSession()).toBeUndefined(); // the gate dropped the session derived under the old key
    expect(getPendingHostKeyChange()?.matchesNode).toBe(true);
    expect(acceptPendingHostKey()).toBe(true);
    expect(getCachedHostPublicKey()).toBe(rotated.publicKey);
    vi.stubGlobal("fetch", handshakeOnly(rotated));
    await ensureSession("optional", rotated.publicKey);
    expect(getSession()?.hostPublicKey).toBe(rotated.publicKey);
  });

  it("a broken pin + a link whose key the node does NOT hold → shown as a mismatch, Accept refused", async () => {
    const old = createTransportIdentity();
    const rotated = createTransportIdentity();
    const evil = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    window.location.hash = `#k=${evil.publicKey}`; // a planted link / QR sticker
    vi.stubGlobal("fetch", handshakeOnly(rotated));

    await expect(ensureSession("optional", rotated.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
    expect(getPendingHostKeyChange()?.matchesNode).toBe(false);
    expect(acceptPendingHostKey()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(old.publicKey);
    expect(isHostKeyPinBroken()).toBe(true);
  });

  it("a pin broken on an EARLIER load: the node's key is probed so a matching link can be accepted", async () => {
    const old = createTransportIdentity();
    const rotated = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    localStorage.setItem(PIN_BROKEN_KEY(), "1");
    window.location.hash = `#k=${rotated.publicKey}`;
    const node = handshakeOnly(rotated);
    vi.stubGlobal("fetch", node);

    await expect(ensureSession("optional", rotated.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
    expect(getSession()).toBeUndefined(); // the probe never becomes a session
    expect(getPendingHostKeyChange()?.matchesNode).toBe(true);
    expect(acceptPendingHostKey()).toBe(true);
    expect(getCachedHostPublicKey()).toBe(rotated.publicKey);
  });

  it("a broken pin whose probe fails leaves the link unacceptable", async () => {
    const old = createTransportIdentity();
    const rotated = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    localStorage.setItem(PIN_BROKEN_KEY(), "1");
    window.location.hash = `#k=${rotated.publicKey}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("unreachable");
      }),
    );

    await expect(ensureSession("optional", rotated.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
    expect(getPendingHostKeyChange()?.matchesNode).toBe(false);
    expect(acceptPendingHostKey()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(old.publicKey);
  });

  it("rescanning the SAME key is a quiet confirmation (no prompt)", async () => {
    const real = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), real.publicKey);
    window.location.hash = `#k=${real.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(real));

    await ensureSession("optional", real.publicKey);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(getSession()?.hostPublicKey).toBe(real.publicKey);
  });
});

describe("the Android host's own WebView trusts the launcher's key (ephemeral-key node, new key every boot)", () => {
  type HostWindow = Window & { __loamHostTransportKey?: unknown };

  afterEach(() => {
    delete (window as HostWindow).__loamHostTransportKey;
  });

  it("pinned OLD + launcher key NEW + #k=NEW → NEW adopted silently: no gate, no prompt", async () => {
    const old = createTransportIdentity();
    const rebooted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    (window as HostWindow).__loamHostTransportKey = rebooted.publicKey;
    window.location.hash = `#k=${rebooted.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(rebooted));

    await ensureSession("optional", rebooted.publicKey);
    expect(getSession()?.hostPublicKey).toBe(rebooted.publicKey);
    expect(getCachedHostPublicKey()).toBe(rebooted.publicKey);
    expect(isHostKeyPinBroken()).toBe(false);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(inviteQrHostKey()).toEqual({ key: rebooted.publicKey, suppressed: false });
  });

  it("the launcher key also repairs a pin a previous boot marked broken (a reload without #k=)", async () => {
    const old = createTransportIdentity();
    const rebooted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    localStorage.setItem(PIN_BROKEN_KEY(), "1");
    (window as HostWindow).__loamHostTransportKey = rebooted.publicKey;
    vi.stubGlobal("fetch", handshakeOnly(rebooted));

    await ensureSession("required", rebooted.publicKey);
    expect(getSession()?.hostPublicKey).toBe(rebooted.publicKey);
    expect(isHostKeyPinBroken()).toBe(false);
  });

  it("without the launcher key (a LAN browser) the same situation breaks the pin and asks", async () => {
    const old = createTransportIdentity();
    const rebooted = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), old.publicKey);
    window.location.hash = `#k=${rebooted.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(rebooted));

    const failure = await ensureSession("optional", rebooted.publicKey).catch((error: unknown) => error);
    expect((failure as TransportNeedsQrError).reason).toBe("changed");
    expect(getCachedHostPublicKey()).toBe(old.publicKey);
    expect(getPendingHostKeyChange()?.matchesNode).toBe(true);
  });

  it("a non-string global (DOM clobbering) or a malformed key is ignored", async () => {
    const old = createTransportIdentity();
    const rebooted = createTransportIdentity();
    for (const bogus of [document.createElement("a"), "not a key!", ""]) {
      resetTransportStateForTests();
      localStorage.clear();
      localStorage.setItem(PIN_KEY(), old.publicKey);
      (window as HostWindow).__loamHostTransportKey = bogus;
      vi.stubGlobal("fetch", handshakeOnly(rebooted));
      await expect(ensureSession("optional", rebooted.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
      expect(getCachedHostPublicKey()).toBe(old.publicKey);
    }
  });
});

describe("invite QR key comes only from a QR-verified session (finding #4)", () => {
  it("no session → no key (plain join URL)", () => {
    expect(inviteQrHostKey()).toEqual({ key: undefined, suppressed: false });
  });

  it("a session keyed only from the advertised (unauthenticated) key → no key", async () => {
    const host = createTransportIdentity();
    vi.stubGlobal("fetch", handshakeOnly(host));
    await ensureSession("optional", host.publicKey);
    expect(getSession()).toBeDefined();
    expect(inviteQrHostKey()).toEqual({ key: undefined, suppressed: false });
  });

  it("a QR-verified session → its own verified key", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(host));
    await ensureSession("optional", host.publicKey);
    expect(inviteQrHostKey()).toEqual({ key: host.publicKey, suppressed: false });
  });

  it("an advertised key that contradicts the pin → the QR is suppressed", async () => {
    const real = createTransportIdentity();
    const advertised = createTransportIdentity();
    window.location.hash = `#k=${real.publicKey}`;
    vi.stubGlobal("fetch", handshakeOnly(real));
    await ensureSession("optional", advertised.publicKey);
    expect(getHostKeyMismatch()).toBe(true);
    expect(inviteQrHostKey()).toEqual({ suppressed: true });
  });
});

describe("the tunnelled-image URL cache never revokes a URL still on screen (finding #15)", () => {
  it("evicts only entries no element holds", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    vi.stubGlobal("fetch", tunnelNode(host, (inner) => ({ status: 200, json: { path: inner.p } })));
    let counter = 0;
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${(counter += 1)}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await ensureSession("required", host.publicKey);

    retainImageUrl("/img/0"); // on screen
    const held = await encryptedImageUrl("/img/0");
    const unheld = await encryptedImageUrl("/img/1");
    for (let i = 2; i < 200; i += 1) {
      retainImageUrl(`/img/${i}`);
      await encryptedImageUrl(`/img/${i}`);
    }
    expect(create).toHaveBeenCalledTimes(200);

    await encryptedImageUrl("/img/200"); // full → evicts the oldest UNHELD entry
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(unheld);
    expect(revoke).not.toHaveBeenCalledWith(held);

    releaseImageUrl("/img/0"); // unmounted → evictable again, oldest first
    await encryptedImageUrl("/img/201");
    expect(revoke).toHaveBeenLastCalledWith(held);
  });
});

describe("clearing the image cache while images are mounted (review 2026-09-25 #6)", () => {
  async function tunnelWithBlobs(): Promise<{ revoke: ReturnType<typeof vi.spyOn> }> {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    vi.stubGlobal("fetch", tunnelNode(host, (inner) => ({ status: 200, json: { path: inner.p } })));
    let counter = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${(counter += 1)}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await ensureSession("required", host.publicKey);
    return { revoke };
  }

  it("keeps holder counts, so an image still mounted after the clear is never evicted", async () => {
    const { revoke } = await tunnelWithBlobs();
    retainImageUrl("/img/held"); // mounted before the clear, still mounted after it
    await encryptedImageUrl("/img/held");
    clearImageObjectUrls();
    const reResolved = await encryptedImageUrl("/img/held"); // the mounted element re-resolves
    for (let i = 0; i < 200; i += 1) {
      await encryptedImageUrl(`/img/${i}`);
    }
    expect(revoke).not.toHaveBeenCalledWith(reResolved);
  });

  it("bumps the generation and tells subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeImageCacheCleared(listener);
    const before = getImageCacheGeneration();
    clearImageObjectUrls();
    unsubscribe();
    expect(getImageCacheGeneration()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("an image fetch in flight across the clear is not cached (no old-identity image comes back)", async () => {
    await tunnelWithBlobs();
    const inFlight = encryptedImageUrl("/img/a");
    clearImageObjectUrls();
    expect(await inFlight).toBe("");
    expect(await encryptedImageUrl("/img/a")).toMatch(/^blob:test\//);
  });

  it("a mounted useEncryptedImage re-resolves its revoked blob: URL after the clear", async () => {
    await tunnelWithBlobs();
    const container = document.createElement("div");
    document.body.appendChild(container);
    function Img() {
      return h("img", { src: useEncryptedImage("/img/a") });
    }
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    try {
      render(h(Img, null), container);
      await settle();
      const first = container.querySelector("img")?.getAttribute("src");
      expect(first).toMatch(/^blob:test\//);

      clearImageObjectUrls(); // revokes `first`
      await settle();
      const second = container.querySelector("img")?.getAttribute("src");
      expect(second).toMatch(/^blob:test\//);
      expect(second).not.toBe(first);
    } finally {
      render(null, container);
      container.remove();
    }
  });
});
