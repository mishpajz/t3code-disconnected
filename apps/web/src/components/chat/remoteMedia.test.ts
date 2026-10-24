import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canAutoLoadChatMedia } from "./remoteMedia";

// t3code-disconnected: keep upstream's remote media behavior covered with its gate on.
const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("@t3tools/shared/disconnected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/disconnected")>()),
  get REMOTE_FAVICONS_ENABLED() {
    return gate.enabled;
  },
}));

afterEach(() => {
  gate.enabled = true;
});

describe("chat media loading", () => {
  it("allows remote images and video when enabled", () => {
    expect(canAutoLoadChatMedia("https://example.com/image.png")).toBe(true);
    expect(canAutoLoadChatMedia("//example.com/video.mp4")).toBe(true);
  });

  it("blocks remote media while preserving embedded images and local blobs when disabled", () => {
    gate.enabled = false;
    for (const src of [
      "https://example.com/image.png",
      "HTTP://example.com/video.mp4",
      "//example.com/image.png",
      "https://github.com/user/repo/blob/main/image.png",
    ]) {
      expect(canAutoLoadChatMedia(src), src).toBe(false);
    }
    expect(canAutoLoadChatMedia("data:image/png;base64,aGVsbG8=")).toBe(true);
    expect(canAutoLoadChatMedia("blob:http://localhost/local-image")).toBe(true);
  });
});
