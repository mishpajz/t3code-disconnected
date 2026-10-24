import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayTracingConfig,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// t3code-disconnected: T3 Connect is disabled (DISCONNECTED.md).
describe("T3 Connect gate", () => {
  it("keeps T3 Connect and Clerk off even when a build provides their config", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
    vi.stubGlobal("window", {
      location: new URL("file:///app/index.html"),
      desktopBridge: { getRelayTelemetryEnabled: () => true },
    });

    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveRelayTracingConfig()).toBeNull();
    expect(resolveCloudPublicConfig()).toMatchObject({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
    });
  });
});
