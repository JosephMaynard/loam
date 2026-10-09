// Every error message the server answers with must map to a stable code in `ERROR_CODES`: the client
// branches on the code and shows its own 15-locale text, so a message without one reaches people in
// English whatever language they chose. This scans the source for the two literal forms (`errorBody("…")`
// and `{ error: "…" }`) so a new route can't quietly add an untranslated sentence.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_ERROR_CODES } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "./errors.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));

/** Every error-message literal in the server source, with the file it came from. */
function errorLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "errors.ts") {
      continue;
    }
    const source = readFileSync(join(sourceDir, file), "utf8");
    for (const match of source.matchAll(/errorBody\(\s*"([^"]+)"|\{\s*error:\s*"([^"]+)"\s*\}/g)) {
      const text = match[1] ?? match[2];
      if (text) {
        found.set(text, [...(found.get(text) ?? []), file]);
      }
    }
  }
  return found;
}

describe("server error messages", () => {
  it("every message literal answered to a client has a code", () => {
    const missing = [...errorLiterals()].filter(([text]) => ERROR_CODES[text] === undefined);
    expect(missing).toEqual([]);
  });

  it("every code in the table is one the schema (and so every client catalog) knows", () => {
    const known = new Set<string>(SERVER_ERROR_CODES);
    const unknown = Object.entries(ERROR_CODES).filter(([, code]) => !known.has(code));
    expect(unknown).toEqual([]);
  });
});
