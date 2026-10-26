import type {
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { CopilotSettings } from "../settings.ts";
import {
  makeCopilotSdkClient,
  resolveCopilotLaunch,
  startCopilotClient,
  type CopilotModel,
  type CopilotSdkFactory,
} from "./sdk.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  // Copilot enforces prompts natively; full access is its own approve-all switch.
  supportedRuntimeModes: ["approval-required", "full-access"],
  supportsConversationRollback: true,
} as const;

export const SDK_PROBE_TIMEOUT_MS = 20_000;

const copilotProvider = (input: Parameters<typeof buildServerProvider>[0]) => {
  const provider = buildServerProvider(input);
  return { ...provider, supportsTextGeneration: provider.auth.status !== "unauthenticated" };
};

const REASONING_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// Copilot prices the long-context tier separately; other providers only list the tier.
const hasLongContextTier = (
  model: Pick<CopilotModel, "billing" | "supportedContextTiers">,
): boolean =>
  model.billing?.tokenPrices?.longContext !== undefined ||
  (model.supportedContextTiers ?? []).includes("long_context");

function copilotModelCapabilities(
  model?: Pick<
    CopilotModel,
    "supportedReasoningEfforts" | "defaultReasoningEffort" | "billing" | "supportedContextTiers"
  >,
): ModelCapabilities {
  const efforts = (model?.supportedReasoningEfforts ?? []).filter((effort) =>
    Object.hasOwn(REASONING_EFFORT_LABELS, effort),
  );
  const defaultValue =
    efforts.find((effort) => effort === model?.defaultReasoningEffort) ?? efforts[0];
  return createModelCapabilities({
    optionDescriptors: [
      ...(defaultValue === undefined
        ? []
        : [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              currentValue: defaultValue,
              options: efforts.map((id) => ({
                id,
                label: REASONING_EFFORT_LABELS[id]!,
                ...(id === defaultValue ? { isDefault: true } : {}),
              })),
            },
          ]),
      ...(model && hasLongContextTier(model)
        ? [
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select" as const,
              currentValue: "default",
              options: [
                { id: "default", label: "Default", isDefault: true },
                { id: "long_context", label: "Long context" },
              ],
            },
          ]
        : []),
    ],
  });
}

function copilotProviderModels(
  models: ReadonlyArray<CopilotModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model): ServerProviderModel[] => {
    const slug = model.id.trim();
    if (!slug || seen.has(slug) || model.policy?.state === "disabled") return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(slug === "auto" ? { isDefault: true } : {}),
        capabilities: copilotModelCapabilities(model),
      },
    ];
  });
}

export const makePendingCopilotProvider = Effect.fn("makePendingCopilotProvider")(function* (
  settings: CopilotSettings,
) {
  return copilotProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings([], settings.customModels, copilotModelCapabilities()),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking GitHub Copilot CLI availability..."
        : "GitHub Copilot is disabled in T3 Code settings.",
    },
  });
});

/** Reads sign-in and models from a session-less CLI, so no MCP servers or hooks start. */
export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  createClient: CopilotSdkFactory = makeCopilotSdkClient,
) {
  if (!settings.enabled) return yield* makePendingCopilotProvider(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (probe: ProviderProbeResult, models: ReadonlyArray<ServerProviderModel> = []) =>
    copilotProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(models, settings.customModels, copilotModelCapabilities()),
      probe,
    });
  const launchResult = yield* resolveCopilotLaunch({
    binaryPath: settings.binaryPath,
    launchArgs: settings.launchArgs,
    environment,
    cwd,
    hideGitHubTokens: settings.hideGitHubTokens,
  }).pipe(Effect.result);
  if (Result.isFailure(launchResult)) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: launchResult.failure.message,
    });
  }
  const launch = launchResult.success;
  if (launch === undefined) {
    return snapshot({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `GitHub Copilot CLI (\`${settings.binaryPath}\`) was not found. Install it, or set its binary path, on this T3 server host.`,
    });
  }
  const versionResult = yield* spawnAndCollect(
    launch.command,
    ChildProcess.make(launch.command, [...launch.args, "--version"], {
      env: launch.env,
      cwd,
    }),
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "GitHub Copilot CLI was not found on this T3 server host."
        : "Failed to run the GitHub Copilot CLI. Check its binary path and launch arguments.",
    });
  }
  const versionOutput = Option.getOrUndefined(versionResult.success);
  const version = versionOutput
    ? parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`)
    : null;
  if (versionOutput !== undefined && versionOutput.code !== 0) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI is installed but failed to run.",
    });
  }

  const probe = yield* Effect.acquireRelease(
    startCopilotClient(createClient, launch),
    (client) => Effect.promise(() => client.stop().catch(() => undefined)),
    { interruptible: true },
  ).pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise(async () => {
        const auth = await client.authStatus();
        return { auth, models: auth.isAuthenticated ? await client.listModels() : [] };
      }),
    ),
    Effect.scoped,
    Effect.timeoutOption(SDK_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(probe) || Option.isNone(probe.success)) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "GitHub Copilot did not answer over its SDK connection. Check that the binary path and launch arguments start the Copilot CLI.",
    });
  }
  const { auth, models } = probe.success.value;
  if (!auth.isAuthenticated) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Sign in with `copilot login` on this T3 server host, then refresh.",
    });
  }
  const login = auth.login?.trim();
  const providerAuth: ServerProviderAuth = {
    status: "authenticated",
    ...(auth.authType ? { type: auth.authType } : {}),
    ...(login ? { label: login } : {}),
  };
  const providerModels = copilotProviderModels(models);
  return snapshot(
    {
      installed: true,
      version,
      auth: providerAuth,
      ...(providerModels.length > 0
        ? { status: "ready" }
        : {
            status: "warning",
            message: "GitHub Copilot returned no models for this account.",
          }),
    },
    providerModels,
  );
});
