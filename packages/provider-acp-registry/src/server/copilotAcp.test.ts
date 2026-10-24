import { describe, expect, it } from "vite-plus/test";

import { isCopilotLocalCommand } from "./copilotAcp.ts";

describe("isCopilotLocalCommand", () => {
  it("matches the copilot binary and wrappers that launch it", () => {
    expect(isCopilotLocalCommand("/usr/local/bin/copilot", ["--acp"])).toBe(true);
    expect(isCopilotLocalCommand("C:\\Tools\\copilot.exe", ["--acp"])).toBe(true);
    expect(isCopilotLocalCommand("/opt/acme/bin/acme-copilot", [])).toBe(true);
    expect(
      isCopilotLocalCommand("C:\\Program Files\\nodejs\\node.exe", [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\index.js",
        "--acp",
      ]),
    ).toBe(true);
  });

  it("does not match other agents", () => {
    expect(isCopilotLocalCommand("/usr/local/bin/claude-agent-acp", [])).toBe(false);
    expect(isCopilotLocalCommand("node", ["/opt/agents/gemini/cli.js", "--acp"])).toBe(false);
  });
});
