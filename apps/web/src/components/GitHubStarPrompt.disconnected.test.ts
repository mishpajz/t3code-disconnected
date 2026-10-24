import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const { add, runAtomCommand } = vi.hoisted(() => ({
  add: vi.fn(),
  runAtomCommand: vi.fn(),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add, close: vi.fn() } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: { checkStarred: {} } }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand }));

// t3code-disconnected: the star prompt must never ask GitHub about the user's stars.
it("never checks stars or asks, however many prompts are sent", async () => {
  const store = new Map([["t3code:github-star-prompt:sent", "10"]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
  const { recordPromptSent } = await import("./GitHubStarPrompt");
  for (let i = 0; i < 3; i++) await recordPromptSent(EnvironmentId.make("environment-1"));
  expect(runAtomCommand).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
