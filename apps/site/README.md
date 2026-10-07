# apps/site — loamnet.com

The public marketing site for LOAM. A static Vite build (hand-written HTML/CSS + a touch of
progressive-enhancement JS — no framework), designed to be deployed to **loamnet.com** via Vercel.

## Develop

```bash
pnpm --filter site dev       # local dev server
pnpm --filter site build     # production build → apps/site/dist
pnpm --filter site preview   # preview the built output
```

## Deploy to Vercel

Point Vercel at this repo with **Root Directory = `apps/site`**. It auto-detects Vite; `vercel.json`
pins the build command, output directory, and a few security headers. Set the production domain to
`loamnet.com`.

## Structure

- `index.html`: the landing page (semantic sections, accessible).
- `privacy.html`: the privacy policy at `/privacy` (a second Vite entry; Vercel `cleanUrls` drops the
  `.html`). Play requires a public policy URL; keep it in step with what the app actually does.
- `child-safety.html`: the child safety (CSAE) standards at `/child-safety`, a third Vite entry. Play's
  Child Safety Standards policy requires a public page with a named point of contact.
- `src/styles.css`: the design system. Warm paper and deep moss with an ember accent, light and dark,
  Bricolage Grotesque for headings, Inter for text and JetBrains Mono for code. The fonts are
  self-hosted from `@fontsource-variable` packages (the CSP allows no font host), split by script, so a
  visitor downloads only the subsets their language needs.
- `src/main.js`: nav toggle, header hairline on scroll, copy buttons, scroll reveal (skipped under
  `prefers-reduced-motion`), footer year, and cookieless PostHog analytics (EU host, memory-only
  persistence, pageviews plus download, GitHub and copy-command clicks; a no-op when `VITE_POSTHOG_KEY`
  isn't set at build time). The CSP in `vercel.json` allows only the EU ingest host.
- `public/shots/`: the screenshots, all real (see `scripts/android-shots.md` to retake them).
- `public/og-image.png`: the 1200×630 share image (`scripts/og-image.mjs`).
- `scripts/`: the screenshot tooling (dev-only; `playwright-core` drives the installed Chrome).

Content is intentionally framed to protect ordinary people, not to advertise concealment, mirroring
the project's stance (see the root README and `docs/`).
