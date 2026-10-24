import { REMOTE_FAVICONS_ENABLED } from "@t3tools/shared/disconnected";

// t3code-disconnected: only embedded media loads automatically; workspace assets use their own path.
export function canAutoLoadChatMedia(src: string): boolean {
  return REMOTE_FAVICONS_ENABLED || /^(?:data:|blob:)/i.test(src);
}
