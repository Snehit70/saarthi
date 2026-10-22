vi.mock("../src/lib/desktop-environment.js", () => ({ desktopEnvironment: async () => ({ ...process.env }) }));
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), scope: vi.fn(), key: vi.fn(), focus: vi.fn(), root: "" }));
vi.mock("node:child_process", () => ({
  execFile: (command: string, args: string[], options: unknown, callback: Function) => ({
    once: () => {},
    stdin: {
      on: () => {},
      end: (input?: Buffer) =>
        queueMicrotask(() => {
          try {
            callback(null, mocks.run(command, args, input, options));
          } catch (error) {
            callback(error, Buffer.alloc(0), (error as { stderr?: string }).stderr);
          }
        }),
    },
  }),
}));
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")),
  assertWindowFocus: mocks.focus,
  sendShortcut: mocks.key,
}));
vi.mock("../src/lib/ui-action.js", () => ({ performUiAction: mocks.scope }));
vi.mock("../src/lib/state.js", () => ({ statePath: (name: string) => join(mocks.root, name) }));
import {
  exportClipboardImages,
  imageMime,
  listClipboardImages,
  parseImageHistory,
  pasteClipboardImages,
} from "../src/lib/clipboard.js";

const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const history =
  "9\t[[ binary data 88 B png 24x24 ]]\n8\tprivate text must not be returned\n7\t[[ binary data 88 B png 24x24 ]]";
let selected: Buffer;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.root = await mkdtemp(join(tmpdir(), "saarthi-clip-test-"));
  selected = Buffer.from("original selection");
  mocks.scope.mockResolvedValue({ ok: true });
  mocks.focus.mockResolvedValue({ id: "0x1" });
  mocks.key.mockResolvedValue("ok");
  mocks.run.mockImplementation((command, args, input) => {
    if (command === "cliphist" && args[0] === "list") return Buffer.from(history);
    if (command === "cliphist" && args[0] === "decode") {
      expect(input.toString()).toMatch(/^\d+$/);
      return Buffer.concat([png, input]);
    }
    if (command === "wl-paste" && args[0] === "--list-types") return Buffer.from("text/plain;charset=utf-8\n");
    if (command === "wl-copy") {
      selected = input;
      return Buffer.alloc(0);
    }
    if (command === "wl-paste") return selected;
    throw new Error("Unexpected clipboard operation");
  });
});
afterEach(async () => {
  await rm(mocks.root, { recursive: true, force: true });
});

it("returns image metadata in history order without text previews", async () => {
  expect(await listClipboardImages()).toEqual([
    { id: "9", format: "png", width: 24, height: 24 },
    { id: "7", format: "png", width: 24, height: 24 },
  ]);
  expect(JSON.stringify(await listClipboardImages())).not.toContain("private text");
  expect(parseImageHistory("bad\ttext\n1\t[[ binary data 1 B png 0x1 ]]")).toEqual([]);
});
it("exports exact bytes into private files and validates explicit ordering", async () => {
  const images = await exportClipboardImages(2, ["7", "9"]);
  expect(images.map((image) => image.id)).toEqual(["7", "9"]);
  expect(await readFile(images[0].path)).toEqual(Buffer.concat([png, Buffer.from("7")]));
  expect((await stat(images[0].path)).mode & 0o777).toBe(0o600);
  expect(mocks.run.mock.calls.every(([, args]) => !args.join(" ").includes("original selection"))).toBe(true);
});
it("rejects insufficient, missing, duplicate, and non-image selections", async () => {
  await expect(exportClipboardImages(4)).rejects.toThrow("Expected 4");
  await expect(exportClipboardImages(1, ["8"])).rejects.toThrow("available");
  await expect(exportClipboardImages(2, ["9", "9"])).rejects.toThrow("unique");
  expect(() => imageMime(Buffer.from("not an image"))).toThrow("supported image");
});
it("checks field scope before each paste, sends no Enter, and restores preferred clipboard bytes", async () => {
  const result = await pasteClipboardImages({ windowId: "0x1", targetName: "Target composer", count: 2, settleMs: 0 });
  expect(result).toMatchObject({ sentImages: 2, clipboardRestored: true, verificationRequired: true });
  expect(mocks.key.mock.calls).toEqual([
    ["CTRL", "V"],
    ["CTRL", "V"],
  ]);
  expect(mocks.scope).toHaveBeenCalledTimes(3);
  expect(selected.toString()).toBe("original selection");
});
it("rejects a wrong field before reading image contents or changing the selection", async () => {
  mocks.scope.mockRejectedValue(new Error("wrong field"));
  await expect(
    pasteClipboardImages({ windowId: "0x1", targetName: "Other composer", count: 2, settleMs: 0 }),
  ).rejects.toThrow("wrong field");
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.key).not.toHaveBeenCalled();
});
it("restores the selection after a failed key action without replaying it", async () => {
  mocks.key.mockRejectedValue(new Error("focus changed"));
  await expect(
    pasteClipboardImages({ windowId: "0x1", targetName: "Target composer", count: 2, settleMs: 0 }),
  ).rejects.toThrow("focus changed");
  expect(mocks.key).toHaveBeenCalledTimes(1);
  expect(selected.toString()).toBe("original selection");
});
it("does not overwrite a new clipboard selection made during the workflow", async () => {
  mocks.key.mockImplementation(async () => {
    selected = Buffer.from("user copied new content");
  });
  const result = await pasteClipboardImages({ windowId: "0x1", targetName: "Target composer", count: 1, settleMs: 0 });
  expect(result.clipboardRestored).toBe(false);
  expect(selected.toString()).toBe("user copied new content");
});
it("dry-run does not change the selection or dispatch input", async () => {
  const result = await pasteClipboardImages({
    windowId: "0x1",
    targetName: "Target composer",
    count: 2,
    settleMs: 0,
    dryRun: true,
  });
  expect(result.sentImages).toBe(0);
  expect(mocks.key).not.toHaveBeenCalled();
  expect(mocks.run.mock.calls.some(([command]) => command === "wl-copy")).toBe(false);
});

it("stops before the next image if the user copies new content", async () => {
  mocks.key.mockImplementation(async () => {
    selected = Buffer.from("new selection");
  });
  await expect(
    pasteClipboardImages({ windowId: "0x1", targetName: "Target composer", count: 2, settleMs: 0 }),
  ).rejects.toThrow("Clipboard changed");
  expect(mocks.key).toHaveBeenCalledTimes(1);
  expect(selected.toString()).toBe("new selection");
});

it("accepts and restores an empty clipboard selection", async () => {
  const normal = mocks.run.getMockImplementation()!;
  mocks.run.mockImplementation((command, args, input, options) => {
    if (command === "wl-paste" && args[0] === "--list-types")
      throw Object.assign(new Error("empty"), { code: 1, stderr: "Nothing is copied\n" });
    return normal(command, args, input, options);
  });
  const result = await pasteClipboardImages({ windowId: "0x1", targetName: "Target composer", count: 1, settleMs: 0 });
  expect(result).toMatchObject({ sentImages: 1, clipboardRestored: true, restoredMime: null });
  expect(mocks.run.mock.calls.some(([command, args]) => command === "wl-copy" && args[0] === "--clear")).toBe(true);
});
