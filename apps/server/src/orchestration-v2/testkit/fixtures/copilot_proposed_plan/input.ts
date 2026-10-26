import type { OrchestratorFixtureInput } from "../shared.ts";

export const COPILOT_PROPOSED_PLAN_PROMPT =
  "Create a short implementation plan for adding deterministic replay fixtures to this project. Do not ask questions. Present the finished plan with exit_plan_mode.";

/** Copilot's plan mode hands its plan to exit_plan_mode rather than writing a text block. */
export function copilotProposedPlanInput(): OrchestratorFixtureInput {
  return {
    interactionMode: "plan",
    steps: [{ type: "message", text: COPILOT_PROPOSED_PLAN_PROMPT }],
  };
}
