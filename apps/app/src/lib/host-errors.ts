// What the operator reads when the embedded host (the launcher, nodejs-project-template/main.js) refuses a
// request. The launcher answers in English for its own log, plus an `errorCode` for every failure it knows;
// this maps the code to the host catalog. An answer with no code (an unexpected exception) keeps its raw
// text as the detail, since there is nothing to translate it from. Pure, so it is unit-tested.
import { t, type AppCatalogKey } from './i18n';

const HOST_ERROR_KEYS: Readonly<Record<string, AppCatalogKey>> = {
  host_no_response: 'hostError.noResponse',
  host_not_running: 'hostError.notRunning',
  host_status: 'hostError.status',
  unknown_request: 'hostError.unknownRequest',
  invalid_model_config: 'hostError.invalidModelConfig',
  model_config_save_failed: 'hostError.modelConfigSaveFailed',
  mode_hint_save_failed: 'hostError.modeHintSaveFailed',
  start_fresh_in_progress: 'hostError.startFreshInProgress',
  start_fresh_indeterminate: 'hostError.startFreshIndeterminate',
  start_fresh_not_scheduled: 'hostError.startFreshNotScheduled',
  unlock_in_progress: 'hostError.unlockInProgress',
};

/** Every launcher error code mapped here, for the test that checks main.js sends no other. */
export const HOST_ERROR_CODES: readonly string[] = Object.keys(HOST_ERROR_KEYS);

/**
 * The operator-facing text for a failed launcher round trip: the catalog text for a known `errorCode`
 * (`status` fills `hostError.status`), else the raw `error` detail, else "unknown error".
 */
export function hostErrorText(reply: { errorCode?: unknown; error?: unknown; status?: unknown } | undefined): string {
  const code = reply?.errorCode;
  const key = typeof code === 'string' ? HOST_ERROR_KEYS[code] : undefined;
  if (key) {
    return t(key, { status: typeof reply?.status === 'number' ? reply.status : '?' });
  }
  return typeof reply?.error === 'string' && reply.error.length > 0 ? reply.error : t('common.unknownError');
}

/** The text for a round trip the launcher never answered. */
export function hostNoResponseText(): string {
  return t('hostError.noResponse');
}
