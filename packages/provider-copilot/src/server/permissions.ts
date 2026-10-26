import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
} from "@t3tools/contracts";

import type { CopilotPermissionRequest, CopilotPermissionResult } from "./sdk.ts";

const DECLINE_FEEDBACK = "The user declined this tool call. Continue without it.";

export interface CopilotApprovalPresentation {
  readonly kind: ProviderRequestKind;
  readonly prompt: string;
  readonly options: ReadonlyArray<ProviderApprovalOption>;
}

/** The session-wide grant Copilot can remember for this request, if any. */
function sessionApproval(request: CopilotPermissionRequest) {
  switch (request.kind) {
    case "shell":
      return request.canOfferSessionApproval
        ? {
            kind: "commands" as const,
            commandIdentifiers: request.commands.map((command) => command.identifier),
          }
        : undefined;
    case "write":
      return request.canOfferSessionApproval ? { kind: "write" as const } : undefined;
    case "read":
      return { kind: "read" as const };
    case "mcp":
      return { kind: "mcp" as const, serverName: request.serverName, toolName: request.toolName };
    default:
      return undefined;
  }
}

export function copilotApprovalPresentation(
  request: CopilotPermissionRequest,
): CopilotApprovalPresentation {
  const sessionOption = sessionApproval(request)
    ? [{ decision: "acceptForSession" as const, label: "Allow for this session" }]
    : [];
  const options: ReadonlyArray<ProviderApprovalOption> = [
    { decision: "accept", label: "Allow once" },
    ...sessionOption,
    { decision: "decline", label: "Deny" },
    { decision: "cancel", label: "Deny and stop" },
  ];
  switch (request.kind) {
    case "shell":
      return { kind: "command", prompt: request.fullCommandText, options };
    case "read":
      return { kind: "file-read", prompt: request.path, options };
    case "write":
      return { kind: "file-change", prompt: request.fileName, options };
    case "mcp":
      return {
        kind: "permission",
        prompt: `${request.serverName}: ${request.toolTitle || request.toolName}`,
        options,
      };
    case "url":
      return { kind: "permission", prompt: request.url, options };
    default: {
      const intention = "intention" in request ? request.intention : undefined;
      const toolName = "toolName" in request ? request.toolName : undefined;
      return {
        kind: "permission",
        prompt:
          (typeof intention === "string" && intention) ||
          (typeof toolName === "string" && toolName) ||
          `Copilot requests ${request.kind} permission`,
        options,
      };
    }
  }
}

export function copilotPermissionResult(
  request: CopilotPermissionRequest,
  decision: ProviderApprovalDecision,
  feedback?: string,
): CopilotPermissionResult | undefined {
  switch (decision) {
    case "accept":
      return { kind: "approve-once" };
    case "acceptForSession": {
      const approval = sessionApproval(request);
      return approval ? { kind: "approve-for-session", approval } : undefined;
    }
    // Copilot ends the whole turn on a reject without feedback, so only cancel omits it.
    case "decline":
      return { kind: "reject", feedback: feedback?.trim() || DECLINE_FEEDBACK };
    case "cancel":
      return { kind: "reject" };
    default:
      return undefined;
  }
}
