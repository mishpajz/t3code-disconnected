import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  COPILOT_START_TIMEOUT_MS,
  startCopilotClient,
  type CopilotLaunch,
  type CopilotLaunchArgumentError,
  type CopilotSdkClient,
  type CopilotSdkFactory,
} from "./sdk.ts";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
// The SDK's stop waits on every session's disconnect with no deadline of its own.
const COPILOT_STOP_TIMEOUT = "10 seconds";
/** Marks a text session's id, so a later sweep can find the ones left behind. */
export const TEXT_SESSION_PREFIX = "t3-text-";
// Another T3 process sharing Copilot's home may still use a text session this recent.
const SWEEP_MIN_AGE_MS = 30 * 60_000;
const SWEEP_BUDGET = "30 seconds";

export interface CopilotClientPool {
  readonly acquire: Effect.Effect<CopilotSdkClient, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly release: (client: CopilotSdkClient) => Effect.Effect<void>;
  /** Kills a client that cannot be trusted, whoever else holds it; its sessions see it exit. */
  readonly invalidate: (client: CopilotSdkClient, reason: string) => Effect.Effect<void>;
  /**
   * Text session ids a live keeper owns. Each new CLI sweeps Copilot's history in the background
   * for older prefixed sessions nobody owns, so a session a killed CLI could not delete goes too.
   */
  readonly textSessions: Set<string>;
}

/** Stops the CLI gracefully, or kills it when its sessions do not let go in time. */
const stopClient = (client: CopilotSdkClient) =>
  Effect.tryPromise(() => client.stop()).pipe(
    Effect.timeout(COPILOT_STOP_TIMEOUT),
    Effect.catch((cause) =>
      Effect.logWarning("Copilot CLI did not stop; killing it", cause).pipe(
        Effect.andThen(Effect.tryPromise(() => client.forceStop())),
        Effect.timeout(COPILOT_STOP_TIMEOUT),
      ),
    ),
    Effect.catch((cause) => Effect.logWarning("Copilot CLI could not be killed", cause)),
  );

/** One CLI serves every session of an instance; it stops when its last user releases it. */
export const makeCopilotClientPool = Effect.fn("makeCopilotClientPool")(function* (options: {
  readonly binaryPath: string;
  readonly createClient: CopilotSdkFactory;
  readonly resolveLaunch: Effect.Effect<CopilotLaunch | undefined, CopilotLaunchArgumentError>;
}) {
  const protocolError = (detail: string, cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: COPILOT_PROVIDER,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const lock = yield* Semaphore.make(1);
  let shared: { readonly client: CopilotSdkClient; users: number } | undefined;
  const textSessions = new Set<string>();
  const sweep = Effect.fn("CopilotClientPool.sweep")(
    function* (client: CopilotSdkClient) {
      const now = yield* Clock.currentTimeMillis;
      for (const { sessionId, modifiedAt } of yield* Effect.tryPromise(() =>
        client.listSessions(),
      )) {
        if (!sessionId.startsWith(TEXT_SESSION_PREFIX) || textSessions.has(sessionId)) continue;
        if (now - modifiedAt < SWEEP_MIN_AGE_MS) continue;
        yield* Effect.tryPromise(() => client.deleteSession(sessionId)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Copilot could not delete a left-behind text session",
              sessionId,
              cause,
            ),
          ),
        );
      }
    },
    Effect.timeout(SWEEP_BUDGET),
    Effect.catch((cause) => Effect.logWarning("Copilot text session sweep failed", cause)),
  );
  const acquire = lock.withPermits(1)(
    Effect.gen(function* () {
      if (shared) {
        shared.users += 1;
        return shared.client;
      }
      const launch = yield* options.resolveLaunch.pipe(
        Effect.mapError((cause) => protocolError(cause.message, cause)),
      );
      if (launch === undefined)
        return yield* protocolError(
          `GitHub Copilot CLI (${options.binaryPath}) was not found on this host`,
        );
      // Publishing cannot be interrupted once the CLI started, so a started CLI always has an owner.
      return yield* Effect.uninterruptibleMask((restore) =>
        restore(
          startCopilotClient(options.createClient, launch).pipe(
            Effect.timeout(COPILOT_START_TIMEOUT_MS),
            Effect.mapError((cause) => protocolError("GitHub Copilot CLI failed to start", cause)),
          ),
        ).pipe(
          Effect.tap((client) => {
            const owner = { client, users: 1 };
            shared = owner;
            void client.exited.then(() => {
              if (shared === owner) shared = undefined;
            });
            // Detached, so the pool needs no scope; its budget bounds it instead.
            return sweep(client).pipe(Effect.forkDetach);
          }),
        ),
      );
    }),
  );
  const release = (client: CopilotSdkClient) =>
    lock
      .withPermits(1)(
        Effect.sync(() => {
          if (shared?.client !== client) return false;
          shared.users -= 1;
          if (shared.users > 0) return false;
          shared = undefined;
          return true;
        }),
      )
      .pipe(Effect.flatMap((last) => (last ? stopClient(client) : Effect.void)));
  const invalidate = (client: CopilotSdkClient, reason: string) =>
    lock
      .withPermits(1)(
        Effect.sync(() => {
          if (shared?.client === client) shared = undefined;
        }),
      )
      .pipe(
        Effect.andThen(Effect.logWarning(`Killing the Copilot CLI: ${reason}`)),
        Effect.andThen(Effect.tryPromise(() => client.forceStop(new Error(reason)))),
        Effect.timeout(COPILOT_STOP_TIMEOUT),
        Effect.catch((cause) => Effect.logWarning("Copilot CLI could not be killed", cause)),
      );
  return { acquire, release, invalidate, textSessions } satisfies CopilotClientPool;
});
