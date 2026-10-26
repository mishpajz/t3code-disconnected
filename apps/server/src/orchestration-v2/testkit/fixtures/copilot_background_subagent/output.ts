import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import { COPILOT_BACKGROUND_SUBAGENT_PROMPT } from "./input.ts";

// Copilot's main loop idles once the subagent is launched; its wake is a continuation run.
export function assertCopilotBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [COPILOT_BACKGROUND_SUBAGENT_PROMPT]);
  const [rootRun, wakeRun] = projection.runs;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.runId, rootRun?.id, "the subagent belongs to the run that launched it");
  assert.isTrue(
    projection.turnItems.some(
      (item) =>
        item.runId === rootRun?.id &&
        item.type === "assistant_message" &&
        item.text.includes("ROOT_DONE"),
    ),
  );

  // Replay delivers frames at once, so the order to check is Copilot's own: its main loop
  // idled while the subagent ran, and the wake came after the subagent finished.
  const eventTypes = transcript.entries.flatMap((entry) => {
    if (entry.type === "runtime_exit") return [];
    const frame = entry.frame as { type?: string; event?: { type?: string; agentId?: string } };
    return frame.type === "event" && frame.event?.type
      ? [`${frame.event.agentId ? "sub:" : ""}${frame.event.type}`]
      : [];
  });
  assert.isBelow(
    eventTypes.indexOf("assistant.idle"),
    eventTypes.indexOf("sub:subagent.completed"),
    "the main loop idled before the subagent finished",
  );
  assert.isBelow(
    eventTypes.indexOf("sub:subagent.completed"),
    eventTypes.indexOf("system.notification"),
  );
  const runTexts = (runId: string | undefined) =>
    projection.turnItems.flatMap((item) =>
      item.runId === runId && item.type === "assistant_message" ? [item.text] : [],
    );
  assert.isFalse(runTexts(rootRun?.id).some((text) => text.includes("SUBAGENT_DONE")));
  assert.isTrue(
    runTexts(wakeRun?.id).some((text) => text.includes("SUBAGENT_DONE")),
    "Copilot's reply to the finished subagent lands in the continuation run",
  );

  if (subagent?.childThreadId == null) throw new Error("The subagent is missing its child thread.");
  const child = result.projections.get(subagent.childThreadId);
  assert.isTrue(
    child?.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("SUBAGENT_DONE"),
    ),
    "the subagent's reply lands in its child thread after its parent run ended",
  );

  assert.lengthOf(backgroundNotifications(projection), 1);
  assert.equal(backgroundNotifications(projection)[0]?.source.kind, "subagent");
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.isTrue(
    projection.providerTurns.some(
      (turn) =>
        turn.runAttemptId !== null &&
        turn.nativeTurnRef?.nativeId?.startsWith("wake:") === true &&
        turn.status === "completed",
    ),
    "the wake runs as its own provider turn",
  );
}
