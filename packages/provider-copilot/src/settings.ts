// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CopilotSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("copilot").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Copilot CLI, or a wrapper that launches it, on this environment. Sign in with copilot login on that host.",
        providerSettingsForm: { placeholder: "copilot", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description:
          "Arguments placed before Copilot's own, for example copilot when the binary path is a wrapper that launches it.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    autoCompactPercent: TrimmedString.check(Schema.isPattern(/^(?:|[1-8]\d|90)$/)).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Auto-compact at",
        description:
          "Percent of the context window, 10 to 90, at which Copilot compacts in the background. Leave empty to use Copilot's default.",
        providerSettingsForm: { placeholder: "e.g. 70", clearWhenEmpty: "omit" },
      }),
    ),
    hideGitHubTokens: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Hide GitHub tokens from Copilot",
        description:
          "Start Copilot without GH_TOKEN, GITHUB_TOKEN, and COPILOT_GITHUB_TOKEN, so it uses its own sign-in.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath", "launchArgs", "autoCompactPercent", "hideGitHubTokens"] },
);
export type CopilotSettings = typeof CopilotSettings.Type;
