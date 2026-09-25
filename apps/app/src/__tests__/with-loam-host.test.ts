// Unit tests for the pure helpers of plugins/with-loam-host.js (pre-release review 2026-09-25):
// no-backup + no-device-transfer, optional hardware features, and the stale-prebuild fingerprint.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require("../../plugins/with-loam-host.js");
const {
  BACKUP_DOMAINS,
  OPTIONAL_FEATURES,
  STALE_GUARD_GRADLE,
  addOptionalFeatures,
  applyApplicationAttributes,
  dataExtractionRulesXml,
  prebuildFingerprint,
} = plugin._internal;

/** The `<exclude domain=…>` values inside one section of the rules XML. */
function excludedDomains(xml: string, section: "cloud-backup" | "device-transfer"): string[] {
  const body = xml.split(`<${section}>`)[1]?.split(`</${section}>`)[0] ?? "";
  return [...body.matchAll(/<exclude domain="([^"]+)" path="\." \/>/g)].map((match) => match[1]);
}

describe("with-loam-host: backup / device-transfer exclusion", () => {
  it("excludes every domain for BOTH cloud backup and device-to-device transfer, with no <include>", () => {
    const xml = dataExtractionRulesXml();
    expect(xml).not.toContain("<include");
    for (const section of ["cloud-backup", "device-transfer"] as const) {
      expect(excludedDomains(xml, section).sort()).toEqual([...BACKUP_DOMAINS].sort());
    }
    expect(BACKUP_DOMAINS).toEqual(
      expect.arrayContaining(["root", "file", "database", "sharedpref", "external", "device_file", "device_database"]),
    );
  });

  it("sets allowBackup/fullBackupContent=false (API < 31) and points dataExtractionRules at the XML", () => {
    const application = applyApplicationAttributes({ $: { "android:allowBackup": "true" } });
    expect(application.$).toMatchObject({
      "android:allowBackup": "false",
      "android:fullBackupContent": "false",
      "android:dataExtractionRules": "@xml/data_extraction_rules",
      "android:usesCleartextTraffic": "true",
    });
  });
});

describe("with-loam-host: optional hardware features", () => {
  it("declares wifi/location/bluetooth features optional and forces an existing required one optional", () => {
    const manifest = {
      "uses-feature": [{ $: { "android:name": "android.hardware.wifi", "android:required": "true" } }],
    };
    addOptionalFeatures(manifest);
    const features = manifest["uses-feature"] as { $: Record<string, string> }[];
    for (const name of ["android.hardware.wifi", "android.hardware.location", "android.hardware.location.gps"]) {
      const matches = features.filter((feature) => feature.$["android:name"] === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].$["android:required"]).toBe("false");
    }
    expect(features).toHaveLength(OPTIONAL_FEATURES.length);
  });
});

describe("with-loam-host: stale-prebuild fingerprint", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("hashes name+bytes of app.json then plugins/*.js sorted — the order the Groovy check uses", () => {
    dir = mkdtempSync(join(tmpdir(), "loam-fp-"));
    mkdirSync(join(dir, "plugins"));
    writeFileSync(join(dir, "app.json"), "{}");
    writeFileSync(join(dir, "plugins", "b.js"), "B");
    writeFileSync(join(dir, "plugins", "a.js"), "A");
    writeFileSync(join(dir, "plugins", "notes.txt"), "ignored");

    const expected = createHash("sha256")
      .update("app.json")
      .update("{}")
      .update("a.js")
      .update("A")
      .update("b.js")
      .update("B")
      .digest("hex");
    expect(prebuildFingerprint(dir)).toBe(expected);

    writeFileSync(join(dir, "app.json"), '{"changed":true}');
    expect(prebuildFingerprint(dir)).not.toBe(expected);
  });

  it("the Gradle guard reads the same stamp file and hooks preBuild", () => {
    expect(STALE_GUARD_GRADLE).toContain('new File(rootDir, "loam-prebuild.sha256")');
    expect(STALE_GUARD_GRADLE).toContain('new File(appDir, "app.json")');
    expect(STALE_GUARD_GRADLE).toContain('it.name.endsWith(".js")');
    expect(STALE_GUARD_GRADLE).toContain('it.name == "preBuild"');
  });
});
