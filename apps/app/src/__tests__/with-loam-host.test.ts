// Unit tests for the pure helpers of plugins/with-loam-host.js: loopback-only cleartext, no-backup +
// no-device-transfer, the hotspot permission set, optional hardware features, the legacy Bluetooth
// permissions, and the stale-prebuild fingerprint.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hotspotPermissionsToRequest } from "@/lib/hotspot-permissions";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require("../../plugins/with-loam-host.js");
const {
  BACKUP_DOMAINS,
  CLEARTEXT_HOSTS,
  FINGERPRINT_FILE,
  HOTSPOT_PERMISSIONS,
  LEGACY_BLUETOOTH_PERMISSIONS,
  NETWORK_SECURITY_CONFIG_RESOURCE,
  OPTIONAL_FEATURES,
  STALE_GUARD_GRADLE,
  addLegacyBluetoothPermissions,
  addOptionalFeatures,
  applyApplicationAttributes,
  applyMainActivityAttributes,
  dataExtractionRulesXml,
  networkSecurityConfigXml,
  prebuildFingerprint,
} = plugin._internal;

describe("with-loam-host: cleartext only to loopback", () => {
  it("points the application at a network security config and drops the app-wide usesCleartextTraffic", () => {
    const application = applyApplicationAttributes({ $: { "android:usesCleartextTraffic": "true" } });
    expect(application.$["android:networkSecurityConfig"]).toBe("@xml/network_security_config");
    expect(NETWORK_SECURITY_CONFIG_RESOURCE).toBe("@xml/network_security_config");
    expect(application.$).not.toHaveProperty("android:usesCleartextTraffic");
  });

  it("refuses cleartext by default and allows it for exactly localhost and 127.0.0.1", () => {
    const xml = networkSecurityConfigXml();
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false" />');
    const domainConfigs = [...xml.matchAll(/<domain-config cleartextTrafficPermitted="([^"]+)">([\s\S]*?)<\/domain-config>/g)];
    expect(domainConfigs).toHaveLength(1);
    expect(domainConfigs[0][1]).toBe("true");
    const hosts = [...domainConfigs[0][2].matchAll(/<domain includeSubdomains="false">([^<]+)<\/domain>/g)].map((match) => match[1]);
    expect(hosts.sort()).toEqual(["127.0.0.1", "localhost"]);
    expect(CLEARTEXT_HOSTS.sort()).toEqual(["127.0.0.1", "localhost"]);
    // No LAN range, no wildcard, no second permitted block: the joiners' phones never go through this app.
    expect(xml).not.toMatch(/includeSubdomains="true"|192\.168|10\.0|\*/);
    expect(xml).not.toContain("<debug-overrides");
  });
});

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
      "android:networkSecurityConfig": "@xml/network_security_config",
    });
  });
});

describe("with-loam-host: hotspot permissions", () => {
  it("declares fine AND coarse location together, NEARBY_WIFI_DEVICES and the WIFI_STATE pair", () => {
    // Android 12+ honours a fine-location request only when coarse rides in the same dialog, and a runtime
    // request for a permission the manifest does not declare auto-denies with no dialog; so a manifest
    // with fine but not coarse means the hotspot can never start on a fresh Android 12 install.
    expect(HOTSPOT_PERMISSIONS).toEqual(
      expect.arrayContaining([
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.NEARBY_WIFI_DEVICES",
        "android.permission.CHANGE_WIFI_STATE",
        "android.permission.ACCESS_WIFI_STATE",
      ]),
    );
    expect(new Set(HOTSPOT_PERMISSIONS).size).toBe(HOTSPOT_PERMISSIONS.length);
  });

  it("declares every permission the runtime request asks for, on every API level", () => {
    // The manifest side and the JS side (src/lib/hotspot-permissions.ts) must agree, or the request for the
    // missing one silently auto-denies (the API 33+ regression described in the plugin).
    for (const apiLevel of [24, 30, 31, 32, 33, 35]) {
      for (const name of hotspotPermissionsToRequest(apiLevel)) {
        expect(HOTSPOT_PERMISSIONS, `API ${apiLevel}: ${name}`).toContain(`android.permission.${name}`);
      }
    }
  });

  it("is not undone by app.json's blockedPermissions", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appJson = require("../../app.json");
    const blocked: string[] = appJson.expo.android?.blockedPermissions ?? [];
    for (const name of HOTSPOT_PERMISSIONS) {
      expect(blocked).not.toContain(name);
    }
  });
});

describe("with-loam-host: optional hardware features", () => {
  it("declares wifi/location/bluetooth/touch features optional and forces an existing required one optional", () => {
    const manifest = {
      "uses-feature": [{ $: { "android:name": "android.hardware.wifi", "android:required": "true" } }],
    };
    addOptionalFeatures(manifest);
    const features = manifest["uses-feature"] as { $: Record<string, string> }[];
    for (const name of [
      "android.hardware.wifi",
      "android.hardware.location",
      "android.hardware.location.gps",
      // ACCESS_COARSE_LOCATION implies this one (fine implies .gps); both optional, like the rest.
      "android.hardware.location.network",
      // Every app implies a touchscreen unless it says otherwise; without these two Play hides the listing
      // from Android laptops and desktops that have only a keyboard and trackpad.
      "android.hardware.touchscreen",
      "android.hardware.faketouch",
    ]) {
      const matches = features.filter((feature) => feature.$["android:name"] === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].$["android:required"]).toBe("false");
    }
    expect(features).toHaveLength(OPTIONAL_FEATURES.length);
  });

  it("declares no screen-orientation feature, since app.json locks no orientation", () => {
    // A fixed orientation implies `android.hardware.screen.<orientation>`; `default` implies none, and the
    // host must run in both (tablets, foldables, laptops; Play's large-screen checks).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appJson = require("../../app.json");
    expect(appJson.expo.orientation).toBe("default");
    expect(OPTIONAL_FEATURES.filter((name: string) => name.startsWith("android.hardware.screen."))).toEqual([]);
  });
});

describe("with-loam-host: large screens", () => {
  it("marks the main activity resizable and leaves its configChanges and orientation alone", () => {
    const configChanges = "keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize";
    const activity = applyMainActivityAttributes({
      $: { "android:name": ".MainActivity", "android:configChanges": configChanges, "android:screenOrientation": "unspecified" },
    });
    expect(activity.$).toEqual({
      "android:name": ".MainActivity",
      "android:configChanges": configChanges,
      "android:screenOrientation": "unspecified",
      "android:resizeableActivity": "true",
    });
  });

  it("overrides a non-resizable declaration rather than keeping it", () => {
    const activity = applyMainActivityAttributes({ $: { "android:name": ".MainActivity", "android:resizeableActivity": "false" } });
    expect(activity.$["android:resizeableActivity"]).toBe("true");
  });
});

describe("with-loam-host: legacy Bluetooth permissions (API 24-30)", () => {
  it("declares BLUETOOTH and BLUETOOTH_ADMIN capped at API 30, leaving the API 31+ trio uncapped", () => {
    const manifest = {
      "uses-permission": [{ $: { "android:name": "android.permission.BLUETOOTH_SCAN" } }],
    };
    addLegacyBluetoothPermissions(manifest);
    const perms = manifest["uses-permission"] as { $: Record<string, string> }[];
    expect(LEGACY_BLUETOOTH_PERMISSIONS).toEqual(["android.permission.BLUETOOTH", "android.permission.BLUETOOTH_ADMIN"]);
    for (const name of LEGACY_BLUETOOTH_PERMISSIONS) {
      const matches = perms.filter((permission) => permission.$["android:name"] === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].$["android:maxSdkVersion"]).toBe("30");
    }
    const scan = perms.find((permission) => permission.$["android:name"] === "android.permission.BLUETOOTH_SCAN");
    expect(scan?.$["android:maxSdkVersion"]).toBeUndefined();
    expect(perms).toHaveLength(3);
  });

  it("caps an existing declaration instead of duplicating it, and is idempotent", () => {
    const manifest = {
      "uses-permission": [{ $: { "android:name": "android.permission.BLUETOOTH" } }],
    };
    addLegacyBluetoothPermissions(manifest);
    addLegacyBluetoothPermissions(manifest);
    const perms = manifest["uses-permission"] as { $: Record<string, string> }[];
    expect(perms).toHaveLength(2);
    expect(perms.every((permission) => permission.$["android:maxSdkVersion"] === "30")).toBe(true);
  });

  it("creates the permission list on a manifest that has none", () => {
    const manifest: Record<string, unknown> = {};
    addLegacyBluetoothPermissions(manifest);
    expect(manifest["uses-permission"]).toHaveLength(2);
  });
});

/** An app dir with app.json and plugins whose names sort differently by code unit vs. case-insensitively. */
function writePrebuildFixture(appDir: string) {
  mkdirSync(join(appDir, "plugins"), { recursive: true });
  writeFileSync(join(appDir, "app.json"), '{"expo":{}}');
  writeFileSync(join(appDir, "plugins", "a.js"), "A");
  writeFileSync(join(appDir, "plugins", "B.js"), "B");
  writeFileSync(join(appDir, "plugins", "_c.js"), "C");
  writeFileSync(join(appDir, "plugins", "notes.md"), "ignored");
}

type GroovyFingerprintSpec = {
  digest: string;
  manifest: string;
  pluginDir: string;
  pluginExt: string;
  perFile: string[];
};

/** Parse the fingerprint closure out of the Groovy guard; throws when its shape isn't the expected one. */
function groovyFingerprintSpec(gradle: string): GroovyFingerprintSpec {
  const body = gradle.split("def loamPrebuildFingerprint = {")[1]?.split("\n}\n")[0];
  if (!body) throw new Error("loamPrebuildFingerprint closure not found");
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const expectLine = (index: number, pattern: RegExp) => {
    const match = pattern.exec(lines[index] ?? "");
    if (!match) throw new Error(`unexpected Groovy at line ${index}: ${lines[index]}`);
    return match;
  };
  expectLine(0, /^def appDir = new File\(rootDir, "\.\."\)$/);
  const digest = expectLine(1, /^def md = java\.security\.MessageDigest\.getInstance\("([^"]+)"\)$/)[1];
  const manifest = expectLine(2, /^def files = \[new File\(appDir, "([^"]+)"\)\]$/)[1];
  const [, pluginDir, pluginExt] = expectLine(
    3,
    /^files \+= \(new File\(appDir, "([^"]+)"\)\.listFiles\(\)\.findAll \{ it\.name\.endsWith\("([^"]+)"\) \}\.sort \{ it\.name \}\)$/,
  );
  expectLine(4, /^files\.each \{ f ->$/);
  const perFile: string[] = [];
  let index = 5;
  for (; lines[index]?.startsWith("md.update("); index += 1) {
    perFile.push(lines[index]);
  }
  expectLine(index, /^\}$/);
  expectLine(index + 1, /^return md\.digest\(\)\.encodeHex\(\)\.toString\(\)$/);
  if (lines.length !== index + 2) throw new Error("extra Groovy after the digest");
  return { digest, manifest, pluginDir, pluginExt, perFile };
}

/** Compute the fingerprint the way the parsed Groovy spec says to. */
function fingerprintFromSpec(spec: GroovyFingerprintSpec, appDir: string): string {
  expect(spec.digest).toBe("SHA-256");
  const hash = createHash("sha256");
  const plugins = readdirSync(join(appDir, spec.pluginDir))
    .filter((name) => name.endsWith(spec.pluginExt))
    .sort(); // Groovy `sort { it.name }` = String.compareTo = UTF-16 code-unit order, as here.
  const files = [
    [spec.manifest, join(appDir, spec.manifest)],
    ...plugins.map((name) => [name, join(appDir, spec.pluginDir, name)]),
  ];
  for (const [name, path] of files) {
    for (const op of spec.perFile) {
      if (op === 'md.update(f.name.getBytes("UTF-8"))') hash.update(Buffer.from(name, "utf8"));
      else if (op === "md.update(f.bytes)") hash.update(readFileSync(path));
      else throw new Error(`unknown Groovy hash input: ${op}`);
    }
  }
  return hash.digest("hex");
}

/** A gradle executable for the opt-in run: $LOAM_GRADLE, else `gradle` on PATH; undefined when neither. */
function findGradle(): string | undefined {
  if (process.env.LOAM_GRADLE) return existsSync(process.env.LOAM_GRADLE) ? process.env.LOAM_GRADLE : undefined;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(entry, process.platform === "win32" ? "gradle.bat" : "gradle");
    if (entry && existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Opt-in (LOAM_GRADLE_GUARD_TEST=1, plus gradle on PATH or $LOAM_GRADLE): runs the real Groovy guard in a
// tiny Gradle project against a stamp written by the JS side. ~30 s of JVM start-up, so not in CI.
const gradle = process.env.LOAM_GRADLE_GUARD_TEST === "1" ? findGradle() : undefined;

describe.skipIf(!gradle)("with-loam-host: stale-prebuild guard under real Gradle (opt-in)", () => {
  it("passes on the JS-written stamp, fails once app.json changes, and honours the escape hatch", () => {
    const root = mkdtempSync(join(tmpdir(), "loam-gradle-guard-"));
    try {
      writePrebuildFixture(root);
      const android = join(root, "android");
      mkdirSync(android);
      writeFileSync(join(android, "settings.gradle"), 'rootProject.name = "loam-guard-fixture"\n');
      writeFileSync(join(android, "build.gradle"), `tasks.register("preBuild")\n${STALE_GUARD_GRADLE}`);
      writeFileSync(join(android, FINGERPRINT_FILE), `${prebuildFingerprint(root)}\n`);
      const run = (...extra: string[]) =>
        spawnSync(gradle as string, ["-p", android, "preBuild", "--offline", "--no-daemon", "-q", ...extra], {
          encoding: "utf8",
          timeout: 180_000,
        });

      const fresh = run();
      expect(fresh.status, fresh.stderr).toBe(0);

      writeFileSync(join(root, "plugins", "B.js"), "B changed");
      const stale = run();
      expect(stale.status).not.toBe(0);
      expect(stale.stderr + stale.stdout).toMatch(/STALE/);

      expect(run("-PloamSkipPrebuildCheck").status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
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

  it("the Groovy guard's hashing algorithm, parsed back out, matches the JS fingerprint", () => {
    // Recompute the fingerprint from what the GROOVY says (digest, inputs, their order, what each file
    // contributes, the encoding) and compare with prebuildFingerprint. Any drift in the Groovy — a new input,
    // a different order, hashing only the bytes — fails the parse or the comparison.
    const spec = groovyFingerprintSpec(STALE_GUARD_GRADLE);
    dir = mkdtempSync(join(tmpdir(), "loam-fp-"));
    writePrebuildFixture(dir);
    expect(fingerprintFromSpec(spec, dir)).toBe(prebuildFingerprint(dir));
  });

  it("the Gradle guard reads the same stamp file and hooks preBuild", () => {
    expect(STALE_GUARD_GRADLE).toContain('new File(rootDir, "loam-prebuild.sha256")');
    expect(STALE_GUARD_GRADLE).toContain('new File(appDir, "app.json")');
    expect(STALE_GUARD_GRADLE).toContain('it.name.endsWith(".js")');
    expect(STALE_GUARD_GRADLE).toContain('it.name == "preBuild"');
  });
});
