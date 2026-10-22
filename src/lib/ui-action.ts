import { execFile } from "node:child_process";
import { join } from "node:path";
import { assertWindowFocus, HyprlandError, hyprlandEnvironment } from "./hyprland.js";
import { projectRoot } from "./paths.js";
import { inputOwnershipSignal } from "./input-ownership.js";
import type { WindowId } from "./types.js";

export interface UiActionInput {
  windowId: WindowId;
  name?: string;
  role?: string;
  action?: "focus" | "invoke" | "set-text" | "read-text" | "inspect";
  actionName?: string;
  text?: string;
  requireFocusedEditable?: boolean;
  steps?: Array<{ name: string; role?: string; action: string; text?: string; actionName?: string }>;
}
export async function performUiAction(input: UiActionInput): Promise<Record<string, unknown>> {
  const window = await assertWindowFocus(input.windowId);
  if (!window.pid) throw new HyprlandError("INPUT_FAILED", "Target window has no process identity");
  const env = await hyprlandEnvironment();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [join(projectRoot(), "scripts/atspi_action.py")],
      { env, signal: inputOwnershipSignal(), timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout) as Record<string, unknown>;
          if (error || result.ok !== true)
            throw new HyprlandError(
              "ATSPI_FAILED",
              typeof result.error === "string"
                ? `${result.error}${typeof result.completedSteps === "number" ? `; ${result.completedSteps} steps completed, inspect state before retrying` : ""}`
                : "Accessibility action failed",
            );
          resolve(result);
        } catch (failure) {
          reject(
            failure instanceof HyprlandError
              ? failure
              : new HyprlandError("ATSPI_FAILED", "Accessibility action failed or returned invalid output"),
          );
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({
        ...input,
        pid: window.pid,
        windowTitle: window.title,
        bounds: { ...window.position, ...window.size },
      }),
    );
  });
}
