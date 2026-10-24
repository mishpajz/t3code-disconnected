import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "./pinnedRuntime.ts";

it.layer(NodeServices.layer)("disconnected runtime downloads", (it) => {
  it.effect("refuses downloads and still reuses a manually installed runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-runtime-" });
      let requests = 0;
      let validations = 0;
      const input = {
        baseDir,
        version: "1.2.3",
        platform: "linux" as const,
        arch: "x64",
        fs,
        path,
        httpClient: HttpClient.make(() => {
          requests += 1;
          return Effect.die("unexpected request");
        }),
        runner: ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected command") }),
        validate: () =>
          Effect.sync(() => {
            validations += 1;
          }),
      };
      const error = yield* Effect.flip(ensurePinnedRuntimeInstalled(input));
      expect(error.message).toContain("disabled in this build");
      expect(requests).toBe(0);
      expect(yield* fs.readDirectory(baseDir)).toEqual([]);

      const paths = pinnedRuntimePaths(path, baseDir, input.version, input.platform);
      yield* fs.makeDirectory(paths.versionDir, { recursive: true });
      yield* fs.writeFileString(paths.entryPath, "manually installed");
      yield* fs.writeFileString(paths.sentinelPath, input.version);
      expect(yield* ensurePinnedRuntimeInstalled(input)).toEqual(paths);
      expect(validations).toBe(1);
      expect(requests).toBe(0);
    }),
  );
});
