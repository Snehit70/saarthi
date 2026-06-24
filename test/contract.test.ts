import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/hyprland.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/lib/hyprland.js");
  const { makeHyprlandMock } = await import("./_hypr-fixtures.js");
  return makeHyprlandMock(actual);
});

let executeCli: typeof import("../src/cli/execute.js").executeCli;
let registry: typeof import("../src/registry.js").registry;
let statusPath: string;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "saarthi-contract-"));
  process.env.HOME = home;
  process.env.SAARTHI_STATE_DIR = join(home, ".local", "state", "saarthi");
  process.env.SAARTHI_DRY_RUN = "1";
  process.env.SAARTHI_SESSION_ID = "test-session";
  process.env.SAARTHI_STATUS = "1";
  statusPath = join(process.env.SAARTHI_STATE_DIR, "status.json");
  ({ executeCli } = await import("../src/cli/execute.js"));
  ({ registry } = await import("../src/registry.js"));
  await import("../src/register-tools.js");
});

describe("full CLI dispatch", () => {
  it("returns structured JSON through the real registered handler", async () => {
    const result = await executeCli(["observability", "desktop-health", "--json"], registry);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ monitorCount: 1, focusedMonitor: "DP-1" });
  });

  it("keeps dry-run mutations safe", async () => {
    const result = await executeCli(["window", "focus", "0x111"], registry);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(/^DRY_RUN/);
  });

  it("maps malformed input to stderr and a stable validation exit", async () => {
    const result = await executeCli(["window", "get", "not-an-address"], registry);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("windowId");
  });

  it("emits a completed read step into the status feed", async () => {
    const result = await executeCli(["window", "list", "--json"], registry);
    expect(result.exitCode).toBe(0);
    await vi.waitFor(async () => {
      const snapshot = JSON.parse(await readFile(statusPath, "utf8"));
      expect(snapshot.sessionId).toBe("test-session");
      expect(snapshot.recent).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: "window_list", kind: "read", state: "done" }),
      ]));
    });
  });
});
