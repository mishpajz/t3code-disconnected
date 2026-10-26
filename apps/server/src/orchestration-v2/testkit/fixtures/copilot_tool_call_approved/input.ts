import type { OrchestratorFixtureInput } from "../shared.ts";
import { toolCallReadOnlyOnRequestInput } from "../tool_call_read_only_on_request/input.ts";

/** Supervised mode leaves approve-all off, so Copilot asks T3 before the write. */
export function copilotToolCallApprovedInput(): OrchestratorFixtureInput {
  return { ...toolCallReadOnlyOnRequestInput(), runtimeMode: "approval-required" };
}
