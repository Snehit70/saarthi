import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  hypr: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: mocks.run,
  }),
}));
vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual("node:fs/promises")),
  lstat: mocks.lstat,
  realpath: mocks.realpath,
}));
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")),
  hyprlandEnvironment: mocks.hypr,
}));
let resolve: typeof import("../src/lib/desktop-environment.js").desktopEnvironment;
const runtime = `/run/user/${process.getuid?.()}`;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const key of [
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SAARTHI_DESKTOP_ID",
  ])
    vi.stubEnv(key, undefined);
  mocks.hypr.mockResolvedValue({ HYPRLAND_INSTANCE_SIGNATURE: "selected" });
  mocks.run.mockResolvedValue({
    stdout: JSON.stringify([
      { instance: "selected", pid: 42, wl_socket: "wayland-7" },
    ]),
  });
  mocks.realpath.mockImplementation(async (path) => path);
  mocks.lstat.mockImplementation(async (path) => ({
    uid: process.getuid?.(),
    mode: 0o700,
    isDirectory: () => path === runtime,
    isSocket: () => !path.startsWith("/proc/"),
  }));
  resolve = (await import("../src/lib/desktop-environment.js"))
    .desktopEnvironment;
});
afterEach(() => vi.unstubAllEnvs());
it("fills missing session variables from the exact live instance without assuming a display number", async () => {
  const result = await resolve();
  expect(result).toMatchObject({
    XDG_RUNTIME_DIR: runtime,
    WAYLAND_DISPLAY: `${runtime}/wayland-7`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  });
  expect(process.env.WAYLAND_DISPLAY).toBeUndefined();
  await resolve();
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
it("does not select an unrelated compositor or accept another user's socket", async () => {
  mocks.run.mockResolvedValue({
    stdout: JSON.stringify([
      { instance: "other", pid: 42, wl_socket: "wayland-1" },
    ]),
  });
  await expect(resolve()).rejects.toThrow(/unique/);
  mocks.run.mockResolvedValue({
    stdout: JSON.stringify([
      { instance: "selected", pid: 42, wl_socket: "wayland-7" },
    ]),
  });
  mocks.lstat.mockResolvedValue({ uid: 999999 });
  await expect(resolve()).rejects.toThrow(/another user/);
});
it("rejects conflicting explicit routing rather than silently overwriting it", async () => {
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-99");
  await expect(resolve()).rejects.toThrow(/conflicts/);
});
it("preserves a complete explicit environment and never discovers the host for a private desktop", async () => {
  vi.stubEnv("XDG_RUNTIME_DIR", runtime);
  vi.stubEnv("WAYLAND_DISPLAY", "wayland-4");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=explicit");
  expect((await resolve()).WAYLAND_DISPLAY).toBe("wayland-4");
  expect(mocks.run).not.toHaveBeenCalled();
  vi.stubEnv("SAARTHI_DESKTOP_ID", "1234567890abcdef");
  await expect(resolve()).rejects.toThrow(/forbidden/);
});
