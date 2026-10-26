import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { TEXT_SESSION_PREFIX, type CopilotClientPool } from "./clientPool.ts";
import {
  type CopilotSdkClient,
  type CopilotTextSession,
  type CopilotTextSessionOptions,
  type SessionEvent,
} from "./sdk.ts";
import {
  addModelUsage,
  compactionUsage,
  isCompactionUsage,
  type CopilotTokenCounts,
  type CopilotUsageRecorder,
} from "./usage.ts";

const PROVIDER_LABEL = "GitHub Copilot";
const DEFAULT_TIMEOUT_MS = 180_000;
const CLEANUP_STEP_TIMEOUT = "10 seconds";
// How long a creation may keep the CLI after its request ended before the CLI is killed.
const CREATION_GRACE = "60 seconds";
// Copilot names its search tool per model (grep, or rg); an allowlist cannot enable a writer.
const READ_ONLY_TOOLS = ["view", "glob", "grep", "rg"];
const isTextGenerationError = Schema.is(TextGenerationError);
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const shuttingDown = new ProviderAdapter.ProviderAdapterProtocolError({
  driver: ProviderDriverKind.make("copilot"),
  detail: `${PROVIDER_LABEL} is shutting down.`,
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The reply text, or why the session produced none T3 can use. */
function copilotTextReply(
  events: ReadonlyArray<SessionEvent>,
  toolsAllowed: boolean,
): { readonly text: string } | { readonly failure: string } {
  let text = "";
  for (const event of events) {
    const data = record(event.data);
    if (event.type === "session.error")
      return {
        failure: `${PROVIDER_LABEL} failed while generating text: ${String(data.message ?? "unknown error")}`,
      };
    if (event.type === "tool.execution_start" && !toolsAllowed)
      return { failure: `${PROVIDER_LABEL} tried to use a tool during text generation.` };
    if (
      event.type === "assistant.message" &&
      typeof data.content === "string" &&
      data.content.trim()
    )
      text = data.content;
  }
  return text.trim()
    ? { text }
    : { failure: `${PROVIDER_LABEL} returned empty text generation output.` };
}

/**
 * Creation cannot be cancelled, so a keeper fiber owns the lease and the session from acquisition.
 * When the request ends or `keepers` closes, it retires the session and disposes of it; a creation
 * still pending after the grace period, or at closing, means a wedged CLI, so it kills that client.
 */
const openTextSession = Effect.fn("CopilotTextGeneration.openSession")(function* (
  pool: CopilotClientPool,
  keepers: Scope.Scope,
  options: Omit<CopilotTextSessionOptions, "sessionId">,
) {
  const opened = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const client = yield* pool.acquire;
      if (keepers.state._tag === "Closed") {
        yield* pool.release(client);
        return yield* shuttingDown;
      }
      // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off -- Names a Copilot session; nothing replays it.
      const sessionId = `${TEXT_SESSION_PREFIX}${crypto.randomUUID()}`;
      pool.textSessions.add(sessionId);
      const creation = client.createTextSession({ ...options, sessionId });
      let created: "pending" | "failed" | CopilotTextSession = "pending";
      const settled = creation.then(
        (session) => {
          created = session;
        },
        () => {
          created = "failed";
        },
      );
      const state = { retired: false };
      const dispose = Effect.suspend(() => {
        state.retired = true;
        if (created === "pending")
          return pool.invalidate(client, "a text generation session was never created");
        return closeTextSession(
          client,
          sessionId,
          created === "failed" ? Option.none() : Option.some(created),
        );
      });
      const finished = yield* Deferred.make<void>();
      // Forked uninterruptible so it runs even when `keepers` closes first; it waits interruptibly,
      // and once interrupted it no longer waits at all.
      const keeper = yield* Deferred.await(finished).pipe(
        Effect.andThen(Effect.promise(() => settled).pipe(Effect.timeout(CREATION_GRACE))),
        Effect.interruptible,
        Effect.exit,
        Effect.andThen(dispose),
        // Once disposed of, a session left in Copilot's history is the next sweep's to delete.
        Effect.ensuring(Effect.sync(() => pool.textSessions.delete(sessionId))),
        Effect.ensuring(pool.release(client)),
        Effect.forkIn(keepers, { uninterruptible: true }),
      );
      return { creation, state, finished, keeper };
    }),
    ({ finished, keeper }) =>
      Deferred.done(finished, Exit.void).pipe(
        Effect.andThen(Fiber.await(keeper).pipe(Effect.timeout(CLEANUP_STEP_TIMEOUT))),
        Effect.ignore,
      ),
  );
  const session = yield* Effect.tryPromise(() => opened.creation);
  return { session, state: opened.state };
});

const closeTextSession = Effect.fn("CopilotTextGeneration.closeSession")(function* (
  client: CopilotSdkClient,
  sessionId: string,
  session: Option.Option<CopilotTextSession>,
) {
  const step = (label: string, run: () => Promise<void>) =>
    Effect.tryPromise(run).pipe(
      Effect.timeout(CLEANUP_STEP_TIMEOUT),
      Effect.catch((cause) =>
        Effect.logWarning(`Copilot text session ${label} failed`, sessionId, cause),
      ),
    );
  if (Option.isSome(session)) {
    yield* step("abort", () => session.value.abort());
    yield* step("disconnect", () => session.value.disconnect());
  }
  yield* step("deletion", () => client.deleteSession(sessionId));
});

/**
 * Each request runs in a short-lived Copilot session on the instance's CLI. Plain requests
 * get no tools; review guides get only Copilot's own file reading and search tools.
 */
export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(
  function* (options: {
    readonly clientPool: CopilotClientPool;
    readonly recordUsage?: CopilotUsageRecorder;
    readonly timeoutMs?: number;
  }) {
    // Parallel, so closing the instance waits about as long as its slowest text session.
    const keepers = yield* Scope.fork(yield* Effect.scope, "parallel");
    const runJson = Effect.fn("CopilotTextGeneration.runJson")(
      function* <S extends Schema.Top>(request: TextGenerationOperations.Request<S>) {
        const failure = (detail: string, cause?: unknown) =>
          new TextGenerationError({
            operation: request.operation,
            detail,
            ...(cause === undefined ? {} : { cause }),
          });
        const investigate = request.investigate !== undefined;
        const { session, state } = yield* openTextSession(options.clientPool, keepers, {
          model: request.modelSelection.model,
          workingDirectory: request.cwd,
          builtInTools: investigate ? READ_ONLY_TOOLS : [],
          instructions: [
            "You write text for T3 Code.",
            investigate
              ? "Inspect the checkout only with your read-only tools. Do not ask questions."
              : "Use only the input you are given. Do not use tools or ask questions.",
            "Return only the requested JSON object.",
          ].join(" "),
        }).pipe(
          Effect.mapError((cause) =>
            isProtocolError(cause)
              ? failure(cause.detail, cause)
              : failure(`${PROVIDER_LABEL} could not open a text generation session.`, cause),
          ),
        );
        const events = yield* Effect.tryPromise({
          // A keeper retires its session before disposing of it, so nothing runs one it gave up.
          try: () =>
            state.retired
              ? Promise.reject(new Error("The text generation session was retired"))
              : session.run(request.prompt),
          catch: (cause) => failure(`${PROVIDER_LABEL} could not generate text.`, cause),
        });
        if (options.recordUsage) {
          const byModel = new Map<string, CopilotTokenCounts>();
          for (const event of events) {
            const data = record(event.data);
            if (event.type === "assistant.usage" && !isCompactionUsage(data))
              addModelUsage(byModel, data.model, data);
            const compaction =
              event.type === "session.compaction_complete" ? compactionUsage(data) : undefined;
            if (compaction)
              yield* options.recordUsage({ sessionId: session.sessionId, ...compaction });
          }
          for (const [model, usage] of byModel)
            yield* options.recordUsage({ sessionId: session.sessionId, model, usage });
        }
        const reply = copilotTextReply(events, investigate);
        if ("failure" in reply) return yield* failure(reply.failure);
        return yield* TextGenerationOperations.decodeJsonReply(request, PROVIDER_LABEL, reply.text);
      },
      (effect, request) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: request.investigate?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: request.operation,
                  detail: `${PROVIDER_LABEL} did not finish text generation in time.`,
                }),
              ),
          }),
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: request.operation,
                  detail: `${PROVIDER_LABEL} text generation failed.`,
                  cause,
                }),
          ),
        ),
    );
    return TextGenerationOperations.fromRunner("CopilotTextGeneration", runJson);
  },
);
