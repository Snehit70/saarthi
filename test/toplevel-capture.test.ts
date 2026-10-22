vi.mock("../src/lib/desktop-environment.js", () => ({ desktopEnvironment: async () => ({ ...process.env }) }));
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), window: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.run }) }));
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")), getWindowOrThrow: mocks.window,
  hyprlandEnvironment: vi.fn(async () => ({ WAYLAND_DISPLAY: "wayland-1" })),
}));
import { captureToplevel } from "../src/lib/toplevel-capture.js";
beforeEach(() => { vi.clearAllMocks(); mocks.window.mockResolvedValue({ pid: 42, class: "browser" }); });
it("uses the exact full-width address mapping and bounds both subprocess calls", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify([{ windowId: "0x55ff5980f3c0", identifier: "foreign-7" }]) })
    .mockResolvedValueOnce({ stdout: Buffer.from("png"), stderr: "" });
  expect(await captureToplevel("0x55ff5980f3c0")).toEqual(Buffer.from("png"));
  expect(mocks.run).toHaveBeenNthCalledWith(1, expect.stringContaining("dist/native/toplevels"), [], expect.objectContaining({ timeout: 5000 }));
  expect(mocks.run).toHaveBeenNthCalledWith(2, "grim", ["-T", "foreign-7", "-"], expect.objectContaining({ timeout: 10000 }));
});
it("refuses missing capability or a missing exact mapping without attempting grim", async () => {
  mocks.run.mockRejectedValueOnce(new Error("ENOENT"));
  await expect(captureToplevel("0x123")).rejects.toMatchObject({ code: "SCREENSHOT_FAILED" });
  expect(mocks.run).toHaveBeenCalledTimes(1);
  mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify([{ windowId: "0x124", identifier: "other" }]) });
  await expect(captureToplevel("0x123")).rejects.toThrow(/no unique/);
  expect(mocks.run).toHaveBeenCalledTimes(2);
});
it("rejects a recycled window address before the capture", async () => {
  mocks.window.mockResolvedValueOnce({ pid: 42, class: "browser" }).mockResolvedValueOnce({ pid: 99, class: "browser" });
  mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify([{ windowId: "0x123", identifier: "foreign-7" }]) });
  await expect(captureToplevel("0x123")).rejects.toThrow(/identity changed/);
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
