# LOAM

LOAM is a system for off-grid, local-first communication.

It allows groups of people to communicate without internet access by connecting to a nearby device acting as a WiFi hotspot. Messages are shared locally and can be relayed between devices using low-bandwidth radios like LoRa, allowing communication to spread across a wider area.

The system is designed for use in situations where traditional networks are unavailable, unreliable, or unsafe, such as emergencies, large events, or areas with limited infrastructure.

LOAM prioritises:
- simplicity (no accounts, no setup)
- privacy (anonymous, ephemeral identities)
- resilience (works with very low bandwidth and intermittent connectivity)

Users connect via their phone's browser to a local web app (PWA), where they can send short messages, view announcements, and coordinate with others nearby. The interface is intentionally minimal and works across languages, including support for right-to-left scripts.

LOAM is transport-agnostic, meaning it can operate over different communication methods (WiFi, LoRa, or others), while maintaining the same user experience.

The goal is to provide a reliable, easy-to-use communication layer that works even when the internet does not.

## Workspace

This repository is a small pnpm workspace.

- `apps/client`: Preact client application and local demo surface
- `packages/avatar`: deterministic avatar generation from a shared SVG template
- `packages/display-name`: deterministic anonymous display-name generation from an id
- `packages/qr`: QR-related shared utilities

## Development

Install dependencies:

```bash
pnpm install
```

Run the workspace build:

```bash
pnpm build
```

Run the workspace test suite:

```bash
pnpm test
```
