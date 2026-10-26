import type { ServerProviderSkill } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";

import type { CopilotSkill } from "./sdk.ts";

const SKILL_SCOPES: Partial<Record<CopilotSkill["source"], string>> = {
  project: "project",
  inherited: "project",
  "personal-copilot": "personal",
  "personal-agents": "personal",
  builtin: "system",
};

/** Named by slash command, since that is what the composer inserts and Copilot runs. */
export function copilotProviderSkills(
  skills: ReadonlyArray<CopilotSkill>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.flatMap((skill): ServerProviderSkill[] => {
    const name = (skill.commandName ?? skill.name).trim();
    const path = skill.path?.trim();
    // Pathless skills come from SDK skill providers, which T3 does not register.
    if (!name || !path) return [];
    const description = skill.description.trim();
    return [
      {
        name,
        path,
        scope: SKILL_SCOPES[skill.source] ?? skill.source,
        enabled: skill.enabled,
        ...(description ? { description } : {}),
        ...(skill.userInvocable ? {} : { userInvocable: false }),
      },
    ];
  });
}

export const hasSkillMention = (text: string): boolean => text.search(SKILL_MENTION_PATTERN) >= 0;

export interface CopilotSkillInvocation {
  /** The prompt with every skill mention as `/name`, as Copilot's history shows it. */
  readonly displayText: string;
  /** Text before the invoked skill, sent ahead of its expansion. */
  readonly leadingText: string;
  readonly name: string;
  /** Text after the invoked skill, which Copilot passes to it as arguments. */
  readonly input: string;
}

/** Copilot expands one skill per prompt, so the first mention of a known skill runs. */
export function planCopilotSkillInvocation(
  text: string,
  skillCommands: ReadonlySet<string>,
): CopilotSkillInvocation | undefined {
  const first = [...text.matchAll(SKILL_MENTION_PATTERN)].find((match) =>
    skillCommands.has(match[2] ?? ""),
  );
  if (!first) return undefined;
  const asSlashes = (part: string) =>
    part.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
      skillCommands.has(name) ? `${prefix}/${name}` : match,
    );
  const start = first.index + (first[1]?.length ?? 0);
  return {
    displayText: asSlashes(text),
    leadingText: asSlashes(text.slice(0, start)).trim(),
    name: first[2]!,
    input: asSlashes(text.slice(first.index + first[0].length)).trim(),
  };
}
