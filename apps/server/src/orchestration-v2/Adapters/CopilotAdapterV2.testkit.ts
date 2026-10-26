import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayEntry as ProviderReplayEntryType,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { CopilotSettings } from "@t3tools/provider-copilot/settings";
import { makeCopilotAdapterV2 } from "@t3tools/provider-copilot/server";
import type {
  CopilotPersistedEvent,
  CopilotSdkClient,
  CopilotSdkFactory,
  CopilotSdkSession,
  CopilotSessionHandlers,
} from "@t3tools/provider-copilot/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export const COPILOT_PROVIDER_KIND = "copilot";
export const COPILOT_SDK_REPLAY_PROTOCOL = "copilot.sdk";
const COPILOT_REPLAY_ANY = "<any>";

const CopilotReplayTranscript = Schema.Struct({
  provider: Schema.Literal(COPILOT_PROVIDER_KIND),
  protocol: Schema.Literal(COPILOT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type CopilotReplayTranscript = typeof CopilotReplayTranscript.Type;
const decodeCopilotReplayTranscript = Schema.decodeUnknownEffect(CopilotReplayTranscript);

class CopilotReplayTranscriptDecodeError extends Schema.TaggedError<CopilotReplayTranscriptDecodeError>()(
  "CopilotReplayTranscriptDecodeError",
  { scenario: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to decode Copilot SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class CopilotReplayMismatchError extends Schema.TaggedError<CopilotReplayMismatchError>()(
  "CopilotReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Copilot replay call mismatch at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

class CopilotReplayIncompleteError extends Schema.TaggedError<CopilotReplayIncompleteError>()(
  "CopilotReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    next: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Copilot replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

/** Outbound frames are SDK calls and handler answers; inbound frames are call results, events, and handler requests. */
export type CopilotReplayFrame = Record<string, unknown> & { readonly type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === COPILOT_REPLAY_ANY) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

/** Drops undefined members so frames compare the way they serialize. */
const jsonCodec = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(jsonCodec);
const decodeJson = Schema.decodeUnknownSync(jsonCodec);
function jsonFrame(frame: CopilotReplayFrame): CopilotReplayFrame {
  return decodeJson(encodeJson(frame)) as CopilotReplayFrame;
}

interface PendingCall {
  readonly call: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Inbound entries are delivered as soon as the cursor reaches them; an outbound entry waits for
 * the adapter's matching call. Calls may match a later outbound entry, but never across a send.
 */
class CopilotReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly calls: Array<PendingCall> = [];
  private readonly handlers = new Map<string, CopilotSessionHandlers>();
  private openingHandlers: CopilotSessionHandlers | undefined;
  private exit: ((error: Error) => void) | undefined;
  private readonly transcript: CopilotReplayTranscript;

  constructor(transcript: CopilotReplayTranscript) {
    this.transcript = transcript;
  }

  call(frame: CopilotReplayFrame, handlers?: CopilotSessionHandlers): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (handlers) this.openingHandlers = handlers;
      this.calls.push({ call: frame.type, resolve, reject });
      this.receive(frame);
    });
  }

  receive(frame: CopilotReplayFrame): void {
    if (this.failure !== null) return;
    const actual = jsonFrame(frame);
    const entries = this.transcript.entries;
    let matched: number | undefined;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound" || this.consumed.has(index)) continue;
      if (replayValueMatches(entry.frame, actual)) {
        matched = index;
        break;
      }
      if (isRecord(entry.frame) && entry.frame.type === "session.send") break;
    }
    if (matched === undefined) {
      this.fail(
        new CopilotReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          expected: entries[this.cursor] ?? null,
          actual,
        }),
      );
      return;
    }
    this.consumed.add(matched);
    this.advance();
  }

  onExit(listener: (error: Error) => void): void {
    this.exit = listener;
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length)
      throw new CopilotReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        next: this.transcript.entries[this.cursor] ?? null,
      });
  }

  private advance(): void {
    while (this.failure === null) {
      const entry: ProviderReplayEntryType | undefined = this.transcript.entries[this.cursor];
      if (entry === undefined) return;
      if (entry.type === "expect_outbound") {
        if (!this.consumed.has(this.cursor)) return;
        this.cursor += 1;
        continue;
      }
      this.cursor += 1;
      if (entry.type === "runtime_exit") {
        this.exit?.(new Error("Copilot CLI exited"));
        continue;
      }
      this.deliver(entry.frame);
      // Like the SDK's JSON-RPC connection, a caller sees its result before the next message.
      if (
        isRecord(entry.frame) &&
        (entry.frame.type === "return" || entry.frame.type === "throw")
      ) {
        setImmediate(() => this.advance());
        return;
      }
    }
  }

  private handlersFor(frame: Record<string, unknown>) {
    const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : undefined;
    return (sessionId && this.handlers.get(sessionId)) || this.openingHandlers;
  }

  private deliver(frame: unknown): void {
    if (!isRecord(frame)) return;
    switch (frame.type) {
      case "return":
      case "throw": {
        const index = this.calls.findIndex((pending) => pending.call === frame.call);
        if (index === -1) {
          this.fail(
            new CopilotReplayMismatchError({
              scenario: this.transcript.scenario,
              cursor: this.cursor - 1,
              expected: frame,
              actual: null,
            }),
          );
          return;
        }
        const [pending] = this.calls.splice(index, 1);
        if (frame.type === "throw") {
          pending!.reject(new Error(typeof frame.message === "string" ? frame.message : "failed"));
          return;
        }
        const value = isRecord(frame.value) ? frame.value : undefined;
        if (
          (frame.call === "session.create" || frame.call === "session.resume") &&
          typeof value?.sessionId === "string" &&
          this.openingHandlers
        )
          this.handlers.set(value.sessionId, this.openingHandlers);
        pending!.resolve(frame.value ?? null);
        return;
      }
      case "event":
        this.handlersFor(frame)?.onEvent(frame.event as never);
        return;
      case "permission.request":
        void this.handlersFor(frame)
          ?.onPermissionRequest(frame.request as never, String(frame.requestId))
          .then((result) =>
            this.receive({ type: "permission.respond", sessionId: frame.sessionId, result }),
          );
        return;
      case "userInput.request":
        void this.handlersFor(frame)
          ?.onUserInputRequest(frame.request as never)
          .then((result) =>
            this.receive({ type: "userInput.respond", sessionId: frame.sessionId, result }),
          );
        return;
      case "exitPlanMode.request":
        void this.handlersFor(frame)
          ?.onExitPlanModeRequest(frame.request as never)
          .then((result) =>
            this.receive({ type: "exitPlanMode.respond", sessionId: frame.sessionId, result }),
          );
        return;
    }
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const pending of this.calls.splice(0)) pending.reject(new Error("Copilot replay failed"));
  }
}

function replaySession(controller: CopilotReplayController, sessionId: string): CopilotSdkSession {
  const call = <A>(type: string, frame: Record<string, unknown> = {}) =>
    controller.call({ type, sessionId, ...frame }) as Promise<A>;
  return {
    sessionId,
    send: (input) => call<string>("session.send", { input }),
    abort: () => call<void>("session.abort"),
    isProcessing: () => call<boolean>("session.isProcessing"),
    setModel: (model, reasoningEffort) =>
      call<void>("session.setModel", { model, ...(reasoningEffort ? { reasoningEffort } : {}) }),
    setApproveAll: (enabled) => call<void>("session.setApproveAll", { enabled }),
    rewind: (eventId) => call("session.rewind", { eventId }),
    readTodos: () => call("session.readTodos"),
    disconnect: () => call<void>("session.disconnect"),
  };
}

function makeReplayCreateClient(controller: CopilotReplayController): CopilotSdkFactory {
  return async (launch) => {
    await controller.call({ type: "client.start", args: [...launch.args] });
    const exited = new Promise<Error>((resolve) => controller.onExit(resolve));
    const open = async (frame: CopilotReplayFrame, handlers: CopilotSessionHandlers) => {
      const value = (await controller.call(frame, handlers)) as { sessionId: string };
      return replaySession(controller, value.sessionId);
    };
    return {
      authStatus: () => Promise.reject(new Error("Replay does not probe sign-in")),
      listModels: () => Promise.reject(new Error("Replay does not list models")),
      createSession: (options, handlers) => open({ type: "session.create", options }, handlers),
      resumeSession: (sessionId, options, handlers) =>
        open({ type: "session.resume", sessionId, options }, handlers),
      forkSession: async (sessionId, toEventId) =>
        (
          (await controller.call({ type: "session.fork", sessionId, toEventId })) as {
            sessionId: string;
          }
        ).sessionId,
      persistedEventsAfter: (sessionId, eventId) =>
        controller.call({ type: "session.eventsAfter", sessionId, eventId }) as Promise<
          ReadonlyArray<CopilotPersistedEvent> | undefined
        >,
      // The pool's background sweep is not part of a recorded conversation.
      listSessions: async () => [],
      deleteSession: async (sessionId) => {
        await controller.call({ type: "session.delete", sessionId });
      },
      createTextSession: () => Promise.reject(new Error("Replay does not generate text")),
      exited,
      stop: async () => {
        await controller.call({ type: "client.stop" });
      },
      forceStop: async () => {},
    } satisfies CopilotSdkClient;
  };
}

/** Wraps a live client so every call, result, event, and handler exchange is recorded in order. */
export function makeRecordingCreateClient(
  inner: CopilotSdkFactory,
  record: (type: "expect_outbound" | "emit_inbound", frame: CopilotReplayFrame) => void,
): CopilotSdkFactory {
  const traced = async <A>(
    frame: CopilotReplayFrame,
    run: () => Promise<A>,
    recordedValue: (value: A) => unknown = (value) => value ?? null,
  ): Promise<A> => {
    record("expect_outbound", frame);
    try {
      const value = await run();
      record("emit_inbound", { type: "return", call: frame.type, value: recordedValue(value) });
      return value;
    } catch (error) {
      record("emit_inbound", {
        type: "throw",
        call: frame.type,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const wrapSession = (session: CopilotSdkSession): CopilotSdkSession => {
    const sessionId = session.sessionId;
    const frame = (type: string, rest: Record<string, unknown> = {}) => ({
      type,
      sessionId,
      ...rest,
    });
    return {
      sessionId,
      send: (input) => traced(frame("session.send", { input }), () => session.send(input)),
      abort: () => traced(frame("session.abort"), () => session.abort()),
      isProcessing: () => traced(frame("session.isProcessing"), () => session.isProcessing()),
      setModel: (model, reasoningEffort) =>
        traced(
          frame("session.setModel", { model, ...(reasoningEffort ? { reasoningEffort } : {}) }),
          () => session.setModel(model, reasoningEffort),
        ),
      setApproveAll: (enabled) =>
        traced(frame("session.setApproveAll", { enabled }), () => session.setApproveAll(enabled)),
      rewind: (eventId) =>
        traced(frame("session.rewind", { eventId }), () => session.rewind(eventId)),
      readTodos: () => traced(frame("session.readTodos"), () => session.readTodos()),
      disconnect: () => traced(frame("session.disconnect"), () => session.disconnect()),
    };
  };
  const wrapHandlers = (
    handlers: CopilotSessionHandlers,
    sessionId: () => string | undefined,
  ): CopilotSessionHandlers => {
    const exchange =
      <Request, Result>(
        kind: string,
        handler: (request: Request) => Promise<Result>,
      ): ((request: Request) => Promise<Result>) =>
      async (request) => {
        record("emit_inbound", { type: `${kind}.request`, sessionId: sessionId(), request });
        const result = await handler(request);
        record("expect_outbound", { type: `${kind}.respond`, sessionId: sessionId(), result });
        return result;
      };
    return {
      onEvent: (event) => {
        record("emit_inbound", { type: "event", sessionId: sessionId(), event });
        handlers.onEvent(event);
      },
      onPermissionRequest: async (request, requestId) => {
        record("emit_inbound", {
          type: "permission.request",
          sessionId: sessionId(),
          requestId,
          request,
        });
        const result = await handlers.onPermissionRequest(request, requestId);
        record("expect_outbound", { type: "permission.respond", sessionId: sessionId(), result });
        return result;
      },
      onUserInputRequest: exchange("userInput", handlers.onUserInputRequest),
      onExitPlanModeRequest: exchange("exitPlanMode", handlers.onExitPlanModeRequest),
      onPermissionDeliveryFailed: handlers.onPermissionDeliveryFailed,
    };
  };
  return async (launch, control) => {
    const client = await traced(
      { type: "client.start", args: [...launch.args] },
      () => inner(launch, control),
      () => null,
    );
    const open = async (
      frame: CopilotReplayFrame,
      handlers: CopilotSessionHandlers,
      run: (wrapped: CopilotSessionHandlers) => Promise<CopilotSdkSession>,
    ) => {
      let sessionId = typeof frame.sessionId === "string" ? frame.sessionId : undefined;
      const session = await traced(
        frame,
        async () => {
          const opened = await run(wrapHandlers(handlers, () => sessionId));
          sessionId = opened.sessionId;
          return opened;
        },
        (opened) => ({ sessionId: opened.sessionId }),
      );
      return wrapSession(session);
    };
    return {
      authStatus: () => client.authStatus(),
      listModels: () => client.listModels(),
      createSession: (options, handlers) =>
        open({ type: "session.create", options }, handlers, (wrapped) =>
          client.createSession(options, wrapped),
        ),
      resumeSession: (sessionId, options, handlers) =>
        open({ type: "session.resume", sessionId, options }, handlers, (wrapped) =>
          client.resumeSession(sessionId, options, wrapped),
        ),
      forkSession: (sessionId, toEventId) =>
        traced(
          { type: "session.fork", sessionId, toEventId },
          () => client.forkSession(sessionId, toEventId),
          (forked) => ({ sessionId: forked }),
        ),
      persistedEventsAfter: (sessionId, eventId) =>
        traced({ type: "session.eventsAfter", sessionId, eventId }, () =>
          client.persistedEventsAfter(sessionId, eventId),
        ),
      listSessions: async () => [],
      deleteSession: (sessionId) =>
        traced({ type: "session.delete", sessionId }, () => client.deleteSession(sessionId)),
      createTextSession: (options) => client.createTextSession(options),
      exited: client.exited,
      stop: () => traced({ type: "client.stop" }, () => client.stop()),
      forceStop: (reason) => client.forceStop(reason),
    } satisfies CopilotSdkClient;
  };
}

const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({ enabled: true });

export function layer(input: {
  readonly createClient: CopilotSdkFactory;
  readonly environment?: NodeJS.ProcessEnv;
  /** Recording resolves the real CLI; replay never spawns one. */
  readonly launchCommand?: string;
  readonly launchArgs?: ReadonlyArray<string>;
}) {
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      return [
        yield* makeCopilotAdapterV2({
          instanceId: ProviderInstanceId.make(COPILOT_PROVIDER_KIND),
          settings: DEFAULT_COPILOT_SETTINGS,
          environment: input.environment ?? {},
          createClient: input.createClient,
          resolveLaunch: (cwd) =>
            Effect.succeed({
              platform,
              command: input.launchCommand ?? "copilot",
              args: [...(input.launchArgs ?? [])],
              env: Object.fromEntries(
                Object.entries(input.environment ?? {}).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              cwd,
            }),
        }),
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

export const CopilotOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CopilotReplayTranscript,
  CopilotReplayTranscriptDecodeError
> = {
  driver: ProviderDriverKind.make(COPILOT_PROVIDER_KIND),
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeCopilotReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) => new CopilotReplayTranscriptDecodeError({ scenario: transcript.scenario, cause }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const controller = new CopilotReplayController(transcript);
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
        return layer({ createClient: makeReplayCreateClient(controller) });
      }),
    ),
};
