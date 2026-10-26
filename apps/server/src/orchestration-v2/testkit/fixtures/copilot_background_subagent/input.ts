import type { OrchestratorFixtureInput } from "../shared.ts";

export const COPILOT_BACKGROUND_SUBAGENT_PROMPT =
  "Use the task tool in background mode to start ONE general-purpose subagent whose prompt is: run the shell command `sleep 20` and then reply exactly SUBAGENT_DONE. As soon as it is launched, reply exactly ROOT_DONE and end your turn; do not wait for it.";

// Full access, so the subagent's command needs no approval while no turn is running.
export function copilotBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "full-access",
    steps: [
      { type: "message", text: COPILOT_BACKGROUND_SUBAGENT_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
