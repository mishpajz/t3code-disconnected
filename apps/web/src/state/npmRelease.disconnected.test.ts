import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { expect, it, vi } from "vite-plus/test";

import { npmReleasePublishedAtom } from "./npmRelease";

// t3code-disconnected: even a known release must not contact npm or expose an update.
it("never checks npm when release checks are disabled", async () => {
  using fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  const registry = AtomRegistry.make();
  const atom = npmReleasePublishedAtom("1.2.3");
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    expect(AsyncResult.getOrElse(registry.get(atom), () => true)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    unmount();
    registry.dispose();
  }
});
