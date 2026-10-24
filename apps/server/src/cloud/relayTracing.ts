import { T3_CONNECT_ENABLED } from "@t3tools/shared/disconnected";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

// t3code-disconnected: T3 Connect is disabled (DISCONNECTED.md), so relay traces are never exported.
const relayClientTracingConfig = T3_CONNECT_ENABLED ? resolveRelayClientTracingConfig() : null;

export const layerHeadlessRelayClient = RelayTracing.layer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  runtime: "node",
  client: "headless-cli",
});

export const layerServerRelayBroker = RelayTracing.layer(relayClientTracingConfig, {
  serviceName: "t3code-server",
  runtime: "node",
  client: "environment-server",
  component: "relay-broker",
});
