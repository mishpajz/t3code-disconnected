// @effect-diagnostics nodeBuiltinImport:off
// t3code-disconnected: tests for ACP Registry text generation (DISCONNECTED.md).
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { makeAcpRegistryTextGeneration } from "./textGeneration.ts";

const fixturePath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "testing/textGenerationAgent.fixture.ts",
);
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const isTextGenerationError = Schema.is(TextGenerationError);

type TextGeneration = Effect.Success<ReturnType<typeof makeAcpRegistryTextGeneration>>;

const generate = Effect.fn("generate")(function* (
  mode: "reply" | "branch" | "permission" | "tool" | "hang" | "empty" | "auth",
  options: {
    readonly run?: (
      textGeneration: TextGeneration,
      input: { readonly cwd: string; readonly modelSelection: ModelSelection },
    ) => Effect.Effect<unknown, TextGenerationError>;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly command?: string;
    readonly resolve?: Effect.Effect<never, AcpRegistrySupport.AcpRegistryError>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-acp-text-generation-" });
  const logPath = path.join(cwd, "agent.log");
  const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.die("unused inspect"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
    resolve: (_settings, resolveCwd, environment) =>
      options.resolve ??
      Effect.succeed({
        distribution: "local" as const,
        spawn: {
          command: options.command ?? process.execPath,
          args: [fixturePath],
          cwd: resolveCwd,
          env: { ...environment, T3_TEXT_AGENT_MODE: mode, T3_TEXT_AGENT_LOG: logPath },
          shell: false as const,
        },
      }),
  });
  const textGeneration = yield* makeAcpRegistryTextGeneration({
    settings: decodeSettings({ source: "local", commandPath: "text-agent" }),
    environment: process.env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));
  const run =
    options.run ??
    ((generation, input) =>
      generation.generateThreadTitle({ ...input, message: "Fix the login redirect loop" }));
  const result = yield* Effect.exit(
    run(textGeneration, {
      cwd,
      modelSelection: {
        instanceId: ProviderInstanceId.make("acpRegistry_text"),
        model: options.model ?? "small",
      },
    }),
  );
  const log = (yield* fs.exists(logPath))
    ? (yield* fs.readFileString(logPath)).trim().split("\n")
    : [];
  return { result, log };
});

const failureDetail = (exit: Exit.Exit<unknown, TextGenerationError>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  const error = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined;
  const failure = error?._tag === "Fail" ? error.error : undefined;
  expect(isTextGenerationError(failure)).toBe(true);
  return failure?.detail ?? "";
};

describe("ACP Registry text generation", () => {
  it.live("generates a title with the selected model and stops the agent", () =>
    Effect.gen(function* () {
      const { result, log } = yield* generate("reply");
      expect(result).toEqual(Exit.succeed({ title: "Title from small" }));
      expect(log).toEqual(["model:small", "prompt", "exit"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("generates a branch name with the configured prefix", () =>
    Effect.gen(function* () {
      const { result, log } = yield* generate("branch", {
        run: (generation, input) =>
          generation.generateBranchName({
            ...input,
            message: "Fix the login redirect loop",
            naming: { mode: "static", prefix: "t3code", instructions: "" },
          }),
      });
      expect(result).toEqual(Exit.succeed({ branch: "t3code/fix-login-small" }));
      expect(log).toEqual(["model:small", "prompt", "exit"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails when the selected model is not offered", () =>
    Effect.gen(function* () {
      const { result, log } = yield* generate("reply", { model: "missing" });
      expect(failureDetail(result)).toContain("does not offer model 'missing'");
      expect(log).toEqual(["exit"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects permission requests and fails the generation", () =>
    Effect.gen(function* () {
      const { result, log } = yield* generate("permission");
      expect(failureDetail(result)).toContain("asked for tool permission");
      expect(log).toContain("permission:reject");
      expect(log.at(-1)).toBe("exit");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops the agent as soon as it starts tool work", () =>
    Effect.gen(function* () {
      const { result, log } = yield* generate("tool");
      expect(failureDetail(result)).toContain("started tool work");
      expect(log.at(-1)).toBe("exit");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The timeout can fire before the agent finishes starting, so process cleanup is asserted
  // by the tool and permission tests, which interrupt an in-flight prompt the same way.
  it.live("times out", () =>
    Effect.gen(function* () {
      const { result } = yield* generate("hang", { timeoutMs: 1_000 });
      expect(failureDetail(result)).toContain("did not finish text generation within 1 seconds");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("treats empty output as an error", () =>
    Effect.gen(function* () {
      const { result } = yield* generate("empty");
      expect(failureDetail(result)).toContain("returned empty text generation output");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports when the agent needs sign-in", () =>
    Effect.gen(function* () {
      const { result } = yield* generate("auth");
      expect(failureDetail(result)).toContain("needs you to sign in");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a command that is not on PATH", () =>
    Effect.gen(function* () {
      const { result, log } = yield* generate("reply", {
        resolve: Effect.fail(
          new AcpRegistrySupport.AcpRegistryError({
            reason: "runner_unavailable",
            detail: "Local ACP executable is not available on this environment's PATH.",
          }),
        ),
      });
      expect(failureDetail(result)).toContain("not available on this environment's PATH");
      expect(log).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a command that cannot be started", () =>
    Effect.gen(function* () {
      const { result } = yield* generate("reply", {
        command: "/nonexistent/t3-text-agent",
      });
      expect(failureDetail(result)).toContain(
        "Could not start the ACP command '/nonexistent/t3-text-agent'",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
