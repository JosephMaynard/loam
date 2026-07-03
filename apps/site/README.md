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

- `index.html` — the single landing page (semantic sections, accessible).
- `src/styles.css` — the design system (earthy LOAM palette, responsive, light + dark).
- `src/main.js` — nav toggle, scroll reveal (skipped under `prefers-reduced-motion`), footer year.
- `public/` — the LOAM mark and icon.

Content is intentionally framed to protect ordinary people, not to advertise concealment — mirroring
the project's stance (see the root README and `docs/`).
