#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// t3code-disconnected: fake ACP agent for textGeneration.test.ts.
import * as NodeFS from "node:fs";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

// reply | permission | tool | hang | empty | auth
const mode = process.env.T3_TEXT_AGENT_MODE ?? "reply";
const logPath = process.env.T3_TEXT_AGENT_LOG;
const sessionId = "text-session-1";
let currentModel = "large";

const log = (line: string) => {
  if (logPath) NodeFS.appendFileSync(logPath, `${line}\n`, "utf8");
};
process.once("SIGTERM", () => process.exit(0));
process.once("exit", () => log("exit"));

const configOptions = (): ReadonlyArray<AcpSchema.SessionConfigOption> => [
  {
    configId: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModel,
    options: [
      { value: "large", name: "Large" },
      { value: "small", name: "Small" },
    ],
  },
];

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;
  const message = (text: string) =>
    agent.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "text-message",
        content: { type: "text", text },
      },
    });
  const finish = agent.client
    .sessionUpdate({
      sessionId,
      update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    })
    .pipe(Effect.as({}));

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 2,
      info: { name: "t3-text-generation-fixture", version: "0.0.0" },
      capabilities: { session: {} },
    }),
  );
  yield* agent.handleCreateSession(() =>
    mode === "auth"
      ? Effect.fail(AcpError.AcpRequestError.authRequired())
      : Effect.succeed({ sessionId, configOptions: configOptions() }),
  );
  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.sync(() => {
      if (request.configId === "model" && typeof request.value === "string") {
        currentModel = request.value;
        log(`model:${currentModel}`);
      }
      return { configOptions: configOptions() };
    }),
  );
  yield* agent.handleCancel(() => Effect.sync(() => log("cancel")));
  yield* agent.handlePrompt(() =>
    Effect.gen(function* () {
      log("prompt");
      if (mode === "hang") return yield* Effect.never;
      if (mode === "permission") {
        const permission = yield* agent.client.requestPermission({
          sessionId,
          title: "`rm -rf build`",
          subject: {
            type: "tool_call",
            toolCall: { toolCallId: "tool-1", title: "`rm -rf build`", kind: "execute" },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        const outcome = permission.outcome;
        log(`permission:${outcome.outcome === "selected" ? outcome.optionId : outcome.outcome}`);
      }
      if (mode === "tool") {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            title: "Edit file",
            kind: "edit",
            status: "pending",
            rawInput: {},
          },
        });
        return yield* Effect.never;
      }
      if (mode !== "empty") {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Thinking about it." },
          },
        });
        yield* message('{"title": "Title from ');
        yield* message(`${currentModel}"}`);
      }
      return yield* finish;
    }),
  );
  return yield* Effect.never;
}).pipe(
  Effect.provide(EffectAcpAgent.layerStdio()),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
