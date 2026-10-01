/**
 * The first-run setup's decisions, kept free of React Native and storage so they're testable: what each
 * preset means (the node settings it writes and how the phone stores the data), and the small record the
 * app keeps about the network it set up.
 *
 * Presets are named security profiles (docs/09) plus the identity and presence flags a profile doesn't
 * cover; the profile itself forces the join policy, message lifetime, remote kill switch and transport
 * encryption. "custom" writes only the name and language and leaves every other setting to the admin
 * screens.
 */
import type { DbEncryptionMode } from './db-encryption';
import type { AppLocale } from './i18n';

export type SetupPreset = 'private' | 'community' | 'custom';
export const SETUP_PRESETS: readonly SetupPreset[] = ['private', 'community', 'custom'];

/** Where people connect: this phone's Wi-Fi network, its own hotspot, or another LOAM network as a node. */
export type SetupConnection = 'wifi' | 'hotspot' | 'join';

/** What the app remembers about the network it set up (SecureStore `loam.setup`). */
export type SetupRecord = {
  preset: SetupPreset;
  nodeName: string;
  connection: SetupConnection;
};

export const SETUP_RECORD_ITEM = 'loam.setup';
/** The network name used when the person leaves it blank. */
export const DEFAULT_NODE_NAME = 'LOAM';
const MAX_NODE_NAME = 80;

/** The node name to use: trimmed, the default when blank, at most 80 characters (the server's limit). */
export function cleanNodeName(name: string): string {
  const trimmed = name.trim().slice(0, MAX_NODE_NAME).trim();
  return trimmed || DEFAULT_NODE_NAME;
}

/**
 * The initial `config.json` (a `LoamConfigUpdate`) for a new network. Written by the launcher before the
 * server's first boot on an empty data folder, so it's the node's starting configuration; admins can
 * change any of it later.
 */
export function presetConfig(preset: SetupPreset, nodeName: string, locale: AppLocale): Record<string, unknown> {
  const node = { name: cleanNodeName(nodeName), locale };
  if (preset === 'private') {
    return {
      node,
      security: { profile: 'hardened' },
      identity: { allowUserDisplayNameEdit: false, allowUserAvatarEdit: false, allowUserAvatarUpload: false },
      features: { enablePresence: false },
    };
  }
  if (preset === 'community') {
    return {
      node,
      security: { profile: 'standard' },
      identity: { allowUserDisplayNameEdit: true, allowUserAvatarEdit: true, allowUserAvatarUpload: true },
      features: { enablePresence: true },
    };
  }
  return { node };
}

/**
 * How the phone stores a new network's data: Private keeps it only as long as the app runs (an ephemeral
 * key, so nothing is readable once the app stops); Community encrypts it with a key kept in the phone's
 * keystore, so it survives restarts. Custom leaves the current choice (the Encryption menu) alone.
 */
export function presetDbMode(preset: SetupPreset): DbEncryptionMode | undefined {
  return preset === 'private' ? 'ephemeral' : preset === 'community' ? 'persistent' : undefined;
}

/** Parse the stored record; anything malformed counts as none. */
export function parseSetupRecord(value: string | null | undefined): SetupRecord | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const raw = JSON.parse(value) as Partial<SetupRecord>;
    if (
      (SETUP_PRESETS as readonly string[]).includes(raw.preset ?? '') &&
      typeof raw.nodeName === 'string' &&
      (raw.connection === 'wifi' || raw.connection === 'hotspot' || raw.connection === 'join')
    ) {
      return { preset: raw.preset as SetupPreset, nodeName: cleanNodeName(raw.nodeName), connection: raw.connection };
    }
  } catch {
    // Not JSON: treat as no record.
  }
  return undefined;
}

/**
 * Whether there's a previous network worth offering to continue: a database exists, and it wasn't kept
 * under a key that only lived in memory (an ephemeral network can never be reopened; the launcher erases
 * its leftovers at the next boot).
 */
export function hasContinuableNetwork(files: { database: boolean; ephemeralMarker: boolean }): boolean {
  return files.database && !files.ephemeralMarker;
}
