import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

import type { CopilotLaunch } from "./server/sdk.ts";

export {
  type CopilotPersistedEvent,
  type CopilotSdkClient,
  type CopilotSdkFactory,
  type CopilotSdkSession,
  type CopilotSessionHandlers,
  makeCopilotSdkClient,
  resolveCopilotLaunch,
} from "./server/sdk.ts";

/** Recorders run against the user's real session store; remove exactly the sessions they made. */
export async function deleteCopilotSessions(
  launch: CopilotLaunch,
  sessionIds: ReadonlyArray<string>,
): Promise<void> {
  if (sessionIds.length === 0) return;
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: launch.command,
      args: [...launch.args],
      env: launch.env,
    }),
    workingDirectory: launch.cwd,
    logLevel: "error",
  });
  await client.start();
  try {
    for (const sessionId of sessionIds) await client.deleteSession(sessionId);
  } finally {
    await client.stop();
  }
}
