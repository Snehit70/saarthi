import { z } from "zod";
import { server } from "../registry.js";
import { readPrivateJson } from "../lib/private-json.js";
import { runBackgroundPlan, validateBackgroundPlan } from "../lib/background-plan.js";
import { dryRun } from "../runtime.js";
import { audit } from "../lib/audit.js";

server.registerTool("plan_run", {
  description: "Execute 4–10 typed background steps from a private JSON plan. Explicit tab/window scope, checkpoints, durable progress, no retries or global desktop input.",
  inputSchema: { planFile: z.string().min(1).max(4096) },
  annotations: { desktopInput: false, readOnlyHint: false },
}, async ({ planFile }) => {
  const plan = validateBackgroundPlan(await readPrivateJson(planFile));
  if (dryRun) await audit("plan_run", { planId: plan.id, stepCount: plan.steps.length }, true);
  const result = dryRun ? { dryRun: true, validated: true, stepCount: plan.steps.length } : await runBackgroundPlan(plan);
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});
