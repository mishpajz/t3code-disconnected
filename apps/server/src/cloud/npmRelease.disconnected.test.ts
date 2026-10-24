import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";

// t3code-disconnected: release lookups must not run npm or contact the public registry.
it.layer(NodeServices.layer)("disconnected npm release lookups", (it) => {
  it.effect("answers no release without running npm or fetching", () =>
    Effect.gen(function* () {
      const npmRelease = yield* NpmRelease.make().pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected npm") }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected fetch")),
        ),
      );
      expect(yield* npmRelease.get({ spec: "latest" })).toBeNull();
      expect(yield* npmRelease.get({ spec: "0.1.6" })).toBeNull();
    }),
  );
});
