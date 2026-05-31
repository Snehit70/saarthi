import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

// Fake the live desktop backend for the whole module graph booted below.
vi.mock("../src/lib/hyprland.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/lib/hyprland.js");
  const { makeHyprlandMock } = await import("./_hypr-fixtures.js");
  return makeHyprlandMock(actual);
});

import { bootClient, type BootedClient } from "./_harness.js";
import { dispatchMock } from "./_hypr-fixtures.js";

let ctx: BootedClient;

beforeAll(async () => {
  ctx = await bootClient();
});

async function readStatus(): Promise<any> {
  return JSON.parse(await readFile(ctx.statusPath, "utf8"));
}

function textOf(res: any): string {
  return res?.content?.[0]?.text ?? "";
}

describe("tool registration", () => {
  it("exposes every tool with a name and input schema", async () => {
    const { tools } = await ctx.client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(51);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "browser_discover",
        "browser_focus",
        "browser_open_url",
        "tmux_list",
        "tmux_capture",
        "tmux_run_command",
        "tmux_send_keys",
      ]),
    );
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
    }
  });
});

describe("status-feed wrapper", () => {
  it("records a done step for a successful read and writes a valid snapshot", async () => {
    const res = await ctx.client.callTool({ name: "window_list", arguments: {} });
    expect(res.isError).toBeFalsy();

    await vi.waitFor(async () => {
      const snap = await readStatus();
      expect(snap.schema).toBe(2);
      expect(snap.sessionId).toBe("test-session");
      expect(snap.task).toMatchObject({
        state: "waiting",
      });
      expect(Array.isArray(snap.recent)).toBe(true);
      const step = [...snap.recent].reverse().find((s: any) => s.tool === "window_list");
      expect(step).toBeTruthy();
      expect(step.state).toBe("done");
      expect(step.kind).toBe("read");
    });
  });

  it("records an error step and propagates isError when a handler throws", async () => {
    const res = await ctx.client.callTool({
      name: "window_get",
      arguments: { windowId: "0x999" },
    });
    expect(res.isError).toBe(true);

    await vi.waitFor(async () => {
      const snap = await readStatus();
      const step = [...snap.recent].reverse().find((s: any) => s.tool === "window_get");
      expect(step).toBeTruthy();
      expect(step.state).toBe("error");
      expect(snap.task.stats.errors).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("overlay lifecycle tools", () => {
  it("keeps a task active between calls until explicit completion", async () => {
    const started: any = await ctx.client.callTool({
      name: "overlay_task_start",
      arguments: { label: "review desktop" },
    });
    expect(started.isError).toBeFalsy();

    const health = await ctx.client.callTool({ name: "desktop_health", arguments: {} });
    expect(health.isError).toBeFalsy();

    await vi.waitFor(async () => {
      const snap = await readStatus();
      expect(snap.state).toBe("active");
      expect(snap.task).toMatchObject({
        label: "review desktop",
        state: "waiting",
      });
      expect(snap.current).toBeNull();
      expect(snap.recent.some((s: any) => s.tool === "desktop_health")).toBe(true);
    });

    const completed = await ctx.client.callTool({
      name: "overlay_task_complete",
      arguments: { status: "done" },
    });
    expect(completed.isError).toBeFalsy();

    await vi.waitFor(async () => {
      const snap = await readStatus();
      expect(snap.state).toBe("idle");
      expect(snap.task.state).toBe("complete");
      expect(snap.task.completedAt).toBeTruthy();
    });
  });
});

describe("dry-run safety", () => {
  it("type_text returns a DRY_RUN summary and types nothing", async () => {
    const res = await ctx.client.callTool({ name: "type_text", arguments: { text: "hello" } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^DRY_RUN type_text length=5/);
  });

  it("mouse_click returns a DRY_RUN summary and clicks nothing", async () => {
    const res = await ctx.client.callTool({
      name: "mouse_click",
      arguments: { x: 10, y: 10, target: "full" },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^DRY_RUN mouse_click/);
  });

  it("never reaches the mutating hyprctl dispatch in dry-run", async () => {
    dispatchMock.mockClear();
    const res = await ctx.client.callTool({
      name: "window_focus",
      arguments: { windowId: "0x111" },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/^DRY_RUN/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("structured output", () => {
  it("desktop_health returns stable structured fields", async () => {
    const res: any = await ctx.client.callTool({ name: "desktop_health", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      monitorCount: 1,
      focusedMonitor: "DP-1",
    });
  });

  it("rejects malformed window ids with a tool error", async () => {
    const res = await ctx.client.callTool({
      name: "window_get",
      arguments: { windowId: "not-an-address" },
    });
    expect(res.isError).toBe(true);
  });
});
