import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  owns: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  ipc: vi.fn(),
}));
vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual("node:fs/promises")),
  lstat: mocks.lstat,
  realpath: mocks.realpath,
}));
vi.mock("../src/lib/isolated-process.js", async () => ({
  ...(await vi.importActual("../src/lib/isolated-process.js")),
  ownsProcess: mocks.owns,
}));
vi.mock("../src/lib/sway-ipc.js", () => ({ swayRequest: mocks.ipc }));
import {
  assertDesktop,
  desktopRequest,
  treeWindows,
} from "../src/lib/isolated-desktop.js";
const record = {
  id: "1234567890abcdef",
  status: "running",
  display: "wayland-1",
  compositor: { pid: 42, startTime: "1" },
  bus: { pid: 43, startTime: "2" },
  devices: { pid: 44, startTime: "3" },
} as never;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owns.mockResolvedValue(true);
  mocks.lstat.mockResolvedValue({
    isSocket: () => true,
    uid: process.getuid?.(),
  });
  mocks.realpath.mockImplementation(async (path) => path);
});
it("never opens IPC when private processes or devices have disappeared", async () => {
  mocks.owns.mockResolvedValueOnce(false);
  await expect(desktopRequest(record, 4)).rejects.toThrow(/no host fallback/);
  expect(mocks.ipc).not.toHaveBeenCalled();
  await expect(
    assertDesktop({ ...(record as object), devices: undefined } as never),
  ).rejects.toThrow(/devices/);
});
it("rejects a replaced private socket instead of using host discovery", async () => {
  mocks.lstat.mockResolvedValueOnce({
    isSocket: () => false,
    uid: process.getuid?.(),
  });
  await expect(desktopRequest(record, 4)).rejects.toThrow(/socket/);
  expect(mocks.ipc).not.toHaveBeenCalled();
  mocks.realpath.mockResolvedValueOnce("/host/socket");
  await expect(desktopRequest(record, 4)).rejects.toThrow(/socket/);
  expect(mocks.ipc).not.toHaveBeenCalled();
});
it("treats a failed Sway command response as failure even when the transport succeeds", async () => {
  mocks.ipc.mockResolvedValue([{ success: false, error: "No matching node" }]);
  await expect(desktopRequest(record, 0, "[con_id=5] focus")).rejects.toThrow(
    /rejected/,
  );
});
it("extracts nested private windows including floating dialogs without inventing Hyprland ids", () => {
  const rect = { x: 0, y: 0, width: 1280, height: 800 };
  expect(
    treeWindows({
      id: 1,
      rect,
      nodes: [
        {
          id: 2,
          rect,
          nodes: [],
          floating_nodes: [
            {
              id: 8,
              pid: 42,
              rect,
              app_id: "app",
              name: "Choose a file",
              focused: true,
            },
          ],
        },
      ],
    }),
  ).toEqual([
    {
      id: 8,
      pid: 42,
      rect,
      appId: "app",
      title: "Choose a file",
      focused: true,
    },
  ]);
});
