import { describe, expect, it } from "vitest";
import {
  clampAbsolutePointToMonitor,
  clampAbsoluteSizeToMonitor,
  clampMoveResize,
  filterWindowsByQuery,
  formatError,
  HyprlandError,
  focusWindowExpression,
  focusWindowParams,
  launchAppExpression,
  moveCursorExpression,
  moveCursorParams,
  moveWindowExpression,
  moveWindowParams,
  resizeWindowExpression,
  pickFirstEmptyWorkspace,
  resizeWindowParams,
  sendShortcutExpression,
  sendShortcutParams,
  sendWindowToWorkspaceExpression,
  sendWindowToWorkspaceParams,
  switchWorkspaceExpression,
  workspaceNeedsSwitch,
} from "../src/lib/hyprland.js";
import type { MonitorInfo, WindowInfo } from "../src/lib/types.js";

describe("clampMoveResize", () => {
  it("clamps too small and too large values", () => {
    expect(clampMoveResize(-20000)).toBe(-10000);
    expect(clampMoveResize(20000)).toBe(10000);
  });

  it("rounds towards zero", () => {
    expect(clampMoveResize(12.8)).toBe(12);
    expect(clampMoveResize(-12.8)).toBe(-12);
  });

  it("throws for NaN", () => {
    expect(() => clampMoveResize(Number.NaN)).toThrow("Numeric value must be finite");
  });
});

describe("monitor-bound clamping", () => {
  const monitor: MonitorInfo = {
    id: 0,
    name: "eDP-1",
    width: 1920,
    height: 1080,
    x: 0,
    y: 0,
    focused: true,
  };

  it("clamps absolute point to monitor bounds", () => {
    expect(clampAbsolutePointToMonitor(monitor, { x: -100, y: 5000 })).toEqual({ x: 0, y: 1079 });
  });

  it("clamps absolute size to monitor dimensions", () => {
    expect(clampAbsoluteSizeToMonitor(monitor, { width: 9999, height: 0.7 })).toEqual({ width: 1920, height: 1 });
  });
});

describe("formatError", () => {
  it("formats HyprlandError with code", () => {
    const err = new HyprlandError("WINDOW_NOT_FOUND", "Window not found");
    expect(formatError(err)).toBe("[WINDOW_NOT_FOUND] Window not found");
  });

  it("formats plain Error without code", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });
});

describe("dispatch parameter builders", () => {
  it("formats address-targeted window dispatch params centrally", () => {
    expect(focusWindowParams("0xabc")).toBe("address:0xabc");
    expect(moveWindowParams("0xabc", "absolute", 10, 20)).toBe("exact 10 20,address:0xabc");
    expect(moveWindowParams("0xabc", "delta", -5, 8)).toBe("-5 8,address:0xabc");
    expect(resizeWindowParams("0xabc", "absolute", 800, 600)).toBe("exact 800 600,address:0xabc");
    expect(resizeWindowParams("0xabc", "delta", 40, -20)).toBe("40 -20,address:0xabc");
    expect(sendWindowToWorkspaceParams("0xabc", "7")).toBe("7,address:0xabc");
  });

  it("normalizes shortcut and cursor params without handler-specific string glue", () => {
    expect(sendShortcutParams("CTRL SHIFT", "L")).toBe("CTRL SHIFT,L");
    expect(sendShortcutParams("", "RETURN")).toBe("RETURN");
    expect(moveCursorParams(120, 300)).toBe("120 300");
  });

  it("formats workspace focus as a Hyprland Lua dispatcher expression", () => {
    expect(switchWorkspaceExpression("7")).toBe('hl.dsp.focus({ workspace = "7" })');
    expect(switchWorkspaceExpression("m+1")).toBe('hl.dsp.focus({ workspace = "m+1" })');
  });

  it("formats remaining mutating actions as Hyprland Lua dispatcher expressions", () => {
    expect(focusWindowExpression("0xabc")).toBe('hl.dsp.focus({ window = "address:0xabc" })');
    expect(moveWindowExpression("0xabc", "absolute", 10, 20)).toBe(
      'hl.dsp.window.move({ x = 10, y = 20, relative = false, window = "address:0xabc" })',
    );
    expect(moveWindowExpression("0xabc", "delta", -5, 8)).toBe(
      'hl.dsp.window.move({ x = -5, y = 8, relative = true, window = "address:0xabc" })',
    );
    expect(resizeWindowExpression("0xabc", "absolute", 800, 600)).toBe(
      'hl.dsp.window.resize({ x = 800, y = 600, relative = false, window = "address:0xabc" })',
    );
    expect(sendWindowToWorkspaceExpression("0xabc", "7")).toBe('hl.dsp.window.move({ workspace = "7", window = "address:0xabc" })');
    expect(sendShortcutExpression("CTRL SHIFT", "L")).toBe('hl.dsp.send_shortcut({ mods = "CTRL SHIFT", key = "L" })');
    expect(moveCursorExpression(120, 300)).toBe("hl.dsp.cursor.move({ x = 120, y = 300 })");
    expect(launchAppExpression('printf "%s" ok')).toBe('hl.dsp.exec_cmd("printf \\"%s\\" ok")');
  });
});

describe("workspace switching helpers", () => {
  it("switches only when both workspaces exist and differ", () => {
    expect(workspaceNeedsSwitch("1", "2")).toBe(true);
    expect(workspaceNeedsSwitch("1", "1")).toBe(false);
    expect(workspaceNeedsSwitch(null, "2")).toBe(false);
    expect(workspaceNeedsSwitch("1", null)).toBe(false);
  });
});

describe("filterWindowsByQuery", () => {
  const windows: WindowInfo[] = [
    {
      id: "0x1",
      class: "org.pwmt.zathura",
      title: "paper.pdf",
      workspace: "3",
      monitor: 0,
      floating: false,
      fullscreen: false,
      focused: false,
      mapped: true,
      hidden: false,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
    },
    {
      id: "0x2",
      class: "kitty",
      title: "tmux",
      workspace: "3",
      monitor: 0,
      floating: false,
      fullscreen: false,
      focused: true,
      mapped: true,
      hidden: false,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
    },
  ];

  it("matches class contains case-insensitively", () => {
    const out = filterWindowsByQuery(windows, { classContains: "ZATHURA" });
    expect(out.map((w) => w.id)).toEqual(["0x1"]);
  });

  it("matches focusedOnly", () => {
    const out = filterWindowsByQuery(windows, { focusedOnly: true });
    expect(out.map((w) => w.id)).toEqual(["0x2"]);
  });
});

describe("pickFirstEmptyWorkspace", () => {
  const windows: WindowInfo[] = [
    {
      id: "0x1",
      class: "kitty",
      title: "a",
      workspace: "1",
      monitor: 0,
      floating: false,
      fullscreen: false,
      focused: true,
      mapped: true,
      hidden: false,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
    },
    {
      id: "0x2",
      class: "kitty",
      title: "b",
      workspace: "2",
      monitor: 0,
      floating: false,
      fullscreen: false,
      focused: false,
      mapped: true,
      hidden: false,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
    },
  ];

  it("returns first empty workspace in range", () => {
    expect(pickFirstEmptyWorkspace(windows, 1, 5)).toBe("3");
  });

  it("returns null when all occupied in range", () => {
    const filled = [...windows, { ...windows[0], id: "0x3", workspace: "3" }];
    expect(pickFirstEmptyWorkspace(filled, 1, 3)).toBeNull();
  });
});
