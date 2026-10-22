import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  assert: vi.fn(),
  save: vi.fn(),
  spawn: vi.fn(),
  owns: vi.fn(),
  signal: vi.fn(),
  read: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("../src/lib/isolated-desktop.js", () => ({
  assertDesktop: mocks.assert,
  saveDesktop: mocks.save,
}));
vi.mock("../src/lib/isolated-process.js", () => ({
  spawnOwned: mocks.spawn,
  ownsProcess: mocks.owns,
  signalOwned: mocks.signal,
}));
vi.mock("../src/lib/private-json.js", () => ({ readPrivateJson: mocks.read }));
vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual("node:fs/promises")),
  rm: mocks.rm,
}));
import { privateKeyboard } from "../src/lib/isolated-keyboard.js";
const current = { pid: 44, startTime: "3" };
const previous = { pid: 43, startTime: "2" };
const desktop = () =>
  ({
    id: "1234567890abcdef",
    display: "wayland-1",
    keyboard: previous,
  }) as never;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assert.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue(undefined);
  mocks.spawn.mockResolvedValue(current);
  mocks.owns.mockResolvedValue(true);
  mocks.read.mockResolvedValue({ complete: true });
  mocks.signal.mockResolvedValue({ signalled: 1 });
  mocks.rm.mockResolvedValue(undefined);
});
it("retains the previous keyboard until its replacement has a compositor receipt and keeps text off argv", async () => {
  const record = desktop();
  await privateKeyboard(record, ["type"], "Private ✓");
  expect(record).toMatchObject({ keyboard: current, inputBlocked: false });
  expect(mocks.spawn).toHaveBeenCalledWith(
    expect.stringContaining("dist/native/keyboard"),
    [
      expect.stringContaining("/saarthi-isolated/1234567890abcdef/wayland-1"),
      expect.stringMatching(/keyboard-[a-f0-9]+\.json$/),
      "type",
    ],
    expect.objectContaining({ SAARTHI_DESKTOP_ID: "1234567890abcdef" }),
    expect.any(String),
    "Private ✓",
  );
  expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.read.mock.invocationCallOrder[0],
  );
  expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.signal.mock.invocationCallOrder[0],
  );
  expect(mocks.signal).toHaveBeenCalledWith(
    "1234567890abcdef",
    expect.any(String),
    [previous],
    "SIGTERM",
  );
});
it("does not retire a keyboard or replay uncertain input when the replacement dies", async () => {
  mocks.owns.mockResolvedValue(false);
  await expect(privateKeyboard(desktop(), ["key", "28", "0"])).rejects.toThrow(
    /exited/,
  );
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.signal).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalled();
});
it("blocks before spawning if the private desktop is unavailable", async () => {
  mocks.assert.mockRejectedValue(new Error("Private desktop stopped"));
  await expect(privateKeyboard(desktop(), ["key", "28", "0"])).rejects.toThrow(
    /stopped/,
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("blocks a second action after an interrupted keyboard dispatch", async () => {
  await expect(
    privateKeyboard({ ...(desktop() as object), inputBlocked: true } as never, [
      "key",
      "28",
      "0",
    ]),
  ).rejects.toThrow(/unresolved/);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
