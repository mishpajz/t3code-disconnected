import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { HttpClient } from "effect/http";

import { resolveNewestVersion, updateCommand } from "./update.ts";

// t3code-disconnected: neither version discovery nor explicit updates may reach the network.
it.effect("rejects release discovery without contacting GitHub", () => {
  let requests = 0;
  return resolveNewestVersion("stable").pipe(
    Effect.flip,
    Effect.tap((error) => {
      expect(error.message).toContain("disabled in this build");
      expect(requests).toBe(0);
      return Effect.void;
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        requests += 1;
        return Effect.die("unexpected request");
      }),
    ),
  );
});

it.effect.each([{ args: [] }, { args: ["1.2.3"] }])(
  "rejects t3 update $args before setup",
  ({ args }) =>
    Command.runWith(updateCommand, { version: "0.0.0" })(args).pipe(
      Effect.flip,
      Effect.tap((error) => {
        expect(error).toMatchObject({
          _tag: "CliUpdateError",
          reason: "t3 update is disabled in this build. Install updates manually.",
        });
        return Effect.void;
      }),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    ),
);
