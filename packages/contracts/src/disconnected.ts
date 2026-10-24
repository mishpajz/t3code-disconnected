/**
 * Master switch for the t3code-disconnected fork (see DISCONNECTED.md).
 *
 * It lives in contracts, the package everything else depends on, so settings
 * defaults can follow it too. The per-feature gates derived from it are in
 * `@t3tools/shared/disconnected`.
 */

/** While true, the fork's gates turn off every feature that talks to T3 or third-party hosts. */
export const DISCONNECTED: boolean = true;

/**
 * Default for `enableProviderUpdateChecks` (model list download and provider version checks).
 * Users can still turn the checks on in Settings.
 */
export const PROVIDER_UPDATE_CHECKS_DEFAULT = !DISCONNECTED;
