import { vi } from "vitest";
import type { MonitorInfo, WindowInfo } from "../src/lib/types.js";

// Canned desktop state for the in-memory contract tests. The pure parsing in
// hyprland.ts is already covered by hyprland.test.ts; here we fake the live
// backend so tool dispatch, the status wrapper, and structured output can be
// exercised deterministically (no real Hyprland, no /run socket).

export const monitorsFixture: MonitorInfo[] = [
  { id: 0, name: "DP-1", width: 2560, height: 1440, x: 0, y: 0, focused: true },
];

export const windowsFixture: WindowInfo[] = [
  {
    id: "0x111",
    class: "kitty",
    title: "kitty",
    workspace: "1",
    monitor: 0,
    floating: false,
    fullscreen: false,
    focused: true,
    mapped: true,
    hidden: false,
    position: { x: 0, y: 0 },
    size: { width: 1280, height: 1440 },
  },
  {
    id: "0x222",
    class: "zen",
    title: "Zen Browser",
    workspace: "1",
    monitor: 0,
    floating: false,
    fullscreen: false,
    focused: false,
    mapped: true,
    hidden: false,
    position: { x: 1280, y: 0 },
    size: { width: 1280, height: 1440 },
  },
];

// Shared spy so a test can assert a mutating dispatch was never reached in dry-run.
export const dispatchMock = vi.fn(async () => "ok");

/**
 * Build a mock of lib/hyprland.js: keep all pure helpers from the real module
 * and override only the functions that would otherwise touch the live desktop.
 */
export function makeHyprlandMock(actual: Record<string, unknown>): Record<string, unknown> {
  const HyprlandError = actual.HyprlandError as new (code: string, msg: string) => Error;
  return {
    ...actual,
    listMonitors: vi.fn(async () => monitorsFixture.slice()),
    activeWindow: vi.fn(async () => windowsFixture.find((w) => w.focused) ?? null),
    listWindows: vi.fn(async () => windowsFixture.slice()),
    getWindowOrThrow: vi.fn(async (id: string) => {
      const w = windowsFixture.find((x) => x.id === id);
      if (!w) throw new HyprlandError("WINDOW_NOT_FOUND", `Window not found: ${id}`);
      return w;
    }),
    healthCheck: vi.fn(async () => ({
      sessionType: "wayland",
      desktop: "Hyprland",
      hyprlandInstance: "test-sig",
      monitorCount: monitorsFixture.length,
      focusedMonitor: "DP-1",
      activeWindow: windowsFixture[0],
    })),
    listWorkspaces: vi.fn(async () => [{ name: "1", id: 1, monitor: "DP-1", hasFullscreen: false }]),
    focusedWorkspaceName: vi.fn(async () => "1"),
    cursorPosition: vi.fn(async () => ({ x: 100, y: 100 })),
    monitorForWindow: vi.fn(async () => monitorsFixture[0]),
    captureGeometryForTarget: vi.fn(async () => "0,0 1280x1440"),
    hyprctlDispatch: dispatchMock,
  };
}
