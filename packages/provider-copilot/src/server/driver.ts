// Copilot keeps its sessions and sign-in in the user's ~/.copilot, so instances share them.
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CopilotSettings } from "../settings.ts";
import { makeCopilotAdapterV2 } from "./adapter.ts";
import { makeCopilotClientPool } from "./clientPool.ts";
import { makeCopilotSdkClient, resolveCopilotLaunch } from "./sdk.ts";
import { copilotProviderSkills } from "./skills.ts";
import {
  checkCopilotProviderStatus,
  makePendingCopilotProvider,
  SDK_PROBE_TIMEOUT_MS,
} from "./status.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";
import {
  copilotUsageReader,
  makeCopilotUsageRecorder,
  type CopilotUsageDirectory,
} from "./usage.ts";

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

export type CopilotDriverEnv =
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ProviderEventLoggers.ProviderEventLoggers
  | FileSystem.FileSystem
  | Path.Path;

export const CopilotDriver: ProviderDriver<
  CopilotSettings,
  CopilotDriverEnv,
  CopilotUsageDirectory
> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "GitHub Copilot", supportsMultipleInstances: true },
  configSchema: CopilotSettings,
  defaultConfig: () => decodeCopilotSettings({}),
  usage: copilotUsageReader,
  create: Effect.fn("CopilotDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies CopilotSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    // No installer provably owns a wrapper-launched CLI, so updates stay manual.
    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        makePendingCopilotProvider(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: checkCopilotProviderStatus(
        effectiveConfig,
        processEnvironment,
        host.paths.cwd,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build GitHub Copilot snapshot.",
            cause,
          }),
      ),
    );
    const clientPool = yield* makeCopilotClientPool({
      binaryPath: effectiveConfig.binaryPath,
      createClient: makeCopilotSdkClient,
      resolveLaunch: resolveCopilotLaunch({
        binaryPath: effectiveConfig.binaryPath,
        launchArgs: effectiveConfig.launchArgs,
        environment: processEnvironment,
        cwd: host.paths.cwd,
        hideGitHubTokens: effectiveConfig.hideGitHubTokens,
      }),
    });
    // Session-less, like the status probe, so no MCP servers or hooks start.
    const discoverSkills = (cwd: string) =>
      Effect.acquireUseRelease(
        clientPool.acquire,
        (client) => Effect.tryPromise(() => client.discoverSkills(cwd)),
        clientPool.release,
      ).pipe(
        Effect.timeout(SDK_PROBE_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not read GitHub Copilot skills.",
              cause,
            }),
        ),
      );
    const recordUsage = yield* makeCopilotUsageRecorder();
    const orchestrationAdapter = yield* makeCopilotAdapterV2({
      instanceId,
      settings: effectiveConfig,
      environment: processEnvironment,
      clientPool,
      recordUsage,
      modelCatalog: snapshot.getSnapshot.pipe(Effect.map((current) => current.models)),
      ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
    });
    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        enabled
          ? Effect.all([snapshot.getSnapshot, discoverSkills(cwd)]).pipe(
              Effect.map(([current, skills]) => ({
                ...current,
                skills: copilotProviderSkills(skills),
              })),
            )
          : snapshot.getSnapshot,
      orchestrationAdapter,
      textGeneration: yield* makeCopilotTextGeneration({ clientPool, recordUsage }),
    } satisfies ProviderInstance;
  }),
};
