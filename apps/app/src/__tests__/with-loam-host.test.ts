// Unit tests for the pure helpers of plugins/with-loam-host.js (pre-release review 2026-09-25):
// no-backup + no-device-transfer, optional hardware features, and the stale-prebuild fingerprint.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require("../../plugins/with-loam-host.js");
const {
  BACKUP_DOMAINS,
  FINGERPRINT_FILE,
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
    for (const name of [
      "android.hardware.wifi",
      "android.hardware.location",
      "android.hardware.location.gps",
      // Implied by app.json `orientation: "portrait"`; optional so landscape-only devices (Chromebooks)
      // aren't filtered from Play.
      "android.hardware.screen.portrait",
    ]) {
      const matches = features.filter((feature) => feature.$["android:name"] === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].$["android:required"]).toBe("false");
    }
    expect(features).toHaveLength(OPTIONAL_FEATURES.length);
  });

  it("covers the portrait feature app.json's orientation implies", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appJson = require("../../app.json");
    if (appJson.expo.orientation === "portrait") {
      expect(OPTIONAL_FEATURES).toContain("android.hardware.screen.portrait");
    }
    if (appJson.expo.orientation === "landscape") {
      expect(OPTIONAL_FEATURES).toContain("android.hardware.screen.landscape");
    }
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
