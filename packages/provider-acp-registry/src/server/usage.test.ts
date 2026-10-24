import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import {
  acpUsageDirectory,
  acpUsageFormat,
  makeAcpUsageRecorder,
  readsHistoryElsewhere,
} from "./usage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const parse = (usage: Record<string, number>, model = "claude-sonnet-4.5") =>
  acpUsageFormat.parseLine(
    JSON.stringify({
      type: "acp_usage",
      timestamp: "2026-10-25T10:00:00.000Z",
      sessionId: "session-1",
      agent: "Copilot",
      model,
      usage,
    }),
    undefined,
  );

describe("acpUsageFormat", () => {
  it("splits cache reads and writes out of an inclusive input count", () => {
    const [record] = parse({
      inputTokens: 1_000,
      outputTokens: 50,
      thoughtTokens: 20,
      cachedReadTokens: 600,
      cachedWriteTokens: 100,
    });
    expect(record).toMatchObject({
      provider: "acp",
      timestampMs: Date.parse("2026-10-25T10:00:00.000Z"),
      sessionId: "session-1",
      model: "Copilot/claude-sonnet-4.5",
      rateModel: "claude-sonnet-4.5",
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

  it("keeps an input count smaller than its cache counters as disjoint", () => {
    const [record] = parse({ inputTokens: 40, outputTokens: 10, cachedReadTokens: 500 });
    expect(record?.totals).toMatchObject({ uncachedInputTokens: 40, cachedInputTokens: 500 });
  });

  it("attributes turns without a model to the agent and skips empty turns", () => {
    expect(parse({ inputTokens: 10, outputTokens: 1 }, "")[0]).toMatchObject({ model: "Copilot" });
    expect(parse({ inputTokens: 0, outputTokens: 0 })).toEqual([]);
  });
});

describe("makeAcpUsageRecorder", () => {
  it.effect("appends turns that the usage format reads back", () =>
    Effect.gen(function* () {
      const record = yield* makeAcpUsageRecorder(
        "Copilot",
        decodeSettings({ source: "local", commandPath: "agency", commandArgs: ["copilot"] }),
      );
      if (record === undefined) throw new Error("Copilot usage should be recorded");
      const usage = { totalTokens: 130, inputTokens: 100, outputTokens: 30, cachedReadTokens: 40 };
      yield* record({ sessionId: "session-1", model: "gpt-5", usage });
      yield* record({ sessionId: "session-1", model: "gpt-5", usage });

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const directory = acpUsageDirectory(path, host.paths.stateDir);
      const [file] = yield* fileSystem.readDirectory(directory);
      const lines = (yield* fileSystem.readFileString(path.join(directory, file!)))
        .split("\n")
        .filter(Boolean);
      const records = lines.flatMap((line) => acpUsageFormat.parseLine(line, undefined));
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        model: "Copilot/gpt-5",
        totals: { uncachedInputTokens: 60, cachedInputTokens: 40, outputTokens: 30 },
      });
    }).pipe(Effect.provide(TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

describe("readsHistoryElsewhere", () => {
  it("skips agents whose provider history Usage already reads", () => {
    expect(readsHistoryElsewhere(decodeSettings({ agentId: "claude-acp" }))).toBe(true);
    expect(
      readsHistoryElsewhere(
        decodeSettings({ source: "local", commandPath: "/usr/local/bin/codex-acp" }),
      ),
    ).toBe(true);
    expect(
      readsHistoryElsewhere(
        decodeSettings({ source: "local", commandPath: "agency", commandArgs: ["copilot"] }),
      ),
    ).toBe(false);
  });
});
