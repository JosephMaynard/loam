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
- `apps/server`: backend server application and API surface
- `packages/avatar`: deterministic avatar generation from a shared SVG template
- `packages/display-name`: deterministic anonymous display-name generation from an id
- `packages/qr`: QR-related shared utilities
- `packages/schema`: shared data and schema definitions

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

## Optional local configuration

LOAM runs without a config file. Optional identity and LLM features can be enabled by creating
`.loam/config.json`, or by setting `LOAM_CONFIG_FILE` to another JSON file path.

See `config.example.json` for a complete example. With Ollama running locally, the important
settings are:

```json
{
  "identity": {
    "allowUserDisplayNameEdit": true,
    "allowUserAvatarEdit": true,
    "allowUserAvatarUpload": true,
    "allowAdminUserEdit": true
  },
  "llm": {
    "ollama": {
      "enabled": true,
      "baseUrl": "http://localhost:11434",
      "model": "gemma4",
      "botId": "llm.ollama.gemma4",
      "botDisplayName": "Gemma"
    }
  }
}
```

When enabled, the Ollama bot appears as a direct-message contact. Sending it a DM creates a
streaming assistant response in the same LOAM conversation. If the config is absent or
`llm.ollama.enabled` is `false`, no LLM user or LLM routes are active.

When `allowUserAvatarUpload` is enabled, users can choose an image in the settings screen,
crop it locally in the browser, and upload only the final 256 x 256 PNG/WebP avatar. Original
image files are never sent to the server.
