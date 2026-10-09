# Contributing to LOAM

Thanks for looking. LOAM is a small project with a clear purpose (local, off-grid messaging that is
simple, private and resilient), so the most useful contributions are the ones that keep it that way:
bug reports with steps, fixes with a regression test, translations, and honest documentation.

## Before you start

- **Found a security problem?** Do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Want a feature?** Open an issue first and say who it is for and what they would do with it. LOAM
  turns down features that need an account, a cloud service or an internet connection.
- **Code of conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Licence:** LOAM is AGPL-3.0-only. By contributing you agree that your contribution is licensed the
  same way.

## Setting up

LOAM is a pnpm workspace. Node is pinned in `.node-version` (24.15.0) and pnpm in `package.json`
(`packageManager`), so either `corepack enable` or `npm install -g pnpm@10` works.

```bash
pnpm install
pnpm dev            # server on :3001, web client on :3000, prints a join QR
pnpm build          # every package, then the server (tsc) and client (tsc -b + vite)
pnpm test           # every Vitest suite, then the Node tests for scripts/ and cli/
pnpm --filter app typecheck   # the Android host has no build script, so typecheck it explicitly
```

[ARCHITECTURE.md](ARCHITECTURE.md) is the map of the codebase. `CLAUDE.md` is the same material
written as instructions for AI coding agents; it is accurate, but it is not the friendly version.

## Three things that catch everyone

1. **The server consumes the compiled `packages/*`.** `apps/server` imports `@loam/schema` (and the
   other packages) from their `dist/`, and `tsx watch` does not rebuild them. After editing a package,
   run `pnpm --filter @loam/schema build` (or `pnpm -r build`) or the running server will not see it.
   The web client aliases the packages to `src/`, so it picks up edits live.
2. **Never put a test file under `apps/app/src/app/`.** That directory is the Expo Router root; its
   `require.context` bundles every file in it into the release APK, and a `vitest` import drags Vite
   into the bundle and breaks `assembleRelease`. Debug builds hide it. Tests go in `apps/app/src/lib/`
   or `apps/app/src/__tests__/`.
3. **There is no linter, on purpose.** TypeScript strict with `noUnusedLocals`, `noUnusedParameters`
   and `verbatimModuleSyntax` is the guard, and `pnpm build` runs it. Match the surrounding style:
   named functions with a JSDoc line, `import type` for types, explicit `.js` extensions on relative
   imports inside `packages/*/src`.

## Making a change

- One topic per pull request. Big multi-commit branches are fine; they are squash-merged, so put the
  effort into the PR title and description rather than the commit history.
- Every bug fix comes with a test that fails without it. The server suites drive `buildApp()` through
  `server.inject()`; the client suites mount real components in jsdom; the Android app and the CLI have
  their own Vitest and `node --test` suites.
- Validate at boundaries with the shared Zod schemas in `packages/schema` rather than trusting input.
- After mutating server state, write through to the store and then broadcast, as the existing handlers do.
- **User-facing text** lives in the i18n catalogs (`apps/client/src/i18n/`, `apps/app/src/lib/i18n/`),
  all 15 locales, and the parity tests fail on a missing key. Keep it plain, keep it short, and do not
  use em-dashes in anything a person reads.
- Add a line to `CHANGELOG.md` under `[Unreleased]` for anything a user or operator would notice.
- Keep the security docs honest. If a change alters what is protected against whom, update
  [SECURITY.md](SECURITY.md) and the relevant `docs/` page rather than only the code.

CI runs the version check, build, every test suite, the Android typecheck and a smoke test of the
packed `loamnet` CLI on the oldest supported Node. A pull request needs all of it green.

## How AI is used here

The maintainer uses AI coding agents for implementation and review, including the security reviews
listed in SECURITY.md. Everything they produce is read, verified against the source, tested and
reviewed again before it is merged. Pull requests written with AI help are welcome under the same rule:
you are responsible for understanding and standing behind what you submit.

## Translations

LOAM ships in 15 languages. A correction to an existing translation is a one-line change in the locale
file. A new language needs a complete catalog in both `apps/client/src/i18n/` and
`apps/app/src/lib/i18n/`, plus the rules and privacy text; open an issue first so we can agree the
locale code and the right-to-left handling.
