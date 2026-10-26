import type { OrchestratorFixtureInput } from "../shared.ts";
import { toolCallDeniedWriteInput } from "../tool_call_denied_write/input.ts";

export function copilotToolCallDeniedInput(): OrchestratorFixtureInput {
  return { ...toolCallDeniedWriteInput(), runtimeMode: "approval-required" };
}
