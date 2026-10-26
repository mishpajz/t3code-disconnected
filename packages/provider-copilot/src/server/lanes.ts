import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItemStatus,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");

// Copilot's own bookkeeping tools; T3 shows their effect as plan, question, or todo rows.
export const HIDDEN_TOOLS = new Set(["report_intent", "exit_plan_mode", "ask_user", "sql"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);
const FILE_CHANGE_TOOLS = new Set(["create", "edit", "str_replace", "str_replace_editor", "write"]);

export interface ToolState {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
  output: string;
  status: OrchestrationV2TurnItemStatus;
  exitCode?: number;
}

/** Where items land: the root turn, or a subagent's child thread. */
export interface Lane {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly rootNodeId: NodeId;
  /** Prefix of every item identity in this lane. */
  readonly identity: string;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  nextOrdinal: number;
  readonly messages: Map<string, string>;
  readonly reasoning: Map<string, string>;
  readonly tools: Map<string, ToolState>;
}

export const nativeRef = (nativeId: string) => ({
  driver: COPILOT_PROVIDER,
  nativeId,
  strength: "strong" as const,
});

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(value: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string") return entry;
  }
  return undefined;
}

export type CopilotEmit = (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;

/** Item identity and message, reasoning, and tool rows, for a root turn or a child thread. */
export function makeCopilotLanes(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly emit: CopilotEmit;
}) {
  const { idAllocator, emit } = input;
  // Per-event helpers run for every streamed SDK event; spans would be too frequent.
  const baseItem = (lane: Lane, key: string, time: DateTime.Utc) => {
    if (!lane.ordinals.has(key)) lane.ordinals.set(key, lane.nextOrdinal++);
    if (!lane.started.has(key)) lane.started.set(key, time);
    const identity = `${lane.identity}:${key}`;
    return {
      id: idAllocator.derive.turnItemFromProviderItem({
        driver: COPILOT_PROVIDER,
        nativeItemId: identity,
      }),
      nodeId: idAllocator.derive.nodeFromProviderItem({
        driver: COPILOT_PROVIDER,
        nativeItemId: identity,
      }),
      threadId: lane.threadId,
      runId: lane.runId,
      providerThreadId: lane.providerThreadId,
      providerTurnId: lane.providerTurnId,
      nativeItemRef: nativeRef(key.slice(key.indexOf(":") + 1)),
      parentItemId: null,
      ordinal: lane.ordinals.get(key)!,
      startedAt: lane.started.get(key)!,
      updatedAt: time,
    };
  };
  const emitNode = (
    lane: Lane,
    base: Omit<ReturnType<typeof baseItem>, "nativeItemRef"> & {
      readonly nativeItemRef: OrchestrationV2ExecutionNode["nativeItemRef"];
    },
    kind: OrchestrationV2ExecutionNode["kind"],
    status: OrchestrationV2TurnItemStatus,
    completedAt: DateTime.Utc | null,
  ) =>
    emit({
      type: "node.updated",
      driver: COPILOT_PROVIDER,
      node: {
        id: base.nodeId,
        threadId: base.threadId,
        runId: base.runId,
        parentNodeId: lane.rootNodeId,
        rootNodeId: lane.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: base.providerThreadId,
        providerTurnId: base.providerTurnId,
        nativeItemRef: base.nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: base.startedAt,
        completedAt,
      },
    });

  const publishMessage = Effect.fnUntraced(function* (
    lane: Lane,
    messageId: string,
    streaming: boolean,
  ) {
    const text = lane.messages.get(messageId) ?? "";
    if (!text) return;
    const time = yield* DateTime.now;
    const key = `message:${messageId}`;
    const base = baseItem(lane, key, time);
    const status = streaming ? "running" : "completed";
    const completedAt = streaming ? null : time;
    const conversationMessageId = idAllocator.derive.messageFromProviderItem({
      driver: COPILOT_PROVIDER,
      nativeItemId: `${lane.identity}:${key}`,
    });
    const message: OrchestrationV2ConversationMessage = {
      id: conversationMessageId,
      threadId: lane.threadId,
      runId: lane.runId,
      nodeId: base.nodeId,
      role: "assistant",
      text,
      attachments: [],
      streaming,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: base.startedAt,
      updatedAt: time,
    };
    yield* emit({ type: "message.updated", driver: COPILOT_PROVIDER, message });
    yield* emitNode(lane, base, "assistant_message", status, completedAt);
    yield* emit({
      type: "turn_item.updated",
      driver: COPILOT_PROVIDER,
      turnItem: {
        ...base,
        type: "assistant_message",
        status,
        title: null,
        completedAt,
        messageId: conversationMessageId,
        text,
        streaming,
      },
    });
  });
  const publishReasoning = Effect.fnUntraced(function* (
    lane: Lane,
    reasoningId: string,
    streaming: boolean,
  ) {
    const text = lane.reasoning.get(reasoningId) ?? "";
    if (!text.trim()) return;
    const time = yield* DateTime.now;
    const base = baseItem(lane, `reasoning:${reasoningId}`, time);
    const status = streaming ? "running" : "completed";
    const completedAt = streaming ? null : time;
    yield* emitNode(lane, base, "reasoning", status, completedAt);
    yield* emit({
      type: "turn_item.updated",
      driver: COPILOT_PROVIDER,
      turnItem: {
        ...base,
        type: "reasoning",
        status,
        title: null,
        completedAt,
        text,
        streaming,
      },
    });
  });
  const toolPresentation = (tool: ToolState) => {
    const args = tool.args;
    if (SHELL_TOOLS.has(tool.toolName)) {
      return {
        type: "command_execution" as const,
        input: stringField(args, "command") ?? "",
        output: tool.output,
        ...(tool.exitCode === undefined ? {} : { exitCode: tool.exitCode }),
      };
    }
    const fileName = stringField(args, "path", "file_path", "filePath")?.trim();
    if (FILE_CHANGE_TOOLS.has(tool.toolName) && fileName) {
      const oldStr = stringField(args, "old_str", "old_string");
      const newStr = stringField(args, "new_str", "new_string", "file_text", "content");
      return {
        type: "file_change" as const,
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
      };
    }
    if (tool.mcpServerName) {
      const toolName = `mcp__${tool.mcpServerName}__${tool.mcpToolName ?? tool.toolName}`;
      return {
        type: "dynamic_tool" as const,
        toolName,
        input: args,
        output: tool.output,
        ...mcpToolPresentation({ toolName, serverName: tool.mcpServerName }),
      };
    }
    return {
      type: "dynamic_tool" as const,
      toolName: tool.toolName,
      input: args,
      output: tool.output,
    };
  };
  const publishTool = Effect.fnUntraced(function* (lane: Lane, tool: ToolState) {
    if (HIDDEN_TOOLS.has(tool.toolName)) return;
    const time = yield* DateTime.now;
    const base = baseItem(lane, `tool:${tool.toolCallId}`, time);
    const settled = tool.status !== "running" && tool.status !== "pending";
    const completedAt = settled ? time : null;
    const presentation = toolPresentation(tool);
    yield* emitNode(lane, base, "tool_call", tool.status, completedAt);
    yield* emit({
      type: "turn_item.updated",
      driver: COPILOT_PROVIDER,
      turnItem: {
        ...base,
        title: tool.toolName,
        ...presentation,
        status: tool.status,
        completedAt,
      },
    });
  });

  const publishChildUserMessage = Effect.fnUntraced(function* (
    lane: Lane,
    eventId: string,
    text: string,
  ) {
    const time = yield* DateTime.now;
    const key = `user:${eventId}`;
    const base = baseItem(lane, key, time);
    const artifacts = makeSubagentConversationArtifacts({
      messageId: idAllocator.derive.messageFromProviderItem({
        driver: COPILOT_PROVIDER,
        nativeItemId: `${lane.identity}:${key}`,
      }),
      senderThreadId: lane.appThread.lineage.parentThreadId ?? lane.threadId,
      turnItemId: base.id,
      threadId: lane.threadId,
      rootNodeId: lane.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: nativeRef(eventId),
      role: "user",
      text,
      ordinal: base.ordinal,
      now: time,
    });
    yield* emit({
      type: "message.updated",
      driver: COPILOT_PROVIDER,
      message: artifacts.message,
    });
    yield* emit({
      type: "turn_item.updated",
      driver: COPILOT_PROVIDER,
      turnItem: artifacts.turnItem,
    });
  });
  return {
    baseItem,
    emitNode,
    publishMessage,
    publishReasoning,
    publishTool,
    publishChildUserMessage,
  };
}

export type CopilotLanes = ReturnType<typeof makeCopilotLanes>;
