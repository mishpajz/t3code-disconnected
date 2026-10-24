import type * as EffectAcpSchema from "effect-acp/compat";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { AcpRegistrySettings } from "../settings.ts";

// ACP agents keep no history format T3 can read, so T3 writes its own: one
// line per prompt turn, from the usage the agent returns with the turn.
const USAGE_DIRECTORY = "acp-usage";

export function acpUsageDirectory(path: Path.Path, stateDir: string): string {
  return path.join(stateDir, USAGE_DIRECTORY);
}

/** Usage readers run outside the provider host, so the server provides the directory. */
export class AcpUsageDirectory extends Context.Service<AcpUsageDirectory, string>()(
  "@t3tools/provider-acp-registry/server/usage/AcpUsageDirectory",
) {}

export const layerAcpUsageDirectory = Layer.effect(
  AcpUsageDirectory,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    return acpUsageDirectory(path, host.paths.stateDir);
  }),
);

const UsageLine = Schema.Struct({
  type: Schema.Literal("acp_usage"),
  timestamp: Schema.String,
  sessionId: Schema.String,
  agent: Schema.NonEmptyString,
  model: Schema.String,
  usage: Schema.Struct({
    inputTokens: Schema.optional(Schema.Unknown),
    outputTokens: Schema.optional(Schema.Unknown),
    thoughtTokens: Schema.optional(Schema.Unknown),
    cachedReadTokens: Schema.optional(Schema.Unknown),
    cachedWriteTokens: Schema.optional(Schema.Unknown),
  }),
});
type UsageLine = typeof UsageLine.Type;
const decodeUsageLine = Schema.decodeUnknownOption(UsageLine);
const encodeUsageLine = Schema.encodeEffect(Schema.fromJsonString(UsageLine));

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeUsageLine(parsed);
  if (Option.isNone(decoded)) return [];
  const line = decoded.value;
  const timestampMs = parseTimestampMs(line.timestamp);
  if (timestampMs === null) return [];
  const input = tokenCount(line.usage.inputTokens);
  const outputTokens = tokenCount(line.usage.outputTokens);
  const cachedInputTokens = tokenCount(line.usage.cachedReadTokens);
  const cacheCreationTokens = tokenCount(line.usage.cachedWriteTokens);
  const totals = {
    // ACP leaves open whether `inputTokens` includes cache reads and writes.
    // Agents seen so far include them (Grok reports input + output as the total),
    // so only an input smaller than its cache counters is read as disjoint.
    uncachedInputTokens:
      input >= cachedInputTokens + cacheCreationTokens
        ? input - cachedInputTokens - cacheCreationTokens
        : input,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(line.usage.thoughtTokens)),
  };
  if (totalTokens(totals) === 0) return [];
  const rateModel = line.model.trim();
  return [
    {
      provider: "acp",
      timestampMs,
      model: rateModel ? `${line.agent}/${rateModel}` : line.agent,
      ...(rateModel ? { rateModel } : {}),
      sessionId: line.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: null,
    },
  ];
}

export const acpUsageFormat: TranscriptUsageFormat<undefined> = {
  selectFields: {
    type: true,
    timestamp: true,
    sessionId: true,
    agent: true,
    model: true,
    usage: true,
  },
  usageMarkers: ['"acp_usage"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: parseRecord,
};

export const acpUsageReader: ProviderUsageReader<AcpRegistrySettings, AcpUsageDirectory> = {
  kind: "transcripts",
  provider: "acp",
  format: acpUsageFormat as TranscriptUsageFormat<unknown>,
  // Every instance writes into the same directory, which the scan reads once.
  directories: Effect.fn("acpUsageReader.directories")(function* () {
    return [{ dir: yield* AcpUsageDirectory }];
  }),
};

/**
 * Agents that wrap a provider whose own history Usage already reads. Recording
 * them here would count the same turns twice.
 */
export function readsHistoryElsewhere(settings: AcpRegistrySettings): boolean {
  if (settings.source === "registry") return settings.agentId === "claude-acp";
  const executable = settings.commandPath.split(/[\\/]/).pop() ?? "";
  return /^(claude-agent-acp|codex-acp|pi-acp|opencode)(\.exe|\.cmd)?$/i.test(executable);
}

function agentLabel(displayName: string | undefined, settings: AcpRegistrySettings) {
  const executable = settings.commandPath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd)$/i, "");
  return (
    displayName?.trim() ||
    (settings.source === "registry" ? settings.agentId : executable) ||
    "ACP agent"
  );
}

export type AcpUsageRecorder = (input: {
  readonly sessionId: string;
  readonly model: string;
  readonly usage: EffectAcpSchema.Usage;
}) => Effect.Effect<void>;

/** `undefined` for agents whose usage is read from their own history. */
export const makeAcpUsageRecorder = Effect.fn("makeAcpUsageRecorder")(function* (
  displayName: string | undefined,
  settings: AcpRegistrySettings,
): Effect.fn.Return<
  AcpUsageRecorder | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ProviderHost.ProviderHost
> {
  if (readsHistoryElsewhere(settings)) return undefined;
  const agent = agentLabel(displayName, settings);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const directory = acpUsageDirectory(path, host.paths.stateDir);
  return Effect.fn("AcpUsageRecorder.record")(
    function* (input: {
      readonly sessionId: string;
      readonly model: string;
      readonly usage: EffectAcpSchema.Usage;
    }) {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const line: UsageLine = {
        type: "acp_usage",
        timestamp,
        sessionId: input.sessionId,
        agent,
        model: input.model,
        usage: {
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          thoughtTokens: input.usage.thoughtTokens,
          cachedReadTokens: input.usage.cachedReadTokens,
          cachedWriteTokens: input.usage.cachedWriteTokens,
        },
      };
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      // One file per UTC day leaves older files untouched, so scans skip them by mtime.
      yield* fileSystem.writeFileString(
        path.join(directory, `${timestamp.slice(0, 10)}.jsonl`),
        `${yield* encodeUsageLine(line)}\n`,
        { flag: "a" },
      );
    },
    Effect.catch((error) => Effect.logWarning("Could not record ACP usage", error)),
  );
});
