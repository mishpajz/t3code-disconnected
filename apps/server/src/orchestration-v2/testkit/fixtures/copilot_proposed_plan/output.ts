import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { COPILOT_PROPOSED_PLAN_PROMPT } from "./input.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Plan mode sends agentMode plan; Copilot's exit_plan_mode request becomes the plan card. */
export function assertCopilotProposedPlanOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const send = transcript.entries.find(
    (entry) => entry.type === "expect_outbound" && field(entry.frame, "type") === "session.send",
  );
  assert.equal(
    field(field(send?.type === "expect_outbound" ? send.frame : undefined, "input"), "agentMode"),
    "plan",
  );
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [COPILOT_PROPOSED_PLAN_PROMPT]);
  const proposedPlans = projection.plans.filter((plan) => plan.kind === "proposed_plan");
  assert.isAtLeast(proposedPlans.length, 1);
  assert.match(proposedPlans.at(-1)?.markdown ?? "", /fixture/iu);
  assert.equal(proposedPlans.at(-1)?.status, "active");
  const answers = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === "exitPlanMode.respond"
      ? [field(field(entry.frame, "result"), "approved")]
      : [],
  );
  assert.isNotEmpty(answers);
  assert.isTrue(
    answers.every((approved) => approved === false),
    "T3 never lets Copilot leave plan mode on its own",
  );
}
