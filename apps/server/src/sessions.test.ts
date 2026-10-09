import { afterEach, describe, expect, it } from "vitest";

import { makeSessionToken, makeSessionUserId } from "./identity.js";
import { makeApp, newSession, sessionCookie, teardownApps } from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("anonymous identity minting limit", () => {
  it("429s new identities from one IP past the cap but lets cookie'd requests through", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: 3 });

    const first = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(first.statusCode).toBe(200);
    const cookie = sessionCookie(first);

    // Two more fresh mints (count 2, 3) are allowed; the 4th cookieless request exceeds the cap.
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    const refused = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "rate_limited" });

    // A request that carries an existing session cookie mints nothing, so it's unaffected.
    const returning = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie } });
    expect(returning.statusCode).toBe(200);
  });
});

describe("session identity minting", () => {
  it("mints 64-bit user ids that never alias an existing one, and 256-bit session tokens", async () => {
    const app = await makeApp();
    const session = await newSession(app);
    expect(session.userId).toMatch(/^user\.[0-9a-f]{16}$/);
    expect(decodeURIComponent(session.cookie.slice("loam_session=".length))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(makeSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The minter retries until the id is free.
    const seen: string[] = [];
    const id = makeSessionUserId((candidate) => {
      seen.push(candidate);
      return seen.length < 4;
    });
    expect(seen).toHaveLength(4);
    expect(id).toBe(seen[3]);
  });
});

describe("ending a session", () => {
  it("ends the caller's session so the next request mints a fresh identity", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const end = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: user.cookie },
    });
    expect(end.statusCode).toBe(200);
    // The Set-Cookie clears the session cookie (Max-Age=0).
    expect(String(end.headers["set-cookie"])).toContain("Max-Age=0");

    // Reusing the now-invalidated cookie mints a brand-new identity rather than the wiped one.
    const after = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: user.cookie } });
    const newId = (after.json() as { currentUser: { id: string } }).currentUser.id;
    expect(newId).not.toBe(user.userId);
  });

  it("session/end is a safe no-op on an absent/unknown cookie and never mints a session", async () => {
    const app = await makeApp();
    const usersBefore = app.store.loadUsers().length;

    // No cookie at all.
    const none = await app.server.inject({ method: "POST", url: "/api/session/end" });
    expect(none.statusCode).toBe(200);
    // An unknown token.
    const unknown = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: "loam_session=deadbeef" },
    });
    expect(unknown.statusCode).toBe(200);

    // Crucially, ending a session must not itself create an identity.
    expect(app.store.loadUsers().length).toBe(usersBefore);
  });
});
