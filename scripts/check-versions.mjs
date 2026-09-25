#!/usr/bin/env node
// Release-version consistency check (pre-release review 2026-09-25). Run by CI on every push/PR and by
// the APK workflow before a tag build.
//
//   node scripts/check-versions.mjs
//     Every workspace package.json (root, apps/*, packages/*), cli/package.json and apps/app/app.json
//     `expo.version` must carry the SAME version.
//
//   node scripts/check-versions.mjs --release-tag v1.2.3
//     Additionally: the tag must be exactly `v<version>`, and apps/app/app.json `expo.android.versionCode`
//     must be GREATER than the versionCode at the previous release tag — the highest `vX.Y.Z` tag that
//     sorts below this one (Play rejects a reused code, and a sideloaded update with a lower code won't
//     install). Chosen by version order, not ancestry: squash-merged release branches mean an earlier tag
//     need not be reachable from a later one. Needs the tags fetched (checkout fetch-depth: 0).
//
// Exits non-zero with a list of problems; never modifies anything (bumping is a deliberate release step).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_JSON = "apps/app/app.json";

/** Read and parse a JSON file relative to the repo root. */
function readJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
}

/** Every package.json the release version must agree across. */
function manifestPaths() {
  const paths = ["package.json", "cli/package.json"];
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(repoRoot, group)).sort()) {
      const rel = `${group}/${name}/package.json`;
      if (existsSync(join(repoRoot, rel))) {
        paths.push(rel);
      }
    }
  }
  return paths;
}

/** The value after `--flag`, or undefined. */
function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** `vX.Y.Z` → [X, Y, Z], or undefined for anything else (pre-releases included). */
function parseReleaseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : undefined;
}

/** Negative / zero / positive like a comparator, over two parsed [X, Y, Z] triples. */
function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

/** Run git in the repo; returns trimmed stdout, or undefined on failure. */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const problems = [];
const versions = new Map();
for (const rel of manifestPaths()) {
  versions.set(rel, readJson(rel).version);
}
const appJson = readJson(APP_JSON);
versions.set(`${APP_JSON} (expo.version)`, appJson.expo?.version);

const distinct = [...new Set(versions.values())];
if (distinct.length !== 1 || typeof distinct[0] !== "string") {
  problems.push(
    "Versions disagree:\n" + [...versions].map(([file, version]) => `    ${file}: ${String(version)}`).join("\n"),
  );
}
const version = distinct[0];

const releaseTag = argValue("--release-tag");
if (process.argv.includes("--release-tag") && !releaseTag) {
  problems.push("--release-tag needs a value, e.g. --release-tag v1.2.3");
}
if (releaseTag) {
  if (releaseTag !== `v${version}`) {
    problems.push(`Tag ${releaseTag} does not match the version in the manifests (expected v${version}).`);
  }
  const versionCode = appJson.expo?.android?.versionCode;
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    problems.push(`${APP_JSON} expo.android.versionCode must be a positive integer (got ${String(versionCode)}).`);
  } else {
    // The highest vX.Y.Z tag below this one — the previous release.
    const current = parseReleaseTag(releaseTag);
    const previousTag = current
      ? (git(["tag", "--list", "v*"]) ?? "")
          .split("\n")
          .map((tag) => [tag.trim(), parseReleaseTag(tag.trim())])
          .filter(([, triple]) => triple && compareTriples(triple, current) < 0)
          .sort(([, a], [, b]) => compareTriples(b, a))[0]?.[0]
      : undefined;
    if (!current) {
      problems.push(`Release tag ${releaseTag} is not of the form vX.Y.Z.`);
    } else if (!previousTag) {
      console.log(`No earlier vX.Y.Z tag than ${releaseTag} — skipping the versionCode comparison.`);
    } else {
      const previousAppJson = git(["show", `${previousTag}:${APP_JSON}`]);
      const previousCode = previousAppJson ? JSON.parse(previousAppJson).expo?.android?.versionCode : undefined;
      if (!Number.isInteger(previousCode)) {
        console.log(`${previousTag} has no readable versionCode — skipping the versionCode comparison.`);
      } else if (versionCode <= previousCode) {
        problems.push(
          `${APP_JSON} expo.android.versionCode ${versionCode} is not greater than ${previousCode} at ${previousTag} — bump it.`,
        );
      } else {
        console.log(`versionCode ${versionCode} > ${previousCode} (${previousTag}) ✓`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ Version check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`✓ All ${versions.size} version fields agree on ${version}${releaseTag ? ` (tag ${releaseTag})` : ""}.`);
