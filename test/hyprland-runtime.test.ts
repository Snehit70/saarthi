import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const run = vi.fn();
  const exec = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: run });
  return { run, exec, readdir: vi.fn(), access: vi.fn() };
});
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual("node:fs/promises")),
  readdir: mocks.readdir,
  access: mocks.access,
}));

const client = {
  address: "0x1",
  class: "helium",
  title: "Example",
  workspace: { id: 1, name: "1" },
  monitor: 0,
  floating: false,
  fullscreen: false,
  mapped: true,
  hidden: false,
  at: [0, 0],
  size: [100, 100],
};
let hyprland: typeof import("../src/lib/hyprland.js");
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "test-session");
  mocks.readdir.mockResolvedValue([{ name: "test-session", isDirectory: () => true }]);
  mocks.access.mockResolvedValue(undefined);
  mocks.run.mockImplementation(async (_command, args) => ({
    stdout: JSON.stringify(
      args.includes("version") ? { version: "0.55.2" } : args.includes("clients") ? [client] : { address: "0x1" },
    ),
    stderr: "",
  }));
  hyprland = await import("../src/lib/hyprland.js");
});
afterEach(() => vi.unstubAllEnvs());

describe("per-invocation Hyprland discovery", () => {
  it("shares one version probe across concurrent reads and polls but never caches window state", async () => {
    await Promise.all([hyprland.listWindows({}), hyprland.listWindows({})]);
    await hyprland.listWindows({});
    expect(mocks.run.mock.calls.filter(([, args]) => args.includes("version"))).toHaveLength(1);
    expect(mocks.run.mock.calls.filter(([, args]) => args.includes("clients"))).toHaveLength(3);
    expect(mocks.readdir).toHaveBeenCalledTimes(1);
    for (const [, , options] of mocks.run.mock.calls)
      expect(options).toMatchObject({ timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  });

  it("rediscovers after a failed read without replaying the failed command", async () => {
    await hyprland.listWindows({});
    mocks.run.mockRejectedValueOnce(new Error("socket closed"));
    await expect(hyprland.listMonitors()).rejects.toThrow("socket closed");
    await hyprland.listWindows({});
    expect(mocks.run.mock.calls.filter(([, args]) => args.includes("version"))).toHaveLength(2);
    expect(mocks.run.mock.calls.filter(([, args]) => args.includes("monitors"))).toHaveLength(1);
  });

  it("preserves fresh focused state for foreground input", async () => {
    await expect(hyprland.assertWindowFocus("0x1")).resolves.toMatchObject({ id: "0x1" });
    mocks.run.mockImplementation(async (_command, args) => ({
      stdout: JSON.stringify(args.includes("clients") ? [client] : {}),
      stderr: "",
    }));
    await expect(hyprland.assertWindowFocus("0x1")).rejects.toThrow("focus changed");
  });

  it.each(["focusWindow", "moveWindow", "sendWindowToWorkspace"] as const)(
    "rejects a missing window before %s dispatch",
    async (operation) => {
      const call =
        operation === "focusWindow"
          ? hyprland.focusWindow("0xdead")
          : operation === "moveWindow"
            ? hyprland.moveWindow("0xdead", "delta", 1, 2)
            : hyprland.sendWindowToWorkspace("0xdead", "2");
      await expect(call).rejects.toThrow("Window not found");
      expect(mocks.run.mock.calls.some(([, args]) => args[0] === "dispatch")).toBe(false);
    },
  );

  it("rejects hidden targets even for relative resize", async () => {
    mocks.run.mockImplementation(async (_command, args) => ({
      stdout: JSON.stringify(
        args.includes("version")
          ? { version: "0.55.2" }
          : args.includes("clients")
            ? [{ ...client, hidden: true }]
            : { address: "0x1" },
      ),
      stderr: "",
    }));
    await expect(hyprland.resizeWindow("0x1", "delta", 10, 10)).rejects.toThrow("not actionable");
    expect(mocks.run.mock.calls.some(([, args]) => args[0] === "dispatch")).toBe(false);
  });

  it("treats a compositor error with exit zero as failure without replay", async () => {
    mocks.run.mockImplementation(async (_command, args) => ({
      stdout: args[0] === "dispatch" ? "error: rejected" : JSON.stringify({ version: "0.55.2" }),
      stderr: "",
    }));
    await expect(hyprland.sendShortcut("CTRL", "L")).rejects.toThrow("error: rejected");
    expect(mocks.run.mock.calls.filter(([, args]) => args[0] === "dispatch")).toHaveLength(1);
  });

  it("maps a timed-out dispatch without replaying the mutation", async () => {
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "dispatch") throw Object.assign(new Error("timed out"), { killed: true });
      return { stdout: JSON.stringify({ version: "0.55.2" }), stderr: "" };
    });
    await expect(hyprland.sendShortcut("CTRL", "L")).rejects.toMatchObject({ code: "DISPATCH_FAILED" });
    expect(mocks.run.mock.calls.filter(([, args]) => args[0] === "dispatch")).toHaveLength(1);
  });
});
