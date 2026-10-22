vi.mock("../src/lib/desktop-environment.js", () => ({ desktopEnvironment: async () => ({ ...process.env }) }));
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
import { typeText } from "../src/lib/typing.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exec.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null));
    return { stdin: { end: mocks.end, on: mocks.on } };
  });
});

it.each(["-M ctrl -k a", "-", "password $(untouched)", "Hello\nनमस्ते"])(
  "sends literal text through stdin: %s",
  async (text) => {
    await typeText(text);
    expect(mocks.exec).toHaveBeenCalledWith(
      "wtype",
      ["-"],
      expect.objectContaining({ timeout: 10000 }),
      expect.any(Function),
    );
    expect(mocks.end).toHaveBeenCalledWith(text);
    if (text !== "-") expect(JSON.stringify(mocks.exec.mock.calls[0].slice(0, 3))).not.toContain(text);
  },
);

it("rejects excessive typing time and controls before starting a process", async () => {
  await expect(typeText("x".repeat(4000), 1000)).rejects.toThrow("120 seconds");
  await expect(typeText("bad\0text")).rejects.toThrow("control");
  expect(mocks.exec).not.toHaveBeenCalled();
});

it("includes -d only for a positive typing delay", async () => {
  await typeText("hello", 10);
  expect(mocks.exec).toHaveBeenCalledWith(
    "wtype",
    ["-d", "10", "-"],
    expect.objectContaining({ timeout: 10050 }),
    expect.any(Function),
  );
});

it("maps process failure without exposing typed secrets", async () => {
  mocks.exec.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(new Error("private payload")));
    return { stdin: { end: mocks.end, on: mocks.on } };
  });
  await expect(typeText("private payload")).rejects.toThrow("wtype failed");
});
