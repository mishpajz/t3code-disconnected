import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { TEXT_SESSION_PREFIX, type CopilotClientPool } from "./clientPool.ts";
import type { CopilotSdkClient, CopilotTextSessionOptions, SessionEvent } from "./sdk.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";

const event = (type: string, data: Record<string, unknown>) =>
  ({ id: type, type, data, timestamp: "", parentId: null }) as unknown as SessionEvent;

function fakePool(
  behavior: {
    readonly reply?: ReadonlyArray<SessionEvent>;
    /** Holds session creation until it settles. */
    readonly creation?: Promise<void>;
    /** Replaces the reply; a run that never settles never sees an idle. */
    readonly run?: () => Promise<ReadonlyArray<SessionEvent>>;
    readonly abort?: () => Promise<void>;
    readonly deleteSession?: () => Promise<void>;
  } = {},
) {
  const opened: Array<CopilotTextSessionOptions> = [];
  const log: Array<string> = [];
  let creating: () => void = () => {};
  const createCalled = new Promise<void>((resolve) => {
    creating = resolve;
  });
  let running: () => void = () => {};
  const runCalled = new Promise<void>((resolve) => {
    running = resolve;
  });
  let releasing: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releasing = resolve;
  });
  const client = {
    createTextSession: async (options) => {
      opened.push(options);
      creating();
      await behavior.creation;
      log.push("created");
      return {
        sessionId: options.sessionId,
        run: async () => {
          log.push("run");
          running();
          return behavior.run ? behavior.run() : (behavior.reply ?? []);
        },
        abort: async () => {
          log.push("abort");
          await behavior.abort?.();
        },
        disconnect: async () => {
          log.push("disconnect");
        },
      };
    },
    deleteSession: async (sessionId) => {
      log.push(sessionId === opened.at(-1)?.sessionId ? "delete" : `delete:${sessionId}`);
      await behavior.deleteSession?.();
    },
  } as Pick<CopilotSdkClient, "createTextSession" | "deleteSession"> as CopilotSdkClient;
  const pool: CopilotClientPool = {
    acquire: Effect.sync(() => {
      log.push("acquire");
      return client;
    }),
    release: () =>
      Effect.sync(() => {
        log.push("release");
        releasing();
      }),
    invalidate: () =>
      Effect.sync(() => {
        log.push("invalidate");
      }),
    textSessions: new Set(),
  };
  return { pool, opened, log, createCalled, runCalled, released };
}

const modelSelection = { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-5-mini" };
const titleInput = { cwd: "/workspace", message: "the login redirect is broken", modelSelection };
const CLEANUP = ["abort", "disconnect", "delete", "release"];

describe("Copilot text generation", () => {
  it.effect("titles a thread from a tool-less session, records usage, and deletes it", () =>
    Effect.gen(function* () {
      const fake = fakePool({
        reply: [
          event("assistant.usage", { model: "gpt-5-mini", inputTokens: 70, outputTokens: 9 }),
          event("assistant.usage", {
            model: "gpt-5-mini",
            inputTokens: 500,
            outputTokens: 50,
            interactionType: "conversation-compaction",
          }),
          event("session.compaction_complete", {
            success: true,
            compactionTokensUsed: { model: "gpt-5-mini", inputTokens: 500, outputTokens: 50 },
          }),
          event("assistant.message", { messageId: "m", content: '{"title":"Fix login redirect"}' }),
          event("session.idle", {}),
        ],
      });
      const usage: Array<string> = [];
      const generation = yield* makeCopilotTextGeneration({
        clientPool: fake.pool,
        recordUsage: ({ model, usage: counts }) =>
          Effect.sync(() => usage.push(`${model}:${counts.inputTokens}:${counts.outputTokens}`)),
      });
      const result = yield* generation.generateThreadTitle(titleInput);
      assert.equal(result.title, "Fix login redirect");
      assert.deepEqual(fake.opened[0]?.builtInTools, []);
      assert.equal(fake.opened[0]?.model, "gpt-5-mini");
      assert.deepEqual(usage, ["gpt-5-mini:500:50", "gpt-5-mini:70:9"]);
      assert.deepEqual(fake.log, ["acquire", "created", "run", ...CLEANUP]);
      assert.isTrue(fake.opened[0]?.sessionId.startsWith(TEXT_SESSION_PREFIX));
      assert.equal(fake.pool.textSessions.size, 0);
    }),
  );

  it.effect("rejects a reply that used a tool, and offers review guides only read-only tools", () =>
    Effect.gen(function* () {
      const fake = fakePool({
        reply: [
          event("tool.execution_start", { toolCallId: "t", toolName: "view" }),
          event("assistant.message", { messageId: "m", content: '{"title":"x"}' }),
        ],
      });
      const generation = yield* makeCopilotTextGeneration({ clientPool: fake.pool });
      const titled = yield* generation
        .generateThreadTitle({ cwd: "/workspace", message: "hi", modelSelection })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(titled));
      yield* generation
        .generateReviewGuide({
          cwd: "/workspace",
          number: 1,
          title: "PR",
          description: "",
          baseBranch: "main",
          baseCommit: "abc",
          settledReview: "",
          modelSelection,
        })
        .pipe(Effect.exit);
      assert.deepEqual(fake.opened[1]?.builtInTools, ["view", "glob", "grep", "rg"]);
    }),
  );

  it.effect("deletes a session that opens after the request timed out without prompting it", () =>
    Effect.gen(function* () {
      let open: () => void = () => {};
      const fake = fakePool({
        creation: new Promise((resolve) => {
          open = resolve;
        }),
      });
      const generation = yield* makeCopilotTextGeneration({
        clientPool: fake.pool,
        timeoutMs: 1_000,
      });
      const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.createCalled);
      yield* TestClock.adjust(1_000);
      open();
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(fake.log, ["acquire", "created", ...CLEANUP]);
    }),
  );

  it.effect("kills the CLI when a creation outlasts its request by the grace period", () =>
    Effect.gen(function* () {
      let open: () => void = () => {};
      const fake = fakePool({
        creation: new Promise((resolve) => {
          open = resolve;
        }),
      });
      const generation = yield* makeCopilotTextGeneration({
        clientPool: fake.pool,
        timeoutMs: 1_000,
      });
      const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.createCalled);
      yield* TestClock.adjust(1_000);
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      yield* TestClock.adjust("49 seconds");
      assert.deepEqual(fake.log, ["acquire"]);
      assert.deepEqual([...fake.pool.textSessions], [fake.opened[0]?.sessionId]);
      yield* TestClock.adjust("1 second");
      yield* Effect.promise(() => fake.released);
      assert.deepEqual(fake.log, ["acquire", "invalidate", "release"]);
      assert.equal(fake.pool.textSessions.size, 0);
      open();
      yield* Effect.promise(() => fake.createCalled);
      assert.deepEqual(fake.log, ["acquire", "invalidate", "release", "created"]);
    }),
  );

  it.effect("never runs a session created after the server stopped waiting for it", () =>
    Effect.gen(function* () {
      let open: () => void = () => {};
      const fake = fakePool({
        creation: new Promise((resolve) => {
          open = resolve;
        }),
      });
      const owner = yield* Scope.make();
      const generation = yield* makeCopilotTextGeneration({ clientPool: fake.pool }).pipe(
        Scope.provide(owner),
      );
      const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.createCalled);
      yield* Scope.close(owner, Exit.void);
      assert.deepEqual(fake.log, ["acquire", "invalidate", "release"]);
      open();
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.deepEqual(fake.log, ["acquire", "invalidate", "release", "created"]);
    }),
  );

  it.effect("disposes of an open session when the server stops before the request ends", () =>
    Effect.gen(function* () {
      const fake = fakePool({ run: () => new Promise(() => {}) });
      const owner = yield* Scope.make();
      const generation = yield* makeCopilotTextGeneration({ clientPool: fake.pool }).pipe(
        Scope.provide(owner),
      );
      const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.runCalled);
      yield* Scope.close(owner, Exit.void);
      assert.deepEqual(fake.log, ["acquire", "created", "run", ...CLEANUP]);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(fake.log, ["acquire", "created", "run", ...CLEANUP]);
    }),
  );

  it.effect(
    "kills the CLI of a session still being created when the server stops mid-request",
    () =>
      Effect.gen(function* () {
        const fake = fakePool({ creation: new Promise(() => {}) });
        const owner = yield* Scope.make();
        const generation = yield* makeCopilotTextGeneration({ clientPool: fake.pool }).pipe(
          Scope.provide(owner),
        );
        const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
        yield* Effect.promise(() => fake.createCalled);
        yield* Scope.close(owner, Exit.void);
        assert.deepEqual(fake.log, ["acquire", "invalidate", "release"]);
        yield* Fiber.interrupt(fiber);
        assert.deepEqual(fake.log, ["acquire", "invalidate", "release"]);
      }),
  );

  it.effect("opens no session once the server has stopped", () =>
    Effect.gen(function* () {
      const fake = fakePool();
      const owner = yield* Scope.make();
      const generation = yield* makeCopilotTextGeneration({ clientPool: fake.pool }).pipe(
        Scope.provide(owner),
      );
      yield* Scope.close(owner, Exit.void);
      assert.isTrue(
        Exit.isFailure(yield* generation.generateThreadTitle(titleInput).pipe(Effect.exit)),
      );
      assert.deepEqual(fake.opened, []);
      assert.deepEqual(fake.log, ["acquire", "release"]);
    }),
  );

  it.effect("kills the CLI when the server stops during a creation's grace period", () =>
    Effect.gen(function* () {
      const fake = fakePool({ creation: new Promise(() => {}) });
      const owner = yield* Scope.make();
      const generation = yield* makeCopilotTextGeneration({
        clientPool: fake.pool,
        timeoutMs: 1_000,
      }).pipe(Scope.provide(owner));
      const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.createCalled);
      yield* TestClock.adjust(1_000);
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      yield* Scope.close(owner, Exit.void);
      assert.deepEqual(fake.log, ["acquire", "invalidate", "release"]);
    }),
  );

  it.effect("ends a run Copilot never idles, even when it rejects the abort", () =>
    Effect.gen(function* () {
      const fake = fakePool({
        run: () => new Promise(() => {}),
        abort: () => Promise.reject(new Error("abort refused")),
        deleteSession: () => Promise.reject(new Error("delete refused")),
      });
      const generation = yield* makeCopilotTextGeneration({
        clientPool: fake.pool,
        timeoutMs: 1_000,
      });
      const fiber = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.runCalled);
      yield* TestClock.adjust(1_000);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(fake.log, ["acquire", "created", "run", ...CLEANUP]);
    }),
  );
});
