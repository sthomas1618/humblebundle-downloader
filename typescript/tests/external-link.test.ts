import { describe, expect, it } from "bun:test";

import { formatExternalLinkMessage } from "../src/download/downloader";

describe("formatExternalLinkMessage", () => {
  it("builds a consistent external link message", () => {
    expect(
      formatExternalLinkMessage("Bundle", "Product", "https://example.com"),
    ).toBe("External link found: Bundle/Product : https://example.com");
  });
});
