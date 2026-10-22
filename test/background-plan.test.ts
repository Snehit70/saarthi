import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runBackgroundPlan, validateBackgroundPlan, type PlanDependencies } from "../src/lib/background-plan.js";
import { HyprlandError } from "../src/lib/hyprland.js";
vi.mock("../src/lib/status.js", () => ({ recordStepStart: vi.fn(() => 1), recordStepDone: vi.fn() }));

let root: string;
const connection = { browserTarget: "chrome", profile: "Default", sessionId: "test-background" };
const base = () => ({ id: "run-1", browser: connection, allowedTabIds: [42], steps: [
  { kind: "browser", tabId: 42, expectedUrl: "https://example.com/", action: "fill", selector: "#title", text: "Report" },
  { kind: "browser", tabId: 42, expectedUrl: "https://example.com/", action: "read", selector: "#title", expectText: "Report" },
  { kind: "browser", tabId: 42, expectedUrl: "https://example.com/", action: "click", selector: "#preview" },
  { kind: "browser", tabId: 42, expectedUrl: "https://example.com/", action: "wait-text", selector: "#preview-result", text: "Report" },
] });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "saarthi-plan-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function dependencies() {
  const browser = { assertOwned: vi.fn(async () => {}), act: vi.fn(async () => ({ text: "Report", verified: true })) };
  const deps: Partial<PlanDependencies> = {
    withBrowser: vi.fn(async (_options, operation) => operation(browser as never)),
    persist: async value => value, audit: vi.fn(async () => {}), receiptPath: id => join(root, `${id}.json`),
  };
  return { deps, browser };
}
it("preflights the entire plan including late gates and declared scope before acting", async () => {
  const plan = base();
  plan.steps[2].action = "files";
  expect(() => validateBackgroundPlan(plan)).toThrow();
  const escaped = base(); escaped.steps[0].tabId = 99;
  expect(() => validateBackgroundPlan(escaped)).toThrow(/scope/);
  const gate = base(); Object.assign(gate.steps[2], { actionKind: "submit" });
  const { deps, browser } = dependencies();
  await expect(runBackgroundPlan(gate, deps)).rejects.toThrow(/confirmation/);
  expect(browser.act).not.toHaveBeenCalled();
});
it("requires 4–10 steps and a checkpoint after each mutation", () => {
  expect(() => validateBackgroundPlan({ ...base(), steps: base().steps.slice(0, 3) })).toThrow();
  expect(() => validateBackgroundPlan({ ...base(), steps: [...base().steps, ...base().steps, ...base().steps] })).toThrow();
  const missing = base(); missing.steps[1].action = "screenshot";
  expect(() => validateBackgroundPlan(missing)).toThrow(/checkpoint/);
});
it("keeps one connection, records completed progress and refuses replay of a completed id", async () => {
  const { deps, browser } = dependencies();
  const result = await runBackgroundPlan(base(), deps);
  expect(result).toMatchObject({ status: "completed", completedSteps: 4, inFlightStep: null });
  expect(deps.withBrowser).toHaveBeenCalledTimes(1);
  expect(browser.act).toHaveBeenCalledTimes(4);
  const receipt = await readFile(join(root, "run-1.json"), "utf8");
  expect(receipt).not.toContain("Report");
  expect(receipt).not.toContain("example.com");
  await expect(runBackgroundPlan(base(), deps)).rejects.toThrow(/already started/);
  expect(browser.act).toHaveBeenCalledTimes(4);
});
it("stops after an uncertain action and refuses replay of a failed id", async () => {
  const { deps, browser } = dependencies();
  browser.act.mockResolvedValueOnce({ text: "Report", verified: true })
    .mockResolvedValueOnce({ text: "Report", verified: true })
    .mockRejectedValueOnce(new HyprlandError("ACTION_TIMEOUT", "uncertain"));
  await expect(runBackgroundPlan(base(), deps)).rejects.toMatchObject({ code: "ACTION_TIMEOUT", details: { completedSteps: 2, inFlightStep: 2 } });
  expect(browser.act).toHaveBeenCalledTimes(3);
  expect(JSON.parse(await readFile(join(root, "run-1.json"), "utf8"))).toMatchObject({ status: "error", completedSteps: 2, inFlightStep: 2 });
  await expect(runBackgroundPlan(base(), deps)).rejects.toThrow(/already started/);
  expect(browser.act).toHaveBeenCalledTimes(3);
});
it("does not continue when an application checkpoint disagrees with the input readback", async () => {
  const { deps, browser } = dependencies();
  browser.act.mockResolvedValueOnce({ text: "Report", verified: true }).mockResolvedValueOnce({ text: "Previous record", verified: true });
  await expect(runBackgroundPlan(base(), deps)).rejects.toMatchObject({ details: { completedSteps: 1, inFlightStep: 1 } });
  expect(browser.act).toHaveBeenCalledTimes(2);
});
it("rejects a window that moves out of its declared workspace between validation and capture", async () => {
  const { deps } = dependencies();
  const window = vi.fn().mockResolvedValueOnce({ pid: 12, workspace: "4" }).mockResolvedValueOnce({ pid: 12, workspace: "2" });
  const capture = vi.fn();
  const plan = { id: "window-plan", allowedWindows: [{ windowId: "0xabc", pid: 12, workspace: "4" }], steps: Array.from({ length: 4 }, () => ({ kind: "capture", windowId: "0xabc" })) };
  await expect(runBackgroundPlan(plan, { ...deps, window, capture })).rejects.toMatchObject({ details: { completedSteps: 0, inFlightStep: 0 } });
  expect(capture).not.toHaveBeenCalled();
});
