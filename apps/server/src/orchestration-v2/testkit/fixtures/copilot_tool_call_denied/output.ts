import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { TOOL_CALL_DENIED_WRITE_PROMPT } from "../tool_call_denied_write/input.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** A decline reaches Copilot as its native reject, and the denied tool row fails. */
export function assertCopilotToolCallDeniedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_DENIED_WRITE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.decision),
    ["decline"],
  );
  const responses = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === "permission.respond"
      ? [field(field(entry.frame, "result"), "kind")]
      : [],
  );
  assert.deepEqual(responses, ["reject"]);
  const denied = projection.turnItems.filter(
    (item) =>
      (item.type === "file_change" || item.type === "command_execution") &&
      item.status === "failed",
  );
  assert.isNotEmpty(denied, "the denied tool call must settle as failed");
}
