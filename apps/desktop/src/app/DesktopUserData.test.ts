import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { resolveUserDataPath } from "./DesktopUserData.ts";

// t3code-disconnected: the profile migration tests cover upstream's identity, so they turn the
// fork's own identity off.
const disconnectedGate = vi.hoisted(() => ({ ownAppIdentity: false }));
vi.mock("@t3tools/shared/disconnected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/disconnected")>()),
  get DESKTOP_OWN_APP_IDENTITY() {
    return disconnectedGate.ownAppIdentity;
  },
}));

it.effect("uses a profile of its own that is never seeded from upstream's", () =>
  Effect.gen(function* () {
    disconnectedGate.ownAppIdentity = true;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-disconnected-profile-" });
    yield* fs.makeDirectory(path.join(directory, "t3code-v2"), { recursive: true });
    yield* fs.writeFileString(path.join(directory, "t3code-v2", "Local State"), "upstream");
    const userDataPath = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
    });
    assert.equal(userDataPath, path.join(directory, "t3code-disconnected"));
    assert.isFalse(yield* fs.exists(userDataPath));
  }).pipe(
    Effect.ensuring(Effect.sync(() => (disconnectedGate.ownAppIdentity = false))),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
