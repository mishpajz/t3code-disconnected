// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// The Copilot SDK is Promise-based and owns its CLI process, as production's client does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import {
  deleteCopilotSessions,
  makeCopilotSdkClient,
  resolveCopilotLaunch,
} from "@t3tools/provider-copilot/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  checkpointWorkspace,
  makeCheckpointWorkspace,
} from "@t3tools/provider-testing/replayWorkspace";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import {
  COPILOT_PROVIDER_KIND,
  COPILOT_SDK_REPLAY_PROTOCOL,
  CopilotOrchestratorReplayHarness,
  layer as copilotReplayLayer,
  makeRecordingCreateClient,
  type CopilotReplayFrame,
} from "../src/orchestration-v2/Adapters/CopilotAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const CLOCK_TICK = Duration.millis(20);
// Opaque provider blobs and quota snapshots the adapter never reads.
const DROPPED_KEYS = new Set([
  "encryptedContent",
  "reasoningOpaque",
  "apiCallId",
  "providerCallId",
  "serviceRequestId",
  "quotaSnapshots",
  "copilotUsage",
  "toolTelemetry",
  "responsesReasoning",
]);

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const variant = fixture?.providers.find((provider) => provider.driver === COPILOT_PROVIDER_KIND);
if (fixture === undefined || variant === undefined) {
  const names = ORCHESTRATOR_REPLAY_FIXTURES.filter((entry) =>
    entry.providers.some((provider) => provider.driver === COPILOT_PROVIDER_KIND),
  ).map((entry) => entry.name);
  throw new Error(`Pass --scenario with a fixture that registers Copilot: ${names.join(", ")}`);
}

const home = process.env.HOME ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntries(
  entries: ReadonlyArray<ProviderReplayEntry>,
  workspaces: ReadonlyArray<string>,
): ReadonlyArray<ProviderReplayEntry> {
  const normalizeString = (value: string): string => {
    let next = value;
    for (const workspace of workspaces) next = next.replaceAll(workspace, "<workspace>");
    return home.length > 1 ? next.replaceAll(home, "~") : next;
  };
  const normalizeValue = (value: unknown): unknown =>
    typeof value === "string"
      ? normalizeString(value)
      : Array.isArray(value)
        ? value.map(normalizeValue)
        : isRecord(value)
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => !DROPPED_KEYS.has(key))
                .map(([key, entry]) => [key, normalizeValue(entry)]),
            )
          : value;
  return entries.map((entry) => {
    if (entry.type === "runtime_exit") return entry;
    const frame = normalizeValue(entry.frame);
    if (!isRecord(frame)) return { ...entry, frame };
    // Launch arguments and T3's instructions vary by machine and release; replay accepts any.
    if (frame.type === "client.start") return { ...entry, frame: { ...frame, args: "<any>" } };
    if (isRecord(frame.options))
      return {
        ...entry,
        frame: { ...frame, options: { ...frame.options, instructions: "<any>" } },
      };
    return { ...entry, frame };
  });
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

// Follow wall time so live Copilot turns finish.
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const fixtureInput = fixture.buildInput();
  const workspace = yield* Effect.promise(() =>
    makeCheckpointWorkspace(`copilot-sdk-record-${fixture.name}`, fixtureInput.workspaceFiles),
  );
  yield* Effect.addFinalizer(() =>
    fs.remove(workspace, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  const canonicalWorkspace = NodeFS.realpathSync(workspace);
  const launch = yield* resolveCopilotLaunch({
    binaryPath: process.env.T3_COPILOT_BIN ?? "copilot",
    launchArgs: process.env.T3_COPILOT_ARGS ?? "",
    environment: process.env,
    cwd: workspace,
  });
  if (launch === undefined) throw new Error("Set T3_COPILOT_BIN to the Copilot CLI.");
  const version = NodeChildProcess.execFileSync(launch.command, [...launch.args, "--version"], {
    encoding: "utf8",
    env: process.env,
  }).match(/\d+\.\d+\.\d+/)?.[0];

  const entries: Array<ProviderReplayEntry> = [];
  const sessionIds = new Set<string>();
  const recordFrame = (type: "expect_outbound" | "emit_inbound", frame: CopilotReplayFrame) => {
    if (
      frame.type === "return" &&
      isRecord(frame.value) &&
      typeof frame.value.sessionId === "string"
    )
      sessionIds.add(frame.value.sessionId);
    entries.push({ type, label: frame.type, frame });
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => deleteCopilotSessions(launch, [...sessionIds])).pipe(
      Effect.tap(() => Console.log(`Deleted ${sessionIds.size} recorded Copilot session(s)`)),
    ),
  );
  const placeholder: ProviderReplayTranscript = {
    provider: COPILOT_PROVIDER_KIND,
    protocol: COPILOT_SDK_REPLAY_PROTOCOL,
    version: version ?? "unknown",
    scenario: fixture.name,
    entries: [],
  };
  const materializeInput = materializeFixtureInput({
    scenario: fixture.name,
    fixtureInput,
    driver: variant.driver,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const continuationOptions =
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {};

  yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeInput;
    yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/copilot:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
      },
      {
        driver: CopilotOrchestratorReplayHarness.driver,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          copilotReplayLayer({
            createClient: makeRecordingCreateClient(makeCopilotSdkClient, recordFrame),
            environment: process.env,
            launchCommand: launch.command,
            launchArgs: launch.args,
          }),
      },
      continuationOptions,
    );
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  const transcript = {
    ...placeholder,
    metadata: { generatedBy: "live-copilot-recorder", model: variant.modelSelection.model },
    entries: normalizeEntries(
      decodeJson(encodeJson(entries)) as ReadonlyArray<ProviderReplayEntry>,
      [canonicalWorkspace, workspace],
    ),
  } satisfies ProviderReplayTranscript;

  yield* Effect.gen(function* () {
    const replayWorkspace = yield* checkpointWorkspace(fixture.name, fixtureInput.workspaceFiles);
    const materialized = yield* materializeInput;
    const replayResult = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/copilot:verify`,
        transcript: yield* CopilotOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(transcript, replayWorkspace),
        ),
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: replayWorkspace },
      },
      CopilotOrchestratorReplayHarness,
      continuationOptions,
    );
    variant.assertOutput(replayResult, transcript);
  }).pipe(
    Effect.scoped,
    provideDeterministicTestRuntime,
    // Keep the transcript for inspection; the exit code still reports the failure.
    Effect.catchCause((cause) =>
      Console.error("Replay verification failed", Cause.pretty(cause)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  );

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
  yield* Console.log(
    `Wrote ${transcript.entries.length} Copilot SDK replay entries to ${outputPath}`,
  );
});

await Effect.runPromise(record.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
