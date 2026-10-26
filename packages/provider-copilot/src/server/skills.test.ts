import { describe, expect, it } from "@effect/vitest";

import type { CopilotSkill } from "./sdk.ts";
import { copilotProviderSkills, planCopilotSkillInvocation } from "./skills.ts";

const skill = (overrides: Partial<CopilotSkill>): CopilotSkill => ({
  name: "review",
  description: "Reviews the diff",
  source: "project",
  userInvocable: true,
  enabled: true,
  path: "/repo/.github/skills/review/SKILL.md",
  ...overrides,
});

describe("copilotProviderSkills", () => {
  it("names skills by slash command and keeps Copilot's invocability", () => {
    expect(
      copilotProviderSkills([
        skill({ name: "Code Review", commandName: "review" }),
        skill({
          name: "lint",
          source: "personal-copilot",
          description: "",
          userInvocable: false,
          path: "/home/me/.copilot/skills/lint/SKILL.md",
        }),
        { name: "remote", description: "", source: "sdk", userInvocable: true, enabled: true },
      ]),
    ).toEqual([
      {
        name: "review",
        description: "Reviews the diff",
        path: "/repo/.github/skills/review/SKILL.md",
        scope: "project",
        enabled: true,
      },
      {
        name: "lint",
        path: "/home/me/.copilot/skills/lint/SKILL.md",
        scope: "personal",
        enabled: true,
        userInvocable: false,
      },
    ]);
  });
});

describe("planCopilotSkillInvocation", () => {
  const skills = new Set(["review", "test"]);

  it("invokes the first known skill and passes the rest as its input", () => {
    expect(planCopilotSkillInvocation("$review then €test it", skills)).toEqual({
      displayText: "/review then /test it",
      leadingText: "",
      name: "review",
      input: "then /test it",
    });
    expect(planCopilotSkillInvocation("Please\n$test", skills)).toEqual({
      displayText: "Please\n/test",
      leadingText: "Please",
      name: "test",
      input: "",
    });
  });

  it("ignores mentions that are not Copilot skills, such as variables and prices", () => {
    expect(planCopilotSkillInvocation("echo $HOME costs $5", skills)).toBeUndefined();
  });
});
