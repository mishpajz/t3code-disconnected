import { expect, it } from "@effect/vitest";
import { BITBUCKET_ENABLED } from "@t3tools/shared/disconnected";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  sourceControlDefinitions,
} from "./sourceControlDefinitions.ts";

it("runs a driver for every host the server and clients read, in their order", () => {
  expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.definition)).toEqual(
    // t3code-disconnected: Bitbucket has no driver while it is disabled (DISCONNECTED.md).
    sourceControlDefinitions.definitions.filter(
      (definition) => BITBUCKET_ENABLED || definition.kind !== "bitbucket",
    ),
  );
});

it("t3code-disconnected: runs no Bitbucket driver", () => {
  expect(BITBUCKET_ENABLED).toBe(false);
  expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.kind)).not.toContain(
    "bitbucket",
  );
});
