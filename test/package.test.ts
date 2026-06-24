import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CLI package contract", () => {
  it("declares the built shebang entry and build-time executable permission", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.bin).toEqual({ saarthi: "dist/src/cli.js" });
    expect(pkg.scripts.build).toContain("chmod +x dist/src/cli.js");
    expect(readFileSync("src/cli.ts", "utf8")).toMatch(/^#!\/usr\/bin\/env node/);
    if (statSync("dist/src/cli.js", { throwIfNoEntry: false })) {
      expect(statSync("dist/src/cli.js").mode & 0o111).not.toBe(0);
    }
  });
});
