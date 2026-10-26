import { describe, expect, it } from "@effect/vitest";

import { copilotApprovalPresentation, copilotPermissionResult } from "./permissions.ts";
import type { CopilotPermissionRequest } from "./sdk.ts";

const shell = (canOfferSessionApproval: boolean) =>
  ({
    kind: "shell",
    fullCommandText: "npm test",
    intention: "Run tests",
    commands: [{ identifier: "npm test", readOnly: false }],
    canOfferSessionApproval,
    hasWriteFileRedirection: false,
    possiblePaths: [],
    possibleUrls: [],
  }) as CopilotPermissionRequest;

describe("Copilot permissions", () => {
  it("offers a session grant only when Copilot can remember one", () => {
    expect(
      copilotApprovalPresentation(shell(false)).options.map((option) => option.decision),
    ).toEqual(["accept", "decline", "cancel"]);
    expect(
      copilotApprovalPresentation(shell(true)).options.map((option) => option.decision),
    ).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(copilotPermissionResult(shell(false), "acceptForSession")).toBeUndefined();
    expect(copilotPermissionResult(shell(true), "acceptForSession")).toEqual({
      kind: "approve-for-session",
      approval: { kind: "commands", commandIdentifiers: ["npm test"] },
    });
  });

  it("keeps the turn going on decline and stops it on cancel", () => {
    // Copilot aborts the turn when a reject carries no feedback.
    expect(copilotPermissionResult(shell(false), "decline")).toMatchObject({
      kind: "reject",
      feedback: expect.any(String),
    });
    expect(copilotPermissionResult(shell(false), "decline", "Use yarn")).toEqual({
      kind: "reject",
      feedback: "Use yarn",
    });
    expect(copilotPermissionResult(shell(false), "cancel")).toEqual({ kind: "reject" });
  });
});
