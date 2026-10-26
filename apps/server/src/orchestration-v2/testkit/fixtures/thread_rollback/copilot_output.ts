import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleUserMessagesExclude,
  assertVisibleUserMessagesInclude,
  projectionFor,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
} from "../shared.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Rollback rewinds Copilot to the discarded turn's user message, keeping the session. */
export function assertCopilotThreadRollbackOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "rolled_back", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2, 3]);
  assertUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    THREAD_ROLLBACK_SECOND_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesExclude(projection, [THREAD_ROLLBACK_SECOND_PROMPT]);

  const rewinds = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === "session.rewind"
      ? [field(entry.frame, "eventId")]
      : [],
  );
  const discardedTurn = projection.providerTurns.find((providerTurn) => providerTurn.ordinal === 2);
  assert.equal(discardedTurn?.nativeTurnRef?.strength, "strong");
  assert.deepEqual(rewinds, [discardedTurn?.nativeTurnRef?.nativeId]);
  assert.lengthOf(projection.providerThreads, 1);

  const finalAnswer = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.include(finalAnswer?.text, "rollback fixture first turn complete");
  assert.notInclude(finalAnswer?.text, "second turn");
}
