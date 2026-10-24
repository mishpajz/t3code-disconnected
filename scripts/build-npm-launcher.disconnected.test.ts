// @effect-diagnostics nodeBuiltinImport:off -- Runs the published launcher with a fetch trap in a subprocess.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

it.layer(NodeServices.layer)("disconnected npm launcher", (it) => {
  it.effect("refuses a missing runtime without fetching, then runs an installed one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-launcher-" });
      const { packageDir } = yield* buildNpmLauncher({ version: "1.2.3", outputDir: root });
      const trap = path.join(root, "trap.mjs");
      yield* fs.writeFileString(
        trap,
        'globalThis.fetch = () => { throw new Error("UNEXPECTED_FETCH"); };',
      );
      const home = path.join(root, "home");
      const launcher = path.join(packageDir, "bin/t3.mjs");
      const run = () =>
        NodeChildProcess.spawnSync(process.execPath, ["--import", trap, launcher, "--version"], {
          encoding: "utf8",
          env: {
            ...process.env,
            T3CODE_HOME: home,
            T3CODE_RELEASE_BASE_URL: "https://example.test",
          },
        });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("disabled in this build");
      expect(result.stderr).not.toContain("UNEXPECTED_FETCH");
      expect(yield* fs.exists(home)).toBe(false);
      if ((yield* HostProcess.Platform) === "win32") return;
      const runtime = path.join(home, "runtime/versions/1.2.3");
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.writeFileString(path.join(runtime, ".install-complete"), "1.2.3\n");
      yield* fs.writeFileString(path.join(runtime, "t3"), '#!/bin/sh\nprintf "local %s\\n" "$*"\n');
      yield* fs.chmod(path.join(runtime, "t3"), 0o755);
      const cached = run();
      expect(cached.status).toBe(0);
      expect(cached.stdout.trim()).toBe("local --version");
    }),
  );
});
