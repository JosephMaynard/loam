import { beforeEach, describe, expect, it } from "vitest";

import { captureInviteCode } from "./invite";
import { captureLinkCodeFragment, linkCodePresentAtStartup, splitLinkCodeFragment } from "./link-code-fragment";
import { captureJoinKey, getCachedHostPublicKey, resetTransportStateForTests } from "./transport";

const KEY = "A".repeat(43);
const CODE = "abcdefghijklmnop";

/** The start-up capture main.tsx runs, against a given address. */
function startAt(url: string): void {
  window.history.replaceState(null, "", url);
  captureInviteCode();
  captureLinkCodeFragment();
  captureJoinKey();
}

beforeEach(() => {
  resetTransportStateForTests();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("splitLinkCodeFragment", () => {
  it("takes l=<code> out and keeps the other parameters in order", () => {
    expect(splitLinkCodeFragment(`#k=${KEY}&l=${CODE}`)).toEqual({ hash: `#k=${KEY}`, code: CODE });
    expect(splitLinkCodeFragment(`#l=${CODE}&k=${KEY}&i=invite`)).toEqual({ hash: `#k=${KEY}&i=invite`, code: CODE });
    expect(splitLinkCodeFragment(`#l=${CODE}`)).toEqual({ hash: "", code: CODE });
  });

  it("drops a malformed code without using it, and leaves a fragment without one alone", () => {
    expect(splitLinkCodeFragment(`#k=${KEY}&l=short`)).toEqual({ hash: `#k=${KEY}`, code: undefined });
    expect(splitLinkCodeFragment(`#k=${KEY}`)).toEqual({ hash: `#k=${KEY}`, code: undefined });
    expect(splitLinkCodeFragment("")).toEqual({ hash: "" });
  });
});

describe("captureLinkCodeFragment", () => {
  it("keeps the key of a link QR opened in a browser, strips the code, and remembers it was there", () => {
    startAt(`/#k=${KEY}&l=${CODE}`);

    expect(getCachedHostPublicKey()).toBe(KEY);
    expect(window.location.hash).toBe("");
    expect(linkCodePresentAtStartup()).toBe(true);
  });

  it("does the same for a link QR that also carries an invite code", () => {
    startAt(`/#k=${KEY}&i=invitecode&l=${CODE}`);

    expect(getCachedHostPublicKey()).toBe(KEY);
    expect(window.location.hash).toBe("");
    expect(linkCodePresentAtStartup()).toBe(true);
  });

  it("reports nothing for an ordinary join link", () => {
    startAt(`/#k=${KEY}`);

    expect(getCachedHostPublicKey()).toBe(KEY);
    expect(linkCodePresentAtStartup()).toBe(false);

    startAt("/channels");
    expect(window.location.pathname).toBe("/channels");
    expect(linkCodePresentAtStartup()).toBe(false);
  });
});
