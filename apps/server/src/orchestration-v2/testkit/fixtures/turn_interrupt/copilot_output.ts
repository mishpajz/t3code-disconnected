import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_PROMPT,
} from "../shared.ts";

export function assertCopilotTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT]);
  assert.isTrue(
    transcript.entries.some(
      (entry) =>
        entry.type === "expect_outbound" &&
        typeof entry.frame === "object" &&
        entry.frame !== null &&
        Reflect.get(entry.frame, "type") === "session.abort",
    ),
    "Stop must reach Copilot as session.abort",
  );
  assert.isFalse(projection.turnItems.some((item) => item.status === "running"));
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
