import { z } from "zod";
import { server, type ToolResult } from "../registry.js";
import { browserConnectionShape, allowedPageUrl, validateBrowserStep } from "../lib/background-browser.js";
import { withBrowserSession } from "../lib/browser-session.js";
import { readPrivateJson } from "../lib/private-json.js";
import { persistCapture } from "../lib/capture-artifact.js";
import { audit } from "../lib/audit.js";
import { dryRun } from "../runtime.js";

function output(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
async function audited(action: string, payload: Record<string, unknown>, operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  await audit(action, payload, dryRun, { status: "started" });
  try {
    const result = dryRun ? { dryRun: true, acted: false } : await operation();
    await audit(action, payload, dryRun, { result: "ok" });
    return output(result);
  } catch (error) {
    await audit(action, payload, dryRun, { result: "error", errorCode: "INPUT_FAILED" });
    throw error;
  }
}
server.registerTool("browser_background_open", {
  description: "Create an owned background tab through an already connected Open Browser Use profile. Never activates it or launches a browser.",
  inputSchema: { ...browserConnectionShape, url: z.string().min(1).max(8192), label: z.string().min(1).max(80).default("Saarthi task") },
  annotations: { desktopInput: false, readOnlyHint: false },
}, async args => {
  allowedPageUrl(args.url);
  return audited("browser_background_open", {}, () => withBrowserSession(args, browser => browser.open(args.url, args.label)));
});
server.registerTool("browser_background_tabs", {
  description: "List only tabs owned by the explicit browser task session. Does not claim user tabs.",
  inputSchema: browserConnectionShape,
  annotations: { desktopInput: false, readOnlyHint: true },
}, args => audited("browser_background_tabs", {}, () => withBrowserSession(args, async browser => ({ tabs: await browser.tabs() }))));
server.registerTool("browser_background_act", {
  description: "Run one fixed browser action from a private JSON step file. Exact session tab, URL and selector checks; file attachments avoid native dialogs. No arbitrary JavaScript.",
  inputSchema: { ...browserConnectionShape, stepFile: z.string().min(1).max(4096) },
  annotations: { desktopInput: false, readOnlyHint: false },
}, async args => {
  const step = validateBrowserStep(await readPrivateJson(args.stepFile));
  return audited("browser_background_act", { tabId: step.tabId, action: step.action, textLength: step.text?.length, fileCount: step.files?.length },
    () => withBrowserSession(args, async browser => persistCapture(await browser.act(step))));
});
server.registerTool("browser_background_finish", {
  description: "Finalize only this task session. Close owned intermediate tabs; optionally retain owned tabs as handoffs.",
  inputSchema: { ...browserConnectionShape, keepTabIds: z.array(z.coerce.number().int().positive()).max(30).default([]) },
  annotations: { desktopInput: false, readOnlyHint: false },
}, args => audited("browser_background_finish", { keepCount: args.keepTabIds.length },
  () => withBrowserSession(args, browser => browser.finish(args.keepTabIds))));
