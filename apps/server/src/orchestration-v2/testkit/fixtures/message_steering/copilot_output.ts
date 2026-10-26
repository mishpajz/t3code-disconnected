import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The steer is an immediate send into the running Copilot turn, not an abort or a new turn. */
export function assertCopilotMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const sends = outbound.filter((frame) => field(frame, "type") === "session.send");
  assert.deepEqual(
    sends.map((frame) => [
      field(field(frame, "input"), "prompt"),
      field(field(frame, "input"), "mode"),
    ]),
    [
      [MESSAGE_STEERING_INITIAL_PROMPT, undefined],
      [MESSAGE_STEERING_STEER_PROMPT, "immediate"],
    ],
  );
  assert.isFalse(outbound.some((frame) => field(frame, "type") === "session.interrupt"));
  const userMessages = transcript.entries.flatMap((entry) => {
    const event = entry.type === "emit_inbound" ? field(entry.frame, "event") : undefined;
    return field(event, "type") === "user.message" ? [field(event, "data")] : [];
  });
  assert.deepEqual(
    userMessages.map((data) => [field(data, "content"), field(data, "delivery")]),
    [
      [MESSAGE_STEERING_INITIAL_PROMPT, "idle"],
      [MESSAGE_STEERING_STEER_PROMPT, "steering"],
    ],
  );

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assert.lengthOf(projection.providerTurns, 1, "active steering must not start a provider turn");
  assert.equal(projection.providerTurns[0]?.status, "completed");
  assertAssistantTextIncludes(projection, "steering fixture observed");
}
