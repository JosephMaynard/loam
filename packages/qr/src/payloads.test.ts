import { describe, expect, it } from "vitest";

import { channelLink, userLink, wifiPayload } from "./payloads.js";

describe("payload helpers", () => {
  it("escapes wifi payload values conservatively", () => {
    expect(wifiPayload('LOAM\\Net;"', 'pa:ss;word,1')).toBe(
      'WIFI:T:WPA;S:LOAM\\\\Net\\;\\\";P:pa\\:ss\\;word\\,1;;',
    );
  });

  it("builds absolute user and channel links", () => {
    expect(userLink("http://loam.local", "a/b")).toBe("http://loam.local/user/a%2Fb");
    expect(channelLink("http://loam.local/app", "general chat")).toBe(
      "http://loam.local/channel/general%20chat",
    );
  });
});
