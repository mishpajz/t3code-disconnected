// @effect-diagnostics nodeBuiltinImport:off -- Windows needs taskkill to stop a wrapper's process tree, and SDK callbacks resolve links.
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type ExitPlanModeRequest,
  type ExitPlanModeResult,
  type GetAuthStatusResponse,
  type MCPHTTPServerConfig,
  type PermissionHandler,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution, npmShimExecutable } from "@t3tools/shared/shell";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type CopilotPermissionRequest = Parameters<PermissionHandler>[0];
export type CopilotPermissionResult = PermissionRequestResult;
export type CopilotUserInputRequest = Parameters<
  NonNullable<SessionConfig["onUserInputRequest"]>
>[0];
export type CopilotUserInputResponse = Awaited<
  ReturnType<NonNullable<SessionConfig["onUserInputRequest"]>>
>;
export type CopilotReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
export type CopilotContextTier = NonNullable<SessionConfig["contextTier"]>;
export type CopilotRewindResult = Awaited<ReturnType<CopilotSession["rpc"]["history"]["rewind"]>>;
export type CopilotTodoRow = Awaited<
  ReturnType<CopilotSession["rpc"]["plan"]["readSqlTodos"]>
>["rows"][number];
export type CopilotModel = Awaited<
  ReturnType<CopilotClient["rpc"]["models"]["list"]>
>["models"][number];
export type { ExitPlanModeRequest, ExitPlanModeResult, GetAuthStatusResponse, SessionEvent };

/** Everything here crosses the replay boundary, so it stays JSON. */
export interface CopilotSessionOptions {
  readonly model?: string;
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly contextTier?: CopilotContextTier;
  readonly workingDirectory: string;
  readonly instructions: string;
  readonly mcpServers: Record<string, MCPHTTPServerConfig>;
  /** Context share, 0 to 1, at which Copilot starts compacting in the background. */
  readonly compactionThreshold?: number;
}

export interface CopilotSessionHandlers {
  readonly onEvent: (event: SessionEvent) => void;
  readonly onPermissionRequest: (
    request: CopilotPermissionRequest,
    requestId: string,
  ) => Promise<CopilotPermissionResult>;
  readonly onUserInputRequest: (
    request: CopilotUserInputRequest,
  ) => Promise<CopilotUserInputResponse>;
  readonly onExitPlanModeRequest: (request: ExitPlanModeRequest) => Promise<ExitPlanModeResult>;
  /** Copilot keeps waiting on a permission whose answer did not reach it. */
  readonly onPermissionDeliveryFailed: (requestId: string, cause: unknown) => void;
}

export interface CopilotSendInput {
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<{ readonly type: "file"; readonly path: string }>;
  readonly mode?: "enqueue" | "immediate";
  readonly agentMode?: "interactive" | "plan";
}

export interface CopilotSdkSession {
  readonly sessionId: string;
  readonly send: (input: CopilotSendInput) => Promise<string>;
  readonly abort: () => Promise<void>;
  /** True while Copilot runs a loop or has queued prompts, whoever started them. */
  readonly isProcessing: () => Promise<boolean>;
  readonly setModel: (
    model: string,
    reasoningEffort?: CopilotReasoningEffort,
    contextTier?: CopilotContextTier,
  ) => Promise<void>;
  readonly setApproveAll: (enabled: boolean) => Promise<void>;
  readonly rewind: (eventId: string) => Promise<CopilotRewindResult>;
  readonly readTodos: () => Promise<ReadonlyArray<CopilotTodoRow>>;
  readonly disconnect: () => Promise<void>;
}

/** An unindexed session for one text generation request, with at most built-in tools. */
export interface CopilotTextSessionOptions {
  /** Chosen up front, so the session can be deleted even when its creation never answers. */
  readonly sessionId: string;
  readonly model: string;
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly workingDirectory: string;
  readonly instructions: string;
  /** Built-in tools the session may use; empty means none. */
  readonly builtInTools: ReadonlyArray<string>;
}

export interface CopilotTextSession {
  readonly sessionId: string;
  /** Sends the prompt and resolves with Copilot's events up to its idle. */
  readonly run: (prompt: string) => Promise<ReadonlyArray<SessionEvent>>;
  readonly abort: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

/** A persisted event's identity, as Copilot's journal stores it. */
export interface CopilotPersistedEvent {
  readonly id: string;
  readonly type: string;
  readonly agentId?: string;
}

export interface CopilotSdkClient {
  readonly authStatus: () => Promise<GetAuthStatusResponse>;
  readonly listModels: () => Promise<ReadonlyArray<CopilotModel>>;
  readonly createSession: (
    options: CopilotSessionOptions,
    handlers: CopilotSessionHandlers,
  ) => Promise<CopilotSdkSession>;
  readonly resumeSession: (
    sessionId: string,
    options: CopilotSessionOptions,
    handlers: CopilotSessionHandlers,
  ) => Promise<CopilotSdkSession>;
  /** Copies a session's persisted history up to, not including, an event; resolves the copy's id. */
  readonly forkSession: (sessionId: string, toEventId?: string) => Promise<string>;
  /**
   * The persisted events after one, oldest first, read without resuming the session.
   * Undefined when the journal no longer has that event.
   */
  readonly persistedEventsAfter: (
    sessionId: string,
    eventId: string,
  ) => Promise<ReadonlyArray<CopilotPersistedEvent> | undefined>;
  /** Copilot's history, with when each session last changed in epoch milliseconds. */
  readonly listSessions: () => Promise<
    ReadonlyArray<{ readonly sessionId: string; readonly modifiedAt: number }>
  >;
  /** Removes a session from Copilot's history. */
  readonly deleteSession: (sessionId: string) => Promise<void>;
  /** The caller disconnects and deletes the session; it stays out of the cross-session store. */
  readonly createTextSession: (options: CopilotTextSessionOptions) => Promise<CopilotTextSession>;
  /** Settles when the CLI exits without stop(). */
  readonly exited: Promise<Error>;
  readonly stop: () => Promise<void>;
  /**
   * Kills the CLI without waiting on its sessions; on Windows, its whole process tree.
   * With a reason, `exited` settles with it, so its sessions see the CLI as gone.
   */
  readonly forceStop: (reason?: Error) => Promise<void>;
}

export interface CopilotLaunch {
  readonly platform: NodeJS.Platform;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly cwd: string;
}

export interface CopilotStartControl {
  /** Aborting while the CLI starts kills it and rejects. */
  readonly signal?: AbortSignal;
  readonly onCleanupError?: (error: unknown) => void;
}

export type CopilotSdkFactory = (
  launch: CopilotLaunch,
  control?: CopilotStartControl,
) => Promise<CopilotSdkClient>;

export const COPILOT_START_TIMEOUT_MS = 60_000;

/** T3 owns these; the adapter never reads the others, and model.* frames carry whole prompts. */
const COPILOT_FORWARDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.message",
  "assistant.reasoning",
  "assistant.usage",
  "tool.execution_start",
  "tool.shell_output",
  "tool.execution_complete",
  "permission.completed",
  "session.todos_changed",
  "session.usage_info",
  "session.error",
  "session.warning",
  "session.idle",
  "session.compaction_start",
  "session.compaction_complete",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
]);

// GitHub's built-in MCP server would reach GitHub on its own; T3 provides its tools instead.
const DISABLED_MCP_SERVERS = ["github-mcp-server"];

// The permission handler gets no request id, so T3 answers from the event that carries one.
function sessionConfig(
  options: CopilotSessionOptions,
  handlers: CopilotSessionHandlers,
  opened: Promise<CopilotSession>,
) {
  const answerPermission = async (requestId: string, request: CopilotPermissionRequest) => {
    const session = await opened;
    const result = await handlers
      .onPermissionRequest(request, requestId)
      .catch((): CopilotPermissionResult => ({ kind: "user-not-available" }));
    if (result.kind === "no-result") return;
    // success:false means the request already ended, so only a rejection leaves Copilot waiting.
    await session.rpc.permissions
      .handlePendingPermissionRequest({ requestId, result })
      .catch((cause: unknown) => handlers.onPermissionDeliveryFailed(requestId, cause));
  };
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.contextTier ? { contextTier: options.contextTier } : {}),
    workingDirectory: options.workingDirectory,
    streaming: true,
    // Repository and personal skills and custom agents load only with discovery, as in the CLI.
    enableConfigDiscovery: true,
    // Subagent messages and tools still arrive whole; only their deltas stay out.
    includeSubAgentStreamingEvents: false,
    enableSessionTelemetry: false,
    disabledMcpServers: DISABLED_MCP_SERVERS,
    mcpServers: options.mcpServers,
    ...(options.compactionThreshold === undefined
      ? {}
      : { infiniteSessions: { backgroundCompactionThreshold: options.compactionThreshold } }),
    systemMessage: { mode: "append" as const, content: options.instructions },
    onEvent: (event: SessionEvent) => {
      if (event.type === "permission.requested" && !event.data.resolvedByHook)
        void answerPermission(event.data.requestId, event.data.permissionRequest);
      if (COPILOT_FORWARDED_EVENT_TYPES.has(event.type)) handlers.onEvent(event);
    },
    onPermissionRequest: (): CopilotPermissionResult => ({ kind: "no-result" }),
    onUserInputRequest: (request: CopilotUserInputRequest) => handlers.onUserInputRequest(request),
    onExitPlanModeRequest: (request: ExitPlanModeRequest) =>
      handlers.onExitPlanModeRequest(request),
  } satisfies SessionConfig;
}

export function wrapCopilotSession(session: CopilotSession): CopilotSdkSession {
  return {
    sessionId: session.sessionId,
    send: (input) =>
      session.send({
        prompt: input.prompt,
        ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.agentMode ? { agentMode: input.agentMode } : {}),
      }),
    abort: () => session.abort(),
    isProcessing: async () => (await session.rpc.metadata.isProcessing()).processing,
    // null clears an earlier override; leaving it out would keep it.
    setModel: async (model, reasoningEffort, contextTier) => {
      await session.rpc.model.switchTo({
        modelId: model,
        reasoningEffort: reasoningEffort ?? null,
        ...(contextTier ? { contextTier } : {}),
      });
    },
    setApproveAll: async (enabled) => {
      const { success } = await session.rpc.permissions.setApproveAll({ enabled });
      if (!success)
        throw new Error(`Copilot refused to turn approve-all ${enabled ? "on" : "off"}`);
    },
    rewind: (eventId) => session.rpc.history.rewind({ eventId, mode: "conversation" }),
    readTodos: async () => (await session.rpc.plan.readSqlTodos()).rows,
    disconnect: () => session.disconnect(),
  };
}

export async function openCopilotSession(
  open: (config: SessionConfig) => Promise<CopilotSession>,
  options: CopilotSessionOptions,
  handlers: CopilotSessionHandlers,
) {
  let resolveOpened: (session: CopilotSession) => void = () => {};
  const opened = new Promise<CopilotSession>((resolve) => {
    resolveOpened = resolve;
  });
  const session = await open(sessionConfig(options, handlers, opened));
  resolveOpened(session);
  return wrapCopilotSession(session);
}

/**
 * Trust is what lets Copilot start the project's own MCP servers. A session created before
 * its folder was trusted loaded none, so they load once trust is granted. Best effort: the
 * session works without them.
 */
export async function trustSessionFolder(
  session: Pick<CopilotSession, "rpc">,
  path: string,
): Promise<void> {
  try {
    const folderTrust = session.rpc.permissions.folderTrust;
    if ((await folderTrust.isTrusted({ path })).trusted) return;
    if ((await folderTrust.addTrusted({ path })).success) await session.rpc.mcp.reload();
  } catch {}
}

/** Lexical containment of canonical paths; Windows compares case-insensitively, across drives too. */
export function isPathInside(directory: string, target: string, platform: NodeJS.Platform) {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const relative = path.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Links and junctions, including ones to network shares, resolve before the check; a path
 * that cannot be resolved, such as a missing file, is outside.
 */
async function isReadInside(
  canonicalDirectory: Promise<string>,
  request: { readonly path: string; readonly resolvedPath?: string },
  platform: NodeJS.Platform,
) {
  try {
    const directory = await canonicalDirectory;
    const target = await NodeFSP.realpath(
      request.resolvedPath ?? NodePath.resolve(directory, request.path),
    );
    return isPathInside(directory, target, platform);
  } catch {
    return false;
  }
}

/**
 * Qualified names match only Copilot's own tools: a bare name also matches a custom or MCP
 * tool registered under it. Hooks from the checkout stay off, so nothing runs but the reply.
 */
export async function createCopilotTextSession(
  client: Pick<CopilotClient, "createSession">,
  options: CopilotTextSessionOptions,
  platform: NodeJS.Platform,
): Promise<CopilotTextSession> {
  const events: Array<SessionEvent> = [];
  let idle: () => void = () => {};
  const checkout = NodeFSP.realpath(options.workingDirectory);
  checkout.catch(() => {});
  const session = await client.createSession({
    sessionId: options.sessionId,
    model: options.model,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    workingDirectory: options.workingDirectory,
    streaming: false,
    enableSessionTelemetry: false,
    enableSessionStore: false,
    enableSkills: false,
    enableFileHooks: false,
    disabledMcpServers: DISABLED_MCP_SERVERS,
    availableTools: options.builtInTools.map((name) => `builtin:${name}`),
    excludedTools: ["custom:*", "mcp:*"],
    systemMessage: { mode: "replace", content: options.instructions },
    // Copilot asks before reading an untrusted folder, and nobody is there to answer.
    onPermissionRequest: async (request) =>
      request.kind === "read" && (await isReadInside(checkout, request, platform))
        ? { kind: "approve-once" }
        : { kind: "reject" },
    onUserInputRequest: () => ({ answer: "", wasFreeform: true }),
    onEvent: (event) => {
      if (event.agentId) return;
      events.push(event);
      if (event.type === "session.idle") idle();
    },
  });
  return {
    sessionId: session.sessionId,
    run: async (prompt) => {
      const settled = new Promise<void>((resolve) => {
        idle = resolve;
      });
      const from = events.length;
      await session.send({ prompt });
      await settled;
      return events.slice(from);
    },
    abort: () => session.abort(),
    disconnect: () => session.disconnect(),
  };
}

/** Pages Copilot's journal backwards from its end until it reaches the event. */
export async function readPersistedEventsAfter(
  read: CopilotClient["rpc"]["sessions"]["readPersistedEvents"],
  sessionId: string,
  eventId: string,
): Promise<ReadonlyArray<CopilotPersistedEvent> | undefined> {
  /** Newest first. */
  const newer: Array<ReadonlyArray<CopilotPersistedEvent>> = [];
  let cursor: string | undefined;
  while (true) {
    const page = await read({
      sessionId,
      direction: "backward",
      max: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.cursorStatus !== "ok") throw new Error(`Copilot's history read ${page.cursorStatus}`);
    const events = page.events.map(({ id, type, agentId }) => ({
      id,
      type,
      ...(agentId ? { agentId } : {}),
    }));
    const index = events.findIndex((event) => event.id === eventId);
    if (index >= 0) return [events.slice(index + 1), ...newer.toReversed()].flat();
    newer.push(events);
    if (!page.hasMore) return undefined;
    cursor = page.cursor;
  }
}

export interface CliProcess {
  readonly pid?: number;
  readonly stdin: { readonly destroy: () => void } | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  readonly once: (event: "exit", listener: (code: number | null) => void) => void;
}

/**
 * The SDK exposes no pid and drops its process handle when start fails, so this captures the
 * process the moment the SDK assigns it.
 */
function onCliSpawn(client: CopilotClient, spawned: (child: CliProcess) => void) {
  let current: unknown = Reflect.get(client, "cliProcess");
  Object.defineProperty(client, "cliProcess", {
    configurable: true,
    get: () => current,
    set: (next: unknown) => {
      current = next;
      if (typeof next === "object" && next !== null && "kill" in next) spawned(next as CliProcess);
    },
  });
}

/** taskkill exits 128 when the process is already gone. */
const killWindowsProcessTree = (pid: number) =>
  new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 10_000 },
      (error) => (error && error.code !== 128 ? reject(error) : resolve()),
    );
  });

/**
 * SIGKILL reaches only cmd.exe or a wrapper .exe, so on Windows every SDK kill of the CLI
 * takes the whole tree, and the root dies only after it: /T cannot walk a tree whose root
 * already exited. Closing stdin ends a Copilot CLI that outlived the wrapper anyway.
 */
export function killCliTree(
  child: CliProcess,
  killTree: (pid: number) => Promise<void>,
  onCleanupError: (error: unknown) => void,
) {
  const kill = child.kill.bind(child);
  let tree: Promise<void> | undefined;
  child.kill = (signal) => {
    const pid = child.pid;
    if (pid === undefined) return kill(signal);
    tree ??= killTree(pid)
      .catch(onCleanupError)
      .finally(() => {
        kill(signal);
      });
    return true;
  };
  child.once("exit", () => child.stdin?.destroy());
}

/** Launches the user's CLI; never the SDK's bundled runtime, which it would only use without a path. */
export const makeCopilotSdkFactory =
  (killTree: (pid: number) => Promise<void> = killWindowsProcessTree): CopilotSdkFactory =>
  async (launch, control = {}) => {
    const { signal, onCleanupError = () => {} } = control;
    if (signal?.aborted) throw new Error("Copilot CLI start was cancelled");
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({
        path: launch.command,
        args: [...launch.args],
        env: launch.env,
      }),
      workingDirectory: launch.cwd,
      logLevel: "error",
    });
    let child: CliProcess | undefined;
    onCliSpawn(client, (spawned) => {
      child = spawned;
      if (launch.platform === "win32") killCliTree(spawned, killTree, onCleanupError);
    });
    let stopping = false;
    let reportExit: (error: Error) => void = () => {};
    const exited = new Promise<Error>((resolve) => {
      reportExit = resolve;
    });
    let killing: Promise<void> | undefined;
    const kill = () => {
      stopping = true;
      killing ??= client.forceStop().catch(onCleanupError);
      return killing;
    };
    let onAbort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        void kill().then(() => reject(new Error("Copilot CLI start was cancelled")));
      };
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([client.start(), cancelled]);
    } catch (error) {
      stopping = true;
      await client.forceStop().catch(onCleanupError);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    child?.once("exit", (code) => {
      if (stopping) return;
      reportExit(new Error(`Copilot CLI exited unexpectedly (${code})`));
      void kill();
    });
    return {
      authStatus: () => client.getAuthStatus(),
      listModels: async () => (await client.rpc.models.list({})).models,
      createSession: (options, handlers) =>
        // Trusted for good, as answering the CLI's folder trust prompt does, so resumes keep it.
        openCopilotSession(
          (config) => client.createSession({ ...config, trustWorkingDirectory: "user" }),
          options,
          handlers,
        ),
      resumeSession: (sessionId, options, handlers) =>
        openCopilotSession(
          async (config) => {
            const session = await client.resumeSession(sessionId, config);
            await trustSessionFolder(session, options.workingDirectory);
            return session;
          },
          options,
          handlers,
        ),
      forkSession: async (sessionId, toEventId) =>
        (await client.rpc.sessions.fork({ sessionId, ...(toEventId ? { toEventId } : {}) }))
          .sessionId,
      persistedEventsAfter: (sessionId, eventId) =>
        readPersistedEventsAfter(
          (params) => client.rpc.sessions.readPersistedEvents(params),
          sessionId,
          eventId,
        ),
      listSessions: async () =>
        (await client.listSessions()).map(({ sessionId, modifiedTime }) => ({
          sessionId,
          modifiedAt: modifiedTime.getTime(),
        })),
      deleteSession: (sessionId) => client.deleteSession(sessionId),
      createTextSession: (options) => createCopilotTextSession(client, options, launch.platform),
      exited,
      stop: async () => {
        stopping = true;
        await client.stop();
      },
      forceStop: (reason) => {
        if (reason) reportExit(reason);
        return kill();
      },
    };
  };

export const makeCopilotSdkClient: CopilotSdkFactory = makeCopilotSdkFactory();

/**
 * True only when the request provably never took effect: it was never written, or Copilot
 * answered it with an error. A lost connection leaves that unknown.
 */
export function isCopilotRequestRejected(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;
  if (typeof code !== "number") return false;
  // vscode-jsonrpc: positive codes are ConnectionErrors thrown before writing; -32097 and
  // -32096 reject requests pending when the connection went away.
  return code > 0 || (code !== -32097 && code !== -32096);
}

/** A timeout or interrupt while the CLI starts kills it, e.g. a wrapper waiting for an interactive sign-in. */
export const startCopilotClient = Effect.fn("startCopilotClient")(function* (
  createClient: CopilotSdkFactory,
  launch: CopilotLaunch,
) {
  // @effect-diagnostics-next-line abortControllerInEffect:off - Interruption must abort before awaiting the CLI's stop.
  const controller = new AbortController();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const starting = createClient(launch, {
    signal: controller.signal,
    onCleanupError: (error) =>
      runFork(Effect.logWarning("Copilot CLI process tree cleanup failed", error)),
  });
  return yield* Effect.tryPromise(() => starting).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => controller.abort()).pipe(
        Effect.andThen(
          Effect.promise(() =>
            starting.then(
              (client) => client.stop().catch(() => undefined),
              () => undefined,
            ),
          ),
        ),
      ),
    ),
  );
});

function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : environment[key];
}

export class CopilotLaunchArgumentError extends Schema.TaggedError<CopilotLaunchArgumentError>()(
  "CopilotLaunchArgumentError",
  { argument: Schema.String },
) {
  override get message(): string {
    return `cmd.exe cannot pass this Copilot launch argument unchanged: ${this.argument}`;
  }
}

const GITHUB_TOKEN_VARIABLES = new Set(["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]);

/**
 * Node quotes only arguments with a space or tab, so cmd.exe reads every other argument raw.
 * Inside those quotes cmd.exe still expands %, and a literal " cannot survive both parsers.
 */
function cmdArgument(argument: string, metacharacters: RegExp): string | undefined {
  if (/["\r\n]/.test(argument)) return undefined;
  if (/[ \t]/.test(argument)) return argument.includes("%") ? undefined : argument;
  return argument.replace(metacharacters, "^$&");
}

/**
 * Resolves the configured binary to an absolute path: the SDK spawns without a shell and
 * requires the file to exist. Windows script shims run under cmd.exe.
 */
export const resolveCopilotLaunch = Effect.fn("resolveCopilotLaunch")(function* (input: {
  readonly binaryPath: string;
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly hideGitHubTokens?: boolean;
}): Effect.fn.Return<CopilotLaunch | undefined, CopilotLaunchArgumentError> {
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved = resolveExecutable(input.binaryPath, platform, input.environment);
  if (resolved === undefined) return undefined;
  const env = Object.fromEntries(
    Object.entries(input.environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(input.hideGitHubTokens && GITHUB_TOKEN_VARIABLES.has(entry[0].toUpperCase())),
    ),
  );
  const extraArgs = tokenizeCliArgs(input.launchArgs);
  const base = { platform, env, cwd: input.cwd };
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(resolved)) {
    return { ...base, command: resolved, args: extraArgs };
  }
  const shimTarget = npmShimExecutable(resolved);
  if (shimTarget !== undefined) return { ...base, command: shimTarget, args: extraArgs };
  const systemRoot = windowsEnvironmentValue(input.environment, "SystemRoot");
  const escaped: Array<string> = [];
  for (const [index, argument] of [resolved, ...extraArgs].entries()) {
    const next = cmdArgument(argument, index === 0 ? /[()&<>@^|%!]/g : /[()&<>^|%!]/g);
    if (next === undefined) return yield* new CopilotLaunchArgumentError({ argument });
    escaped.push(next);
  }
  return {
    ...base,
    command:
      windowsEnvironmentValue(input.environment, "ComSpec") ??
      (systemRoot ? `${systemRoot}\\System32\\cmd.exe` : "cmd.exe"),
    // /d prevents AutoRun stdout, /v:off keeps ! literal; bare @ preserves quoted paths that cmd /c would unquote.
    args: ["/d", "/v:off", "/c", ...(/[ \t]/.test(resolved) ? ["@"] : []), ...escaped],
  };
});
