/**
 * Public web pages the host UI links out to. Kept here as plain constants (not imported from
 * `@loam/schema`, whose zod graph must stay out of the RN bundle). The phone is often offline while
 * hosting, so these simply fail to load until it has internet — that's expected.
 */

/** LOAM's privacy policy (Play's user-data policy requires an in-app link to it). */
export const PRIVACY_POLICY_URL = 'https://loamnet.com/privacy';
