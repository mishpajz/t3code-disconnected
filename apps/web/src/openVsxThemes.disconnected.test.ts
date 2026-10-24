import { describe, expect, it, vi } from "vite-plus/test";

import { importOpenVsxThemeExtension, searchOpenVsxThemes } from "./openVsxThemes";

// t3code-disconnected: neither marketplace entry point may contact Open VSX.
describe("theme marketplace gate", () => {
  it("blocks searching and installing before any fetch", async () => {
    using fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    await expect(searchOpenVsxThemes("dark")).resolves.toEqual([]);
    await expect(
      importOpenVsxThemeExtension({
        collectionId: "open-vsx:demo.theme",
        id: "demo.theme",
        name: "Demo",
        publisher: "demo",
        description: "",
        downloadCount: 1,
        iconUrl: null,
        sourceUrl: null,
        license: "MIT",
        manifestUrl: "https://open-vsx.org/api/demo/theme/package.json",
        sha256Url: "https://open-vsx.org/api/demo/theme/package.sha256",
        version: "1.0.0",
        vsixUrl: "https://open-vsx.org/api/demo/theme/package.vsix",
      }),
    ).rejects.toThrow("Theme marketplace is disabled in this build.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
