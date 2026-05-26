import { describe, expect, it } from "vitest";
import {
  clampAbsolutePointToMonitor,
  clampAbsoluteSizeToMonitor,
  clampMoveResize,
  filterWindowsByQuery,
  formatError,
  HyprlandError,
  pickFirstEmptyWorkspace,
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
