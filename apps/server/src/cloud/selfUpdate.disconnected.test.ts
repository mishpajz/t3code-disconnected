import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

it.layer(NodeServices.layer)("disconnected server updates", (it) => {
  it.effect("hides update capabilities and rejects direct RPC updates before downloading", () =>
    Effect.gen(function* () {
      expect(
        SelfUpdate.resolveServerSelfUpdateCapability({
          desktopManaged: true,
          launcherManaged: true,
        }),
      ).toBeNull();
      expect(
        SelfUpdate.resolveServerSelfUpdateCapability({
          desktopManaged: false,
          launcherManaged: true,
        }),
      ).toBeNull();
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-update-" });
      const selfUpdate = yield* SelfUpdate.make().pipe(
        Effect.provide(
          Layer.mergeAll(ServerConfig.layerTest(process.cwd(), baseDir), ManagedPolicy.layerTest()),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected download")),
        ),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected process") }),
        ),
        Effect.provideService(DesktopAppUpdate.DesktopAppUpdate, {
          available: true,
          run: () => Effect.die("unexpected desktop update"),
          commit: () => Effect.die("unexpected desktop update commit"),
        }),
        Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, {
          managed: true,
          requestUpdate: () => Effect.die("unexpected service handoff"),
          prepareTrial: Effect.undefined,
        }),
      );
      const error = yield* Effect.flip(selfUpdate.update({ targetVersion: "1.2.3" }));
      expect(error.message).toContain("disabled in this build");
    }),
  );
});
