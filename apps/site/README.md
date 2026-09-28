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

- `index.html` — the landing page (semantic sections, accessible).
- `privacy.html` — the privacy policy at `/privacy` (a second Vite entry; Vercel `cleanUrls` drops the
  `.html`). Play requires a public policy URL; keep it in step with what the app actually does.
- `src/styles.css` — the design system (earthy LOAM palette, responsive, light + dark).
- `src/main.js` — nav toggle, scroll reveal (skipped under `prefers-reduced-motion`), footer year, and
  cookieless PostHog analytics (EU host, memory-only persistence, pageviews + download/GitHub link
  clicks; a no-op when `VITE_POSTHOG_KEY` isn't set at build time). The CSP in `vercel.json` allows only
  the EU ingest host.
- `public/` — the LOAM mark and icon.

Content is intentionally framed to protect ordinary people, not to advertise concealment — mirroring
the project's stance (see the root README and `docs/`).
