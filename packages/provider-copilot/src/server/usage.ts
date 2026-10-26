import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import type { CopilotSettings } from "../settings.ts";

export interface CopilotTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/** Writes one Usage history line per model a turn used, subagents included. */
export type CopilotUsageRecorder = (input: {
  readonly sessionId: string;
  readonly model: string;
  readonly usage: CopilotTokenCounts;
}) => Effect.Effect<void>;

export const emptyCounts = (): CopilotTokenCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
});

/** Adds the counts of an assistant.usage payload, or of compaction's usage. */
export function addUsage(into: CopilotTokenCounts, data: Record<string, unknown>) {
  const count = (key: string) => {
    const value = data[key];
    return typeof value === "number" && value > 0 ? Math.round(value) : 0;
  };
  into.inputTokens += count("inputTokens");
  into.outputTokens += count("outputTokens");
  into.cachedInputTokens += count("cacheReadTokens");
  into.cacheCreationTokens += count("cacheWriteTokens");
  into.reasoningTokens += count("reasoningTokens");
}

export function addModelUsage(
  byModel: Map<string, CopilotTokenCounts>,
  model: unknown,
  data: Record<string, unknown>,
) {
  const key = (typeof model === "string" && model.trim()) || "unknown";
  const counts = byModel.get(key) ?? emptyCounts();
  addUsage(counts, data);
  byModel.set(key, counts);
}

/** session.compaction_complete carries compaction's usage; an assistant.usage for it would count twice. */
export const isCompactionUsage = (data: Record<string, unknown>) =>
  data.interactionType === "conversation-compaction";

/** What a finished compaction used, from its session.compaction_complete payload. */
export function compactionUsage(
  data: Record<string, unknown>,
): { readonly model: string; readonly usage: CopilotTokenCounts } | undefined {
  const used = data.compactionTokensUsed;
  if (typeof used !== "object" || used === null) return undefined;
  const fields = used as Record<string, unknown>;
  const usage = emptyCounts();
  addUsage(usage, fields);
  if (usage.inputTokens + usage.outputTokens === 0) return undefined;
  const model = [fields.model, data.model].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return { model: model ?? "unknown", usage };
}

// Copilot's own session files are not a stable usage history, so T3 writes one:
// a line per model at the end of each turn or text generation.
const USAGE_DIRECTORY = "copilot-usage";

/** Usage readers run outside the provider host, so the server provides the directory. */
export class CopilotUsageDirectory extends Context.Service<CopilotUsageDirectory, string>()(
  "@t3tools/provider-copilot/server/usage/CopilotUsageDirectory",
) {}

const usageDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  return path.join(host.paths.stateDir, USAGE_DIRECTORY);
});

export const layerCopilotUsageDirectory = Layer.effect(CopilotUsageDirectory, usageDirectory);

const UsageLine = Schema.Struct({
  type: Schema.Literal("copilot_usage"),
  timestamp: Schema.String,
  sessionId: Schema.String,
  model: Schema.String,
  usage: Schema.Struct({
    inputTokens: Schema.optional(Schema.Unknown),
    outputTokens: Schema.optional(Schema.Unknown),
    cacheReadTokens: Schema.optional(Schema.Unknown),
    cacheWriteTokens: Schema.optional(Schema.Unknown),
    reasoningTokens: Schema.optional(Schema.Unknown),
  }),
});
type UsageLine = typeof UsageLine.Type;
const decodeUsageLine = Schema.decodeUnknownOption(UsageLine);
const encodeUsageLine = Schema.encodeEffect(Schema.fromJsonString(UsageLine));

/** Copilot dots Claude versions (`claude-sonnet-4.5`) where rate tables dash them. */
function rateModelFor(model: string): string {
  return model.startsWith("claude-") ? model.replace(/(\d)\.(?=\d)/g, "$1-") : model;
}

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeUsageLine(parsed);
  if (Option.isNone(decoded)) return [];
  const line = decoded.value;
  const timestampMs = parseTimestampMs(line.timestamp);
  if (timestampMs === null) return [];
  const cachedInputTokens = tokenCount(line.usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(line.usage.cacheWriteTokens);
  const outputTokens = tokenCount(line.usage.outputTokens);
  const totals = {
    // Copilot's inputTokens include cache reads and writes.
    uncachedInputTokens: Math.max(
      0,
      tokenCount(line.usage.inputTokens) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(line.usage.reasoningTokens)),
  };
  if (totalTokens(totals) === 0) return [];
  const model = line.model.trim() || "unknown";
  const rateModel = rateModelFor(model);
  return [
    {
      provider: "copilot",
      timestampMs,
      model,
      ...(rateModel === model ? {} : { rateModel }),
      sessionId: line.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: null,
    },
  ];
}

export const copilotUsageFormat: TranscriptUsageFormat<undefined> = {
  selectFields: { type: true, timestamp: true, sessionId: true, model: true, usage: true },
  usageMarkers: ['"copilot_usage"'],
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

export const copilotUsageReader: ProviderUsageReader<CopilotSettings, CopilotUsageDirectory> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat as TranscriptUsageFormat<unknown>,
  // Every instance writes into the same directory, which the scan reads once.
  directories: Effect.fn("copilotUsageReader.directories")(function* () {
    return [{ dir: yield* CopilotUsageDirectory }];
  }),
};

export const makeCopilotUsageRecorder = Effect.fn("makeCopilotUsageRecorder")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* usageDirectory;
  const record: CopilotUsageRecorder = Effect.fn("CopilotUsageRecorder.record")(
    function* ({ sessionId, model, usage }) {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const line: UsageLine = {
        type: "copilot_usage",
        timestamp,
        sessionId,
        model,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cachedInputTokens,
          cacheWriteTokens: usage.cacheCreationTokens,
          reasoningTokens: usage.reasoningTokens,
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
    Effect.catch((error) => Effect.logWarning("Could not record Copilot usage", error)),
  );
  return record;
});
