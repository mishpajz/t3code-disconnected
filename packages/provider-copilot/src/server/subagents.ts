import { ProviderDriverKind } from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2Subagent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeSubagentChildThread,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  nativeRef,
  record,
  stringField,
  type CopilotEmit,
  type CopilotLanes,
  type Lane,
  type ToolState,
} from "./lanes.ts";
import type { SessionEvent } from "./sdk.ts";
import { addModelUsage, isCompactionUsage, type CopilotTokenCounts } from "./usage.ts";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
// Shown as a subagent row and child thread instead of a tool row.
const SUBAGENT_TOOL = "task";

export interface Subagent {
  readonly toolCallId: string;
  /** Its task call returned: at once for a background subagent, at its end for a sync one. */
  callReturned?: boolean;
  /** Its own loop can start after its task call returned, so only its events end it. */
  readonly background: boolean;
  /** The lane whose task tool started it. */
  readonly parent: Lane;
  readonly prompt: string;
  title: string;
  agentId?: string;
  child?: Lane;
  model: string | null;
  status: OrchestrationV2Subagent["status"];
  result: string | null;
  lastText?: string;
  completedAt: DateTime.Utc | null;
}

/** What subagent routing needs of the turn whose task tools start them. */
export interface SubagentTurn {
  readonly input: { readonly modelSelection: ModelSelection };
  /** By the task tool call that started each one. */
  readonly subagents: Map<string, Subagent>;
  readonly agents: Map<string, Subagent>;
  /** Every model call of the turn, subagents included, for Usage history. */
  readonly usageByModel: Map<string, CopilotTokenCounts>;
}

/** Task tools become subagent rows; Copilot's subagent events fill their child threads. */
export function makeCopilotSubagents(input: {
  readonly instanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly emit: CopilotEmit;
  readonly lanes: CopilotLanes;
  readonly nativeSessionId: () => string;
}) {
  const { instanceId, idAllocator, emit } = input;
  const {
    baseItem,
    emitNode,
    publishMessage,
    publishReasoning,
    publishTool,
    publishChildUserMessage,
  } = input.lanes;
  const publishSubagent = Effect.fnUntraced(function* (sub: Subagent) {
    const time = yield* DateTime.now;
    const base = baseItem(sub.parent, `subagent:${sub.toolCallId}`, time);
    const nativeTaskRef = nativeRef(sub.toolCallId);
    const subagent: OrchestrationV2Subagent = {
      id: base.nodeId,
      threadId: base.threadId,
      runId: base.runId,
      parentNodeId: sub.parent.rootNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: COPILOT_PROVIDER,
      providerInstanceId: instanceId,
      providerThreadId: base.providerThreadId,
      childThreadId: sub.child?.threadId ?? null,
      nativeTaskRef,
      prompt: sub.prompt,
      title: sub.title,
      model: sub.model,
      status: sub.status,
      result: sub.result,
      startedAt: base.startedAt,
      completedAt: sub.completedAt,
      updatedAt: time,
    };
    yield* emit({ type: "subagent.updated", driver: COPILOT_PROVIDER, subagent });
    yield* emitNode(
      sub.parent,
      { ...base, nativeItemRef: nativeTaskRef },
      "subagent",
      sub.status,
      sub.completedAt,
    );
    // Before the subagent's item: once a turn has ended, settling its last item closes the run's
    // event stream, and the child thread's root must already be settled by then.
    const child = sub.child;
    if (child)
      yield* emit({
        type: "node.updated",
        driver: COPILOT_PROVIDER,
        node: {
          id: child.rootNodeId,
          threadId: child.threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: child.rootNodeId,
          kind: "root_turn",
          status: sub.status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: nativeTaskRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: base.startedAt,
          completedAt: sub.completedAt,
        },
      });
    yield* emit({
      type: "turn_item.updated",
      driver: COPILOT_PROVIDER,
      turnItem: {
        ...base,
        nativeItemRef: nativeTaskRef,
        type: "subagent",
        status: sub.status,
        title: sub.title,
        completedAt: sub.completedAt,
        subagentId: subagent.id,
        origin: "provider_native",
        driver: COPILOT_PROVIDER,
        providerInstanceId: instanceId,
        childThreadId: subagent.childThreadId,
        prompt: sub.prompt,
        result: sub.result,
      },
    });
  });
  const startSubagent = Effect.fnUntraced(function* (
    turn: SubagentTurn,
    parent: Lane,
    toolCallId: string,
    args: Record<string, unknown>,
  ) {
    const prompt = stringField(args, "prompt") ?? "";
    const sub: Subagent = {
      toolCallId,
      parent,
      prompt,
      background: stringField(args, "mode") === "background",
      title: subagentThreadTitle({
        parentTitle: parent.appThread.title,
        title: stringField(args, "name", "description") ?? null,
        prompt,
        ordinal: turn.subagents.size + 1,
      }),
      model: stringField(args, "model") ?? null,
      status: "running",
      result: null,
      completedAt: null,
    };
    turn.subagents.set(toolCallId, sub);
    yield* publishSubagent(sub);
  });
  /** Copilot started the subagent's own loop, so it gets a child thread. */
  const attachSubagent = Effect.fnUntraced(function* (
    turn: SubagentTurn,
    sub: Subagent,
    agentId: string,
    data: Record<string, unknown>,
  ) {
    if (sub.child) return;
    const time = yield* DateTime.now;
    const nativeId = `${input.nativeSessionId()}:${agentId}`;
    const childThreadId = idAllocator.derive.threadFromProviderThread({
      driver: COPILOT_PROVIDER,
      providerInstanceId: instanceId,
      nativeThreadId: nativeId,
    });
    sub.agentId = agentId;
    sub.model = stringField(data, "model") ?? sub.model;
    const appThread = makeSubagentChildThread({
      parentThread: sub.parent.appThread,
      childThreadId,
      parentNodeId: baseItem(sub.parent, `subagent:${sub.toolCallId}`, time).nodeId,
      activeProviderThreadId: null,
      providerInstanceId: instanceId,
      modelSelection: turn.input.modelSelection,
      title: sub.title,
      now: time,
      createdBy: "agent",
      creationSource: "provider",
    });
    const identity = `${instanceId}:child:${nativeId}`;
    sub.child = {
      appThread,
      threadId: childThreadId,
      runId: null,
      providerThreadId: null,
      providerTurnId: null,
      rootNodeId: idAllocator.derive.nodeFromProviderItem({
        driver: COPILOT_PROVIDER,
        nativeItemId: `${identity}:root`,
      }),
      identity,
      ordinals: new Map(),
      started: new Map(),
      nextOrdinal: 1,
      messages: new Map(),
      reasoning: new Map(),
      tools: new Map(),
    };
    turn.agents.set(agentId, sub);
    yield* emit({ type: "app_thread.created", driver: COPILOT_PROVIDER, appThread });
    yield* publishSubagent(sub);
  });
  const settleSubagent = Effect.fnUntraced(function* (
    sub: Subagent,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string | null,
  ) {
    if (sub.status !== "running") return;
    for (const tool of sub.child?.tools.values() ?? []) {
      if (tool.status !== "running") continue;
      tool.status = status === "completed" ? "cancelled" : status;
      yield* publishTool(sub.child!, tool);
    }
    sub.status = status;
    sub.result = result?.trim() || null;
    sub.completedAt = yield* DateTime.now;
    yield* publishSubagent(sub);
  });

  const startTool = Effect.fnUntraced(function* (
    turn: SubagentTurn,
    lane: Lane,
    data: Record<string, unknown>,
  ) {
    const toolCallId = stringField(data, "toolCallId");
    const toolName = stringField(data, "toolName");
    if (!toolCallId || !toolName) return;
    if (toolName === SUBAGENT_TOOL)
      return yield* startSubagent(turn, lane, toolCallId, record(data.arguments));
    const mcpServerName = stringField(data, "mcpServerName");
    const mcpToolName = stringField(data, "mcpToolName");
    const tool: ToolState = {
      toolCallId,
      toolName,
      args: record(data.arguments),
      ...(mcpServerName ? { mcpServerName } : {}),
      ...(mcpToolName ? { mcpToolName } : {}),
      output: "",
      status: "running",
    };
    lane.tools.set(toolCallId, tool);
    yield* publishTool(lane, tool);
  });
  const completeTool = Effect.fnUntraced(function* (
    turn: SubagentTurn,
    lane: Lane,
    data: Record<string, unknown>,
  ) {
    const toolCallId = stringField(data, "toolCallId") ?? "";
    const result = record(data.result);
    const error = record(data.error);
    const content = stringField(result, "content");
    const errorMessage = stringField(error, "message");
    const sub = turn.subagents.get(toolCallId);
    if (sub) {
      sub.callReturned = true;
      // A background task's call returns at once; its subagent events end it.
      if (data.success !== true)
        return yield* settleSubagent(sub, "failed", errorMessage ?? content ?? null);
      if (sub.agentId === undefined && !sub.background)
        return yield* settleSubagent(sub, "completed", content ?? null);
      if (sub.status === "completed" && sub.result === null && content) {
        sub.result = content;
        yield* publishSubagent(sub);
      }
      return;
    }
    const tool = lane.tools.get(toolCallId);
    if (!tool) return;
    if (content !== undefined) tool.output = content;
    else if (errorMessage)
      tool.output = tool.output ? `${tool.output}\n${errorMessage}` : errorMessage;
    const exitCode = record(data.shellExecution).exitCode;
    if (typeof exitCode === "number") tool.exitCode = exitCode;
    tool.status = data.success === true ? "completed" : "failed";
    yield* publishTool(lane, tool);
  });

  const handleAgentEvent = Effect.fnUntraced(function* (
    turn: SubagentTurn,
    agentId: string,
    event: SessionEvent,
  ) {
    const data = record(event.data);
    if (event.type === "assistant.usage") {
      if (!isCompactionUsage(data)) addModelUsage(turn.usageByModel, data.model, data);
      return;
    }
    if (event.type === "subagent.started") {
      const sub = turn.subagents.get(stringField(data, "toolCallId") ?? "");
      if (sub) yield* attachSubagent(turn, sub, agentId, data);
      return;
    }
    const sub = turn.agents.get(agentId);
    const lane = sub?.child;
    if (!sub || !lane) return;
    switch (event.type) {
      case "subagent.completed":
        return yield* settleSubagent(
          sub,
          data.cancelled === true ? "cancelled" : "completed",
          sub.lastText ?? null,
        );
      case "subagent.failed":
        return yield* settleSubagent(sub, "failed", stringField(data, "error") ?? null);
      case "user.message": {
        const content = stringField(data, "content")?.trim();
        if (content) yield* publishChildUserMessage(lane, event.id, content);
        return;
      }
      case "assistant.message":
      case "assistant.reasoning": {
        const isMessage = event.type === "assistant.message";
        const id = stringField(data, isMessage ? "messageId" : "reasoningId");
        const content = stringField(data, "content") ?? "";
        if (!id || !content.trim()) return;
        (isMessage ? lane.messages : lane.reasoning).set(id, content);
        if (isMessage) {
          sub.lastText = content;
          yield* publishMessage(lane, id, false);
        } else yield* publishReasoning(lane, id, false);
        return;
      }
      case "tool.execution_start":
        return yield* startTool(turn, lane, data);
      case "tool.execution_complete":
        return yield* completeTool(turn, lane, data);
    }
  });
  return { settleSubagent, startTool, completeTool, handleAgentEvent };
}
