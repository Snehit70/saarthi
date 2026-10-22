import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registry } from "../src/registry.js";

const mocks = vi.hoisted(() => ({ focus: vi.fn(), perform: vi.fn(), audit: vi.fn() }));
vi.mock("../src/lib/hyprland.js", async () => ({
  ...(await vi.importActual("../src/lib/hyprland.js")),
  assertWindowFocus: mocks.focus,
}));
vi.mock("../src/lib/ui-action.js", () => ({ performUiAction: mocks.perform }));
vi.mock("../src/lib/audit.js", () => ({ audit: mocks.audit }));
vi.mock("../src/runtime.js", () => ({ dryRun: false }));
let root: string;
beforeAll(async () => {
  await import("../src/handlers/ui-action.js");
});
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "saarthi-ui-handler-"));
  mocks.perform.mockResolvedValue({ ok: true, verified: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function invoke(verb: string, args: Record<string, unknown>) {
  const tool = registry.get("ui", verb)!;
  return tool.handler(z.object(tool.config.inputSchema).parse(args));
}
async function batch(steps: unknown[]) {
  const path = join(root, "plan.json");
  await writeFile(path, JSON.stringify(steps), { mode: 0o600 });
  return invoke("batch", { windowId: "0x1", stepsFile: path });
}
it("gates every batch step before executing any action", async () => {
  await expect(
    batch([
      { name: "Editor", action: "set-text", text: "secret text" },
      { name: "Send", action: "invoke" },
    ]),
  ).rejects.toThrow("confirmed");
  expect(mocks.perform).not.toHaveBeenCalled();
  expect(mocks.focus).not.toHaveBeenCalled();
});
it("validates action payloads and bounds batches before input", async () => {
  for (const steps of [
    [],
    [{ name: "Editor", action: "set-text" }],
    [{ name: "Save", action: "invoke", text: "invalid" }],
    Array.from({ length: 21 }, () => ({ name: "Save", action: "invoke" })),
  ]) {
    await expect(batch(steps)).rejects.toThrow();
  }
  expect(mocks.perform).not.toHaveBeenCalled();
});
it("records lengths without persisting entered text", async () => {
  await batch([{ name: "Editor", action: "set-text", text: "private payload" }]);
  expect(mocks.perform).toHaveBeenCalledOnce();
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("private payload");
  expect(JSON.stringify(mocks.audit.mock.calls)).toContain("textLength");
});
it("does not replay a partially completed batch", async () => {
  mocks.perform.mockRejectedValue(new Error("1 steps completed, inspect state"));
  await expect(batch([{ name: "Save", action: "invoke" }])).rejects.toThrow("inspect state");
  expect(mocks.perform).toHaveBeenCalledOnce();
});
it("gates action kinds even when labels conceal the operation", async () => {
  await expect(
    invoke("act", { windowId: "0x1", name: "Continue", action: "invoke", actionKind: "payment" }),
  ).rejects.toThrow("confirmed");
  expect(mocks.perform).not.toHaveBeenCalled();
});
