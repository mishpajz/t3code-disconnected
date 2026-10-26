import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  projectionFor,
} from "../shared.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function assertCopilotProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const created = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" &&
    field(entry.frame, "type") === "return" &&
    field(entry.frame, "call") === "session.create"
      ? [field(field(entry.frame, "value"), "sessionId")]
      : [],
  );
  const resumed = outbound.flatMap((frame) =>
    field(frame, "type") === "session.resume" ? [field(frame, "sessionId")] : [],
  );
  assert.lengthOf(created, 1);
  assert.deepEqual(resumed, created, "the reopened session must resume the first Copilot session");

  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, created[0]);
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.include(answers.at(-1), "provider thread resume fixture first turn complete");
  assert.include(answers.at(-1), "provider thread resume fixture second turn complete");
}
