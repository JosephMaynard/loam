/**
 * How people reach the LOAM project. Its own module so Settings can show them without pulling the
 * privacy policy's text (lib/privacy-policy.ts, loaded only with the `/privacy` screen) into the main
 * bundle.
 */

/** Where people report problems: LOAM has no telemetry, so these are the only way we hear of one. */
export const ISSUE_TRACKER = "github.com/MagicZebraLtd/loam/issues";
/** LOAM's website, where people report problems (its "Report a problem" section) and find ways to support it. */
export const WEBSITE = "loamnet.com";
export const CONTACT_EMAIL = "opensource@magiczebra.co.uk";
