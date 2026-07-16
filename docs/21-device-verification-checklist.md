# 21 · On-device runtime verification checklist

The `feat/hardening-llm-sqlcipher` work (on-device LLM via llama.rn, at-rest SQLCipher encryption, the
kill-switch/wipe lifecycle) is code-complete and covered by the workspace test suite + CI, and it passed an
external review sign-off. Everything reachable in code and CI is verified there.

What CI and headless review CANNOT verify is behaviour that only exists on a physical arm64 Android device:
real native model loading, actual SQLCipher keying against the on-device driver, and the process-kill timing
of the wipe lifecycle. This checklist is that last mile. Run it on a real phone (the reference device is a
Galaxy S25 Ultra) against a clean release build.

If an item here exposes a native-runtime discrepancy, that is a genuine new finding. If they all pass, the
branch is done.

## Build and install

```bash
pnpm --filter app apk                 # → apps/app/loam-host.apk
adb install -r apps/app/loam-host.apk
```

- [ ] **Clean cold start.** Uninstall any prior copy first, then install and launch. The host boots, the join
  QR renders, and a second device can scan it and reach the server. This exercises the launcher module graph
  packaging (a clean install has no previously-extracted files to fall back on).

## 1. On-device LLM (llama.rn)

- [ ] **Download + activate + chat.** Download the default model (Gemma 3 1B), activate it, DM the bot. Reply
  text streams in token by token.
- [ ] **Switch models while idle.** Activate a second model. The old context is released and the new one
  loads; the next DM uses the new model. Watch `adb shell dumpsys meminfo <pkg>` across the switch: resident
  memory must not stack (no two multi-GB contexts at once).
- [ ] **Switch models mid-inference.** Start a long reply, then switch the active model before it finishes.
  No crash; the old reply finishes or is dropped; the next DM runs the new model.
- [ ] **Delete the active model.** The file is removed and the bot deactivates cleanly.
- [ ] **Delete an inactive model.** The active model is unaffected and keeps working.
- [ ] **Deactivate.** The bot disappears as a DM contact and its RAM is reclaimed.
- [ ] **Bounded load / no freeze.** Load a large model on a busy device so the load is slow. A stuck or
  very slow load surfaces a "recovering" / timed-out message and NEVER freezes other DMs or the UI.
- [ ] **Completion timeout.** If a generation wedges, it is stopped and reported after the bound rather than
  hanging the assistant forever; a later DM recovers.
- [ ] **Acceleration is honest.** The reported acceleration (GPU / reason-no-GPU) matches what the device
  actually did (OpenCL / Hexagon vs CPU) — the app reads this back from llama.rn, it does not assume it.

## 2. SQLCipher at rest (`security.dbEncryption`)

- [ ] **Persistent mode.** Set `persistent`, restart. Pull `.loam/loam.db` off the device and confirm it is
  NOT readable as plaintext SQLite (the header is encrypted).
- [ ] **Passphrase mode.** Set a passphrase, restart, unlock. Then change the passphrase: the DB rekeys in
  place and the old passphrase no longer opens it.
- [ ] **Ephemeral mode.** Trigger the kill switch / Emergency Reset: the key is rotated and the previous
  ciphertext is unreadable afterwards.
- [ ] **Wipe lifecycle under process kill.** On API 31+ / 34, start a wipe and force-kill the app mid-wipe
  (`adb shell am force-stop <pkg>`), then relaunch. The two-phase wipe resumes and completes: a fresh DB, the
  config (kill switch / panic token / profile / retention) survives, and there is no perpetual re-wipe loop.

## 3. Recovery paths

- [ ] **Locked / unreadable DB.** Put the store into a state it cannot open under the current mode (e.g. wrong
  mode after a manual change). The app shows the locked / recovery screen rather than crashing, and the
  "preserve old DB and start fresh" option round-trips (old data set aside recoverably, fresh DB opens).

## Reporting

Note the device model, Android version, and build SHA (`951f7a6` or later) with each result. A failure on any
item is a native-runtime finding worth escalating; a clean pass closes the branch's remaining work.
