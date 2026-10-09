// The Node.js version gate for the `loam` launcher (bin/loam.js). Kept separate so it's testable
// (cli/test/node-version.test.mjs) without spawning an old Node. `npx loamnet` never enforces package.json
// `engines`, and the server needs the built-in `node:sqlite` (unflagged from Node 22.13), which is loaded
// lazily inside the database open: on Node 18 or 20 that failure used to be reported as a wrong or lost
// database key. The evaluator covers the comparators package.json ranges use (`^`, `~`, `>=`, `>`, `<=`,
// `<`, `=`, a bare version), space-separated within an alternative (all must hold) and `||` between
// alternatives (any may hold). `^` is read for versions 1.0.0 and up only, which every Node release is.

/** The Node.js versions loamnet runs on. Must equal `engines.node` in cli/package.json (a test checks). */
export const SUPPORTED_NODE_RANGE = "^22.14.0 || >=23.6.0";

/**
 * Parse "22.14.0" (a leading "v" allowed, missing minor/patch read as 0) into `[major, minor, patch]`.
 * Undefined when the text doesn't start with a version.
 */
export function parseVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?![\d.])/.exec(String(version ?? "").trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. */
function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

/** One comparator as a predicate on a parsed version; undefined for one that can't be read. */
function comparator(text) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(v?\d+(?:\.\d+)?(?:\.\d+)?)$/.exec(text);
  const bound = match ? parseVersion(match[2]) : undefined;
  if (!bound) {
    return undefined;
  }
  switch (match[1]) {
    case ">=":
      return (version) => compare(version, bound) >= 0;
    case ">":
      return (version) => compare(version, bound) > 0;
    case "<=":
      return (version) => compare(version, bound) <= 0;
    case "<":
      return (version) => compare(version, bound) < 0;
    case "^":
      return (version) => compare(version, bound) >= 0 && version[0] === bound[0];
    case "~":
      return (version) => compare(version, bound) >= 0 && version[0] === bound[0] && version[1] === bound[1];
    default:
      return (version) => compare(version, bound) === 0;
  }
}

/**
 * Whether `version` satisfies `range`. A version or range that can't be read never satisfies, so a typo in
 * the range refuses every Node rather than admitting one that will crash later (the test suite pins the real
 * range against the manifest).
 */
export function satisfiesNodeRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return false;
  }
  return String(range ?? "")
    .split("||")
    .some((alternative) => {
      const predicates = alternative.trim().split(/\s+/).filter(Boolean).map(comparator);
      return predicates.length > 0 && predicates.every((holds) => holds !== undefined && holds(parsed));
    });
}

/** One alternative in words: `^22.14.0` reads "22.14 or any later 22.x", `>=23.6.0` "23.6 or newer". */
function describeAlternative(alternative) {
  const match = /^(\^|>=)\s*v?(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(alternative);
  if (!match) {
    return alternative;
  }
  const shown = `${match[2]}.${match[3] ?? 0}`;
  return match[1] === "^" ? `${shown} or any later ${match[2]}.x` : `${shown} or newer`;
}

/** `range` for people: "22.14 or any later 22.x, or 23.6 or newer". */
export function describeNodeRange(range) {
  return String(range ?? "")
    .split("||")
    .map((alternative) => describeAlternative(alternative.trim()))
    .join(", or ");
}

/** The one-sentence refusal for an unsupported Node, or undefined when `version` is supported. */
export function nodeVersionProblem(version, range = SUPPORTED_NODE_RANGE) {
  if (satisfiesNodeRange(version, range)) {
    return undefined;
  }
  const shown = String(version ?? "").trim().replace(/^v/, "") || "unknown";
  return (
    `loamnet needs Node.js ${describeNodeRange(range)}; this is Node ${shown}. ` +
    "Install a current Node.js from https://nodejs.org and run loam again."
  );
}
