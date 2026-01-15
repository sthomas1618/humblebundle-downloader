import { describe, expect, it } from "bun:test";

import { parsePurchaseKeysFromLibraryPage } from "../src/download/downloader";

describe("parsePurchaseKeysFromLibraryPage", () => {
  it("extracts purchase keys from embedded JSON", () => {
    const html = `
      <html>
        <body>
          <script id="user-home-json-data" type="application/json">
            {"gamekeys":["key-one","key-two"]}
          </script>
        </body>
      </html>
    `;

    expect(parsePurchaseKeysFromLibraryPage(html)).toEqual(["key-one", "key-two"]);
  });

  it("returns empty array when missing data", () => {
    const html = "<html><body>No data</body></html>";

    expect(parsePurchaseKeysFromLibraryPage(html)).toEqual([]);
  });
});
