vi.mock("../src/lib/desktop-environment.js", () => ({ desktopEnvironment: async () => ({ ...process.env }) }));
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ focus: vi.fn(), restore: vi.fn(), switch: vi.fn(), run: vi.fn() }));
vi.mock("../src/lib/toplevel-capture.js", () => ({ captureToplevel: (...args: unknown[]) => mocks.run(...args) }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.run }),
}));
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")),
  activeWindow: vi.fn(async () => ({
    id: "0x1",
    workspace: "2",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
  })),
  focusedWorkspaceName: vi.fn(async () => "1"),
  getWindowOrThrow: vi.fn(async () => ({
    id: "0x1",
    workspace: "2",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
  })),
  focusWindow: mocks.focus,
  restoreWorkspaceIfNeeded: mocks.restore,
  switchWorkspaceIfNeeded: mocks.switch,
}));
import { captureScreenshot } from "../src/lib/screenshot.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.switch.mockResolvedValue(true);
  mocks.focus.mockResolvedValue("ok");
});

it("restores the original workspace if focusing fails after switching", async () => {
  mocks.focus.mockRejectedValueOnce(new Error("window disappeared"));
  await expect(captureScreenshot({ target: "window", windowId: "0x1", allowFocus: true })).rejects.toThrow(
    "window disappeared",
  );
  expect(mocks.restore).toHaveBeenCalledWith("1", "2");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("bounds screenshot execution and restores the workspace on capture failure", async () => {
  mocks.run.mockRejectedValueOnce(new Error("capture timed out"));
  await expect(captureScreenshot({ target: "window", windowId: "0x1", allowFocus: true })).rejects.toThrow(
    "capture timed out",
  );
  expect(mocks.run).toHaveBeenCalledWith("grim", expect.any(Array), expect.objectContaining({ timeout: 10000 }));
  expect(mocks.restore).toHaveBeenCalledWith("1", "2");
});

it("never switches workspace or focuses a window when background capture fails", async () => {
  mocks.run.mockRejectedValueOnce(new Error("capture unsupported"));
  await expect(captureScreenshot({ target: "window", windowId: "0x1" })).rejects.toThrow("capture unsupported");
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(mocks.switch).not.toHaveBeenCalled();
  expect(mocks.restore).not.toHaveBeenCalled();
});
