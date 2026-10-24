import type { DesktopBridge } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { resolveTriageCommand } from "./bootError";

// t3code-disconnected: the fallback must not run upstream's t3 through npx.
it("falls back to the installed t3 without a usable desktop launcher", async () => {
  using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(resolveTriageCommand(undefined)).resolves.toBe("t3 triage");
  await expect(resolveTriageCommand({} as DesktopBridge)).resolves.toBe("t3 triage");
});
