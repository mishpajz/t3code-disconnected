import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ModelSelection,
  type OrchestrationV2RuntimeRequest,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { CopilotSettings } from "../settings.ts";
import {
  copilotRewindBoundary,
  copilotTodoSteps,
  makeCopilotAdapterV2,
  type CopilotAdapterV2Options,
} from "./adapter.ts";
import type {
  CopilotPermissionRequest,
  CopilotPersistedEvent,
  CopilotRewindResult,
  CopilotSdkClient,
  CopilotSdkSession,
  CopilotSendInput,
  CopilotSessionHandlers,
  ExitPlanModeRequest,
  SessionEvent,
} from "./sdk.ts";

const COPILOT = ProviderDriverKind.make("copilot");

const turn = (ordinal: number, nativeId: string | null): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`turn-${ordinal}`),
  providerThreadId: ProviderThreadId.make("thread"),
  nodeId: NodeId.make(`node-${ordinal}`),
  runAttemptId: null,
  nativeTurnRef: nativeId === null ? null : { driver: COPILOT, nativeId, strength: "strong" },
  ordinal,
  status: "completed",
  startedAt: null,
  completedAt: null,
});

describe("Copilot rollback boundary", () => {
  it("rewinds to the first rolled-back turn, which must have a boundary", () => {
    const turns = [turn(3, "event-3"), turn(1, "event-1"), turn(2, null)];
    expect(copilotRewindBoundary({ targetOrdinal: 0, providerThreadTurns: turns })).toBe("event-1");
    expect(copilotRewindBoundary({ targetOrdinal: 2, providerThreadTurns: turns })).toBe("event-3");
    expect(copilotRewindBoundary({ targetOrdinal: 3, providerThreadTurns: turns })).toBeUndefined();
    // Turn 2's prompt may sit before event-3, so rewinding there would keep it.
    expect(copilotRewindBoundary({ targetOrdinal: 1, providerThreadTurns: turns })).toBeNull();
    expect(
      copilotRewindBoundary({
        targetOrdinal: 1,
        providerThreadTurns: turns,
        unsentTurnIds: new Set(["turn-2"]),
      }),
    ).toBe("event-3");
  });
});

describe("Copilot todo rows", () => {
  it("maps Copilot's SQL todo statuses and drops untitled rows", () => {
    expect(
      copilotTodoSteps(
        [
          { id: "a", title: "Read", status: "done" },
          { id: "b", title: "Write", status: "in_progress" },
          { id: "c", description: "Verify", status: "pending" },
          { id: "d", status: "pending" },
        ],
        "turn",
      ),
    ).toEqual([
      { id: "turn:a", text: "Read", status: "completed" },
      { id: "turn:b", text: "Write", status: "running" },
      { id: "turn:c", text: "Verify", status: "pending" },
    ]);
  });
});

const INSTANCE_ID = ProviderInstanceId.make("copilot");
const THREAD_ID = ThreadId.make("thread-copilot-test");
const SESSION_ID = ProviderSessionId.make("session-copilot-test");
const settings = Schema.decodeSync(CopilotSettings)({ enabled: true });
const modelSelection = { instanceId: INSTANCE_ID, model: "auto" };
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const policy = (runtimeMode: RuntimeMode = "approval-required") =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
  });

const shellRequest = (toolCallId?: string) =>
  ({
    kind: "shell",
    ...(toolCallId ? { toolCallId } : {}),
    fullCommandText: "npm test",
    intention: "Run tests",
    commands: [{ identifier: "npm test", readOnly: false }],
    canOfferSessionApproval: false,
    hasWriteFileRedirection: false,
    possiblePaths: [],
    possibleUrls: [],
  }) as CopilotPermissionRequest;

function makeFakeCopilot() {
  const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = [];
  const record = (method: string, ...args: ReadonlyArray<unknown>) => {
    calls.push({ method, args });
  };
  let handlers: CopilotSessionHandlers | undefined;
  let aborted: () => void = () => {};
  const abortCalled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let eventCount = 0;
  let sendCount = 0;
  let exit: (error: Error) => void = () => {};
  /** Each session's persisted journal, by session id. */
  const journals = new Map<string, ReadonlyArray<CopilotPersistedEvent>>();
  const behavior: {
    resumeSession?: (sessionId: string) => Promise<void>;
    send?: (input: CopilotSendInput) => Promise<string>;
    abort?: () => Promise<void>;
    isProcessing?: () => Promise<boolean>;
    setApproveAll?: (enabled: boolean) => Promise<void>;
  } = {};
  const session = (sessionId: string): CopilotSdkSession => ({
    sessionId,
    send: async (input) => {
      record("send", input);
      sendCount += 1;
      return behavior.send ? behavior.send(input) : `prompt-${sendCount}`;
    },
    abort: async () => {
      record("abort");
      aborted();
      await behavior.abort?.();
    },
    isProcessing: async () => {
      record("isProcessing");
      return (await behavior.isProcessing?.()) ?? false;
    },
    setModel: async (model, effort, contextTier) => record("setModel", model, effort, contextTier),
    setApproveAll: async (enabled) => {
      record("setApproveAll", enabled);
      await behavior.setApproveAll?.(enabled);
    },
    rewind: async (eventId) => {
      record("rewind", eventId);
      return { outcome: "success" } as CopilotRewindResult;
    },
    readTodos: async () => [],
    disconnect: async () => record("disconnect"),
  });
  const client: CopilotSdkClient = {
    authStatus: async () => ({ isAuthenticated: true }),
    listModels: async () => [],
    createSession: async (options, next) => {
      record("createSession", options);
      handlers = next;
      return session("native-1");
    },
    resumeSession: async (sessionId, _options, next) => {
      record("resumeSession", sessionId);
      await behavior.resumeSession?.(sessionId);
      handlers = next;
      return session(sessionId);
    },
    forkSession: async (sessionId, toEventId) => {
      record("forkSession", sessionId, toEventId);
      return "native-fork";
    },
    persistedEventsAfter: async (sessionId, eventId) => {
      record("persistedEventsAfter", sessionId, eventId);
      const journal = journals.get(sessionId) ?? [];
      const index = journal.findIndex((event) => event.id === eventId);
      return index < 0 ? undefined : journal.slice(index + 1);
    },
    listSessions: async () => [],
    deleteSession: async (sessionId) => record("deleteSession", sessionId),
    createTextSession: async () => {
      throw new Error("the adapter does not generate text");
    },
    exited: new Promise((resolve) => {
      exit = resolve;
    }),
    stop: async () => record("stop"),
    forceStop: async () => record("forceStop"),
  };
  const emitTo = (
    target: CopilotSessionHandlers,
    type: string,
    data: Record<string, unknown> = {},
    agentId?: string,
    parentId: string | null = null,
  ) =>
    target.onEvent({
      id: `event-${++eventCount}`,
      type,
      data,
      timestamp: "2026-10-26T00:00:00.000Z",
      parentId,
      ...(agentId ? { agentId } : {}),
    } as unknown as SessionEvent);
  const emit = (type: string, data: Record<string, unknown> = {}) => emitTo(handlers!, type, data);
  const emitAgent = (agentId: string, type: string, data: Record<string, unknown> = {}) =>
    emitTo(handlers!, type, data, agentId);
  return {
    client,
    emitAgent,
    /** Idle is never persisted; its parent is the last event that was. */
    emitIdle: (parentId: string, data: Record<string, unknown> = {}) =>
      emitTo(handlers!, "session.idle", data, undefined, parentId),
    setJournal: (sessionId: string, events: ReadonlyArray<CopilotPersistedEvent>) => {
      journals.set(sessionId, events);
    },
    behavior,
    /** The CLI dies, or the pool killed it with a reason. */
    exit: (error: Error) => exit(error),
    emit,
    emitTo,
    abortCalled,
    handlers: () => handlers!,
    calls: (method: string) => calls.filter((call) => call.method === method),
    methods: () => calls.map((call) => call.method),
  };
}
type FakeCopilot = ReturnType<typeof makeFakeCopilot>;

const openHarness = Effect.fnUntraced(function* (
  fake: FakeCopilot,
  runtimeMode: RuntimeMode = "approval-required",
  existingProviderThread?: OrchestrationV2ProviderThread,
  adapterOptions: Partial<CopilotAdapterV2Options> = {},
  selection: ModelSelection = modelSelection,
) {
  const adapter = yield* makeCopilotAdapterV2({
    instanceId: INSTANCE_ID,
    settings,
    environment: {},
    ...adapterOptions,
    createClient: async () => fake.client,
    resolveLaunch: (cwd) =>
      Effect.succeed({ platform: "linux", command: "copilot", args: [], env: {}, cwd }),
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: selection,
    runtimePolicy: policy(runtimeMode),
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.ignore,
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: selection,
    runtimePolicy: policy(runtimeMode),
    ...(existingProviderThread ? { existingProviderThread } : {}),
  });
  /** Consumes events up to and including the first of `type`. */
  const takeThrough = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(
    type: T,
    predicate: (
      event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>,
    ) => boolean = () => true,
  ) {
    const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    while (true) {
      const event = yield* Queue.take(events);
      seen.push(event);
      if (
        event.type === type &&
        predicate(event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>)
      )
        return {
          event: event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>,
          seen,
        };
    }
  });
  return { runtime, providerThread, takeThrough };
});
type Harness = Effect.Success<ReturnType<typeof openHarness>>;

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  ordinal = 1,
  runtimeMode: RuntimeMode = "approval-required",
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: THREAD_ID,
    projectId: ProjectId.make("project-copilot-test"),
    title: "Copilot test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: INSTANCE_ID,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId: THREAD_ID,
    runId: RunId.make(`run-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-${ordinal}`),
    rootNodeId: NodeId.make(`root-${ordinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${ordinal}`),
      text: "Hello Copilot",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy: policy(runtimeMode),
  };
});

/** Starts a turn and waits until Copilot has shown its prompt. */
const startTurn = Effect.fnUntraced(function* (harness: Harness, fake: FakeCopilot, ordinal = 1) {
  yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, ordinal));
  fake.emit("user.message", {
    content: "Hello Copilot",
    messageId: `prompt-${fake.calls("send").length}`,
  });
  const { event } = yield* harness.takeThrough(
    "provider_turn.updated",
    (update) => update.providerTurn.nativeTurnRef !== null,
  );
  return event.providerTurn;
});

const assistantTexts = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => [
  ...new Set(
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? [event.turnItem.text]
        : [],
    ),
  ),
];

describe("CopilotAdapterV2 approve-all", () => {
  it.effect("states approve-all on create and on resume, matching the runtime mode", () =>
    Effect.gen(function* () {
      const supervised = makeFakeCopilot();
      yield* openHarness(supervised, "approval-required");
      assert.deepEqual(supervised.methods(), ["createSession", "setApproveAll"]);
      assert.deepEqual(supervised.calls("setApproveAll")[0]?.args, [false]);

      const fullAccess = makeFakeCopilot();
      yield* openHarness(fullAccess, "full-access");
      assert.deepEqual(fullAccess.calls("setApproveAll")[0]?.args, [true]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the session when its CLI exits, as when the pool kills a wedged one", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      fake.exit(new Error("a text generation session was never created"));
      const { event } = yield* harness.takeThrough(
        "provider_session.updated",
        (update) => update.providerSession.status === "error",
      );
      assert.equal(event.providerSession.lastError, "a text generation session was never created");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes a stored Copilot session on a fresh client", () =>
    Effect.gen(function* () {
      const first = makeFakeCopilot();
      const stored = yield* Effect.scoped(
        Effect.map(openHarness(first), (harness) => harness.providerThread),
      );
      assert.include(first.methods(), "stop");

      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake, "approval-required", {
        ...stored,
        nativeThreadRef: { ...stored.nativeThreadRef!, nativeId: "native-stored" },
      });
      assert.deepEqual(fake.methods(), ["resumeSession", "setApproveAll", "isProcessing"]);
      assert.deepEqual(fake.calls("resumeSession")[0]?.args, ["native-stored"]);
      assert.deepEqual(fake.calls("setApproveAll")[0]?.args, [false]);
      assert.equal(harness.providerThread.nativeThreadRef?.nativeId, "native-stored");
      yield* startTurn(harness, fake);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a mode change Copilot refuses and retries it on the next turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      fake.behavior.setApproveAll = async () => {
        throw new Error("Copilot refused to turn approve-all on");
      };
      const refused = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread, 1, "full-access"))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.lengthOf(fake.calls("send"), 0);

      delete fake.behavior.setApproveAll;
      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, 2, "full-access"));
      assert.deepEqual(
        fake.calls("setApproveAll").map((call) => call.args[0]),
        [false, true, true],
      );
      assert.lengthOf(fake.calls("send"), 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("CopilotAdapterV2 context tier", () => {
  it.effect("states the selected tier for tiered models and leaves it out for others", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const tiered = { instanceId: INSTANCE_ID, model: "claude-opus-5.5" };
      const harness = yield* openHarness(
        fake,
        "approval-required",
        undefined,
        {
          modelCatalog: Effect.succeed([
            { slug: "auto", name: "Auto", isCustom: false, capabilities: null },
            {
              slug: tiered.model,
              name: "Claude Opus 5.5",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "contextWindow",
                    label: "Context Window",
                    type: "select",
                    options: [
                      { id: "default", label: "Default", isDefault: true },
                      { id: "long_context", label: "Long context" },
                    ],
                  },
                ],
              },
            },
          ]),
        },
        { ...tiered, options: [{ id: "contextWindow", value: "long_context" }] },
      );
      const created = fake.calls("createSession")[0]?.args[0] as { contextTier?: string };
      assert.equal(created.contextTier, "long_context");

      const runTurn = Effect.fnUntraced(function* (ordinal: number, selection: ModelSelection) {
        yield* harness.runtime.startTurn({
          ...(yield* turnInput(harness.providerThread, ordinal)),
          modelSelection: selection,
        });
        fake.emit("session.idle");
        yield* harness.takeThrough("turn.terminal");
      });
      // Unset on a tiered model means its default tier, not whatever Copilot last used.
      yield* runTurn(1, tiered);
      yield* runTurn(2, modelSelection);
      assert.deepEqual(
        fake.calls("setModel").map((call) => call.args),
        [
          [tiered.model, undefined, "default"],
          ["auto", undefined, undefined],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("CopilotAdapterV2 approvals", () => {
  it.effect("tracks each permission request by its own request id", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* startTurn(harness, fake);
      const handlers = fake.handlers();
      const first = handlers.onPermissionRequest(shellRequest("tool-1"), "request-1");
      const second = handlers.onPermissionRequest(shellRequest("tool-1"), "request-2");
      const third = handlers.onPermissionRequest(shellRequest(), "request-3");
      const opened: Array<OrchestrationV2RuntimeRequest> = [];
      while (opened.length < 3) {
        const { event } = yield* harness.takeThrough(
          "runtime_request.updated",
          (update) => update.runtimeRequest.status === "pending",
        );
        opened.push(event.runtimeRequest);
      }
      assert.deepEqual(
        opened.map((request) => request.nativeRequestRef?.nativeId),
        ["request-1", "request-2", "request-3"],
      );
      assert.lengthOf(new Set(opened.map((request) => request.id)), 3);

      fake.emit("permission.completed", {
        requestId: "request-2",
        toolCallId: "tool-1",
        result: { kind: "approved" },
      });
      const { event: completed } = yield* harness.takeThrough("runtime_request.updated");
      assert.equal(completed.runtimeRequest.id, opened[1]!.id);
      assert.equal(completed.runtimeRequest.status, "cancelled");
      assert.deepEqual(yield* Effect.promise(() => second), { kind: "no-result" });

      yield* harness.runtime.respondToRuntimeRequest({
        requestId: opened[0]!.id,
        decision: "accept",
      });
      assert.deepEqual(yield* Effect.promise(() => first), { kind: "approve-once" });
      const { event: answered } = yield* harness.takeThrough("runtime_request.updated");
      assert.equal(answered.runtimeRequest.id, opened[0]!.id);
      assert.equal(answered.runtimeRequest.status, "resolved");

      fake.emit("session.idle");
      yield* harness.takeThrough("turn.terminal");
      assert.deepEqual(yield* Effect.promise(() => third), {
        kind: "reject",
        feedback: "The turn ended.",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

const interruptInput = (harness: Harness, providerTurnId: ProviderTurnId) => ({
  threadId: THREAD_ID,
  runId: RunId.make("run-1"),
  providerThread: harness.providerThread,
  providerTurnId,
});

const steerInput = (harness: Harness, providerTurnId: ProviderTurnId) => ({
  ...interruptInput(harness, providerTurnId),
  message: {
    messageId: MessageId.make("steer-message"),
    text: "Also say steered",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
  },
});

/** session.usage_info always reaches the thread, so seeing it means earlier events were handled. */
const settle = Effect.fnUntraced(function* (harness: Harness, fake: FakeCopilot) {
  fake.emit("session.usage_info", { currentTokens: 1, tokenLimit: 10 });
  const { seen } = yield* harness.takeThrough("provider_thread.updated", (update) =>
    Boolean(update.providerThread.contextUsage),
  );
  return seen;
});

describe("CopilotAdapterV2 turn boundaries", () => {
  it.effect("keeps a steer Copilot took after idling inside the steered turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      const providerTurn = yield* startTurn(harness, fake);
      fake.behavior.send = async (input) => {
        if (input.mode !== "immediate") return "unexpected";
        // Copilot finished the loop before the steer reached it.
        fake.emit("session.idle");
        return "steer-1";
      };
      yield* harness.runtime.steerTurn(steerInput(harness, providerTurn.id));
      assert.deepEqual(fake.calls("send").at(-1)?.args, [
        { prompt: "Also say steered", mode: "immediate" },
      ]);
      fake.emit("user.message", { content: "Also say steered", messageId: "steer-1" });
      fake.emit("assistant.message", { messageId: "reply-1", content: "steered" });
      fake.emit("session.idle");
      const { event, seen } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.providerTurnId, providerTurn.id);
      assert.equal(event.status, "completed");
      assert.deepEqual(assistantTexts(seen), ["steered"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("starts no turn while Copilot runs work T3 did not start", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      const pendingWork = harness.runtime.hasPendingBackgroundWork!;
      fake.emit("user.message", { content: "background done", messageId: "native-loop" });
      yield* settle(harness, fake);
      assert.isTrue(yield* pendingWork);
      const refused = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.lengthOf(fake.calls("send"), 0);
      const plan = yield* Effect.promise(() =>
        fake.handlers().onExitPlanModeRequest({
          summary: "Plan",
          planContent: "1. Not T3's",
        } as ExitPlanModeRequest),
      );
      assert.equal(plan.feedback, "T3 Code has no active turn to show this request in.");

      fake.emit("session.idle");
      yield* settle(harness, fake);
      assert.isFalse(yield* pendingWork);
      yield* startTurn(harness, fake);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("waits for a resumed session Copilot reports busy", () =>
    Effect.gen(function* () {
      const first = makeFakeCopilot();
      const stored = yield* Effect.scoped(
        Effect.map(openHarness(first), (harness) => harness.providerThread),
      );
      const fake = makeFakeCopilot();
      fake.behavior.isProcessing = async () => true;
      const harness = yield* openHarness(fake, "approval-required", stored);
      assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
      const refused = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread))
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(refused));

      fake.emit("session.idle");
      yield* settle(harness, fake);
      yield* startTurn(harness, fake);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each<{
    readonly name: string;
    readonly events: ReadonlyArray<readonly [string, Record<string, unknown>]>;
    readonly status: string;
    readonly message?: string;
  }>([
    {
      name: "ignores an error Copilot reports for another prompt",
      events: [
        ["user.message", { content: "Hello Copilot", messageId: "prompt-1" }],
        ["session.error", { message: "not mine", errorType: "query", originatingMessageId: "A" }],
        ["session.idle", {}],
      ],
      status: "completed",
    },
    {
      name: "fails with its own error even when Copilot then aborts",
      events: [
        [
          "session.error",
          {
            message: "attachment unreadable",
            errorType: "query",
            originatingMessageId: "prompt-1",
          },
        ],
        ["session.idle", { aborted: true }],
      ],
      status: "failed",
      message: "attachment unreadable",
    },
    {
      name: "fails with an error Copilot does not correlate",
      events: [
        ["session.error", { message: "model unavailable", errorType: "query" }],
        ["session.idle", {}],
      ],
      status: "failed",
      message: "model unavailable",
    },
    {
      name: "fails a prompt a policy hook blocked",
      events: [
        [
          "session.warning",
          {
            warningType: "policy_blocked",
            message: "Blocked by policy",
            originatingMessageId: "prompt-1",
          },
        ],
        ["session.idle", {}],
      ],
      status: "failed",
      message: "Blocked by policy",
    },
  ])("$name", ({ events, status, message }) =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread));
      for (const [type, data] of events) fake.emit(type, data);
      const { event } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, status);
      assert.equal(event.failure?.message, message);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("CopilotAdapterV2 stop", () => {
  it.effect("stops a turn before Copilot shows its prompt", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread));
      const { event: started } = yield* harness.takeThrough("provider_turn.updated");
      const stopping = yield* harness.runtime
        .interruptTurn(interruptInput(harness, started.providerTurn.id))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.abortCalled);
      fake.emit("abort", { reason: "user_initiated" });
      fake.emit("session.idle", { aborted: true });
      yield* Fiber.join(stopping);
      const { event } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, "interrupted");
      assert.notInclude(fake.methods(), "disconnect");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("detaches a session that never confirms a stop and resumes it for the next turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      const providerTurn = yield* startTurn(harness, fake);
      fake.behavior.send = async () => "steer-1";
      yield* harness.runtime.steerTurn(steerInput(harness, providerTurn.id));
      delete fake.behavior.send;
      fake.behavior.abort = () => new Promise(() => {});
      const stopping = yield* harness.runtime
        .interruptTurn(interruptInput(harness, providerTurn.id))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.abortCalled);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(stopping);
      const { event } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, "interrupted");
      assert.include(fake.methods(), "disconnect");
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);

      const detached = fake.handlers();
      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread, 2));
      assert.deepEqual(fake.methods().slice(-4), [
        "resumeSession",
        "setApproveAll",
        "isProcessing",
        "send",
      ]);
      // The steer's loop on the detached handle never reaches the next turn.
      fake.emitTo(detached, "assistant.message", { messageId: "late", content: "steered" });
      fake.emitTo(detached, "session.idle");
      fake.emit("user.message", { content: "Hello Copilot", messageId: "prompt-3" });
      fake.emit("assistant.message", { messageId: "mine", content: "my reply" });
      fake.emit("session.idle");
      const { event: next, seen } = yield* harness.takeThrough("turn.terminal");
      assert.equal(next.status, "completed");
      assert.deepEqual(assistantTexts(seen), ["my reply"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("detaches the session when Copilot rejects the abort", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      const providerTurn = yield* startTurn(harness, fake);
      fake.behavior.abort = async () => {
        throw new Error("connection lost");
      };
      yield* harness.runtime.interruptTurn(interruptInput(harness, providerTurn.id));
      const { event } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, "interrupted");
      assert.include(fake.methods(), "disconnect");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails and detaches the turn when Copilot did not receive an approval answer", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* startTurn(harness, fake);
      const handlers = fake.handlers();
      void handlers.onPermissionRequest(shellRequest("tool-1"), "request-1");
      const { event: opened } = yield* harness.takeThrough(
        "runtime_request.updated",
        (update) => update.runtimeRequest.status === "pending",
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: opened.runtimeRequest.id,
        decision: "accept",
      });
      handlers.onPermissionDeliveryFailed("request-1", new Error("connection closed"));
      const { event } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, "failed");
      assert.include(event.failure?.message, "connection closed");
      assert.include(fake.methods(), "disconnect");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("CopilotAdapterV2 rollback", () => {
  const providerTurn = (
    ordinal: number,
    nativeId: string | null,
    status: OrchestrationV2ProviderTurn["status"] = "completed",
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(`turn-${ordinal}`),
    providerThreadId: ProviderThreadId.make("thread"),
    nodeId: NodeId.make(`node-${ordinal}`),
    runAttemptId: null,
    nativeTurnRef: nativeId === null ? null : { driver: COPILOT, nativeId, strength: "strong" },
    ordinal,
    status,
    startedAt: null,
    completedAt: null,
  });

  it.effect("refuses to report a rollback it could not rewind in Copilot", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      const rollback = (providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>) =>
        harness.runtime
          .rollbackThread({
            providerThread: harness.providerThread,
            target: {
              type: "thread_start",
              checkpointId: CheckpointId.make("checkpoint-0"),
              appRunOrdinal: 0,
            },
            providerThreadTurns,
          })
          .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(yield* rollback([providerTurn(1, null)])));
      assert.isTrue(Exit.isSuccess(yield* rollback([])));
      // A failed status alone does not show the prompt never reached Copilot.
      assert.isTrue(
        Exit.isFailure(
          yield* rollback([providerTurn(1, null, "failed"), providerTurn(2, "event-2")]),
        ),
      );
      assert.lengthOf(fake.calls("rewind"), 0);
      assert.isTrue(Exit.isSuccess(yield* rollback([providerTurn(1, "event-1")])));
      assert.deepEqual(fake.calls("rewind")[0]?.args, ["event-1"]);

      const failSend = Effect.fnUntraced(function* (error: Error, ordinal: number) {
        fake.behavior.send = async () => {
          throw error;
        };
        const sent = yield* harness.runtime
          .startTurn(yield* turnInput(harness.providerThread, ordinal))
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(sent));
        delete fake.behavior.send;
        const { event } = yield* harness.takeThrough("turn.terminal");
        return [
          { ...providerTurn(ordinal, null, "failed"), id: event.providerTurnId },
          providerTurn(ordinal + 1, `event-${ordinal + 1}`),
        ];
      });
      // A lost connection may still have delivered the prompt.
      const unknown = yield* failSend(new Error("connection lost"), 3);
      assert.isTrue(Exit.isFailure(yield* rollback(unknown)));
      assert.include(fake.methods(), "resumeSession");
      // Copilot answered with an error, so there is nothing of the prompt to rewind.
      const rejected = yield* failSend(
        Object.assign(new Error("Copilot rejected the prompt"), { code: -32603 }),
        5,
      );
      assert.isTrue(Exit.isSuccess(yield* rollback(rejected)));
      assert.deepEqual(fake.calls("rewind")[1]?.args, ["event-6"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("CopilotAdapterV2 lifecycle", () => {
  it.effect("closing the session rejects pending approvals and stops the CLI", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const scope = yield* Scope.make();
      const harness = yield* openHarness(fake).pipe(Scope.provide(scope));
      yield* startTurn(harness, fake).pipe(Scope.provide(scope));
      const approval = fake.handlers().onPermissionRequest(shellRequest("tool-1"), "request-1");
      yield* harness.takeThrough(
        "runtime_request.updated",
        (update) => update.runtimeRequest.status === "pending",
      );
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(yield* Effect.promise(() => approval), {
        kind: "reject",
        feedback: "The turn ended.",
      });
      const methods = fake.methods();
      assert.isAbove(methods.indexOf("stop"), methods.indexOf("disconnect"));
      assert.isAtLeast(methods.indexOf("disconnect"), 0);
    }).pipe(Effect.provide(testLayer)),
  );
});

const itemsOf = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

describe("CopilotAdapterV2 subagents", () => {
  it.effect("shows a task as a subagent with its own child thread and result", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* startTurn(harness, fake);
      fake.emit("tool.execution_start", {
        toolCallId: "task-1",
        toolName: "task",
        arguments: { description: "Read a.txt", prompt: "Read a.txt and report it" },
      });
      fake.emitAgent("agent-1", "subagent.started", {
        toolCallId: "task-1",
        agentName: "explore",
        agentDisplayName: "read-a-txt",
        model: "gpt-5-mini",
      });
      fake.emitAgent("agent-1", "user.message", { content: "Read a.txt and report it" });
      fake.emitAgent("agent-1", "tool.execution_start", {
        toolCallId: "view-1",
        toolName: "view",
        arguments: { path: "a.txt" },
        parentToolCallId: "task-1",
      });
      fake.emitAgent("agent-1", "tool.execution_complete", {
        toolCallId: "view-1",
        success: true,
        result: { content: "hello" },
      });
      fake.emitAgent("agent-1", "assistant.message", { messageId: "child-1", content: "hello" });
      fake.emitAgent("agent-1", "subagent.completed", { toolCallId: "task-1" });
      fake.emit("tool.execution_complete", {
        toolCallId: "task-1",
        success: true,
        result: { content: "hello" },
      });
      fake.emit("assistant.message", { messageId: "reply-1", content: "It says hello" });
      fake.emit("session.idle");
      const { event, seen } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, "completed");

      const created = seen.flatMap((entry) =>
        entry.type === "app_thread.created" ? [entry.appThread] : [],
      );
      assert.lengthOf(created, 1);
      const child = created[0]!;
      assert.equal(child.lineage.parentThreadId, THREAD_ID);
      assert.equal(child.lineage.relationshipToParent, "subagent");
      const subagents = seen.flatMap((entry) =>
        entry.type === "subagent.updated" ? [entry.subagent] : [],
      );
      const last = subagents.at(-1)!;
      assert.equal(last.status, "completed");
      assert.equal(last.result, "hello");
      assert.equal(last.childThreadId, child.id);
      assert.equal(last.prompt, "Read a.txt and report it");

      const items = itemsOf(seen);
      // The task call is the subagent row, not a tool row.
      assert.isFalse(items.some((item) => item.type === "dynamic_tool" && item.title === "task"));
      const childItems = items.filter((item) => item.threadId === child.id);
      assert.deepEqual(
        childItems.map((item) => item.type),
        ["user_message", "dynamic_tool", "dynamic_tool", "assistant_message"],
      );
      assert.isTrue(childItems.every((item) => item.runId === null));
      assert.deepEqual(
        [
          ...new Set(
            items.flatMap((item) =>
              item.type === "assistant_message" && item.threadId === THREAD_ID ? [item.text] : [],
            ),
          ),
        ],
        ["It says hello"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a background task running past its tool call until Copilot ends it", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* startTurn(harness, fake);
      fake.emit("tool.execution_start", {
        toolCallId: "task-1",
        toolName: "task",
        arguments: { prompt: "Look around", mode: "background" },
      });
      fake.emitAgent("agent-1", "subagent.started", { toolCallId: "task-1" });
      fake.emit("tool.execution_complete", {
        toolCallId: "task-1",
        success: true,
        result: { content: "Agent started in background with agent_id: agent-1" },
      });
      fake.emit("assistant.message", { messageId: "reply-1", content: "launched" });
      fake.emitAgent("agent-1", "assistant.message", { messageId: "child-1", content: "found it" });
      const { seen: before } = yield* harness.takeThrough(
        "turn_item.updated",
        (update) =>
          update.turnItem.type === "assistant_message" && update.turnItem.text === "found it",
      );
      assert.isTrue(
        before
          .flatMap((entry) => (entry.type === "subagent.updated" ? [entry.subagent.status] : []))
          .every((status) => status === "running"),
      );
      fake.emitAgent("agent-1", "subagent.completed", { toolCallId: "task-1" });
      fake.emit("session.idle");
      const { seen } = yield* harness.takeThrough("turn.terminal");
      const last = seen.findLast((entry) => entry.type === "subagent.updated");
      assert.isTrue(
        last?.type === "subagent.updated" &&
          last.subagent.status === "completed" &&
          last.subagent.result === "found it",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("ends a running subagent with an interrupted turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      const providerTurn = yield* startTurn(harness, fake);
      fake.emit("tool.execution_start", {
        toolCallId: "task-1",
        toolName: "task",
        arguments: { prompt: "Work" },
      });
      fake.emitAgent("agent-1", "subagent.started", { toolCallId: "task-1" });
      fake.emitAgent("agent-1", "tool.execution_start", { toolCallId: "bash-1", toolName: "bash" });
      fake.behavior.abort = async () => fake.emit("session.idle", { aborted: true });
      yield* harness.runtime.interruptTurn(interruptInput(harness, providerTurn.id));
      const { event, seen } = yield* harness.takeThrough("turn.terminal");
      assert.equal(event.status, "interrupted");
      const last = seen.findLast((entry) => entry.type === "subagent.updated");
      assert.isTrue(last?.type === "subagent.updated" && last.subagent.status === "interrupted");
      const bash = itemsOf(seen).findLast((item) => item.title === "bash");
      assert.equal(bash?.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

const recordedUsage = () => {
  const recorded: Array<{ model: string; inputTokens: number; outputTokens: number }> = [];
  const recordUsage: NonNullable<CopilotAdapterV2Options["recordUsage"]> = ({ model, usage }) =>
    Effect.sync(() => {
      recorded.push({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    });
  const sorted = () =>
    recorded.toSorted(
      (left, right) =>
        left.model.localeCompare(right.model) || left.inputTokens - right.inputTokens,
    );
  return { recordUsage, sorted };
};

const compactionsOf = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  itemsOf(events).flatMap((item) => (item.type === "compaction" ? [item] : []));

const completedTurnOf = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) =>
    event.type === "provider_turn.updated" && event.providerTurn.status === "completed"
      ? [event.providerTurn]
      : [],
  )[0];

describe("CopilotAdapterV2 compaction and usage", () => {
  it.effect("shows compaction in the turn and records usage per model, subagents included", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const usage = recordedUsage();
      const harness = yield* openHarness(fake, "approval-required", undefined, {
        settings: { ...settings, autoCompactPercent: "70" },
        recordUsage: usage.recordUsage,
      });
      const created = fake.calls("createSession")[0]?.args[0] as
        | { readonly compactionThreshold?: number }
        | undefined;
      assert.equal(created?.compactionThreshold, 0.7);
      yield* startTurn(harness, fake);
      fake.emit("assistant.usage", { model: "main", inputTokens: 100, outputTokens: 10 });
      fake.emit("tool.execution_start", { toolCallId: "task-1", toolName: "task", arguments: {} });
      fake.emitAgent("agent-1", "subagent.started", { toolCallId: "task-1" });
      fake.emitAgent("agent-1", "assistant.usage", {
        model: "mini",
        inputTokens: 5,
        outputTokens: 1,
      });
      fake.emitAgent("agent-1", "subagent.completed", { toolCallId: "task-1" });
      fake.emit("session.compaction_start", { compactionAttemptId: "c1", currentTokens: 900 });
      // Should Copilot also report compaction's model call, compaction_complete stays the count.
      fake.emit("assistant.usage", {
        model: "main",
        inputTokens: 50,
        outputTokens: 5,
        interactionType: "conversation-compaction",
      });
      fake.emit("session.compaction_complete", {
        compactionAttemptId: "c1",
        success: true,
        summaryContent: "Summary",
        preCompactionTokens: 900,
        postCompactionTokens: 100,
        compactionTokensUsed: { model: "main", inputTokens: 50, outputTokens: 5 },
      });
      fake.emit("session.idle");
      const { seen } = yield* harness.takeThrough("turn.terminal");
      const compaction = compactionsOf(seen).at(-1);
      assert.isTrue(
        compaction?.status === "completed" &&
          compaction.summary === "Summary" &&
          compaction.beforeTokenCount === 900 &&
          compaction.afterTokenCount === 100,
      );
      const completed = completedTurnOf(seen);
      assert.equal(completed?.turnTokenUsage?.inputTokens, 100);
      assert.equal(completed?.turnTokenUsage?.hasSubagents, true);
      yield* settle(harness, fake);
      assert.deepEqual(usage.sorted(), [
        { model: "main", inputTokens: 50, outputTokens: 5 },
        { model: "main", inputTokens: 100, outputTokens: 10 },
        { model: "mini", inputTokens: 5, outputTokens: 1 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("finishes a compaction in the turn that started it, after that turn ended", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const usage = recordedUsage();
      const harness = yield* openHarness(fake, "approval-required", undefined, {
        recordUsage: usage.recordUsage,
      });
      yield* startTurn(harness, fake, 1);
      fake.emit("session.compaction_start", { compactionAttemptId: "c1", currentTokens: 900 });
      fake.emit("session.idle");
      const first = yield* harness.takeThrough("turn.terminal");
      const running = compactionsOf(first.seen).at(-1);
      assert.equal(running?.status, "running");
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);

      yield* startTurn(harness, fake, 2);
      fake.emit("session.compaction_complete", {
        compactionAttemptId: "c1",
        success: true,
        preCompactionTokens: 900,
        postCompactionTokens: 100,
        compactionTokensUsed: { model: "main", inputTokens: 50, outputTokens: 5 },
      });
      fake.emit("assistant.usage", { model: "main", inputTokens: 7, outputTokens: 1 });
      fake.emit("session.idle");
      const second = yield* harness.takeThrough("turn.terminal");
      const finished = compactionsOf(second.seen);
      assert.lengthOf(finished, 1);
      assert.equal(finished[0]?.id, running?.id);
      assert.equal(finished[0]?.runId, RunId.make("run-1"));
      assert.equal(finished[0]?.status, "completed");
      assert.equal(completedTurnOf(second.seen)?.turnTokenUsage?.inputTokens, 7);
      yield* settle(harness, fake);
      assert.deepEqual(usage.sorted(), [
        { model: "main", inputTokens: 7, outputTokens: 1 },
        { model: "main", inputTokens: 50, outputTokens: 5 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps one row for a compaction Copilot reports without an attempt id", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* startTurn(harness, fake);
      fake.emit("session.compaction_start", { currentTokens: 900 });
      fake.emit("session.compaction_complete", { success: true, postCompactionTokens: 100 });
      fake.emit("session.idle");
      const { seen } = yield* harness.takeThrough("turn.terminal");
      const rows = compactionsOf(seen);
      assert.deepEqual(
        rows.map((row) => row.status),
        ["running", "completed"],
      );
      assert.lengthOf(new Set(rows.map((row) => row.id)), 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not count a compaction's usage after idle as work T3 did not start", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const usage = recordedUsage();
      const harness = yield* openHarness(fake, "approval-required", undefined, {
        recordUsage: usage.recordUsage,
      });
      yield* startTurn(harness, fake, 1);
      fake.emit("session.compaction_start", { compactionAttemptId: "c1", currentTokens: 900 });
      fake.emit("session.idle");
      yield* harness.takeThrough("turn.terminal");
      fake.emit("assistant.usage", {
        model: "main",
        inputTokens: 50,
        outputTokens: 5,
        interactionType: "conversation-compaction",
      });
      fake.emit("session.compaction_complete", {
        compactionAttemptId: "c1",
        success: true,
        compactionTokensUsed: { model: "main", inputTokens: 50, outputTokens: 5 },
      });
      yield* settle(harness, fake);
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      yield* startTurn(harness, fake, 2);
      assert.deepEqual(usage.sorted(), [{ model: "main", inputTokens: 50, outputTokens: 5 }]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not count a compaction after idle as work T3 did not start", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      fake.emit("session.compaction_complete", { success: true });
      yield* settle(harness, fake);
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      yield* startTurn(harness, fake);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("CopilotAdapterV2 fork", () => {
  const sourceTurn = (
    ordinal: number,
    nativeId: string | null,
    endEventId?: string,
  ): OrchestrationV2ProviderTurn => {
    const base = turn(ordinal, nativeId);
    return {
      ...base,
      providerThreadId: ProviderThreadId.make("source"),
      ...(base.nativeTurnRef && endEventId
        ? { nativeTurnRef: { ...base.nativeTurnRef, fingerprint: endEventId } }
        : {}),
    };
  };
  const event = (id: string, type: string, agentId?: string): CopilotPersistedEvent => ({
    id,
    type,
    ...(agentId ? { agentId } : {}),
  });
  const SOURCE_TURNS = [
    sourceTurn(1, "event-1", "end-1"),
    sourceTurn(2, "event-2", "end-2"),
    { ...turn(3, "other-thread"), providerThreadId: ProviderThreadId.make("other") },
  ];

  const fork = (
    providerTurnId?: string,
    setup: (fake: FakeCopilot) => void = () => {},
    sourceProviderTurns: ReadonlyArray<OrchestrationV2ProviderTurn> = SOURCE_TURNS,
  ) =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      setup(fake);
      const adapter = yield* makeCopilotAdapterV2({
        instanceId: INSTANCE_ID,
        settings,
        environment: {},
        createClient: async () => fake.client,
        resolveLaunch: (cwd) =>
          Effect.succeed({ platform: "linux", command: "copilot", args: [], env: {}, cwd }),
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make("fork"),
        providerSessionId: ProviderSessionId.make("fork-session"),
        modelSelection,
        runtimePolicy: policy(),
      });
      const now = yield* DateTime.now;
      const forked = yield* runtime
        .forkThread({
          sourceProviderThread: {
            id: ProviderThreadId.make("source"),
            driver: COPILOT,
            providerInstanceId: INSTANCE_ID,
            providerSessionId: SESSION_ID,
            appThreadId: THREAD_ID,
            ownerNodeId: null,
            nativeThreadRef: { driver: COPILOT, nativeId: "native-1", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 2,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          sourceProviderTurns,
          targetThreadId: ThreadId.make("fork"),
          ...(providerTurnId ? { providerTurnId: ProviderTurnId.make(providerTurnId) } : {}),
        })
        .pipe(Effect.exit);
      return { fake, forked };
    }).pipe(Effect.scoped);

  /** The source's journal through T3's second turn, ending with what came after it. */
  const sourceJournal =
    (...after: ReadonlyArray<CopilotPersistedEvent>) =>
    (fake: FakeCopilot) =>
      fake.setJournal("native-1", [
        event("event-1", "user.message"),
        event("end-1", "x"),
        event("event-2", "user.message"),
        event("end-2", "x"),
        ...after,
      ]);
  const copyJournal = (fake: FakeCopilot) =>
    fake.setJournal("native-fork", [event("end-2", "x"), event("info-2", "session.info")]);

  it.effect("records where each turn ended on its native ref", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot();
      const harness = yield* openHarness(fake);
      yield* startTurn(harness, fake);
      fake.emitIdle("persisted-9");
      const { seen } = yield* harness.takeThrough("turn.terminal");
      const completed = completedTurnOf(seen);
      assert.equal(completed?.nativeTurnRef?.nativeId, "event-1");
      assert.equal(completed?.nativeTurnRef?.fingerprint, "persisted-9");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forks before the first later turn's prompt and resumes the copy", () =>
    Effect.gen(function* () {
      const { fake, forked } = yield* fork("turn-1", sourceJournal());
      assert.deepEqual(fake.calls("forkSession")[0]?.args, ["native-1", "event-2"]);
      assert.deepEqual(fake.calls("resumeSession")[0]?.args, ["native-fork"]);
      assert.deepEqual(
        fake.calls("persistedEventsAfter").map((call) => call.args),
        [["native-1", "end-1"]],
      );
      assert.isTrue(Exit.isSuccess(forked));
      if (Exit.isSuccess(forked)) {
        assert.equal(forked.value.nativeThreadRef?.nativeId, "native-fork");
        assert.equal(forked.value.appThreadId, ThreadId.make("fork"));
        assert.equal(forked.value.forkedFrom?.providerTurnId, "turn-1");
      }
      assert.isTrue(Exit.isFailure((yield* fork("turn-9", sourceJournal())).forked));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves CLI work between T3's turns out of a fork from the earlier turn", () =>
    Effect.gen(function* () {
      const between =
        (...events: ReadonlyArray<CopilotPersistedEvent>) =>
        (fake: FakeCopilot) =>
          fake.setJournal("native-1", [
            event("event-1", "user.message"),
            event("end-1", "x"),
            ...events,
            event("event-2", "user.message"),
            event("end-2", "x"),
          ]);
      const clean = yield* fork(
        "turn-1",
        between(event("cli-1", "user.message"), event("cli-1-end", "x")),
      );
      assert.isTrue(Exit.isSuccess(clean.forked));
      assert.deepEqual(clean.fake.calls("forkSession")[0]?.args, ["native-1", "cli-1"]);
      // Turn 1's own work went on past where T3 saw it end.
      const midTurn = yield* fork("turn-1", between(event("tool-1", "tool.execution_start")));
      const unfinished = yield* fork("turn-1", sourceJournal(), [
        sourceTurn(1, "event-1"),
        sourceTurn(2, "event-2", "end-2"),
      ]);
      for (const attempt of [midTurn, unfinished]) {
        assert.isTrue(Exit.isFailure(attempt.forked));
        assert.lengthOf(attempt.fake.calls("forkSession"), 0);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("forks from a turn a rollback returned to without the turns it rewound", () =>
    Effect.gen(function* () {
      // Rewinding to turn 2's prompt removes it and all after; its auto-mode event stays.
      const rewound = yield* fork("turn-1", (fake) =>
        fake.setJournal("native-1", [
          event("event-1", "user.message"),
          event("end-1", "x"),
          event("mode-2", "session.auto_mode_resolved"),
        ]),
      );
      assert.isTrue(Exit.isSuccess(rewound.forked));
      assert.deepEqual(rewound.fake.calls("forkSession")[0]?.args, ["native-1", "mode-2"]);
      const whole = yield* fork("turn-1", (fake) => {
        fake.setJournal("native-1", [event("event-1", "user.message"), event("end-1", "x")]);
        fake.setJournal("native-fork", [event("event-1", "user.message"), event("end-1", "x")]);
      });
      assert.isTrue(Exit.isSuccess(whole.forked));
      assert.deepEqual(whole.fake.calls("forkSession")[0]?.args, ["native-1", undefined]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("copies the whole session when nothing ran after T3's last turn", () =>
    Effect.gen(function* () {
      for (const providerTurnId of ["turn-2", undefined]) {
        const { fake, forked } = yield* fork(providerTurnId, (current) => {
          // An earlier fork noted itself in the source.
          sourceJournal(event("info-1", "session.info"))(current);
          copyJournal(current);
        });
        assert.isTrue(Exit.isSuccess(forked));
        assert.deepEqual(fake.calls("forkSession")[0]?.args, ["native-1", undefined]);
        assert.deepEqual(
          fake.calls("persistedEventsAfter").map((call) => call.args),
          [
            ["native-1", "end-2"],
            ["native-fork", "end-2"],
          ],
        );
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves work started after T3's last turn out of the copy", () =>
    Effect.gen(function* () {
      const { fake, forked } = yield* fork(
        "turn-2",
        sourceJournal(
          event("mode-3", "session.auto_mode_resolved"),
          event("cli-3", "user.message"),
        ),
      );
      assert.isTrue(Exit.isSuccess(forked));
      assert.deepEqual(fake.calls("forkSession")[0]?.args, ["native-1", "mode-3"]);
      assert.lengthOf(fake.calls("persistedEventsAfter"), 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to fork from the last turn without a clean end", () =>
    Effect.gen(function* () {
      const midTurn = yield* fork("turn-2", sourceJournal(event("tool-3", "tool.execution_start")));
      const subagent = yield* fork("turn-2", sourceJournal(event("sub-3", "user.message", "a1")));
      const rewritten = yield* fork("turn-2", (fake) => fake.setJournal("native-1", []));
      const unfinished = yield* fork("turn-2", sourceJournal(), [
        sourceTurn(1, "event-1", "end-1"),
        sourceTurn(2, "event-2"),
      ]);
      for (const attempt of [midTurn, subagent, rewritten, unfinished]) {
        assert.isTrue(Exit.isFailure(attempt.forked));
        assert.lengthOf(attempt.fake.calls("forkSession"), 0);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deletes a whole copy that caught work Copilot started meanwhile", () =>
    Effect.gen(function* () {
      const { fake, forked } = yield* fork("turn-2", (current) => {
        sourceJournal()(current);
        current.setJournal("native-fork", [event("end-2", "x"), event("cli-3", "user.message")]);
      });
      assert.isTrue(Exit.isFailure(forked));
      assert.deepEqual(fake.calls("deleteSession")[0]?.args, ["native-fork"]);
      assert.lengthOf(fake.calls("resumeSession"), 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("detaches and deletes a copy it could not resume", () =>
    Effect.gen(function* () {
      const { fake, forked } = yield* fork("turn-1", (current) => {
        sourceJournal()(current);
        current.behavior.resumeSession = async () => {
          throw new Error("resume refused");
        };
      });
      assert.isTrue(Exit.isFailure(forked));
      assert.deepEqual(fake.calls("deleteSession")[0]?.args, ["native-fork"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("detaches and deletes a copy whose approve-all Copilot refused", () =>
    Effect.gen(function* () {
      const { fake, forked } = yield* fork("turn-1", (current) => {
        sourceJournal()(current);
        current.behavior.setApproveAll = async () => {
          throw new Error("approve-all refused");
        };
      });
      assert.isTrue(Exit.isFailure(forked));
      const methods = fake.methods();
      assert.isAbove(methods.indexOf("deleteSession"), methods.indexOf("disconnect"));
      assert.deepEqual(fake.calls("deleteSession")[0]?.args, ["native-fork"]);
    }).pipe(Effect.provide(testLayer)),
  );
});
