// @effect-diagnostics nodeBuiltinImport:off -- Executes the generated SSH runner against local shell fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

it.layer(NodeServices.layer)("disconnected SSH runner", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "uses installed t3 and fails without downloading when it is missing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-ssh-" });
        const bin = path.join(root, ".local/bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        for (const command of ["curl", "wget", "npm", "npx"]) {
          yield* fs.writeFileString(
            path.join(bin, command),
            "#!/bin/sh\necho UNEXPECTED_DOWNLOAD >&2\nexit 99\n",
          );
          yield* fs.chmod(path.join(bin, command), 0o755);
        }
        const script = buildRemoteT3RunnerScript({ archiveVersion: "1.2.3" });
        const run = () =>
          NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "serve", "a b"], {
            input: script,
            encoding: "utf8",
            env: { HOME: root, PATH: bin },
          });
        const missing = run();
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain("disabled in this build");
        expect(missing.stderr).toContain("Install t3 manually");
        expect(missing.stderr).not.toContain("UNEXPECTED_DOWNLOAD");
        yield* fs.writeFileString(
          path.join(bin, "t3"),
          '#!/bin/sh\nprintf "local <%s> <%s>\\n" "$1" "$2"\n',
        );
        yield* fs.chmod(path.join(bin, "t3"), 0o755);
        const installed = run();
        expect(installed.status).toBe(0);
        expect(installed.stdout.trim()).toBe("local <serve> <a b>");
      }),
  );
});
