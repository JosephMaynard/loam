// Tests for scripts/check-versions.mjs's release-tag rules. Run with `node --test` (root `pnpm test`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkReleaseTag, compareReleaseTags, parseReleaseTag } from "./check-versions.mjs";

/** checkReleaseTag over a fixed map of tag → versionCode (a missing key = no readable app.json). */
function check(tag, versionCode, codes, version = "0.5.0") {
  return checkReleaseTag({
    tag,
    version,
    versionCode,
    tags: Object.keys(codes),
    versionCodeAt: (other) => codes[other],
  });
}

describe("parseReleaseTag", () => {
  it("accepts vX.Y.Z and -rc.N / -beta.N pre-releases", () => {
    assert.deepEqual(parseReleaseTag("v0.5.0"), { core: [0, 5, 0], pre: undefined });
    assert.deepEqual(parseReleaseTag("v0.5.0-rc.2"), { core: [0, 5, 0], pre: { kind: "rc", n: 2 } });
    assert.deepEqual(parseReleaseTag("v1.10.3-beta.1"), { core: [1, 10, 3], pre: { kind: "beta", n: 1 } });
  });

  it("rejects anything else", () => {
    for (const tag of ["0.5.0", "v0.5", "v0.5.0-rc", "v0.5.0-rc1", "v0.5.0-alpha.1", "v0.5.0+build", "vfoo"]) {
      assert.equal(parseReleaseTag(tag), undefined, tag);
    }
  });
});

describe("compareReleaseTags", () => {
  it("orders beta < rc < release within a version, and versions numerically", () => {
    const ordered = ["v0.4.0", "v0.5.0-beta.1", "v0.5.0-beta.2", "v0.5.0-rc.1", "v0.5.0-rc.10", "v0.5.0", "v0.10.0"];
    const shuffled = [...ordered].reverse();
    shuffled.sort((a, b) => compareReleaseTags(parseReleaseTag(a), parseReleaseTag(b)));
    assert.deepEqual(shuffled, ordered);
  });
});

describe("checkReleaseTag", () => {
  const history = { "v0.3.0": 5, "v0.4.0": 6 };

  it("passes a release whose core matches and whose versionCode beats every earlier tag", () => {
    const result = check("v0.5.0", 7, history);
    assert.deepEqual(result.problems, []);
    assert.equal(result.prerelease, false);
  });

  it("accepts an RC tag against the bare X.Y.Z manifests and flags it as a pre-release", () => {
    const result = check("v0.5.0-rc.1", 7, history);
    assert.deepEqual(result.problems, []);
    assert.equal(result.prerelease, true);
    assert.equal(check("v0.5.0-beta.3", 7, history).prerelease, true);
  });

  it("rejects a tag whose core differs from the manifests (RC included)", () => {
    assert.match(check("v0.5.1", 7, history).problems.join("\n"), /does not match/);
    assert.match(check("v0.6.0-rc.1", 7, history).problems.join("\n"), /does not match/);
  });

  it("rejects a malformed tag", () => {
    const result = check("v0.5.0-preview", 7, history);
    assert.match(result.problems.join("\n"), /not of the form/);
  });

  it("requires the final release to beat an earlier RC's versionCode", () => {
    const codes = { ...history, "v0.5.0-rc.1": 7 };
    assert.match(check("v0.5.0", 7, codes).problems.join("\n"), /not greater than 7 at v0\.5\.0-rc\.1/);
    assert.deepEqual(check("v0.5.0", 8, codes).problems, []);
    // A later RC too.
    assert.match(check("v0.5.0-rc.2", 7, codes).problems.join("\n"), /not greater than 7/);
  });

  it("compares with the MAXIMUM earlier versionCode, not the nearest lower tag", () => {
    // v0.4.1 (a hotfix) shipped with a lower code than v0.4.0's — the nearest-lower rule would accept 8.
    const codes = { "v0.3.0": 5, "v0.4.0": 9, "v0.4.1": 7 };
    assert.match(check("v0.5.0", 8, codes).problems.join("\n"), /not greater than 9 at v0\.4\.0/);
    assert.deepEqual(check("v0.5.0", 10, codes).problems, []);
  });

  it("ignores later tags, the tag itself and non-release tags", () => {
    const codes = { "v0.4.0": 6, "v0.5.0": 7, "v0.6.0": 20, "nightly": 99, "v0.5.0-alpha.1": 50 };
    assert.deepEqual(check("v0.5.0", 7, codes).problems, []);
  });

  it("skips earlier tags without a readable versionCode", () => {
    const result = check("v0.5.0", 7, { "v0.1.0": undefined, "v0.4.0": 6 });
    assert.deepEqual(result.problems, []);
    assert.match(result.notes.join("\n"), /v0\.1\.0 has no readable versionCode/);
    assert.deepEqual(check("v0.5.0", 1, { "v0.1.0": undefined }).problems, []);
  });

  it("rejects a missing or non-positive versionCode", () => {
    assert.match(check("v0.5.0", undefined, history).problems.join("\n"), /positive integer/);
    assert.match(check("v0.5.0", 0, history).problems.join("\n"), /positive integer/);
  });
});
