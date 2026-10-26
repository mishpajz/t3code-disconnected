import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  CopilotUsageDirectory,
  copilotUsageFormat,
  emptyCounts,
  layerCopilotUsageDirectory,
  makeCopilotUsageRecorder,
} from "./usage.ts";

const parse = (usage: Record<string, number>, model = "claude-sonnet-4.5") =>
  copilotUsageFormat.parseLine(
    JSON.stringify({
      type: "copilot_usage",
      timestamp: "2026-10-25T10:00:00.000Z",
      sessionId: "session-1",
      model,
      usage,
    }),
    undefined,
  );

describe("copilotUsageFormat", () => {
  it("records under GitHub Copilot with cache counts split out of the input", () => {
    const [record] = parse({
      inputTokens: 1_000,
      outputTokens: 50,
      reasoningTokens: 20,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
    });
    expect(record).toMatchObject({
      provider: "copilot",
      timestampMs: Date.parse("2026-10-25T10:00:00.000Z"),
      sessionId: "session-1",
      model: "claude-sonnet-4.5",
      rateModel: "claude-sonnet-4-5",
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 300,
        cachedInputTokens: 600,
        cacheCreationTokens: 100,
        outputTokens: 50,
        reasoningTokens: 20,
      },
    });
  });

  it("prices other models under their own name and skips empty lines", () => {
    const [record] = parse({ inputTokens: 10, outputTokens: 1 }, "gpt-5.2");
    expect(record?.model).toBe("gpt-5.2");
    expect(record?.rateModel).toBeUndefined();
    expect(parse({ inputTokens: 10, outputTokens: 1 }, "")[0]?.model).toBe("unknown");
    expect(parse({ inputTokens: 0, outputTokens: 0 })).toEqual([]);
  });
});

describe("makeCopilotUsageRecorder", () => {
  it.effect("appends lines that the usage reader's directory and format read back", () =>
    Effect.gen(function* () {
      const record = yield* makeCopilotUsageRecorder();
      const usage = {
        ...emptyCounts(),
        inputTokens: 100,
        outputTokens: 30,
        cachedInputTokens: 40,
      };
      yield* record({ sessionId: "session-1", model: "gpt-5", usage });
      yield* record({ sessionId: "session-1", model: "claude-haiku-4.5", usage });

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* CopilotUsageDirectory;
      const [file] = yield* fileSystem.readDirectory(directory);
      const lines = (yield* fileSystem.readFileString(path.join(directory, file!)))
        .split("\n")
        .filter(Boolean);
      const records = lines.flatMap((line) => copilotUsageFormat.parseLine(line, undefined));
      expect(records.map((entry) => [entry.provider, entry.model])).toEqual([
        ["copilot", "gpt-5"],
        ["copilot", "claude-haiku-4.5"],
      ]);
      expect(records[0]?.totals).toMatchObject({
        uncachedInputTokens: 60,
        cachedInputTokens: 40,
        outputTokens: 30,
      });
    }).pipe(
      Effect.provide(
        layerCopilotUsageDirectory.pipe(
          Layer.provideMerge(TestProviderHost.layer()),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
