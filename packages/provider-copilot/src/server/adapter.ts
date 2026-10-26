import {
  ProviderDriverKind,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Notification,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type PlanId,
  type ProviderInstanceId,
  type RuntimeRequestId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type { CopilotSettings } from "../settings.ts";
import { makeCopilotClientPool, type CopilotClientPool } from "./clientPool.ts";
import { copilotApprovalPresentation, copilotPermissionResult } from "./permissions.ts";
import {
  HIDDEN_TOOLS,
  makeCopilotLanes,
  nativeRef,
  record,
  stringField,
  type Lane,
} from "./lanes.ts";
import {
  COPILOT_START_TIMEOUT_MS,
  isCopilotRequestRejected,
  makeCopilotSdkClient,
  resolveCopilotLaunch,
  type CopilotLaunch,
  type CopilotLaunchArgumentError,
  type CopilotPermissionRequest,
  type CopilotPermissionResult,
  type CopilotContextTier,
  type CopilotReasoningEffort,
  type CopilotSdkFactory,
  type CopilotSdkSession,
  type CopilotSendInput,
  type CopilotSessionHandlers,
  type CopilotSessionOptions,
  type CopilotTodoRow,
  type CopilotUserInputRequest,
  type CopilotUserInputResponse,
  type ExitPlanModeRequest,
  type ExitPlanModeResult,
  type SessionEvent,
} from "./sdk.ts";
import { hasSkillMention, planCopilotSkillInvocation } from "./skills.ts";
import { makeCopilotSubagents, type Subagent, type SubagentTurn } from "./subagents.ts";
import {
  addModelUsage,
  addUsage,
  compactionUsage,
  emptyCounts,
  isCompactionUsage,
  type CopilotTokenCounts,
  type CopilotUsageRecorder,
} from "./usage.ts";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");

const CopilotProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CopilotAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly createClient?: CopilotSdkFactory;
  readonly resolveLaunch?: (
    cwd: string,
  ) => Effect.Effect<CopilotLaunch | undefined, CopilotLaunchArgumentError>;
  readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger;
  /** Shared with text generation so both use one CLI. */
  readonly clientPool?: CopilotClientPool;
  readonly recordUsage?: CopilotUsageRecorder;
}

const PLAN_CAPTURED_FEEDBACK =
  "T3 Code captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";
const NO_ACTIVE_TURN_FEEDBACK = "T3 Code has no active turn to show this request in.";
const USAGE_LIMIT_ERROR_TYPES = new Set(["quota", "rate_limit"]);
const REWIND_TRUNCATED = new Set(["success", "checkpoint-cleanup-failed", "snapshot-prune-failed"]);
/** How long a Copilot RPC, or a stop until Copilot idles, may take before T3 gives up on its state. */
const COPILOT_SETTLE_TIMEOUT = "10 seconds";
/** Opening a turn waits like a CLI start: a freshly resumed session still loads its MCP servers. */
const COPILOT_OPEN_TIMEOUT = COPILOT_START_TIMEOUT_MS;
/** Main-agent events no T3 send explains: a prompt from the user's own CLI, or a wake. */
const MAIN_LOOP_STARTS = new Set(["user.message", "assistant.turn_start", "system.notification"]);
/** Native ref prefixes of turns with no prompt of their own in Copilot's conversation. */
const WAKE_TURN_PREFIX = "wake:";
const COMPACTION_TURN_PREFIX = "compact:";
/** Persisted events that start work after an idle, so a copy can end right before one. */
const COPILOT_FORK_POINTS = new Set([
  "user.message",
  "session.auto_mode_resolved",
  "session.compaction_start",
]);

interface ActiveTurn extends Lane, SubagentTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  promptId?: string;
  /** The prompt and every steer Copilot accepted for this turn. */
  readonly messageIds: Set<string>;
  /** Events received when Copilot accepted the latest send; an earlier idle is stale. */
  acceptedSeq: number;
  readonly approvals: Set<string>;
  readonly done: Deferred.Deferred<void>;
  readonly dirty: Set<string>;
  flushScheduled: boolean;
  interruptRequested: boolean;
  /** A manual compaction, which ends when its request settles rather than on idle. */
  compacting?: boolean;
  /** Copilot's main loop runs for this turn; a turn opened for a subagent's approval has none. */
  loopRunning: boolean;
  /** Its prompt was queued behind a wake, so that wake's idle does not end it. */
  awaitingPrompt?: boolean;
  /** How the main loop ended, while subagent requests still hold the turn open. */
  idleOutcome?:
    | {
        readonly status: "completed" | "cancelled" | "interrupted" | "failed";
        readonly detail?: string;
        readonly usageLimited: boolean;
      }
    | undefined;
  finishing?: boolean;
  /** Runs a loop Copilot woke on its own, whose errors name the latest earlier prompt. */
  wakeLoop?: boolean;
  error?: { readonly message: string; readonly errorType: string; readonly code?: string };
  /** The main agent's model calls. */
  usage: CopilotTokenCounts;
  endEventId?: string;
  todoPlanId?: PlanId;
}

type PendingNative =
  | {
      readonly type: "approval";
      readonly requestId: string;
      readonly request: CopilotPermissionRequest;
      /** Set for a subagent's request, which can outlast the main loop's turn. */
      readonly agentId?: string;
      readonly resolve: (result: CopilotPermissionResult) => void;
    }
  | {
      readonly type: "question";
      readonly request: CopilotUserInputRequest;
      readonly resolve: (result: CopilotUserInputResponse) => void;
    };

interface PendingRequest {
  readonly native: PendingNative;
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
  response?: Pick<OrchestrationV2RuntimeRequest, "decision" | "answers">;
}

type WakeEntry =
  | { readonly type: "event"; readonly event: SessionEvent; readonly seq: number }
  | { readonly type: "request"; readonly native: PendingNative };

/** Work Copilot started with no T3 turn, held until T3 opens the continuation turn for it. */
interface Wake {
  readonly messageId: MessageId | undefined;
  readonly entries: Array<WakeEntry>;
  /** Taken by a user's turn, so the continuation T3 was asked for has nothing to show. */
  dropped: boolean;
}

/** Entries from a session handle carry the attach generation they came from. */
type Inbox = { readonly generation?: number } & (
  | { readonly type: "event"; readonly event: SessionEvent; readonly seq: number }
  | {
      readonly type: "permission";
      readonly requestId: string;
      readonly request: CopilotPermissionRequest;
      readonly agentId?: string;
      readonly resolve: (result: CopilotPermissionResult) => void;
    }
  | {
      readonly type: "question";
      readonly request: CopilotUserInputRequest;
      readonly resolve: (result: CopilotUserInputResponse) => void;
    }
  | {
      readonly type: "exit_plan";
      readonly request: ExitPlanModeRequest;
      readonly resolve: (result: ExitPlanModeResult) => void;
    }
  | { readonly type: "flush"; readonly turn: ActiveTurn }
  | { readonly type: "compacted"; readonly turn: ActiveTurn; readonly failure?: string }
  | { readonly type: "settled"; readonly turn: ActiveTurn }
  | { readonly type: "permission_failed"; readonly requestId: string; readonly cause: unknown }
  | { readonly type: "failure"; readonly cause: Error }
);

function todoStatus(status: string | undefined): OrchestrationV2PlanStep["status"] {
  const normalized = status?.toLowerCase().replaceAll("-", "_");
  if (normalized === "done" || normalized === "completed" || normalized === "complete")
    return "completed";
  if (normalized === "in_progress" || normalized === "running") return "running";
  return "pending";
}

export function copilotTodoSteps(
  rows: ReadonlyArray<CopilotTodoRow>,
  keyPrefix: string,
): ReadonlyArray<OrchestrationV2PlanStep> {
  return rows.flatMap((row, index) => {
    const text = (row.title ?? row.description ?? "").trim();
    return text
      ? [{ id: `${keyPrefix}:${row.id ?? index}`, text, status: todoStatus(row.status) }]
      : [];
  });
}

/**
 * The first rolled-back turn's user message; rewinding to it also drops every later turn.
 * Undefined when no rolled-back turn reached Copilot, null when no rewind drops exactly them.
 */
export function copilotRewindBoundary(input: {
  readonly targetOrdinal: number;
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  /** Turns whose prompt Copilot rejected, so they never reached its conversation. */
  readonly unsentTurnIds?: ReadonlySet<string>;
}): string | null | undefined {
  const rolledBack = input.providerThreadTurns
    .filter((turn) => turn.ordinal > input.targetOrdinal && !input.unsentTurnIds?.has(turn.id))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const first = rolledBack.find((turn) => !isPromptlessTurn(turn));
  // Copilot rewinds only to a prompt, and a wake has none: only rewinding to a prompt before it
  // drops what Copilot learned from it. A compaction's summary may stay.
  if (
    rolledBack.some(
      (turn) =>
        turn.nativeTurnRef?.nativeId?.startsWith(WAKE_TURN_PREFIX) &&
        (first === undefined || turn.ordinal < first.ordinal),
    )
  )
    return null;
  if (first === undefined) return undefined;
  return first.nativeTurnRef?.strength === "strong" ? (first.nativeTurnRef.nativeId ?? null) : null;
}

/** Wakes and compactions have no prompt to rewind to; rewinding to the next turn drops them. */
const isPromptlessTurn = (turn: OrchestrationV2ProviderTurn) => {
  const nativeId = turn.nativeTurnRef?.nativeId ?? "";
  return nativeId.startsWith(WAKE_TURN_PREFIX) || nativeId.startsWith(COMPACTION_TURN_PREFIX);
};

const isContinuation = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";

/** What woke Copilot, for the message T3 shows in the thread. */
function copilotWakeNotification(
  data: Record<string, unknown>,
  subagents: Iterable<Subagent>,
): OrchestrationV2Notification {
  const kind = record(data.kind);
  const type = stringField(kind, "type");
  if (type === "agent_completed" || type === "agent_idle") {
    const agentId = stringField(kind, "agentId");
    const sub = [...subagents].find((candidate) => candidate.agentId === agentId);
    const name = stringField(kind, "displayName") ?? sub?.title;
    const failed = stringField(kind, "status") === "failed";
    return {
      source: {
        kind: "subagent",
        ...(sub?.child ? { childThreadId: sub.child.threadId } : {}),
      },
      outcome: failed ? "failed" : "completed",
      summary: `${name ? `Subagent "${name}"` : "A subagent"} ${failed ? "failed" : "finished"}`,
    };
  }
  if (type === "shell_completed" || type === "shell_detached_completed")
    return {
      source: { kind: "command" },
      outcome: "completed",
      summary: "A background command finished",
    };
  return {
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Copilot has an update from background work",
  };
}

export const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const resolveLaunch =
    options.resolveLaunch ??
    ((cwd: string) =>
      resolveCopilotLaunch({
        binaryPath: options.settings.binaryPath,
        launchArgs: options.settings.launchArgs,
        environment: options.environment,
        cwd,
        hideGitHubTokens: options.settings.hideGitHubTokens,
      }));
  const clientPool =
    options.clientPool ??
    (yield* makeCopilotClientPool({
      binaryPath: options.settings.binaryPath,
      createClient: options.createClient ?? makeCopilotSdkClient,
      resolveLaunch: resolveLaunch(providerHost.paths.cwd),
    }));
  const compactionThreshold = options.settings.autoCompactPercent
    ? Number(options.settings.autoCompactPercent) / 100
    : undefined;
  const protocolError = (detail: string, cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: COPILOT_PROVIDER,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const instructions = (hasT3Mcp: boolean, hasDeviceTools: boolean) =>
    [
      buildRuntimeInstructions({ harness: "GitHub Copilot" }),
      t3OrchestrationSystemPrompt(hasT3Mcp, hasDeviceTools)?.trim(),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

  const resolveSelection = Effect.fnUntraced(function* (selection: ModelSelection) {
    if (selection.instanceId !== options.instanceId)
      return yield* protocolError("Model selection belongs to another Copilot instance");
    const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
    const offered = catalog.find((model) => model.slug === selection.model);
    /** The selected value, only when the model offers it. */
    const offeredValue = (id: string) => {
      const descriptor = offered?.capabilities?.optionDescriptors?.find(
        (option) => option.id === id,
      );
      if (descriptor?.type !== "select") return undefined;
      const requested = getModelSelectionStringOptionValue(selection, id);
      return descriptor.options.some((option) => option.id === requested) ? requested : undefined;
    };
    const effort = offeredValue("reasoningEffort") as CopilotReasoningEffort | undefined;
    // Always stated for a tiered model, so the CLI's own remembered tier never applies.
    const contextTier = offered?.capabilities?.optionDescriptors?.some(
      (option) => option.id === "contextWindow",
    )
      ? ((offeredValue("contextWindow") ?? "default") as CopilotContextTier)
      : undefined;
    return { model: selection.model, effort, contextTier };
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: COPILOT_PROVIDER,
    getCapabilities: Effect.fn("CopilotAdapter.getCapabilities")(function () {
      return Effect.succeed(CopilotProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CopilotAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CopilotAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("GitHub Copilot is disabled");
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? providerHost.paths.cwd;
      const client = yield* clientPool.acquire.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: COPILOT_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      yield* Scope.addFinalizer(scope, clientPool.release(client));
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: COPILOT_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: CopilotProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const inbox = yield* Queue.unbounded<Inbox>();
      const commands = yield* Semaphore.make(1);
      const eventPermit = yield* Semaphore.make(1);
      let closed = false;
      let broken = false;
      let sdkSession: CopilotSdkSession | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      let appliedModel: string | undefined;
      let appliedEffort: CopilotReasoningEffort | undefined;
      let appliedContextTier: CopilotContextTier | undefined;
      let allowAll = false;
      let sessionOptions: CopilotSessionOptions | undefined;
      // T3 sends only while the main loop is idle, so all until its next assistant.idle is the
      // active turn's. Set while that loop runs work no T3 turn owns: a wake not yet attached,
      // or a prompt from the user's own CLI. Background agents run either way.
      let mainBusy = false;
      let wake: Wake | undefined;
      // Background subagents outlive the turn that started them, so they are the session's.
      const subagentsByCall = new Map<string, Subagent>();
      const subagentsByAgent = new Map<string, Subagent>();
      let lastModelSelection = input.modelSelection;
      /** Subagent approvals T3 published, by request id: their answer can fail after the turn. */
      const subagentRequests = new Map<string, string>();
      /** Copilot's state is unknown; the next use detaches and resumes the session first. */
      let quarantined = false;
      /** Bumped on each attach; events from an earlier handle are dropped. */
      let generation = 0;
      let received = 0;
      const unsentTurnIds = new Set<string>();
      let syntheticRequestCount = 0;
      const pending = new Map<RuntimeRequestId, PendingRequest>();

      const handlersFor = (attached: number, fullAccess: boolean): CopilotSessionHandlers => {
        const offer = (entry: Inbox) =>
          Queue.offerUnsafe(inbox, { ...entry, generation: attached });
        return {
          onEvent: (event) => {
            offer({ type: "event", event, seq: ++received });
          },
          onPermissionRequest: (request, requestId, agentId) =>
            new Promise((resolve) =>
              offer({
                type: "permission",
                requestId,
                request,
                ...(agentId ? { agentId } : {}),
                resolve,
              }),
            ),
          // Full access is Copilot's allow-all, which Copilot turns on only once it opened.
          onPermissionRequestWhileOpening: () =>
            fullAccess ? { kind: "approve-once" } : { kind: "user-not-available" },
          onUserInputRequest: (request) =>
            new Promise((resolve) => offer({ type: "question", request, resolve })),
          onExitPlanModeRequest: (request) =>
            new Promise((resolve) => offer({ type: "exit_plan", request, resolve })),
          onPermissionDeliveryFailed: (requestId, cause) => {
            Queue.offerUnsafe(inbox, { type: "permission_failed", requestId, cause });
          },
        };
      };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const lanes = makeCopilotLanes({ idAllocator, emit });
      const { baseItem, emitNode, publishMessage, publishReasoning, publishTool } = lanes;
      const { settleSubagent, startTool, completeTool, handleAgentEvent } = makeCopilotSubagents({
        instanceId: options.instanceId,
        idAllocator,
        emit,
        lanes,
        nativeSessionId: () => sdkSession?.sessionId ?? "",
      });
      const call = Effect.fn("CopilotAdapter.sdkCall")(function* <A>(
        label: string,
        run: (current: CopilotSdkSession) => Promise<A>,
        timeout: Duration.Input = COPILOT_SETTLE_TIMEOUT,
      ) {
        const current = sdkSession;
        if (!current) return yield* protocolError("Copilot session is not attached");
        return yield* Effect.tryPromise({
          try: () => run(current),
          catch: (cause) =>
            protocolError(
              cause instanceof Error && cause.message
                ? `Copilot ${label} failed: ${cause.message}`
                : `Copilot ${label} failed`,
              cause,
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(protocolError(`Copilot ${label} timed out`)),
          }),
        );
      });
      const detach = (handle: CopilotSdkSession) =>
        Effect.tryPromise(() => handle.disconnect()).pipe(
          Effect.timeout(COPILOT_SETTLE_TIMEOUT),
          Effect.ignore,
        );

      // Per-event helpers run for every streamed SDK event; spans would be too frequent.
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: COPILOT_PROVIDER,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: thread,
        });
      });
      const emitProviderTurn = (turn: ActiveTurn) =>
        emit({
          type: "provider_turn.updated",
          driver: COPILOT_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
      /** By attempt id: background compaction can finish after the turn that started it. */
      const compactions = new Map<string, { readonly turn: ActiveTurn; readonly key: string }>();
      const publishCompaction = Effect.fnUntraced(function* (
        event: SessionEvent,
        data: Record<string, unknown>,
      ) {
        // An attempt without an id pairs with the latest start that had none.
        const attempt = stringField(data, "compactionAttemptId") ?? "";
        const done = event.type === "session.compaction_complete";
        if (!done && active)
          compactions.set(attempt, { turn: active, key: `compaction:${attempt || event.id}` });
        const owner = compactions.get(attempt);
        if (!owner) return;
        if (done) compactions.delete(attempt);
        const turn = owner.turn;
        const time = yield* DateTime.now;
        const status = !done ? "running" : data.success === true ? "completed" : "failed";
        const tokens = (value: unknown) =>
          typeof value === "number" && value >= 0 ? { value: Math.round(value) } : undefined;
        const before = tokens(done ? data.preCompactionTokens : data.currentTokens);
        const after = tokens(data.postCompactionTokens);
        const summary = done
          ? (stringField(data, "summaryContent") ?? stringField(data, "error"))
          : undefined;
        const sessionId = sdkSession?.sessionId;
        // Kept out of the turn's totals, which count the main agent's own calls.
        const used = done ? compactionUsage(data) : undefined;
        if (used && options.recordUsage && sessionId)
          yield* options.recordUsage({ sessionId, ...used }).pipe(Effect.forkIn(scope));
        const base = baseItem(turn, owner.key, time);
        yield* emitNode(
          turn,
          { ...base, nativeItemRef: null },
          "system",
          status,
          done ? time : null,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            nativeItemRef: null,
            type: "compaction",
            status,
            title: null,
            completedAt: done ? time : null,
            driver: COPILOT_PROVIDER,
            ...(summary ? { summary } : {}),
            ...(before ? { beforeTokenCount: before.value } : {}),
            ...(after ? { afterTokenCount: after.value } : {}),
          },
        });
      });
      const scheduleFlush = Effect.fnUntraced(function* (turn: ActiveTurn) {
        if (turn.flushScheduled) return;
        turn.flushScheduled = true;
        yield* Effect.sleep(50).pipe(
          Effect.andThen(Queue.offer(inbox, { type: "flush", turn })),
          Effect.forkIn(scope),
        );
      });
      const flushTurn = Effect.fnUntraced(function* (turn: ActiveTurn) {
        turn.flushScheduled = false;
        for (const key of turn.dirty) {
          const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
          if (kind === "message") yield* publishMessage(turn, id, true);
          else if (kind === "reasoning") yield* publishReasoning(turn, id, true);
        }
        turn.dirty.clear();
      });

      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingRequest,
        status: "resolved" | "cancelled",
      ) {
        const time = yield* DateTime.now;
        entry.request = {
          ...entry.request,
          ...(status === "resolved" ? entry.response : undefined),
          status,
          resolvedAt: time,
          responseCapability: { type: "not_resumable", reason: "This Copilot request has ended." },
        };
        entry.node = {
          ...entry.node,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
        };
        entry.item = {
          ...entry.item,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
          updatedAt: time,
        };
        pending.delete(entry.request.id);
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: entry.node.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: entry.item });
        if (pending.size === 0 && active) yield* updateSession("running");
        // The last subagent request of a turn whose main loop already idled ends it.
        if (!hasSubagentRequest() && active && !active.loopRunning && !active.finishing)
          yield* Queue.offer(inbox, { type: "settled", turn: active });
      });
      /** A subagent's open request keeps its turn after the main loop idles. */
      const hasSubagentRequest = () =>
        [...pending.values()].some(
          (entry) => entry.native.type === "approval" && entry.native.agentId !== undefined,
        );
      const cancelPending = Effect.fnUntraced(function* () {
        for (const entry of pending.values()) {
          if (entry.native.type === "approval")
            entry.native.resolve({ kind: "reject", feedback: "The turn ended." });
          else entry.native.resolve({ answer: "", wasFreeform: true });
          yield* resolvePending(entry, "cancelled");
        }
      });

      const recordModelUsage = Effect.fnUntraced(function* (
        usageByModel: ReadonlyMap<string, CopilotTokenCounts>,
      ) {
        const recordUsage = options.recordUsage;
        const sessionId = sdkSession?.sessionId;
        if (!recordUsage || !sessionId) return;
        for (const [model, counts] of usageByModel)
          yield* recordUsage({ sessionId, model, usage: counts }).pipe(Effect.forkIn(scope));
      });
      /** Detaching or losing the CLI ends every subagent with it. */
      const settleRunningSubagents = Effect.fnUntraced(function* (
        status: "cancelled" | "interrupted" | "failed",
      ) {
        for (const sub of subagentsByCall.values())
          yield* settleSubagent(sub, status, sub.lastText ?? null);
      });

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        detail?: string,
        disposition: "reusable" | "broken" = "reusable",
        usageLimited = false,
      ) {
        if (active !== turn) return;
        turn.finishing = true;
        yield* flushTurn(turn);
        for (const messageId of turn.messages.keys()) {
          if (turn.ordinals.has(`message:${messageId}`))
            yield* publishMessage(turn, messageId, false);
        }
        for (const reasoningId of turn.reasoning.keys()) {
          if (turn.ordinals.has(`reasoning:${reasoningId}`))
            yield* publishReasoning(turn, reasoningId, false);
        }
        for (const tool of turn.tools.values()) {
          if (tool.status !== "running") continue;
          tool.status = status === "completed" ? "completed" : status;
          yield* publishTool(turn, tool);
        }
        // Background subagents keep running past the turn and Copilot's events settle them; one
        // whose task call is still open ran inside this turn's loop and ends with it.
        for (const sub of subagentsByCall.values())
          if (sub.parent === turn && !sub.callReturned)
            yield* settleSubagent(
              sub,
              status === "completed" ? "cancelled" : status,
              sub.lastText ?? null,
            );
        yield* cancelPending();
        const completedAt = yield* DateTime.now;
        const usage = turn.usage;
        yield* recordModelUsage(turn.usageByModel);
        const nativeTurnRef = turn.providerTurn.nativeTurnRef;
        turn.providerTurn = {
          ...turn.providerTurn,
          // Its fingerprint is the turn's last persisted event, where a copy may end.
          ...(nativeTurnRef && turn.endEventId
            ? { nativeTurnRef: { ...nativeTurnRef, fingerprint: turn.endEventId } }
            : {}),
          status,
          completedAt,
          ...(usage.inputTokens + usage.outputTokens > 0
            ? {
                turnTokenUsage: {
                  usageScope: "main_agent",
                  usageStatus: "complete",
                  hasSubagents: [...subagentsByCall.values()].some((sub) => sub.parent === turn),
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cachedInputTokens: usage.cachedInputTokens,
                  cacheCreationTokens: usage.cacheCreationTokens,
                  reasoningTokens: usage.reasoningTokens,
                },
              }
            : {}),
        };
        yield* emitProviderTurn(turn);
        yield* updateThread({ status: disposition === "broken" ? "error" : "idle" });
        yield* updateSession(disposition === "broken" ? "error" : "ready", detail ?? null);
        active = undefined;
        yield* Deferred.succeed(turn.done, undefined);
        const terminal = {
          type: "turn.terminal" as const,
          driver: COPILOT_PROVIDER,
          providerThreadId: turn.providerTurn.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          threadDisposition: disposition,
        };
        if (status !== "failed") {
          yield* emit({ ...terminal, status, failure: null });
          return;
        }
        const failure = makeProviderFailure({
          class:
            disposition === "broken"
              ? "transport_error"
              : usageLimited
                ? "usage_limit"
                : "provider_error",
          message: detail ?? "Copilot turn failed.",
          ...(turn.error?.code ? { code: turn.error.code } : {}),
        });
        const base = baseItem(turn, "failure:turn", completedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            nativeItemRef: null,
            type: "error",
            status: "failed",
            title: usageLimited ? "Usage limit reached" : null,
            completedAt,
            failure,
          },
        });
        yield* emit({ ...terminal, status, failure, failureItemOrdinal: base.ordinal });
      });

      const failSession = Effect.fnUntraced(function* (cause: Error) {
        if (closed || broken) return;
        broken = true;
        wake = undefined;
        yield* settleRunningSubagents("failed");
        const turn = active;
        if (turn) yield* finish(turn, "failed", cause.message, "broken");
        else {
          yield* cancelPending();
          yield* updateThread({ status: "error" });
          yield* updateSession("error", cause.message);
        }
        if (turn) yield* Queue.fail(events, protocolError(cause.message, cause));
      });

      // Ends a turn whose Copilot state is unknown. Detaching stops whatever Copilot still runs;
      // the next use resumes the session before sending anything.
      const quarantine = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "interrupted" | "failed",
        detail?: string,
      ) {
        if (active !== turn) return;
        quarantined = true;
        generation += 1;
        wake = undefined;
        if (sdkSession) yield* detach(sdkSession).pipe(Effect.forkIn(scope));
        yield* settleRunningSubagents(status);
        yield* finish(turn, status, detail);
      });

      /** A subagent left waiting on an answer Copilot never got is cancelled, or the session detached. */
      const stopStrandedSubagent = Effect.fnUntraced(function* (agentId: string, detail: string) {
        yield* Effect.logWarning("Copilot subagent approval was not delivered", agentId, detail);
        const sub = subagentsByAgent.get(agentId);
        const cancelled = sub
          ? yield* call("subagent stop", (current) => current.cancelSubagent(sub.toolCallId)).pipe(
              Effect.orElseSucceed(() => false),
            )
          : false;
        if (sub) yield* settleSubagent(sub, "failed", detail);
        if (cancelled) return;
        return yield* detachStranded(detail);
      });

      /** Copilot waits on an answer it never got, so the session's state is unknown. */
      const detachStranded = Effect.fnUntraced(function* (detail: string) {
        if (active) return yield* quarantine(active, "failed", detail);
        quarantined = true;
        generation += 1;
        wake = undefined;
        if (sdkSession) yield* detach(sdkSession).pipe(Effect.forkIn(scope));
        yield* settleRunningSubagents("failed");
      });

      const publishTodos = Effect.fnUntraced(function* (turn: ActiveTurn) {
        const rows = yield* call("readTodos", (current) => current.readTodos());
        if (active !== turn) return;
        const steps = copilotTodoSteps(rows, `${turn.providerTurn.id}:todo`);
        const time = yield* DateTime.now;
        const base = baseItem(turn, "todo:list", time);
        const planId =
          turn.todoPlanId ??
          (yield* idAllocator.allocate
            .plan({
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              driver: COPILOT_PROVIDER,
            })
            .pipe(Effect.mapError((cause) => protocolError("Cannot allocate a todo list", cause))));
        turn.todoPlanId = planId;
        yield* emit({
          type: "plan.updated",
          driver: COPILOT_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "todo_list",
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            steps,
          },
        });
        yield* emitNode(turn, { ...base, nativeItemRef: null }, "todo_list", "completed", time);
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            nativeItemRef: null,
            type: "todo_list",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            steps,
          },
        });
      });

      /** Copilot started work on its own between turns; T3 opens a continuation turn to show it. */
      const beginWake = Effect.fnUntraced(function* (
        entry: WakeEntry,
        data: Record<string, unknown>,
      ) {
        const route = thread?.appThreadId ?? null;
        const current: Wake = {
          messageId:
            route === null
              ? undefined
              : yield* idAllocator.allocate.message({ threadId: route, ordinal: 0 }),
          entries: [entry],
          dropped: false,
        };
        wake = current;
        if (entry.type === "event") mainBusy = true;
        if (route === null || !thread || current.messageId === undefined) return;
        yield* continuationRequests.offer({
          threadId: route,
          providerThreadId: thread.id,
          driver: COPILOT_PROVIDER,
          detail: null,
          messageId: current.messageId,
          notification:
            entry.type === "request"
              ? {
                  source: { kind: "subagent" },
                  outcome: "updated",
                  summary: "A subagent needs your answer",
                }
              : copilotWakeNotification(data, subagentsByCall.values()),
          dispatchIfCurrent: (dispatch) =>
            current.dropped ? Effect.succeedNone : Effect.asSome(dispatch),
        });
      });

      const handleEvent = Effect.fnUntraced(function* (event: SessionEvent, seq: number) {
        const data = record(event.data);
        if (event.type === "permission.completed") {
          const requestId = stringField(data, "requestId");
          const entry = [...pending.values()].find(
            (candidate) =>
              candidate.native.type === "approval" && candidate.native.requestId === requestId,
          );
          if (requestId) subagentRequests.delete(requestId);
          if (!entry) {
            // Answered elsewhere while held for a continuation turn, which must not show it.
            const held = wake;
            const index =
              held?.entries.findIndex(
                (candidate) =>
                  candidate.type === "request" &&
                  candidate.native.type === "approval" &&
                  candidate.native.requestId === requestId,
              ) ?? -1;
            if (!held || index < 0) return;
            const [answered] = held.entries.splice(index, 1);
            if (answered?.type === "request" && answered.native.type === "approval")
              answered.native.resolve({ kind: "no-result" });
            if (held.entries.length === 0) {
              held.dropped = true;
              wake = undefined;
            }
            return;
          }
          // Answered outside T3, so the SDK must not answer again.
          if (!entry.response && entry.native.type === "approval")
            entry.native.resolve({ kind: "no-result" });
          yield* resolvePending(entry, entry.response ? "resolved" : "cancelled");
          return;
        }
        if ("agentId" in event && event.agentId) {
          if (active) return yield* handleAgentEvent(active, event.agentId, event);
          // Between turns a subagent's model calls have no turn to total them, so they go to Usage now.
          const usageByModel = new Map<string, CopilotTokenCounts>();
          yield* handleAgentEvent(
            {
              input: { modelSelection: lastModelSelection },
              subagents: subagentsByCall,
              agents: subagentsByAgent,
              usageByModel,
            },
            event.agentId,
            event,
          );
          return yield* recordModelUsage(usageByModel);
        }
        if (event.type === "session.usage_info") {
          const used = data.currentTokens;
          const limit = data.tokenLimit;
          if (typeof used === "number" && thread)
            yield* updateThread({
              contextUsage: {
                usedTokens: Math.max(0, Math.round(used)),
                ...(typeof limit === "number" && limit > 0 ? { maxTokens: Math.round(limit) } : {}),
              },
            });
          return;
        }
        // Background compaction is no sign of work T3 did not start; its usage counts at completion.
        if (
          event.type === "session.compaction_start" ||
          event.type === "session.compaction_complete"
        )
          return yield* publishCompaction(event, data);
        if (event.type === "assistant.usage" && isCompactionUsage(data)) return;
        const turn = active;
        if (!turn) {
          const ended = event.type === "assistant.idle" || event.type === "session.idle";
          if (ended) mainBusy = false;
          if (wake) {
            wake.entries.push({ type: "event", event, seq });
            return;
          }
          if (event.type === "system.notification")
            return yield* beginWake({ type: "event", event, seq }, data);
          if (!ended && MAIN_LOOP_STARTS.has(event.type)) mainBusy = true;
          return;
        }
        switch (event.type) {
          case "user.message": {
            if (data.messageId !== turn.promptId) return;
            turn.awaitingPrompt = false;
            if (turn.providerTurn.nativeTurnRef) return;
            turn.providerTurn = { ...turn.providerTurn, nativeTurnRef: nativeRef(event.id) };
            yield* emitProviderTurn(turn);
            return;
          }
          case "assistant.message_delta":
          case "assistant.reasoning_delta": {
            const isMessage = event.type === "assistant.message_delta";
            const id = stringField(data, isMessage ? "messageId" : "reasoningId");
            const delta = stringField(data, "deltaContent");
            if (!id || !delta) return;
            const store = isMessage ? turn.messages : turn.reasoning;
            store.set(id, (store.get(id) ?? "") + delta);
            turn.dirty.add(`${isMessage ? "message" : "reasoning"}:${id}`);
            yield* scheduleFlush(turn);
            return;
          }
          case "assistant.message":
          case "assistant.reasoning": {
            const isMessage = event.type === "assistant.message";
            const id = stringField(data, isMessage ? "messageId" : "reasoningId");
            if (!id) return;
            const content = stringField(data, "content") ?? "";
            const store = isMessage ? turn.messages : turn.reasoning;
            if (content) store.set(id, content);
            turn.dirty.delete(`${isMessage ? "message" : "reasoning"}:${id}`);
            if (isMessage) yield* publishMessage(turn, id, false);
            else yield* publishReasoning(turn, id, false);
            return;
          }
          case "assistant.usage":
            addUsage(turn.usage, data);
            return addModelUsage(turn.usageByModel, data.model, data);
          case "tool.execution_start":
            return yield* startTool(turn, turn, data);
          case "tool.shell_output": {
            const tool = turn.tools.get(stringField(data, "toolCallId") ?? "");
            const text = stringField(data, "text");
            if (!tool || !text || tool.status !== "running") return;
            tool.output += text;
            if (HIDDEN_TOOLS.has(tool.toolName)) return;
            const base = baseItem(turn, `tool:${tool.toolCallId}`, yield* DateTime.now);
            yield* emit({
              type: "command_output.delta",
              driver: COPILOT_PROVIDER,
              threadId: turn.input.threadId,
              itemId: base.id,
              chunk: text,
            });
            return;
          }
          case "tool.execution_complete":
            return yield* completeTool(turn, turn, data);
          case "session.todos_changed":
            yield* publishTodos(turn).pipe(
              Effect.catch((error) => Effect.logWarning("Copilot todo list was unreadable", error)),
            );
            return;
          case "session.warning":
          case "session.error": {
            const origin = stringField(data, "originatingMessageId");
            // A policy hook refuses a prompt with a warning in place of its user.message.
            if (event.type === "session.warning" && data.warningType !== "policy_blocked") return;
            if (origin !== undefined && !turn.messageIds.has(origin) && !turn.wakeLoop)
              return yield* Effect.logWarning("Copilot error for a prompt T3 did not send", origin);
            const message = stringField(data, "message") ?? "Copilot reported an error.";
            const code = stringField(data, "errorCode");
            turn.error = {
              message,
              errorType: stringField(data, "errorType", "warningType") ?? "unknown",
              ...(code ? { code } : {}),
            };
            return;
          }
          case "assistant.turn_start":
          case "system.notification":
            // A loop that starts after an earlier idle, e.g. Copilot waking for a subagent while
            // its approval holds the turn, ends the turn at its own idle.
            turn.loopRunning = true;
            turn.idleOutcome = undefined;
            return;
          // The main loop is done at assistant.idle; session.idle also waits for background
          // agents. Replays recorded before T3 read assistant.idle end on session.idle alone.
          case "assistant.idle":
          case "session.idle": {
            // Copilot idled before it took the turn's latest send, which then runs as more work.
            if (seq <= turn.acceptedSeq || turn.compacting || turn.idleOutcome) return;
            if (turn.awaitingPrompt && !turn.error && data.aborted !== true) return;
            mainBusy = false;
            turn.loopRunning = false;
            // Idle is never persisted; its parent is the turn's last persisted event.
            if (event.parentId) turn.endEventId = event.parentId;
            turn.idleOutcome = turn.error
              ? {
                  status: "failed",
                  detail: turn.error.message,
                  usageLimited: USAGE_LIMIT_ERROR_TYPES.has(turn.error.errorType),
                }
              : data.aborted === true
                ? {
                    status: turn.interruptRequested ? "interrupted" : "cancelled",
                    usageLimited: false,
                  }
                : { status: "completed", usageLimited: false };
            // A background subagent's open request keeps the turn until it is answered.
            if (hasSubagentRequest() && turn.idleOutcome.status === "completed") return;
            const outcome = turn.idleOutcome;
            return yield* finish(
              turn,
              outcome.status,
              outcome.detail,
              "reusable",
              outcome.usageLimited,
            );
          }
        }
      });

      const publishRequest = Effect.fnUntraced(function* (native: PendingNative, current: boolean) {
        const turn = active;
        // A background subagent asks between turns: hold it for a continuation turn to show.
        if (!turn && thread && current) {
          if (wake) wake.entries.push({ type: "request", native });
          else yield* beginWake({ type: "request", native }, {});
          return;
        }
        if (!turn || !thread || !current) {
          if (native.type === "approval")
            native.resolve({ kind: "reject", feedback: NO_ACTIVE_TURN_FEEDBACK });
          else native.resolve({ answer: "", wasFreeform: true });
          return;
        }
        const nativeId =
          native.type === "approval"
            ? native.requestId
            : `${native.type}:${++syntheticRequestCount}`;
        const providerTurnId = turn.providerTurn.id;
        const requestId = yield* idAllocator.allocate
          .runtimeRequest({ driver: COPILOT_PROVIDER, providerTurnId, nativeRequestId: nativeId })
          .pipe(
            Effect.mapError((cause) => protocolError("Cannot allocate a Copilot request", cause)),
          );
        const time = yield* DateTime.now;
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const presentation =
          native.type === "approval" ? copilotApprovalPresentation(native.request) : undefined;
        const request: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: nativeRef(nativeId),
          kind: presentation?.kind ?? "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: time,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: native.type === "approval" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: thread.id,
          providerTurnId,
          nativeItemRef: nativeRef(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: time,
          completedAt: null,
        };
        const base = {
          ...baseItem(turn, `request:${nativeId}`, time),
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          nodeId,
          status: "waiting" as const,
          title: null,
          completedAt: null,
        };
        const item: OrchestrationV2TurnItem =
          native.type === "approval"
            ? {
                ...base,
                type: "approval_request",
                requestId,
                requestKind: presentation!.kind,
                prompt: presentation!.prompt,
                options: [...presentation!.options],
                // With allow-all on, only a check Copilot enforces anyway still asks.
                ...(allowAll ? { fullAccessOverride: "provider_check" as const } : {}),
              }
            : {
                ...base,
                type: "user_input_request",
                requestId,
                questions: [
                  {
                    id: "answer",
                    header: "Copilot",
                    question: native.request.question.trim() || "Copilot asks for input.",
                    options: (native.request.choices ?? [])
                      .filter((choice) => choice.trim())
                      .map((choice) => ({ label: choice.trim(), description: choice.trim() })),
                    allowCustomAnswer: native.request.allowFreeform ?? true,
                    required: true,
                  },
                ],
              };
        pending.set(requestId, { native, request, node, item });
        if (native.type === "approval") turn.approvals.add(native.requestId);
        if (native.type === "approval" && native.agentId)
          subagentRequests.set(native.requestId, native.agentId);
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: turn.input.threadId,
          runtimeRequest: request,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
        yield* updateSession("waiting");
      });

      const publishProposedPlan = Effect.fnUntraced(function* (request: ExitPlanModeRequest) {
        const turn = active;
        const markdown = (request.planContent ?? "").trim() || request.summary.trim();
        if (!turn || !markdown) return;
        const time = yield* DateTime.now;
        const base = baseItem(turn, `plan:${turn.ordinals.size}`, time);
        const planId = yield* idAllocator.allocate
          .plan({
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            driver: COPILOT_PROVIDER,
          })
          .pipe(
            Effect.mapError((cause) => protocolError("Cannot allocate a proposed plan", cause)),
          );
        yield* emit({
          type: "plan.updated",
          driver: COPILOT_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "proposed_plan",
            status: "active",
            markdown,
          },
        });
        yield* emitNode(turn, base, "plan", "completed", time);
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            type: "proposed_plan",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            markdown,
            streaming: false,
          },
        });
      });

      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            // A detached handle's events and requests are no turn's.
            const current = entry.generation === undefined || entry.generation === generation;
            switch (entry.type) {
              case "event":
                if (
                  options.nativeEventLogger &&
                  entry.event.type !== "assistant.message_delta" &&
                  entry.event.type !== "assistant.reasoning_delta"
                )
                  yield* options.nativeEventLogger.write(
                    { provider: "copilot", event: entry.event },
                    input.threadId,
                  );
                if (!current) return;
                return yield* handleEvent(entry.event, entry.seq);
              case "permission":
                return yield* publishRequest(
                  {
                    type: "approval",
                    requestId: entry.requestId,
                    request: entry.request,
                    ...(entry.agentId ? { agentId: entry.agentId } : {}),
                    resolve: entry.resolve,
                  },
                  current,
                );
              case "question":
                return yield* publishRequest(
                  {
                    type: "question",
                    request: entry.request,
                    resolve: entry.resolve,
                  },
                  current,
                );
              case "exit_plan": {
                const shown = current && active !== undefined;
                if (shown) yield* publishProposedPlan(entry.request);
                const feedback = shown ? PLAN_CAPTURED_FEEDBACK : NO_ACTIVE_TURN_FEEDBACK;
                return entry.resolve({ approved: false, feedback });
              }
              case "flush":
                if (active === entry.turn) yield* flushTurn(entry.turn);
                return;
              case "settled": {
                const turn = entry.turn;
                if (active !== turn || turn.loopRunning || hasSubagentRequest()) return;
                const outcome = turn.idleOutcome;
                return yield* finish(
                  turn,
                  outcome?.status ?? "completed",
                  outcome?.detail,
                  "reusable",
                  outcome?.usageLimited,
                );
              }
              case "compacted":
                if (!current) return;
                if (entry.turn.interruptRequested) return yield* finish(entry.turn, "interrupted");
                return entry.failure === undefined
                  ? yield* finish(entry.turn, "completed")
                  : yield* finish(entry.turn, "failed", entry.failure);
              case "permission_failed": {
                const turn = active;
                const reason =
                  entry.cause instanceof Error && entry.cause.message
                    ? `: ${entry.cause.message}`
                    : "";
                const detail = `Copilot did not receive the approval answer${reason}`;
                const agentId = subagentRequests.get(entry.requestId);
                subagentRequests.delete(entry.requestId);
                // A subagent's answer can fail after its turn ended; only that subagent waits.
                if (agentId !== undefined) return yield* stopStrandedSubagent(agentId, detail);
                if (!turn?.approvals.has(entry.requestId)) return;
                return yield* quarantine(turn, "failed", detail);
              }
              case "failure":
                return yield* failSession(entry.cause);
            }
          }).pipe(eventPermit.withPermits(1)),
        ),
        Effect.forkIn(scope),
      );
      yield* Effect.promise(() => client.exited).pipe(
        Effect.flatMap((cause) => Queue.offer(inbox, { type: "failure", cause })),
        Effect.forkIn(scope),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          wake = undefined;
          yield* settleRunningSubagents("cancelled");
          if (active) yield* finish(active, "cancelled", "Copilot session closed", "broken");
          yield* cancelPending();
          const current = sdkSession;
          if (current) yield* detach(current);
          yield* Queue.shutdown(inbox);
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );

      const applyAllowAll = Effect.fnUntraced(function* (enabled: boolean) {
        yield* call("setAllowAll", (current) => current.setAllowAll(enabled), COPILOT_OPEN_TIMEOUT);
        allowAll = enabled;
      });

      /** Opens or resumes the native session; a resumed one may still run work T3 did not start. */
      const attach = Effect.fnUntraced(
        function* (
          resumeId: string | undefined,
          options: CopilotSessionOptions,
          fullAccess: boolean,
        ) {
          if (sdkSession) yield* detach(sdkSession);
          generation += 1;
          const handlers = handlersFor(generation, fullAccess);
          sdkSession = yield* Effect.tryPromise({
            try: () =>
              resumeId
                ? client.resumeSession(resumeId, options, handlers)
                : client.createSession(options, handlers),
            catch: (cause) => protocolError("Copilot could not open its session", cause),
          }).pipe(Effect.timeout(COPILOT_START_TIMEOUT_MS));
          appliedModel = options.model;
          appliedEffort = options.reasoningEffort;
          appliedContextTier = options.contextTier;
          // A resumed session may keep an earlier allow-all; always state it.
          yield* applyAllowAll(fullAccess);
          quarantined = false;
          mainBusy = false;
          wake = undefined;
          if (resumeId === undefined) return sdkSession;
          const processing = yield* call(
            "isProcessing",
            (current) => current.isProcessing(),
            COPILOT_OPEN_TIMEOUT,
          ).pipe(Effect.option);
          if (Option.isSome(processing)) mainBusy = processing.value;
          else quarantined = true;
          return sdkSession;
        },
        // Events of a handle that opened late or half-way stay out.
        Effect.tapError(() =>
          Effect.gen(function* () {
            const failed = sdkSession;
            sdkSession = undefined;
            generation += 1;
            quarantined = true;
            if (failed) yield* detach(failed);
          }),
        ),
      );
      const reattach = (fullAccess: boolean) => {
        const nativeId = thread?.nativeThreadRef?.nativeId;
        return nativeId && sessionOptions
          ? attach(nativeId, sessionOptions, fullAccess)
          : Effect.fail(protocolError("Copilot session is not attached"));
      };

      // Stamped before Effect resumes, so events received after the reply are not counted.
      const send = (input: CopilotSendInput) =>
        call(
          "send",
          (current) => current.send(input).then((messageId) => ({ messageId, seq: received })),
          COPILOT_OPEN_TIMEOUT,
        );

      const register = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (closed || broken)
          return yield* protocolError("Copilot session is unavailable; reopen the session");
        if (active)
          return yield* protocolError("Cannot change Copilot sessions during an active turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== COPILOT_PROVIDER ||
            existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Copilot thread belongs to another provider instance");
        const requestedId = existing
          ? (existing.nativeThreadRef?.nativeId ?? undefined)
          : input.initialNativeThreadId;
        if (
          thread &&
          (!requestedId || requestedId === thread.nativeThreadRef?.nativeId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread)
          return yield* protocolError("Open a new session to attach another Copilot session");
        const mcp = yield* mcpSessions.read(args.threadId);
        const selection = yield* resolveSelection(args.modelSelection);
        const nativeOptions: CopilotSessionOptions = {
          model: selection.model,
          ...(selection.effort ? { reasoningEffort: selection.effort } : {}),
          ...(selection.contextTier ? { contextTier: selection.contextTier } : {}),
          workingDirectory: cwd,
          instructions: instructions(mcp !== undefined, mcp?.capabilities?.has("device") === true),
          ...(compactionThreshold === undefined ? {} : { compactionThreshold }),
          mcpServers: mcp
            ? {
                "t3-code": {
                  type: "http",
                  url: mcp.endpoint,
                  headers: { Authorization: mcp.authorizationHeader },
                  tools: ["*"],
                },
              }
            : {},
        };
        sessionOptions = nativeOptions;
        const opened = yield* attach(
          requestedId,
          nativeOptions,
          args.runtimePolicy.runtimeMode === "full-access",
        );
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: nativeRef(opened.sessionId),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: COPILOT_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: opened.sessionId,
              }),
              driver: COPILOT_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(opened.sessionId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        session = { ...session, model: selection.model };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });

      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        candidate.driver === COPILOT_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.appThreadId === thread.appThreadId &&
        candidate.nativeThreadRef?.nativeId === thread.nativeThreadRef?.nativeId;

      // A skill left unexpanded still reaches the model as `/name`, which it then loads itself.
      const skillPrompt = Effect.fnUntraced(function* (text: string, expand: boolean) {
        if (!hasSkillMention(text)) return { prompt: text };
        const skillCommands = yield* call(
          "skill listing",
          (current) => current.listSkillCommands(),
          COPILOT_OPEN_TIMEOUT,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Copilot could not list skills", error).pipe(Effect.as([])),
          ),
        );
        const plan = planCopilotSkillInvocation(text, new Set(skillCommands));
        if (!plan) return { prompt: text };
        const expanded = expand
          ? yield* call(
              "skill expansion",
              (current) => current.expandSkill(plan.name, plan.input),
              COPILOT_OPEN_TIMEOUT,
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Copilot could not expand a skill", error).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
          : undefined;
        return {
          prompt:
            expanded === undefined
              ? plan.displayText
              : [plan.leadingText, expanded].filter(Boolean).join("\n\n"),
          displayPrompt: plan.displayText,
        };
      });

      /** Steering skips skill expansion: Copilot disallows skill commands while a turn runs. */
      const prompt = Effect.fnUntraced(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnMessage,
        expandSkills: boolean,
      ) {
        const attachments = message.attachments.flatMap((attachment) => {
          if (!isProviderNativeImageAttachment(attachment)) return [];
          const path = providerHost.resolveAttachmentPath(attachment);
          return path ? [{ type: "file" as const, path }] : [];
        });
        const text = yield* providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments,
          resolveAttachmentPath: providerHost.resolveAttachmentPath,
          resolveExtractedTextPath: providerHost.resolveExtractedTextPath,
        });
        return {
          ...(yield* skillPrompt(text, expandSkills)),
          ...(attachments.length ? { attachments } : {}),
        };
      });

      const openTurn = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        const startedAt = yield* DateTime.now;
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: COPILOT_PROVIDER,
          nativeTurnId: `${options.instanceId}:${sdkSession!.sessionId}:${turnInput.message.messageId}`,
        });
        // Earlier turns' settled subagents get no more events worth routing.
        for (const [toolCallId, sub] of subagentsByCall) {
          if (sub.status === "running") continue;
          subagentsByCall.delete(toolCallId);
          if (sub.agentId) subagentsByAgent.delete(sub.agentId);
        }
        const turn: ActiveTurn = {
          input: turnInput,
          appThread: turnInput.appThread,
          threadId: turnInput.threadId,
          runId: turnInput.runId,
          providerThreadId: turnInput.providerThread.id,
          providerTurnId,
          rootNodeId: turnInput.rootNodeId,
          identity: `${options.instanceId}:${turnInput.providerThread.id}:${providerTurnId}`,
          providerTurn: {
            id: providerTurnId,
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          },
          messageIds: new Set(),
          acceptedSeq: received,
          ordinals: new Map(),
          started: new Map(),
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          messages: new Map(),
          reasoning: new Map(),
          tools: new Map(),
          approvals: new Set(),
          done: yield* Deferred.make<void>(),
          dirty: new Set(),
          subagents: subagentsByCall,
          agents: subagentsByAgent,
          flushScheduled: false,
          interruptRequested: false,
          loopRunning: true,
          usage: emptyCounts(),
          usageByModel: new Map(),
        };
        thread = turnInput.providerThread;
        active = turn;
        lastModelSelection = turnInput.modelSelection;
        yield* emitProviderTurn(turn);
        yield* updateThread({
          status: "active",
          firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
        });
        yield* updateSession("running");
        return turn;
      });

      /** Feeds held work to the active turn, in the order Copilot sent it. */
      const replay = Effect.fnUntraced(function* (entries: ReadonlyArray<WakeEntry>) {
        for (const entry of entries) {
          if (entry.type === "event") yield* handleEvent(entry.event, entry.seq);
          else yield* publishRequest(entry.native, true);
        }
      });

      /** The continuation turn T3 opened for a wake shows what Copilot did on its own. */
      const attachWake = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (!sdkSession) return yield* protocolError("Copilot session is not attached");
        const turn = yield* openTurn(turnInput);
        const held = wake;
        if (!held || held.messageId !== turnInput.message.messageId)
          return yield* finish(turn, "completed");
        wake = undefined;
        const first = held.entries[0];
        if (!first) return yield* finish(turn, "completed");
        turn.loopRunning = first.type === "event";
        turn.wakeLoop = true;
        turn.acceptedSeq = 0;
        turn.providerTurn = {
          ...turn.providerTurn,
          nativeTurnRef: nativeRef(
            `${WAKE_TURN_PREFIX}${first.type === "event" ? first.event.id : turn.providerTurn.id}`,
          ),
        };
        yield* emitProviderTurn(turn);
        yield* replay(held.entries);
        if (active === turn && !turn.loopRunning && !hasSubagentRequest())
          yield* finish(turn, "completed");
      });

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        compact = false,
      ) {
        if (!validateThread(turnInput.providerThread) || broken || closed)
          return yield* protocolError("Copilot thread is not attached to this session");
        if (active)
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: COPILOT_PROVIDER,
            detail: "Copilot already has an active turn; queue through the orchestrator",
            reason: "previous_turn_active",
          });
        if (!compact && isContinuation(turnInput)) return yield* attachWake(turnInput);
        const fullAccess = turnInput.runtimePolicy.runtimeMode === "full-access";
        if (quarantined) yield* reattach(fullAccess);
        // A user's prompt can take over a wake; anything else Copilot runs is not T3's.
        if ((mainBusy && (compact || !wake)) || quarantined)
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: COPILOT_PROVIDER,
            detail: "Copilot session is still busy with work T3 did not start",
            reason: "previous_turn_active",
          });
        const selection = yield* resolveSelection(turnInput.modelSelection);
        if (
          selection.model !== appliedModel ||
          selection.effort !== appliedEffort ||
          selection.contextTier !== appliedContextTier
        ) {
          yield* call(
            "setModel",
            (current) => current.setModel(selection.model, selection.effort, selection.contextTier),
            COPILOT_OPEN_TIMEOUT,
          );
          appliedModel = selection.model;
          appliedEffort = selection.effort;
          appliedContextTier = selection.contextTier;
          session = { ...session, model: selection.model };
        }
        if (fullAccess !== allowAll) yield* applyAllowAll(fullAccess);
        const turn = yield* openTurn(turnInput);
        if (compact) {
          turn.compacting = true;
          // No prompt of its own in Copilot's conversation, so a rewind skips past it.
          turn.providerTurn = {
            ...turn.providerTurn,
            nativeTurnRef: nativeRef(`${COMPACTION_TURN_PREFIX}${turn.providerTurn.id}`),
          };
          yield* emitProviderTurn(turn);
          const current = sdkSession!;
          const attached = generation;
          // Compaction runs a model call, so no settle timeout; Stop aborts it instead.
          // Its outcome joins the inbox behind the compaction events Copilot sent before it.
          yield* Effect.tryPromise(() => current.compact()).pipe(
            Effect.match({
              onSuccess: (applied) =>
                applied ? {} : { failure: "Copilot did not compact the conversation." },
              onFailure: (error) => ({
                failure:
                  error.cause instanceof Error && error.cause.message
                    ? `Copilot compaction failed: ${error.cause.message}`
                    : "Copilot compaction failed.",
              }),
            }),
            Effect.flatMap((outcome) =>
              Queue.offer(inbox, { type: "compacted", turn, generation: attached, ...outcome }),
            ),
            Effect.forkIn(scope),
          );
          return;
        }
        const held = wake;
        if (held) {
          // Shown in this turn, so the continuation T3 was asked for is not dispatched. Its idles
          // came before this turn's send; while its loop still runs, the prompt queues behind it.
          wake = undefined;
          held.dropped = true;
          turn.awaitingPrompt = mainBusy;
          turn.wakeLoop = true;
          yield* replay(held.entries);
        }
        const sent = yield* send({
          ...(yield* prompt(turnInput.message, true)),
          agentMode: turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : "interactive",
        }).pipe(
          Effect.tapError((error) =>
            // Only a provably refused prompt is absent from Copilot's history.
            isCopilotRequestRejected(error.cause)
              ? Effect.sync(() => unsentTurnIds.add(turn.providerTurn.id)).pipe(
                  Effect.andThen(finish(turn, "failed", error.detail)),
                )
              : quarantine(turn, "failed", error.detail),
          ),
        );
        turn.promptId = sent.messageId;
        turn.messageIds.add(sent.messageId);
        turn.acceptedSeq = sent.seq;
      });

      const startOrCompact = (args: ProviderAdapter.ProviderAdapterV2TurnInput, compact: boolean) =>
        start(args, compact).pipe(
          eventPermit.withPermits(1),
          commands.withPermits(1),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: COPILOT_PROVIDER,
                threadId: args.threadId,
                providerThreadId: args.providerThread.id,
                runId: args.runId,
                cause,
              }),
          ),
        );

      const clientCall = <A>(label: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => protocolError(`Copilot ${label} failed`, cause),
        }).pipe(
          Effect.timeoutOrElse({
            duration: COPILOT_SETTLE_TIMEOUT,
            orElse: () => Effect.fail(protocolError(`Copilot ${label} timed out`)),
          }),
        );
      /** Persisted events after a turn's end, e.g. the user continuing the session in the CLI. */
      const workAfter = Effect.fnUntraced(function* (sessionId: string, endEventId: string) {
        const later = yield* clientCall("history read", () =>
          client.persistedEventsAfter(sessionId, endEventId),
        );
        if (later === undefined)
          return yield* protocolError("Copilot's history no longer has the end of this turn");
        // Each fork notes itself in its source's history.
        return later.filter((event) => event.type !== "session.info");
      });
      const discardFork = Effect.fnUntraced(function* (forkedId: string) {
        const attached = sdkSession;
        if (attached?.sessionId === forkedId) {
          sdkSession = undefined;
          generation += 1;
          yield* detach(attached);
        }
        yield* clientCall("fork cleanup", () => client.deleteSession(forkedId)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Copilot kept a fork T3 could not adopt", forkedId, error),
          ),
        );
      });
      const adoptFork = Effect.fnUntraced(function* (
        forkedId: string,
        args: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
        /** Set for a whole copy, which must end at this event. */
        wholeCopyEnd: string | undefined,
      ) {
        // Work Copilot started after the source was read would be half in the copy.
        if (wholeCopyEnd !== undefined && (yield* workAfter(forkedId, wholeCopyEnd)).length > 0)
          return yield* protocolError(
            "Copilot is running work after this turn; fork once it is idle",
          );
        const source = args.sourceProviderThread;
        const createdAt = yield* DateTime.now;
        return yield* register({
          threadId: args.targetThreadId,
          modelSelection: args.modelSelection ?? input.modelSelection,
          runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
          existingProviderThread: {
            id: idAllocator.derive.providerThread({
              driver: COPILOT_PROVIDER,
              providerInstanceId: options.instanceId,
              nativeThreadId: forkedId,
            }),
            driver: COPILOT_PROVIDER,
            providerInstanceId: options.instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: args.targetThreadId,
            ownerNodeId: args.ownerNodeId ?? null,
            nativeThreadRef: nativeRef(forkedId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: {
              providerThreadId: source.id,
              ...(args.providerTurnId === undefined ? {} : { providerTurnId: args.providerTurnId }),
            },
            createdAt,
            updatedAt: createdAt,
          },
        });
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: COPILOT_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        // Background subagents and work T3 did not start, such as a wake it has yet to show.
        hasPendingBackgroundWork: Effect.sync(
          () =>
            active === undefined &&
            (mainBusy ||
              wake !== undefined ||
              [...subagentsByCall.values()].some((sub) => sub.status === "running")),
        ),
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: COPILOT_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: COPILOT_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) => startOrCompact(args, false),
        compactThread: (args) => startOrCompact(args, true),
        steerTurn: Effect.fn("CopilotAdapter.steerTurn")(
          function* (args) {
            const turn = active;
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread)
            )
              return yield* protocolError("This Copilot turn cannot be steered");
            const sent = yield* send({
              ...(yield* prompt(args.message, false)),
              mode: "immediate",
            }).pipe(
              Effect.tapError((error) =>
                isCopilotRequestRejected(error.cause)
                  ? Effect.void
                  : quarantine(turn, "failed", error.detail),
              ),
            );
            turn.messageIds.add(sent.messageId);
            turn.acceptedSeq = sent.seq;
          },
          (effect, args) =>
            effect.pipe(
              // Holding the event permit keeps session.idle from ending the turn mid-send.
              eventPermit.withPermits(1),
              commands.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: args.providerThread.id,
                    providerTurnId: args.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        // Copilot reports the stop as the subagent's cancelled completion, which settles its row.
        stopSubagent: Effect.fn("CopilotAdapter.stopSubagent")(function* (args) {
          const sub = validateThread(args.providerThread)
            ? subagentsByCall.get(args.nativeTaskId)
            : undefined;
          if (!sub) return yield* protocolError("This Copilot subagent is no longer running");
          if (sub.status !== "running") return;
          const cancelled = yield* call("subagent stop", (current) =>
            current.cancelSubagent(args.nativeTaskId),
          );
          if (!cancelled) return yield* protocolError("Copilot could not stop this subagent");
        }),
        interruptTurn: Effect.fn("CopilotAdapter.interruptTurn")(
          function* (args) {
            const turn = active;
            // Stop with no turn running ends the background agents that outlived their turns.
            if (
              !turn &&
              args.requestRuntimeRestart === true &&
              validateThread(args.providerThread)
            ) {
              if ([...subagentsByCall.values()].some((sub) => sub.status === "running"))
                yield* call("background stop", (current) => current.cancelBackgroundAgents());
              return;
            }
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread)
            )
              return yield* protocolError("This Copilot turn is no longer active");
            turn.interruptRequested = true;
            // Stops the main loop only; background agents keep running and report later.
            const interrupted = yield* call("interrupt", (current) =>
              turn.compacting ? current.abortCompaction().then(() => true) : current.interrupt(),
            ).pipe(
              Effect.tapError((error) => Effect.logWarning("Copilot interrupt failed", error)),
              Effect.option,
            );
            // No loop ran, e.g. a turn held open only by a subagent's request.
            if (Option.isSome(interrupted) && interrupted.value === false)
              return yield* eventPermit.withPermits(1)(finish(turn, "interrupted"));
            // Outside the event permit, so the idle that ends the turn can arrive meanwhile.
            const stopped = Option.isNone(interrupted)
              ? Option.none()
              : yield* Deferred.await(turn.done).pipe(Effect.timeoutOption(COPILOT_SETTLE_TIMEOUT));
            if (Option.isSome(stopped)) return;
            yield* Effect.logWarning("Copilot did not confirm the stop; detaching its session");
            yield* eventPermit.withPermits(1)(quarantine(turn, "interrupted"));
          },
          (effect, args) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: args.providerThread.id,
                    providerTurnId: args.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("CopilotAdapter.respondToRuntimeRequest")(
          function* (args) {
            yield* eventPermit.withPermits(1)(
              Effect.gen(function* () {
                const entry = pending.get(args.requestId);
                if (!entry)
                  return yield* protocolError("This Copilot request is no longer pending");
                if (entry.native.type === "approval") {
                  const result = args.decision
                    ? copilotPermissionResult(entry.native.request, args.decision, args.feedback)
                    : undefined;
                  if (!result)
                    return yield* protocolError("Copilot did not offer this approval decision");
                  entry.response = { decision: args.decision };
                  entry.native.resolve(result);
                } else {
                  const raw = args.answers?.["answer"];
                  const answer = (
                    Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : ""
                  ).trim();
                  if (!answer) return yield* protocolError("Copilot needs a nonempty answer");
                  entry.response = { answers: { answer } };
                  entry.native.resolve({
                    answer,
                    wasFreeform: !(entry.native.request.choices ?? []).includes(answer),
                  });
                }
                yield* resolvePending(entry, "resolved");
              }),
            );
          },
          (effect, args) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: COPILOT_PROVIDER,
                    requestId: args.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("CopilotAdapter.readThreadSnapshot")(
          function* (args) {
            if (!validateThread(args.providerThread))
              return yield* protocolError("Snapshot requested for a different Copilot thread");
            return {
              providerThread: thread ?? args.providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [...pending.values()].map((entry) => entry.request),
            };
          },
          (effect, args) =>
            effect.pipe(
              commands.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: args.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("CopilotAdapter.rollbackThread")(
          function* (args) {
            if (!validateThread(args.providerThread))
              return yield* protocolError("Rollback requested for a different Copilot thread");
            if (active)
              return yield* protocolError("Cannot roll back while a Copilot turn is active");
            if (quarantined) yield* eventPermit.withPermits(1)(reattach(allowAll));
            const targetOrdinal =
              args.target.type === "thread_start" ? 0 : args.target.providerTurn.ordinal;
            const eventId = copilotRewindBoundary({
              targetOrdinal,
              providerThreadTurns: args.providerThreadTurns,
              unsentTurnIds,
            });
            if (eventId === null)
              return yield* protocolError(
                "Copilot cannot rewind to exactly this point; revert to an earlier turn",
              );
            if (eventId !== undefined) {
              const result = yield* call("rewind", (current) => current.rewind(eventId));
              if (!REWIND_TRUNCATED.has(result.outcome))
                return yield* protocolError(
                  `Copilot could not rewind its conversation (${result.outcome})`,
                );
            }
            return {
              providerThread: thread ?? args.providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            };
          },
          (effect, args) =>
            effect.pipe(
              commands.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: args.providerThread.id,
                    checkpointId: args.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: Effect.fn("CopilotAdapter.forkThread")(
          function* (args) {
            const source = args.sourceProviderThread;
            const sourceId = source.nativeThreadRef?.nativeId;
            if (
              source.driver !== COPILOT_PROVIDER ||
              source.providerInstanceId !== options.instanceId ||
              !sourceId
            )
              return yield* protocolError("Copilot can fork only its own sessions");
            if (thread) return yield* protocolError("Fork into a session with no Copilot thread");
            const turns = (args.sourceProviderTurns ?? []).filter(
              (candidate) => candidate.providerThreadId === source.id,
            );
            const selected =
              args.providerTurnId === undefined
                ? turns.toSorted((left, right) => right.ordinal - left.ordinal)[0]
                : turns.find((candidate) => candidate.id === args.providerTurnId);
            if (args.providerTurnId !== undefined && !selected)
              return yield* protocolError("Copilot fork turn was not found");
            // Copilot's journal, not T3's turn rows, says what followed the turn: a later T3
            // turn, the user's own CLI work, or nothing after a rollback rewound it away.
            const end = selected?.nativeTurnRef?.fingerprint;
            if (selected && !end)
              return yield* protocolError("Copilot has no fork point after this turn");
            const first = end === undefined ? undefined : (yield* workAfter(sourceId, end))[0];
            if (first && (first.agentId || !COPILOT_FORK_POINTS.has(first.type)))
              return yield* protocolError(
                "Copilot has work after this turn that a fork cannot leave out",
              );
            const toEventId = first?.id;
            const forkedId = yield* clientCall("fork", () =>
              client.forkSession(sourceId, toEventId),
            );
            return yield* adoptFork(forkedId, args, first === undefined ? end : undefined).pipe(
              Effect.tapError(() => discardFork(forkedId)),
            );
          },
          (effect, args) =>
            effect.pipe(
              commands.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: args.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        ),
      };
      return runtime;
    }),
  });
});
