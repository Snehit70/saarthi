import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registry } from "../src/registry.js";

const mocks = vi.hoisted(() => ({
  focus: vi.fn(),
  assertFocus: vi.fn(),
  shortcut: vi.fn(),
  type: vi.fn(),
  audit: vi.fn(),
}));
const window = {
  id: "0x1",
  class: "helium",
  title: "Original page",
  workspace: "1",
  monitor: 0,
  floating: false,
  fullscreen: false,
  focused: true,
  mapped: true,
  hidden: false,
  position: { x: 0, y: 0 },
  size: { width: 100, height: 100 },
};
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")),
  listWindows: vi.fn(async () => [window]),
  focusWindow: mocks.focus,
  assertWindowFocus: mocks.assertFocus,
  sendShortcut: mocks.shortcut,
}));
vi.mock("../src/lib/typing.js", async () => ({
  ...(await vi.importActual("../src/lib/typing.js")),
  typeText: mocks.type,
}));
vi.mock("../src/lib/audit.js", () => ({ audit: mocks.audit }));
vi.mock("../src/runtime.js", () => ({
  dryRun: false,
  policy: {
    launch: {
      allowedAppAliases: [],
      deniedExecutables: [],
      deniedSubstrings: [],
      maxCommandLength: 240,
      maxLaunchesPerMinute: 30,
      allowCustomCommand: false,
    },
  },
  assertLaunchRateLimit: vi.fn(),
}));

beforeAll(async () => {
  process.env.SAARTHI_STATUS = "0";
  await import("../src/handlers/browser.js");
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertFocus.mockResolvedValue(window);
});

function invoke(verb: string, args: Record<string, unknown>) {
  const tool = registry.get("browser", verb)!;
  return tool.handler(z.object(tool.config.inputSchema).parse(args));
}

it("sends the shared tab shortcut and reports that page verification is required", async () => {
  const result = await invoke("action", { action: "select-tab", tabIndex: 9, windowId: "0x1" });
  expect(mocks.shortcut).toHaveBeenCalledWith("CTRL", "9");
  expect(result.structuredContent).toMatchObject({ sent: true, browser: "helium", verificationRequired: true });
});

it.each([
  { action: "find" },
  { action: "select-tab" },
  { action: "find", query: "one\ntwo" },
  { action: "reload", query: "bad" },
])("validates browser action inputs before focus or input: %j", async (args) => {
  await expect(invoke("action", args)).rejects.toThrow();
  expect(mocks.focus).not.toHaveBeenCalled();
  expect(mocks.type).not.toHaveBeenCalled();
});

it("opens Vimium preview without typing or appending Enter", async () => {
  await invoke("vimium-hint", { visibleText: "ab", commit: false, focusSettleMs: 0, hintSettleMs: 0 });
  expect(mocks.shortcut.mock.calls).toEqual([
    ["", "ESCAPE"],
    ["", "F"],
  ]);
  expect(mocks.type).not.toHaveBeenCalled();
});

it("requires confirmation before sending a gated Vimium hint", async () => {
  await expect(invoke("vimium-hint", { visibleText: "ab", actionKind: "send" })).rejects.toThrow("requires confirmed");
  expect(mocks.focus).not.toHaveBeenCalled();
});

it("sends a confirmed hint without a second Enter action", async () => {
  const result = await invoke("vimium-hint", {
    visibleText: "ab",
    actionKind: "send",
    confirmed: true,
    focusSettleMs: 0,
    hintSettleMs: 0,
  });
  expect(mocks.type).toHaveBeenCalledWith("ab", 0);
  expect(mocks.shortcut.mock.calls).toEqual([
    ["", "ESCAPE"],
    ["", "F"],
  ]);
  expect(result.structuredContent).toMatchObject({ hintTextSent: true, verificationRequired: true });
});

it("returns exit 17 and records failure when navigation title readiness times out", async () => {
  const { executeCli } = await import("../src/cli/execute.js");
  const result = await executeCli(
    ["browser", "open-url", "https://example.com", "--window-id", "0x1", "--ready-timeout-ms", "0", "--json"],
    registry,
  );
  expect(result).toMatchObject({ exitCode: 17, stdout: "" });
  expect(result.stderr).toContain("navigation may have occurred");
  expect(mocks.audit).toHaveBeenLastCalledWith(
    "browser_open_url",
    expect.any(Object),
    false,
    expect.objectContaining({ result: "error", errorCode: "ACTION_TIMEOUT" }),
  );
});
