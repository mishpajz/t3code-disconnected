import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_PROMPT,
} from "../shared.ts";

/** Copilot's task tool becomes the subagent row; the subagent's own loop fills its child thread. */
export function assertCopilotSubagentV2Output(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [SUBAGENT_V2_PROMPT]);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["completed"],
  );
  assert.lengthOf(projection.subagents, 1);
  assert.lengthOf(result.shellSnapshot.threads, 2);
  assert.isFalse(
    projection.turnItems.some((item) => item.type === "dynamic_tool" && item.title === "task"),
  );

  const subagent = projection.subagents[0]!;
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.driver, "copilot");
  assert.equal(subagent.status, "completed");
  assert.isNotEmpty(subagent.prompt);
  assert.match(subagent.result ?? "", /^Hello\.?$/u);
  assert.isNotNull(subagent.completedAt);
  if (subagent.childThreadId === null) throw new Error("The subagent has no child thread");

  const child = result.projections.get(subagent.childThreadId);
  if (child === undefined) throw new Error("The child thread has no projection");
  assert.equal(child.thread.lineage.parentThreadId, projection.thread.id);
  assert.equal(child.thread.lineage.relationshipToParent, "subagent");
  assert.lengthOf(child.runs, 0);
  assert.deepEqual(child.messages.at(0)?.role, "user");
  assert.deepEqual(child.messages.at(-1)?.text, subagent.result);
  const reply = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.match(reply?.type === "assistant_message" ? reply.text : "", /Hello/u);
}
