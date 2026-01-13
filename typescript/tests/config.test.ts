import { describe, expect, it } from "bun:test";

import { resolveConfig } from "../src/config";

describe("resolveConfig", () => {
  it("returns defaults when no overrides are provided", () => {
    const config = resolveConfig({});

    expect(config).toEqual({
      cookieFile: undefined,
      libraryPath: "Downloaded Library",
      showProgress: false,
      updateOnly: false,
    });
  });

  it("applies provided overrides", () => {
    const config = resolveConfig({
      cookieFile: "cookies.txt",
      libraryPath: "My Library",
      showProgress: true,
      updateOnly: true,
    });

    expect(config).toEqual({
      cookieFile: "cookies.txt",
      libraryPath: "My Library",
      showProgress: true,
      updateOnly: true,
    });
  });
});
