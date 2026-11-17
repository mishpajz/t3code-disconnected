import { buildHostedPairingUrl } from "../../hostedPairing";
import { PROMPT_LINKS_ENABLED } from "@t3tools/shared/disconnected";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  // t3code-disconnected: opening a hosted pairing link sends the endpoint to app.t3.codes.
  if (!PROMPT_LINKS_ENABLED) return null;
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
