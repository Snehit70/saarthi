import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/screenshot.js", () => ({
  captureScreenshot: vi.fn(async () => ({
    png: Buffer.from("png-data"),
    width: 320,
    height: 200,
    target: "full",
    geometry: "0,0 320x200",
    monitorName: null,
  })),
}));

describe("screenshot CLI contract", () => {
  beforeAll(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "saarthi-shot-"));
    process.env.SAARTHI_STATUS = "0";
  });

  it("writes capture output to disk and returns a path without inline image content", async () => {
    const { registry } = await import("../src/registry.js");
    await import("../src/handlers/screenshots.js");
    const tool = registry.get("screenshot", "capture");
    expect(tool).toBeTruthy();
    const result = await tool!.handler({ target: "full" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.structuredContent?.path).toEqual(expect.any(String));
    expect(existsSync(String(result.structuredContent?.path))).toBe(true);
  });
});
