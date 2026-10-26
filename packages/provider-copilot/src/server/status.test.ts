import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { CopilotSettings } from "../settings.ts";
import type { CopilotModel, CopilotSdkClient, GetAuthStatusResponse } from "./sdk.ts";
import { checkCopilotProviderStatus, SDK_PROBE_TIMEOUT_MS } from "./status.ts";

const settings = Schema.decodeSync(CopilotSettings);

const makeClient = (auth: GetAuthStatusResponse, models: ReadonlyArray<CopilotModel> = []) => {
  const client: CopilotSdkClient = {
    authStatus: vi.fn(async () => auth),
    listModels: vi.fn(async () => models),
    createSession: vi.fn(async () => {
      throw new Error("status must not open a session");
    }),
    resumeSession: vi.fn(async () => {
      throw new Error("status must not open a session");
    }),
    forkSession: vi.fn(async () => {
      throw new Error("status must not fork a session");
    }),
    persistedEventsAfter: vi.fn(async () => {
      throw new Error("status must not read history");
    }),
    listSessions: vi.fn(async () => {
      throw new Error("status must not read history");
    }),
    deleteSession: vi.fn(async () => {
      throw new Error("status must not delete a session");
    }),
    createTextSession: vi.fn(async () => {
      throw new Error("status must not open a session");
    }),
    exited: new Promise(() => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
  };
  return client;
};

const fakeCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "copilot-status-test-" });
  return writeFakeCli({
    directory,
    name: "copilot",
    source: 'process.stdout.write("GitHub Copilot CLI 1.0.103.\\n");',
  });
});

it.layer(NodeServices.layer)("Copilot status", (it) => {
  it.effect("reads sign-in and models without opening a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli;
        const client = makeClient({ isAuthenticated: true, authType: "user", login: "octocat" }, [
          {
            id: "auto",
            name: "Auto",
            capabilities: { supports: {}, limits: {} } as CopilotModel["capabilities"],
          },
          {
            id: "gpt-6-luna",
            name: "GPT-6 Luna",
            capabilities: { supports: {}, limits: {} } as CopilotModel["capabilities"],
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
          {
            id: "claude-opus-5.5",
            name: "Claude Opus 5.5",
            capabilities: { supports: {}, limits: {} } as CopilotModel["capabilities"],
            billing: { tokenPrices: { longContext: { maxPromptTokens: 1_000_000 } } },
          },
          {
            id: "blocked",
            name: "Blocked",
            capabilities: { supports: {}, limits: {} } as CopilotModel["capabilities"],
            policy: { state: "disabled", terms: "" },
          },
        ]);
        const snapshot = yield* checkCopilotProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["typed-model"] }),
          process.env,
          process.cwd(),
          async () => client,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("1.0.103");
        expect(snapshot.auth).toEqual({ status: "authenticated", type: "user", label: "octocat" });
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "auto",
          "gpt-6-luna",
          "claude-opus-5.5",
          "typed-model",
        ]);
        const options = (slug: string) =>
          snapshot.models.find((model) => model.slug === slug)?.capabilities?.optionDescriptors;
        const effort = options("gpt-6-luna")?.[0];
        expect(effort?.type === "select" && effort.currentValue).toBe("medium");
        expect(options("gpt-6-luna")?.map((option) => option.id)).toEqual(["reasoningEffort"]);
        const tier = options("claude-opus-5.5")?.[0];
        expect(tier?.id).toBe("contextWindow");
        expect(tier?.type === "select" && tier.options.map((option) => option.id)).toEqual([
          "default",
          "long_context",
        ]);
        expect(client.createSession).not.toHaveBeenCalled();
        expect(client.stop).toHaveBeenCalledOnce();
        expect(snapshot.supportsTextGeneration).toBe(true);
      }),
    ),
  );

  it.effect("reports a signed-out CLI without listing models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli;
        const client = makeClient({ isAuthenticated: false });
        const snapshot = yield* checkCopilotProviderStatus(
          settings({ enabled: true, binaryPath }),
          process.env,
          process.cwd(),
          async () => client,
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(client.listModels).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("reports a missing binary as not installed without starting the SDK", () =>
    Effect.gen(function* () {
      const createClient = vi.fn(async () => makeClient({ isAuthenticated: true }));
      const snapshot = yield* checkCopilotProviderStatus(
        settings({ enabled: true, binaryPath: "/nonexistent/copilot" }),
        process.env,
        process.cwd(),
        createClient,
      );
      expect(snapshot.installed).toBe(false);
      expect(createClient).not.toHaveBeenCalled();
    }),
  );

  it.effect("kills a CLI that never answers when the probe times out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "copilot-status-hang-" });
        const socketPath =
          (yield* HostProcess.Platform) === "win32"
            ? `\\\\.\\pipe\\${path.basename(directory)}`
            : path.join(directory, "cli.sock");
        const connected = yield* Deferred.make<void>();
        const disconnected = yield* Deferred.make<void>();
        const server = NodeNet.createServer((socket) => {
          Deferred.doneUnsafe(connected, Effect.void);
          socket.on("close", () => Deferred.doneUnsafe(disconnected, Effect.void));
        });
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            server.listen(socketPath, () => resume(Effect.void));
          }),
          () => Effect.sync(() => server.close()),
        );
        // Like a wrapper waiting for an interactive sign-in: alive, but silent on stdio.
        const binaryPath = writeFakeCli({
          directory,
          name: "copilot",
          env: { COPILOT_TEST_SOCKET: socketPath },
          source: [
            'import { connect } from "node:net";',
            'if (process.argv.includes("--version")) {',
            '  process.stdout.write("GitHub Copilot CLI 1.0.103.\\n");',
            "  process.exit(0);",
            "}",
            "connect(process.env.COPILOT_TEST_SOCKET);",
          ].join("\n"),
        });
        const probe = yield* checkCopilotProviderStatus(
          settings({ enabled: true, binaryPath }),
          process.env,
          directory,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(connected);
        yield* TestClock.adjust(SDK_PROBE_TIMEOUT_MS);
        const snapshot = yield* Fiber.join(probe);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("did not answer");
        yield* Deferred.await(disconnected);
      }),
    ),
  );
});
