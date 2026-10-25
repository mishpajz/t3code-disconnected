/**
 * Feature gates for the t3code-disconnected fork (see DISCONNECTED.md).
 *
 * These are constants rather than settings or environment variables so that a
 * build cannot be switched back to calling home at runtime. Fork patches check
 * them at the entry points of each subsystem instead of deleting upstream code,
 * which keeps rebases on upstream cheap.
 *
 * Every gate is ANDed into upstream's own switch for the feature (build config,
 * env vars, settings, stored secrets), so the fork gate always wins: if upstream
 * turns a feature on, it still stays off while DISCONNECTED is true.
 */
import { DISCONNECTED } from "@t3tools/contracts/disconnected";

/** T3 Connect: cloud relay, account linking, managed endpoints, cloudflared and Clerk sign-in. */
export const T3_CONNECT_ENABLED = !DISCONNECTED;

/** Tailscale integration: running the `tailscale` command and Tailscale Serve. */
export const TAILSCALE_ENABLED = !DISCONNECTED;

/** Product analytics sent to T3's PostHog ingest endpoint. */
export const ANALYTICS_ENABLED = !DISCONNECTED;

/** Desktop auto-update checks and downloads from the release feed. */
export const DESKTOP_AUTO_UPDATE_ENABLED = !DISCONNECTED;

/** Web UI polling the npm registry for a newer `t3` release. */
export const NPM_RELEASE_CHECK_ENABLED = !DISCONNECTED;

/** CLI self-update and runtime downloads from npm/GitHub (`t3 update`, npm launcher, SSH bootstrap). */
export const RUNTIME_DOWNLOADS_ENABLED = !DISCONNECTED;

/** Fetching LiteLLM model pricing from GitHub; bundled rates are used instead. */
export const REMOTE_PRICING_ENABLED = !DISCONNECTED;

/** ACP registry index, package downloads and CDN icons; local ACP commands still work. */
export const ACP_REGISTRY_ENABLED = !DISCONNECTED;

/** Third-party favicon service and remote images for links in chat. */
export const REMOTE_FAVICONS_ENABLED = !DISCONNECTED;

/** Bitbucket Cloud integration; it checks sign-in against api.bitbucket.org even with no token. */
export const BITBUCKET_ENABLED = !DISCONNECTED;

/** Theme marketplace backed by open-vsx.org. */
export const THEME_MARKETPLACE_ENABLED = !DISCONNECTED;

/** Copying links that open a prompt on T3's hosted app (app.t3.codes). */
export const PROMPT_LINKS_ENABLED = !DISCONNECTED;

/**
 * Packaged desktop builds use their own app ID, install folder and profile folder. With
 * upstream's, Windows and package managers see the fork as upstream T3 Code, upstream's
 * installer or updater replaces it, and a running upstream app holds its single-instance lock.
 */
export const DESKTOP_OWN_APP_IDENTITY = DISCONNECTED;

export const DISCONNECTED_DESKTOP_APP_ID = "com.t3tools.t3code.disconnected";
export const DISCONNECTED_DESKTOP_PRODUCT_NAME = "T3 Code Disconnected";
/** Install folder name (from the packaged app's package.json) and profile folder name. */
export const DISCONNECTED_DESKTOP_PACKAGE_NAME = "t3code-disconnected";
