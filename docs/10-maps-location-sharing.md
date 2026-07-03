# 10 — Maps & location sharing

> **Status: investigation / not committed.** Briefing for a future decision. Captures the goal, a
> concrete off-grid-friendly stack, the two real challenges, and the open scope questions. No code
> yet. Owner ([[loam-project-goal]]) raised it 2026-07-03; wants to think before committing.

## Goal

A built-in map in the LOAM client with **location sharing** — so people on an off-grid node can
point at "the north gate", "camp 3", "the blocked road" and coordinate spatially, not just in text.
Must hold to LOAM's priorities: **works with no internet**, **privacy-first**, **low bandwidth**.

## Why it's non-trivial (the owner's instinct was right)

1. **Map tiles need the internet — normally.** Every mainstream basemap (Google, Mapbox, MapTiler,
   OSM tile servers) is a *cloud service*. LOAM has no internet by design, so tiles must be served
   **by the host, locally**, or not at all.
2. **Location is sensitive.** A messaging tool that quietly tracks people is exactly what LOAM must
   *not* be (see the ethos note in the README / [[loam-project-goal]]). Sharing must be deliberate,
   ephemeral, and leak nothing to third parties.

## Recommended stack (fully offline, all open, no API keys)

| Layer | Choice | Why it fits |
|-------|--------|-------------|
| Renderer | **MapLibre GL JS** (BSD) | No API key, no service; renders vector tiles client-side via WebGL. |
| Tile container | **PMTiles** (single file, HTTP range reads) | **No tile-server process** — the host serves one static `.pmtiles`; MapLibre fetches only visible tiles via range requests. Fastify already does range. |
| Tile data + style | **Protomaps** basemap (OpenStreetMap, ODbL) | Free planet-scale vector builds + open GL styles. Self-host style JSON, glyphs (font PBFs), sprite. |
| Sharing | **Tap-to-drop-a-pin** location messages | Works over plain-HTTP LAN (see challenge 2); deliberate = privacy-respecting. |

**Everything is served by the host over the LAN with zero third-party calls.** That's the core
privacy win: viewport and shared locations never touch an external CDN. Vector tiles are KB-sized,
so it's also low-bandwidth-friendly.

### How it slots into LOAM's architecture

- **Server**: serve `basemap.pmtiles` (static, range-enabled), `style.json`, glyphs, sprite from the
  host. A new `location` message payload (or a `location` message type in `packages/schema`).
- **Client**: a lazy-loaded map view (MapLibre is ~230 KB gzipped — **code-split it** so the core
  chat bundle stays small). Render shared locations as markers; tap the map to share a pin.
- **Config**: a `enableLocationSharing` feature flag, **off by default**, enforced server-side in
  `createMessage()` like the other messaging flags.

## The two real challenges & their answers

1. **Getting tile data offline.** A useful regional `.pmtiles` is ~50–500 MB. It can't be fetched
   off-grid. The admin downloads their region **once while online** (from Protomaps) and the host
   serves it. Delivery options: admin upload via the admin UI, a bundled "region pack", or a
   documented file path the host operator drops in. **This is a genuine setup step, not automatic.**
2. **GPS is blocked over the LAN.** `navigator.geolocation` requires a *secure context*
   (HTTPS/localhost); plain HTTP over the hotspot is not one (the same insecure-context limit noted
   in [[loam-architecture-gotchas]]). So **tap-to-drop-a-pin is the primary share method** — it works
   everywhere and is more privacy-respecting than continuous GPS. Real device GPS works only on the
   host itself (localhost) or under a future HTTPS story; remote joiners drop pins.

## Privacy model (must-haves)

- **Opt-in per share** — you tap to share a specific point; never continuous/background tracking.
- **Ephemeral** — shared locations expire with the retention TTL, like messages.
- **Flag-gated, off by default** — `enableLocationSharing`; server-enforced.
- **No third-party requests** — all map assets from the host. Attribution: "© OpenStreetMap
  contributors" (ODbL) shown on the map.

## Proposed first PR (one cohesive unit)

`location` message type (lat/lng + optional label) → lazy-loaded MapLibre map view served entirely
by the host (PMTiles source + self-hosted style/glyphs/sprite) → tap-to-share pins → markers for
shared locations → `enableLocationSharing` flag + ephemeral, server-enforced. Ship with a small demo
region and document how an admin swaps in their own `.pmtiles`. Add a rendered-component test for the
message/marker rendering (harness landed in #37).

## Open questions for the owner

1. **Demo tile data**: (a) bundle a small sample region, (b) build the admin "upload a region pack"
   flow in the same PR, or (c) scaffold against a documented external `.pmtiles` path and leave
   acquisition to the operator? *(This is the main scope fork.)*
2. **Scope of v1 sharing**: pin-drop only, or also host-GPS where the context is secure?
3. **Bundle-size budget**: OK to lazy-load MapLibre (no cost until the map opens), or keep maps as a
   separate opt-in build entirely?
4. **LoRa tie-in**: a shared location is tiny (a lat/lng pair) — a natural candidate for the future
   low-bandwidth relay transport, unlike bulk tiles. Worth keeping in mind for that roadmap item.
