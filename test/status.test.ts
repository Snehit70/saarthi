import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// status.ts derives its path from homedir() at import and keeps module-global
// state, so set HOME before importing and drive it directly.
let statusPath: string;
let status: typeof import("../src/lib/status.js");

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "saarthi-status-"));
  process.env.HOME = home;
  process.env.SAARTHI_SESSION_ID = "status-test";
  process.env.SAARTHI_STATUS = "1";
  statusPath = join(home, ".local", "state", "saarthi", "status.json");
  status = await import("../src/lib/status.js");
});

async function readSnap(): Promise<any> {
  return JSON.parse(await readFile(statusPath, "utf8"));
}

describe("status feed", () => {
  it("writes an active snapshot with the running step as current", async () => {
    const id = status.emitActive("type_text", "act", "Typing (hidden)");
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.schema).toBe(1);
      expect(s.sessionId).toBe("status-test");
      expect(s.state).toBe("active");
      expect(s.current).toMatchObject({
        tool: "type_text",
        kind: "act",
        state: "running",
        label: "Typing (hidden)",
      });
    });
    status.emitDone(id, true);
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.state).toBe("idle");
      expect(s.current).toBeNull();
      const step = s.recent.find((x: any) => x.id === id);
      expect(step.state).toBe("done");
    });
  });

  it("marks a failed step as error", async () => {
    const id = status.emitActive("window_get", "read", "Inspecting window");
    status.emitDone(id, false);
    await vi.waitFor(async () => {
      const s = await readSnap();
      const step = s.recent.find((x: any) => x.id === id);
      expect(step.state).toBe("error");
    });
  });

  it("keeps at most six recent steps", async () => {
    // Serialize so each pair's fire-and-forget flush settles before the next
    // emit; otherwise the last rename to land may carry a ramp-up snapshot.
    for (let i = 0; i < 10; i += 1) {
      const id = status.emitActive(`tool_${i}`, "read", `step ${i}`);
      status.emitDone(id, true);
      await new Promise((r) => setTimeout(r, 8));
    }
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.recent.length).toBe(6);
    });
  });
});
