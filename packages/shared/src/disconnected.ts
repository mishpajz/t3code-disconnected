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
