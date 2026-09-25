#!/usr/bin/env node
// Release-version consistency check (pre-release review 2026-09-25). Run by CI on every push/PR and by
// the APK workflow before a tag build. Tests: scripts/check-versions.test.mjs (`node --test`).
//
//   node scripts/check-versions.mjs
//     Every workspace package.json (root, apps/*, packages/*), cli/package.json and apps/app/app.json
//     `expo.version` must carry the SAME version.
//
//   node scripts/check-versions.mjs --release-tag v1.2.3            (a release)
//   node scripts/check-versions.mjs --release-tag v1.2.3-rc.1       (a pre-release: -rc.N or -beta.N)
//     Additionally: the tag's X.Y.Z core must equal the manifest version (manifests always carry the bare
//     X.Y.Z; the suffix lives only on the tag), and apps/app/app.json `expo.android.versionCode` must be
//     GREATER than the versionCode of EVERY earlier release tag — every `vX.Y.Z[-rc.N|-beta.N]` tag that
//     sorts below this one, read via `git show <tag>:apps/app/app.json` (tags without that file are
//     skipped). Play rejects a reused code across all tracks, so an RC uploaded to internal testing uses
//     up its code and the final release needs a higher one; a sideloaded update with a lower code won't
//     install. Chosen by version order, not ancestry: squash-merged release branches mean an earlier tag
//     need not be reachable from a later one. Needs the tags fetched (checkout fetch-depth: 0).
//
// Exits non-zero with a list of problems; never modifies anything (bumping is a deliberate release step).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_JSON = "apps/app/app.json";

/** Pre-release kinds a tag may carry, in ascending order (semver compares them as strings: beta < rc). */
const PRERELEASE_KINDS = ["beta", "rc"];

/**
 * Parse a release tag: `vX.Y.Z`, `vX.Y.Z-rc.N` or `vX.Y.Z-beta.N`. Returns
 * `{ core: [X, Y, Z], pre: { kind, n } | undefined }`, or undefined for anything else.
 */
export function parseReleaseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(rc|beta)\.(\d+))?$/.exec(tag);
  if (!match) {
    return undefined;
  }
  return {
    core: match.slice(1, 4).map(Number),
    pre: match[4] ? { kind: match[4], n: Number(match[5]) } : undefined,
  };
}

/**
 * Semver-style comparator over two parsed tags: the core triple first, then a pre-release sorts BELOW
 * its release (v1.0.0-rc.1 < v1.0.0), beta below rc, then by N.
 */
export function compareReleaseTags(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i] - b.core[i];
    }
  }
  if (!a.pre || !b.pre) {
    return (a.pre ? -1 : 0) - (b.pre ? -1 : 0);
  }
  if (a.pre.kind !== b.pre.kind) {
    return PRERELEASE_KINDS.indexOf(a.pre.kind) - PRERELEASE_KINDS.indexOf(b.pre.kind);
  }
  return a.pre.n - b.pre.n;
}

/**
 * The release-tag checks, pure over their inputs so they can be tested without a git repo.
 *
 * @param {object} input
 * @param {string} input.tag             the tag being built
 * @param {string} input.version         the (agreed) manifest version, bare X.Y.Z
 * @param {unknown} input.versionCode    app.json expo.android.versionCode at this commit
 * @param {string[]} input.tags          every tag in the repo (non-release ones are ignored)
 * @param {(tag: string) => unknown} input.versionCodeAt  versionCode at a tag, or undefined when unreadable
 * @returns {{ problems: string[], notes: string[], prerelease: boolean }}
 */
export function checkReleaseTag({ tag, version, versionCode, tags, versionCodeAt }) {
  const problems = [];
  const notes = [];
  const current = parseReleaseTag(tag);
  if (!current) {
    problems.push(`Release tag ${tag} is not of the form vX.Y.Z, vX.Y.Z-rc.N or vX.Y.Z-beta.N.`);
    return { problems, notes, prerelease: false };
  }
  const core = current.core.join(".");
  if (core !== version) {
    problems.push(`Tag ${tag} does not match the version in the manifests (expected v${version}, optionally with -rc.N / -beta.N).`);
  }
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    problems.push(`${APP_JSON} expo.android.versionCode must be a positive integer (got ${String(versionCode)}).`);
    return { problems, notes, prerelease: Boolean(current.pre) };
  }
  // Every earlier release tag's versionCode; the new one must beat the highest.
  let highest;
  for (const other of tags) {
    const parsed = parseReleaseTag(other);
    if (!parsed || compareReleaseTags(parsed, current) >= 0) {
      continue;
    }
    const code = versionCodeAt(other);
    if (!Number.isInteger(code)) {
      notes.push(`${other} has no readable versionCode — skipped.`);
      continue;
    }
    if (!highest || code > highest.code) {
      highest = { tag: other, code };
    }
  }
  if (!highest) {
    notes.push(`No earlier release tag with a versionCode than ${tag} — skipping the versionCode comparison.`);
  } else if (versionCode <= highest.code) {
    problems.push(
      `${APP_JSON} expo.android.versionCode ${versionCode} is not greater than ${highest.code} at ${highest.tag} ` +
        "(the highest of every earlier release tag) — bump it.",
    );
  } else {
    notes.push(`versionCode ${versionCode} > ${highest.code} (${highest.tag}, the highest earlier release) ✓`);
  }
  return { problems, notes, prerelease: Boolean(current.pre) };
}

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

/** Run git in the repo; returns trimmed stdout, or undefined on failure. */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** app.json's versionCode at `tag`, or undefined when the tag lacks the file or it doesn't parse. */
function versionCodeAtTag(tag) {
  const text = git(["show", `${tag}:${APP_JSON}`]);
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text).expo?.android?.versionCode;
  } catch {
    return undefined;
  }
}

/** The CLI: check the manifests (and, with --release-tag, the tag); exit non-zero on any problem. */
function main(argv) {
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

  const flagIndex = argv.indexOf("--release-tag");
  const releaseTag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (flagIndex >= 0 && !releaseTag) {
    problems.push("--release-tag needs a value, e.g. --release-tag v1.2.3");
  }
  let prerelease = false;
  if (releaseTag) {
    const result = checkReleaseTag({
      tag: releaseTag,
      version,
      versionCode: appJson.expo?.android?.versionCode,
      tags: (git(["tag", "--list", "v*"]) ?? "").split("\n").map((tag) => tag.trim()).filter(Boolean),
      versionCodeAt: versionCodeAtTag,
    });
    problems.push(...result.problems);
    for (const note of result.notes) {
      console.log(note);
    }
    prerelease = result.prerelease;
  }

  if (problems.length > 0) {
    console.error(`✗ Version check failed:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `✓ All ${versions.size} version fields agree on ${version}` +
      (releaseTag ? ` (tag ${releaseTag}${prerelease ? ", pre-release" : ""})` : "") +
      ".",
  );
}

// Run only as the entry point (the test imports the pure helpers above).
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
