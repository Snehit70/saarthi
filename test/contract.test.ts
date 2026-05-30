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
    expect(tools.length).toBeGreaterThanOrEqual(44);
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
      expect(snap.schema).toBe(1);
      expect(snap.sessionId).toBe("test-session");
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
