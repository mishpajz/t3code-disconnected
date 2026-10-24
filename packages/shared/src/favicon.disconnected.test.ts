import { describe, expect, it } from "vite-plus/test";

import { faviconUrlForOrigin, toolActivityFaviconUrl } from "./favicon.ts";

// t3code-disconnected: links and provider events must not load third-party icons.
describe("remote favicon gate", () => {
  it("returns the local fallback for Google, site, themed and provider-supplied favicons", () => {
    expect(faviconUrlForOrigin("https://example.com/private", 64)).toBeNull();
    for (const appearance of ["light", "dark"] as const) {
      expect(toolActivityFaviconUrl({ pageUrl: "https://github.com/repo" }, appearance)).toBeNull();
      expect(
        toolActivityFaviconUrl(
          {
            pageUrl: "https://example.com",
            faviconUrl: "https://example.com/icon.png",
            faviconUrlDark: "https://example.com/dark.png",
          },
          appearance,
        ),
      ).toBeNull();
    }
  });
});
