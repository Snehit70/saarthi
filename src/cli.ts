#!/usr/bin/env node
import "./register-tools.js";
import { executeCli } from "./cli/execute.js";
import { flushIdleSync } from "./lib/status.js";
import { registry } from "./registry.js";
import { withDesktopInput } from "./lib/input-ownership.js";
import { audit } from "./lib/audit.js";

process.on("exit", () => flushIdleSync());
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const captureTools = new Set([
  "find_text_on_screen",
  "resolve_text_point",
  "wait_for_text",
  "wait_for_stable",
  "screenshot_compare",
]);
const result = await executeCli(process.argv.slice(2), registry, async (tool, args) => {
  const ownsInput = tool.config.annotations?.desktopInput === false ? args.allowFocus === true :
    (!tool.config.annotations?.readOnlyHint && !tool.name.startsWith("overlay_task_")) ||
    tool.name.startsWith("desktop_screenshot") ||
    captureTools.has(tool.name);
  if (!ownsInput || process.env.SAARTHI_DRY_RUN === "1") return tool.handler(args);
  try {
    return await withDesktopInput(async () => tool.handler(args));
  } catch (error) {
    if ((error as { code?: string }).code === "INPUT_BUSY")
      await audit(tool.name, { blockedBeforeAction: true }, false, { result: "error", errorCode: "INPUT_BUSY" });
    throw error;
  }
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
