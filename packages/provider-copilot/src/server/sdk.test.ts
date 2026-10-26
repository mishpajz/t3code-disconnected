// @effect-diagnostics nodeBuiltinImport:off -- Read approvals resolve real symlinks in a temporary checkout.
import { CopilotClient, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import {
  createCopilotTextSession,
  isCopilotRequestRejected,
  isPathInside,
  killCliTree,
  makeCopilotSdkFactory,
  openCopilotSession,
  readPersistedEventsAfter,
  resolveCopilotLaunch,
  trustSessionFolder,
  wrapCopilotSession,
  type CopilotPermissionRequest,
  type CopilotPermissionResult,
  type CopilotSessionHandlers,
} from "./sdk.ts";

async function temporaryDirectory() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-copilot-read-"));
  return { path, [Symbol.asyncDispose]: () => NodeFSP.rm(path, { recursive: true, force: true }) };
}

const fakeSession = (rpc: Record<string, unknown>) =>
  ({ sessionId: "native-1", rpc }) as unknown as CopilotSession;

describe("Copilot SDK session", () => {
  it("fails when Copilot refuses an approve-all change", async () => {
    const setApproveAll = vi.fn(async ({ enabled }: { enabled: boolean }) => ({
      success: !enabled,
    }));
    const session = wrapCopilotSession(fakeSession({ permissions: { setApproveAll } }));
    await session.setApproveAll(false);
    await expect(session.setApproveAll(true)).rejects.toThrow(/approve-all on/);
  });

  it("clears the reasoning effort override when reset to the default", async () => {
    const switchTo = vi.fn(async () => ({}));
    const session = wrapCopilotSession(fakeSession({ model: { switchTo } }));
    await session.setModel("gpt-6-luna", "high");
    await session.setModel("gpt-6-luna");
    assert.deepEqual(switchTo.mock.calls, [
      [{ modelId: "gpt-6-luna", reasoningEffort: "high" }],
      [{ modelId: "gpt-6-luna", reasoningEffort: null }],
    ]);
  });

  it("trusts a resumed session's folder and reloads its MCP servers only when it was untrusted", async () => {
    const trustedFolder = (trusted: boolean, addTrusted = async () => ({ success: true })) => {
      const reload = vi.fn(async () => {});
      const add = vi.fn(addTrusted);
      const session = fakeSession({
        permissions: { folderTrust: { isTrusted: async () => ({ trusted }), addTrusted: add } },
        mcp: { reload },
      });
      return { session, add, reload };
    };
    const trusted = trustedFolder(true);
    await trustSessionFolder(trusted.session, "/workspace");
    expect(trusted.add).not.toHaveBeenCalled();
    expect(trusted.reload).not.toHaveBeenCalled();

    const untrusted = trustedFolder(false);
    await trustSessionFolder(untrusted.session, "/workspace");
    assert.deepEqual(untrusted.add.mock.calls, [[{ path: "/workspace" }]]);
    expect(untrusted.reload).toHaveBeenCalledOnce();

    // The session still resumes, just without the project's MCP servers.
    const refused = trustedFolder(false, async () => {
      throw new Error("unknown method");
    });
    await trustSessionFolder(refused.session, "/workspace");
    expect(refused.reload).not.toHaveBeenCalled();
  });

  it("answers each permission request under the request id from its event", async () => {
    let answered: (value: unknown) => void = () => {};
    const answer = new Promise((resolve) => {
      answered = resolve;
    });
    const handlePendingPermissionRequest = vi.fn(async (params: unknown) => {
      answered(params);
      return { success: true };
    });
    let config: SessionConfig | undefined;
    const onPermissionRequest = vi.fn(async (): Promise<CopilotPermissionResult> => ({
      kind: "approve-once",
    }));
    const handlers: CopilotSessionHandlers = {
      onEvent: () => {},
      onPermissionRequest,
      onUserInputRequest: async () => ({ answer: "", wasFreeform: true }),
      onExitPlanModeRequest: async () => ({ approved: false }),
      onPermissionDeliveryFailed: () => {},
    };
    await openCopilotSession(
      async (next) => {
        config = next;
        return fakeSession({ permissions: { handlePendingPermissionRequest } });
      },
      { workingDirectory: "/workspace", instructions: "", mcpServers: {} },
      handlers,
    );
    const request = { kind: "url", url: "https://example.com" } as CopilotPermissionRequest;
    // The SDK's own answer is suppressed so the event path can answer with the id.
    assert.deepEqual(await config!.onPermissionRequest!(request, { sessionId: "native-1" }), {
      kind: "no-result",
    });
    config!.onEvent!({
      type: "permission.requested",
      data: { requestId: "request-7", permissionRequest: request },
    } as Parameters<NonNullable<SessionConfig["onEvent"]>>[0]);
    assert.deepEqual(await answer, { requestId: "request-7", result: { kind: "approve-once" } });
    assert.deepEqual(onPermissionRequest.mock.calls, [[request, "request-7"]]);
  });

  it("reports an approval answer Copilot did not receive", async () => {
    let failed: (value: unknown) => void = () => {};
    const failure = new Promise((resolve) => {
      failed = resolve;
    });
    let config: SessionConfig | undefined;
    await openCopilotSession(
      async (next) => {
        config = next;
        return fakeSession({
          permissions: {
            handlePendingPermissionRequest: async () => {
              throw new Error("connection closed");
            },
          },
        });
      },
      { workingDirectory: "/workspace", instructions: "", mcpServers: {} },
      {
        onEvent: () => {},
        onPermissionRequest: async () => ({ kind: "approve-once" }),
        onUserInputRequest: async () => ({ answer: "", wasFreeform: true }),
        onExitPlanModeRequest: async () => ({ approved: false }),
        onPermissionDeliveryFailed: (requestId, cause) => failed([requestId, cause]),
      },
    );
    config!.onEvent!({
      type: "permission.requested",
      data: { requestId: "request-7", permissionRequest: { kind: "url", url: "https://x" } },
    } as Parameters<NonNullable<SessionConfig["onEvent"]>>[0]);
    const [requestId, cause] = (await failure) as [string, Error];
    assert.equal(requestId, "request-7");
    assert.equal(cause.message, "connection closed");
  });
});

// Stands in for a wrapper whose CLI refuses the SDK's connect request.
const REFUSING_CLI = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const header = buffer.match(/Content-Length: (\\d+)\\r\\n\\r\\n/);
  if (!header) return;
  const body = buffer.slice(header.index + header[0].length);
  if (body.length < Number(header[1])) return;
  const { id } = JSON.parse(body.slice(0, Number(header[1])));
  const reply = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "refused" } });
  process.stdout.write("Content-Length: " + Buffer.byteLength(reply) + "\\r\\n\\r\\n" + reply);
});
setInterval(() => {}, 1000);
`;

describe("Copilot text session", () => {
  const textSession = async (workingDirectory: string) => {
    let config: SessionConfig | undefined;
    const createSession = vi.fn(async (next: SessionConfig) => {
      config = next;
      return fakeSession({});
    });
    await createCopilotTextSession(
      { createSession } as never,
      {
        sessionId: "text-1",
        model: "gpt-5-mini",
        workingDirectory,
        instructions: "Write JSON.",
        builtInTools: ["view", "grep"],
      },
      NodePath.sep === "\\" ? "win32" : "linux",
    );
    const answer = (request: Record<string, unknown>) =>
      config!.onPermissionRequest!(request as never, { sessionId: "text-1" });
    return { config: config!, answer };
  };

  it("offers only Copilot's own tools, no hooks, under the session id it chose", async () => {
    const { config } = await textSession("/workspace/repo");
    assert.equal(config.sessionId, "text-1");
    assert.deepEqual(config.availableTools, ["builtin:view", "builtin:grep"]);
    assert.deepEqual(config.excludedTools, ["custom:*", "mcp:*"]);
    assert.isFalse(config.enableFileHooks);
    assert.isFalse(config.enableSessionStore);
  });

  it("approves reads only of files that resolve inside the checkout", async () => {
    await using root = await temporaryDirectory();
    const checkout = NodePath.join(root.path, "repo");
    const outside = NodePath.join(root.path, "secrets");
    await NodeFSP.mkdir(NodePath.join(checkout, "src"), { recursive: true });
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(checkout, "src", "a.ts"), "");
    await NodeFSP.writeFile(NodePath.join(outside, "key"), "");
    await NodeFSP.symlink(outside, NodePath.join(checkout, "linked"));
    const { answer } = await textSession(checkout);
    const approve = { kind: "approve-once" };
    const reject = { kind: "reject" };
    assert.deepEqual(
      await answer({ kind: "read", path: NodePath.join(checkout, "src/a.ts") }),
      approve,
    );
    assert.deepEqual(await answer({ kind: "read", path: "src" }), approve);
    assert.deepEqual(
      await answer({ kind: "read", path: NodePath.join(checkout, "linked/key") }),
      reject,
    );
    assert.deepEqual(
      await answer({
        kind: "read",
        path: NodePath.join(checkout, "src/a.ts"),
        resolvedPath: NodePath.join(outside, "key"),
      }),
      reject,
    );
    assert.deepEqual(
      await answer({ kind: "read", path: NodePath.join(checkout, "../secrets/key") }),
      reject,
    );
    assert.deepEqual(
      await answer({ kind: "read", path: NodePath.join(checkout, "missing.ts") }),
      reject,
    );
    assert.deepEqual(
      await answer({ kind: "write", fileName: NodePath.join(checkout, "src/a.ts") }),
      reject,
    );
    // A checkout that does not resolve allows nothing.
    const gone = await textSession(NodePath.join(root.path, "gone"));
    assert.deepEqual(await gone.answer({ kind: "read", path: "a.ts" }), reject);
  });

  it("compares Windows paths case-insensitively and never across drives or shares", () => {
    const inside = (target: string) => isPathInside("C:\\Repo", target, "win32");
    assert.isTrue(inside("c:\\repo\\src\\a.ts"));
    assert.isTrue(inside("C:\\Repo"));
    assert.isFalse(inside("C:\\Repo-other\\a.ts"));
    assert.isFalse(inside("D:\\Repo\\a.ts"));
    assert.isFalse(inside("\\\\server\\share\\Repo\\a.ts"));
  });
});

describe("Copilot persisted history", () => {
  const page = (ids: ReadonlyArray<string>, hasMore: boolean, cursor: string) => ({
    events: ids.map((id) => ({ id, type: "user.message", parentId: null })),
    hasMore,
    cursor,
    cursorStatus: "ok" as const,
  });

  it("pages back from the end until it finds the event", async () => {
    const read = vi.fn(async ({ cursor }: Record<string, unknown>) =>
      cursor === undefined ? page(["c", "d"], true, "older") : page(["a", "b"], false, "done"),
    );
    const after = (eventId: string) => readPersistedEventsAfter(read as never, "s", eventId);
    assert.deepEqual(
      (await after("b"))?.map((event) => event.id),
      ["c", "d"],
    );
    assert.deepEqual(await after("d"), []);
    assert.isUndefined(await after("gone"));
    assert.deepEqual(read.mock.calls[0]?.[0], { sessionId: "s", direction: "backward", max: 200 });
  });
});

describe("Copilot CLI process tree", () => {
  const launch = {
    platform: "win32" as const,
    command: process.execPath,
    args: ["-e", REFUSING_CLI, "--"],
    env: { PATH: process.env.PATH ?? "" },
    cwd: process.cwd(),
  };

  it("kills the tree of a CLI that fails to start before the SDK drops it", async () => {
    const killed: Array<number> = [];
    const killTree = async (pid: number) => {
      killed.push(pid);
      process.kill(pid, "SIGKILL");
    };
    await expect(makeCopilotSdkFactory(killTree)(launch)).rejects.toThrow(/refused/);
    assert.lengthOf(killed, 1);
  });

  it("reports a failed tree kill and still stops the CLI", async () => {
    const errors: Array<unknown> = [];
    const killTree = async () => {
      throw new Error("access denied");
    };
    await expect(
      makeCopilotSdkFactory(killTree)(launch, { onCleanupError: (error) => errors.push(error) }),
    ).rejects.toThrow(/refused/);
    assert.deepEqual(
      errors.map((error) => (error as Error).message),
      ["access denied"],
    );
  });

  it("keeps the process alive when start is cancelled right after the CLI spawned", async () => {
    const rejections: Array<unknown> = [];
    const record = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", record);
    try {
      const controller = new AbortController();
      const starting = makeCopilotSdkFactory()(
        { ...launch, platform: "linux" },
        { signal: controller.signal },
      );
      // The SDK keeps connecting to the killed CLI after forceStop.
      controller.abort();
      await expect(starting).rejects.toThrow(/cancelled/);
    } finally {
      process.off("unhandledRejection", record);
    }
    assert.deepEqual(rejections, []);
  });

  it("kills the tree once and the root after it, however often the SDK kills", async () => {
    let finishTree: () => void = () => {};
    const killTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTree = resolve;
        }),
    );
    let rootKilled: () => void = () => {};
    const rootDone = new Promise<void>((resolve) => {
      rootKilled = resolve;
    });
    const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
      rootKilled();
      return true;
    });
    const child = { pid: 42, stdin: null, kill, once: () => {} };
    killCliTree(child, killTree, () => {});
    // stop() and a concurrent forceStop() both kill while taskkill still runs.
    assert.isTrue(child.kill("SIGTERM"));
    assert.isTrue(child.kill("SIGKILL"));
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    finishTree();
    await rootDone;
    child.kill("SIGKILL");
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("tells the CLI's sessions it exited when it is killed with a reason", async () => {
    using _start = vi.spyOn(CopilotClient.prototype, "start").mockResolvedValue();
    using forceStop = vi.spyOn(CopilotClient.prototype, "forceStop").mockResolvedValue();
    const client = await makeCopilotSdkFactory()({ ...launch, platform: "linux" });
    await client.forceStop(new Error("wedged"));
    assert.equal((await client.exited).message, "wedged");
    expect(forceStop).toHaveBeenCalledTimes(1);
  });

  it("spawns nothing when start was already cancelled", async () => {
    const killTree = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeCopilotSdkFactory(killTree)(
        { ...launch, command: "/nonexistent/copilot" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/);
    expect(killTree).not.toHaveBeenCalled();
  });
});

describe("Copilot send failures", () => {
  it("treats only unsent or refused requests as rejected", () => {
    // ConnectionError before writing, a failed write, and an error reply from Copilot.
    for (const code of [1, -32099, -32603]) assert.isTrue(isCopilotRequestRejected({ code }));
    // The connection went away with the request pending, or nothing says what happened.
    for (const cause of [{ code: -32097 }, { code: -32096 }, new Error("timeout")])
      assert.isFalse(isCopilotRequestRejected(cause));
  });
});

describe("Copilot launch", () => {
  it.effect("escapes cmd.exe metacharacters when a .cmd wrapper launches Copilot", () =>
    Effect.gen(function* () {
      const resolve = (launchArgs: string, binary = "C:\\Tools\\launcher.cmd") =>
        resolveCopilotLaunch({
          binaryPath: "launcher",
          launchArgs,
          environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
          cwd: "C:\\work",
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => binary),
        );
      const launch = yield* resolve(`copilot --banner=a&b "two words" 50%`);
      assert.deepEqual(launch?.args, [
        "/d",
        "/v:off",
        "/c",
        "C:\\Tools\\launcher.cmd",
        "copilot",
        "--banner=a^&b",
        "two words",
        "50^%",
      ]);
      const spaced = yield* resolve("copilot", "C:\\Program Files\\launcher (x86)\\launcher.cmd");
      assert.deepEqual(spaced?.args, [
        "/d",
        "/v:off",
        "/c",
        "@",
        "C:\\Program Files\\launcher (x86)\\launcher.cmd",
        "copilot",
      ]);
      const unsafe = yield* resolve(`"100% sure"`).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(unsafe));
    }),
  );

  it.effect("hides GitHub tokens from Copilot only when asked", () =>
    Effect.gen(function* () {
      const environment = {
        PATH: "/usr/bin",
        GH_TOKEN: "a",
        github_token: "b",
        COPILOT_GITHUB_TOKEN: "c",
      };
      const resolve = (hideGitHubTokens: boolean) =>
        resolveCopilotLaunch({
          binaryPath: "copilot",
          launchArgs: "",
          environment,
          cwd: "/work",
          hideGitHubTokens,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(SpawnExecutableResolution, () => "/usr/bin/copilot"),
        );
      assert.deepEqual((yield* resolve(false))?.env, environment);
      assert.deepEqual((yield* resolve(true))?.env, { PATH: "/usr/bin" });
    }),
  );
});
