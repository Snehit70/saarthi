import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// status.ts derives its path from homedir() at import and keeps module-global
// state, so set HOME before importing and drive it directly.
let statusPath: string;
let taskPath: string;
let status: typeof import("../src/lib/status.js");

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "saarthi-status-"));
  process.env.HOME = home;
  process.env.SAARTHI_SESSION_ID = "status-test";
  process.env.SAARTHI_STATUS = "1";
  statusPath = join(home, ".local", "state", "saarthi", "status.json");
  taskPath = join(home, ".local", "state", "saarthi", "overlay-task.json");
  status = await import("../src/lib/status.js");
});

async function readSnap(): Promise<any> {
  return JSON.parse(await readFile(statusPath, "utf8"));
}

describe("status feed", () => {
  it("writes a task-aware snapshot with the running step as current", async () => {
    const task = status.startTask("send a message");
    const id = status.recordStepStart("type_text", "act", "Typing (hidden)");
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.schema).toBe(2);
      expect(s.sessionId).toBe("status-test");
      expect(s.state).toBe("active");
      expect(s.task).toMatchObject({
        id: task.id,
        label: "send a message",
        state: "working",
      });
      expect(s.current).toMatchObject({
        tool: "type_text",
        kind: "act",
        state: "running",
        label: "Typing (hidden)",
      });
    });
    status.recordStepDone(id, true);
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.state).toBe("active");
      expect(s.task.state).toBe("waiting");
      expect(s.current).toBeNull();
      const step = s.recent.find((x: any) => x.id === id);
      expect(step.state).toBe("done");
      expect(s.task.stats).toMatchObject({ steps: 1, acts: 1, errors: 0 });
    });
  });

  it("marks a failed step as error", async () => {
    status.startTask("inspect bad window");
    const id = status.recordStepStart("window_get", "read", "Inspecting window");
    status.recordStepDone(id, false);
    await vi.waitFor(async () => {
      const s = await readSnap();
      const step = s.recent.find((x: any) => x.id === id);
      expect(step.state).toBe("error");
      expect(s.task.state).toBe("waiting");
      expect(s.task.stats.errors).toBe(1);
    });
  });

  it("keeps at most twenty-five recent steps", async () => {
    status.startTask("many steps");
    // Serialize so each pair's fire-and-forget flush settles before the next
    // emit; otherwise the last rename to land may carry a ramp-up snapshot.
    for (let i = 0; i < 30; i += 1) {
      const id = status.recordStepStart(`tool_${i}`, "read", `step ${i}`);
      status.recordStepDone(id, true);
      await new Promise((r) => setTimeout(r, 8));
    }
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.recent.length).toBe(25);
      expect(s.recent[0].tool).toBe("tool_5");
      expect(s.task.stats.steps).toBe(30);
    });
  });

  it("marks task completion as idle after explicit completion", async () => {
    status.startTask("complete me");
    status.completeTask("done");
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.state).toBe("idle");
      expect(s.task.state).toBe("complete");
      expect(s.task.completedAt).toBeTruthy();
    });
  });

  it("supports dormant pings and timeout completion", async () => {
    status.startTask("long wait");
    status.pingTask("dormant_waiting");
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.state).toBe("active");
      expect(s.task.state).toBe("dormant_waiting");
    });

    status.completeTask("timeout");
    await vi.waitFor(async () => {
      const s = await readSnap();
      expect(s.state).toBe("idle");
      expect(s.task.state).toBe("timeout");
    });
  });

  it("persists an explicit task for the next CLI process", async () => {
    const task = status.startTask("cross-process task");
    status.pingTask("dormant_waiting");
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await readFile(taskPath, "utf8"));
      expect(persisted).toMatchObject({ id: task.id, label: "cross-process task", state: "dormant_waiting" });
    });
  });

  it("settles an in-flight command while preserving its explicit task", async () => {
    status.startTask("interrupted task");
    status.recordStepStart("mouse_click", "act", "Clicking");
    status.flushIdleSync();
    const s = await readSnap();
    expect(s.state).toBe("active");
    expect(s.task.state).toBe("waiting");
    expect(s.task.completedAt).toBeNull();
    expect(s.current).toBeNull();
  });
});
