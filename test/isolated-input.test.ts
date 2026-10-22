import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  windows: vi.fn(),
  request: vi.fn(),
  assert: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
  audit: vi.fn(),
  keyboard: vi.fn(),
}));
vi.mock("../src/lib/isolated-desktop.js", () => ({
  desktopWindows: mocks.windows,
  desktopRequest: mocks.request,
  assertDesktop: mocks.assert,
}));
vi.mock("../src/lib/isolated-keyboard.js", () => ({
  privateKeyboard: mocks.keyboard,
}));
vi.mock("../src/lib/status.js", () => ({
  recordStepStart: vi.fn(() => 1),
  recordStepDone: vi.fn(),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: mocks.audit }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign((...args: unknown[]) => mocks.exec(...args), {
    [Symbol.for("nodejs.util.promisify.custom")]: mocks.run,
  }),
}));
import {
  validateIsolatedActions,
  performIsolatedAction,
  runIsolatedActions,
} from "../src/lib/isolated-input.js";
const desktop = {
  id: "1234567890abcdef",
  width: 1280,
  height: 800,
  display: "wayland-1",
} as never;
const window = {
  id: 5,
  pid: 42,
  focused: true,
  rect: { x: 100, y: 100, width: 500, height: 400 },
};
const action = (value: Record<string, unknown>) =>
  validateIsolatedActions([{ windowId: 5, pid: 42, ...value }], {
    width: 1280,
    height: 800,
  })[0];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows.mockResolvedValue([window]);
  mocks.assert.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ stdout: "" });
  mocks.audit.mockResolvedValue(undefined);
});
it("preflights all actions, including a late out-of-bounds pointer or unconfirmed Enter", () => {
  expect(() =>
    validateIsolatedActions(
      [{ windowId: 5, pid: 42, action: "move", x: 1280, y: 100 }],
      { width: 1280, height: 800 },
    ),
  ).toThrow(/coordinates/);
  expect(() => action({ action: "key", key: "enter" })).toThrow(/confirmed/);
  expect(() => action({ action: "type", text: "hello\nsubmit" })).toThrow(
    /Enter/,
  );
  expect(() => action({ action: "type", text: "hello\tworld" })).toThrow(
    /Enter/,
  );
});
it("rejects a host/foreign window id, stale PID or lost private focus before injecting input", async () => {
  for (const windows of [
    [],
    [{ ...window, pid: 99 }],
    [{ ...window, focused: false }],
  ]) {
    mocks.windows.mockResolvedValueOnce(windows);
    await expect(
      performIsolatedAction(
        desktop,
        action({ action: "move", x: 200, y: 200 }),
      ),
    ).rejects.toThrow(/identity\/focus/);
  }
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});
it("uses an explicit private Wayland socket and private environment for virtual pointer commands", async () => {
  await performIsolatedAction(
    desktop,
    action({ action: "click", x: 200, y: 200 }),
  );
  expect(mocks.run).toHaveBeenCalledWith(
    expect.stringContaining("dist/native/pointer"),
    [
      `/run/user/${process.getuid?.()}/saarthi-isolated/1234567890abcdef/wayland-1`,
      "1280",
      "800",
      "click",
      "200",
      "200",
      "272",
      "1",
    ],
    expect.objectContaining({
      timeout: 5000,
      env: expect.objectContaining({
        WLR_BACKENDS: "headless",
        SAARTHI_DESKTOP_ID: "1234567890abcdef",
      }),
    }),
  );
});
it("refuses a point outside the declared window even when it fits the desktop", async () => {
  await expect(
    performIsolatedAction(desktop, action({ action: "click", x: 10, y: 10 })),
  ).rejects.toThrow(/outside/);
  expect(mocks.run).not.toHaveBeenCalled();
});
it("reports completed progress and never runs subsequent actions after a failure", async () => {
  mocks.run
    .mockResolvedValueOnce({ stdout: "" })
    .mockRejectedValueOnce(new Error("pointer lost"));
  await expect(
    runIsolatedActions(desktop, [
      { windowId: 5, pid: 42, action: "move", x: 200, y: 200 },
      { windowId: 5, pid: 42, action: "click", x: 200, y: 200 },
      { windowId: 5, pid: 42, action: "type", text: "must not type" },
    ]),
  ).rejects.toMatchObject({
    details: { completedSteps: 1, inFlightStep: 1, totalSteps: 3 },
  });
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.exec).not.toHaveBeenCalled();
});

it("uses physical evdev shortcuts and stdin-only Unicode text through retained private keyboards", async () => {
  await performIsolatedAction(
    desktop,
    action({ action: "key", key: "l", modifiers: ["ctrl"] }),
  );
  expect(mocks.keyboard).toHaveBeenCalledWith(desktop, ["key", "38", "1"]);
  await performIsolatedAction(
    desktop,
    action({ action: "type", text: "Private ✓ हिन्दी" }),
  );
  expect(mocks.keyboard).toHaveBeenLastCalledWith(
    desktop,
    ["type"],
    "Private ✓ हिन्दी",
  );
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.exec).not.toHaveBeenCalled();
});
