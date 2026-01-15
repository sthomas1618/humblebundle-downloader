import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { buildProductFolder, buildTroveFolder, cleanName } from "../src/utils/fs";

describe("fs utils", () => {
  it("cleans names using Python-aligned normalization", () => {
    expect(cleanName("Cool: Game+1.")).toBe("Cool - Game_1");
    expect(cleanName("  Weird@@@Name... ")).toBe("WeirdName");
  });

  it("builds product folder paths", () => {
    const folder = buildProductFolder(
      "/downloads",
      "Bundle:Name",
      "Product+1",
    );

    expect(folder).toBe(join("/downloads", "Bundle -Name", "Product_1"));
  });

  it("builds trove folder paths", () => {
    const folder = buildTroveFolder("/downloads", "Trove:Title");

    expect(folder).toBe(join("/downloads", "Humble Trove", "Trove -Title"));
  });
});
