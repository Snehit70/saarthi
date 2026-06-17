import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowId } from "./types.js";
import { parsePngDimensions } from "./image.js";
import {
  activeWindow,
  focusedWorkspaceName,
  focusWindow,
  getWindowOrThrow,
  HyprlandError,
  restoreWorkspaceIfNeeded,
  switchWorkspaceIfNeeded,
} from "./hyprland.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type ScreenshotTarget = "full" | "monitor" | "active_window" | "window";

export async function captureScreenshot(input: {
  target: ScreenshotTarget;
  monitorName?: string;
  windowId?: WindowId;
}): Promise<{ png: Buffer; width: number; height: number; target: ScreenshotTarget; geometry?: string; monitorName?: string }> {
  const args = ["-"];
  let geometry: string | undefined;
  let originalWorkspace: string | null = null;
  let targetWorkspace: string | null = null;
  let switchedWorkspace = false;

  if (input.target === "monitor") {
    if (!input.monitorName) throw new Error("monitorName is required for monitor target");
    args.unshift("-o", input.monitorName);
  } else if (input.target === "active_window" || input.target === "window") {
    let win = input.target === "active_window" ? await activeWindow() : await getWindowOrThrow(input.windowId as WindowId);
    if (!win) throw new HyprlandError("ACTIVE_WINDOW_MISSING", "No active window available");
    originalWorkspace = await focusedWorkspaceName();
    targetWorkspace = win.workspace;
    if (await switchWorkspaceIfNeeded(originalWorkspace, targetWorkspace)) {
      switchedWorkspace = true;
      await sleep(80);
    }

    await focusWindow(win.id);
    await sleep(40);

    // Re-read after switching/focusing so we capture the current geometry on the target workspace.
    win = await getWindowOrThrow(win.id);
    geometry = `${win.position.x},${win.position.y} ${win.size.width}x${win.size.height}`;
    args.unshift("-g", geometry);
  }

  try {
    const { stdout, stderr } = await execFileAsync("grim", args, { encoding: "buffer", maxBuffer: 25 * 1024 * 1024 });
    if (stderr && String(stderr).trim()) {
      throw new HyprlandError("SCREENSHOT_FAILED", String(stderr).trim());
    }

    const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as Uint8Array);
    const { width, height } = parsePngDimensions(png);

    return {
      png,
      width,
      height,
      target: input.target,
      geometry,
      monitorName: input.monitorName,
    };
  } catch (error) {
    if (error instanceof HyprlandError) throw error;
    throw new HyprlandError("SCREENSHOT_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    if (switchedWorkspace && originalWorkspace) {
      await restoreWorkspaceIfNeeded(originalWorkspace, targetWorkspace);
    }
  }
}
