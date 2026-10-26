import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Logger from "effect/Logger";
import { TestClock } from "effect/testing";

import { makeCopilotClientPool, TEXT_SESSION_PREFIX } from "./clientPool.ts";
import type { CopilotSdkClient, SessionEvent } from "./sdk.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";

const event = (type: string, data: Record<string, unknown>) =>
  ({ id: type, type, data, timestamp: "", parentId: null }) as unknown as SessionEvent;

const launch = Effect.succeed({
  platform: "linux" as const,
  command: "copilot",
  args: [],
  env: {},
  cwd: "/workspace",
});
const titleInput = {
  cwd: "/workspace",
  message: "the login redirect is broken",
  modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-5-mini" },
};

/** A CLI whose first text session creation never answers; a kill with a reason exits it, as in the SDK wrapper. */
function wedgedClient(name: string, log: Array<string>, history = new Map<string, number>()) {
  let exit: (error: Error) => void = () => {};
  const exited = new Promise<Error>((resolve) => {
    exit = resolve;
  });
  let dead = false;
  let creations = 0;
  let creating: (sessionId: string) => void = () => {};
  const createCalled = new Promise<string>((resolve) => {
    creating = resolve;
  });
  let running: (sessionId: string) => void = () => {};
  const runCalled = new Promise<string>((resolve) => {
    running = resolve;
  });
  const alive = async () => {
    if (dead) throw new Error(`${name} is gone`);
  };
  const client = {
    createTextSession: async (options) => {
      history.set(options.sessionId, 0);
      creations += 1;
      if (creations === 1) {
        creating(options.sessionId);
        return new Promise(() => {});
      }
      return {
        sessionId: options.sessionId,
        run: () => {
          running(options.sessionId);
          return exited.then((error) => Promise.reject(error));
        },
        abort: alive,
        disconnect: alive,
      };
    },
    listSessions: async () =>
      [...history].map(([sessionId, modifiedAt]) => ({ sessionId, modifiedAt })),
    deleteSession: async (sessionId) => {
      await alive();
      log.push(`${name}.delete:${sessionId}`);
      history.delete(sessionId);
    },
    exited,
    stop: async () => {
      log.push(`${name}.stop`);
    },
    forceStop: async (reason) => {
      log.push(`${name}.forceStop`);
      dead = true;
      if (reason) exit(reason);
    },
  } as Pick<
    CopilotSdkClient,
    "createTextSession" | "listSessions" | "deleteSession" | "exited" | "stop" | "forceStop"
  > as CopilotSdkClient;
  return { client, createCalled, runCalled };
}

const invalidation = Effect.fnUntraced(function* (
  stopWaiting: (owner: Scope.Closeable) => Effect.Effect<void>,
) {
  const log: Array<string> = [];
  const first = wedgedClient("first", log);
  const second = wedgedClient("second", log);
  const clients = [first.client, second.client];
  const pool = yield* makeCopilotClientPool({
    binaryPath: "copilot",
    createClient: async () => clients.shift()!,
    resolveLaunch: launch,
  });
  // A chat session's lease, which keeps the CLI alive past the text request.
  assert.strictEqual(yield* pool.acquire, first.client);
  const owner = yield* Scope.make();
  const generation = yield* makeCopilotTextGeneration({ clientPool: pool, timeoutMs: 1_000 }).pipe(
    Scope.provide(owner),
  );
  const request = yield* generation.generateThreadTitle(titleInput).pipe(Effect.forkChild);
  yield* Effect.promise(() => first.createCalled);
  yield* stopWaiting(owner);
  assert.equal(
    (yield* Effect.promise(() => first.client.exited)).message,
    "a text generation session was never created",
  );
  assert.deepEqual(log, ["first.forceStop"]);
  assert.strictEqual(yield* pool.acquire, second.client);
  yield* Fiber.interrupt(request);
  yield* Scope.close(owner, Exit.void);
});

/** Collects log messages, and settles once one includes `awaited`. */
function capturedLogs(awaited: string) {
  const messages: Array<string> = [];
  let seen: () => void = () => {};
  const logged = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const logger = Logger.make(({ message }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    messages.push(text);
    if (text.includes(awaited)) seen();
  });
  return { messages, logged, layer: Logger.layer([logger], { mergeWithExisting: false }) };
}

describe("Copilot client pool", () => {
  it.effect("kills a CLI that never creates a text session once the request is long over", () =>
    invalidation(() =>
      Effect.gen(function* () {
        yield* TestClock.adjust(1_000);
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.adjust("60 seconds");
      }),
    ),
  );

  it.effect("kills a CLI still creating a text session when the instance stops", () =>
    invalidation((owner) => Scope.close(owner, Exit.void)),
  );

  it.effect("kills a CLI whose stop never settles, and the request still ends", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      let stopping: () => void = () => {};
      const stopCalled = new Promise<void>((resolve) => {
        stopping = resolve;
      });
      const client = {
        createTextSession: async (options) => ({
          sessionId: options.sessionId,
          run: async () => [
            event("assistant.message", { messageId: "m", content: '{"title":"Fix login"}' }),
          ],
          abort: async () => {},
          disconnect: async () => {},
        }),
        listSessions: async () => [],
        deleteSession: async () => {},
        exited: new Promise(() => {}),
        stop: () => {
          log.push("stop");
          stopping();
          return new Promise(() => {});
        },
        forceStop: async () => {
          log.push("forceStop");
        },
      } as Pick<
        CopilotSdkClient,
        "createTextSession" | "listSessions" | "deleteSession" | "exited" | "stop" | "forceStop"
      > as CopilotSdkClient;
      const pool = yield* makeCopilotClientPool({
        binaryPath: "copilot",
        createClient: async () => client,
        resolveLaunch: Effect.succeed({
          platform: "linux",
          command: "copilot",
          args: [],
          env: {},
          cwd: "/workspace",
        }),
      });
      const generation = yield* makeCopilotTextGeneration({ clientPool: pool });
      const request = yield* generation
        .generateThreadTitle({
          cwd: "/workspace",
          message: "the login redirect is broken",
          modelSelection: { instanceId: ProviderInstanceId.make("copilot"), model: "gpt-5-mini" },
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => stopCalled);
      // The pool lock is free while the stop hangs.
      assert.strictEqual(yield* pool.acquire, client);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(request);
      assert.equal(result.title, "Fix login");
      assert.deepEqual(log, ["stop", "forceStop"]);
    }),
  );
  it.effect("sweeps the text sessions a killed CLI left behind, and only those", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const history = new Map([
        ["7c1e0d2a-chat", 0],
        [`${TEXT_SESSION_PREFIX}owned`, 0],
      ]);
      const first = wedgedClient("first", log, history);
      const second = wedgedClient("second", log, history);
      const clients = [first.client, second.client];
      const pool = yield* makeCopilotClientPool({
        binaryPath: "copilot",
        createClient: async () => clients.shift()!,
        resolveLaunch: launch,
      });
      pool.textSessions.add(`${TEXT_SESSION_PREFIX}owned`);
      assert.strictEqual(yield* pool.acquire, first.client);
      const owner = yield* Scope.make();
      const wedging = yield* makeCopilotTextGeneration({ clientPool: pool, timeoutMs: 1_000 }).pipe(
        Scope.provide(owner),
      );
      const running = yield* makeCopilotTextGeneration({ clientPool: pool }).pipe(
        Scope.provide(owner),
      );
      // A's creation wedges the CLI; B is mid-run on it, so its own deletion fails once it is killed.
      const requestA = yield* wedging.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      const sessionA = yield* Effect.promise(() => first.createCalled);
      const requestB = yield* running.generateThreadTitle(titleInput).pipe(Effect.forkChild);
      const sessionB = yield* Effect.promise(() => first.runCalled);
      yield* TestClock.adjust(1_000);
      yield* TestClock.adjust("10 seconds");
      yield* TestClock.adjust("60 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(requestA)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(requestB)));
      yield* Scope.close(owner, Exit.void);
      assert.deepEqual(log, ["first.forceStop"]);
      assert.deepEqual([...pool.textSessions], [`${TEXT_SESSION_PREFIX}owned`]);
      yield* TestClock.adjust("30 minutes");
      history.set(`${TEXT_SESSION_PREFIX}other-process`, yield* Clock.currentTimeMillis);
      const swept = Promise.withResolvers<void>();
      const deleteSession = second.client.deleteSession;
      Object.assign(second.client, {
        deleteSession: async (sessionId: string) => {
          await deleteSession(sessionId);
          if (log.length === 3) swept.resolve();
        },
      });
      assert.strictEqual(yield* pool.acquire, second.client);
      yield* Effect.promise(() => swept.promise);
      assert.deepEqual(log, [
        "first.forceStop",
        `second.delete:${sessionA}`,
        `second.delete:${sessionB}`,
      ]);
      assert.deepEqual(
        [...history.keys()],
        ["7c1e0d2a-chat", `${TEXT_SESSION_PREFIX}owned`, `${TEXT_SESSION_PREFIX}other-process`],
      );
    }),
  );

  it.effect("hands out a new CLI before its sweep ends, and gives the sweep 30 seconds", () => {
    const logs = capturedLogs("sweep failed");
    return Effect.gen(function* () {
      const deleted: Array<string> = [];
      const client = {
        listSessions: async () => [
          { sessionId: `${TEXT_SESSION_PREFIX}a`, modifiedAt: 0 },
          { sessionId: `${TEXT_SESSION_PREFIX}b`, modifiedAt: 0 },
        ],
        deleteSession: (sessionId) => {
          deleted.push(sessionId);
          return new Promise(() => {});
        },
        exited: new Promise(() => {}),
      } as Pick<CopilotSdkClient, "listSessions" | "deleteSession" | "exited"> as CopilotSdkClient;
      const pool = yield* makeCopilotClientPool({
        binaryPath: "copilot",
        createClient: async () => client,
        resolveLaunch: launch,
      });
      yield* TestClock.adjust("31 minutes");
      assert.strictEqual(yield* pool.acquire, client);
      yield* TestClock.adjust("30 seconds");
      yield* Effect.promise(() => logs.logged);
      assert.deepEqual(deleted, [`${TEXT_SESSION_PREFIX}a`]);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("stops a CLI whose acquirer gave up while it started", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const first = wedgedClient("first", log);
      const second = wedgedClient("second", log);
      const starting = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const clients = [first.client, second.client];
      const pool = yield* makeCopilotClientPool({
        binaryPath: "copilot",
        createClient: (_launch, control) => {
          const client = clients.shift()!;
          if (client === second.client) return Promise.resolve(client);
          control?.signal?.addEventListener("abort", () => aborted.resolve());
          starting.resolve();
          // Starts only once its acquirer has given up.
          return aborted.promise.then(() => client);
        },
        resolveLaunch: launch,
      });
      const acquiring = yield* pool.acquire.pipe(Effect.forkChild);
      yield* Effect.promise(() => starting.promise);
      yield* Fiber.interrupt(acquiring);
      assert.deepEqual(log, ["first.stop"]);
      assert.strictEqual(yield* pool.acquire, second.client);
    }),
  );
});
