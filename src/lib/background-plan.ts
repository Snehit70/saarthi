import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { browserConnectionShape, browserStepSchema, validateBrowserStep, type BackgroundBrowser } from "./background-browser.js";
import { withBrowserSession } from "./browser-session.js";
import { getWindowOrThrow, HyprlandError } from "./hyprland.js";
import { captureScreenshot } from "./screenshot.js";
import { persistCapture } from "./capture-artifact.js";
import { audit } from "./audit.js";
import { statePath } from "./state.js";
import { recordStepStart, recordStepDone } from "./status.js";
import type { WindowId } from "./types.js";

const windowId = z.string().regex(/^0x[0-9a-f]+$/);
const stepSchema = z.discriminatedUnion("kind", [
  browserStepSchema.extend({ kind: z.literal("browser"), expectText: z.string().min(1).max(100000).optional() }),
  z.object({ kind: z.literal("capture"), windowId }).strict(),
]);
export const backgroundPlanSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  browser: z.object(browserConnectionShape).strict().optional(),
  allowedTabIds: z.array(z.number().int().positive()).max(30).default([]),
  allowedWindows: z.array(z.object({ windowId, workspace: z.string().min(1).max(80), pid: z.number().int().positive() }).strict()).max(30).default([]),
  steps: z.array(stepSchema).min(4).max(10),
}).strict();
export type BackgroundPlan = z.infer<typeof backgroundPlanSchema>;

export function validateBackgroundPlan(raw: unknown): BackgroundPlan {
  const plan = backgroundPlanSchema.parse(raw);
  if (plan.allowedTabIds.length && !plan.browser)
    throw new HyprlandError("INPUT_FAILED", "Declared browser tabs require an explicit browser connection");
  if (new Set(plan.allowedTabIds).size !== plan.allowedTabIds.length || new Set(plan.allowedWindows.map(w => w.windowId)).size !== plan.allowedWindows.length)
    throw new HyprlandError("INPUT_FAILED", "Plan scope must contain distinct targets");
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind === "capture") {
      if (!plan.allowedWindows.some(w => w.windowId === step.windowId))
        throw new HyprlandError("INPUT_FAILED", "Capture is outside declared window scope");
      continue;
    }
    const { kind: _, expectText, ...action } = step;
    validateBrowserStep(action);
    if (!plan.browser || !plan.allowedTabIds.includes(step.tabId))
      throw new HyprlandError("INPUT_FAILED", "Browser step is outside declared session/tab scope");
    if (expectText !== undefined && step.action !== "read")
      throw new HyprlandError("INPUT_FAILED", "expectText is only valid on read checkpoints");
    if (["fill", "click", "files"].includes(step.action)) {
      const next = plan.steps[index + 1];
      if (!next || next.kind !== "browser" || next.tabId !== step.tabId ||
          !(next.action === "wait-text" || (next.action === "read" && next.expectText !== undefined)))
        throw new HyprlandError("INPUT_FAILED", "Each browser mutation must be followed by a read/expectText or wait-text checkpoint on the same tab");
    }
  }
  return plan;
}

export interface PlanDependencies {
  withBrowser: typeof withBrowserSession;
  window: typeof getWindowOrThrow;
  capture: typeof captureScreenshot;
  persist: typeof persistCapture;
  audit: typeof audit;
  receiptPath: (id: string) => string;
}
const defaults: PlanDependencies = {
  withBrowser: withBrowserSession, window: getWindowOrThrow, capture: captureScreenshot,
  persist: persistCapture, audit, receiptPath: id => statePath(`plans/${id}.json`),
};

/** No resume/retry API: a started id cannot be replayed, even after process death.
 * Receipts contain counts and a source hash, never file paths or entered text. */
export async function runBackgroundPlan(raw: unknown, overrides: Partial<PlanDependencies> = {}): Promise<Record<string, unknown>> {
  const plan = validateBackgroundPlan(raw);
  const deps = { ...defaults, ...overrides };
  const path = deps.receiptPath(plan.id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new HyprlandError("INPUT_FAILED", "This plan id already started. Inspect its receipt and actual state; prepare a new id with only remaining work");
    throw error;
  });
  const state = {
    id: plan.id, sha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    status: "started", completedSteps: 0, totalSteps: plan.steps.length,
    inFlightStep: null as number | null, startedAt: new Date().toISOString(), errorCode: null as string | null,
  };
  // Write and fsync the intent before an operation can have an external effect.
  const save = async () => {
    const data = Buffer.from(JSON.stringify(state));
    await file.truncate(0);
    await file.write(data, 0, data.length, 0);
    await file.sync();
  };
  const results: Record<string, unknown>[] = [];
  let telemetryStep: number | null = null;
  const execute = async (browser?: BackgroundBrowser) => {
    // Validate all declared scopes before any plan mutation, then check again
    // before and after each operation. A stale id never broadens the scope.
    const checkWindow = async (id: string) => {
      const fence = plan.allowedWindows.find(w => w.windowId === id)!;
      const current = await deps.window(id as WindowId);
      if (current.pid !== fence.pid || current.workspace !== fence.workspace)
        throw new HyprlandError("INPUT_FAILED", "Window identity or workspace escaped the plan scope");
    };
    for (const window of plan.allowedWindows) await checkWindow(window.windowId);
    for (const tabId of plan.allowedTabIds) await browser!.assertOwned(tabId);
    for (const [index, step] of plan.steps.entries()) {
      state.inFlightStep = index;
      await save();
      const action = step.kind === "browser" ? step.action : "capture";
      telemetryStep = recordStepStart(`plan_${action}`, ["fill", "click", "files"].includes(action) ? "act" : "read", `Plan step ${index + 1}: ${action}`);
      await deps.audit("plan_step", { planId: plan.id, index, kind: step.kind, action: step.kind === "browser" ? step.action : "capture" }, false, { status: "started" });
      let result: Record<string, unknown>;
      if (step.kind === "capture") {
        await checkWindow(step.windowId);
        const shot = await deps.capture({ target: "window", windowId: step.windowId as WindowId });
        await checkWindow(step.windowId);
        result = await deps.persist({ png: shot.png, captureMethod: shot.captureMethod });
      } else {
        const { kind: _, expectText, ...action } = step;
        result = await deps.persist(await browser!.act(action));
        if (expectText !== undefined && !String(result.text).includes(expectText))
          throw new HyprlandError("INPUT_FAILED", "Read checkpoint did not contain expected text");
      }
      results.push({ index, ...result });
      state.completedSteps++;
      state.inFlightStep = null;
      await save();
      recordStepDone(telemetryStep, true);
      telemetryStep = null;
      await deps.audit("plan_step", { planId: plan.id, index }, false, { result: "ok" });
    }
  };
  try {
    await save();
    await deps.audit("plan_run", { planId: plan.id, stepCount: plan.steps.length }, false, { status: "started" });
    if (plan.browser) await deps.withBrowser(plan.browser, execute);
    else await execute();
    state.status = "completed";
    await save();
    await deps.audit("plan_run", { planId: plan.id, completedSteps: state.completedSteps }, false, { result: "ok" });
    return { ...state, receiptPath: path, results, viewMutationRequested: false };
  } catch (error) {
    if (telemetryStep !== null) recordStepDone(telemetryStep, false);
    state.status = "error";
    const code = error instanceof HyprlandError ? error.code : "INPUT_FAILED";
    state.errorCode = code;
    await save();
    await deps.audit("plan_run", { planId: plan.id, completedSteps: state.completedSteps, inFlightStep: state.inFlightStep }, false, { result: "error", errorCode: state.errorCode });
    throw Object.assign(new HyprlandError(code, "Plan stopped. Inspect actual state before preparing remaining work; nothing was automatically replayed"), {
      details: { receiptPath: path, completedSteps: state.completedSteps, inFlightStep: state.inFlightStep, totalSteps: state.totalSteps,
        reason: error instanceof Error ? error.message.slice(0,1000) : "Operation failed" },
    });
  } finally { await file.close(); }
}
