// Tests for the `loam` launcher's Node version gate (cli/bin/node-version.js). Run with `node --test`
// (root `pnpm test`). Pure functions, so an old Node is never spawned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  SUPPORTED_NODE_RANGE,
  describeNodeRange,
  nodeVersionProblem,
  parseVersion,
  satisfiesNodeRange,
} from "../bin/node-version.js";

describe("SUPPORTED_NODE_RANGE", () => {
  it("is the engines.node range the package declares", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(SUPPORTED_NODE_RANGE, manifest.engines.node);
  });

  it("admits the Node this test runs on", () => {
    assert.equal(satisfiesNodeRange(process.versions.node, SUPPORTED_NODE_RANGE), true);
    assert.equal(nodeVersionProblem(process.versions.node), undefined);
  });
});

describe("parseVersion", () => {
  it("reads full, short and v-prefixed versions", () => {
    assert.deepEqual(parseVersion("22.14.0"), [22, 14, 0]);
    assert.deepEqual(parseVersion("v20.20.0"), [20, 20, 0]);
    assert.deepEqual(parseVersion("23.6"), [23, 6, 0]);
    assert.deepEqual(parseVersion("24"), [24, 0, 0]);
  });

  it("rejects text that is not a version", () => {
    assert.equal(parseVersion(""), undefined);
    assert.equal(parseVersion("latest"), undefined);
    assert.equal(parseVersion(undefined), undefined);
    assert.equal(parseVersion("1.2.3.4"), undefined);
  });
});

describe("satisfiesNodeRange with the real range", () => {
  const supported = ["22.14.0", "22.14.1", "22.20.0", "23.6.0", "23.11.1", "24.0.0", "24.15.0", "v22.14.0"];
  const unsupported = ["18.19.0", "20.20.0", "21.7.3", "22.0.0", "22.13.1", "23.0.0", "23.5.9"];

  for (const version of supported) {
    it(`accepts ${version}`, () => {
      assert.equal(satisfiesNodeRange(version, SUPPORTED_NODE_RANGE), true);
    });
  }

  for (const version of unsupported) {
    it(`refuses ${version}`, () => {
      assert.equal(satisfiesNodeRange(version, SUPPORTED_NODE_RANGE), false);
    });
  }
});

describe("satisfiesNodeRange comparators", () => {
  it("handles each comparator kind", () => {
    assert.equal(satisfiesNodeRange("1.2.3", ">1.2.2"), true);
    assert.equal(satisfiesNodeRange("1.2.3", ">1.2.3"), false);
    assert.equal(satisfiesNodeRange("1.2.3", "<=1.2.3"), true);
    assert.equal(satisfiesNodeRange("1.2.4", "<=1.2.3"), false);
    assert.equal(satisfiesNodeRange("1.9.9", "<2"), true);
    assert.equal(satisfiesNodeRange("2.0.0", "<2"), false);
    assert.equal(satisfiesNodeRange("1.2.3", "=1.2.3"), true);
    assert.equal(satisfiesNodeRange("1.2.3", "1.2.3"), true);
    assert.equal(satisfiesNodeRange("1.2.4", "1.2.3"), false);
    assert.equal(satisfiesNodeRange("1.2.9", "~1.2.3"), true);
    assert.equal(satisfiesNodeRange("1.3.0", "~1.2.3"), false);
    assert.equal(satisfiesNodeRange("1.9.0", "^1.2.3"), true);
    assert.equal(satisfiesNodeRange("2.0.0", "^1.2.3"), false);
  });

  it("requires every comparator of an alternative and any one alternative", () => {
    assert.equal(satisfiesNodeRange("22.15.0", ">=22.14.0 <23"), true);
    assert.equal(satisfiesNodeRange("23.0.0", ">=22.14.0 <23"), false);
    assert.equal(satisfiesNodeRange("23.0.0", ">=22.14.0 <23 || >=23.6.0"), false);
    assert.equal(satisfiesNodeRange("23.6.0", ">=22.14.0 <23 || >=23.6.0"), true);
  });

  it("never satisfies an unreadable range or version", () => {
    assert.equal(satisfiesNodeRange("22.14.0", "latest"), false);
    assert.equal(satisfiesNodeRange("22.14.0", ""), false);
    assert.equal(satisfiesNodeRange("22.14.0", undefined), false);
    assert.equal(satisfiesNodeRange("lts", SUPPORTED_NODE_RANGE), false);
  });
});

describe("nodeVersionProblem", () => {
  it("is one sentence naming the needed and the running Node, never a database key", () => {
    const problem = nodeVersionProblem("20.20.0", SUPPORTED_NODE_RANGE);
    assert.equal(
      problem,
      "loamnet needs Node.js 22.14 or any later 22.x, or 23.6 or newer; this is Node 20.20.0. " +
        "Install a current Node.js from https://nodejs.org and run loam again.",
    );
    assert.doesNotMatch(problem, /key/i);
  });

  it("strips a leading v and names an unreadable version as unknown", () => {
    assert.match(nodeVersionProblem("v18.19.0"), /this is Node 18\.19\.0\./);
    assert.match(nodeVersionProblem(""), /this is Node unknown\./);
  });

  it("is silent for a supported Node", () => {
    assert.equal(nodeVersionProblem("22.14.0"), undefined);
    assert.equal(nodeVersionProblem("24.15.0"), undefined);
  });
});

describe("describeNodeRange", () => {
  it("renders caret and at-least alternatives in words and leaves others as written", () => {
    assert.equal(describeNodeRange("^22.14.0 || >=23.6.0"), "22.14 or any later 22.x, or 23.6 or newer");
    assert.equal(describeNodeRange(">=20"), "20.0 or newer");
    assert.equal(describeNodeRange("~22.14.0"), "~22.14.0");
  });
});
