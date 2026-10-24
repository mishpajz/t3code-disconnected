// t3code-disconnected: application text generation for ACP Registry instances (DISCONNECTED.md).
import { TextGenerationError } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { acpRegistryProbeFailure } from "./probe.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
const PROVIDER_LABEL = "The ACP agent";
const isTextGenerationError = Schema.is(TextGenerationError);

export interface AcpRegistryTextGenerationOptions {
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

type TextRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"];

/**
 * Generic ACP agents cannot be confined to read-only tools, so each request runs one
 * tool-less prompt in a fresh agent process and aborts as soon as the agent reaches for a
 * tool, a permission, or user input.
 */
export const makeAcpRegistryTextGeneration = Effect.fn("makeAcpRegistryTextGeneration")(function* (
  options: AcpRegistryTextGenerationOptions,
) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const customModels = readCustomModelEntries(options.settings.customModels).map(
    (entry) => entry.slug,
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const applyModel = Effect.fn("AcpRegistryTextGeneration.applyModel")(function* (
    runtime: TextRuntime,
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    model: string,
  ): Effect.fn.Return<boolean, EffectAcpErrors.AcpError> {
    const isCustomModel = customModels.includes(model);
    const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
    if (modelOption !== undefined) {
      if (modelOption.currentValue === model) return true;
      if (
        !isCustomModel &&
        !flattenSelectChoices(modelOption.options).some((choice) => choice.value === model)
      ) {
        return false;
      }
      yield* runtime.setConfigOption(modelOption.id, model);
      return true;
    }
    const modelState = started.sessionSetupResult.models;
    if (modelState == null) return false;
    if (modelState.currentModelId === model) return true;
    if (!isCustomModel && !modelState.availableModels.some((entry) => entry.modelId === model)) {
      return false;
    }
    yield* runtime.setSessionModel(model);
    return true;
  });

  const runJson = Effect.fn("AcpRegistryTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) {
      const { operation } = input;
      const failure = (detail: string, cause?: unknown) =>
        new TextGenerationError({
          operation,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });

      const resolved = yield* catalog
        .resolve(options.settings, input.cwd, options.environment)
        .pipe(
          Effect.mapError((cause) =>
            failure(`Could not start the ACP agent for text generation: ${cause.detail}`, cause),
          ),
        );
      const runtimeContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: resolved.spawn,
          cwd: input.cwd,
          // No fs, terminal, auth, or elicitation capabilities: the helper only reads text.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code-text-generation", version: "0.0.0" },
          // A background title or commit message must not start an interactive sign-in.
          authenticateOnAuthRequired: false,
          ...(options.settings.authMethodId ? { authMethodId: options.settings.authMethodId } : {}),
          customModels,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Layer.succeed(Crypto.Crypto, crypto),
            ),
          ),
        ),
      ).pipe(
        Effect.mapError((cause) =>
          failure(
            cause._tag === "AcpSpawnError"
              ? `Could not start the ACP command '${resolved.spawn.command}'. Check the executable in provider settings.`
              : "Could not start the ACP agent for text generation.",
            cause,
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(runtimeContext),
      );

      const output = yield* Ref.make("");
      const sessionIdRef = yield* Ref.make<string | undefined>(undefined);
      const permissionRequested = yield* Ref.make(false);
      const rejected = yield* Deferred.make<never, TextGenerationError>();
      const reject = (detail: string) =>
        Deferred.fail(rejected, failure(detail)).pipe(Effect.asVoid);
      const rejectClientRequest = () =>
        reject(`${PROVIDER_LABEL} tried to use a tool during text generation.`).pipe(
          Effect.andThen(
            Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32601,
                errorMessage: "Tools are disabled for text generation.",
              }),
            ),
          ),
        );

      // Answer first and fail after the prompt returns, so the agent sees the rejection.
      yield* runtime.handleRequestPermission((request: EffectAcpSchema.RequestPermissionRequest) =>
        Ref.set(permissionRequested, true).pipe(
          Effect.as({
            outcome: Option.match(
              Option.fromNullishOr(
                request.options.find(
                  (option) => option.kind === "reject_once" || option.kind === "reject_always",
                ),
              ),
              {
                onNone: () => ({ outcome: "cancelled" as const }),
                onSome: (option) => ({ outcome: "selected" as const, optionId: option.optionId }),
              },
            ),
          }),
        ),
      );
      yield* runtime.handleElicitation(() =>
        reject(`${PROVIDER_LABEL} asked for user input during text generation.`).pipe(
          Effect.as({ action: "decline" as const }),
        ),
      );
      yield* runtime.handleReadTextFile(rejectClientRequest);
      yield* runtime.handleWriteTextFile(rejectClientRequest);
      yield* runtime.handleCreateTerminal(rejectClientRequest);
      yield* runtime.handleTerminalOutput(rejectClientRequest);
      yield* runtime.handleTerminalWaitForExit(rejectClientRequest);
      yield* runtime.handleTerminalKill(rejectClientRequest);
      yield* runtime.handleTerminalRelease(rejectClientRequest);
      yield* runtime.handleUnknownExtRequest(rejectClientRequest);
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.gen(function* () {
          const update = notification.update;
          // Agents run some tools without asking (or with tools pre-approved on their
          // command line), so stop the process at the first sign of tool work.
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            return yield* reject(`${PROVIDER_LABEL} started tool work during text generation.`);
          }
          if (
            update.sessionUpdate !== "agent_message_chunk" ||
            update.content.type !== "text" ||
            notification.sessionId !== (yield* Ref.get(sessionIdRef))
          ) {
            return;
          }
          const text = update.content.text;
          const exceeded = yield* Ref.modify(output, (current) =>
            current.length + text.length > MAX_OUTPUT_CHARS
              ? [true, current]
              : [false, current + text],
          );
          if (exceeded) {
            return yield* reject(`${PROVIDER_LABEL} exceeded the text generation output limit.`);
          }
        }),
      );

      const started = yield* runtime
        .start()
        .pipe(
          Effect.mapError((cause) =>
            acpRegistryProbeFailure(cause).reason === "authentication_failed"
              ? failure(
                  `${PROVIDER_LABEL} needs you to sign in before it can generate text. Sign in from its provider settings.`,
                  cause,
                )
              : failure(`${PROVIDER_LABEL} could not start a text generation session.`, cause),
          ),
        );
      yield* Ref.set(sessionIdRef, started.sessionId);

      const model = input.modelSelection.model.trim();
      if (model.length > 0 && model !== "default") {
        const applied = yield* applyModel(runtime, started, model).pipe(
          Effect.mapError((cause) =>
            failure(`${PROVIDER_LABEL} could not select model '${model}'.`, cause),
          ),
        );
        if (!applied) {
          return yield* failure(
            `${PROVIDER_LABEL} does not offer model '${model}'. Select another text generation model.`,
          );
        }
      }

      return yield* Effect.gen(function* () {
        const result = yield* runtime
          .prompt({
            prompt: [
              {
                type: "text",
                text: [
                  "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
                  "Return only the requested JSON object.",
                  "",
                  input.prompt,
                ].join("\n"),
              },
            ],
          })
          .pipe(
            Effect.mapError((cause) =>
              failure(`${PROVIDER_LABEL} failed while generating text.`, cause),
            ),
          );
        if (yield* Deferred.isDone(rejected)) {
          return yield* Deferred.await(rejected);
        }
        if (yield* Ref.get(permissionRequested)) {
          return yield* failure(
            `${PROVIDER_LABEL} asked for tool permission during text generation. Choose a model or agent that answers without tools.`,
          );
        }
        if (result.stopReason === "cancelled") {
          return yield* failure(`${PROVIDER_LABEL} cancelled text generation.`);
        }
        const text = (yield* Ref.get(output)).trim();
        if (text.length === 0) {
          return yield* failure(`${PROVIDER_LABEL} returned empty text generation output.`);
        }
        return yield* TextGenerationOperations.decodeJsonReply(input, PROVIDER_LABEL, text);
      }).pipe(
        Effect.onInterrupt(() => runtime.cancel.pipe(Effect.timeoutOption(2_000), Effect.ignore)),
        Effect.raceFirst(Deferred.await(rejected)),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: `${PROVIDER_LABEL} did not finish text generation within ${Math.round(timeoutMs / 1_000)} seconds.`,
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: `${PROVIDER_LABEL} text generation failed.`,
                cause,
              }),
        ),
      ),
  );

  return TextGenerationOperations.fromRunner(
    "AcpRegistryTextGeneration",
    TextGenerationOperations.withoutInvestigation("This ACP agent", runJson),
  );
});
