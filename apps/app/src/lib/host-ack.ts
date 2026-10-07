// The host's one-time acknowledgement that they run their network and are responsible for what's posted on
// it (shown on the setup screens beside the button that starts or continues a network). LOAM's child-safety
// standards (loamnet.com/child-safety) rely on hosts being told this, so it's recorded once per install.
import * as SecureStore from 'expo-secure-store';

/** Bump when the host's responsibilities text changes in substance: every host sees it once more. */
export const HOST_ACK_VERSION = '1';

const HOST_ACK_ITEM = 'loam.hostAck';

/** Whether this install's host has acknowledged the current text. A failed read counts as "not yet". */
export async function loadHostAck(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(HOST_ACK_ITEM)) === HOST_ACK_VERSION;
  } catch {
    return false;
  }
}

/** Record the acknowledgement. Best effort: a failed write only means the note shows again next time. */
export async function saveHostAck(): Promise<void> {
  try {
    await SecureStore.setItemAsync(HOST_ACK_ITEM, HOST_ACK_VERSION);
  } catch {
    // Shown again on the next launch, which is harmless.
  }
}
