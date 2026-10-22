import { z } from "zod";
import { server } from "../registry.js";
import { audit } from "../lib/audit.js";
import { dryRun } from "../runtime.js";
import { assertWindowFocus, HyprlandError } from "../lib/hyprland.js";
import { performUiAction } from "../lib/ui-action.js";
import type { WindowId } from "../lib/types.js";

const selector = {
  windowId: z.string().regex(/^0x[0-9a-fA-F]+$/),
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(60).optional(),
};
server.registerTool(
  "ui_act",
  {
    title: "UI Act",
    description:
      "Resolve one current named accessible element in an exact focused window and focus it, replace its text with readback verification, or invoke an advertised semantic action.",
    inputSchema: {
      ...selector,
      action: z.enum(["focus", "invoke", "set-text"]),
      actionName: z.string().min(1).max(60).optional(),
      text: z.string().max(100000).optional(),
      sensitive: z.boolean().default(true),
      confirmed: z.boolean().default(false),
      actionKind: z.enum(["edit", "navigate", "send", "submit", "delete", "payment"]).default("edit"),
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => {
    if (args.action === "set-text" && args.text === undefined)
      throw new HyprlandError("INPUT_FAILED", "set-text requires --text, which may be empty");
    if (args.action !== "set-text" && args.text !== undefined)
      throw new HyprlandError("INPUT_FAILED", "--text is only valid for set-text");
    if (
      args.action === "invoke" &&
      !args.confirmed &&
      (["send", "submit", "delete", "payment"].includes(args.actionKind) ||
        /^(send|submit|publish|pay|purchase|delete|remove)\b/i.test(args.name))
    )
      throw new HyprlandError("INPUT_FAILED", "This action requires --confirmed");
    const payload = { windowId: args.windowId, name: args.name, action: args.action, textLength: args.text?.length };
    await audit("ui_act", payload, dryRun, { status: "started" });
    try {
      await assertWindowFocus(args.windowId as WindowId);
      const result = dryRun
        ? { acted: false, dryRun: true }
        : await performUiAction({ ...args, windowId: args.windowId as WindowId });
      await audit("ui_act", payload, dryRun, { result: "ok" });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      await audit("ui_act", payload, dryRun, { result: "error", errorCode: "ATSPI_FAILED" });
      throw error;
    }
  },
);
server.registerTool(
  "ui_read_text",
  {
    title: "UI Read Text",
    description: "Read verifiable text from one exactly named accessible element in a validated focused window.",
    inputSchema: selector,
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const result = await performUiAction({ ...args, action: "read-text", windowId: args.windowId as WindowId });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  },
);

const batchStep = z
  .object({
    name: z.string().min(1).max(200),
    role: z.string().max(60).optional(),
    action: z.enum(["focus", "invoke", "set-text", "read-text"]),
    actionName: z.string().max(60).optional(),
    text: z.string().max(100000).optional(),
    confirmed: z.boolean().default(false),
    actionKind: z.enum(["edit", "navigate", "send", "submit", "delete", "payment"]).default("edit"),
  })
  .strict();
server.registerTool(
  "ui_batch",
  {
    title: "UI Batch",
    description:
      "Execute bounded structured accessibility steps from a private JSON file. Re-resolves every target, verifies text changes, stops on the first failure, and never replays completed actions.",
    inputSchema: {
      windowId: selector.windowId,
      stepsFile: z.string().min(1).max(4096),
      sensitive: z.boolean().default(true),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ windowId, stepsFile }) => {
    const { readFile, stat } = await import("node:fs/promises");
    const metadata = await stat(stepsFile);
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new HyprlandError("INPUT_FAILED", "Batch plan must be a regular file no larger than 1 MiB");
    const steps = z
      .array(batchStep)
      .min(1)
      .max(20)
      .parse(JSON.parse(await readFile(stepsFile, "utf8")));
    for (const step of steps) {
      if (step.action === "set-text" && step.text === undefined)
        throw new HyprlandError("INPUT_FAILED", "set-text requires text");
      if (step.action !== "set-text" && step.text !== undefined)
        throw new HyprlandError("INPUT_FAILED", "Only set-text accepts text");
      if (
        step.action === "invoke" &&
        !step.confirmed &&
        (["send", "submit", "delete", "payment"].includes(step.actionKind) ||
          /^(send|submit|publish|pay|purchase|delete|remove)\b/i.test(step.name))
      )
        throw new HyprlandError("INPUT_FAILED", "A gated batch action requires confirmed=true");
    }
    const payload = {
      windowId,
      steps: steps.map(({ name, action, text }) => ({ name, action, textLength: text?.length })),
    };
    await audit("ui_batch", payload, dryRun, { status: "started" });
    try {
      await assertWindowFocus(windowId as WindowId);
      const result = dryRun
        ? { acted: false, dryRun: true, stepCount: steps.length }
        : await performUiAction({ windowId: windowId as WindowId, steps });
      await audit("ui_batch", { windowId, stepCount: steps.length }, dryRun, { result: "ok" });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      await audit("ui_batch", { windowId, stepCount: steps.length }, dryRun, {
        result: "error",
        errorCode: "ATSPI_FAILED",
      });
      throw error;
    }
  },
);
