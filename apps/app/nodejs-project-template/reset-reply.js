'use strict';

// The launcher's answer to RN's `loam-emergency-reset` (main.js), built from what the server's in-process
// reset (`global.__loamEmergencyReset`, embedded-main.ts → the kill switch) resolved with. Extracted from
// main.js so it can be tested on its own (src/lib/reset-reply.test.ts): main.js pulls in rn-bridge at import
// time. RN reads the answer in src/lib/emergency-reset.ts.

/**
 * The `ok` answer for a reset that ran.
 *
 * - `complete`: every artifact was erased and verified gone. False leaves the node locked (503).
 * - `keyClear`: the device-key clear was handed to RN (`loam-wipe-restart`); RN closes the app once it is
 *   verified.
 * - `journaled`: the wipe journal reached disk, so the next boot finishes an incomplete wipe before serving.
 *   False only when the server says it could not write it: a restart then does NOT finish the wipe, and the
 *   reset has to be run again. A result without the field (a server from before it existed) counts as
 *   journaled, which is what the host screen promised then.
 *
 * @param {unknown} result the kill-switch result: `{ complete, keyClearRequested?, journaled? }`.
 * @returns {{ ok: true, complete: boolean, keyClear: boolean, journaled: boolean }}
 */
function resetReply(result) {
  var value = result && typeof result === 'object' ? result : {};
  return {
    ok: true,
    complete: value.complete === true,
    keyClear: value.keyClearRequested === true,
    journaled: value.journaled !== false,
  };
}

module.exports = { resetReply: resetReply };
