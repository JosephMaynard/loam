import { afterEach, describe, expect, it } from "vitest";

import { captureAdminClaimCode, splitAdminFragment, takeAdminClaimCode } from "./admin-link";

const CODE = "abcdefghijklmnopqrstuv";

afterEach(() => {
  takeAdminClaimCode();
  window.history.replaceState(null, "", "/");
});

describe("splitAdminFragment", () => {
  it("takes a=<code> out and keeps the other parameters in order", () => {
    expect(splitAdminFragment(`#k=key&a=${CODE}&i=invite`)).toEqual({ hash: "#k=key&i=invite", code: CODE });
    expect(splitAdminFragment(`#a=${CODE}`)).toEqual({ hash: "", code: CODE });
  });

  it("drops a malformed code without using it", () => {
    expect(splitAdminFragment("#k=key&a=short")).toEqual({ hash: "#k=key", code: undefined });
    expect(splitAdminFragment("#k=key")).toEqual({ hash: "#k=key", code: undefined });
  });
});

describe("captureAdminClaimCode", () => {
  it("strips the code from the address bar and hands it out once", () => {
    window.history.replaceState(null, "", `/channels#k=key&a=${CODE}`);
    captureAdminClaimCode();

    expect(window.location.hash).toBe("#k=key");
    expect(window.location.pathname).toBe("/channels");
    expect(takeAdminClaimCode()).toBe(CODE);
    expect(takeAdminClaimCode()).toBeUndefined();
  });

  it("leaves a URL without one alone", () => {
    window.history.replaceState(null, "", "/#k=key");
    captureAdminClaimCode();
    expect(window.location.hash).toBe("#k=key");
    expect(takeAdminClaimCode()).toBeUndefined();
  });
});
